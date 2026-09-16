const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const fs   = require('fs');
const path = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'clinic.db');
const KITCHEN_PASSWORD = process.env.KITCHEN_PASSWORD || '';

// ── 資料庫 ────────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
try { db.exec("ALTER TABLE users ADD COLUMN password TEXT DEFAULT ''"); } catch(e) {}
if (KITCHEN_PASSWORD) {
  try {
    db.prepare("UPDATE users SET password=? WHERE name='John'").run(KITCHEN_PASSWORD);
  } catch(e) {}
}
// 採購歷史合併與重置為 2026-06-20（一次性遷移）
//
// 這段原本只用「有沒有 2026-06-01 的採購紀錄」當判斷，做完卻沒有留下任何標記。
// 意思是它永遠是武裝狀態：只要日後有人（或手誤）建立一筆日期為 2026-06-01 的進貨，
// 下次伺服器重啟就會 DELETE FROM purchase_log 把整份採購歷史刪光，換成下面這串寫死的資料。
// 而每次部署都會重啟。改成用 settings 記一個永久標記，執行過就不再進來。
try {
  db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)");
  const done = db.prepare("SELECT value FROM settings WHERE key='migrated_purchase_20260620'").get();
  const hasOldLogs = !done &&
    db.prepare("SELECT 1 FROM purchase_log WHERE purchased_at='2026-06-01' LIMIT 1").get();
  if (!done) {
    // 不管這次有沒有真的搬資料，都把標記寫下去，讓它只有一次機會
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('migrated_purchase_20260620', datetime('now','localtime'))").run();
  }
  if (hasOldLogs) {
    db.exec("BEGIN TRANSACTION");
    db.exec("DELETE FROM purchase_log");
    const stmt = db.prepare(
      `INSERT INTO purchase_log (ingredient_id, qty, total_price, purchased_at, item_type, purpose)
       VALUES (?, ?, ?, '2026-06-20', '食材', '精力湯')`
    );
    const list = [
      { id: 10,  q: 5315.0,  p: 1460.0 }, // 莓果
      { id: 2,   q: 1500.0,  p: 831.0  }, // 羽衣甘藍
      { id: 8,   q: 20540.0, p: 3557.0 }, // 蘋果(帶皮)
      { id: 1,   q: 200.0,   p: 155.0  }, // 芽菜
      { id: 3,   q: 1600.0,  p: 1816.0 }, // 貝比生菜
      { id: 5,   q: 250.0,   p: 59.0   }, // 胡蘿蔔
      { id: 237, q: 1800.0,  p: 148.0  }, // 檸檬
      { id: 16,  q: 680.0,   p: 268.0  }, // 薑黃粉
      { id: 25,  q: 3000.0,  p: 1556.0 }, // 橄欖油
      { id: 15,  q: 1360.0,  p: 489.0  }, // 核桃
      { id: 14,  q: 7340.0,  p: 1219.0 }, // 燕麥
      { id: 26,  q: 600.0,   p: 1254.0 }, // 苦茶油
      { id: 20,  q: 4500.0,  p: 2970.0 }, // 蛋白粉
      { id: 11,  q: 1440.0,  p: 85.0   }  // 香蕉
    ];
    for (const item of list) {
      stmt.run(item.id, item.q, item.p);
    }
    db.exec("COMMIT");
    console.log("Production purchase log successfully migrated to 2026-06-20!");
  }
} catch (e) {
  try { db.exec("ROLLBACK"); } catch(r) {}
  console.error("Failed to migrate production purchase log:", e.message);
}
// 食材改名必須在 schema.sql 之前跑。
// schema.sql 的種子資料是用「名稱」去找食材的，如果這時候還叫舊名字，
// 種子會以為這個食材不存在而新建一筆（id 也跟著變），
// 接著 prescription_ingredients 的種子又會用預設份量插入，把真實配方蓋掉。
// 先改名，既有那筆就會被 INSERT OR IGNORE 認出來，id 與份量都保住。
try { db.exec("UPDATE ingredients SET name='蘋果' WHERE name='蘋果(帶皮)'"); } catch(e) {}
// 「莓果」太籠統，拆成藍莓／綜合莓／蔓越莓／草莓／冷凍草莓之後，它本身改名為綜合莓，
// 採購與庫存歷史跟著留在同一筆。這行同樣必須在 schema.sql 之前 —— 放後面的話，
// 種子會重新建一個「莓果」並把它塞回 EMP-00 與 RX-01 的配方
try {
  const hasMixed = db.prepare("SELECT 1 FROM ingredients WHERE name='綜合莓'").get();
  if (!hasMixed) db.exec("UPDATE ingredients SET name='綜合莓' WHERE name='莓果'");
} catch(e) {}

// 已經在用的資料庫：先立旗子，免得 schema.sql 的種子把刪掉的用料種回來。
// 全新資料庫還沒有這張表，會丟例外 —— 那就是該種的情況，什麼都不做
try {
  const seeded = db.prepare('SELECT COUNT(*) c FROM prescription_ingredients').get();
  if (seeded && seeded.c > 0)
    db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('rx_ingredients_seeded','1')").run();
} catch (e) {}

db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
try { db.exec("ALTER TABLE users ADD COLUMN password TEXT DEFAULT ''"); } catch(e) {}
if (KITCHEN_PASSWORD) {
  try {
    db.prepare("UPDATE users SET password=? WHERE name='John'").run(KITCHEN_PASSWORD);
  } catch(e) {}
}

// ── 開帳採購資料：只有 purchase_log 完全是空的時候才寫入一次 ──
// 原本這段在 schema.sql，每次啟動都會再塞 14 筆（沒有唯一鍵，OR IGNORE 無效）
function seedPurchaseLog() {
  try {
    const n = db.prepare('SELECT COUNT(*) c FROM purchase_log').get().c;
    if (n > 0) return;
    const seed = [
      ['莓果', 1500, 329], ['莓果', 3815, 1131], ['羽衣甘藍', 1500, 831],
      ['蘋果', 18140, 3058], ['芽菜', 200, 155], ['貝比生菜', 1000, 1111],
      ['胡蘿蔔', 250, 59], ['檸檬', 1800, 148], ['薑黃粉', 340, 129],
      ['橄欖油', 3000, 1167], ['核桃', 1360, 489], ['燕麥', 5470, 804],
      ['苦茶油', 300, 660], ['蛋白粉', 4500, 2970]
    ];
    const ins = db.prepare(
      `INSERT INTO purchase_log (ingredient_id, qty, total_price, purchased_at)
       SELECT id, ?, ?, '2026-06-01' FROM ingredients WHERE name=?`
    );
    seed.forEach(([name, qty, price]) => ins.run(qty, price, name));
    console.log('purchase_log 為空，已寫入開帳採購資料');
  } catch (e) { console.error('seedPurchaseLog 失敗:', e.message); }
}
seedPurchaseLog();

// 清掉先前重複塞入造成的完全相同列（同食材、同日期、同數量、同金額只留一筆）
try {
  const dedupDone = db.prepare("SELECT 1 FROM settings WHERE key='dedup_purchase_log'").get();
  if (!dedupDone) {
    const r = db.prepare(
      `DELETE FROM purchase_log WHERE id NOT IN (
         SELECT MIN(id) FROM purchase_log
         GROUP BY ingredient_id, purchased_at, qty, total_price)`
    ).run();
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('dedup_purchase_log', datetime('now','localtime'))").run();
    if (r.changes) console.log('清除重複採購紀錄 ' + r.changes + ' 筆');
  }
} catch (e) { console.error('採購紀錄去重失敗:', e.message); }

// ── Migrations（向後相容，欄位不存在才加）────────────────
[
  "CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, unit TEXT NOT NULL DEFAULT '份', batch_size INTEGER NOT NULL DEFAULT 3, description TEXT DEFAULT '', sort_order INTEGER DEFAULT 0, active INTEGER DEFAULT 1)",
  "INSERT OR IGNORE INTO products (id, name, unit, batch_size, sort_order) VALUES (1, '精力湯', '杯', 3, 1)",
  "ALTER TABLE prescriptions ADD COLUMN product_id INTEGER DEFAULT 1",
  "ALTER TABLE prescriptions ADD COLUMN is_staff_rx INTEGER DEFAULT 0",
  "ALTER TABLE case_orders ADD COLUMN powder_type TEXT DEFAULT '袋裝'",
  "ALTER TABLE case_orders ADD COLUMN patient_name TEXT DEFAULT ''",
  "ALTER TABLE ingredients ADD COLUMN count_unit TEXT DEFAULT ''",
  "ALTER TABLE ingredients ADD COLUMN count_ratio REAL DEFAULT 1",
  "ALTER TABLE ingredients ADD COLUMN sort_order INTEGER DEFAULT 0",
  "ALTER TABLE purchase_log ADD COLUMN item_type TEXT DEFAULT '食材'",
  "ALTER TABLE purchase_log ADD COLUMN purpose TEXT DEFAULT '精力湯'",
  "ALTER TABLE ingredients ADD COLUMN shelf_life_days INTEGER DEFAULT 0",
  // 預約系統帶入的出單：source_key 用來避免重複建單（同一筆預約的同一種包裝只會建一次）
  "ALTER TABLE case_orders ADD COLUMN source_key TEXT DEFAULT ''",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_case_orders_source ON case_orders(source_key) WHERE source_key <> ''",
  // 被廚房人員刪掉的預約帶入出單：記下來，之後同步不再重建
  "CREATE TABLE IF NOT EXISTS appt_sync_dismissed (source_key TEXT PRIMARY KEY, dismissed_at TEXT DEFAULT (datetime('now','localtime')))",
  "CREATE TABLE IF NOT EXISTS labor_records (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, user_id INTEGER, role TEXT DEFAULT '', task_type TEXT DEFAULT '製作', purpose TEXT DEFAULT '精力湯', minutes INTEGER DEFAULT 0, hourly_rate REAL DEFAULT 196, created_at TEXT DEFAULT (datetime('now','localtime')))",
  "CREATE TABLE IF NOT EXISTS trial_recipes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, status TEXT DEFAULT '試驗中', notes TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))",
  "CREATE TABLE IF NOT EXISTS trial_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, trial_recipe_id INTEGER, session_no INTEGER DEFAULT 1, date TEXT, notes TEXT DEFAULT '', labor_minutes INTEGER DEFAULT 0, participants TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))",
  // auto = 系統依休假與員工餐日推導；manual = 廚房人員手動改過，同步時不再覆蓋
  "ALTER TABLE staff_attendance ADD COLUMN source TEXT DEFAULT 'auto'",

  // 預約帶入的出單：原本只新增不更新，預約改了時間廚房這邊永遠停在舊值。
  // auto = 仍跟著預約走；manual = 廚房人員改過，同步不再覆蓋（比照 staff_attendance）
  "ALTER TABLE case_orders ADD COLUMN sync_source TEXT DEFAULT 'auto'",
  // 預約當下的時間，不論 auto/manual 每次同步都更新 —— 才能把差異顯示出來
  "ALTER TABLE case_orders ADD COLUMN appt_meal_time TEXT DEFAULT ''",
  // 預約被取消或改期後，帶入的出單不會自己消失，那一杯還是會被做出來。
  // 標記出來讓人決定要不要刪，不自動刪 —— 一次抓取失敗就毀掉當天的單，代價太大
  "ALTER TABLE case_orders ADD COLUMN appt_missing INTEGER DEFAULT 0",

  // 處理方式（帶皮／去皮／只要皮…）。同一種食材的不同處理方式不該拆成兩個品項 ——
  // 拆開之後庫存、單價、缺貨判斷都會各算各的（見 mergeApples）
  "ALTER TABLE prescription_ingredients ADD COLUMN prep TEXT DEFAULT ''",

  // 每日固定供應的處方（原本 AW 的杯數與緩衝是寫死在程式裡的）
  "ALTER TABLE prescriptions ADD COLUMN daily_cups REAL DEFAULT 0",
  "ALTER TABLE prescriptions ADD COLUMN buffer_cups REAL DEFAULT 0",

  // 盤點：帳面庫存會因為忘記勾「拿取」而虛高，靠定期盤點把它拉回現實
  `CREATE TABLE IF NOT EXISTS stocktakes (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     date TEXT NOT NULL, user_id INTEGER, note TEXT DEFAULT '',
     created_at TEXT DEFAULT (datetime('now','localtime')))`,
  `CREATE TABLE IF NOT EXISTS stocktake_items (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     stocktake_id INTEGER NOT NULL, ingredient_id INTEGER NOT NULL,
     book_qty REAL DEFAULT 0,      -- 盤點當下的帳面數量
     counted_qty REAL DEFAULT 0,   -- 實際數到的數量
     variance REAL DEFAULT 0,      -- 實際 − 帳面（負數＝損耗）
     FOREIGN KEY (stocktake_id) REFERENCES stocktakes(id))`,
  "CREATE INDEX IF NOT EXISTS idx_stocktake_date ON stocktakes(date)",

  // 每一次扣庫存都留一筆。原本扣完就沒了，沒有任何地方看得出「那天到底扣了什麼」，
  // 也就無從判斷有沒有漏扣。有了這張表，隔日補扣才能只補差額而不是重扣一次。
  `CREATE TABLE IF NOT EXISTS consumption_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     date TEXT NOT NULL, prescription_id INTEGER NOT NULL,
     cups REAL NOT NULL, powder_type TEXT DEFAULT '',
     source TEXT DEFAULT 'manual',   -- manual = 有人確認出餐；auto = 系統隔日補扣
     note TEXT DEFAULT '', user_id INTEGER,
     reversed_at TEXT DEFAULT '',
     created_at TEXT DEFAULT (datetime('now','localtime')))`,
  "CREATE INDEX IF NOT EXISTS idx_consumption_date ON consumption_log(date)",
  // 「我看過了」。沒有這個欄位，自動補扣的通知只能靠「還原」才會消失 ——
  // 但還原是撤銷，不是確認，於是通知永遠賴在畫面上
  "ALTER TABLE consumption_log ADD COLUMN acked_at TEXT DEFAULT ''",

  // 工時改成「每批固定 + 每杯額外」：3 杯是同一鍋打的，不該算 3 倍備料工。
  // 舊的 labor_min_per_cup 保留不刪，但已不再參與計算。
  "INSERT OR IGNORE INTO settings (key,value) VALUES ('labor_min_per_batch','15')",
  "INSERT OR IGNORE INTO settings (key,value) VALUES ('labor_min_per_serving','3')",
  // 加權平均成本只看最近這段期間的採購，避免被幾個月前的舊價一直稀釋
  "INSERT OR IGNORE INTO settings (key,value) VALUES ('cost_lookback_days','90')",
  // AW 原本是寫死在庫存試算裡的（每日 1 杯 + 7 杯緩衝），改成處方上的設定，
  // 換人或停用只要改資料，不用改程式。這行只在欄位還是預設值時填一次。
  "UPDATE prescriptions SET daily_cups=1, buffer_cups=7 WHERE name='AW' AND COALESCE(daily_cups,0)=0 AND COALESCE(buffer_cups,0)=0",
  // 一盒可以幾個人分。qty 一直是「幾人份」，要買幾盒由比例算出來 ——
  // 舊資料 1:1，boxes 就等於 qty，語意不變
  "ALTER TABLE meal_orders ADD COLUMN share_people INTEGER DEFAULT 1",
  "ALTER TABLE meal_orders ADD COLUMN share_boxes  INTEGER DEFAULT 1",
  // 加菜跟餐盒一起買、但不參與分食計算
  "ALTER TABLE meal_items ADD COLUMN item_type TEXT DEFAULT '餐盒'",
  // 內用擺盤的代表照。只存檔名，檔案放 public/photos/ ——
  // 存絕對路徑的話換機器就全部失效
  "ALTER TABLE meal_items ADD COLUMN photo TEXT DEFAULT ''",
  "INSERT OR IGNORE INTO settings (key,value) VALUES ('share_ratios','1:1,2:1,3:2')",
  // 水要記在配方裡（備料得知道每杯加多少），但不必盤點也不用採購。
  // 沒有這個旗標的話，採購清單每次都會叫人去買 3850ml 的水
  "ALTER TABLE ingredients ADD COLUMN track_stock INTEGER DEFAULT 1",
  "UPDATE ingredients SET track_stock=0 WHERE name='水'",
  "INSERT OR IGNORE INTO settings (key,value) VALUES ('staff_meal_dows','2,4')",
  // 有些人喝得不固定（沒有排定的日子，但一週大概幾杯）。
  // daily_cups 是「每個工作日幾杯」，對這種人算出來會失真
  "ALTER TABLE prescriptions ADD COLUMN weekly_cups REAL DEFAULT 0",
  // 蔬果方案是共用的，改一次全體生效 —— 比改單一處方影響更大，
  // 所以更需要留痕。原本只有處方有歷史，方案是唯一沒有的地方
  `CREATE TABLE IF NOT EXISTS produce_plan_history (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     plan_id INTEGER NOT NULL, summary TEXT DEFAULT '',
     before_json TEXT DEFAULT '', after_json TEXT DEFAULT '',
     user_id INTEGER, user_name TEXT DEFAULT '',
     changed_at TEXT DEFAULT (datetime('now','localtime')))`,
  "CREATE INDEX IF NOT EXISTS idx_plan_hist ON produce_plan_history(plan_id, id DESC)",
  // 備料批次：週一（或週四）一次把整段期間的量處理好，做成 N 份冷凍核心包。
  // 原料在備料當下就離開冰箱，但系統原本要等出餐才扣 —— 帳面因此對不上，
  // 而且會誤報「今天缺藍莓」（藍莓其實已經在冷凍包裡了）
  `CREATE TABLE IF NOT EXISTS prep_batches (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     date TEXT NOT NULL, group_code TEXT NOT NULL DEFAULT '主方案',
     plan_id INTEGER, plan_name TEXT DEFAULT '',
     servings INTEGER NOT NULL DEFAULT 0,
     note TEXT DEFAULT '', user_id INTEGER, user_name TEXT DEFAULT '',
     created_at TEXT DEFAULT (datetime('now','localtime')),
     reversed_at TEXT DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS prep_batch_items (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     batch_id INTEGER NOT NULL, ingredient_id INTEGER NOT NULL,
     qty REAL NOT NULL DEFAULT 0,
     FOREIGN KEY (batch_id) REFERENCES prep_batches(id))`,
  // 在市場勾的「買到了」要能被診所那台裝置接手登記金額 ——
  // 存 localStorage 的話，回到診所就看不到了。
  // 這是「買了什麼、幾份」，金額回診所再補：在市場輸入金額不現實
  `CREATE TABLE IF NOT EXISTS purchase_draft (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     date TEXT NOT NULL, ingredient_id INTEGER NOT NULL,
     qty REAL NOT NULL DEFAULT 0, note TEXT DEFAULT '',
     user_id INTEGER, updated_at TEXT DEFAULT (datetime('now','localtime')),
     UNIQUE(date, ingredient_id))`,
  // 配方異動留痕。這裡放的是具名個案的醫療配方，改了卻不留任何痕跡 ——
  // 2026-06 那次把「蘋果(去皮)」改名成「蘋果(純皮)」語意整個翻轉，
  // 是靠翻 git log 才查出來的，資料本身什麼都沒有。
  // 操作紀錄（user_logs）只記「誰動了哪個端點」，查不出「份量從幾克變成幾克」
  `CREATE TABLE IF NOT EXISTS prescription_history (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     prescription_id INTEGER NOT NULL,
     change_type TEXT NOT NULL DEFAULT '用料',
     summary TEXT DEFAULT '',
     before_json TEXT DEFAULT '', after_json TEXT DEFAULT '',
     user_id INTEGER, user_name TEXT DEFAULT '',
     changed_at TEXT DEFAULT (datetime('now','localtime')))`,
  "CREATE INDEX IF NOT EXISTS idx_rx_hist ON prescription_history(prescription_id, id DESC)",
  // 手動指定某一段期間用哪個方案。現實會偏離排程（食材沒到、想延一週），
  // 但預設仍然是自動算 —— 需要人定期去按的東西一定會失守
  `CREATE TABLE IF NOT EXISTS produce_plan_overrides (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     group_code TEXT NOT NULL DEFAULT '主方案',
     plan_id INTEGER NOT NULL,
     date_from TEXT NOT NULL, date_to TEXT NOT NULL,
     note TEXT DEFAULT '', created_by TEXT DEFAULT '',
     created_at TEXT DEFAULT (datetime('now','localtime')))`,
  // 蔬果方案：方案一／二只差在蔬果，機能配料是每個人自己的。
  // 把會輪替的那部分抽出來獨立存放，處方只要指向它 ——
  // 否則每多一個人用方案就要多維護兩張處方，蛋白粉要改兩次
  `CREATE TABLE IF NOT EXISTS produce_plans (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     group_code TEXT NOT NULL DEFAULT '主方案',
     code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
     rotation_index INTEGER DEFAULT 0, active INTEGER DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS produce_plan_items (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     plan_id INTEGER NOT NULL, ingredient_id INTEGER NOT NULL,
     qty_per_cup REAL NOT NULL DEFAULT 0, prep TEXT DEFAULT '', prep_stage TEXT DEFAULT '',
     UNIQUE(plan_id, ingredient_id),
     FOREIGN KEY (plan_id) REFERENCES produce_plans(id))`,
  // 空字串 = 不用方案，維持自己原本的配方（其他個案就是這樣，結構上碰不到）
  "ALTER TABLE prescriptions ADD COLUMN produce_plan_group TEXT DEFAULT ''",
  // 突發外帶要能吸收：3~5 杯的原料。比例在小週會不夠，所以另外設一個絕對杯數
  "INSERT OR IGNORE INTO settings (key,value) VALUES ('buffer_pct','20')",
  "INSERT OR IGNORE INTO settings (key,value) VALUES ('buffer_cups','5')",
  // 盤點的人只有這幾天上班（0=日 1=一 … 6=六）。備料區間依這個算，不是固定一週
  "INSERT OR IGNORE INTO settings (key,value) VALUES ('stocktake_dows','1,2,4')",
  // 雙週輪替：同一個 rotation_group 裡的處方會依週期自動換手，不必有人記得每兩週去切換
  // 不吃哪幾類蛋白質。用明確欄位，不要拿 contraindications 去比對關鍵字 ——
  // 那個欄位現在放的是「無肉桂粉改薑片」「早餐」這種備註，
  // 猜錯的方向是「漏掉過敏」，那不能賭
  "ALTER TABLE prescriptions ADD COLUMN avoid_proteins TEXT DEFAULT ''",
  "ALTER TABLE prescriptions ADD COLUMN rotation_group TEXT DEFAULT ''",
  "ALTER TABLE prescriptions ADD COLUMN rotation_index INTEGER DEFAULT 0",
  // 備料階段：標成「冷凍包」的用料進每週分裝，其餘出餐當天現秤。一個標記長出兩張表
  "ALTER TABLE prescription_ingredients ADD COLUMN prep_stage TEXT DEFAULT ''",
  // 提前備料：料離開冰箱的日子，跟這一筆算哪一天的出餐，是兩件事。
  //   date      = 這批covers 哪一天的出餐（自動補扣是拿這個比對的）
  //   prep_date = 料實際離開冰箱的日子
  // 週一為週二備料時，庫存要在週一就掉下去，但週二不能再扣一次
  "ALTER TABLE consumption_log ADD COLUMN prep_date TEXT DEFAULT ''",
  // 「處方裡有、但廚房從來沒進過貨」有三種完全不同的意思，
  // 而畫面上長得一模一樣：
  //   水       不必進貨
  //   肉桂粉   該進貨但沒登記 —— 成本因此少算
  //   甜菜根   客人自己準備；真的要現場出的時候改用別的
  // 這一欄就是讓它們在處方頁上分得出來。不做成分類是刻意的 ——
  // 現在只有四樣，硬分類只會逼人把不合的塞進某一格
  "ALTER TABLE ingredients ADD COLUMN supply_note TEXT DEFAULT ''",
  // 一列採購沒有出處，事後就分不清它是什麼。
  // 2026-08-27 那兩筆一模一樣的鳳梨就是這樣 —— 是買兩包，還是同一張發票
  // 登記了兩次，誰也講不出來。有備註的話當下寫一句就省掉後來的考古
  "ALTER TABLE purchase_log ADD COLUMN note TEXT DEFAULT ''",
  "INSERT OR IGNORE INTO settings (key,value) VALUES ('rotation_weeks','2')",
  "INSERT OR IGNORE INTO settings (key,value) VALUES ('rotation_anchor','2026-08-31')",
  // 同事訂閱：取餐日與單價。跟員工供應日（週二四）是兩條不同的線
  "INSERT OR IGNORE INTO settings (key,value) VALUES ('subscription_dows','1,3,5')",
  "INSERT OR IGNORE INTO settings (key,value) VALUES ('subscription_price','150')",
  // 廚房不開工的日子。國定假日、颱風、盤點停工都算。
  //
  // 這張表補的是一個既有的洞：系統原本沒有「休診日」的概念，
  // 預估、採購清單、排產全部假設週一到週五都開工 ——
  // 中秋節那天照樣叫你買料、照樣算杯數、沒人點選還會照出勤補扣庫存。
  // 同事訂閱要按假日扣杯，也是靠這張表。
  `CREATE TABLE IF NOT EXISTS kitchen_closures (
     date TEXT PRIMARY KEY,
     reason TEXT DEFAULT '',
     created_by TEXT DEFAULT '',
     created_at TEXT DEFAULT (datetime('now','localtime')))`,
  // 同事訂閱。兩週一輪、每輪一列，取餐日走週一三五。
  //
  // unit_price 與 entitled_cups 都存在這一列，不是每次讀設定即時算。
  // 理由是這一列代表「當時實際收了多少錢、賣了幾杯」——
  // 以後漲價或休診日被補上，已經成立的那一輪不能跟著偷偷變。
  // schema.sql 的種子把刪掉的處方復活過一次，凡是有金額的都要凍在當下。
  `CREATE TABLE IF NOT EXISTS staff_subscriptions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id INTEGER NOT NULL,
     prescription_id INTEGER NOT NULL,
     cycle_start TEXT NOT NULL,
     cycle_weeks INTEGER NOT NULL DEFAULT 2,
     pickup_dows TEXT NOT NULL DEFAULT '1,3,5',
     powder_type TEXT NOT NULL DEFAULT '內用',
     unit_price REAL NOT NULL DEFAULT 150,
     entitled_cups INTEGER NOT NULL DEFAULT 0,
     note TEXT DEFAULT '',
     created_by TEXT DEFAULT '',
     created_at TEXT DEFAULT (datetime('now','localtime')),
     active INTEGER DEFAULT 1,
     UNIQUE(user_id, cycle_start),
     FOREIGN KEY (user_id) REFERENCES users(id),
     FOREIGN KEY (prescription_id) REFERENCES prescriptions(id))`,
  // 一杯一列。這就是「訂了 6 杯、少掉幾杯」的帳。
  //
  //   picked  有人喝掉了（picked_by 記實際喝的人，讓杯時不等於訂的人）
  //   missed  沒人喝 —— 那杯做出來了，成本花掉了，這個數字才是真的浪費
  //   closed  休診日，不算他沒拿
  `CREATE TABLE IF NOT EXISTS subscription_pickups (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     subscription_id INTEGER NOT NULL,
     date TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     picked_by_user_id INTEGER,
     marked_by TEXT DEFAULT '',
     marked_at TEXT DEFAULT '',
     UNIQUE(subscription_id, date),
     FOREIGN KEY (subscription_id) REFERENCES staff_subscriptions(id))`,
  // 當日工作狀態的單一來源（批次分組、拿取勾選、庫存已扣紀錄）
  `CREATE TABLE IF NOT EXISTS day_state (
     date TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT '{}',
     updated_at TEXT DEFAULT (datetime('now','localtime')), updated_by TEXT DEFAULT '')`,
].forEach(sql => { try { db.exec(sql); } catch(e) {} });
// 全新安裝時要有一張員工處方可用，所以先讓 EMP-00 頂著；
// 之後 installFormulaSets() 會建 EMP-01 並讓它接手。
// 條件必須是「有沒有啟用中的員工處方」——
// 一度寫成「有沒有 rotation_group='EMP' 的處方」，輪替移到方案層之後
// 那個條件永遠成立，每次啟動都把已退役的 EMP-00 重新標成員工處方
try {
  const hasStaff = db.prepare('SELECT 1 FROM prescriptions WHERE is_staff_rx=1 AND active=1').get();
  if (!hasStaff) db.exec("UPDATE prescriptions SET is_staff_rx=1 WHERE code='EMP-00'");
} catch (e) { db.exec("UPDATE prescriptions SET is_staff_rx=1 WHERE code='EMP-00'"); }
db.exec("UPDATE prescriptions SET product_id=1 WHERE product_id IS NULL");

// ── 食材資料整理（idempotent）───────────────────────────
[
  // 重新命名
  // 蘋果只有一種，帶皮或去皮是「處理方式」，記在處方的用料行（prescription_ingredients.prep），
  // 不是兩種食材。拆成兩項會讓庫存、單價、缺貨判斷全部失真（見下方 mergeApples）
  "UPDATE ingredients SET name='蘋果' WHERE name='蘋果(帶皮)'",
  "UPDATE ingredients SET name='檸檬'       WHERE name='檸檬帶皮'",
  "UPDATE ingredients SET name='檸檬'       WHERE name='帶皮檸檬'",
  "UPDATE ingredients SET name='奇異果'     WHERE name='帶皮奇異果'",
  // 分類改名
  "UPDATE ingredients SET category='保健品' WHERE category='膠囊'",
  // 分類拆分：油水 → 油（水另外設定）
  "UPDATE ingredients SET category='油' WHERE category='油水' AND name IN ('橄欖油','苦茶油','酪梨油','MCT','亞麻仁油')",
  "UPDATE ingredients SET category='水' WHERE name='水'",
  // 甜菜根歸蔬菜
  "UPDATE ingredients SET category='蔬菜' WHERE name='甜菜根'",
  // 設定顆換算
  "UPDATE ingredients SET count_unit='顆', count_ratio=220 WHERE name='蘋果'",
  "UPDATE ingredients SET count_unit='顆', count_ratio=80  WHERE name='檸檬'",
].forEach(sql => { try { db.exec(sql); } catch(e) {} });

// ── 蘋果合併成單一品項 ──────────────────────────────────
// 「蘋果(帶皮)」與「蘋果(純皮)」是同一種東西的兩種處理方式，卻被建成兩個食材。
// 後果是實際發生過的：純皮從來沒被採購過 → 單價 $0、庫存永遠 0 →
// 用到它的處方成本算不出來、永遠顯示缺貨，而真正的蘋果消耗又沒被算進需求，
// 系統於是說「蘋果夠」，實際上快見底。
// 合併後只留「蘋果」一項，處理方式改記在處方用料行的 prep 欄位。
function mergeApples() {
  try {
    if (db.prepare("SELECT 1 FROM settings WHERE key='merged_apple_items'").get()) return;

    const target = db.prepare("SELECT id FROM ingredients WHERE name='蘋果'").get();
    const peel   = db.prepare("SELECT id, name FROM ingredients WHERE name='蘋果(純皮)'").get();

    if (target && peel && target.id !== peel.id) {
      db.exec('PRAGMA foreign_keys = OFF');
      const delPeel = db.prepare(
        'DELETE FROM prescription_ingredients WHERE prescription_id=? AND ingredient_id=?'
      );
      db.prepare(
        `SELECT prescription_id, qty_per_cup FROM prescription_ingredients WHERE ingredient_id=?`
      ).all(peel.id).forEach(row => {
        // 0g 的列只是編輯畫面留下的空殼，沒有帶任何資訊，直接丟掉
        if (!row.qty_per_cup || row.qty_per_cup <= 0) {
          delPeel.run(row.prescription_id, peel.id);
          return;
        }
        const existing = db.prepare(
          'SELECT id, qty_per_cup FROM prescription_ingredients WHERE prescription_id=? AND ingredient_id=?'
        ).get(row.prescription_id, target.id);

        if (!existing) {
          // 沿用原本的標示，不擅自改寫某位個案的配方
          db.prepare("UPDATE prescription_ingredients SET ingredient_id=?, prep='純皮' WHERE prescription_id=? AND ingredient_id=?")
            .run(target.id, row.prescription_id, peel.id);
        } else if (!existing.qty_per_cup || existing.qty_per_cup <= 0) {
          // 帶皮那列是 0g 空殼，把純皮的用量與標示接過來
          db.prepare("UPDATE prescription_ingredients SET qty_per_cup=?, prep='純皮' WHERE id=?")
            .run(row.qty_per_cup, existing.id);
          delPeel.run(row.prescription_id, peel.id);
        } else {
          // 兩種都真的有用量：份量相加、標示併記，等人確認，不能丟掉任何一邊
          db.prepare("UPDATE prescription_ingredients SET qty_per_cup=?, prep='帶皮＋純皮（請確認）' WHERE id=?")
            .run(existing.qty_per_cup + row.qty_per_cup, existing.id);
          delPeel.run(row.prescription_id, peel.id);
        }
      });
      db.prepare('UPDATE purchase_log SET ingredient_id=? WHERE ingredient_id=?').run(target.id, peel.id);
      db.prepare('DELETE FROM inventory WHERE ingredient_id=?').run(peel.id);
      db.prepare('DELETE FROM ingredients WHERE id=?').run(peel.id);
      db.exec('PRAGMA foreign_keys = ON');
      console.log('蘋果合併完成：蘋果(純皮) → 蘋果，處理方式改記在處方用料行');
    }

    // 其餘用到蘋果的處方，處理方式預設「帶皮」（原本的品名就是這個意思）
    if (target) {
      db.prepare(
        "UPDATE prescription_ingredients SET prep='帶皮' WHERE ingredient_id=? AND COALESCE(prep,'')=''"
      ).run(target.id);
    }
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('merged_apple_items', datetime('now','localtime'))").run();
  } catch (e) {
    try { db.exec('PRAGMA foreign_keys = ON'); } catch (x) {}
    console.error('蘋果合併失敗:', e.message);
  }
}

// 清除重複食材：暫停 FK 檢查，安全地搬移再刪除
db.exec('PRAGMA foreign_keys = OFF');
[
  ['蘋果(帶皮)', '蘋果'],
  ['帶皮奇異果', '奇異果'],
  ['帶皮檸檬',   '檸檬'],
  ['檸檬帶皮',   '檸檬'],
].forEach(([oldName, newName]) => {
  try {
    const oldRow = db.prepare("SELECT id FROM ingredients WHERE name=?").get(oldName);
    const newRow = db.prepare("SELECT id FROM ingredients WHERE name=?").get(newName);
    if (oldRow && newRow && oldRow.id !== newRow.id) {
      // prescription_ingredients：有衝突先刪，再移
      db.prepare(`DELETE FROM prescription_ingredients WHERE ingredient_id=? AND prescription_id IN (SELECT prescription_id FROM prescription_ingredients WHERE ingredient_id=?)`).run(oldRow.id, newRow.id);
      db.prepare("UPDATE prescription_ingredients SET ingredient_id=? WHERE ingredient_id=?").run(newRow.id, oldRow.id);
      db.prepare("UPDATE purchase_log SET ingredient_id=? WHERE ingredient_id=?").run(newRow.id, oldRow.id);
      db.prepare("DELETE FROM inventory WHERE ingredient_id=?").run(oldRow.id);
      db.prepare("DELETE FROM ingredients WHERE id=?").run(oldRow.id);
      console.log(`dedup: ${oldName} → ${newName} ✓`);
    }
  } catch(e) { console.error('dedup error', oldName, e.message); }
});
db.exec('PRAGMA foreign_keys = ON');

mergeApples();   // 必須在上面的改名與去重之後，此時「蘋果」這個品項才存在

// ── 2026-09 新配方：雙週輪替，員工與個案分家 ───────────────
// 一次性，settings 留永久標記。之後在畫面上怎麼改都不會被這段蓋回去 ——
// 這是刻意不寫進 schema.sql 的原因：那裡的種子每次部署都會跑，會把使用者刪掉的用料行復活
const FORMULA_A = [
  ['羽衣甘藍', 20, '生鮮冷藏', ''], ['貝比生菜', 20, '生鮮冷藏', ''],
  ['胡蘿蔔', 15, '帶皮切塊', ''],   ['甜菜根', 15, '熟即食或生鮮', ''],
  ['西洋芹', 15, '生洗切段', ''],   ['大黃瓜', 20, '帶皮切塊', ''],
  ['冷凍菠菜', 15, '殺菁後冷凍直取', '冷凍包'],
  ['冷凍花椰菜', 15, 'IQF 冷凍直取', '冷凍包'],
  ['蘋果', 40, '帶皮切塊', ''],     ['檸檬', 10, '帶皮切角', ''],
  ['奇異果', 20, '帶皮刷毛', ''],   ['鳳梨', 15, '去皮切塊後冷凍', '冷凍包'],
  ['香蕉', 15, '熟成去皮切段後冷凍', '冷凍包'],
  ['芭樂', 15, '帶籽切塊', ''],     ['藍莓', 15, '冷凍直取', '冷凍包'],
  ['蛋白粉', 30, '', ''], ['肉桂粉', 1, '', ''], ['黑胡椒', 1, '', ''],
  ['核桃', 10, '', ''],   ['橄欖油', 10, '特級初榨', ''], ['水', 275, '常溫 250~300ml', '']
];
const FORMULA_B = [
  ['羽衣甘藍', 20, '生鮮冷藏', ''], ['貝比生菜', 20, '生鮮冷藏', ''],
  ['櫻桃蘿蔔', 15, '帶皮洗淨切塊', ''], ['牛番茄', 20, '帶皮切塊', ''],
  ['紫高麗菜', 15, '切絲生打', ''], ['櫛瓜', 15, '帶皮生切', ''],
  ['青江菜', 15, '生洗切段（有機）', ''], ['萵苣', 15, '洗淨撕小片（美生菜）', ''],
  ['蘋果', 40, '帶皮切塊', ''],     ['檸檬', 10, '帶皮切角', ''],
  ['綜合莓', 20, '三種綜合、冷凍直取', '冷凍包'],
  ['木瓜', 15, '去籽切塊', ''],     ['酪梨', 15, '去皮切塊、冷藏或冷凍', '冷凍包'],
  ['甜橙', 15, '去外皮留白絲（香吉士亦可）', ''],
  ['葡萄', 15, '無籽、帶皮冷凍', '冷凍包'],
  ['蛋白粉', 30, '', ''], ['肉桂粉', 1, '', ''], ['黑胡椒', 1, '', ''],
  ['核桃', 10, '', ''],   ['橄欖油', 10, '特級初榨', ''], ['水', 275, '常溫 250~300ml', '']
];

// 修掉一次意外：莓果改名時序放錯，schema.sql 又生了一筆「莓果」並塞回配方，
// 造成同一張處方同時有綜合莓與莓果。只刪重複那筆，原本的用量不動
function dropDuplicateBerry() {
  if (db.prepare("SELECT 1 FROM settings WHERE key='dropped_dup_berry'").get()) return;
  const dup = db.prepare("SELECT id FROM ingredients WHERE name='莓果'").get();
  const keep = db.prepare("SELECT id FROM ingredients WHERE name='綜合莓'").get();
  if (dup && keep) {
    tx(() => {
      // 兩者都在同一張處方時，刪掉後來多出來的「莓果」那行；
      // 只有莓果沒有綜合莓的處方，把它接回綜合莓，用量原封不動
      db.prepare(`DELETE FROM prescription_ingredients WHERE ingredient_id=? AND prescription_id IN
                  (SELECT prescription_id FROM prescription_ingredients WHERE ingredient_id=?)`)
        .run(dup.id, keep.id);
      db.prepare('UPDATE prescription_ingredients SET ingredient_id=? WHERE ingredient_id=?')
        .run(keep.id, dup.id);
      db.prepare('DELETE FROM inventory WHERE ingredient_id=?').run(dup.id);
      db.prepare('DELETE FROM ingredients WHERE id=?').run(dup.id);
      db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('dropped_dup_berry',?)")
        .run(new Date().toISOString().slice(0,19).replace('T',' '));
    });
    console.log('已清除重複的「莓果」品項，配方接回綜合莓');
  }
}
dropDuplicateBerry();

// 阿北套餐與加菜。一次性、有永久標記；店家的分店／電話／步行時間留白，
// 由使用者在畫面上補 —— 採購單靠這些欄位排順序和撥號
// 第二組配方換兩樣（甜椒→櫻桃蘿蔔、蘿蔓生菜→萵苣），並補上阿北的店家與熱量。
// 只換這兩行，其餘用量不動；換下來的兩樣沒有人用了就停用，不刪除
function updateFormulaB2026() {
  if (db.prepare("SELECT 1 FROM settings WHERE key='formula_b_swap_2026_09'").get()) return;
  const ingId = n => (db.prepare('SELECT id FROM ingredients WHERE name=?').get(n) || {}).id;
  const mkIng = (n, c, note) =>
    db.prepare('INSERT OR IGNORE INTO ingredients (name,unit,category,safety_stock,storage_note) VALUES (?,?,?,0,?)')
      .run(n, 'g', c, note);

  tx(() => {
    mkIng('櫻桃蘿蔔', '蔬菜', '完整10天｜切塊冷藏3天');
    mkIng('萵苣',     '蔬菜', '冷藏4°C｜最長5天');

    const swaps = [['甜椒', '櫻桃蘿蔔', '帶皮洗淨切塊'], ['蘿蔓生菜', '萵苣', '洗淨撕小片（美生菜）']];
    ['EMP-02', 'RX-09'].forEach(code => {
      const rx = db.prepare('SELECT id FROM prescriptions WHERE code=?').get(code);
      if (!rx) return;
      swaps.forEach(([from, to, prep]) => {
        const fid = ingId(from), tid = ingId(to);
        if (!fid || !tid) return;
        const row = db.prepare('SELECT qty_per_cup FROM prescription_ingredients WHERE prescription_id=? AND ingredient_id=?')
                      .get(rx.id, fid);
        if (!row) return;
        db.prepare('DELETE FROM prescription_ingredients WHERE prescription_id=? AND ingredient_id=?')
          .run(rx.id, fid);
        db.prepare(`INSERT OR IGNORE INTO prescription_ingredients
                     (prescription_id,ingredient_id,qty_per_cup,prep,prep_stage) VALUES (?,?,?,?,'')`)
          .run(rx.id, tid, row.qty_per_cup, prep);
      });
    });

    // 換下來的兩樣如果沒有任何處方在用，就停用；有人用就留著
    ['甜椒', '蘿蔓生菜'].forEach(n => {
      const id = ingId(n);
      if (!id) return;
      const used = db.prepare('SELECT 1 FROM prescription_ingredients WHERE ingredient_id=?').get(id);
      if (!used) db.prepare('UPDATE ingredients SET active=0 WHERE id=?').run(id);
    });

    // 阿北的店家資訊
    db.prepare("UPDATE vendors SET name='大鼎豬血湯專門店', phone='02-2515-2519', walk_minutes=1, order_note='' WHERE name='阿北'")
      .run();

    // 阿北套餐熱量：半碗飯 130 + 控肉 250 + 豬血湯 60 + 加青菜 45。
    // 控肉大小是最大的變數（70~100g 差約 100 kcal），所以標為內部估算
    db.prepare(`UPDATE meal_items SET kcal=485, protein_g=20.3, kcal_single=485, protein_g_single=20.3,
                 kcal_source='內部估算', nutrition_as_of=?
                WHERE code='SET-A4-PORK'`).run(new Date().toISOString().slice(0, 10));

    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('formula_b_swap_2026_09',?)")
      .run(new Date().toISOString().slice(0, 19).replace('T', ' '));
  });
  console.log('第二組配方已換成櫻桃蘿蔔與萵苣；阿北店家與熱量已補上');
}

// 蔬果方案上線：把 EMP-01／EMP-02 的蔬果搬進「方案一／方案二」，
// 處方只留機能配料。搬完之後兩張員工處方的內容完全一樣，所以只留一張，
// 輪替整個移到方案層 —— 員工、AW 以後共用同一組蔬果，各留各的粉與油。
function installProducePlans() {
  if (db.prepare("SELECT 1 FROM settings WHERE key='produce_plans_2026_09'").get()) return;
  const PRODUCE = new Set(['蔬菜', '水果']);

  const mkPlan = (code, name, idx) => {
    db.prepare("INSERT OR IGNORE INTO produce_plans (group_code,code,name,rotation_index) VALUES ('主方案',?,?,?)")
      .run(code, name, idx);
    return db.prepare('SELECT id FROM produce_plans WHERE code=?').get(code);
  };

  // 把某張處方的蔬果搬進方案，處方那邊刪掉
  const moveProduce = (rxCode, planId) => {
    const rx = db.prepare('SELECT id FROM prescriptions WHERE code=?').get(rxCode);
    if (!rx) return 0;
    const rows = db.prepare(
      `SELECT pi.ingredient_id, pi.qty_per_cup, COALESCE(pi.prep,'') prep,
              COALESCE(pi.prep_stage,'') prep_stage, i.category
         FROM prescription_ingredients pi JOIN ingredients i ON i.id=pi.ingredient_id
        WHERE pi.prescription_id=? AND pi.qty_per_cup>0`
    ).all(rx.id).filter(r => PRODUCE.has(r.category));
    const ins = db.prepare(
      `INSERT OR IGNORE INTO produce_plan_items (plan_id,ingredient_id,qty_per_cup,prep,prep_stage)
       VALUES (?,?,?,?,?)`);
    rows.forEach(r => {
      ins.run(planId, r.ingredient_id, r.qty_per_cup, r.prep, r.prep_stage);
      db.prepare('DELETE FROM prescription_ingredients WHERE prescription_id=? AND ingredient_id=?')
        .run(rx.id, r.ingredient_id);
    });
    return rows.length;
  };

  tx(() => {
    const pa = mkPlan('PLAN-A', '方案一', 0);
    const pb = mkPlan('PLAN-B', '方案二', 1);
    const nA = moveProduce('EMP-01', pa.id);
    const nB = moveProduce('EMP-02', pb.id);

    // 員工只留一張處方（EMP-01），輪替移到方案層
    db.prepare("UPDATE prescriptions SET name='員工配方', rotation_group='', rotation_index=0, produce_plan_group='主方案' WHERE code='EMP-01'").run();
    db.prepare("UPDATE prescriptions SET active=0, is_staff_rx=0, rotation_group='' WHERE code='EMP-02'").run();

    // AW 也走方案：自己的蔬果拿掉（份量與方案不同，以方案為準），
    // 保健品、粉類、油全部保留不動
    const aw = db.prepare("SELECT id FROM prescriptions WHERE code='RX-01'").get();
    if (aw) {
      db.prepare(
        `DELETE FROM prescription_ingredients
          WHERE prescription_id=? AND ingredient_id IN
                (SELECT id FROM ingredients WHERE category IN ('蔬菜','水果'))`
      ).run(aw.id);
      db.prepare("UPDATE prescriptions SET produce_plan_group='主方案' WHERE id=?").run(aw.id);
    }

    // RX-08／RX-09 原本是為了同一件事各建一張，現在方案接手了，只留一張
    db.prepare(
      `DELETE FROM prescription_ingredients
        WHERE prescription_id=(SELECT id FROM prescriptions WHERE code='RX-08')
          AND ingredient_id IN (SELECT id FROM ingredients WHERE category IN ('蔬菜','水果'))`
    ).run();
    db.prepare("UPDATE prescriptions SET name='輪替配方', rotation_group='', produce_plan_group='主方案' WHERE code='RX-08'").run();
    db.prepare("UPDATE prescriptions SET active=0, rotation_group='' WHERE code='RX-09'").run();

    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('produce_plans_2026_09',?)")
      .run(new Date().toISOString().slice(0, 19).replace('T', ' '));
    console.log(`蔬果方案已建立：方案一 ${nA} 樣、方案二 ${nB} 樣；員工與 AW 已改為引用方案`);
  });
}

function installAbeiSet() {
  if (db.prepare("SELECT 1 FROM settings WHERE key='abei_set_2026_09'").get()) return;
  tx(() => {
    db.prepare("INSERT OR IGNORE INTO vendors (name,branch,phone,walk_minutes,order_note) VALUES (?,?,?,?,?)")
      .run('阿北', '', '', 0, '分店、電話、步行時間待補');
    const v = db.prepare("SELECT id FROM vendors WHERE name='阿北'").get();
    db.prepare("INSERT OR IGNORE INTO meal_series (code,vendor_id,name,sort_order) VALUES (?,?,?,?)")
      .run('SER-ABEI', v.id, '阿北套餐', 4);
    const ser = db.prepare("SELECT id FROM meal_series WHERE code='SER-ABEI'").get();

    const ins = db.prepare(
      `INSERT OR IGNORE INTO meal_items
         (code,series_id,protein,display_name,vendor_item_name,kcal,protein_g,
          kcal_source,price_single,price_box,default_mode,item_type,sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    // 熱量還沒有來源，先留 0 並標明 —— 標了估算值會被當成真的
    ins.run('SET-A4-PORK', ser.id, '豬', '阿北套餐', '小肉飯＋豬血湯加菜',
            0, 0, '待確認', 0, 125, '餐盒', '餐盒', 1);

    // 加菜是跟餐盒一起買、但不參與分食計算的品項
    ins.run('ADD-VEG', ser.id, '蔬菜', '燙青菜（加買）', '燙青菜',
            0, 0, '待確認', 0, 0, '餐盒', '加菜', 90);

    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('abei_set_2026_09',?)")
      .run(new Date().toISOString().slice(0,19).replace('T',' '));
  });
  console.log('阿北套餐與加菜品項已建立（店家資訊待補）');
}
// 這幾支會寫 vendors／meal_items，而那些資料表在檔案更後面才建。
// 在這裡跑的話全新資料庫直接開不起來（no such table: vendors）——
// 既有資料庫看不出來，因為那些表早就存在了。
// 呼叫統一移到「餐盒資料表建好之後」，見下方 installMealSeeds()

function installFormulaSets() {
  if (db.prepare("SELECT 1 FROM settings WHERE key='formula_sets_2026_09'").get()) return;

  const upIng = db.prepare(
    'INSERT OR IGNORE INTO ingredients (name,unit,category,safety_stock,storage_note) VALUES (?,?,?,?,?)');
  // 冷凍與生鮮是分開採購、分開計價、分開存放的兩種貨，所以是兩個品項；
  // 「帶皮切塊」「去皮冷凍」那種同一批貨的處理方式，寫在用料行的 prep，不另建品項
  [
    ['西洋芹','蔬菜',0,'完整7天｜切段冷藏3天'],   ['大黃瓜','蔬菜',0,'完整7天｜切塊冷藏3天'],
    ['冷凍菠菜','蔬菜',0,'冷凍-18°C｜殺菁IQF｜開袋後30天'],
    ['冷凍花椰菜','蔬菜',0,'冷凍-18°C｜IQF｜開袋後30天'],
    ['甜椒','蔬菜',0,'完整7天｜去籽冷藏3天'],     ['牛番茄','蔬菜',0,'完整5天｜切塊冷藏2天'],
    ['紫高麗菜','蔬菜',0,'完整10天｜切絲冷藏3天'],['櫛瓜','蔬菜',0,'完整7天｜切開冷藏3天'],
    ['青江菜','蔬菜',0,'冷藏4°C｜最長5天'],       ['萵苣','蔬菜',0,'冷藏4°C｜最長5天'],
    ['櫻桃蘿蔔','蔬菜',0,'完整10天｜切塊冷藏3天'],
    ['芭樂','水果',0,'完整7天｜切塊冷藏2天'],     ['酪梨','水果',0,'後熟後冷藏3天｜切塊可冷凍'],
    ['甜橙','水果',0,'完整14天｜去皮後冷藏2天'],  ['葡萄','水果',0,'冷藏7天｜帶皮冷凍30天'],
    ['藍莓','水果',0,'冷凍-18°C｜開袋密封後30天'],
    ['蔓越莓','水果',0,'冷凍-18°C｜開袋密封後30天'],
    ['草莓','水果',0,'冷藏4°C｜最長3天'],
    ['冷凍草莓','水果',0,'冷凍-18°C｜開袋密封後30天']
  ].forEach(([n,c,ss,note]) => upIng.run(n,'g',c,ss,note));

  // 「莓果」是個籠統的舊品項，改名成綜合莓，採購與庫存歷史跟著留下來；
  // 其餘莓類另外建，不去動它的歷史
  // 「莓果」→「綜合莓」的改名在檔案上方、schema.sql 之前就做掉了

  const ingId = n => (db.prepare('SELECT id FROM ingredients WHERE name=?').get(n) || {}).id;
  const mkRx = (code, name, group, idx, isStaff, rows) => {
    let rx = db.prepare('SELECT id FROM prescriptions WHERE code=?').get(code);
    if (!rx) {
      db.prepare(
        `INSERT INTO prescriptions (product_id,code,name,formula_type,timing,is_staff_rx,active,rotation_group,rotation_index)
         VALUES (1,?,?, '全配方','餐前',?,1,?,?)`
      ).run(code, name, isStaff ? 1 : 0, group, idx);
      rx = db.prepare('SELECT id FROM prescriptions WHERE code=?').get(code);
    }
    const ins = db.prepare(
      `INSERT OR IGNORE INTO prescription_ingredients (prescription_id,ingredient_id,qty_per_cup,prep,prep_stage)
       VALUES (?,?,?,?,?)`);
    rows.forEach(([n, q, prep, stage]) => { const id = ingId(n); if (id) ins.run(rx.id, id, q, prep, stage); });
    return rx.id;
  };

  tx(() => {
    mkRx('EMP-01', '員工配方 第1組', 'EMP', 0, 1, FORMULA_A);
    mkRx('EMP-02', '員工配方 第2組', 'EMP', 1, 1, FORMULA_B);
    mkRx('RX-08',  '輪替配方 第1組', 'RX08', 0, 0, FORMULA_A);
    mkRx('RX-09',  '輪替配方 第2組', 'RX08', 1, 0, FORMULA_B);

    // RX-07 是 EMP-00 的重複，內容已經漂移（檸檬 15 vs 30、核桃 1 vs 0）且從來沒有出單走它。
    // 停用而不是刪除 —— 萬一有人記得它，還找得回來
    db.exec("UPDATE prescriptions SET active=0, is_staff_rx=0 WHERE code='RX-07'");
    // EMP-00 退役但保留：歷史出單指向它，砍掉會讓過去的成本算不出來
    db.exec("UPDATE prescriptions SET active=0, is_staff_rx=0 WHERE code='EMP-00'");

    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('formula_sets_2026_09',?)")
      .run(new Date().toISOString().slice(0,19).replace('T',' '));
  });
  console.log('新配方已建立：EMP-01/EMP-02（員工）、RX-08/RX-09（個案），EMP-00 與 RX-07 已退役');
}
installFormulaSets();
// 必須在上面全部跑完之後：這時候 EMP-01/02、RX-01、RX-08 都已經存在，
// 蔬果才有東西可以搬
installProducePlans();

// 樂芙的雞胸換成去骨烤雞腿。菜單上兩款都在、價格與熱量都不同 ——
// 一度被當成「改名」處理是錯的，那是換一款點。數字取自 2026-04-07 版菜單。
// 只換這一款，其餘不動（其他品項的資料沒拿到就不要臆測）
function switchLefuToThigh() {
  if (db.prepare("SELECT 1 FROM settings WHERE key='lefu_thigh_2026_04'").get()) return;
  tx(() => {
    db.prepare(
      `UPDATE meal_items
          SET display_name='去骨烤雞腿餐盒', vendor_item_name='去骨烤雞腿',
              kcal=674, protein_g=48, kcal_single=0, protein_g_single=0,
              price_box=170, price_single=90,
              kcal_source='店家公告', nutrition_as_of='2026-04-07'
        WHERE code='SET-L1-CHICK'`
    ).run();
    // 採購的人需要這些：地址、營業時間、公休日、外送門檻。
    // 週六日公休沒寫的話，有人會白跑一趟
    db.prepare(
      `UPDATE vendors SET branch='南京龍江店', phone='02-2508-2882',
              order_note='台北市中山區南京東路三段109巷12號｜週一至週五（六日與國定假日休息）｜11:00-14:00、16:30-19:30｜LINE @enjoylovefood2｜3公里內滿 650 元免運'
        WHERE name LIKE '%樂芙%'`
    ).run();
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('lefu_thigh_2026_04',?)")
      .run(new Date().toISOString().slice(0, 19).replace('T', ' '));
    console.log('樂芙雞胸已換成去骨烤雞腿餐盒（674kcal / 48g / $170）');
  });
}
// switchLefuToThigh() 同樣移到餐盒資料表之後

// 樂芙的雞胸改成雞腿。熱量與蛋白質原本是店家公告的「雞胸」數字，
// 換成雞腿之後那些數字就不對了 —— 標回待確認，不要拿舊數字充新品項
try {
  if (!db.prepare("SELECT 1 FROM settings WHERE key='lefu_chicken_thigh_2026_09'").get()) {
    const it = db.prepare("SELECT id FROM meal_items WHERE code='SET-L1-CHICK'").get();
    if (it) {
      db.prepare(
        `UPDATE meal_items SET display_name='水嫩舒肥鮮雞腿', vendor_item_name='水嫩雞腿肉',
                 kcal=0, protein_g=0, kcal_single=0, protein_g_single=0,
                 kcal_source='待確認', nutrition_as_of=''
          WHERE id=?`
      ).run(it.id);
      console.log('樂芙雞胸已改為雞腿；熱量標回待確認');
    }
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('lefu_chicken_thigh_2026_09',?)")
      .run(new Date().toISOString().slice(0, 19).replace('T', ' '));
  }
} catch (e) {}
// 修掉上面那個判斷寫錯時留下的狀態：已停用的處方不該還掛著員工旗標
try {
  db.exec('UPDATE prescriptions SET is_staff_rx=0 WHERE active=0 AND is_staff_rx=1');
} catch (e) {}

// 一張餐盒單要買幾盒。qty 是幾人份，share_people:share_boxes 是選單選的分法。
// 只在這裡算一次 —— 採購單、成本、彙總都讀這個，不各自算一份
function boxesForOrder(o) {
  const people = Number(o.qty) || 0;
  const sp = Number(o.share_people) || 1;
  const sb = Number(o.share_boxes)  || 1;
  if (people <= 0) return 0;
  if (sp <= 1 && sb <= 1) return people;          // 一人一盒
  return Math.ceil(people * sb / sp);
}

// 一份要分攤多少錢：一盒的價格 ÷ 這盒分給幾個人
function shareLabel(o) {
  const sp = Number(o.share_people) || 1, sb = Number(o.share_boxes) || 1;
  return (sp <= 1 && sb <= 1) ? '一人一盒' : `${sp} 人 ${sb} 盒`;
}

// ── 配方異動留痕 ────────────────────────────────────────────
// 只記這張處方自己的用料。蔬果來自方案，不屬於個人，改方案是另一件事
function rxSnapshot(rxId) {
  const p = db.prepare(
    `SELECT code, name, formula_type, timing, COALESCE(contraindications,'') contraindications,
            COALESCE(avoid_proteins,'') avoid_proteins,
            COALESCE(produce_plan_group,'') produce_plan_group, active
       FROM prescriptions WHERE id=?`
  ).get(rxId) || {};
  const items = db.prepare(
    `SELECT i.name, pi.qty_per_cup, COALESCE(pi.prep,'') prep, COALESCE(pi.prep_stage,'') prep_stage
       FROM prescription_ingredients pi JOIN ingredients i ON i.id=pi.ingredient_id
      WHERE pi.prescription_id=? AND pi.qty_per_cup>0 ORDER BY i.name`
  ).all(rxId);
  return { ...p, items };
}

// 把兩份快照的差異寫成人看得懂的一句話。
// 「改過了」沒有用 —— 要看得出「蘋果 30g → 40g」才查得出當初發生什麼事
function diffSummary(before, after) {
  const parts = [];
  const bi = Object.fromEntries((before.items || []).map(x => [x.name, x]));
  const ai = Object.fromEntries((after.items  || []).map(x => [x.name, x]));

  Object.keys(ai).forEach(n => {
    const b = bi[n], a = ai[n];
    if (!b) { parts.push(`新增 ${n} ${a.qty_per_cup}g${a.prep ? '（' + a.prep + '）' : ''}`); return; }
    if (b.qty_per_cup !== a.qty_per_cup) parts.push(`${n} ${b.qty_per_cup}g → ${a.qty_per_cup}g`);
    if (b.prep !== a.prep) parts.push(`${n} 處理方式「${b.prep || '無'}」→「${a.prep || '無'}」`);
    if (b.prep_stage !== a.prep_stage)
      parts.push(`${n} 備料階段「${b.prep_stage || '現場'}」→「${a.prep_stage || '現場'}」`);
  });
  Object.keys(bi).forEach(n => { if (!ai[n]) parts.push(`移除 ${n}（原 ${bi[n].qty_per_cup}g）`); });

  [['name', '名稱'], ['formula_type', '配方類型'], ['timing', '服用時機'],
   ['contraindications', '禁忌註記'], ['avoid_proteins', '不吃的蛋白質'],
   ['produce_plan_group', '蔬果方案組']].forEach(([k, label]) => {
    if ((before[k] || '') !== (after[k] || ''))
      parts.push(`${label}「${before[k] || '無'}」→「${after[k] || '無'}」`);
  });
  if ((before.active ?? 1) !== (after.active ?? 1))
    parts.push(after.active ? '重新啟用' : '停用');

  return parts.join('；');
}

// 記一筆。沒有實質差異就不記 —— 存檔沒改東西也留一筆，會把真正的異動淹掉
function recordRxChange(rxId, before, changeType, req) {
  try {
    const after = rxSnapshot(rxId);
    const summary = diffSummary(before, after);
    if (!summary) return;
    db.prepare(
      `INSERT INTO prescription_history
         (prescription_id, change_type, summary, before_json, after_json, user_id, user_name)
       VALUES (?,?,?,?,?,?,?)`
    ).run(rxId, changeType, summary, JSON.stringify(before), JSON.stringify(after),
          req && req.kitchenUser ? req.kitchenUser.id : null,
          req && req.kitchenUser ? req.kitchenUser.name : '');
  } catch (e) { console.error('配方留痕失敗', e.message); }
}

// ── 雙週輪替配方 ─────────────────────────────────────────
// 兩組配方交替使用，由日期算出今天該用哪一組 —— 沒有人需要每兩週去按一次切換。
// 週期長度與起算日放在 settings，改設定就能變成三組輪替或改成每三週。
function rotationSetting(key, dflt) {
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return r && r.value ? r.value : dflt;
  } catch (e) { return dflt; }
}

// 輪替只算一次：給一組成員和日期，回傳當期該用的那一個。
// 處方輪替與蔬果方案輪替共用這套規則，改週期只要改設定
function rotationPick(members, date) {
  if (!members.length) return null;
  if (members.length === 1) return members[0];
  const weeks  = Number(rotationSetting('rotation_weeks', '2')) || 2;
  const anchor = rotationSetting('rotation_anchor', '2026-08-31');
  const ms = Date.parse(date + 'T00:00:00') - Date.parse(anchor + 'T00:00:00');
  const cycle = Math.floor(ms / (7 * 86400000 * weeks));
  // 起算日之前是負數，取正的餘數才不會落到成員範圍外
  const idx = ((cycle % members.length) + members.length) % members.length;
  return members.find(m => m.rotation_index === idx) || members[0];
}

function activeRxInGroup(group, date) {
  return rotationPick(db.prepare(
    "SELECT id, code, rotation_index FROM prescriptions WHERE rotation_group=? AND active=1 ORDER BY rotation_index"
  ).all(group), date);
}

// 某個方案組在指定日期該用的蔬果方案。
// 手動覆寫優先，沒有覆寫才照日期自動算 —— 兩邊的好處都要：
// 沒人動的時候它自己是對的，現實偏離排程時又改得動
function activePlanFor(group, date) {
  if (!group) return null;
  const d = date || today();
  try {
    const ov = db.prepare(
      `SELECT p.id, p.code, p.name, p.rotation_index, o.id override_id, o.note, o.date_to
         FROM produce_plan_overrides o JOIN produce_plans p ON p.id=o.plan_id
        WHERE o.group_code=? AND ? BETWEEN o.date_from AND o.date_to AND p.active=1
        ORDER BY o.id DESC LIMIT 1`
    ).get(group, d);
    if (ov) return { ...ov, is_override: true };
  } catch (e) { /* 表還沒建起來就走自動 */ }
  return rotationPick(db.prepare(
    'SELECT id, code, name, rotation_index FROM produce_plans WHERE group_code=? AND active=1 ORDER BY rotation_index'
  ).all(group), d);
}

// ★ 有效配方 = 這個人自己的用料 ＋ 當期蔬果方案。
// 六個地方原本各自 SELECT prescription_ingredients，現在一律走這裡 ——
// 少接一個地方，那裡算出來的杯數就會跟其他人不一樣
const EFF_COLS = `pi.ingredient_id, pi.qty_per_cup, COALESCE(pi.prep,'') prep,
       COALESCE(pi.prep_stage,'') prep_stage, i.name, i.unit, i.category,
       COALESCE(i.sort_order,0) sort_order, i.id iid,
       COALESCE(i.kcal_per_unit,0) kcal_per_unit, COALESCE(i.protein_per_unit,0) protein_per_unit`;

function effectiveItems(rxId, date) {
  const own = db.prepare(
    `SELECT ${EFF_COLS} FROM prescription_ingredients pi
     JOIN ingredients i ON i.id=pi.ingredient_id
     WHERE pi.prescription_id=? AND pi.qty_per_cup>0`
  ).all(rxId);

  const rx = db.prepare('SELECT produce_plan_group FROM prescriptions WHERE id=?').get(rxId);
  const plan = rx && activePlanFor(rx.produce_plan_group, date);
  if (!plan) return own.sort(cmpItem);

  const planItems = db.prepare(
    `SELECT ppi.ingredient_id, ppi.qty_per_cup, COALESCE(ppi.prep,'') prep,
            COALESCE(ppi.prep_stage,'') prep_stage, i.name, i.unit, i.category,
            COALESCE(i.sort_order,0) sort_order, i.id iid,
            COALESCE(i.kcal_per_unit,0) kcal_per_unit, COALESCE(i.protein_per_unit,0) protein_per_unit
       FROM produce_plan_items ppi JOIN ingredients i ON i.id=ppi.ingredient_id
      WHERE ppi.plan_id=? AND ppi.qty_per_cup>0`
  ).all(plan.id);

  // 方案先鋪底，個人自己寫的蓋過去 —— 個別微調不會被方案洗掉
  const merged = new Map();
  planItems.forEach(r => merged.set(r.ingredient_id, r));
  own.forEach(r => merged.set(r.ingredient_id, r));
  return [...merged.values()].sort(cmpItem);
}

function cmpItem(a, b) {
  return (a.sort_order - b.sort_order) || String(a.category).localeCompare(String(b.category))
      || String(a.name).localeCompare(String(b.name));
}

// 員工處方只在這裡決定一次。四個地方原本各自 SELECT ... LIMIT 1，
// 兩張員工處方同時啟用時 LIMIT 1 會變成不確定，批次和庫存就會各算各的
function staffRxFor(date, productId) {
  const rot = activeRxInGroup('EMP', date || today());
  if (rot) {
    const full = db.prepare('SELECT * FROM prescriptions WHERE id=?').get(rot.id);
    if (full && (!productId || full.product_id === productId)) return full;
    if (full && productId && full.product_id !== productId) return null;
  }
  return productId
    ? db.prepare('SELECT * FROM prescriptions WHERE product_id=? AND is_staff_rx=1 AND active=1 LIMIT 1').get(productId)
    : db.prepare('SELECT * FROM prescriptions WHERE is_staff_rx=1 AND active=1 LIMIT 1').get();
}


// 新增食材（不存在才加）
[
  ['MCT',        'ml', '油',   53],
  ['亞麻仁油',   'ml', '油',   54],
  ['水',         'ml', '水',   60],
].forEach(([name, unit, cat, ord]) => {
  try {
    const r = db.prepare("INSERT OR IGNORE INTO ingredients (name,unit,category,sort_order) VALUES (?,?,?,?)").run(name, unit, cat, ord);
    if (r.changes > 0) db.prepare("INSERT OR IGNORE INTO inventory (ingredient_id,qty) VALUES (?,0)").run(r.lastInsertRowid);
  } catch(e) {}
});

// 設定食材顯示排序
[
  ['芽菜',10],['羽衣甘藍',11],['貝比生菜',12],['小麥草',13],['胡蘿蔔',14],['甜菜根',15],
  ['蘋果',20],['檸檬',22],['莓果',23],['奇異果',24],['香蕉',25],['木瓜',26],['鳳梨',27],
  ['燕麥',30],['核桃',31],['薑黃粉',32],['肉桂粉',33],['薑粉',34],['藜麥粉',35],['蛋白粉',36],['黑胡椒',37],
  ['AstragIN',40],['Senactiv',41],['益生菌',42],
  ['橄欖油',50],['苦茶油',51],['酪梨油',52],['MCT',53],['亞麻仁油',54],['水',60],
].forEach(([name, ord]) => {
  try { db.prepare("UPDATE ingredients SET sort_order=? WHERE name=?").run(ord, name); } catch(e) {}
});

// ══════════════════════════════════════════════════════════
// 套餐模組（Meal Set）— 外購餐盒，與自製精力湯分屬不同 domain
//   套餐 = 1 份外購餐盒（診所重新擺盤）+ 1 杯精力湯 + 1 張衛教小卡
//   設計文件：docs/MEAL_SET_MODULE_DESIGN.md
// ══════════════════════════════════════════════════════════
[
  // 合作店家：僅後台可見，客人端 API 一律不輸出
  `CREATE TABLE IF NOT EXISTS vendors (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL UNIQUE, branch TEXT DEFAULT '', phone TEXT DEFAULT '',
     walk_minutes INTEGER DEFAULT 0, order_note TEXT DEFAULT '', active INTEGER DEFAULT 1)`,

  // 風味系列：客人看到的分類。與店家分離，換供應商時客人端不受影響
  `CREATE TABLE IF NOT EXISTS meal_series (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, tagline TEXT DEFAULT '',
     vendor_id INTEGER, sort_order INTEGER DEFAULT 0, active INTEGER DEFAULT 1,
     FOREIGN KEY (vendor_id) REFERENCES vendors(id))`,

  `CREATE TABLE IF NOT EXISTS meal_items (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     code TEXT NOT NULL UNIQUE, series_id INTEGER NOT NULL, protein TEXT NOT NULL,
     display_name TEXT NOT NULL,          -- 客人看到的品名
     vendor_item_name TEXT DEFAULT '',    -- 後台採購用的店家品名
     kcal REAL DEFAULT 0, protein_g REAL DEFAULT 0,
     kcal_single REAL DEFAULT 0,          -- 只單點主菜時的熱量
     protein_g_single REAL DEFAULT 0,
     kcal_source TEXT DEFAULT '店家公告',  -- 店家公告 / 內部估算
     nutrition_as_of TEXT DEFAULT '',
     price_single INTEGER DEFAULT 0, price_box INTEGER DEFAULT 0,
     default_mode TEXT DEFAULT '餐盒',
     -- 這幾欄上面也有 ALTER，但那批跑在建表之前：既有資料庫靠 ALTER 補，
     -- 全新資料庫要靠這裡。少了它，開機時 installAbeiSet 會掛
     item_type TEXT DEFAULT '餐盒', photo TEXT DEFAULT '',
     sort_order INTEGER DEFAULT 0, active INTEGER DEFAULT 1,
     FOREIGN KEY (series_id) REFERENCES meal_series(id))`,

  `CREATE TABLE IF NOT EXISTS nutrition_cards (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     code TEXT NOT NULL UNIQUE,
     subject_type TEXT NOT NULL,          -- product / meal_item
     subject_id INTEGER NOT NULL,
     headline TEXT NOT NULL, ratio_line TEXT DEFAULT '', story TEXT DEFAULT '',
     reviewed_by TEXT DEFAULT '', reviewed_at TEXT DEFAULT '',
     updated_at TEXT DEFAULT (datetime('now','localtime')),
     UNIQUE(subject_type, subject_id))`,

  // 每日餐盒出單，與 case_orders 平行。snap_* 是不可變快照：
  // 店家改價改菜單後，歷史單據仍還原得出當時的品名／熱量／價格
  `CREATE TABLE IF NOT EXISTS meal_orders (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     date TEXT NOT NULL, meal_item_id INTEGER NOT NULL, qty INTEGER NOT NULL DEFAULT 1,
     meal_time TEXT DEFAULT '1330', patient_name TEXT DEFAULT '',
     case_order_id INTEGER, purchase_mode TEXT DEFAULT '餐盒',
     status TEXT DEFAULT '待採購',
     snap_display_name TEXT DEFAULT '', snap_kcal REAL DEFAULT 0, snap_price INTEGER DEFAULT 0,
     notes TEXT DEFAULT '', source_key TEXT DEFAULT '',
     -- 同上：上面那批 ALTER 跑在建表之前，全新資料庫要靠這裡
     share_people INTEGER DEFAULT 1, share_boxes INTEGER DEFAULT 1,
     created_at TEXT DEFAULT (datetime('now','localtime')),
     FOREIGN KEY (meal_item_id) REFERENCES meal_items(id))`,
  `CREATE INDEX IF NOT EXISTS idx_meal_orders_date ON meal_orders(date)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_meal_orders_source ON meal_orders(source_key) WHERE source_key <> ''`,
  `CREATE TABLE IF NOT EXISTS meal_sync_dismissed (source_key TEXT PRIMARY KEY, dismissed_at TEXT DEFAULT (datetime('now','localtime')))`,

  // 餐盒採購另立一張表：purchase_log 的加權平均邏輯假設每列都對應一個食材，
  // 把非食材列放進去會污染精力湯的每杯成本
  `CREATE TABLE IF NOT EXISTS meal_purchase_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     date TEXT NOT NULL, meal_item_id INTEGER, meal_order_id INTEGER,
     qty INTEGER NOT NULL DEFAULT 1, total_price REAL NOT NULL DEFAULT 0,
     purchase_mode TEXT DEFAULT '餐盒', user_id INTEGER, note TEXT DEFAULT '',
     created_at TEXT DEFAULT (datetime('now','localtime')))`,
  `CREATE INDEX IF NOT EXISTS idx_meal_purchase_date ON meal_purchase_log(date)`,

  // 營養資料：讓精力湯熱量由配方算出，而不是寫死一個數字
  `ALTER TABLE ingredients ADD COLUMN kcal_per_unit REAL DEFAULT 0`,
  `ALTER TABLE ingredients ADD COLUMN protein_per_unit REAL DEFAULT 0`,
  `ALTER TABLE ingredients ADD COLUMN nutrition_source TEXT DEFAULT ''`,
].forEach(sql => { try { db.exec(sql); } catch(e) {} });

// 餐盒相關的資料表到這裡才建好。所有會碰到 vendors／meal_items 的種子
// 都放在這之後跑 —— 順序錯了，全新資料庫會在開機時就掛掉，
// 而既有資料庫完全看不出來
// 2026-09-10 第三家從「樂坡舒肥健康餐」換成「蛋白盒子健康餐盒 The Protein Box
// 南京復興店」。是換一家店、不是改名，所以新建店家、舊的停用 ——
// 改名會讓過去的採購單看起來像是在新店買的。
//
// 三道全部是新品項（紐奧良雞腿排／壽喜牛五花／薄鹽烤鮭魚），舊的三道停用而不改名：
// 出單有 snap_* 快照，但品項本身改名會讓歷史紀錄看起來像新品。
function installProteinBox() {
  if (db.prepare("SELECT 1 FROM settings WHERE key='protein_box_2026_09'").get()) return;
  tx(() => {
    db.prepare(
      "INSERT OR IGNORE INTO vendors (name,branch,phone,walk_minutes,order_note) VALUES (?,?,?,?,?)"
    ).run('蛋白盒子健康餐盒 The Protein Box', '南京復興店', '02-2715-0020', 5,
          '台北市中山區遼寧街149號。招牌是「南京復興店」但店在遼寧街，跟七福食所同一條');
    const v = db.prepare(
      "SELECT id FROM vendors WHERE name='蛋白盒子健康餐盒 The Protein Box'").get();

    db.prepare(
      "INSERT OR IGNORE INTO meal_series (code,vendor_id,name,tagline,sort_order) VALUES (?,?,?,?,?)"
    ).run('P4', v.id, '水炒輕油高蛋白',
          '不走水煮路線 —— 獨門水炒鎖住蔬菜營養，選好油、配黑米，一份補足蛋白質', 3);
    const ser = db.prepare("SELECT id FROM meal_series WHERE code='P4'").get();

    const ins = db.prepare(
      `INSERT OR IGNORE INTO meal_items
         (code,series_id,protein,display_name,vendor_item_name,kcal,protein_g,
          kcal_source,nutrition_as_of,price_single,price_box,default_mode,item_type,sort_order,photo)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    // 熱量：這家菜單上沒標，用的是同連鎖其他分店對同名品項公告的數字，
    // 所以標「內部估算」。蛋白質店家完全沒公布 → 留 0，菜單會顯示「—（店家未提供）」。
    // 填估算值會被當成真的，客人照著算 —— 那比不寫更糟
    const asOf = '2026-09-10 同連鎖其他分店公告';
    ins.run('SET-P4-CHICK', ser.id, '雞', '紐奧良雞腿排', '紐奧良雞腿排餐盒',
            476, 0, '內部估算', asOf, 0, 135, '餐盒', '餐盒', 1, 'p4-chick.jpg');
    ins.run('SET-P4-BEEF',  ser.id, '牛', '壽喜牛五花',   '壽喜牛五花餐盒',
            575, 0, '內部估算', asOf, 0, 145, '餐盒', '餐盒', 2, 'p4-beef.jpg');
    // 鮭魚那個數字很可能是同菜單上的「減鹽味噌烤鱸魚」，兩道描述都寫味噌鹽烤，
    // 分不出來 —— 所以熱量也留 0，寧可顯示「熱量未提供」
    ins.run('SET-P4-FISH',  ser.id, '魚', '薄鹽烤鮭魚',   '薄鹽烤鮭魚餐盒',
            0, 0, '待確認', '', 0, 180, '餐盒', '餐盒', 3, 'p4-fish.jpg');

    // 舊的第三家：店家與系列停用，三道品項停用（不改名，歷史才讀得懂）
    db.prepare("UPDATE vendors SET active=0 WHERE name='樂坡舒肥健康餐'").run();
    db.prepare("UPDATE meal_series SET active=0 WHERE code='B3'").run();
    db.prepare(
      "UPDATE meal_items SET active=0 WHERE series_id=(SELECT id FROM meal_series WHERE code='B3')"
    ).run();

    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('protein_box_2026_09',?)")
      .run(new Date().toISOString().slice(0, 19).replace('T', ' '));
  });
  console.log('第三家已換成蛋白盒子南京復興店（三道；熱量待店家確認、蛋白質未公布）');
}

// 2026-09-10 樂芙與七福的內用擺盤照。照片是現場拍的，哪一張對哪一道只有
// 當事人知道 —— 這幾筆是他們指認的，不是我從照片推的。
// 薑汁味噌甘露豬與極鮮鹽烤鯖魚沒有拍到，photo 留空：菜單就只顯示文字。
// 放錯照片＝客人看到的不是他會拿到的東西，比沒照片糟
function installMealPhotos2026_09() {
  if (db.prepare("SELECT 1 FROM settings WHERE key='meal_photos_2026_09'").get()) return;
  tx(() => {
    const up = db.prepare("UPDATE meal_items SET photo=? WHERE code=?");
    [['l1-chick.jpg', 'SET-L1-CHICK'],
     ['l1-fish.jpg',  'SET-L1-FISH'],
     ['j2-pork.jpg',  'SET-J2-PORK'],
     ['j2-chick.jpg', 'SET-J2-CHICK']].forEach(([f, code]) => up.run(f, code));
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('meal_photos_2026_09',?)")
      .run(new Date().toISOString().slice(0, 19).replace('T', ' '));
  });
  console.log('樂芙與七福的內用照已掛上（各兩道；甘露豬與鯖魚沒拍到，留空）');
}

// 2026-09-10 蛋白盒子三道的熱量與蛋白質。全平台都沒有營養標示，所以是推估的。
//
// 熱量：紐奧良雞腿排 476、壽喜牛五花 575 取自同連鎖其他分店對「同名品項」的公告。
//   薄鹽烤鮭魚沒有任何分店公告 —— 用配菜熱量回推：
//   雞腿排盒 476 − 去骨雞腿排約 120g（約 250 大卡）＝ 配菜約 225 大卡。
//   拿這個 225 去驗牛五花：牛五花 100g 約 340 大卡 ＋ 225 ＝ 565，
//   對得上公告的 575，所以配菜這個基數可信。
//   鮭魚 130g 約 265 大卡 ＋ 225 ＝ 490。
//
// 蛋白質：店家對菲力豬排標「約 22g」，而豬里肌 100g 正好約 22g ——
//   可見他們報的是主菜那一份，不含配菜。所以照主菜份量推：
//     去骨雞腿排 120g × 24g/100g ≒ 30g
//     牛五花    100g × 17g/100g ≒ 17g（五花油脂高，蛋白質相對低）
//     鮭魚      130g × 21g/100g ≒ 27g
//
// 全部標 kcal_source='內部估算'，菜單上會顯示「（約略值）」——
// 推估值長得跟公告值一樣的話，客人會照著算
function installProteinBoxNutrition() {
  if (db.prepare("SELECT 1 FROM settings WHERE key='protein_box_nutrition_2026_09'").get()) return;
  tx(() => {
    const asOf = '2026-09-10 內部估算：熱量取同連鎖其他分店同名品項公告（鮭魚以配菜 225 大卡回推）；'
               + '蛋白質依主菜份量推估，未經店家確認';
    const up = db.prepare(
      "UPDATE meal_items SET kcal=?, protein_g=?, kcal_source='內部估算', nutrition_as_of=? WHERE code=?");
    [['SET-P4-CHICK', 476, 30],
     ['SET-P4-BEEF',  575, 17],
     ['SET-P4-FISH',  490, 27]].forEach(([code, kcal, prot]) => up.run(kcal, prot, asOf, code));
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('protein_box_nutrition_2026_09',?)")
      .run(new Date().toISOString().slice(0, 19).replace('T', ' '));
  });
  console.log('蛋白盒子三道的熱量與蛋白質已填（全部為內部估算，菜單標約略值）');
}

// 2026-09-10 七福三道的蛋白質。全平台都沒有標示，所以是推估的 ——
// 而且熱量本身就已經是內部估算，這是「拿估算推估算」，可信度比蛋白盒子那三道低一階。
//
// 唯一的實測錨點來自樂芙的店家公告（同樣是主菜＋配菜的餐盒結構）：
//   薑汁味噌豬  單點 250 大卡／30g　餐盒 540 大卡／33g
//   泰式檸檬鱸魚 單點 240 大卡／32g　餐盒 553 大卡／35g
// 兩道都是「餐盒比單點只多 3g」—— 可見蛋白質幾乎全在主菜，配菜與飯只加 3g 左右。
// 所以推估分兩步：先推單點主菜，再 +3 得餐盒。
//
// 單點主菜（七福自己標的單點熱量就是主菜本身，這一段比餐盒好推）：
//   豚福燒肉   230 大卡 ÷ 梅花豬 220 大卡/100g ≒ 105g × 18g/100g ≒ 20g
//   青檸烤雞腿 260 大卡 ÷ 去骨雞腿 215 大卡/100g ≒ 120g × 23g/100g ≒ 28g
//   鹽烤鯖魚   290 大卡 ÷ 薄鹽鯖魚 285 大卡/100g ≒ 100g × 21g/100g ≒ 22g
// 鯖魚油脂高，克數不小但蛋白質相對低 —— 別看熱量最高就以為蛋白質最多。
//
// 餐盒 = 單點 +3g。七福的配菜熱量差（餐盒−單點）約 220 大卡，比樂芙的
// 290～310 還少，所以 +3 已經偏寬鬆，不會低估。
//
// kcal_source 維持 '內部估算'，菜單上會顯示「（約略值）」。
// 哪天問到七福的實際數字，改這裡並把 nutrition_as_of 換成公告日期。
function installQifuNutrition2026_09() {
  if (db.prepare("SELECT 1 FROM settings WHERE key='qifu_nutrition_2026_09'").get()) return;
  tx(() => {
    const asOf = '2026-09-10 內部估算：蛋白質依單點熱量回推主菜份量，餐盒再依樂芙公告的'
               + '「餐盒比單點多 3g」加計；熱量本身亦為估算值，未經店家確認';
    const up = db.prepare(
      `UPDATE meal_items SET protein_g=?, protein_g_single=?,
              kcal_source='內部估算', nutrition_as_of=? WHERE code=?`);
    [['SET-J2-PORK',  23, 20],
     ['SET-J2-CHICK', 31, 28],
     ['SET-J2-FISH',  25, 22]].forEach(([code, box, single]) => up.run(box, single, asOf, code));
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('qifu_nutrition_2026_09',?)")
      .run(new Date().toISOString().slice(0, 19).replace('T', ' '));
  });
  console.log('七福三道的蛋白質已填（推估值，菜單標約略值）');
}

// 2026-09-10 換店家時小卡沒跟著換。
//
// installProteinBox() 停用了樂坡的 B3 三道，但 CARD-B3-* 三張小卡還留著，
// 而新的 P4 三道一張都沒有 —— 個案點了紐奧良雞腿排，隨餐小卡會印不出東西。
// 覆核清單那邊也會一直顯示「10 張待覆核」，其中 3 張是給已經不合作的店家。
//
// 文案裡的公克數全部寫「約」：這三道的營養值是推估的（見
// installQifuNutrition2026_09 上面那段），跟樂芙的店家公告不同級別。
// 小卡是要交到個案手上的東西，寫得像實測值不行。
//
// 一律留在未覆核狀態。衛教文案要醫師或法遵看過才印得出來，那不是我能代簽的。
function installProteinBoxCards2026_09() {
  if (db.prepare("SELECT 1 FROM settings WHERE key='protein_box_cards_2026_09'").get()) return;
  tx(() => {
    const ins = db.prepare(
      `INSERT OR IGNORE INTO nutrition_cards (code,subject_type,subject_id,headline,ratio_line,story)
         SELECT ?, 'meal_item', id, ?, ?, ? FROM meal_items WHERE code=?`);
    [['CARD-P4-CHICK', 'SET-P4-CHICK',
      '水炒輕油・去骨雞腿的完整蛋白',
      '去骨雞腿排 ｜ 蛋白質約 30 公克 ｜ 全程水炒不過油',
      '主菜以水炒取代油炸與大火快炒，減少額外用油，同時保留雞腿的水份與嫩度。'
      + '單盒蛋白質約 30 公克，是這一系列裡蛋白質最高的一道，'
      + '適合需要維持肌肉量的個案。公克數為內部推估值，未經店家確認。'],
     ['CARD-P4-BEEF', 'SET-P4-BEEF',
      '壽喜和風・鐵質與維生素 B12 來源',
      '壽喜牛五花 ｜ 蛋白質約 17 公克 ｜ 和風壽喜調味',
      '牛五花油花分布均勻，口感軟嫩、不需久嚼。牛肉是血基質鐵與維生素 B12 的良好來源。'
      + '要留意五花部位油脂比例高，同一盒的蛋白質會低於雞腿或鮭魚 ——'
      + '以補蛋白質為主要目的時，建議與另外兩道輪替。公克數為內部推估值，未經店家確認。'],
     ['CARD-P4-FISH', 'SET-P4-FISH',
      '深海鮭魚・Omega-3 與優質蛋白',
      '薄鹽烤鮭魚 ｜ 蛋白質約 27 公克 ｜ 天然 Omega-3',
      '鮭魚含 EPA 與 DHA 這類 n-3 多元不飽和脂肪酸，肉質柔軟好咀嚼。'
      + '僅以薄鹽調味烘烤，鈉含量低於一般醬燒做法，適合需要留意鹽份的個案。'
      + '公克數為內部推估值，未經店家確認。']
    ].forEach(([code, item, headline, ratio, story]) =>
      ins.run(code, headline, ratio, story, item));
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('protein_box_cards_2026_09',?)")
      .run(new Date().toISOString().slice(0, 19).replace('T', ' '));
  });
  console.log('蛋白盒子三道的衛教小卡已建立（未覆核，需醫師或法遵確認後才印得出來）');
}

// 2026-09-10 阿北套餐一直沒有衛教小卡。
//
// 它跟樂坡→蛋白盒子那次不同 —— 不是換店家漏掉，是從建立的那天就沒有。
// 沒有人發現，因為缺小卡不會報錯，要到列印當下才印出空白。
// 現在 test-meals 第 13 組會擋住這件事。
//
// 加菜（燙青菜）不算一道菜，不給小卡：它是跟餐盒一起買的配菜，
// 不參與分食計算，也不會單獨交到個案手上。
function installAbeiCard2026_09() {
  if (db.prepare("SELECT 1 FROM settings WHERE key='abei_card_2026_09'").get()) return;
  tx(() => {
    db.prepare(
      `INSERT OR IGNORE INTO nutrition_cards (code,subject_type,subject_id,headline,ratio_line,story)
         SELECT 'CARD-A4-PORK', 'meal_item', id, ?, ?, ? FROM meal_items WHERE code='SET-A4-PORK'`
    ).run(
      '台式家常・豬血湯的鐵質來源',
      '小肉飯＋豬血湯加青菜 ｜ 蛋白質約 20 公克 ｜ 熱量約 485 大卡',
      '豬血是血基質鐵含量很高的食材，吸收率優於植物性鐵質，適合鐵質偏低的個案。'
      + '整份以半碗飯搭配控肉與燙青菜，是熱量最低的一份套餐。'
      + '要留意湯品與控肉滷汁的鈉含量偏高，需要控鹽的個案建議少喝湯。'
      + '熱量與公克數為內部推估值（控肉大小是最大變數），未經店家確認。');
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('abei_card_2026_09',?)")
      .run(new Date().toISOString().slice(0, 19).replace('T', ' '));
  });
  console.log('阿北套餐的衛教小卡已建立（未覆核）');
}

// 2026-09-11 CARD-L1-CHICK 的文案跟菜不一樣。
//
// 2026-04 switchLefuToThigh() 把樂芙那道從雞胸換成去骨烤雞腿，
// 蛋白質從 37g 變 48g —— 小卡沒跟著改，還寫著「低脂雞胸蛋白質 37g」。
// 如果那張被覆核並印出去，個案手上會拿到寫錯部位、寫錯克數的衛教卡。
//
// 沒人發現的原因跟漏建小卡一樣：小卡與品項之間沒有任何一致性檢查。
// 現在 cardNumberIssues() 會把「文案寫的克數／大卡跟系統不符」算出來，
// 介面標紅、test-meals 直接失敗。
function installLefuCardFix2026_09() {
  if (db.prepare("SELECT 1 FROM settings WHERE key='lefu_card_fix_2026_09'").get()) return;
  tx(() => {
    // 改了文案就要撤銷覆核 —— 舊簽核不能蓋到新文字
    db.prepare(
      `UPDATE nutrition_cards
          SET headline=?, ratio_line=?, story=?, reviewed_by='', reviewed_at='',
              updated_at=datetime('now','localtime')
        WHERE code='CARD-L1-CHICK'`
    ).run(
      '去骨雞腿・高效率肌肉修復',
      '去骨烤雞腿 蛋白質 48 公克 ｜ 豐富支鏈胺基酸 BCAA ｜ 藜麥多色時蔬',
      '去骨雞腿肉質細嫩多汁、好咀嚼好入口。每份提供 48 公克優質蛋白質，'
      + '富含支鏈胺基酸（BCAA），是維持肌肉量與日常體能的基礎營養來源。'
      + '這是整份菜單裡蛋白質最高的一道，熱量也最高（674 大卡），'
      + '需要控制熱量的個案請斟酌。');
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('lefu_card_fix_2026_09',?)")
      .run(new Date().toISOString().slice(0, 19).replace('T', ' '));
  });
  console.log('CARD-L1-CHICK 已從「雞胸 37g」改回實際的「去骨雞腿 48g」（覆核狀態已撤銷）');
}

// 文案寫的數字跟系統裡的品項不符時，把不符之處列出來。
//
// 只比對「蛋白質 X 公克」與「熱量 X 大卡」這兩種明確寫法 ——
// 泛抓所有數字會把「維生素 B12」「Omega-3」當成克數。
// 蛋白質容許 1 公克誤差（文案寫「約 20 公克」、系統 20.3 是合理的四捨五入），
// 熱量容許 5 大卡。
function cardNumberIssues(text, item) {
  if (!item) return [];
  const out = [];
  const grams = [
    ...text.matchAll(/蛋白質[^0-9]{0,6}(\d+(?:\.\d+)?)\s*(?:g|公克)/g),
    ...text.matchAll(/(\d+(?:\.\d+)?)\s*(?:g|公克)[^。｜]{0,4}蛋白質/g)
  ].map(m => Number(m[1]));
  const kcals = [...text.matchAll(/(\d+(?:\.\d+)?)\s*大卡/g)].map(m => Number(m[1]));
  grams.forEach(v => {
    if (item.protein_g > 0 && Math.abs(v - item.protein_g) > 1)
      out.push(`文案寫蛋白質 ${v} 公克，系統是 ${item.protein_g} 公克`);
  });
  kcals.forEach(v => {
    if (item.kcal > 0 && Math.abs(v - item.kcal) > 5)
      out.push(`文案寫 ${v} 大卡，系統是 ${item.kcal} 大卡`);
  });
  return [...new Set(out)];   // 同一個數字寫兩次，不必報兩次
}

// 2026-09-12 供應備註的起始值。只填 John 明確講過的那兩樣 ——
// 肉桂粉與黑胡椒留空，因為那兩樣是「該進貨但沒登記」，
// 留空才會顯示成待處理，填了說明反而會讓人以為處理過了
function installSupplyNotes2026_09() {
  if (db.prepare("SELECT 1 FROM settings WHERE key='supply_notes_2026_09'").get()) return;
  tx(() => {
    const up = db.prepare('UPDATE ingredients SET supply_note=? WHERE name=? AND COALESCE(supply_note,\'\')=\'\'');
    up.run('不必進貨', '水');
    up.run('客人自己準備；真的要現場出內用時改用火龍果', '甜菜根');
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('supply_notes_2026_09',?)")
      .run(new Date().toISOString().slice(0, 19).replace('T', ' '));
  });
  console.log('供應備註已填（水、甜菜根）');
}

function installMealSeeds() {
  updateFormulaB2026();
  switchLefuToThigh();
  installAbeiSet();
  installProteinBox();
  installMealPhotos2026_09();
  installProteinBoxNutrition();
  installQifuNutrition2026_09();
  installProteinBoxCards2026_09();
  installAbeiCard2026_09();
  installLefuCardFix2026_09();
  installSupplyNotes2026_09();
}
installMealSeeds();

// ── 食材營養密度（每 1 單位；油品的單位是 ml）──────────────
[
  ['芽菜',       0.23,  0.040, 'USDA'],
  ['羽衣甘藍',   0.35,  0.029, 'USDA'],
  ['貝比生菜',   0.20,  0.020, 'USDA'],
  ['小麥草',     0.21,  0.021, 'USDA'],
  ['胡蘿蔔',     0.41,  0.009, 'USDA'],
  ['甜菜根',     0.43,  0.016, 'USDA'],
  ['蘋果',       0.52,  0.003, 'USDA'],
  ['檸檬',       0.29,  0.011, 'USDA'],
  ['莓果',       0.50,  0.008, 'USDA'],
  ['牛番茄',     0.18,  0.009, 'USDA 生番茄 18 kcal/100g'],
  ['西洋芹',     0.16,  0.007, 'USDA 生西洋芹 16 kcal/100g'],
  ['火龍果',     0.60,  0.012, 'USDA 火龍果 60 kcal/100g'],
  ['冷凍菠菜',   0.29,  0.036, 'USDA 冷凍菠菜（未調理）29 kcal/100g'],
  ['冷凍花椰菜', 0.24,  0.019, 'USDA 冷凍白花椰（未調理）24 kcal/100g'],
  ['藍莓',       0.51,  0.004, 'USDA 冷凍藍莓（未加糖）51 kcal/100g'],
  ['蔓越莓',     0.46,  0.004, 'USDA 冷凍蔓越莓（未加糖生果）46 kcal/100g'],
  ['小黃瓜',     0.15,  0.007, 'USDA 帶皮小黃瓜 15 kcal/100g'],
  ['奇異果',     0.61,  0.011, 'USDA'],
  ['香蕉',       0.89,  0.011, 'USDA'],
  ['木瓜',       0.43,  0.005, 'USDA'],
  ['鳳梨',       0.50,  0.005, 'USDA'],
  ['燕麥',       3.89,  0.169, 'USDA'],
  ['核桃',       6.54,  0.152, 'USDA'],
  ['薑黃粉',     3.54,  0.078, 'USDA'],
  ['肉桂粉',     2.47,  0.040, 'USDA'],
  ['薑粉',       3.35,  0.090, 'USDA'],
  ['藜麥粉',     3.68,  0.141, 'USDA'],
  ['蛋白粉',     3.80,  0.800, '產品標示'],
  ['黑胡椒',     2.51,  0.104, 'USDA'],
  ['AstragIN',   0,     0,     '膠囊，不計熱量'],
  ['Senactiv',   0,     0,     '膠囊，不計熱量'],
  ['益生菌',     5.00,  0,     '產品標示（每包）'],
  ['橄欖油',     8.10,  0,     '884 kcal/100g × 0.916 g/ml'],
  ['苦茶油',     8.05,  0,     '884 kcal/100g × 0.910 g/ml'],
  ['酪梨油',     8.07,  0,     '884 kcal/100g × 0.913 g/ml'],
  ['MCT',        7.80,  0,     '830 kcal/100g × 0.940 g/ml'],
  ['亞麻仁油',   8.18,  0,     '884 kcal/100g × 0.925 g/ml'],
  ['水',         0,     0,     ''],
].forEach(([name, kcal, prot, src]) => {
  try {
    db.prepare(
      `UPDATE ingredients SET kcal_per_unit=?, protein_per_unit=?, nutrition_source=?
       WHERE name=? AND COALESCE(nutrition_source,'')=''`
    ).run(kcal, prot, src, name);
  } catch(e) {}
});

// ── 種子資料：3 間店家 / 3 個風味系列 / 9 款餐盒 ───────────
[
  ['樂芙健康餐盒',   '南京龍江店',           '02-2508-2882', 3, '步行約 3 分鐘'],
  ['七福食所',       '遼寧街',               '',             5, '步行約 5 分鐘'],
  ['樂坡舒肥健康餐', '南京龍江店（Bonbox）', '',             4, '步行約 4 分鐘'],
].forEach(([name, branch, phone, walk, note]) => {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO vendors (name,branch,phone,walk_minutes,order_note) VALUES (?,?,?,?,?)`
    ).run(name, branch, phone, walk, note);
  } catch(e) {}
});

[
  ['L1', '舒肥清爽輕食風味', '低溫慢煮鎖住肉汁，好咬好消化，搭配三色藜麥五穀飯與時令鮮蔬', '樂芙健康餐盒',   1],
  ['J2', '和風慢火香烤風味', '日式職人慢火炙烤，少油輕鹽逼出天然肉香，佐紫米藜麥飯與和風時蔬', '七福食所',     2],
  ['B3', '低溫極致舒肥香草', '精準控溫熟成，質地極度軟嫩多汁，蛋白質含量最高的一系列',       '樂坡舒肥健康餐', 3],
].forEach(([code, name, tagline, vendorName, ord]) => {
  try {
    const v = db.prepare('SELECT id FROM vendors WHERE name=?').get(vendorName);
    db.prepare(
      `INSERT OR IGNORE INTO meal_series (code,name,tagline,vendor_id,sort_order) VALUES (?,?,?,?,?)`
    ).run(code, name, tagline, v ? v.id : null, ord);
  } catch(e) {}
});

// kcal / protein_g 為「整盒」值；kcal_single / protein_g_single 為只買主菜時的值
[
  ['SET-L1-PORK',  'L1', '豬', '薑汁味噌甘露豬',   '薑汁味噌豬',   540, 33, 250, 30,  60, 140, '店家公告', 1],
  ['SET-L1-CHICK', 'L1', '雞', '水嫩舒肥鮮雞胸',   '水嫩雞胸肉',   453, 37, 180, 34,  70, 150, '店家公告', 2],
  ['SET-L1-FISH',  'L1', '魚', '泰式檸檬清蒸鱸魚', '泰式檸檬鱸魚', 553, 35, 240, 32,  90, 170, '店家公告', 3],
  ['SET-J2-PORK',  'J2', '豬', '和風炙燒豚肉',     '豚福燒肉',     450,  0, 230,  0, 139, 249, '內部估算', 4],
  ['SET-J2-CHICK', 'J2', '雞', '青檸慢烤嫩雞腿',   '青檸烤雞腿',   480,  0, 260,  0, 179, 279, '內部估算', 5],
  ['SET-J2-FISH',  'J2', '魚', '極鮮鹽烤鯖魚',     '鹽烤鯖魚',     520,  0, 290,  0, 189, 269, '內部估算', 6],
  ['SET-B3-PORK',  'B3', '豬', '椒鹽輕嫩梅花豬',   '椒鹽梅花豬',   626, 33, 310, 30,  49, 125, '店家公告', 7],
  ['SET-B3-CHICK', 'B3', '雞', '厚切慢熟嫩雞胸',   '厚切嫩雞胸',   598, 51, 280, 48,  89, 155, '店家公告', 8],
  ['SET-B3-FISH',  'B3', '魚', '檸香輕嫩巴沙魚',   '檸香巴沙魚',   474,  0, 200,  0,  59, 130, '店家公告', 9],
].forEach(([code, sCode, protein, disp, vendorItem, kcal, prot, kcalS, protS, pS, pB, src, ord]) => {
  try {
    const s = db.prepare('SELECT id FROM meal_series WHERE code=?').get(sCode);
    if (!s) return;
    db.prepare(
      `INSERT OR IGNORE INTO meal_items
         (code,series_id,protein,display_name,vendor_item_name,kcal,protein_g,
          kcal_single,protein_g_single,price_single,price_box,kcal_source,nutrition_as_of,sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'2026-08-22',?)`
    ).run(code, s.id, protein, disp, vendorItem, kcal, prot, kcalS, protS, pS, pB, src, ord);
  } catch(e) {}
});

// ── 種子資料：10 張隨餐衛教小卡 ────────────────────────────
// reviewed_at 刻意留空：未經醫師／法遵覆核的小卡不得列印（見設計文件 R1）
[
  ['CARD-TONIC', 'product', 1, '綠活力植化素・黃金協同吸收',
   '深綠葉菜植化素 ｜ 特級初榨橄欖油 ｜ 分離乳清蛋白 ｜ 薑黃＋黑胡椒',
   '嚴選深綠羽衣甘藍與嫩葉貝比生菜，富含葉綠素與天然抗氧化微量元素。搭配特級初榨冷壓橄欖油，以不飽和脂肪酸帶動脂溶性維生素 A、D、E、K 的吸收。薑黃粉與黑胡椒同時入杯，是營養學上常見的搭配組合。'],
  ['CARD-L1-PORK', 'meal_item', 0, '暖胃循行・優質蛋白質滋補',
   '優質豬肉蛋白質 33g ｜ 天然生薑 ｜ 發酵熟成味噌',
   '生薑帶來溫潤的辛香，搭配天然大豆發酵味噌，是東方飲食中常見的暖胃組合。肉質細嫩多汁，好咀嚼好入口，為長輩提供維持肌力所需的優質蛋白質。'],
  ['CARD-L1-CHICK', 'meal_item', 0, '極致純淨・高效率肌肉修復',
   '低脂雞胸蛋白質 37g ｜ 豐富支鏈胺基酸 BCAA ｜ 藜麥多色時蔬',
   '低溫真空舒肥工法鎖住雞肉天然肉汁與細緻纖維。每份提供 37g 優質蛋白質，富含支鏈胺基酸（BCAA），是維持肌肉量與日常體能的基礎營養來源。'],
  ['CARD-L1-FISH', 'meal_item', 0, '細緻好吸收・搭配天然維生素 C',
   '鮮嫩鱸魚蛋白質 35g ｜ 鮮萃檸檬維生素 C ｜ 微量元素鋅',
   '鱸魚蛋白質分子結構細緻，質地柔軟易咀嚼，是調養期間常見的選擇。佐以新鮮檸檬，補充天然維生素 C，並帶來清爽不膩口的風味。'],
  ['CARD-J2-PORK', 'meal_item', 0, '活力代謝・豐富維生素 B 群',
   '和風輕炙燒豬肉 ｜ 維生素 B1 ｜ 紫米高纖膳食纖維',
   '嚴選優質豚肉，富含能量代謝所需的維生素 B1 與必需胺基酸。慢火輕油炙燒，香氣飽滿且清爽不油膩，搭配紫米補充膳食纖維。'],
  ['CARD-J2-CHICK', 'meal_item', 0, '軟嫩多汁・鐵質與鋅補充',
   '去骨鮮雞腿肉 ｜ 檸檬多酚 ｜ 血基質鐵與鋅',
   '去骨鮮嫩雞腿肉提供優質動物性鐵質與鋅，是均衡飲食中常見的礦物質來源。青檸微酸果香引出肉汁鮮甜，肉質滑嫩好咀嚼，適合牙口敏感者。'],
  ['CARD-J2-FISH', 'meal_item', 0, '天然深海 Omega-3',
   '深海鯖魚 ｜ EPA & DHA 脂肪酸 ｜ 維生素 D',
   '鯖魚富含深海 Omega-3 不飽和脂肪酸（DHA 與 EPA）與維生素 D，是日常飲食中優質脂肪的重要來源。天然油脂經鹽烤轉化為迷人甘甜。'],
  ['CARD-B3-PORK', 'meal_item', 0, '充沛元氣・均衡油花與胺基酸',
   '低溫舒肥梅花豬 ｜ 蛋白質 33g ｜ 礦物質磷與鐵',
   '經舒肥精準溫控熟成，梅花豬細緻的油花轉化為滑嫩適口的口感，改善傳統豬肉乾柴難咬的問題。提供優質蛋白質與鐵質，飽足感扎實。'],
  ['CARD-B3-CHICK', 'meal_item', 0, '高蛋白低卡典範',
   '厚切低溫熟成雞胸 ｜ 蛋白質 51g ｜ 無額外添加精緻糖',
   '以舒肥技術保留雞肉水份，厚切口感多汁不乾澀。單份 51g 的蛋白質含量，適合體態重塑期間或需要較高蛋白質攝取的個案。'],
  ['CARD-B3-FISH', 'meal_item', 0, '輕盈低卡・清爽無負擔',
   '無刺白身巴沙魚 ｜ 低脂優質蛋白 ｜ 天然鮮檸清香',
   '巴沙魚肉質細緻柔嫩、完全無細刺，油脂含量低，入口即化。搭配清新檸檬提香，口味清淡，適合偏好低脂飲食的個案。'],
].forEach(([code, sType, sId, headline, ratio, story]) => {
  try {
    let subjectId = sId;
    if (sType === 'meal_item') {
      const itemCode = code.replace(/^CARD-/, 'SET-');
      const it = db.prepare('SELECT id FROM meal_items WHERE code=?').get(itemCode);
      if (!it) return;
      subjectId = it.id;
    }
    db.prepare(
      `INSERT OR IGNORE INTO nutrition_cards (code,subject_type,subject_id,headline,ratio_line,story)
       VALUES (?,?,?,?,?,?)`
    ).run(code, sType, subjectId, headline, ratio, story);
  } catch(e) {}
});

// ── 中介層 ────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/public/users', (req, res) => {
  const rows = db.prepare("SELECT id, name, CASE WHEN COALESCE(password,'') <> '' THEN 1 ELSE 0 END AS requires_password FROM users ORDER BY id").all();
  res.json(rows);
});

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ab.length === bb.length && require('crypto').timingSafeEqual(ab, bb);
}

app.use('/api', (req, res, next) => {
  const userId = Number(req.get('x-kitchen-user-id') || 0);
  if (!userId) {
    return res.status(401).json({ error: 'User is required' });
  }
  const user = db.prepare("SELECT id, name, COALESCE(password,'') AS password FROM users WHERE id=?").get(userId);
  if (!user) {
    return res.status(401).json({ error: 'Unknown user' });
  }
  if (user.password && !safeEqual(req.get('x-kitchen-password'), user.password)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.kitchenUser = { id: user.id, name: user.name };
  next();
});

// 每一個會改資料的請求都記一筆。放在這裡是因為 app.use() 只對之後註冊的
// 路由生效 —— 放到檔案後段就會漏掉前面所有端點。
// 依賴的常數與函式定義在下方，但這個 callback 是每次請求才執行，屆時都已就緒
app.use((req, res, next) => {
  if (req.method === 'GET' || LOG_SKIP.some(p => req.path.startsWith(p))) return next();
  res.on('finish', () => {
    // 失敗的請求不記 —— 什麼都沒改，記了只是雜訊
    if (res.statusCode >= 400) return;
    try {
      db.prepare('INSERT INTO user_logs (user_id,action,detail) VALUES (?,?,?)').run(
        req.kitchenUser ? req.kitchenUser.id : null,
        logActionName(req.path, req.method),
        logDetail(req.body)
      );
    } catch (e) { /* 記錄失敗不能影響本來的操作 */ }
  });
  next();
});

// ── Healthcheck ───────────────────────────────────────────
app.get('/health', (req, res) => res.send('ok'));

// ── 工具函式 ──────────────────────────────────────────────
function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch(e) { db.exec('ROLLBACK'); throw e; }
}

function today() {
  return new Date().toISOString().slice(0,10);
}

// 姓名比對用：跨系統的名字大小寫與空白並不一致
function normName(s) {
  return String(s || '').toLowerCase().trim();
}

// ── 員工供應日 ────────────────────────────────────────────
// 0=日 1=一 2=二 3=三 4=四 5=五 6=六
// 只在這裡定義一次：出席預設、庫存試算、SOP 說明全部讀這個常數。
// 之前出席邏輯和庫存試算各寫一份 [2,4,5]，改一邊就會不一致。
const DOW_LABEL = ['日', '一', '二', '三', '四', '五', '六'];

// 員工供應日。原本是寫死的常數，但這件事會改（可能變成每週 2~3 天），
// 改成設定就不用動程式。仍然只定義一次 —— 要用就從這裡讀，不要各自寫一份
function staffMealDows() {
  const raw = rotationSetting('staff_meal_dows', '2,4');
  const list = String(raw).split(',').map(x => Number(String(x).trim()))
    .filter(x => Number.isInteger(x) && x >= 0 && x <= 6);
  return list.length ? list : [2, 4];
}
function isStaffMealDay(dow) { return staffMealDows().includes(dow); }
function staffMealDaysLabel() {
  return staffMealDows().map(d => '週' + DOW_LABEL[d]).join('、');
}
// 在編人數（庫存試算用）。之前寫死 9 人，離職或新進都不會反映
function rosterCount() {
  return db.prepare('SELECT COUNT(*) c FROM users').get().c;
}

// ══════════════════════════════════════════════════════════
// 預約系統帶入：把喜悅預約系統裡的四種精力湯／基底粉項目，
// 自動建立成廚房的個案出單。只新增、不修改也不刪除既有出單。
// ══════════════════════════════════════════════════════════
const APPTS_URL = process.env.APPTS_URL || 'https://clinic-system-1224f-default-rtdb.asia-southeast1.firebasedatabase.app/clinic_v3/appts.json';
// 預約系統的治療項目 → 廚房的出單包裝類型
const APPT_ITEM_MAP = {
  '罐裝基底粉':   '罐裝',
  '袋裝基底粉':   '袋裝',
  '全配方精力湯': '全配方',
  '內用精力湯':   '內用'
};
const SYNC_AHEAD_DAYS = 14;          // 往後同步幾天的預約
let _apptCache = { at: 0, data: null };

// 預約系統的 Firebase 在 2026-08-29 把 clinic_v3 的讀取權從「任何人可讀」
// 改成「必須持有憑證」（那是對的，原本知道網址就能讀寫整個診所資料）。
// 廚房是伺服器對伺服器，所以用服務帳號 —— 它會繞過規則，也不必跟著
// 匿名登入那條路走（規則的註解自己也說匿名擋不住有心人）。
//
// 憑證放在 FIREBASE_SERVICE_ACCOUNT_JSON 環境變數，跟 assistant-service 同一把。
// 沒設定的話仍會嘗試不帶憑證讀 —— 那會拿到 401，而錯誤訊息會講清楚要設什麼。
const FB_SCOPE = 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/firebase.database';
let _fbToken = { token: null, expiresAt: 0 };

async function firebaseAccessToken() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  if (_fbToken.token && _fbToken.expiresAt > Date.now()) return _fbToken.token;

  const { createSign } = require('node:crypto');
  let acct;
  try { acct = JSON.parse(raw); }
  catch (e) { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON 不是合法的 JSON'); }
  if (!acct.client_email || !acct.private_key || !acct.token_uri)
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON 缺少 client_email / private_key / token_uri');

  const iat = Math.floor(Date.now() / 1000);
  const enc = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  const head  = enc({ alg: 'RS256', typ: 'JWT' });
  const claim = enc({ iss: acct.client_email, scope: FB_SCOPE, aud: acct.token_uri,
                      iat, exp: iat + 3600 });
  const signer = createSign('RSA-SHA256');
  signer.update(head + '.' + claim);
  signer.end();
  const assertion = head + '.' + claim + '.' + signer.sign(acct.private_key, 'base64url');

  const r = await fetch(acct.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + assertion,
    signal: AbortSignal.timeout(8000)
  });
  // 不要把回應內容放進錯誤訊息 —— 那裡面可能帶著憑證相關的東西
  if (!r.ok) throw new Error('取得 Firebase 存取權杖失敗（HTTP ' + r.status + '）');
  const j = await r.json();
  if (!j.access_token) throw new Error('Firebase 沒有回傳存取權杖');
  // 權杖有效 1 小時，提前 15 分鐘換發
  _fbToken = { token: j.access_token, expiresAt: Date.now() + 45 * 60 * 1000 };
  return j.access_token;
}

async function fetchAppts() {
  const now = Date.now();
  if (_apptCache.data && now - _apptCache.at < 120000) return _apptCache.data;   // 快取 2 分鐘
  const token = await firebaseAccessToken();
  const r = await fetch(APPTS_URL, {
    headers: token ? { authorization: 'Bearer ' + token } : {},
    signal: AbortSignal.timeout(8000)
  });
  // 一定要檢查狀態碼。Firebase 的 401 回的是 {"error":"Permission denied"} ——
  // 那是合法 JSON，直接 .json() 會當成正常資料收下，然後在上面找不到任何日期，
  // 於是回報「同步成功、0 筆」。權限被關掉了卻沒有人知道
  if (!r.ok) {
    const hint = (r.status === 401 || r.status === 403) && !token
      ? '：預約系統已改成需要憑證，請在 Railway 設定 FIREBASE_SERVICE_ACCOUNT_JSON'
      : '';
    throw new Error(`預約系統回 HTTP ${r.status}${hint}`);
  }
  const j = await r.json();
  if (j && typeof j === 'object' && j.error && !Array.isArray(j)) {
    throw new Error('預約系統：' + String(j.error).slice(0, 80));
  }
  _apptCache = { at: now, data: j || {} };
  return _apptCache.data;
}

// '09:30' → '0930'；取不到就用預設用餐時間
function apptTimeToMeal(t) {
  const m = String(t || '').match(/(\d{1,2}):(\d{2})/);
  return m ? String(m[1]).padStart(2, '0') + m[2] : '1330';
}

// 最近一次同步的結果。讀不到預約時只寫 console 沒有人看得到 ——
// 實際發生過：預約系統的權限被改掉之後回 401，廚房那邊什麼都沒帶進來，
// 大家以為是自己忘了 key，默默改成全部手動建單
let lastApptSync = { at: null, ok: null, error: null, created: 0, updated: 0 };

async function syncApptOrders() {
  let appts;
  try {
    appts = await fetchAppts();
  } catch (err) {
    console.error('讀取預約系統失敗:', err.message);
    lastApptSync = { at: new Date().toISOString().slice(0, 19).replace('T', ' '),
                     ok: false, error: err.message, created: 0, updated: 0 };
    return { created: 0, error: err.message };
  }

  const from = today();
  const to   = new Date(Date.now() + SYNC_AHEAD_DAYS * 86400000).toISOString().slice(0, 10);

  // 患者姓名 → 自己的處方（個案處方，不含員工標準）
  const rxByName = {};
  db.prepare("SELECT id,name FROM prescriptions WHERE active=1 AND is_staff_rx=0").all()
    .forEach(r => { if (r.name) rxByName[String(r.name).trim()] = r.id; });
  // 沒有自己處方的患者，先掛員工標準配方並在備註標明，讓廚房人員確認
  // 用當期的員工處方當後備，不要寫死 EMP-00 —— 那張已經退役，
  // 掛上去的出單會抓不到配方，備料和扣庫存都會是空的
  const emp = staffRxFor(today());
  const fallbackId = emp ? emp.id : 1;

  // 已被廚房人員刪掉的，不再重建
  const dismissed = new Set(
    db.prepare('SELECT source_key FROM appt_sync_dismissed').all().map(r => r.source_key)
  );

  const ins = db.prepare(
    `INSERT OR IGNORE INTO case_orders
       (date,prescription_id,cups,meal_time,powder_type,patient_name,notes,source_key,
        sync_source,appt_meal_time)
     VALUES (?,?,?,?,?,?,?,?, 'auto', ?)`
  );
  // 廚房沒改過的（sync_source='auto'）就跟著預約更新；改過的只更新 appt_meal_time，
  // 好讓畫面能標出「預約是幾點、這裡是幾點」
  const updAuto = db.prepare(
    `UPDATE case_orders SET meal_time=?, patient_name=?, notes=?, appt_meal_time=?, cups=?
     WHERE source_key=? AND COALESCE(sync_source,'auto')='auto'`
  );
  const updApptTime = db.prepare(
    `UPDATE case_orders SET appt_meal_time=? WHERE source_key=?`
  );

  let created = 0, updated = 0, skipped = 0, adopted = 0;
  const seenByDate = {};   // 這次同步在每一天看到的 source_key，用來找出被取消的預約

  Object.keys(appts || {}).forEach(date => {
    if (date < from || date > to) return;
    const raw = appts[date];
    const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
    seenByDate[date] = new Set();
    list.forEach(a => {
      if (!a || typeof a !== 'object' || !a.id) return;
      // 預約系統是用「重複列出同一個項目」來表達數量的：
      // 「內用精力湯、內用精力湯」＝ 兩杯。原本每個項目各跑一次、
      // 固定建 1 杯，而且 source_key 相同會被 INSERT OR IGNORE 擋掉，
      // 所以兩杯的預約帶進來只會變成一杯
      const wanted = {};
      (a.items || []).forEach(item => {
        const p = APPT_ITEM_MAP[item];
        if (p) wanted[p] = (wanted[p] || 0) + 1;
      });
      Object.entries(wanted).forEach(([powder, cups]) => {
        if (dismissed.has('appt:' + a.id + ':' + powder)) return;
        const name = String(a.name || '').trim();
        const rxId = rxByName[name];
        // 預約上的備註帶進來。原本被固定字串蓋掉，像「先.BIPAP 後.精力湯」
        // 這種出餐順序指示就整段消失了
        const apptNote = String(a.note || '').replace(/\s*\n\s*/g, ' · ').trim();
        const note = [
          '[預約帶入]',
          rxId ? '' : '此患者尚未建立處方，暫用員工標準配方，請確認',
          apptNote
        ].filter(Boolean).join(' ');

        const mealTime = apptTimeToMeal(a.start);
        const key = 'appt:' + a.id + ':' + powder;
        seenByDate[date].add(key);

        // 廚房可能已經手動建過同一筆（連不上預約的那段期間就是這樣）。
        // 認領它而不是再建一張 —— 否則一接通就會冒出一堆重複單
        const manual = db.prepare(
          `SELECT id FROM case_orders
            WHERE date=? AND patient_name=? AND powder_type=? AND COALESCE(source_key,'')=''
            ORDER BY id LIMIT 1`
        ).get(date, name, powder);
        if (manual) {
          db.prepare(
            "UPDATE case_orders SET source_key=?, appt_meal_time=?, sync_source='manual' WHERE id=?"
          ).run(key, mealTime, manual.id);
          adopted++;
          return;   // 認領過就不再動它的內容，人改過的優先
        }

        const r = ins.run(date, rxId || fallbackId, cups, mealTime, powder, name, note, key, mealTime);
        if (r.changes) {
          created++;
        } else {
          skipped++;
          // 已存在：預約若改了時間、備註或杯數，沒被廚房改過的要跟著更新
          const u = updAuto.run(mealTime, name, note, mealTime, cups, key);
          if (u.changes) updated++; else updApptTime.run(mealTime, key);
        }
      });
    });
  });
  // 找出預約已經不在了、單卻還留著的（預約被取消或改期）。
  // 只檢查這次確實有抓到資料的日期 —— 沒抓到資料的日期不能當作「預約沒了」
  let missing = 0;
  Object.entries(seenByDate).forEach(([date, keys]) => {
    const rows = db.prepare(
      "SELECT id, source_key, appt_missing FROM case_orders WHERE date=? AND COALESCE(source_key,'')<>''"
    ).all(date);
    rows.forEach(r => {
      const gone = keys.has(r.source_key) ? 0 : 1;
      if ((r.appt_missing || 0) !== gone) {
        db.prepare('UPDATE case_orders SET appt_missing=? WHERE id=?').run(gone, r.id);
      }
      if (gone) missing++;
    });
  });

  if (created || updated || missing) {
    console.log(`預約帶入：新建 ${created} 筆、認領既有手動單 ${adopted} 筆、更新 ${updated} 筆、預約已不存在 ${missing} 筆（已存在 ${skipped} 筆）`);
  }
  lastApptSync = { at: new Date().toISOString().slice(0, 19).replace('T', ' '),
                   ok: true, error: null, created, updated, adopted };
  return { created, skipped, adopted };
}

// 計算批次：batch_size=3 用 3+2 最佳化，其他用整除
function calcBatches(cups, batchSize) {
  batchSize = batchSize || 3;
  if (batchSize === 3) {
    const mod   = cups % 3;
    const three = mod === 1 ? Math.floor(cups/3) - 1 : Math.floor(cups/3);
    const two   = mod === 0 ? 0 : mod === 1 ? 2 : 1;
    return [
      ...(three > 0 ? [{ size: 3, count: three }] : []),
      ...(two   > 0 ? [{ size: 2, count: two   }] : [])
    ];
  }
  const full = Math.floor(cups / batchSize);
  const rem  = cups % batchSize;
  return [
    ...(full > 0 ? [{ size: batchSize, count: full }] : []),
    ...(rem  > 0 ? [{ size: rem,       count: 1    }] : [])
  ];
}

// 加權平均單價 (NT$/unit)
// ── 食材單價 ──────────────────────────────────────────────
// 加權平均只看最近一段期間的採購。把全部歷史平均進去，漲價會被幾個月前的
// 舊價一直稀釋，成本報表就跟不上現實。期間內沒有任何採購的食材，
// 退回用全部歷史計算，免得單價變成 0。
function getSettings() {
  const s = {};
  // 只有整個值就是數字才轉數字。日期（2026-08-31）和比例（1:1,2:1,3:2）
  // 用 parseFloat 會被悄悄截成 2026 和 1，讀到的人不會發現出了錯
  db.prepare('SELECT key,value FROM settings').all().forEach(r => {
    const raw = String(r.value ?? '').trim();
    // 這個 regex 的反斜線曾經掉過（變成 /^-?d+(.d+)?$/），
    // 那樣 d 是字面上的字母 d、. 配任何字元 —— 結果「90」「250」全部
    // 留成字串，只有「d」「dxd」會被當成數字。等於這一行從來沒生效。
    //
    // 當時沒有算錯任何數字，純粹是運氣：用它的兩個地方一個用 *（會自動轉型）、
    // 一個有自己的 num()。但下一個寫 settings.full_formula_price + x 的人就會中，
    // 而同一種 bug 已經讓人工成本被算成 6.6 倍過一次（見 laborParams 的註解）。
    s[r.key] = /^-?\d+(\.\d+)?$/.test(raw) ? parseFloat(raw) : r.value;
  });
  return s;
}

function costLookbackFrom(settings) {
  const days = (settings && settings.cost_lookback_days) || 0;
  if (!days || days <= 0) return null;              // 0 = 不限期間
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function buildUnitCostCache(settings) {
  const from = costLookbackFrom(settings || getSettings());
  const all = {};
  db.prepare(
    `SELECT ingredient_id, SUM(total_price) tp, SUM(qty) tq
     FROM purchase_log GROUP BY ingredient_id`
  ).all().forEach(r => { all[r.ingredient_id] = r.tq > 0 ? r.tp / r.tq : 0; });

  if (!from) return all;

  const recent = {};
  db.prepare(
    `SELECT ingredient_id, SUM(total_price) tp, SUM(qty) tq
     FROM purchase_log WHERE purchased_at >= ? GROUP BY ingredient_id`
  ).all(from).forEach(r => { if (r.tq > 0) recent[r.ingredient_id] = r.tp / r.tq; });

  // 期間內有採購就用近期價，沒有才退回全部歷史
  return { ...all, ...recent };
}

function unitCost(ingredientId) {
  return buildUnitCostCache()[ingredientId] || 0;
}

// 每樣食材的單價是幾筆採購算出來的。
//
// 成本頁原本只給一個數字，看不出它穩不穩。窗口內只剩一筆的時候，
// 那一筆就決定整份配方的成本 —— 而且它會隨著舊紀錄滑出 90 天窗口
// 自己跳動（橄欖油 −20%、蛋白粉 +17%，什麼都不做也會變）。
// 幾筆算出來的，跟數字本身一樣重要。
function unitCostDetail(settings) {
  const st = settings || getSettings();
  const from = costLookbackFrom(st);
  const out = {};
  const rowsAll = db.prepare(
    `SELECT ingredient_id id, COUNT(*) n, SUM(total_price) tp, SUM(qty) tq,
            MIN(purchased_at) first, MAX(purchased_at) last
       FROM purchase_log GROUP BY ingredient_id`
  ).all();
  rowsAll.forEach(r => {
    out[r.id] = { price: r.tq > 0 ? r.tp / r.tq : 0, n: r.n,
                  source: 'history', first: r.first, last: r.last };
  });
  if (from) {
    db.prepare(
      `SELECT ingredient_id id, COUNT(*) n, SUM(total_price) tp, SUM(qty) tq,
              MIN(purchased_at) first, MAX(purchased_at) last
         FROM purchase_log WHERE purchased_at >= ? GROUP BY ingredient_id`
    ).all(from).forEach(r => {
      if (r.tq > 0) out[r.id] = { price: r.tp / r.tq, n: r.n,
                                  source: 'window', first: r.first, last: r.last };
    });
  }
  return { from, detail: out };
}

// ── 工時 ──────────────────────────────────────────────────
// 一鍋 3 杯的備料只做一次，所以拆成「每批固定 + 每杯額外」，
// 而不是每杯都算一份完整備料工。
function laborParams(settings) {
  // 一定要轉成數字。settings 存的是 TEXT，拿字串去算 (15/3 + "3") 會得到
  // "53" 而不是 8 —— 除法會自動轉型，加法卻變成字串串接。
  // 人工成本因此被算成 6.6 倍，而且數字看起來只是「有點高」，不像壞掉
  const num = (v, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) && v !== null && v !== '' ? n : dflt;
  };
  return {
    rate:       num(settings.labor_rate, 250),
    perBatch:   num(settings.labor_min_per_batch, 15),
    perServing: num(settings.labor_min_per_serving, 3)
  };
}

// 每杯的標準工時成本（給處方成本參考表用，把每批工時攤到每杯）
function laborPerCup(lp, batchSize) {
  const size = Number(batchSize) || 3;
  return (lp.perBatch / size + lp.perServing) * lp.rate / 60;
}

// 某日實際工時成本：當天有登記工時就用實際的，沒有才用批次估算
function dayLaborCost(date, lp, batchCount, cups) {
  const rec = db.prepare(
    `SELECT COALESCE(SUM(minutes * COALESCE(NULLIF(hourly_rate,0), ?) / 60.0), 0) cost,
            COALESCE(SUM(minutes),0) mins, COUNT(*) n
     FROM labor_records WHERE date=? AND purpose='精力湯'`
  ).get(lp.rate, date);

  if (rec.n > 0) {
    return { cost: rec.cost, minutes: rec.mins, basis: 'actual' };
  }
  const minutes = batchCount * lp.perBatch + cups * lp.perServing;
  return { cost: minutes * lp.rate / 60, minutes, basis: 'estimated' };
}

// 計算某日各產品實際成本（員工批次 + 個案）
function calcDailyCost(date, ucCache, lp) {
  const products = db.prepare(
    'SELECT * FROM products WHERE active=1 ORDER BY sort_order, id'
  ).all();
  const attendingCount = db.prepare(
    'SELECT COUNT(*) as c FROM staff_attendance WHERE date=? AND attending=1'
  ).get(date)?.c || 0;

  const productCosts = [];
  let grandTotal = 0;
  let dayBatches = 0, dayCups = 0;   // 全日批次數與杯數，用來估算工時

  for (const prod of products) {
    let ingCost = 0, staffCups = 0, caseCups = 0;

    // 員工批次
    const staffRx = staffRxFor(date, prod.id);
    if (staffRx && attendingCount > 0) {
      staffCups = attendingCount;
      db.prepare(
        'SELECT ingredient_id, qty_per_cup FROM prescription_ingredients WHERE prescription_id=?'
      ).all(staffRx.id).forEach(ri => {
        ingCost += ri.qty_per_cup * staffCups * (ucCache[ri.ingredient_id] || 0);
      });
    }

    // 個案出單。用員工標準配方的併入員工批次，其餘各自一鍋
    let staffRxCaseCups = 0, soloBatches = 0;
    db.prepare(
      `SELECT co.cups, co.prescription_id, p.is_staff_rx FROM case_orders co
       JOIN prescriptions p ON p.id=co.prescription_id
       WHERE co.date=? AND p.product_id=?`
    ).all(date, prod.id).forEach(o => {
      caseCups += o.cups;
      if (o.is_staff_rx) staffRxCaseCups += o.cups; else soloBatches += 1;
      db.prepare(
        'SELECT ingredient_id, qty_per_cup FROM prescription_ingredients WHERE prescription_id=?'
      ).all(o.prescription_id).forEach(ri => {
        ingCost += ri.qty_per_cup * o.cups * (ucCache[ri.ingredient_id] || 0);
      });
    });

    const totalCups = staffCups + caseCups;
    if (totalCups > 0) {
      // 批次數：員工批次（含用員工配方的個案）＋ 各自現打的個案
      const staffPool   = staffCups + staffRxCaseCups;
      const staffBatches = staffPool > 0
        ? calcBatches(staffPool, prod.batch_size).reduce((s, b) => s + b.count, 0) : 0;
      dayBatches += staffBatches + soloBatches;
      dayCups    += totalCups;

      productCosts.push({
        product_id:      prod.id,
        product_name:    prod.name,
        product_unit:    prod.unit,
        staff_cups:      staffCups,
        case_cups:       caseCups,
        total_cups:      totalCups,
        batches:         staffBatches + soloBatches,
        ingredient_cost: Math.round(ingCost * 10) / 10,
        labor_cost:      0,        // 工時是全日一起算，下面再按杯數分攤回各產品
        total_cost:      Math.round(ingCost * 10) / 10,
        cost_per_cup:    Math.round(ingCost / totalCups * 10) / 10
      });
    }
  }

  // 工時：當天有登記就用實際的，沒有才用「批次數 × 每批 + 杯數 × 每杯」估算。
  // 算出來的總工時再按杯數分攤回各產品，這樣每杯成本才含工資。
  const labor = dayLaborCost(date, lp, dayBatches, dayCups);
  productCosts.forEach(p => {
    const share = dayCups > 0 ? labor.cost * (p.total_cups / dayCups) : 0;
    p.labor_cost   = Math.round(share * 10) / 10;
    p.total_cost   = Math.round((p.ingredient_cost + share) * 10) / 10;
    p.cost_per_cup = Math.round(p.total_cost / p.total_cups * 10) / 10;
    grandTotal    += p.total_cost;
  });

  // 餐盒是外購品，成本不走食材加權平均，直接看實付金額。
  // 還沒回填採購的日子先用出單快照價當預估，並標明來源。
  let mealCost = { count: 0, planned: 0, actual: 0, basis: 'none', total: 0 };
  try {
    // 付錢是按盒付的，分食時人數多於盒數，用 qty 乘會多算
    const planRows = db.prepare(
      'SELECT snap_price, qty, share_people, share_boxes FROM meal_orders WHERE date=?'
    ).all(date);
    const planned = {
      p: planRows.reduce((t, o) => t + (o.snap_price || 0) * boxesForOrder(o), 0),
      c: planRows.reduce((t, o) => t + (Number(o.qty) || 0), 0)   // 份數仍以人計
    };
    const actual = db.prepare(
      'SELECT COALESCE(SUM(total_price),0) p, COUNT(*) n FROM meal_purchase_log WHERE date=?'
    ).get(date);
    const basis = actual.n > 0 ? 'actual' : (planned.c > 0 ? 'planned' : 'none');
    const total = basis === 'actual' ? actual.p : (basis === 'planned' ? planned.p : 0);
    mealCost = {
      count:   planned.c,
      planned: Math.round(planned.p * 10) / 10,
      actual:  Math.round(actual.p * 10) / 10,
      basis,
      total:   Math.round(total * 10) / 10
    };
    grandTotal += total;
  } catch(e) {}

  return {
    date, products: productCosts, meals: mealCost,
    labor: {
      basis:   labor.basis,          // actual = 有登記工時；estimated = 依批次估算
      minutes: Math.round(labor.minutes || 0),
      cost:    Math.round(labor.cost * 10) / 10,
      batches: dayBatches, cups: dayCups
    },
    grand_total: Math.round(grandTotal * 10) / 10
  };
}

// ════════════════════════════════════════════════════════
// API: 使用者
// ════════════════════════════════════════════════════════

app.get('/api/users', (req, res) => {
  res.json(db.prepare('SELECT * FROM users ORDER BY id').all());
});

app.post('/api/users', (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: '請輸入姓名' });
  try {
    const r = db.prepare('INSERT INTO users (name) VALUES (?)').run(name.trim());
    res.json({ id: r.lastInsertRowid, name: name.trim() });
  } catch(e) {
    res.status(400).json({ error: '姓名已存在' });
  }
});

// ── 操作紀錄 ──────────────────────────────────────────────
// 原本的設計是「前端呼叫 /api/log」，結果沒有人呼叫過，線上累積 0 筆。
// 靠每個新功能記得自己去記一筆，注定會漏 —— 改成伺服器自動記：
// 它本來就知道是誰在呼叫、動了哪個端點、送了什麼。
//
// 只記會改變資料的請求（非 GET），而且只記成功的。
const LOG_SKIP = [
  '/api/today/state',      // 每次勾選都會存，400ms 一次，記了會把紀錄淹掉
  '/api/log'               // 這條本身就是寫紀錄
];
// 密碼一律不進紀錄
const LOG_REDACT = new Set(['password', 'new_password', 'pw', 'token',
                            'FIREBASE_SERVICE_ACCOUNT_JSON']);

// 把路徑翻成看得懂的動作名稱。查紀錄的人不該需要看得懂 REST
const LOG_NAMES = [
  [/^\/api\/prescriptions\/\d+\/ingredients$/, '修改配方用料'],
  [/^\/api\/prescriptions\/\d+\/duplicate$/,   '複製處方'],
  [/^\/api\/prescriptions\/\d+$/,               m => m === 'DELETE' ? '停用處方' : '修改處方'],
  [/^\/api\/prescriptions$/,                     '新增處方'],
  [/^\/api\/today\/cases\/\d+$/,               m => m === 'DELETE' ? '刪除出單' : '修改出單'],
  [/^\/api\/today\/cases$/,                      '新增出單'],
  [/^\/api\/today\/attendance\/\d+$/,          '改出席'],
  [/^\/api\/inventory\/purchase$/,               '進貨'],
  [/^\/api\/inventory\/consume$/,                '扣庫存'],
  [/^\/api\/inventory\/\d+$/,                   '調整庫存'],
  [/^\/api\/stocktake$/,                          '盤點'],
  [/^\/api\/consumption\/\d+\/reverse$/,       '還原補扣'],
  [/^\/api\/rotation\/plan\/override$/,         '手動指定蔬果方案'],
  [/^\/api\/rotation\/plan\/override\/\d+$/,  '取消方案指定'],
  [/^\/api\/settings$/,                           '改設定'],
  [/^\/api\/ingredients\/\d+$/,                 m => m === 'DELETE' ? '停用食材' : '修改食材'],
  [/^\/api\/ingredients$/,                        '新增食材'],
  [/^\/api\/meals\/orders\/\d+$/,              m => m === 'DELETE' ? '刪除餐盒單' : '修改餐盒單'],
  [/^\/api\/meals\/orders$/,                     '新增餐盒單']
];

function logActionName(path, method) {
  for (const [re, name] of LOG_NAMES) {
    if (re.test(path)) return typeof name === 'function' ? name(method) : name;
  }
  return method + ' ' + path;
}

function logDetail(body) {
  if (!body || typeof body !== 'object') return '';
  const pick = {};
  Object.entries(body).forEach(([k, v]) => {
    if (LOG_REDACT.has(k)) { pick[k] = '***'; return; }
    if (v === null || v === undefined || v === '') return;
    if (typeof v === 'object') { pick[k] = Array.isArray(v) ? `${v.length} 項` : '…'; return; }
    pick[k] = v;
  });
  const s = JSON.stringify(pick);
  return s.length > 400 ? s.slice(0, 400) + '…' : s;
}

app.post('/api/log', (req, res) => {
  const { user_id, action, detail } = req.body;
  db.prepare('INSERT INTO user_logs (user_id,action,detail) VALUES (?,?,?)')
    .run(user_id||null, action||'', detail||'');
  res.json({ ok: true });
});

app.get('/api/logs', (req, res) => {
  const limit  = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);
  const q      = String(req.query.q || '').trim();
  const rows = db.prepare(
    `SELECT l.*, u.name as user_name FROM user_logs l
      LEFT JOIN users u ON u.id=l.user_id
      WHERE (? = '' OR l.action LIKE '%' || ? || '%' OR COALESCE(u.name,'') LIKE '%' || ? || '%')
      ORDER BY l.ts DESC, l.id DESC LIMIT ?`
  ).all(q, q, q, limit);
  const total = db.prepare('SELECT COUNT(*) c FROM user_logs').get().c;
  res.json({ total, count: rows.length, rows });
});

// ════════════════════════════════════════════════════════
// API: 產品管理
// ════════════════════════════════════════════════════════

app.get('/api/products', (req, res) => {
  res.json(db.prepare('SELECT * FROM products ORDER BY sort_order, id').all());
});

app.post('/api/products', (req, res) => {
  const { name, unit, batch_size, description } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: '請填寫產品名稱' });
  try {
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) as m FROM products').get().m;
    const r = db.prepare(
      `INSERT INTO products (name, unit, batch_size, description, sort_order) VALUES (?,?,?,?,?)`
    ).run(name.trim(), unit||'份', parseInt(batch_size)||1, description||'', maxOrder+1);
    res.json({ id: r.lastInsertRowid });
  } catch(e) { res.status(400).json({ error: '產品名稱已存在' }); }
});

app.put('/api/products/:id', (req, res) => {
  const { name, unit, batch_size, description, active } = req.body;
  db.prepare(
    `UPDATE products SET name=?,unit=?,batch_size=?,description=?,active=? WHERE id=?`
  ).run(name, unit||'份', parseInt(batch_size)||1, description||'', active===undefined?1:active, req.params.id);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════
// API: 今日工作單
// ════════════════════════════════════════════════════════

// powderMultiplier: 1.0 袋裝 / 1.1 罐裝（多備10%防溢）
function buildPrepAndPowder(rxId, multiplier, unit, powderMultiplier, date, powderType) {
  powderMultiplier = powderMultiplier || 1.0;
  // 備料表也要照包裝走。基底粉那幾杯不必秤菜 ——
  // 秤了也用不到，而且會讓備料的人以為量不對
  const allItems = servedItems(rxId, date, powderType)
    .map(r => ({ qty_per_cup: r.qty_per_cup, prep_note: r.prep, name: r.name,
                 unit: r.unit, category: r.category }));
  // prep = 鮮食（蔬菜/水果/油/水/其他）。prep_note 是處理方式，備料時要看得到
  const freshCats = new Set(['蔬菜', '水果', '油水', '油', '水', '其他']);
  const prep = allItems.filter(r => freshCats.has(r.category)).map(r => ({
    name: r.name, unit: r.unit, category: r.category,
    prep_note: r.prep_note,
    per_serving: r.qty_per_cup,
    total: Math.round(r.qty_per_cup * multiplier * 10) / 10
  }));
  // powder = 粉類（計重）
  const powderItems = allItems.filter(r => r.category === '粉類');
  const powderPerServing = powderItems.reduce((s, r) => s + r.qty_per_cup, 0);
  const powder = {
    per_serving:       Math.round(powderPerServing * 10) / 10,
    per_serving_adj:   Math.round(powderPerServing * powderMultiplier * 10) / 10,
    total:             Math.round(powderPerServing * multiplier * powderMultiplier * 10) / 10,
    powder_multiplier: powderMultiplier,
    items:             powderItems.map(r => ({ name: r.name, qty: r.qty_per_cup, unit: r.unit }))
  };
  // supplements = 保健品（顆/包，獨立顯示）
  const supplements = allItems.filter(r => r.category === '保健品').map(r => ({
    name: r.name, unit: r.unit,
    per_serving: r.qty_per_cup,
    total: Math.round(r.qty_per_cup * multiplier * 10) / 10
  }));
  return { prep, powder, supplements };
}

app.get('/api/today', async (req, res) => {
  const date = today();

  // 0. 先把預約系統的精力湯／基底粉項目帶入成個案出單（只新增，不動既有資料）
  try { await syncApptOrders(); } catch (err) { console.error('預約帶入失敗:', err.message); }
  try { await syncApptMealOrders(); } catch (err) { console.error('餐盒預約帶入失敗:', err.message); }

  // 過去幾天沒人確認出餐的，在這裡補扣。只補差額，而且可以還原
  let autoSettled = [];
  try { autoSettled = settleRecentDays(req.kitchenUser.id); }
  catch (err) { console.error('自動補扣失敗:', err.message); }

  // 1. Fetch leaves from Firebase clinic system
  // 名字比對一律正規化：預約系統寫的是 'louise'，這裡的使用者叫 'Louise'，
  // 大小寫不一致會讓休假的人被算成出席，杯數就多一杯
  const leavesSet = new Set();
  const leavesToday = [];
  try {
    const response = await fetch('https://clinic-system-1224f-default-rtdb.asia-southeast1.firebasedatabase.app/clinic_v3/leaves.json', { signal: AbortSignal.timeout(3000) });
    const leavesList = await response.json();
    if (Array.isArray(leavesList)) {
      leavesList.forEach(l => {
        if (l && l.date === date && l.name) {
          leavesSet.add(normName(l.name));
          leavesToday.push(l.name);
        }
      });
    }
  } catch (err) {
    console.error('Failed to fetch leaves from clinic system:', err.message);
  }

  // 2. 今天是不是員工供應日
  const dow = new Date(date).getDay();
  const isMealDay = isStaffMealDay(dow);

  // 3. Initialize attendance table
  // source='auto' 的列是系統推導出來的，休假資料變動時要跟著更新；
  // 一旦廚房人員手動改過（source='manual'）就不再覆蓋
  const users = db.prepare('SELECT * FROM users').all();
  users.forEach(u => {
    const onLeave  = leavesSet.has(normName(u.name));
    const expected = (isMealDay && !onLeave) ? 1 : 0;
    const row = db.prepare(
      "SELECT attending, COALESCE(source,'auto') source FROM staff_attendance WHERE date=? AND user_id=?"
    ).get(date, u.id);

    if (!row) {
      db.prepare(
        `INSERT INTO staff_attendance (date,user_id,attending,meal_time,source) VALUES (?,?,?,'1330','auto')`
      ).run(date, u.id, expected);
    } else if (row.source === 'auto' && row.attending !== expected) {
      db.prepare('UPDATE staff_attendance SET attending=? WHERE date=? AND user_id=?')
        .run(expected, date, u.id);
    }
  });

  const staff = db.prepare(
    `SELECT sa.*, u.name FROM staff_attendance sa
     JOIN users u ON u.id=sa.user_id WHERE sa.date=? ORDER BY u.id`
  ).all(date);
  const attendingCount = staff.filter(s => s.attending).length;

  // 每個產品的今日資料
  const products = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY sort_order, id').all();

  const productData = products.map(prod => {
    // 員工標準處方
    const staffRx = staffRxFor(date, prod.id);

    // 個案出單（今日，此產品）— 先取得以計算批次
    const cases = db.prepare(
      `SELECT co.*, p.code, p.name as rx_name, p.formula_type,
              p.contraindications, p.timing, p.is_staff_rx
       FROM case_orders co
       JOIN prescriptions p ON p.id=co.prescription_id
       WHERE co.date=? AND p.product_id=? ORDER BY co.meal_time`
    ).all(date, prod.id);

    // 使用員工配方的個案 → 計入員工批次
    const staffRxCases = cases.filter(c => c.is_staff_rx);
    const extraCups    = staffRxCases.reduce((s, c) => s + c.cups, 0);
    const totalStaffCups = attendingCount + extraCups;

    const batches = calcBatches(totalStaffCups, prod.batch_size);

    let staffPrep = [], staffPowder = { per_serving: 0, items: [], batches: [] };
    if (staffRx && totalStaffCups > 0) {
      // 員工餐一律是完整的一杯，不會只給粉
      const { prep, powder } = buildPrepAndPowder(staffRx.id, totalStaffCups, prod.unit, 1.0, date, '');
      staffPrep = prep;
      const powderBatches = batches.map(b => ({
        label: `${b.size}${prod.unit}批 ×${b.count}`,
        per_batch: Math.round(powder.per_serving * b.size * 10) / 10,
        count: b.count
      }));
      staffPowder = { ...powder, batches: powderBatches };
    }

    const casesWithPrep = cases.map(c => {
      const pm = powderMultFor(c.powder_type);
      const { prep, powder, supplements } =
        buildPrepAndPowder(c.prescription_id, c.cups, prod.unit, pm, date, c.powder_type);
      return { ...c, prep, powder, supplements };
    });

    // 預約出單（未來日期）
    const futureCases = db.prepare(
      `SELECT co.*, p.code, p.name as rx_name, p.formula_type,
              p.contraindications, p.timing, p.is_staff_rx
       FROM case_orders co
       JOIN prescriptions p ON p.id=co.prescription_id
       WHERE co.date>? AND p.product_id=? ORDER BY co.date, co.meal_time`
    ).all(date, prod.id);
    const futureCasesWithPrep = futureCases.map(c => {
      const pm = powderMultFor(c.powder_type);
      // 預約出單可能落在下一個方案期，用那一筆自己的日期去查方案
      const { prep, powder, supplements } =
        buildPrepAndPowder(c.prescription_id, c.cups, prod.unit, pm, c.date, c.powder_type);
      return { ...c, prep, powder, supplements };
    });

    return {
      id:               prod.id,
      name:             prod.name,
      unit:             prod.unit,
      batch_size:       prod.batch_size,
      description:      prod.description,
      attending_count:  attendingCount,
      extra_cups:       extraCups,
      total_staff_cups: totalStaffCups,
      staff_rx_cases:   staffRxCases.map(c => ({
        id: c.id, patient_name: c.patient_name, rx_name: c.rx_name,
        cups: c.cups, meal_time: c.meal_time, prescription_id: c.prescription_id
      })),
      batches,
      staff_rx:         staffRx || null,
      staff_prep:       staffPrep,
      staff_powder:     staffPowder,
      cases:            casesWithPrep,
      future_cases:     futureCasesWithPrep
    };
  });

  // 當日工作狀態隨 /api/today 一起送，前端不必再多打一次
  const stateRow = db.prepare('SELECT state, updated_at, updated_by FROM day_state WHERE date=?').get(date);

  // 今天的訂閱杯。訂閱在自己那一頁管，但出餐時要跟員工、個案並排看得到 ——
  // 分開兩個畫面的話，做餐的人得記得去看第二個地方，遲早會漏一杯
  const subsToday = subscriptionsOnDate(date).map(ss => {
    const pk = db.prepare(
      `SELECT sp.status, sp.picked_by_user_id, u.name picked_by_name
         FROM subscription_pickups sp
         LEFT JOIN users u ON u.id = sp.picked_by_user_id
        WHERE sp.subscription_id=? AND sp.date=?`).get(ss.id, date);
    return {
      subscription_id: ss.id, user_id: ss.user_id, user_name: ss.user_name,
      prescription_id: ss.prescription_id, rx_code: ss.rx_code, rx_name: ss.rx_name,
      powder_type: ss.powder_type,
      status: pk ? pk.status : 'pending',
      picked_by_user_id: pk ? pk.picked_by_user_id : null,
      picked_by_name: pk && pk.picked_by_user_id && pk.picked_by_user_id !== ss.user_id
        ? pk.picked_by_name : null
    };
  });

  res.json({
    date, staff, attending_count: attendingCount, products: productData,
    leaves: leavesToday, is_meal_day: isMealDay, meals: buildMealDay(date),
    subscriptions: subsToday,
    is_closed: isClosed(date),
    closure_reason: isClosed(date)
      ? (db.prepare('SELECT reason FROM kitchen_closures WHERE date=?').get(date).reason || '') : '',
    // 供應日只在伺服器定義一次，SOP 說明文字也讀這個，不再各寫一份
    staff_meal_dows:  staffMealDows(),
    staff_meal_label: staffMealDaysLabel(),
    roster_count:     rosterCount(),
    auto_settled:     autoSettled,   // 這次載入補扣了哪幾天
    // 預約帶入的狀態。讀不到預約時畫面要講出來 ——
    // 「沒有預約」和「讀不到預約」看起來一模一樣，但意思完全不同
    appt_sync: lastApptSync,
    day_state: stateRow ? {
      state:      JSON.parse(stateRow.state || '{}'),
      updated_at: stateRow.updated_at,
      updated_by: stateRow.updated_by
    } : null
  });
});

// 更新員工出席。手動改過就標成 manual，之後休假同步不再覆蓋這一列
app.put('/api/today/attendance/:userId', (req, res) => {
  const { attending, meal_time } = req.body;
  const date = today();
  db.prepare(
    `INSERT INTO staff_attendance (date,user_id,attending,meal_time,source) VALUES (?,?,?,?, 'manual')
     ON CONFLICT(date,user_id) DO UPDATE SET attending=excluded.attending,
            meal_time=excluded.meal_time, source='manual'`
  ).run(date, req.params.userId, attending ? 1 : 0, meal_time || '1330');
  res.json({ ok: true });
});

// ── 當日工作狀態（批次分組、拿取勾選、庫存已扣紀錄）────────
// 這些原本存在瀏覽器的 localStorage，導致兩台裝置看到不同的批次，
// 而且「已扣庫存」的紀錄各存各的，同一批有機會被扣兩次。
// 改為伺服器單一來源，全廚房看到同一份。
app.get('/api/today/state', (req, res) => {
  const date = req.query.date || today();
  const row = db.prepare('SELECT state, updated_at, updated_by FROM day_state WHERE date=?').get(date);
  res.json({
    date,
    state:      row ? JSON.parse(row.state || '{}') : null,
    updated_at: row ? row.updated_at : null,
    updated_by: row ? row.updated_by : null
  });
});

app.put('/api/today/state', (req, res) => {
  const date  = req.body.date || today();
  const state = req.body.state || {};
  db.prepare(
    `INSERT INTO day_state (date,state,updated_at,updated_by)
     VALUES (?,?,datetime('now','localtime'),?)
     ON CONFLICT(date) DO UPDATE SET state=excluded.state,
            updated_at=excluded.updated_at, updated_by=excluded.updated_by`
  ).run(date, JSON.stringify(state), req.kitchenUser.name);
  const row = db.prepare('SELECT updated_at FROM day_state WHERE date=?').get(date);
  res.json({ ok: true, updated_at: row.updated_at, updated_by: req.kitchenUser.name });
});

// 新增個案出單（日期可自訂，預設今日）
app.post('/api/today/cases', (req, res) => {
  const { prescription_id, cups, meal_time, powder_type, patient_name, notes, date } = req.body;
  const orderDate = date || today();
  const r = db.prepare(
    `INSERT INTO case_orders (date,prescription_id,cups,meal_time,powder_type,patient_name,notes) VALUES (?,?,?,?,?,?,?)`
  ).run(orderDate, prescription_id, cups||1, meal_time||'1330', powder_type||'袋裝', patient_name||'', notes||'');
  res.json({ id: r.lastInsertRowid });
});

// 更新個案出單（含日期）
app.put('/api/today/cases/:id', (req, res) => {
  // prescription_id 原本沒有被更新：畫面上改了處方、存檔顯示成功，資料卻沒動。
  // 個案因此永遠留在原本的處方，也就進不了員工批次。
  const { prescription_id, cups, meal_time, powder_type, patient_name, notes, date } = req.body;
  const cur = db.prepare('SELECT prescription_id FROM case_orders WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '找不到這筆出單' });

  // 廚房人員改過就標成 manual，之後預約同步不再覆蓋這一筆
  db.prepare(
    `UPDATE case_orders SET date=?,prescription_id=?,cups=?,meal_time=?,powder_type=?,patient_name=?,notes=?,
            sync_source='manual'
     WHERE id=?`
  ).run(
    date || today(),
    Number(prescription_id) || cur.prescription_id,
    cups, meal_time, powder_type||'袋裝', patient_name||'', notes||'', req.params.id
  );
  res.json({ ok: true });
});

// 刪除今日個案出單
app.delete('/api/today/cases/:id', (req, res) => {
  // 預約帶入的出單被刪掉時記下來，避免下次同步又長回來
  const row = db.prepare('SELECT source_key FROM case_orders WHERE id=?').get(req.params.id);
  if (row && row.source_key) {
    db.prepare('INSERT OR IGNORE INTO appt_sync_dismissed (source_key) VALUES (?)').run(row.source_key);
  }
  db.prepare('DELETE FROM case_orders WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════
// API: 處方管理
// ════════════════════════════════════════════════════════

app.get('/api/prescriptions', (req, res) => {
  // 停用的處方預設不列。帶 include_inactive=1 可以連停用的一起看
  // （停用是軟刪除，處方代號還在，不查出來就不知道為什麼代號會重複）
  const all = req.query.include_inactive === '1';
  const rxs = db.prepare(
    `SELECT p.*, pr.name as product_name, pr.unit as product_unit
     FROM prescriptions p
     LEFT JOIN products pr ON pr.id=p.product_id
     ${all ? '' : 'WHERE p.active=1'}
     ORDER BY pr.sort_order, p.product_id, p.is_staff_rx DESC, p.code`
  ).all();
  res.json(rxs);
});

app.post('/api/prescriptions', (req, res) => {
  const { product_id, code, name, formula_type, contraindications, timing, is_staff_rx } = req.body;
  if (!code || !name) return res.status(400).json({ error: '處方代號和名稱必填' });
  try {
    const r = db.prepare(
      `INSERT INTO prescriptions (product_id,code,name,formula_type,contraindications,timing,is_staff_rx)
       VALUES (?,?,?,?,?,?,?)`
    ).run(product_id||1, code, name, formula_type||'粉配方', contraindications||'', timing||'餐前', is_staff_rx?1:0);
    res.json({ id: r.lastInsertRowid });
  } catch(e) {
    res.status(400).json({ error: '處方代號已存在' });
  }
});

app.put('/api/prescriptions/:id', (req, res) => {
  const { product_id, name, formula_type, contraindications, timing, is_staff_rx, active,
          daily_cups, buffer_cups, weekly_cups, avoid_proteins } = req.body;
  const beforeSnap = rxSnapshot(req.params.id);
  const cur = db.prepare('SELECT daily_cups, buffer_cups, weekly_cups FROM prescriptions WHERE id=?').get(req.params.id) || {};
  const curAvoid = db.prepare("SELECT COALESCE(avoid_proteins,'') a FROM prescriptions WHERE id=?")
                     .get(req.params.id) || { a: '' };
  db.prepare(
    `UPDATE prescriptions SET product_id=?,name=?,formula_type=?,contraindications=?,timing=?,
            is_staff_rx=?,active=?,daily_cups=?,buffer_cups=?,weekly_cups=?,avoid_proteins=? WHERE id=?`
  ).run(product_id||1, name, formula_type, contraindications||'', timing, is_staff_rx?1:0,
        active===undefined?1:active,
        daily_cups  === undefined ? (cur.daily_cups  || 0) : (Number(daily_cups)  || 0),
        buffer_cups === undefined ? (cur.buffer_cups || 0) : (Number(buffer_cups) || 0),
        weekly_cups === undefined ? (cur.weekly_cups || 0) : (Number(weekly_cups) || 0),
        avoid_proteins === undefined ? curAvoid.a : String(avoid_proteins || ''),
        req.params.id);
  recordRxChange(req.params.id, beforeSnap, '基本資料', req);
  res.json({ ok: true });
});

app.delete('/api/prescriptions/:id', (req, res) => {
  db.prepare('UPDATE prescriptions SET active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// 取得處方食材
// 某個輪替組在某一天該用哪一張處方。畫面和測試都問這裡，不各自算一次
// 某一天用哪個蔬果方案，以及那個方案的內容。畫面與測試都問這裡
// 有哪些方案可以選，以及每一天目前算出來是哪個
app.get('/api/rotation/plans', (req, res) => {
  const group = req.query.group || '主方案';
  const plans = db.prepare(
    'SELECT id, code, name, rotation_index FROM produce_plans WHERE group_code=? AND active=1 ORDER BY rotation_index'
  ).all(group);
  const overrides = db.prepare(
    `SELECT o.*, p.name plan_name, p.code plan_code FROM produce_plan_overrides o
       JOIN produce_plans p ON p.id=o.plan_id
      WHERE o.group_code=? AND o.date_to >= ? ORDER BY o.date_from`
  ).all(group, today());
  const cur = activePlanFor(group, today());
  res.json({ group, plans, overrides, current: cur,
             is_override: !!(cur && cur.is_override) });
});

// 手動指定一段期間用哪個方案。預設從今天到下一次自然換組的前一天 ——
// 這是最常見的情況：「這一期改用另一個」
app.post('/api/rotation/plan/override', (req, res) => {
  const group = req.body.group || '主方案';
  const planId = Number(req.body.plan_id);
  const plan = db.prepare('SELECT id, name FROM produce_plans WHERE id=? AND active=1').get(planId);
  if (!plan) return res.status(400).json({ error: '找不到這個方案' });

  const from = req.body.date_from || today();
  let to = req.body.date_to;
  if (!to) {
    // 找出下一次自動會換組的日子，覆寫到那之前
    const base = activePlanFor(group, from);
    to = from;
    for (let i = 1; i <= 60; i++) {
      const d = new Date(Date.parse(from + 'T00:00:00Z') + i * 86400000).toISOString().slice(0, 10);
      const auto = rotationPick(db.prepare(
        'SELECT id, code, name, rotation_index FROM produce_plans WHERE group_code=? AND active=1 ORDER BY rotation_index'
      ).all(group), d);
      if (auto && base && auto.code !== base.code) break;
      to = d;
    }
  }
  const r = db.prepare(
    `INSERT INTO produce_plan_overrides (group_code,plan_id,date_from,date_to,note,created_by)
     VALUES (?,?,?,?,?,?)`
  ).run(group, planId, from, to, req.body.note || '', req.kitchenUser ? req.kitchenUser.name : '');

  // 覆寫只換這一期，輪替時鐘不動。指定的如果剛好跟下一期自然輪到的一樣，
  // 就會連續兩期同一個方案 —— 讓系統自己講，不要等人吃了四週才發現
  const nextDay = new Date(Date.parse(to + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  const nextAuto = rotationPick(db.prepare(
    'SELECT id, code, name, rotation_index FROM produce_plans WHERE group_code=? AND active=1 ORDER BY rotation_index'
  ).all(group), nextDay);
  const warning = (nextAuto && nextAuto.id === planId)
    ? `下一期（${nextDay} 起）自然也輪到${plan.name}，這樣會連續兩期都是它`
    : '';

  res.json({ id: r.lastInsertRowid, group, plan: plan.name,
             date_from: from, date_to: to, next_from: nextDay,
             next_plan: nextAuto ? nextAuto.name : null, warning });
});

// 取消覆寫，回到自動
app.delete('/api/rotation/plan/override/:id', (req, res) => {
  db.prepare('DELETE FROM produce_plan_overrides WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/rotation/plan', (req, res) => {
  const date = req.query.date || today();
  const group = req.query.group || '主方案';
  const plan = activePlanFor(group, date);
  if (!plan) return res.json({ date, group, plan: null, items: [] });
  const items = db.prepare(
    `SELECT i.name, i.category, ppi.qty_per_cup, COALESCE(ppi.prep,'') prep,
            COALESCE(ppi.prep_stage,'') prep_stage
       FROM produce_plan_items ppi JOIN ingredients i ON i.id=ppi.ingredient_id
      WHERE ppi.plan_id=? ORDER BY i.category, i.name`
  ).all(plan.id);
  res.json({ date, group,
             plan: { code: plan.code, name: plan.name, rotation_index: plan.rotation_index },
             is_override: !!plan.is_override, override_note: plan.note || '',
             weeks: Number(rotationSetting('rotation_weeks','2')),
             anchor: rotationSetting('rotation_anchor','2026-08-31'),
             items });
});

app.get('/api/rotation/active', (req, res) => {
  const group = req.query.group || 'EMP';
  const date  = req.query.date  || today();
  const rx = activeRxInGroup(group, date);
  if (!rx) return res.json({ group, date, code: null, id: null });
  const full = db.prepare('SELECT id, code, name FROM prescriptions WHERE id=?').get(rx.id);
  res.json({ group, date, ...full,
             weeks: Number(rotationSetting('rotation_weeks', '2')),
             anchor: rotationSetting('rotation_anchor', '2026-08-31') });
});

// 從既有處方複製一張新的。很多個案的內用配方跟員工／AW 幾乎一樣，
// 只差益生菌那幾樣 —— 從頭建一張要填二十幾行，複製再微調快得多。
//
// 刻意不做成「共用的基礎配方」：那樣改一次全體生效，但多一層、
// 看一個人的配方要合三層。等到真的有五個以上共用同一套機能配料再說。
// 代價要講清楚：複製出來的是獨立的一份，之後改來源不會跟著變。
app.post('/api/prescriptions/:id/duplicate', (req, res) => {
  const src = db.prepare('SELECT * FROM prescriptions WHERE id=?').get(req.params.id);
  if (!src) return res.status(404).json({ error: '找不到來源處方' });

  const { code, name, patient_name } = req.body;
  if (!code || !String(code).trim()) return res.status(400).json({ error: '要給新處方一個代號' });
  const taken = db.prepare('SELECT code, name, active FROM prescriptions WHERE code=?')
                  .get(String(code).trim());
  if (taken) {
    // 停用的處方仍然佔著代號：歷史出單指向它，不能拿去給別人用，
    // 否則過去的成本與紀錄會接到錯的人身上
    return res.status(400).json({
      error: taken.active
        ? `代號 ${taken.code} 已經是「${taken.name}」在用`
        : `代號 ${taken.code} 被已停用的「${taken.name}」佔著（歷史出單還指向它），請換一個`
    });
  }

  let newId;
  tx(() => {
    const r = db.prepare(
      `INSERT INTO prescriptions
         (product_id, code, name, formula_type, contraindications, timing,
          is_staff_rx, active, daily_cups, buffer_cups, weekly_cups, produce_plan_group)
       VALUES (?,?,?,?,?,?, 0, 1, 0, 0, 0, ?)`
    ).run(src.product_id || 1, String(code).trim(),
          (name || patient_name || (src.name + ' 複本')).trim(),
          src.formula_type, src.contraindications || '', src.timing || '餐前',
          // 蔬果方案跟著複製 —— 這正是「跟員工一樣」的那一半
          src.produce_plan_group || '');
    newId = r.lastInsertRowid;

    // 只複製這張處方自己的用料。蔬果來自方案，不會也不該被複製成獨立的一份
    db.prepare(
      `INSERT INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup, prep, prep_stage)
       SELECT ?, ingredient_id, qty_per_cup, COALESCE(prep,''), COALESCE(prep_stage,'')
         FROM prescription_ingredients WHERE prescription_id=?`
    ).run(newId, src.id);
  });

  const created = db.prepare('SELECT * FROM prescriptions WHERE id=?').get(newId);
  const n = db.prepare('SELECT COUNT(*) c FROM prescription_ingredients WHERE prescription_id=?').get(newId).c;
  res.json({ ...created, copied_items: n, from_code: src.code });
});

// 某張處方的異動紀錄。before/after 全文也一起回，需要時看得到當時的完整配方
app.get('/api/prescriptions/:id/history', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
  const rows = db.prepare(
    `SELECT h.*, u.name AS by_name FROM prescription_history h
       LEFT JOIN users u ON u.id = h.user_id
      WHERE h.prescription_id = ? ORDER BY h.id DESC LIMIT ?`
  ).all(req.params.id, limit);
  const total = db.prepare('SELECT COUNT(*) c FROM prescription_history WHERE prescription_id=?')
                  .get(req.params.id).c;
  res.json({ total, rows: rows.map(r => ({
    id: r.id, changed_at: r.changed_at, change_type: r.change_type,
    summary: r.summary, by: r.by_name || r.user_name || '—',
    before: safeParse(r.before_json), after: safeParse(r.after_json)
  })) });
});

function safeParse(t) { try { return JSON.parse(t || 'null'); } catch (e) { return null; } }

app.get('/api/prescriptions/:id/ingredients', (req, res) => {
  const all = db.prepare(
    `SELECT i.id, i.name, i.unit, i.category, i.sort_order,
            COALESCE(i.supply_note,'') supply_note,
            COALESCE(inv.qty, 0) stock,
            (SELECT COUNT(*) FROM purchase_log pl WHERE pl.ingredient_id = i.id) purchase_n
       FROM ingredients i LEFT JOIN inventory inv ON inv.ingredient_id = i.id
      WHERE i.active=1 ORDER BY i.sort_order, i.category, i.name`
  ).all();
  const used = db.prepare(
    `SELECT pi.ingredient_id, pi.qty_per_cup, COALESCE(pi.prep,'') prep,
            COALESCE(pi.prep_stage,'') prep_stage
     FROM prescription_ingredients pi WHERE pi.prescription_id=?`
  ).all(req.params.id);
  const usedMap = {};
  used.forEach(u => { usedMap[u.ingredient_id] = u; });
  res.json(all.map(i => ({
    ...i,
    qty_per_cup: usedMap[i.id] ? usedMap[i.id].qty_per_cup : 0,
    prep:        usedMap[i.id] ? usedMap[i.id].prep : '',
    prep_stage:  usedMap[i.id] ? usedMap[i.id].prep_stage : ''
  })));
});

// 更新處方食材（完整覆蓋）
app.put('/api/prescriptions/:id/ingredients', (req, res) => {
  const items = req.body; // [{ingredient_id, qty_per_cup, prep, prep_stage}]
  // 先照一張改動前的相片。這裡是具名個案的醫療配方，
  // 「誰在什麼時候把份量從幾克改成幾克」必須查得到
  const beforeSnap = rxSnapshot(req.params.id);
  tx(() => {
    // 這裡是先刪再插，送進來沒帶 prep_stage 的話冷凍包標記會整批消失。
    // 先把現有的記下來，沒帶就沿用原值
    const prev = {};
    db.prepare("SELECT ingredient_id, COALESCE(prep_stage,'') ps FROM prescription_ingredients WHERE prescription_id=?")
      .all(req.params.id).forEach(r => { prev[r.ingredient_id] = r.ps; });
    db.prepare('DELETE FROM prescription_ingredients WHERE prescription_id=?').run(req.params.id);
    const ins = db.prepare(
      'INSERT INTO prescription_ingredients (prescription_id,ingredient_id,qty_per_cup,prep,prep_stage) VALUES (?,?,?,?,?)'
    );
    items.forEach(item => {
      if (item.qty_per_cup > 0) {
        const stage = item.prep_stage !== undefined ? item.prep_stage : (prev[item.ingredient_id] || '');
        ins.run(req.params.id, item.ingredient_id, item.qty_per_cup, (item.prep || '').trim(), stage);
      }
    });
  });
  recordRxChange(req.params.id, beforeSnap, '用料', req);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════
// API: 食材管理
// ════════════════════════════════════════════════════════

app.get('/api/ingredients', (req, res) => {
  // 停用的食材照樣查得到（?include_inactive=1）。沒有這條路的話，
  // 停用過的名字就再也找不回來 —— 重新啟用只能改資料庫，
  // 而新建同名的會被唯一索引擋掉，等於那個名字永久消失
  const all = req.query.include_inactive === '1';
  res.json(db.prepare(
    'SELECT * FROM ingredients' + (all ? '' : ' WHERE active=1') +
    ' ORDER BY sort_order, category, name').all());
});

app.post('/api/ingredients', (req, res) => {
  const { name, unit, category, safety_stock, storage_note, shelf_life_days } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: '請輸入食材名稱' });
  try {
    const r = db.prepare(
      `INSERT INTO ingredients (name,unit,category,safety_stock,storage_note,shelf_life_days) VALUES (?,?,?,?,?,?)`
    ).run(name.trim(), unit||'g', category||'其他', safety_stock||0, storage_note||'', shelf_life_days||0);
    db.prepare('INSERT OR IGNORE INTO inventory (ingredient_id, qty) VALUES (?,0)').run(r.lastInsertRowid);
    res.json({ id: r.lastInsertRowid });
  } catch(e) {
    res.status(400).json({ error: '食材名稱已存在' });
  }
});

app.put('/api/ingredients/:id', (req, res) => {
  const { name, unit, category, safety_stock, storage_note, shelf_life_days,
          active, track_stock } = req.body;
  // 盤點單位與換算比例。原本這兩欄只能靠寫死的遷移設定（只有蘋果與檸檬有），
  // 要多一樣就得改程式 —— 而採購與盤點的單位換算全靠它們。
  // 28 樣食材裡只有 2 樣設得起來，難怪「2.2 公斤」那種輸入沒有防線
  const cur = db.prepare('SELECT active, COALESCE(track_stock,1) track_stock FROM ingredients WHERE id=?')
                .get(req.params.id);
  if (!cur) return res.status(404).json({ error: '找不到這個食材' });

  const curConv = db.prepare(
    "SELECT COALESCE(count_unit,'') count_unit, COALESCE(count_ratio,1) count_ratio FROM ingredients WHERE id=?"
  ).get(req.params.id) || { count_unit: '', count_ratio: 1 };
  const nextCountUnit = req.body.count_unit === undefined
    ? curConv.count_unit : String(req.body.count_unit || '').trim();
  const rawRatio = Number(req.body.count_ratio);
  const nextCountRatio = req.body.count_ratio === undefined
    ? curConv.count_ratio
    : (Number.isFinite(rawRatio) && rawRatio > 0 ? rawRatio : 1);
  // 有換算單位就一定要有比例，否則換算會靜默失效 ——
  // 採購填「12 顆」會變成 12 公克，而且沒有人會看到錯在哪
  if (nextCountUnit && !(nextCountRatio > 1))
    return res.status(400).json({
      error: `填了盤點單位「${nextCountUnit}」就要填換算比例（1 ${nextCountUnit} = ? ${
        req.body.unit || ''}），否則採購與盤點會照基本單位算` });
  db.prepare('UPDATE ingredients SET count_unit=?, count_ratio=? WHERE id=?')
    .run(nextCountUnit, nextCountUnit ? nextCountRatio : 1, req.params.id);
  if (req.body.supply_note !== undefined)
    db.prepare('UPDATE ingredients SET supply_note=? WHERE id=?')
      .run(String(req.body.supply_note || '').trim(), req.params.id);

  // 停用是軟停用：歷史採購、消耗紀錄與舊處方都還指向它，不能真的刪掉。
  // 原本只能新增不能停用，換掉的食材（甜椒、蘿蔓生菜）只好寫一次性遷移處理
  const nextActive = active === undefined ? cur.active : (active ? 1 : 0);
  if (!nextActive && cur.active) {
    const used = db.prepare(
      `SELECT p.code FROM prescription_ingredients pi
         JOIN prescriptions p ON p.id = pi.prescription_id
        WHERE pi.ingredient_id=? AND pi.qty_per_cup>0 AND p.active=1 LIMIT 3`
    ).all(req.params.id).map(r => r.code);
    const inPlan = db.prepare(
      `SELECT pp.name FROM produce_plan_items ppi
         JOIN produce_plans pp ON pp.id = ppi.plan_id
        WHERE ppi.ingredient_id=? AND ppi.qty_per_cup>0 AND pp.active=1 LIMIT 3`
    ).all(req.params.id).map(r => r.name);
    // 還在用的東西被停用，備料表會少一樣而且不會有人發現
    if (used.length || inPlan.length) {
      return res.status(400).json({
        error: '還有在用，不能停用：' + [...used, ...inPlan].join('、')
      });
    }
  }

  db.prepare(
    `UPDATE ingredients SET name=?,unit=?,category=?,safety_stock=?,storage_note=?,
            shelf_life_days=?,active=?,track_stock=? WHERE id=?`
  ).run(name, unit, category, safety_stock||0, storage_note||'', shelf_life_days||0,
        nextActive,
        track_stock === undefined ? cur.track_stock : (track_stock ? 1 : 0),
        req.params.id);
  res.json({ ok: true, active: nextActive });
});

app.patch('/api/ingredients/:id', (req, res) => {
  const fields = req.body;
  const allowed = ['shelf_life_days', 'safety_stock', 'storage_note'];
  const sets = Object.keys(fields).filter(k => allowed.includes(k)).map(k => `${k}=?`);
  if (sets.length === 0) return res.status(400).json({ error: 'no valid fields' });
  db.prepare(`UPDATE ingredients SET ${sets.join(',')} WHERE id=?`)
    .run(...Object.keys(fields).filter(k => allowed.includes(k)).map(k => fields[k]), req.params.id);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════
// API: 庫存
// ════════════════════════════════════════════════════════

app.get('/api/inventory', (req, res) => {
  const rows = db.prepare(
    `SELECT i.*, COALESCE(inv.qty,0) as qty, inv.updated_at
     FROM ingredients i LEFT JOIN inventory inv ON inv.ingredient_id=i.id
     WHERE i.active=1 ORDER BY i.sort_order, i.category, i.name`
  ).all();
  res.json(rows);
});

app.put('/api/inventory/:id', (req, res) => {
  const { qty } = req.body;
  db.prepare(
    `INSERT INTO inventory (ingredient_id,qty,updated_at) VALUES (?,?,datetime('now','localtime'))
     ON CONFLICT(ingredient_id) DO UPDATE SET qty=excluded.qty, updated_at=excluded.updated_at`
  ).run(req.params.id, qty);
  res.json({ ok: true });
});

// 記錄採購（更新庫存 + 採購記錄）
// ── 採購的單位換算 ────────────────────────────────────────
// 庫存一律存基本單位（g / ml / 粒 / 包）。但買的時候講的是別的單位：
// 蘋果買 2.2 公斤、檸檬買 12 顆。輸入框原本只有一個沒有單位的數字，
// 打「2.2」就會存成 2.2 公克 —— 庫存加 2.2 克，單價變成 149 元/克。
// 而平均成本是「總金額 ÷ 總數量」，一筆填錯會污染那樣食材 90 天的均價。
function toBaseQty(ing, qty, inputUnit) {
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ratio = Number(ing.count_ratio) || 1;
  switch (String(inputUnit || 'base')) {
    case 'count':                                  // 顆、包、盒
      return ing.count_unit ? n * ratio : null;
    case 'kg': return ing.unit === 'g'  ? n * 1000 : null;
    case 'l':  return ing.unit === 'ml' ? n * 1000 : null;
    default:   return n;                           // 已經是基本單位
  }
}

// 同一張發票被登記兩次。
//
// 單價把關抓不到這件事 —— 重複那一筆的單價完全正確。
// 傷害在兩個地方：庫存被加兩次（帳面多出不存在的貨），
// 而那個價格點拿到雙倍權重，均價會往它靠。
//
// 不擋死，只要確認：同規格同價買兩包是真的會發生的事
// （2026-08-27 那天蘋果就在同一張單裡出現兩行，數量不同）。
function duplicateCheck(ingredientId, purchasedAt, baseQty, totalPrice) {
  const row = db.prepare(
    `SELECT id, qty, total_price FROM purchase_log
      WHERE ingredient_id=? AND purchased_at=?
        AND ABS(qty - ?) < 0.01 AND ABS(total_price - ?) < 0.01
      LIMIT 1`
  ).get(ingredientId, purchasedAt, baseQty, totalPrice);
  return row || null;
}

// 這一筆的單價跟過去差幾倍。差一兩倍是行情，差一百倍是單位填錯 ——
// 後者會把均價永久拉歪，而且看起來只是「有點貴」，不像壞掉
function oddPriceCheck(ingredientId, baseQty, totalPrice) {
  const from = costLookbackFrom(getSettings());
  const rows = from
    ? db.prepare('SELECT qty, total_price FROM purchase_log WHERE ingredient_id=? AND purchased_at>=?')
        .all(ingredientId, from)
    : db.prepare('SELECT qty, total_price FROM purchase_log WHERE ingredient_id=?').all(ingredientId);
  const tq = rows.reduce((a, r) => a + Number(r.qty || 0), 0);
  const tp = rows.reduce((a, r) => a + Number(r.total_price || 0), 0);
  if (rows.length < 1 || tq <= 0 || !(baseQty > 0)) return null;
  const avg = tp / tq;
  const now = Number(totalPrice) / baseQty;
  if (!(avg > 0) || !(now > 0)) return null;
  const factor = now > avg ? now / avg : avg / now;
  if (factor < 5) return null;
  return { avg: Math.round(avg * 1000) / 1000, now: Math.round(now * 1000) / 1000,
           factor: Math.round(factor * 10) / 10 };
}

app.post('/api/inventory/purchase', (req, res) => {
  const { ingredient_id, total_price, purchased_at, user_id, item_type, purpose, note } = req.body;
  const ing = db.prepare(
    `SELECT id, name, unit, COALESCE(count_unit,'') count_unit, COALESCE(count_ratio,1) count_ratio
       FROM ingredients WHERE id=?`).get(ingredient_id);
  if (!ing) return res.status(400).json({ error: '找不到這樣食材' });

  const qty = toBaseQty(ing, req.body.qty, req.body.input_unit);
  if (qty == null)
    return res.status(400).json({
      error: `「${req.body.input_unit}」換不成 ${ing.name} 的單位（${ing.unit}）` });

  // 同一張發票登記兩次。庫存會被加兩次，均價也會往那個價格靠
  const when = purchased_at || today();
  const dup = duplicateCheck(ing.id, when, qty, total_price);
  if (dup && !req.body.confirm_duplicate)
    return res.status(409).json({
      error: `${when} 已經有一筆一模一樣的 ${ing.name}（${qty} ${ing.unit}、${total_price} 元）。`
           + '同規格買兩包的話按確認就好；如果是同一張發票登記兩次，庫存會多算一份。',
      duplicate_of: dup.id, needs_confirm: true });

  // 單價離譜就先擋下來。擋錯了按一下確認就過，擋不住的話均價會歪 90 天
  const odd = oddPriceCheck(ing.id, qty, total_price);
  if (odd && !req.body.confirm_odd_price)
    return res.status(409).json({
      error: `這一筆算出 ${odd.now} 元/${ing.unit}，過去平均是 ${odd.avg} 元/${ing.unit}`
           + `，差 ${odd.factor} 倍。單位填錯了嗎？（${ing.name} 的庫存單位是 ${ing.unit}`
           + (ing.count_unit ? `，1 ${ing.count_unit} = ${ing.count_ratio} ${ing.unit}` : '') + '）',
      odd, needs_confirm: true });

  tx(() => {
    db.prepare(
      `INSERT INTO purchase_log (ingredient_id,qty,total_price,purchased_at,user_id,item_type,purpose,note)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(ingredient_id, qty, total_price, purchased_at || today(), user_id||null,
          item_type||'食材', purpose||'精力湯', String(note || '').trim());
    db.prepare(
      `INSERT INTO inventory (ingredient_id,qty,updated_at) VALUES (?,?,datetime('now','localtime'))
       ON CONFLICT(ingredient_id) DO UPDATE SET qty=qty+excluded.qty, updated_at=excluded.updated_at`
    ).run(ingredient_id, qty);
  });
  res.json({ ok: true, base_qty: qty, unit: ing.unit,
             unit_price: Math.round(Number(total_price) / qty * 1000) / 1000 });
});

// ── 採購籃 ──────────────────────────────────────────────
// 市場勾一樣 → 進這裡；回診所開進貨 → 從這裡帶出來，只要補金額。
// 原本進貨是一次一樣，買 13 樣要開 13 次視窗 ——
// 帳面長期是 0 不是因為懶，是因為登記的成本太高
app.get('/api/purchase/draft', (req, res) => {
  const date = req.query.date || today();
  const rows = db.prepare(
    `SELECT d.id, d.ingredient_id, d.qty, d.note, d.updated_at,
            i.name, i.unit, i.category,
            COALESCE(i.count_unit,'') count_unit, COALESCE(i.count_ratio,1) count_ratio
       FROM purchase_draft d JOIN ingredients i ON i.id = d.ingredient_id
      WHERE d.date = ? ORDER BY i.category, i.name`
  ).all(date);
  res.json({ date, count: rows.length, rows });
});

// 勾起來（帶建議量）或取消勾選
app.put('/api/purchase/draft', (req, res) => {
  const date = req.body.date || today();
  const id   = Number(req.body.ingredient_id);
  if (!id) return res.status(400).json({ error: '缺少食材' });
  if (req.body.remove) {
    db.prepare('DELETE FROM purchase_draft WHERE date=? AND ingredient_id=?').run(date, id);
    return res.json({ ok: true, removed: true });
  }
  db.prepare(
    `INSERT INTO purchase_draft (date,ingredient_id,qty,note,user_id)
     VALUES (?,?,?,?,?)
     ON CONFLICT(date,ingredient_id) DO UPDATE SET
       qty=excluded.qty, note=excluded.note,
       updated_at=datetime('now','localtime')`
  ).run(date, id, Number(req.body.qty) || 0, req.body.note || '',
        req.kitchenUser ? req.kitchenUser.id : null);
  res.json({ ok: true });
});

// 把待買清單整批倒進籃子。用在「已經買回來了、但沒走採購頁勾選」的情況 ——
// 否則要一樣一樣開視窗登記，十幾樣就是十幾次，於是沒有人會做
app.post('/api/purchase/draft/fill', (req, res) => {
  const date = req.body.date || today();
  const f = buildForecast(28);
  const src = f.ingredients.filter(i => i.buy > 0).map(i => ({ id: i.id, qty: i.buy }));
  if (!src.length) return res.json({ ok: true, added: 0, kept: 0 });

  let added = 0, kept = 0;
  const ins = db.prepare(
    `INSERT INTO purchase_draft (date,ingredient_id,qty,note,user_id)
     VALUES (?,?,?,?,?) ON CONFLICT(date,ingredient_id) DO NOTHING`
  );
  tx(() => {
    src.forEach(x => {
      // 已經在籃子裡的不覆蓋 —— 那可能是採購的人在市場改過的實際量
      const r = ins.run(date, x.id, x.qty, '', req.kitchenUser ? req.kitchenUser.id : null);
      if (r.changes) added++; else kept++;
    });
  });
  res.json({ ok: true, added, kept });
});

// 整批登記。金額沒填的那幾行留在籃子裡，不要默默丟掉 ——
// 有時候就是先登記一部分，剩下的等發票
app.post('/api/purchase/commit', (req, res) => {
  const date = req.body.date || today();
  const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
  if (!lines.length) return res.status(400).json({ error: '沒有要登記的項目' });

  // 先整批檢查，再整批寫入。一筆單價離譜就整批不寫 ——
  // 寫一半再報錯的話，人會不知道哪幾樣進去了、哪幾樣沒有，
  // 然後重按一次，同一批就進了兩次
  const odds = [], dups = [];
  const converted = [];
  for (const l of lines) {
    const id = Number(l.ingredient_id);
    const price = Number(l.total_price);
    if (!id || l.total_price === '' || l.total_price === null || !(price >= 0)) continue;
    const ing = db.prepare(
      `SELECT id, name, unit, COALESCE(count_unit,'') count_unit, COALESCE(count_ratio,1) count_ratio
         FROM ingredients WHERE id=?`).get(id);
    if (!ing) continue;
    const q = toBaseQty(ing, l.qty, l.input_unit);
    if (q == null) continue;
    converted.push({ id, qty: q, price, line: l });
    const odd = oddPriceCheck(id, q, price);
    if (odd) odds.push({ name: ing.name, unit: ing.unit, ...odd });
    const dup = duplicateCheck(id, date, q, price);
    if (dup) dups.push({ name: ing.name, unit: ing.unit, qty: q, price, of: dup.id });
  }
  if (dups.length && !req.body.confirm_duplicate)
    return res.status(409).json({
      error: date + ' 已經有一模一樣的紀錄：'
           + dups.map(d => `${d.name} ${d.qty} ${d.unit} / ${d.price} 元`).join('、')
           + '。同規格買兩包的話按確認就好；如果是同一張發票登記兩次，庫存會多算一份。',
      dups, needs_confirm: true });
  if (odds.length && !req.body.confirm_odd_price)
    return res.status(409).json({
      error: '有 ' + odds.length + ' 樣的單價跟過去差太多，先確認單位有沒有填錯：'
           + odds.map(o => `${o.name} ${o.now} 元/${o.unit}（過去 ${o.avg}，差 ${o.factor} 倍）`).join('、'),
      odds, needs_confirm: true });

  const byId = {};
  converted.forEach(c => { byId[c.id] = c.qty; });

  let saved = 0, skipped = 0;
  tx(() => {
    lines.forEach(l => {
      const id = Number(l.ingredient_id);
      const qty = byId[id] != null ? byId[id] : Number(l.qty);
      const price = Number(l.total_price);
      // 量或金額沒填就先留著，下次再登記
      if (!id || !(qty > 0) || !(price >= 0) || l.total_price === '' || l.total_price === null) {
        skipped++; return;
      }
      db.prepare(
        `INSERT INTO purchase_log (ingredient_id,qty,total_price,purchased_at,user_id,item_type,purpose,note)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(id, qty, price, date, req.kitchenUser ? req.kitchenUser.id : null,
            l.item_type || '食材', l.purpose || '精力湯', String(l.note || '').trim());
      db.prepare(
        `INSERT INTO inventory (ingredient_id,qty,updated_at) VALUES (?,?,datetime('now','localtime'))
         ON CONFLICT(ingredient_id) DO UPDATE SET qty=qty+excluded.qty, updated_at=excluded.updated_at`
      ).run(id, qty);
      db.prepare('DELETE FROM purchase_draft WHERE date=? AND ingredient_id=?').run(date, id);
      saved++;
    });
  });
  res.json({ ok: true, saved, skipped });
});

// 登記錯食材時改過去。買的是小黃瓜卻登記在大黃瓜上 ——
// 沒有這條路的話，錯的那筆會一直留著，而且庫存兩邊都不對
app.post('/api/purchase/:id/move', (req, res) => {
  const row = db.prepare('SELECT * FROM purchase_log WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '找不到這筆進貨' });
  const to = Number(req.body.ingredient_id);
  const dst = db.prepare('SELECT id,name FROM ingredients WHERE id=?').get(to);
  if (!dst) return res.status(400).json({ error: '找不到要改成的食材' });
  if (dst.id === row.ingredient_id) return res.status(400).json({ error: '本來就是這一樣' });

  const src = db.prepare('SELECT name FROM ingredients WHERE id=?').get(row.ingredient_id);
  tx(() => {
    // 原本那樣扣回去、新的那樣加上來
    db.prepare('UPDATE inventory SET qty=qty-?, updated_at=datetime(\'now\',\'localtime\') WHERE ingredient_id=?')
      .run(row.qty, row.ingredient_id);
    db.prepare(
      `INSERT INTO inventory (ingredient_id,qty,updated_at) VALUES (?,?,datetime('now','localtime'))
       ON CONFLICT(ingredient_id) DO UPDATE SET qty=qty+excluded.qty, updated_at=excluded.updated_at`
    ).run(to, row.qty);
    db.prepare('UPDATE purchase_log SET ingredient_id=? WHERE id=?').run(to, row.id);
  });
  res.json({ ok: true, from: src ? src.name : '', to: dst.name, qty: row.qty });
});

// 整筆登記錯（重複登記、根本沒買）時刪掉，庫存跟著扣回去
app.delete('/api/purchase/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM purchase_log WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '找不到這筆進貨' });
  const ing = db.prepare('SELECT name FROM ingredients WHERE id=?').get(row.ingredient_id);
  tx(() => {
    db.prepare('UPDATE inventory SET qty=qty-?, updated_at=datetime(\'now\',\'localtime\') WHERE ingredient_id=?')
      .run(row.qty, row.ingredient_id);
    db.prepare('DELETE FROM purchase_log WHERE id=?').run(row.id);
  });
  res.json({ ok: true, name: ing ? ing.name : '', qty: row.qty });
});

// 某一天的杯數是怎麼來的、每一樣料是誰要的。
// 「為什麼還是跳缺貨」這種問題原本只能翻程式碼猜 —— 這條路直接把帳攤開
app.get('/api/day/cups', (req, res) => {
  const date = req.query.date || today();
  const rows = cupsOnDate(date).map(c => {
    const rx = db.prepare('SELECT code, name, active FROM prescriptions WHERE id=?').get(c.rxId) || {};
    return { rx_id: c.rxId, code: rx.code || '?', name: rx.name || '', active: rx.active,
             cups: c.cups, powder_mult: c.powderMult, why: c.why };
  });
  // 那一天實際有哪幾張個案出單。要修某一筆時得知道它的編號，
  // 而系統原本沒有「列出某天出單」的路 —— 只有今天那一頁看得到
  const orders = db.prepare(
    `SELECT co.id, co.prescription_id, co.cups, co.powder_type, co.meal_time,
            co.patient_name, COALESCE(co.source_key,'') source_key,
            p.code rx_code, p.name rx_name, p.active rx_active
       FROM case_orders co LEFT JOIN prescriptions p ON p.id=co.prescription_id
      WHERE co.date=? ORDER BY co.meal_time, co.id`
  ).all(date);

  const out = { date, dow: dowOf(date),
                total_cups: rows.reduce((t, r) => t + r.cups, 0), rows, orders };

  // 指定食材時，列出這一天是誰要用它
  const want = String(req.query.ingredient || '').trim();
  if (want) {
    const ing = db.prepare('SELECT id,name,unit FROM ingredients WHERE name=? OR id=?').get(want, Number(want) || -1);
    if (ing) {
      out.ingredient = { id: ing.id, name: ing.name, unit: ing.unit, from: [] };
      cupsOnDate(date).forEach(c => {
        const it = servedItems(c.rxId, date, c.powderType)
          .find(x => x.ingredient_id === ing.id);
        if (!it || !(it.qty_per_cup > 0)) return;
        const rx = db.prepare('SELECT code, active FROM prescriptions WHERE id=?').get(c.rxId) || {};
        // 粉類在罐裝與全配方要 ×1.1。扣庫存那邊有算，這裡原本沒算 ——
        // 而這個明細正是用來查「為什麼缺這麼多」的地方，兩邊差 10% 就查不出來
        const mult = FRESH_CATS.has(it.category) ? 1.0 : (c.powderMult || 1.0);
        out.ingredient.from.push({
          code: rx.code, active: rx.active, cups: c.cups,
          per_cup: it.qty_per_cup,
          powder_mult: mult,
          total: Math.round(it.qty_per_cup * c.cups * mult * 10) / 10
        });
      });
    }
  }
  res.json(out);
});

// 食材採購歷史
app.get('/api/inventory/:id/purchases', (req, res) => {
  const rows = db.prepare(
    `SELECT pl.*, u.name as user_name
     FROM purchase_log pl LEFT JOIN users u ON u.id=pl.user_id
     WHERE pl.ingredient_id=? ORDER BY pl.purchased_at DESC, pl.id DESC`
  ).all(req.params.id);
  res.json(rows);
});

// 出餐扣庫存
// 依處方扣庫存，並留下一筆消耗紀錄。sign = -1 扣、+1 還原
function applyConsumption(rxId, cups, powderType, sign, date) {
  const pm = (powderType === '罐裝' || powderType === '全配方') ? 1.1 : 1.0;
  const freshCats = new Set(['蔬菜', '水果', '油水', '油', '水', '其他']);
  // 基底粉只扣粉類。原本這裡扣的是整張處方 ——
  // 客人只拿粉，蔬果卻照扣，帳面因此一直短少
  servedItems(rxId, date, powderType).forEach(r => {
    const mult   = freshCats.has(r.category) ? 1.0 : pm;
    const amount = Math.round(r.qty_per_cup * cups * mult * 100) / 100 * sign;
    db.prepare(
      `UPDATE inventory SET qty=MAX(0, ROUND(qty+?,1)), updated_at=datetime('now','localtime')
       WHERE ingredient_id=?`
    ).run(amount, r.ingredient_id);
  });
}

function recordConsumption({ date, rxId, cups, powderType, source, note, userId, prepDate }) {
  // 扣料用的配方要照「出餐那天」算 —— 蔬果方案是會換的，
  // 用備料當天的方案去扣，換組那一週就會扣錯食材
  applyConsumption(rxId, cups, powderType, -1, date);
  const r = db.prepare(
    `INSERT INTO consumption_log (date,prescription_id,cups,powder_type,source,note,user_id,prep_date)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(date, rxId, cups, powderType || '', source || 'manual', note || '', userId || null,
        prepDate || '');
  return r.lastInsertRowid;
}

app.post('/api/inventory/consume', (req, res) => {
  const { prescription_id, cups, powder_type, date } = req.body;
  if (!prescription_id || !cups || cups <= 0) return res.status(400).json({ error: 'invalid' });
  let logId;
  tx(() => {
    logId = recordConsumption({
      date: date || today(), rxId: prescription_id, cups,
      powderType: powder_type, source: 'manual', userId: req.kitchenUser.id
    });
  });
  res.json({ ok: true, id: logId });
});

// ── 月曆 ──────────────────────────────────────────────────
// 一次看完一個月：哪幾天出幾杯、預約帶進來幾筆、哪天缺料、哪天休診。
//
// 現在要回答「這個月忙不忙、料夠不夠」只能一天一天點過去。
// 排產、缺料、預約、訂閱四件事各自在不同畫面上，湊不出一張全月的圖。
//
// 過去的日子看「實際扣了幾杯」，今天以後看「排定幾杯」——
// 這兩個數字意思不一樣，混成一個欄位會讓人以為昨天少做了
app.get('/api/calendar', (req, res) => {
  const m = String(req.query.month || '').match(/^(\d{4})-(\d{2})$/);
  const now = today();
  const year  = m ? Number(m[1]) : Number(now.slice(0, 4));
  const month = m ? Number(m[2]) : Number(now.slice(5, 7));
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

  // 缺料是拿「現在的庫存」去推的，所以只有今天以後算得出來。
  // 過去的日子拿今天的庫存去算缺料，只會得到一堆假的紅字
  const horizonDays = Math.max(7, Math.min(60,
    Math.round((Date.parse(last + 'T00:00:00Z') - Date.parse(now + 'T00:00:00Z')) / 86400000) + 1));
  let fc = { days: [] };
  if (last >= now) { try { fc = buildForecast(horizonDays); } catch (e) {} }
  const fcByDate = {};
  (fc.days || []).forEach(d => { fcByDate[d.date] = d; });

  const closures = {};
  closuresBetween(first, last).forEach(c => { closures[c.date] = c.reason || ''; });

  // 預約帶進來的出單有 source_key，手動建的沒有 —— 分開數才看得出
  // 「今天的量」是預約來的還是現場加的
  const orders = {};
  db.prepare(
    `SELECT co.date, co.cups, COALESCE(co.source_key,'') source_key
       FROM case_orders co WHERE co.date>=? AND co.date<=?`
  ).all(first, last).forEach(r => {
    const o = orders[r.date] || (orders[r.date] = { from_appt: 0, manual: 0, cups: 0 });
    o.cups += r.cups;
    if (r.source_key) o.from_appt += r.cups; else o.manual += r.cups;
  });

  const served = {};
  db.prepare(
    `SELECT date, SUM(cups) c FROM consumption_log
      WHERE date>=? AND date<=? AND COALESCE(reversed_at,'')=''
      GROUP BY date`
  ).all(first, last).forEach(r => { served[r.date] = r.c; });

  const prepped = {};
  db.prepare(
    `SELECT date, SUM(cups) c FROM consumption_log
      WHERE date>=? AND date<=? AND COALESCE(reversed_at,'')=''
        AND COALESCE(prep_date,'')<>'' GROUP BY date`
  ).all(first, last).forEach(r => { prepped[r.date] = r.c; });

  const subDows = parseDows(rotationSetting('subscription_dows', '1,3,5'), [1, 3, 5]);
  const stDows  = stocktakeDows();

  const days = [];
  for (let i = 0; i < daysInMonth; i++) {
    const date = addDays(first, i);
    const dow  = dowOf(date);
    const closed = Object.prototype.hasOwnProperty.call(closures, date);
    const plan = activePlanFor('主方案', date);
    const planned = closed ? 0 : cupsOnDate(date).reduce((a, b) => a + b.cups, 0);
    const f = fcByDate[date];
    const subCups = closed ? 0
      : subscriptionCupsOnDate(date).reduce((a, b) => a + b.cups, 0);

    days.push({
      date, dow,
      is_past: date < now,
      is_today: date === now,
      is_closed: closed,
      closure_reason: closed ? closures[date] : '',
      plan_name: plan ? plan.name : null,
      is_staff_meal_day: !closed && isStaffMealDay(dow),
      is_subscription_day: !closed && subDows.includes(dow),
      is_stocktake_day: stDows.includes(dow),
      planned_cups: Math.round(planned * 10) / 10,
      served_cups: Math.round((served[date] || 0) * 10) / 10,
      prepped_cups: Math.round((prepped[date] || 0) * 10) / 10,
      subscription_cups: subCups,
      appt_cups:   orders[date] ? orders[date].from_appt : 0,
      manual_cups: orders[date] ? orders[date].manual : 0,
      // 缺料只在今天以後有意義
      short_count: f ? f.short.length : null,
      pack_short:  f ? f.pack_short_servings : null,
      short: f ? f.short.slice(0, 6) : []
    });
  }

  const sum = k => days.reduce((a, d) => a + (Number(d[k]) || 0), 0);
  res.json({
    month: `${year}-${String(month).padStart(2, '0')}`,
    first, last, today: now,
    prev_month: addDays(first, -1).slice(0, 7),
    next_month: addDays(last, 1).slice(0, 7),
    totals: {
      planned_cups: Math.round(sum('planned_cups') * 10) / 10,
      served_cups:  Math.round(sum('served_cups') * 10) / 10,
      appt_cups:    sum('appt_cups'),
      manual_cups:  sum('manual_cups'),
      subscription_cups: sum('subscription_cups'),
      closed_days:  days.filter(d => d.is_closed).length,
      short_days:   days.filter(d => d.short_count > 0).length
    },
    days
  });
});

// ── 提前備料 ──────────────────────────────────────────────
// 現場的做法是週一為週二的員工餐做大量備料。料週一就離開冰箱，
// 但系統原本只在出餐日扣 —— 所以週一晚上帳面上還有那些料，
// 實際上已經在盒子裡。缺料因此少報、採購因此晚一天。
//
// 這裡刻意不新開一張表，而是把它記成 consumption_log 的一列：
//   date      = 覆蓋哪一天的出餐
//   prep_date = 料實際離開冰箱的日子
// 這樣隔日自動補扣（settleDay 比對 date）就自動知道那一天已經扣過了，
// 不會再補一次 —— 不必在 expectedForDate 裡多一條「要扣掉已備料」的規則。
// 少一條規則，就少一個 2026-09-03 那種兩邊算不一樣的機會。

// 某一天已經提前備了多少杯，依處方分組
function preppedFor(date) {
  return db.prepare(
    `SELECT cl.prescription_id, p.code rx_code, p.name rx_name,
            SUM(cl.cups) cups, MIN(cl.prep_date) prep_date, cl.powder_type
       FROM consumption_log cl JOIN prescriptions p ON p.id = cl.prescription_id
      WHERE cl.date=? AND COALESCE(cl.reversed_at,'')='' AND COALESCE(cl.prep_date,'')<>''
      GROUP BY cl.prescription_id, cl.powder_type ORDER BY p.code`
  ).all(date);
}

// 那一天還沒備的杯數。備料表要照這個開，不是照記憶
app.get('/api/prep-ahead', (req, res) => {
  const serve = req.query.serve_date || addDays(today(), 1);
  const want = {};
  expectedForDate(serve).forEach(r => {
    if (!want[r.rxId]) want[r.rxId] = { rxId: r.rxId, cups: 0, powderType: r.powderType || '' };
    want[r.rxId].cups += r.cups;
  });
  const done = {};
  db.prepare(
    `SELECT prescription_id, SUM(cups) c FROM consumption_log
      WHERE date=? AND COALESCE(reversed_at,'')='' GROUP BY prescription_id`
  ).all(serve).forEach(r => { done[r.prescription_id] = r.c; });

  const rxName = db.prepare('SELECT id, code, name FROM prescriptions');
  const names = {};
  rxName.all().forEach(r => { names[r.id] = r; });

  res.json({
    serve_date: serve,
    is_closed: isClosed(serve),
    prepped: preppedFor(serve),
    lines: Object.values(want).map(w => ({
      prescription_id: w.rxId,
      rx_code: names[w.rxId] ? names[w.rxId].code : '',
      rx_name: names[w.rxId] ? names[w.rxId].name : '',
      powder_type: w.powderType,
      need_cups: Math.round(w.cups * 10) / 10,
      already_cups: Math.round((done[w.rxId] || 0) * 10) / 10,
      left_cups: Math.round(Math.max(0, w.cups - (done[w.rxId] || 0)) * 10) / 10
    }))
  });
});

// 登記提前備料。扣在按下去的當下，記成出餐日的消耗
app.post('/api/prep-ahead', (req, res) => {
  const serve = String(req.body.serve_date || '').trim();
  const prepDate = String(req.body.prep_date || today()).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serve) || !/^\d{4}-\d{2}-\d{2}$/.test(prepDate))
    return res.status(400).json({ error: '日期格式要是 YYYY-MM-DD' });
  if (serve < prepDate)
    return res.status(400).json({ error: '出餐日不能早於備料日' });
  if (isClosed(serve))
    return res.status(400).json({ error: serve + ' 是休診日，那天不出餐' });

  const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
  if (!lines.length) return res.status(400).json({ error: '沒有要登記的項目' });

  // 先整批檢查。備多於那天要出的杯數就擋 —— 扣多了要一筆一筆還原，
  // 而且中間那段時間缺料會虛報
  const want = {};
  expectedForDate(serve).forEach(r => { want[r.rxId] = (want[r.rxId] || 0) + r.cups; });
  const done = {};
  db.prepare(
    `SELECT prescription_id, SUM(cups) c FROM consumption_log
      WHERE date=? AND COALESCE(reversed_at,'')='' GROUP BY prescription_id`
  ).all(serve).forEach(r => { done[r.prescription_id] = r.c; });

  const over = [];
  lines.forEach(l => {
    const id = Number(l.prescription_id), cups = Number(l.cups);
    if (!id || !(cups > 0)) return;
    const room = (want[id] || 0) - (done[id] || 0);
    if (cups > room + 0.01) {
      const p = db.prepare('SELECT code FROM prescriptions WHERE id=?').get(id);
      over.push(`${p ? p.code : id} 那天只要 ${Math.round((want[id] || 0) * 10) / 10} 杯，`
        + `已經扣過 ${Math.round((done[id] || 0) * 10) / 10} 杯，最多還能備 ${Math.round(room * 10) / 10} 杯`);
    }
  });
  if (over.length && !req.body.confirm_over)
    return res.status(409).json({ error: over.join('；'), needs_confirm: true });

  const saved = [];
  tx(() => {
    lines.forEach(l => {
      const id = Number(l.prescription_id), cups = Number(l.cups);
      if (!id || !(cups > 0)) return;
      const logId = recordConsumption({
        date: serve, rxId: id, cups,
        powderType: l.powder_type || '',
        source: 'prep', prepDate,
        note: `${prepDate} 提前備料（供 ${serve} 出餐）`,
        userId: req.kitchenUser.id
      });
      saved.push({ id: logId, prescription_id: id, cups });
    });
  });
  res.json({ ok: true, serve_date: serve, prep_date: prepDate, saved });
});

// ── 隔日自動補扣 ──────────────────────────────────────────
// 過了那一天之後，比對「那天應該扣的」與「實際扣掉的」，只補差額。
// 補扣一律標 source='auto' 並且可以整筆還原 —— 自動但看得見、改得回來。
//
// 提前備料（source='prep'）記的 date 就是出餐日，所以這裡看得到它，
// 差額自然是 0，不會補第二次。這是刻意讓兩件事共用同一個比對，
// 而不是在別處多寫一條「要扣掉已備料」的規則

// 例外管理：排程上的東西預設就是做了、送出去了，只有被明確標記的才是沒發生。
// 例外和批次狀態存在同一份 day_state（整個廚房共用），這裡讀那一份，不另外算一次。
function dayExceptions(date) {
  const empty = { staffMissed: new Set(), caseMissed: new Set(),
                  staffPicked: new Set(), casePicked: new Set(), anyTap: false };
  try {
    const row = db.prepare('SELECT state FROM day_state WHERE date=?').get(date);
    if (!row) return empty;
    const s = JSON.parse(row.state || '{}');
    const staffPicked = new Set(s.staff || []);
    const casePicked  = new Set(s.cases || []);
    return {
      staffMissed: new Set(s.staffMissed || []),
      caseMissed:  new Set(s.caseMissed  || []),
      staffPicked, casePicked,
      // 那一天到底有沒有人在點。完全沒有人點過的日子（包含改成
      // 「點了才算領」之前的所有歷史）一律走舊規則，否則整天會變成 0 杯
      anyTap: staffPicked.size > 0 || casePicked.size > 0
    };
  } catch (e) { return empty; }
}

function expectedForDate(date) {
  const out = [];   // { rxId, cups, powderType }
  // 休診日什麼都沒做，所以什麼都不扣。
  //
  // 這一行比排產那邊更要緊。下面「沒有人點過就照出勤與出單補扣」的退路，
  // 在休診日一定成立 —— 廚房沒開，當然沒有人點 —— 所以少了這道判斷，
  // 每一個國定假日都會照出勤扣掉一整天的料，而且完全不會報錯。
  if (isClosed(date)) return out;
  const ex = dayExceptions(date);
  // 出席的人裡面扣掉被標「未領」的。逐一比對 id，不用數量相減 ——
  // 被標未領的人有可能同時也沒出席，相減會扣到兩次
  const attendingIds = db.prepare(
    'SELECT user_id FROM staff_attendance WHERE date=? AND attending=1'
  ).all(date).map(r => r.user_id);
  // 預設沒拿、點了才代表領走。沒有人點過的那一天（歷史資料、或是當天
  // 根本沒人動過畫面）退回舊規則：照出勤扣，扣多了看得出來，
  // 扣不到才是真的查不出來
  const staffCups = ex.anyTap
    ? attendingIds.filter(id => ex.staffPicked.has(id)).length
    : attendingIds.filter(id => !ex.staffMissed.has(id)).length;
  const staffRx = staffRxFor(date);
  // 非供餐日不出員工餐 —— 排產那邊本來就有這道判斷，扣庫存這邊漏了。
  // 出勤表在非供餐日照樣有紀錄（那是上班，不是吃飯），
  // 少了這一行就會扣掉根本沒做的那幾杯
  if (staffRx && staffCups > 0 && isStaffMealDay(dowOf(date)))
    out.push({ rxId: staffRx.id, cups: staffCups, powderType: '' });

  // 每日固定供應的處方（AW 就是這種）。排產那邊一直有算，扣庫存這邊漏了 ——
  // 結果是那杯照做、照喝，庫存卻從來沒有扣過。目前被「每天另外建一張單」
  // 蓋過去所以看不出來，哪天沒建單就直接漏掉一整杯的料
  const orders = db.prepare(
    'SELECT id, prescription_id, cups, powder_type FROM case_orders WHERE date=?'
  ).all(date);
  const ordered = new Set(orders.map(o => o.prescription_id));

  // 每日固定供應的處方（AW 就是這種）。當天沒有另外開單時才用這個預設值 ——
  // 有開單就以單為準：單可能是 3 杯而不是預設的 1 杯，也可能被標成沒出餐。
  // 排產那邊用同一條規則，兩邊要一致
  const dow = dowOf(date);
  if (dow >= 1 && dow <= 5) {
    db.prepare(
      `SELECT id, COALESCE(daily_cups,0) daily_cups FROM prescriptions
        WHERE active=1 AND COALESCE(daily_cups,0) > 0`
    ).all().forEach(r => {
      if (ordered.has(r.id)) return;
      out.push({ rxId: r.id, cups: r.daily_cups, powderType: '' });
    });
  }

  orders.forEach(o => {
    if (ex.anyTap ? !ex.casePicked.has(o.id) : ex.caseMissed.has(o.id)) return;
    out.push({ rxId: o.prescription_id, cups: o.cups, powderType: o.powder_type || '' });
  });

  // 訂閱：照排定的杯數扣，不看誰喝掉。
  //
  // 這裡刻意跟員工餐不一樣。員工餐是「點了才算領走」，因為沒人領就不會做。
  // 訂閱是預先收過錢的，那杯每個取餐日都會做出來 —— 原訂的人不拿就給別人喝，
  // 不退費。所以料一定用掉了，扣庫存跟「誰喝的」無關。
  // subscription_pickups 記的是誰喝的與沒人喝（浪費），不是要不要扣料。
  //
  // 寫成「只扣有人喝的」會有一個沒人發現的漏洞：那天沒有人去標，
  // 整天的訂閱杯就從庫存帳上消失，但料早就下鍋了 —— 跟 2026-09-03
  // 那批漏掉的 4 杯是同一種病。
  subscriptionCupsOnDate(date).forEach(x =>
    out.push({ rxId: x.rxId, cups: x.cups, powderType: '' }));
  return out;
}

function settleDay(date, userId) {
  const key = r => r.rxId + '|' + ((r.powderType === '罐裝' || r.powderType === '全配方') ? 'x11' : 'x1');

  const want = {};
  expectedForDate(date).forEach(r => {
    const k = key(r);
    if (!want[k]) want[k] = { rxId: r.rxId, powderType: r.powderType, cups: 0 };
    want[k].cups += r.cups;
  });
  if (!Object.keys(want).length) return null;

  const got = {};
  db.prepare(
    "SELECT prescription_id, powder_type, SUM(cups) c FROM consumption_log " +
    "WHERE date=? AND COALESCE(reversed_at,'')='' GROUP BY prescription_id, powder_type"
  ).all(date).forEach(r => {
    const k = key({ rxId: r.prescription_id, powderType: r.powder_type });
    got[k] = (got[k] || 0) + r.c;
  });

  const added = [];
  Object.entries(want).forEach(([k, w]) => {
    const missing = Math.round((w.cups - (got[k] || 0)) * 100) / 100;
    if (missing <= 0) return;
    recordConsumption({
      date, rxId: w.rxId, cups: missing, powderType: w.powderType,
      source: 'auto', note: '隔日自動補扣（當天沒有人確認出餐）', userId
    });
    added.push({ prescription_id: w.rxId, cups: missing, powder_type: w.powderType });
  });
  return added.length ? added : null;
}

const SETTLE_LOOKBACK_DAYS = 7;

function settleRecentDays(userId) {
  const results = [];
  for (let i = 1; i <= SETTLE_LOOKBACK_DAYS; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    try {
      const added = settleDay(d, userId);
      if (added) results.push({ date: d, items: added,
                                cups: Math.round(added.reduce((s, a) => s + a.cups, 0) * 10) / 10 });
    } catch (e) { console.error('自動補扣失敗', d, e.message); }
  }
  return results;
}

// 某一天實際扣了哪些。手動補扣之前一定要先看這個 ——
// 看不到已經扣過什麼就補扣，等於把同一批料扣兩次
app.get('/api/consumption', (req, res) => {
  const date = req.query.date || today();
  const rows = db.prepare(
    `SELECT cl.*, p.code rx_code, p.name rx_name, u.name user_name
       FROM consumption_log cl
       LEFT JOIN prescriptions p ON p.id = cl.prescription_id
       LEFT JOIN users u ON u.id = cl.user_id
      WHERE cl.date = ? ORDER BY cl.id`
  ).all(date);
  const live = rows.filter(r => !r.reversed_at);
  const byRx = {};
  live.forEach(r => {
    const k = r.rx_code || r.prescription_id;
    if (!byRx[k]) byRx[k] = { rx_code: r.rx_code, rx_name: r.rx_name, cups: 0 };
    byRx[k].cups += r.cups;
  });
  res.json({
    date,
    total_cups: Math.round(live.reduce((s, r) => s + r.cups, 0) * 10) / 10,
    by_rx: Object.values(byRx),
    rows: rows.map(r => ({
      id: r.id, rx_code: r.rx_code, rx_name: r.rx_name, cups: r.cups,
      powder_type: r.powder_type || '', source: r.source, note: r.note || '',
      by: r.user_name || '—', at: r.created_at,
      reversed: !!r.reversed_at
    }))
  });
});

// 今天「應該扣多少」——把例外扣掉之後的結果。
// 這條規則決定隔天自動補扣的數量，攤開來才查得到為什麼是這個數字
app.get('/api/consumption/expected', (req, res) => {
  const date = req.query.date || today();
  const ex = dayExceptions(date);
  const items = expectedForDate(date).map(r => {
    const p = db.prepare('SELECT code, name FROM prescriptions WHERE id=?').get(r.rxId) || {};
    return { rx_id: r.rxId, rx_code: p.code || '', rx_name: p.name || '',
             cups: r.cups, powder_type: r.powderType };
  });
  res.json({
    date, items,
    total_cups: Math.round(items.reduce((s, i) => s + i.cups, 0) * 10) / 10,
    rule: ex.anyTap ? '點了才算領' : '沒有人點過，照出勤與出單補扣',
    picked: { staff: [...ex.staffPicked], cases: [...ex.casePicked] },
    exceptions: { staff_missed: [...ex.staffMissed], case_missed: [...ex.caseMissed] }
  });
});

// 最近的自動補扣紀錄（讓人看得到、能還原）
// pending=1 只回還沒被確認過的，今日頁的提示用這個 —— 確認過就不該再佔版面
app.get('/api/consumption/auto', (req, res) => {
  const days = Number(req.query.days || 14);
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const onlyPending = req.query.pending === '1';
  res.json(db.prepare(
    `SELECT cl.*, p.name rx_name, p.code rx_code
     FROM consumption_log cl LEFT JOIN prescriptions p ON p.id=cl.prescription_id
     WHERE cl.source='auto' AND cl.date >= ? AND COALESCE(cl.reversed_at,'')=''
       ${onlyPending ? "AND COALESCE(cl.acked_at,'')=''" : ''}
     ORDER BY cl.date DESC, cl.id DESC`
  ).all(from));
});

// 「知道了」：標記已確認，通知就不再出現。庫存不動，只是不用再看
app.post('/api/consumption/ack', (req, res) => {
  const dates = Array.isArray(req.body.dates) ? req.body.dates : null;
  const r = dates && dates.length
    ? db.prepare(
        `UPDATE consumption_log SET acked_at=datetime('now','localtime')
         WHERE source='auto' AND COALESCE(acked_at,'')='' AND date IN (${dates.map(() => '?').join(',')})`
      ).run(...dates)
    : db.prepare(
        `UPDATE consumption_log SET acked_at=datetime('now','localtime')
         WHERE source='auto' AND COALESCE(acked_at,'')=''`
      ).run();
  res.json({ ok: true, acked: r.changes });
});

// 還原一筆自動補扣：把食材加回去，並標記已還原
app.post('/api/consumption/:id/reverse', (req, res) => {
  const row = db.prepare("SELECT * FROM consumption_log WHERE id=? AND COALESCE(reversed_at,'')=''").get(req.params.id);
  if (!row) return res.status(404).json({ error: '找不到這筆，或已經還原過' });
  tx(() => {
    // 還原一定要用當初那一筆的日期 —— 用今天的話會加回另一個方案的蔬果
    applyConsumption(row.prescription_id, row.cups, row.powder_type, +1, row.date);
    db.prepare("UPDATE consumption_log SET reversed_at=datetime('now','localtime') WHERE id=?").run(row.id);
  });
  res.json({ ok: true });
});

// 庫存充足性檢查：依星期幾遞減的本週剩餘需求 + 安全緩衝 7 杯
// ── 蔬果方案的編修 ──────────────────────────────────────────
// 方案改一次全體生效（員工、AW、所有引用它的個案），
// 影響比改單一處方更大 —— 所以一樣要留下「誰、什麼時候、從幾克改成幾克」
function planSnapshot(planId) {
  const p = db.prepare('SELECT code, name, group_code, rotation_index, active FROM produce_plans WHERE id=?')
              .get(planId) || {};
  const items = db.prepare(
    `SELECT i.name, ppi.qty_per_cup, COALESCE(ppi.prep,'') prep, COALESCE(ppi.prep_stage,'') prep_stage
       FROM produce_plan_items ppi JOIN ingredients i ON i.id=ppi.ingredient_id
      WHERE ppi.plan_id=? AND ppi.qty_per_cup>0 ORDER BY i.name`
  ).all(planId);
  return { ...p, items };
}

function recordPlanChange(planId, before, req) {
  try {
    const after = planSnapshot(planId);
    const summary = diffSummary(before, after);   // 與處方共用同一套差異描述
    if (!summary) return;
    db.prepare(
      `INSERT INTO produce_plan_history (plan_id, summary, before_json, after_json, user_id, user_name)
       VALUES (?,?,?,?,?,?)`
    ).run(planId, summary, JSON.stringify(before), JSON.stringify(after),
          req && req.kitchenUser ? req.kitchenUser.id : null,
          req && req.kitchenUser ? req.kitchenUser.name : '');
  } catch (e) { console.error('方案留痕失敗', e.message); }
}

app.get('/api/produce-plans', (req, res) => {
  const group = req.query.group || '主方案';
  const plans = db.prepare(
    'SELECT * FROM produce_plans WHERE group_code=? AND active=1 ORDER BY rotation_index'
  ).all(group);
  res.json(plans.map(p => ({
    ...p,
    items: db.prepare(
      `SELECT ppi.ingredient_id, ppi.qty_per_cup, COALESCE(ppi.prep,'') prep,
              COALESCE(ppi.prep_stage,'') prep_stage, i.name, i.unit, i.category
         FROM produce_plan_items ppi JOIN ingredients i ON i.id=ppi.ingredient_id
        WHERE ppi.plan_id=? ORDER BY i.category, i.name`
    ).all(p.id)
  })));
});

// 整批取代這個方案的蔬果。只收蔬菜與水果 ——
// 機能配料屬於個人，混進方案會讓所有人一起被改到
app.put('/api/produce-plans/:id/items', (req, res) => {
  const plan = db.prepare('SELECT id FROM produce_plans WHERE id=?').get(req.params.id);
  if (!plan) return res.status(404).json({ error: '找不到這個方案' });
  const items = Array.isArray(req.body) ? req.body : (req.body.items || []);

  const bad = [];
  items.forEach(it => {
    const ing = db.prepare('SELECT name, category FROM ingredients WHERE id=?').get(it.ingredient_id);
    if (!ing) bad.push('#' + it.ingredient_id);
    else if (!['蔬菜', '水果'].includes(ing.category)) bad.push(ing.name + '（' + ing.category + '）');
  });
  if (bad.length) return res.status(400).json({ error: '方案只放蔬菜與水果：' + bad.join('、') });

  const before = planSnapshot(plan.id);
  tx(() => {
    db.prepare('DELETE FROM produce_plan_items WHERE plan_id=?').run(plan.id);
    const ins = db.prepare(
      `INSERT INTO produce_plan_items (plan_id,ingredient_id,qty_per_cup,prep,prep_stage)
       VALUES (?,?,?,?,?)`);
    items.forEach(it => {
      if (Number(it.qty_per_cup) > 0)
        ins.run(plan.id, it.ingredient_id, Number(it.qty_per_cup),
                (it.prep || '').trim(), (it.prep_stage || '').trim());
    });
  });
  recordPlanChange(plan.id, before, req);
  const after = planSnapshot(plan.id);
  res.json({ ok: true, items: after.items.length,
             veg: after.items.length,
             summary: diffSummary(before, after) });
});

app.get('/api/produce-plans/:id/history', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
  const rows = db.prepare(
    `SELECT h.*, u.name AS by_name FROM produce_plan_history h
       LEFT JOIN users u ON u.id = h.user_id
      WHERE h.plan_id=? ORDER BY h.id DESC LIMIT ?`
  ).all(req.params.id, limit);
  // total 要是真的筆數，不是這一頁的筆數 ——
  // 寫成 rows.length 的話，滿 50 筆之後畫面就永遠停在「50 筆」，
  // 再改幾次都看不出來有沒有留下紀錄
  const total = db.prepare('SELECT COUNT(*) c FROM produce_plan_history WHERE plan_id=?')
                  .get(req.params.id).c;
  res.json({ total, rows: rows.map(r => ({
    id: r.id, changed_at: r.changed_at, summary: r.summary,
    by: r.by_name || r.user_name || '—'
  })) });
});

// ── 備料批次 ────────────────────────────────────────────────
// 冷凍核心包：備料當下把原料變成 N 份備品，之後出餐消耗備品、不再碰原料。
// 備料可能一週做一次、也可能週一做一批週四再補一批 ——
// 所以不綁週期，做幾份是備料當下填的，涵蓋到哪天由份數自己決定

// 哪些處方吃這一組蔬果方案（備品是給他們用的）
function planRxIds(group) {
  return db.prepare(
    "SELECT id FROM prescriptions WHERE active=1 AND COALESCE(produce_plan_group,'')=?"
  ).all(group).map(r => r.id);
}

// 目前還剩幾份備品。做了幾份 − 從第一批之後已經出了幾杯
// 從某一天「開始」還有幾份備品可用 —— 那一天自己的用量還沒扣。
// packStatus 的 remaining 是「到 asOf 為止（含當天）用完之後」的數字，
// 逐日預測再從它扣一次當天用量，等於同一天扣兩次：
// 2026-09-03 做了 24 份、當天要用 14 份，狀態頁說剩 10 份，
// 預測卻說備品 0、還要再備 5 樣 —— 叫人去做已經做好的東西
function packAvailableFrom(group, fromDate) {
  const batches = db.prepare(
    `SELECT date, servings FROM prep_batches
      WHERE group_code=? AND COALESCE(reversed_at,'')='' AND date<=?
      ORDER BY date, id`
  ).all(group, fromDate);
  if (!batches.length) return 0;
  const rxIds = new Set(planRxIds(group));
  const since = batches[0].date;
  let usedBefore = 0;
  for (let d = since; d < fromDate; d = addDays(d, 1)) {
    usedBefore += cupsOnDate(d).filter(x => rxIds.has(x.rxId)).reduce((t, x) => t + x.cups, 0);
  }
  const made = batches.reduce((t, b) => t + b.servings, 0);
  return Math.max(0, Math.round((made - usedBefore) * 10) / 10);
}

function packStatus(group, asOf) {
  const upto = asOf || today();
  const batches = db.prepare(
    `SELECT * FROM prep_batches
      WHERE group_code=? AND COALESCE(reversed_at,'')='' AND date<=?
      ORDER BY date, id`
  ).all(group, upto);
  if (!batches.length)
    return { made: 0, used: 0, remaining: 0, served_without_pack: 0, since: null, batches: [] };

  const rxIds = new Set(planRxIds(group));
  const since = batches[0].date;
  let used = 0;
  for (let d = since; d <= upto; d = addDays(d, 1)) {
    used += cupsOnDate(d).filter(x => rxIds.has(x.rxId)).reduce((sum, x) => sum + x.cups, 0);
  }
  const made = batches.reduce((sum, b) => sum + b.servings, 0);
  // used 算的是「自第一批以來出過幾杯方案」，不是「用掉幾份備品」——
  // 所以它可以大於 made（做了 24 份、期間出了 44 杯，差的 20 杯是當天現做的）。
  // remaining 夾在 0 以上，但夾掉之後就看不出差多少，
  // 所以把差額明講出來，不要讓人以為帳壞了
  const unpacked = Math.max(0, Math.round((used - made) * 10) / 10);
  return { made, used: Math.round(used * 10) / 10,
           remaining: Math.max(0, Math.round((made - used) * 10) / 10),
           // 這幾杯沒有備品可用，是當天現做的
           served_without_pack: unpacked,
           since, batches };
}

// 這一批要秤多少：冷凍包的每一樣 × 份數
function prepWorksheet(group, servings, date) {
  const plan = activePlanFor(group, date || today());
  if (!plan) return { plan: null, items: [], servings };
  const rows = db.prepare(
    `SELECT i.id, i.name, i.unit, ppi.qty_per_cup, COALESCE(ppi.prep,'') prep
       FROM produce_plan_items ppi JOIN ingredients i ON i.id=ppi.ingredient_id
      WHERE ppi.plan_id=? AND COALESCE(ppi.prep_stage,'')='冷凍包' AND ppi.qty_per_cup>0
      ORDER BY i.category, i.name`
  ).all(plan.id);
  const stock = {};
  db.prepare('SELECT ingredient_id, qty FROM inventory').all()
    .forEach(r => { stock[r.ingredient_id] = r.qty; });
  return {
    plan: { code: plan.code, name: plan.name }, servings,
    items: rows.map(r => {
      const need = Math.round(r.qty_per_cup * servings * 10) / 10;
      const have = Math.round((stock[r.id] || 0) * 10) / 10;
      return { id: r.id, name: r.name, unit: r.unit, prep: r.prep,
               per_serving: r.qty_per_cup, need, have,
               short: Math.max(0, Math.round((need - have) * 10) / 10) };
    })
  };
}

// ── 逐日庫存預測 ────────────────────────────────────────────
// 原本的試算是「今天的配方 × 這週剩幾天」，打成一坨。那有兩個問題：
//   1. 兩週後會換蔬果方案，換組要用到的東西現在完全不會被算到，
//      也不會有任何警告 —— 換組當天早上才發現就來不及叫貨
//   2. 備料的人問的不是「夠不夠」，是「撐到哪一天」
// 所以改成逐日展開：每一天各自問「那天用哪個方案、那天有誰要喝」。

function stocktakeDows() {
  return String(rotationSetting('stocktake_dows', '1,2,4'))
    .split(',').map(x => Number(x.trim())).filter(x => x >= 0 && x <= 6);
}

const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const dowOf   = d => new Date(d + 'T00:00:00').getDay();

// ── 休診日 ────────────────────────────────────────────────
// 只在這裡定義一次。杯數、預估、盤點日、訂閱扣杯全部讀這個 ——
// 各自寫一份判斷的話，改一邊就會不一致（員工供應日踩過這個坑）
function isClosed(date) {
  return !!db.prepare('SELECT 1 FROM kitchen_closures WHERE date=?').get(date);
}
// 一段期間內的休診日。訂閱算杯數時一次撈完，不要一天問一次
function closuresBetween(from, to) {
  return db.prepare(
    'SELECT date, reason FROM kitchen_closures WHERE date>=? AND date<=? ORDER BY date'
  ).all(from, to);
}

// 下一個盤點日（不含今天）。盤點的人不是每天上班，備料區間要照他的班表算。
// 休診日跳過 —— 廚房沒開的那天沒有人可以盤點，把備料區間算到那一天
// 會讓「撐到下一個盤點日」少算一整天的料
function nextStocktakeDay(from) {
  const dows = stocktakeDows();
  if (!dows.length) return addDays(from, 7);
  for (let i = 1; i <= 14; i++) {
    const d = addDays(from, i);
    if (dows.includes(dowOf(d)) && !isClosed(d)) return d;
  }
  return addDays(from, 7);
}

// ── 同事訂閱 ──────────────────────────────────────────────
// 輪的邊界沿用蔬果方案的輪替基準（預設 2026-08-31 週一、兩週一輪），
// 所以一個訂閱輪剛好等於一個方案期 —— 不另立一套日期，
// 兩套日期遲早會差一天，而差一天就是差一整杯的錢
function cycleStartFor(date) {
  const anchor = rotationSetting('rotation_anchor', '2026-08-31');
  const weeks  = Number(rotationSetting('rotation_weeks', '2')) || 2;
  const span   = weeks * 7;
  const diff   = Math.floor(
    (Date.parse(date + 'T00:00:00Z') - Date.parse(anchor + 'T00:00:00Z')) / 86400000);
  return addDays(anchor, Math.floor(diff / span) * span);
}

function parseDows(raw, dflt) {
  const list = String(raw == null ? '' : raw).split(',')
    .map(x => Number(String(x).trim()))
    .filter(x => Number.isInteger(x) && x >= 0 && x <= 6);
  return list.length ? list : dflt;
}

// 這一輪實際有幾個取餐日。休診日先扣掉 —— 假日不做，也不該收那一杯的錢
function cycleDates(cycleStart, weeks, dows) {
  const out = [];
  const span = (Number(weeks) || 2) * 7;
  for (let i = 0; i < span; i++) {
    const d = addDays(cycleStart, i);
    if (dows.includes(dowOf(d)) && !isClosed(d)) out.push(d);
  }
  return out;
}

// 某一天有哪些訂閱杯。排產與扣庫存都讀這一支 ——
// 2026-09-03 那次帳歪掉就是因為兩條路各自算杯數，一邊 20 一邊 16
function subscriptionsOnDate(date) {
  if (isClosed(date)) return [];
  const cs = cycleStartFor(date);
  return db.prepare(
    `SELECT ss.*, u.name user_name, p.code rx_code, p.name rx_name
       FROM staff_subscriptions ss
       JOIN users u ON u.id = ss.user_id
       JOIN prescriptions p ON p.id = ss.prescription_id
      WHERE ss.active = 1 AND ss.cycle_start = ?
      ORDER BY ss.id`
  ).all(cs).filter(r => parseDows(r.pickup_dows, [1, 3, 5]).includes(dowOf(date)));
}

// 某一天訂閱要做幾杯，依處方分組
function subscriptionCupsOnDate(date) {
  const by = {};
  subscriptionsOnDate(date).forEach(r => {
    by[r.prescription_id] = (by[r.prescription_id] || 0) + 1;
  });
  return Object.entries(by).map(([rxId, cups]) => ({ rxId: Number(rxId), cups }));
}

// 某一天各張處方要幾杯
function cupsOnDate(date) {
  const out = [];   // { rxId, cups, powderMult, why }
  // 廚房沒開就什麼都不做。回空陣列而不是照樣算 ——
  // 照樣算的話那天會出現在缺料清單上，叫你為一個不開工的日子買料
  if (isClosed(date)) return out;
  const dow = dowOf(date);

  // 同事訂閱。走自己的取餐日（週一三五），跟員工供應日（週二四）互不相干 ——
  // 不能掛在 isStaffMealDay 底下，那樣訂閱的日子一杯都不會做
  subscriptionCupsOnDate(date).forEach(x =>
    out.push({ rxId: x.rxId, cups: x.cups, powderMult: 1, why: '同事訂閱' }));

  // 員工：供應日才有，當天有出席紀錄就用實到人數，否則用名冊
  if (isStaffMealDay(dow)) {
    const rx = staffRxFor(date);
    if (rx) {
      const att = db.prepare('SELECT COUNT(*) c FROM staff_attendance WHERE date=? AND attending=1').get(date).c;
      const cups = att > 0 ? att : rosterCount();
      if (cups > 0) out.push({ rxId: rx.id, cups, powderMult: 1.0, why: '員工' });
    }
  }

  // 當天已經另外開單的處方，以單為準（單可能不是預設杯數）
  const orderedRx = new Set(db.prepare(
    'SELECT DISTINCT prescription_id FROM case_orders WHERE date=?'
  ).all(date).map(r => r.prescription_id));

  // 固定每日供應的處方，週末不出
  if (dow >= 1 && dow <= 5) {
    db.prepare(
      `SELECT id, name, COALESCE(daily_cups,0) daily_cups FROM prescriptions
        WHERE active=1 AND COALESCE(daily_cups,0) > 0`
    ).all().forEach(rx => {
      if (orderedRx.has(rx.id)) return;
      out.push({ rxId: rx.id, cups: rx.daily_cups, powderMult: 1.0, why: rx.name });
    });

    // 喝得不固定的（例如一週約 6 杯、沒有排定日子）：把週量平均攤到 5 個工作日。
    // 攤平只是為了讓備料量抓得住，不代表那天真的會喝那麼多
    db.prepare(
      `SELECT id, name, COALESCE(weekly_cups,0) weekly_cups FROM prescriptions
        WHERE active=1 AND COALESCE(weekly_cups,0) > 0 AND COALESCE(daily_cups,0) = 0`
    ).all().forEach(rx => out.push({ rxId: rx.id, cups: rx.weekly_cups / 5, powderMult: 1.0,
                                     why: rx.name + '（每週 ' + rx.weekly_cups + ' 杯攤平）' }));
  }

  // 已排的個案出單。只排除「每日固定供應」那種（上面已經算過）——
  // 不能連「用員工配方的個案單」一起排掉：員工那幾杯是從出勤表來的，
  // 這些是另外點的單，排掉就等於做了卻沒人算料。2026-09-03 當天
  // 扣庫存算 20 杯、缺料與採購只算 16 杯，差的就是這 4 杯。
  db.prepare(
    `SELECT co.prescription_id, co.cups, co.powder_type, p.name
       FROM case_orders co JOIN prescriptions p ON p.id=co.prescription_id
      WHERE co.date=?`
  ).all(date).forEach(c => {
    // 包裝要一起帶出去。下游（排產、缺料、採購）原本只拿到 powderMult，
    // 分不出「基底粉」和「精力湯」——所以基底粉的單照樣算了一整份蔬果
    out.push({ rxId: c.prescription_id, cups: c.cups,
               powderMult: powderMultFor(c.powder_type),
               powderType: c.powder_type || '', why: c.name });
  });

  return out;
}

const FRESH_CATS = new Set(['蔬菜', '水果', '油水', '油', '水', '其他']);

// 某一天的食材需求（已套用當天的蔬果方案）
function needsOnDate(date) {
  const need = {};
  cupsOnDate(date).forEach(({ rxId, cups, powderMult, powderType }) => {
    servedItems(rxId, date, powderType).forEach(r => {
      const mult = FRESH_CATS.has(r.category) ? 1.0 : powderMult;
      need[r.ingredient_id] = (need[r.ingredient_id] || 0) + r.qty_per_cup * cups * mult;
    });
  });
  return need;
}

// 同一樣食材可能同時出現在冷凍包裡、也出現在某個人自己的處方裡
// （藍莓就是這樣：方案一把它做進冷凍包，個案自己的處方也有）。
// 這兩份要分開算 —— 冷凍包那份看還剩幾份備品，自己那份看還有沒有生料。
// 混在一起算的話，庫存裡明明有 3100g 也會說做不出來。
function needsSplitOnDate(date, planRxSet) {
  const fromPlan = {}, fromOwn = {};
  cupsOnDate(date).forEach(({ rxId, cups, powderMult, powderType }) => {
    const bucket = planRxSet.has(rxId) ? fromPlan : fromOwn;
    servedItems(rxId, date, powderType).forEach(r => {
      const mult = FRESH_CATS.has(r.category) ? 1.0 : powderMult;
      bucket[r.ingredient_id] = (bucket[r.ingredient_id] || 0) + r.qty_per_cup * cups * mult;
    });
  });
  return { fromPlan, fromOwn };
}

function buildForecast(daysAhead) {
  const t       = today();
  const horizon = Math.min(Math.max(Number(daysAhead || 21), 7), 60);
  const bufPct  = Number(rotationSetting('buffer_pct', '20')) || 0;
  const bufCups = Number(rotationSetting('buffer_cups', '5')) || 0;

  const stock = {};
  db.prepare('SELECT ingredient_id, qty FROM inventory').all().forEach(r => { stock[r.ingredient_id] = r.qty; });
  const ingMap = {};
  db.prepare(
    `SELECT id, name, unit, category, safety_stock,
            COALESCE(count_unit,'') count_unit, COALESCE(count_ratio,1) count_ratio
       FROM ingredients WHERE active=1 AND COALESCE(track_stock,1)=1`
  ).all().forEach(i => { ingMap[i.id] = i; });

  // 備料區間：今天到下一個盤點日之前。週三、週五沒人盤點，
  // 所以再加一天當盲區緩衝 —— 那兩天發現不夠也沒人補得了
  const nextST   = nextStocktakeDay(t);
  const windowTo = addDays(nextST, 0);
  const windowDays = Math.round((Date.parse(windowTo + 'T00:00:00Z') - Date.parse(t + 'T00:00:00Z')) / 86400000);

  // 突發外帶：3~5 杯的原料。比例在小週會不夠，所以取「比例」與「絕對杯數」的大者
  const staffRx = staffRxFor(t);
  const bufferOne = {};
  if (staffRx && bufCups > 0) {
    effectiveItems(staffRx.id, t).forEach(r => { bufferOne[r.ingredient_id] = r.qty_per_cup * bufCups; });
  }

  const days = [];
  const cum  = {};            // 累計需求
  const windowNeed = {};      // 備料區間內的需求
  const firstNeed  = {};      // 每樣食材第一次被用到的日期
  const runsOut    = {};

  // 冷凍包的用料由備品支應，不看原料。備料當下原料就離開冰箱了，
  // 再去看原料會天天誤報「缺藍莓」—— 而藍莓其實就在包裡
  const packIds = new Set(
    db.prepare(
      `SELECT DISTINCT ppi.ingredient_id id FROM produce_plan_items ppi
         JOIN produce_plans pp ON pp.id = ppi.plan_id
        WHERE COALESCE(ppi.prep_stage,'')='冷凍包' AND pp.active=1`
    ).all().map(r => r.id)
  );
  const packGroupRx = new Set(planRxIds('主方案'));
  // 從今天「開始」還剩幾份 —— 今天的用量在下面的迴圈裡才扣，不能先扣掉
  let packLeft = packAvailableFrom('主方案', t);

  for (let i = 0; i < horizon; i++) {
    const date = addDays(t, i);
    const plan = activePlanFor('主方案', date);
    const n    = needsOnDate(date);
    const cups = cupsOnDate(date).reduce((a, b) => a + b.cups, 0);
    // 這一天有幾杯是吃方案的（那幾杯才會消耗備品）
    const planCups = cupsOnDate(date).filter(x => packGroupRx.has(x.rxId))
                                     .reduce((a, b) => a + b.cups, 0);

    // 這一天做不做得出來。用「累計需求 vs 現有庫存」比 ——
    // 今天用掉的，明天就沒有了，所以不能每天各自跟原始庫存比
    const short = [];
    const packCovered = Math.min(packLeft, planCups);      // 這一天有幾杯有備品可用
    const packMissing = Math.max(0, planCups - packLeft);  // 還缺幾杯份
    const split = needsSplitOnDate(date, packGroupRx);
    Object.entries(n).forEach(([id, q]) => {
      const nid = Number(id);

      // 冷凍包不夠的時候，要做的是「補做冷凍包」，而做冷凍包會吃生料。
      // 所以缺口只有一種幣別：克。
      //
      // 原本的寫法把「冷凍包還缺幾杯份」按比例換成克數，加進這一樣食材的缺口，
      // 但 need / have 兩欄描述的是生料 —— 結果同一列裡混了兩套數字，
      // 出現過「藍莓 需 505、手上 2250、缺 35」這種算術上不成立的一行。
      // 五樣冷凍包的料全部報缺 15 克，而生料其實有 500～3200 克。
      // 那份清單因此沒人相信，而它是每天第一個要看的東西。
      const perServing = packIds.has(nid) && planCups
        ? (split.fromPlan[id] || 0) / planCups
        : 0;
      // 備品不夠的那幾杯份，要現做，所以那些生料算進今天的需求
      const packRemake = Math.round(perServing * packMissing * 10) / 10;
      // 有備品可用的那幾杯不吃生料 —— 料在備料當天就離開冰箱了
      const fromOwn = q - (split.fromPlan[id] || 0);

      const rawQ = Math.round((fromOwn + packRemake) * 10) / 10;
      const used = cum[id] || 0;                 // 這一天之前已經用掉的
      const left = Math.max(0, (stock[id] || 0) - used);
      const gap  = Math.round(Math.max(0, rawQ - left) * 10) / 10;

      if (gap > 0.05 && ingMap[id]) {
        short.push({ id: nid, name: ingMap[id].name, unit: ingMap[id].unit,
                     // need 與 have 現在講的是同一件事：這一天真的要動用多少生料、手上還有多少
                     need: rawQ,
                     have: Math.round(left * 10) / 10,
                     gap,
                     // 這一樣有一部分是為了補做冷凍包才要用的
                     for_pack: packRemake > 0.05 });
      }
    });
    packLeft = Math.max(0, packLeft - packCovered);
    short.sort((a, b) => b.gap - a.gap);

    days.push({ date, dow: dowOf(date), plan_code: plan ? plan.code : null,
                plan_name: plan ? plan.name : null,
                is_staff_meal_day: isStaffMealDay(dowOf(date)), cups,
                is_stocktake_day: stocktakeDows().includes(dowOf(date)),
                packs_left: Math.round(packLeft * 10) / 10,
                // 備品不夠是一件「要備料」的事，不是「缺料」。
                // 混在缺料清單裡的話，畫面上會變成五樣食材各缺 15 克 ——
                // 看起來要跑一趟市場，實際上只要進廚房分裝
                pack_short_servings: Math.round(packMissing * 10) / 10,
                feasible: short.length === 0, short });

    Object.entries(n).forEach(([id, q]) => {
      cum[id] = (cum[id] || 0) + q;
      if (!firstNeed[id]) firstNeed[id] = date;
      if (date <= windowTo) windowNeed[id] = (windowNeed[id] || 0) + q;
      if (!runsOut[id] && cum[id] > (stock[id] || 0)) runsOut[id] = date;
    });
  }

  const ingredients = Object.keys(ingMap).filter(id => cum[id] || stock[id]).map(id => {
    const ing  = ingMap[id];
    const have = Math.round((stock[id] || 0) * 10) / 10;
    const win  = Math.round((windowNeed[id] || 0) * 10) / 10;
    // 緩衝：比例與絕對杯數取大者
    const buf  = Math.round(Math.max(win * bufPct / 100, bufferOne[id] || 0) * 10) / 10;
    const target = Math.round((win + buf) * 10) / 10;
    return {
      id: Number(id), name: ing.name, unit: ing.unit, category: ing.category,
      count_unit: ing.count_unit, count_ratio: ing.count_ratio,
      stock: have,
      need_window: win, buffer: buf, need_with_buffer: target,
      buy: Math.max(0, Math.round((target - have) * 10) / 10),
      need_horizon: Math.round((cum[id] || 0) * 10) / 10,
      runs_out_on: runsOut[id] || null,
      first_needed_on: firstNeed[id] || null,
      below_safety: ing.safety_stock > 0 && have < ing.safety_stock
    };
  }).sort((a, b) => (b.buy - a.buy) || String(a.name).localeCompare(String(b.name)));

  // 換方案預警：下一次換組是哪天，屆時要用到但現在幾乎沒有的東西。
  // 這是最容易開天窗的地方 —— 方案一期間，方案二的蔬果完全不會被碰到
  const todayPlan = activePlanFor('主方案', t);
  const switchDay = days.find(d => todayPlan && d.plan_code && d.plan_code !== todayPlan.code);
  let switchWarning = null;
  if (switchDay) {
    // 換過去之後要撐到那時候的下一個盤點日，不是只撐換組當天。
    // 只算一天會嚴重低估 —— 「缺 30g 蛋白粉」看起來沒事，實際上要好幾百克
    const covTo = nextStocktakeDay(switchDay.date);
    const need = {};
    for (let d = switchDay.date; d <= covTo; d = addDays(d, 1)) {
      Object.entries(needsOnDate(d)).forEach(([id, q]) => { need[id] = (need[id] || 0) + q; });
    }
    const coverDays = Math.round((Date.parse(covTo + 'T00:00:00Z') - Date.parse(switchDay.date + 'T00:00:00Z')) / 86400000) + 1;
    const missing = Object.entries(need)
      .filter(([id, q]) => (stock[id] || 0) < q && ingMap[id])
      .map(([id, q]) => ({ name: ingMap[id].name, unit: ingMap[id].unit,
                           need: Math.round(q * 10) / 10,
                           stock: Math.round((stock[id] || 0) * 10) / 10,
                           gap: Math.round((q - (stock[id] || 0)) * 10) / 10 }))
      .sort((a, b) => b.gap - a.gap);
    switchWarning = { date: switchDay.date, from: todayPlan.name, to: switchDay.plan_name,
                      days_ahead: Math.round((Date.parse(switchDay.date + 'T00:00:00Z') - Date.parse(t + 'T00:00:00Z')) / 86400000),
                      cover_to: covTo, cover_days: coverDays, missing };
  }

  // 最近一個做不出來的日子。廚房早上要問的第一個問題就是這個
  const firstShort = days.find(d => d.cups > 0 && !d.feasible) || null;

  return {
    date: t, horizon_days: horizon,
    packs: packStatus('主方案', t),
    first_short: firstShort && { date: firstShort.date, dow: firstShort.dow,
                                 cups: firstShort.cups, plan_name: firstShort.plan_name,
                                 short: firstShort.short },
    plan_today: todayPlan ? { code: todayPlan.code, name: todayPlan.name } : null,
    stocktake_dows: stocktakeDows(),
    prep_window: { from: t, to: windowTo, days: windowDays,
                   note: `到 ${windowTo}（下一個盤點日）之前要撐住` },
    buffer: { pct: bufPct, cups: bufCups },
    days, ingredients, switch_warning: switchWarning
  };
}

// 分裝表：這一批要秤多少、做幾份。
// servings 沒給的話，用「到下一個盤點日之前排定的杯數」當建議 ——
// 備料可能一週一次也可能分兩次，所以是建議不是規定
app.get('/api/prep/worksheet', (req, res) => {
  const group = req.query.group || '主方案';
  const date  = req.query.date  || today();
  let servings = Number(req.query.servings);
  if (!(servings > 0)) {
    const to = nextStocktakeDay(date);
    servings = 0;
    for (let d = date; d <= to; d = addDays(d, 1)) {
      const rxIds = new Set(planRxIds(group));
      servings += cupsOnDate(d).filter(x => rxIds.has(x.rxId)).reduce((s, x) => s + x.cups, 0);
    }
    servings = Math.ceil(servings);
  }
  const ws = prepWorksheet(group, servings, date);
  res.json({ date, group, suggested_servings: servings, ...ws,
             status: packStatus(group, date) });
});

// 目前還剩幾份備品
app.get('/api/prep/status', (req, res) => {
  const group = req.query.group || '主方案';
  res.json(packStatus(group, req.query.date || today()));
});

// 記錄一次備料：扣掉冷凍包那幾樣的原料，產生 N 份備品
app.post('/api/prep/batch', (req, res) => {
  const group = req.body.group || '主方案';
  const date  = req.body.date  || today();
  const servings = Math.floor(Number(req.body.servings) || 0);
  if (!(servings > 0)) return res.status(400).json({ error: '要做幾份？' });

  const ws = prepWorksheet(group, servings, date);
  if (!ws.plan) return res.status(400).json({ error: '找不到當期的蔬果方案' });
  if (!ws.items.length) return res.status(400).json({ error: '這個方案沒有標成冷凍包的用料' });

  let id;
  tx(() => {
    const r = db.prepare(
      `INSERT INTO prep_batches (date,group_code,plan_id,plan_name,servings,note,user_id,user_name)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(date, group, null, ws.plan.name, servings, req.body.note || '',
          req.kitchenUser ? req.kitchenUser.id : null,
          req.kitchenUser ? req.kitchenUser.name : '');
    id = r.lastInsertRowid;
    const ins = db.prepare('INSERT INTO prep_batch_items (batch_id,ingredient_id,qty) VALUES (?,?,?)');
    ws.items.forEach(it => {
      ins.run(id, it.id, it.need);
      // 扣到 0 為止 —— 原料不夠也要記錄實際做了幾份，不要讓庫存變負數
      db.prepare(
        `UPDATE inventory SET qty=MAX(0, ROUND(qty-?,1)), updated_at=datetime('now','localtime')
          WHERE ingredient_id=?`
      ).run(it.need, it.id);
    });
  });
  const short = ws.items.filter(i => i.short > 0);
  res.json({ id, servings, plan: ws.plan.name,
             items: ws.items.length,
             warning: short.length
               ? '原料不足：' + short.map(i => `${i.name} 差 ${i.short}${i.unit}`).join('、')
               : '',
             status: packStatus(group, date) });
});

// 還原一次備料：把原料加回去。備料記錯份量時要改得回來
app.post('/api/prep/batch/:id/reverse', (req, res) => {
  const b = db.prepare("SELECT * FROM prep_batches WHERE id=? AND COALESCE(reversed_at,'')=''")
              .get(req.params.id);
  if (!b) return res.status(404).json({ error: '找不到這一批，或已經還原過' });
  tx(() => {
    db.prepare('SELECT ingredient_id, qty FROM prep_batch_items WHERE batch_id=?').all(b.id)
      .forEach(it => {
        db.prepare(
          `INSERT INTO inventory (ingredient_id,qty,updated_at) VALUES (?,?,datetime('now','localtime'))
           ON CONFLICT(ingredient_id) DO UPDATE SET qty=qty+excluded.qty, updated_at=excluded.updated_at`
        ).run(it.ingredient_id, it.qty);
      });
    db.prepare("UPDATE prep_batches SET reversed_at=datetime('now','localtime') WHERE id=?").run(b.id);
  });
  res.json({ ok: true, status: packStatus(b.group_code, today()) });
});

// 最近幾批
app.get('/api/prep/batches', (req, res) => {
  const days = Number(req.query.days || 30);
  const from = addDays(today(), -days);
  const rows = db.prepare(
    `SELECT * FROM prep_batches WHERE date >= ? ORDER BY date DESC, id DESC`
  ).all(from);
  res.json(rows.map(b => ({
    ...b,
    items: db.prepare(
      `SELECT pbi.qty, i.name, i.unit FROM prep_batch_items pbi
         JOIN ingredients i ON i.id=pbi.ingredient_id WHERE pbi.batch_id=?`
    ).all(b.id)
  })));
});

app.get('/api/inventory/forecast', (req, res) => res.json(buildForecast(req.query.days)));

// 今天要盤哪幾樣。不要每次盤 48 樣 —— 盤太多就會開始亂填。
// 只盤這個備料區間會用到的、快到安全量的、以及上次差異大的
app.get('/api/stocktake/shortlist', (req, res) => {
  const t = today();
  const fc = buildForecast(21);   // 和預測同一份計算，不各自算一次

  const lastVar = {};
  db.prepare(
    `SELECT si.ingredient_id, si.variance FROM stocktake_items si
      JOIN stocktakes s ON s.id=si.stocktake_id
      WHERE s.id=(SELECT MAX(id) FROM stocktakes)`
  ).all().forEach(r => { lastVar[r.ingredient_id] = r.variance; });

  const list = (fc.ingredients || []).map(i => {
    const reasons = [];
    if (i.need_window > 0)                 reasons.push('這批會用到');
    if (i.below_safety)                    reasons.push('低於安全量');
    if (i.buy > 0)                         reasons.push('可能不夠');
    if (Math.abs(lastVar[i.id] || 0) > 20) reasons.push('上次差異大');
    return { ...i, reasons, last_variance: lastVar[i.id] ?? null };
  }).filter(i => i.reasons.length)
    .sort((a, b) => b.reasons.length - a.reasons.length || b.buy - a.buy);

  res.json({ date: t, is_stocktake_day: stocktakeDows().includes(dowOf(t)),
             stocktake_dows: stocktakeDows(), count: list.length, items: list });
});

app.get('/api/inventory/check', (req, res) => {
  const t = today();
  // 本週剩餘到週日
  const tDate = new Date(t + 'T00:00:00');
  const dow = tDate.getDay(); // 0=日,1=一,...,6=六
  const daysToSun = dow === 0 ? 0 : 7 - dow;
  const endSun = new Date(tDate);
  endSun.setDate(endSun.getDate() + daysToSun);
  const endStr = endSun.toISOString().slice(0, 10);

  // 現有庫存
  const stock = {};
  db.prepare('SELECT ingredient_id, qty FROM inventory').all()
    .forEach(r => { stock[r.ingredient_id] = r.qty; });

  // 累計配方需求
  const needs = {};
  function addRxNeeds(rxId, cups, powderMult, forDate, powderType) {
    if (cups <= 0) return;
    powderMult = powderMult || 1.0;
    servedItems(rxId, forDate, powderType).forEach(r => {
      const freshCats = new Set(['蔬菜','水果','油水','油','水','其他']);
      const mult = freshCats.has(r.category) ? 1.0 : powderMult;
      needs[r.ingredient_id] = (needs[r.ingredient_id] || 0) + r.qty_per_cup * cups * mult;
    });
  }

  // 1. AW 本週剩餘杯數（週五備週六日外帶，週六日已備妥算 0）
  //    週一=7, 週二=6, 週三=5, 週四=4, 週五=3(含週六日), 週六=0, 週日=0
  //    原本這段是為「AW」這位個案寫死的（每日 1 杯＋7 杯緩衝）。
  //    改成讀處方上的 daily_cups / buffer_cups，換人或停用不用改程式。
  const remainingDays = (dow >= 1 && dow <= 4) ? (8 - dow) : (dow === 5 ? 3 : 0);
  const dailyRxList = db.prepare(
    `SELECT id, name, COALESCE(daily_cups,0) daily_cups, COALESCE(buffer_cups,0) buffer_cups
     FROM prescriptions
     WHERE active=1 AND (COALESCE(daily_cups,0) > 0 OR COALESCE(buffer_cups,0) > 0)`
  ).all();
  const dailySupply = dailyRxList.map(rx => {
    const cups = rx.daily_cups * remainingDays;
    addRxNeeds(rx.id, cups);
    addRxNeeds(rx.id, rx.buffer_cups);
    return { name: rx.name, daily_cups: rx.daily_cups, cups,
             buffer_cups: rx.buffer_cups, total: cups + rx.buffer_cups };
  });
  const awCups = dailySupply.reduce((s, r) => s + r.cups, 0);

  // 2. 員工本週剩餘餐次 × 在編人數
  //    人數改為讀實際名冊，不再寫死 9 人（離職或新進都會反映）；
  //    今天如果就是供應日，用今天實際的出席人數，休假的不算進採購量
  const empDays  = (dow === 0 || dow === 6) ? 0 : staffMealDows().filter(d => d >= dow).length;
  const roster   = rosterCount();
  const todayAtt = db.prepare(
    'SELECT COUNT(*) c FROM staff_attendance WHERE date=? AND attending=1'
  ).get(t).c;
  // 今天是供應日就用今天的實到人數，其餘未來供應日用名冊人數
  const todayIsMeal = isStaffMealDay(dow);
  const empCups = todayIsMeal
    ? todayAtt + Math.max(empDays - 1, 0) * roster
    : empDays * roster;
  const empRx = staffRxFor(today());
  if (empRx) addRxNeeds(empRx.id, empCups);

  // 3. 本週已排個案出單（排除 AW 和員工配方，避免重複計算）
  db.prepare(
    `SELECT co.prescription_id, co.cups, co.powder_type
     FROM case_orders co
     JOIN prescriptions p ON p.id=co.prescription_id
     WHERE co.date >= ? AND co.date <= ?
       AND p.name != 'AW' AND p.is_staff_rx = 0`
  ).all(t, endStr).forEach(c => {
    const pm = (c.powder_type === '罐裝' || c.powder_type === '全配方') ? 1.1 : 1.0;
    // 那一筆自己的日期 —— 這個 scope 裡沒有 date，而且出單可能落在下一個方案期
    addRxNeeds(c.prescription_id, c.cups, pm, c.date, c.powder_type);
  });

  // 整合結果（附本週需求說明）
  const ingMap = {};
  db.prepare('SELECT id, name, unit, category FROM ingredients WHERE active=1').all()
    .forEach(i => { ingMap[i.id] = i; });

  const weekLabel = ['日','一','二','三','四','五','六'][dow];
  const check = Object.keys({ ...stock, ...needs })
    .filter(id => ingMap[id])
    .map(id => {
      const ing  = ingMap[id];
      const s    = Math.round((stock[id] || 0) * 10) / 10;
      const n    = Math.round((needs[id] || 0) * 10) / 10;
      const diff = Math.round((s - n) * 10) / 10;
      return { ingredient_id: +id, name: ing.name, unit: ing.unit, category: ing.category,
               stock: s, needed: n, remaining: diff, sufficient: s >= n };
    })
    .sort((a, b) => a.remaining - b.remaining);

  // 低於安全庫存：這個欄位原本只顯示數字，沒有任何地方會示警。
  // 「本週夠不夠」和「有沒有低於安全存量」是兩件事，兩個都要講。
  const belowSafety = db.prepare(
    `SELECT i.id, i.name, i.unit, i.safety_stock, COALESCE(inv.qty,0) qty
     FROM ingredients i LEFT JOIN inventory inv ON inv.ingredient_id=i.id
     WHERE i.active=1 AND COALESCE(i.safety_stock,0) > 0
       AND COALESCE(inv.qty,0) < i.safety_stock
     ORDER BY (COALESCE(inv.qty,0) / i.safety_stock)`
  ).all();

  res.json({
    check,
    insufficient_count: check.filter(r => !r.sufficient).length,
    below_safety: belowSafety,
    below_safety_count: belowSafety.length,
    week_info: {
      dow, weekLabel, awCups, empCups, endStr,
      bufferCups: dailySupply.reduce((s, r) => s + r.buffer_cups, 0),
      daily_supply: dailySupply,          // 每日固定供應的處方（設定驅動）
      emp_days: empDays, roster, today_attending: todayAtt,
      meal_dows: staffMealDows(), meal_label: staffMealDaysLabel()
    }
  });
});

// ════════════════════════════════════════════════════════
// API: 成本
// ════════════════════════════════════════════════════════

app.get('/api/costs', (req, res) => {
  const settings = getSettings();
  const lp = laborParams(settings);
  const staffProd = db.prepare('SELECT batch_size FROM products WHERE id=1').get();
  // 處方成本參考表用「攤到每杯」的工時；當日實際成本則走 calcDailyCost
  const laborCostPerCup = laborPerCup(lp, staffProd ? staffProd.batch_size : 3);
  const ucCache = buildUnitCostCache(settings);
  const ucDetail = unitCostDetail(settings);

  // 今日實際成本（按產品）
  const todayCost = calcDailyCost(today(), ucCache, lp);

  // 處方成本參考表（每份標準成本）
  const rxs = db.prepare(
    `SELECT p.*, pr.name as product_name, pr.unit as product_unit
     FROM prescriptions p LEFT JOIN products pr ON pr.id=p.product_id
     WHERE p.active=1 ORDER BY pr.sort_order, p.product_id, p.is_staff_rx DESC, p.code`
  ).all();

  const prescriptions = rxs.map(rx => {
    const items = effectiveItems(rx.id);

    let ingCost = 0;
    const breakdown = items.map(it => {
      const uc = ucCache[it.iid] || 0;
      const cost = uc * it.qty_per_cup;
      ingCost += cost;
      const d = ucDetail.detail[it.iid];
      return { name: it.name, unit: it.unit, category: it.category,
               qty: it.qty_per_cup, qty_per_cup: it.qty_per_cup,
               unit_cost: Math.round(uc * 1000) / 1000, cost: Math.round(cost * 10) / 10,
               // 這個單價是幾筆採購算出來的。1 筆＝很脆，0 筆＝根本沒進過貨
               price_n: d ? d.n : 0,
               // window = 窗口內有採購；history = 窗口內沒有，退回用全部歷史（價可能已經過時）
               price_source: d ? d.source : 'none',
               price_last: d ? d.last : null };
    });

    return {
      ...rx,
      ingredient_cost: Math.round(ingCost * 10) / 10,
      labor_cost:      Math.round(laborCostPerCup * 10) / 10,
      total_cost:      Math.round((ingCost + laborCostPerCup) * 10) / 10,
      breakdown
    };
  });

  res.json({
    settings,
    labor_cost_per_cup: Math.round(laborCostPerCup * 10) / 10,
    labor_model: {
      rate: lp.rate, min_per_batch: lp.perBatch, min_per_serving: lp.perServing,
      batch_size: staffProd ? staffProd.batch_size : 3
    },
    cost_lookback_days: settings.cost_lookback_days || 0,
    // 窗口起點。畫面上要講得出「只看這天以後的採購」，
    // 不然單價為什麼跳動沒人說得清
    cost_window_from: ucDetail.from,
    today: todayCost, prescriptions
  });
});

// 月報：某月每日成本 + 月合計
app.get('/api/costs/monthly', (req, res) => {
  const month = (req.query.month || today().slice(0, 7)).slice(0, 7);
  const settings = getSettings();
  const lp = laborParams(settings);
  const ucCache = buildUnitCostCache(settings);

  // 找出該月有出單或出席的所有日期
  const activeDates = new Set();
  db.prepare(`SELECT DISTINCT date FROM case_orders WHERE date LIKE ? ORDER BY date`)
    .all(`${month}-%`).forEach(r => activeDates.add(r.date));
  db.prepare(`SELECT DISTINCT date FROM staff_attendance WHERE date LIKE ? AND attending=1`)
    .all(`${month}-%`).forEach(r => activeDates.add(r.date));
  // 只有餐盒、沒有精力湯的日子也要進月報
  try {
    db.prepare(`SELECT DISTINCT date FROM meal_orders WHERE date LIKE ?`)
      .all(`${month}-%`).forEach(r => activeDates.add(r.date));
    db.prepare(`SELECT DISTINCT date FROM meal_purchase_log WHERE date LIKE ?`)
      .all(`${month}-%`).forEach(r => activeDates.add(r.date));
  } catch(e) {}

  const days = Array.from(activeDates).sort()
    .map(d => calcDailyCost(d, ucCache, lp));

  // 月合計（按產品）
  const byProduct = {};
  days.forEach(d => {
    d.products.forEach(p => {
      if (!byProduct[p.product_id]) {
        byProduct[p.product_id] = {
          product_id: p.product_id, product_name: p.product_name,
          product_unit: p.product_unit, total_cups: 0,
          ingredient_cost: 0, labor_cost: 0, total_cost: 0
        };
      }
      const b = byProduct[p.product_id];
      b.total_cups      += p.total_cups;
      b.ingredient_cost += p.ingredient_cost;
      b.labor_cost      += p.labor_cost;
      b.total_cost      += p.total_cost;
    });
  });

  const by_product = Object.values(byProduct).map(p => ({
    ...p,
    ingredient_cost: Math.round(p.ingredient_cost * 10) / 10,
    labor_cost:      Math.round(p.labor_cost * 10) / 10,
    total_cost:      Math.round(p.total_cost * 10) / 10,
    cost_per_unit:   p.total_cups > 0 ? Math.round(p.total_cost / p.total_cups * 10) / 10 : 0
  }));

  const month_total = Math.round(days.reduce((s, d) => s + d.grand_total, 0) * 10) / 10;

  // 餐盒月合計（外購品，不併入 by_product 的自製品成本結構）
  const meals = days.reduce((acc, d) => {
    const m = d.meals || { count: 0, planned: 0, actual: 0, total: 0 };
    acc.count   += m.count   || 0;
    acc.planned += m.planned || 0;
    acc.actual  += m.actual  || 0;
    acc.total   += m.total   || 0;
    return acc;
  }, { count: 0, planned: 0, actual: 0, total: 0 });
  ['planned', 'actual', 'total'].forEach(k => { meals[k] = Math.round(meals[k] * 10) / 10; });
  meals.cost_per_box = meals.count > 0 ? Math.round(meals.total / meals.count * 10) / 10 : 0;

  res.json({ month, days, month_total, by_product, meals });
});

app.put('/api/settings', (req, res) => {
  const entries = Object.entries(req.body);
  entries.forEach(([k, v]) => {
    db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(k, String(v));
  });
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════
// API: 人力記錄（時薪讀設定 labor_rate）
// ════════════════════════════════════════════════════════

app.get('/api/labor', (req, res) => {
  const date = req.query.date || today();
  const rows = db.prepare(
    `SELECT lr.*, u.name as user_name
     FROM labor_records lr LEFT JOIN users u ON u.id=lr.user_id
     WHERE lr.date=? ORDER BY lr.id`
  ).all(date);
  // 時薪讀設定，不再寫死。每筆若自己存了時薪就用自己的
  const rate = laborParams(getSettings()).rate;
  const total_minutes = rows.reduce((s, r) => s + (r.minutes || 0), 0);
  const total_cost = Math.round(
    rows.reduce((s, r) => s + (r.minutes || 0) / 60 * (r.hourly_rate || rate), 0) * 10
  ) / 10;
  res.json({ date, records: rows, total_minutes, total_cost, hourly_rate: rate });
});

app.post('/api/labor', (req, res) => {
  const { date, user_id, role, task_type, purpose, minutes } = req.body;
  if (!minutes || minutes <= 0) return res.status(400).json({ error: 'invalid' });
  const r = db.prepare(
    `INSERT INTO labor_records (date,user_id,role,task_type,purpose,minutes,hourly_rate) VALUES (?,?,?,?,?,?,?)`
  ).run(date || today(), user_id||null, role||'', task_type||'製作', purpose||'精力湯', minutes,
        laborParams(getSettings()).rate);
  res.json({ id: r.lastInsertRowid });
});

app.delete('/api/labor/:id', (req, res) => {
  db.prepare('DELETE FROM labor_records WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════
// API: 試菜記錄
// ════════════════════════════════════════════════════════

app.get('/api/trial_recipes', (req, res) => {
  const recipes = db.prepare('SELECT * FROM trial_recipes ORDER BY id DESC').all();
  const result = recipes.map(r => {
    const sessions = db.prepare(
      'SELECT * FROM trial_sessions WHERE trial_recipe_id=? ORDER BY session_no, id'
    ).all(r.id);
    const total_labor = sessions.reduce((s, ss) => s + (ss.labor_minutes || 0), 0);
    return { ...r, sessions, total_labor_minutes: total_labor,
             total_labor_cost: Math.round(total_labor / 60 * 196 * 10) / 10 };
  });
  res.json(result);
});

app.post('/api/trial_recipes', (req, res) => {
  const { name, notes } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: '請填寫名稱' });
  const r = db.prepare(
    `INSERT INTO trial_recipes (name,notes,created_at) VALUES (?,?,datetime('now','localtime'))`
  ).run(name.trim(), notes||'');
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/trial_recipes/:id', (req, res) => {
  const { name, status, notes } = req.body;
  db.prepare(`UPDATE trial_recipes SET name=?,status=?,notes=? WHERE id=?`)
    .run(name, status||'試驗中', notes||'', req.params.id);
  res.json({ ok: true });
});

app.post('/api/trial_recipes/:id/sessions', (req, res) => {
  const { date, notes, labor_minutes, participants } = req.body;
  const maxNo = db.prepare(
    'SELECT COALESCE(MAX(session_no),0) as m FROM trial_sessions WHERE trial_recipe_id=?'
  ).get(req.params.id).m;
  const r = db.prepare(
    `INSERT INTO trial_sessions (trial_recipe_id,session_no,date,notes,labor_minutes,participants,created_at)
     VALUES (?,?,?,?,?,?,datetime('now','localtime'))`
  ).run(req.params.id, maxNo+1, date||today(), notes||'', labor_minutes||0, participants||'');
  res.json({ id: r.lastInsertRowid });
});

app.delete('/api/trial_sessions/:id', (req, res) => {
  db.prepare('DELETE FROM trial_sessions WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/trial_recipes/:id', (req, res) => {
  tx(() => {
    db.prepare('DELETE FROM trial_sessions WHERE trial_recipe_id=?').run(req.params.id);
    db.prepare('DELETE FROM trial_recipes WHERE id=?').run(req.params.id);
  });
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════
// 備份
// 整個系統就是 volume 上的一個 SQLite 檔，沒有任何備份機制 ——
// 檔案損壞或誤刪就是全部歸零。每天留一份，保留最近 14 天，
// 並提供下載端點讓人可以把副本抓到 Railway 之外。
// VACUUM INTO 對執行中的資料庫是安全的，不需要停機。
// ════════════════════════════════════════════════════════
const BACKUP_DIR    = path.join(path.dirname(DB_PATH), 'backups');
const BACKUP_KEEP   = 14;

function runBackup(force) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const file = path.join(BACKUP_DIR, `clinic-${today()}.db`);
    if (!force && fs.existsSync(file)) return null;      // 一天一份就夠
    if (fs.existsSync(file)) fs.unlinkSync(file);        // force 時覆蓋
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);

    // 只留最近 N 份
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => /^clinic-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    while (files.length > BACKUP_KEEP) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch (e) {}
    }
    const size = fs.statSync(file).size;
    console.log(`備份完成 ${path.basename(file)}（${Math.round(size / 1024)} KB，保留 ${files.length} 份）`);
    return { file: path.basename(file), size };
  } catch (e) {
    console.error('備份失敗:', e.message);
    return null;
  }
}

runBackup();
setInterval(() => runBackup(), 12 * 3600 * 1000);   // 每 12 小時檢查一次，一天實際產生一份

app.get('/api/backups', (req, res) => {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const list = fs.readdirSync(BACKUP_DIR)
      .filter(f => /^clinic-\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort().reverse()
      .map(f => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, size: st.size, created_at: st.mtime.toISOString().slice(0, 19).replace('T', ' ') };
      });
    res.json({ dir: BACKUP_DIR, keep: BACKUP_KEEP, backups: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/backups/run', (req, res) => {
  const r = runBackup(true);
  if (!r) return res.status(500).json({ error: '備份失敗，請看伺服器記錄' });
  res.json({ ok: true, ...r });
});

app.get('/api/backups/:name', (req, res) => {
  // 只接受自己產生的檔名格式，避免被拿去讀其他路徑
  if (!/^clinic-\d{4}-\d{2}-\d{2}\.db$/.test(req.params.name)) {
    return res.status(400).json({ error: '檔名不正確' });
  }
  const file = path.join(BACKUP_DIR, req.params.name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: '找不到這份備份' });
  res.download(file, req.params.name);
});

// ════════════════════════════════════════════════════════
// API: 盤點
// 帳面庫存只會在有人按「拿取」時才扣，忘了按就永遠不扣，數字只會越來越虛高。
// 盤點是把帳面拉回現實的唯一可靠手段：輸入實際數到的量，系統覆寫庫存並記下差異。
// 差異本身就是管理資訊 —— 那是這段期間的損耗（灑出、壞掉、多打）。
// ════════════════════════════════════════════════════════
app.get('/api/stocktake/draft', (req, res) => {
  const rows = db.prepare(
    `SELECT i.id ingredient_id, i.name, i.unit, i.category,
            i.count_unit, i.count_ratio, COALESCE(inv.qty,0) book_qty
     FROM ingredients i LEFT JOIN inventory inv ON inv.ingredient_id=i.id
     WHERE i.active=1 ORDER BY i.sort_order, i.id`
  ).all();
  const last = db.prepare(
    `SELECT s.id, s.date, s.created_at, u.name user_name
     FROM stocktakes s LEFT JOIN users u ON u.id=s.user_id
     ORDER BY s.id DESC LIMIT 1`
  ).get();
  res.json({ date: today(), items: rows, last_stocktake: last || null });
});

app.post('/api/stocktake', (req, res) => {
  const { date, note, items } = req.body;
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: '沒有盤點資料' });
  }
  const d = date || today();
  const result = tx(() => {
    const st = db.prepare(
      'INSERT INTO stocktakes (date,user_id,note) VALUES (?,?,?)'
    ).run(d, req.kitchenUser.id, note || '');
    const insItem = db.prepare(
      `INSERT INTO stocktake_items (stocktake_id,ingredient_id,book_qty,counted_qty,variance)
       VALUES (?,?,?,?,?)`
    );
    const setQty = db.prepare(
      `INSERT INTO inventory (ingredient_id,qty,updated_at)
       VALUES (?,?,datetime('now','localtime'))
       ON CONFLICT(ingredient_id) DO UPDATE SET qty=excluded.qty, updated_at=excluded.updated_at`
    );
    let counted = 0, shortage = 0;
    items.forEach(it => {
      const id = Number(it.ingredient_id);
      if (!id || it.counted_qty === '' || it.counted_qty == null) return;   // 沒填的品項跳過，不動它
      const book = db.prepare('SELECT COALESCE(qty,0) q FROM inventory WHERE ingredient_id=?').get(id)?.q || 0;
      const cnt  = Number(it.counted_qty) || 0;
      const varc = Math.round((cnt - book) * 100) / 100;
      insItem.run(st.lastInsertRowid, id, book, cnt, varc);
      setQty.run(id, cnt);
      counted++;
      if (varc < 0) shortage += 1;
    });
    return { id: st.lastInsertRowid, counted, shortage };
  });
  res.json({ ok: true, ...result });
});

app.get('/api/stocktake/:id', (req, res) => {
  const st = db.prepare(
    `SELECT s.*, u.name user_name FROM stocktakes s
     LEFT JOIN users u ON u.id=s.user_id WHERE s.id=?`
  ).get(req.params.id);
  if (!st) return res.status(404).json({ error: '找不到這次盤點' });
  const items = db.prepare(
    `SELECT si.*, i.name, i.unit FROM stocktake_items si
     JOIN ingredients i ON i.id=si.ingredient_id
     WHERE si.stocktake_id=? ORDER BY si.variance`
  ).all(req.params.id);
  res.json({ ...st, items });
});

app.get('/api/stocktakes', (req, res) => {
  res.json(db.prepare(
    `SELECT s.id, s.date, s.note, s.created_at, u.name user_name,
            COUNT(si.id) item_count,
            SUM(CASE WHEN si.variance < 0 THEN 1 ELSE 0 END) shortage_count
     FROM stocktakes s
     LEFT JOIN users u ON u.id=s.user_id
     LEFT JOIN stocktake_items si ON si.stocktake_id=s.id
     GROUP BY s.id ORDER BY s.id DESC LIMIT 30`
  ).all());
});

// ════════════════════════════════════════════════════════
// API: 套餐模組（Meal Set）
// ════════════════════════════════════════════════════════

// 精力湯營養：由處方即時算出。粉類的 1.1 倍與 buildPrepAndPowder 一致
function calcTonicNutrition(rxId, powderMultiplier) {
  const pm = powderMultiplier || 1.0;
  const rows = effectiveItems(rxId);

  let kcal = 0, protein = 0;
  const breakdown = rows.map(r => {
    const mult = r.category === '粉類' ? pm : 1;
    const qty  = r.qty_per_cup * mult;
    const k    = qty * r.kcal_per_unit;
    kcal += k;
    protein += qty * r.protein_per_unit;
    return {
      name: r.name, unit: r.unit, qty: Math.round(qty * 100) / 100,
      kcal: Math.round(k * 10) / 10
    };
  });

  return {
    kcal:              Math.round(kcal),
    protein_g:         Math.round(protein * 10) / 10,
    powder_multiplier: pm,
    has_nutrition_data: rows.length > 0 && rows.some(r => r.kcal_per_unit > 0),
    breakdown
  };
}

function powderMultFor(powderType) {
  return (powderType === '罐裝' || powderType === '全配方') ? 1.1 : 1.0;
}

// ── 基底粉的單只給粉類 ────────────────────────────────────
//
// 處方是完整的臨床配方，個案的處方會整張 key 上去。但實際出給他的
// 可能只有粉 —— 袋裝基底粉、罐裝基底粉就是這種：客人自己回家沖，
// 不拿菜。拿處方當生產規格，蔬果就會虛高。
//
// 2026-09 量過：過去 30 天 112 杯裡有 41 杯是基底粉（37%），
// 而它們每一杯都照樣扣掉一整份蔬果。9/11 有一張個人處方一次出 21 杯袋裝粉，
// 就這樣生出 220 g 甜菜根的需求 —— 那樣食材早就換成火龍果了。
//
// 只在這裡定義一次。扣庫存、排產、缺料、採購、備料表、成本
// 六個地方都讀這一支 —— 各寫一份的話改一邊就會不一致，
// 而「同一個數字兩套算法」是這個系統最貴的那一類 bug。
const POWDER_ONLY_TYPES = new Set(['袋裝', '罐裝']);
function isPowderOnly(powderType) {
  return POWDER_ONLY_TYPES.has(String(powderType || ''));
}
// 這一單實際會用到的用料。基底粉只留粉類 ——
// 蔬菜、水果、油、水、保健品都不出
function servedItems(rxId, date, powderType) {
  const items = effectiveItems(rxId, date);
  return isPowderOnly(powderType) ? items.filter(r => r.category === '粉類') : items;
}

// 買便當是有時間壓力的事：最早用餐時間往前推來回步行、每間店的取餐等候，
// 再留擺盤時間。回一個「幾點要出發」給畫面，而不是只給步行分鐘數。
const PICKUP_MIN_PER_VENDOR = 5;   // 每間店等餐
const PLATING_BUFFER_MIN    = 10;  // 拆盒、轉盤、貼封口貼紙

function computeDepartBy(orders, vendorGroups) {
  const times = orders.map(o => o.meal_time).filter(t => /^\d{4}$/.test(t)).sort();
  if (!times.length || !vendorGroups.length) return null;

  const earliest = times[0];
  const travel   = vendorGroups.reduce(
    (s, g) => s + (g.walk_minutes || 0) * 2 + PICKUP_MIN_PER_VENDOR, 0);
  const lead     = travel + PLATING_BUFFER_MIN;

  let mins = Number(earliest.slice(0, 2)) * 60 + Number(earliest.slice(2)) - lead;
  if (mins < 0) mins = 0;
  const hh = String(Math.floor(mins / 60)).padStart(2, '0');
  const mm = String(mins % 60).padStart(2, '0');

  return {
    earliest_meal:  earliest,
    depart_by:      hh + mm,
    travel_minutes: travel,
    plating_buffer: PLATING_BUFFER_MIN,
    lead_minutes:   lead
  };
}

function mealItemKcal(item, mode) {
  return mode === '單點' ? (item.kcal_single || 0) : (item.kcal || 0);
}
function mealItemPrice(item, mode) {
  return mode === '單點' ? (item.price_single || 0) : (item.price_box || 0);
}

// 精力湯熱量
app.get('/api/nutrition/prescription/:id', (req, res) => {
  const rx = db.prepare('SELECT * FROM prescriptions WHERE id=?').get(req.params.id);
  if (!rx) return res.status(404).json({ error: 'Prescription not found' });
  const pm = powderMultFor(req.query.powder_type);
  res.json({ prescription: { id: rx.id, code: rx.code, name: rx.name, formula_type: rx.formula_type },
             ...calcTonicNutrition(rx.id, pm) });
});

// 後台完整菜單（含店家與價格）
app.get('/api/meals/menu', (req, res) => {
  const series = db.prepare(
    `SELECT ms.*, v.name vendor_name, v.branch vendor_branch, v.phone vendor_phone,
            v.walk_minutes, v.order_note
     FROM meal_series ms LEFT JOIN vendors v ON v.id=ms.vendor_id
     WHERE ms.active=1 ORDER BY ms.sort_order, ms.id`
  ).all();
  const itemStmt = db.prepare(
    'SELECT * FROM meal_items WHERE series_id=? AND active=1 ORDER BY sort_order, id'
  );   // SELECT * 已含 photo
  res.json({
    series: series.map(s => ({ ...s, items: itemStmt.all(s.id) })),
    vendors: db.prepare('SELECT * FROM vendors WHERE active=1 ORDER BY id').all()
  });
});

// ── 個案檢視菜單 ──────────────────────────────────────────
// 隱私邊界：這裡明確列出要回傳的欄位，絕不 SELECT *。
// vendor / vendor_item_name / price_* 一律不得出現在回應中。
app.get('/api/meals/menu/case', (req, res) => {
  const rxId = Number(req.query.prescription_id || 0);
  const rx = rxId ? db.prepare('SELECT * FROM prescriptions WHERE id=?').get(rxId) : null;
  if (rxId && !rx) return res.status(404).json({ error: 'Prescription not found' });

  const pm    = powderMultFor(req.query.powder_type);
  const tonic = rx ? calcTonicNutrition(rx.id, pm) : null;
  const prod  = db.prepare('SELECT name, unit FROM products WHERE id=1').get();

  // 明確勾選的「不吃哪幾類」。contraindications 那欄放的是自由備註
  // （「無肉桂粉改薑片」「早餐」），拿它比對關鍵字會漏掉真的過敏
  const avoidList = String((rx && rx.avoid_proteins) || '')
    .split(',').map(x => x.trim()).filter(Boolean);
  const avoidSet = new Set(avoidList);

  const series = db.prepare(
    `SELECT id, name, tagline FROM meal_series WHERE active=1 ORDER BY sort_order, id`
  ).all();
  const itemStmt = db.prepare(
    `SELECT id, protein, display_name, kcal, protein_g, kcal_single, protein_g_single,
            kcal_source, default_mode, COALESCE(photo,'') photo,
            COALESCE(item_type,'餐盒') item_type
     FROM meal_items WHERE series_id=? AND active=1 ORDER BY sort_order, id`
  );

  res.json({
    tonic: {
      name:      prod ? prod.name : '精力湯',
      volume_ml: 250,
      kcal:      tonic ? tonic.kcal : null,
      protein_g: tonic ? tonic.protein_g : null,
      exact:     !!tonic
    },
    // 一盒幾個人分。菜單上要能當場回答「我們兩個人要點幾盒」
    share_ratios: String(rotationSetting('share_ratios', '1:1'))
      .split(',').map(x => x.trim()).filter(Boolean)
      .map(x => { const [p, b] = x.split(':').map(Number); return { people: p || 1, boxes: b || 1 }; }),
    case: rx ? {
      name: rx.name, code: rx.code, formula_type: rx.formula_type,
      avoid: avoidList, note: String(rx.contraindications || '').trim()
    } : null,
    series: series.map(s => ({
      id:      s.id,
      name:    s.name,
      tagline: s.tagline,
      items:   itemStmt.all(s.id).map(it => ({
        id:           it.id,
        protein:      it.protein,
        name:         it.display_name,
        photo:        it.photo || null,
        kcal:         it.kcal,
        kcal_single:  it.kcal_single,
        // 店家沒給就回 null。回 0 的話菜單會寫「蛋白質 0 公克」，
        // 客人會以為那盒真的沒有蛋白質 —— 比不寫還糟
        protein_g:        it.protein_g > 0 ? it.protein_g : null,
        protein_g_single: it.protein_g_single > 0 ? it.protein_g_single : null,
        kcal_unknown:     !(it.kcal > 0),
        // 加菜不是一道主餐。阿北那一家只有 1 道主餐＋1 道加菜，
        // 算成兩道會讓「一家三個選項」那張卡寫錯數字
        item_type:    it.item_type,
        estimated:    it.kcal_source === '內部估算',
        // 這個人不吃這一類。比對的是明確勾選的類別，不是拿備註猜關鍵字
        avoid:        avoidSet.has(it.protein),
        avoid_reason: avoidSet.has(it.protein) ? it.protein : '',
        set_kcal:     tonic && it.kcal > 0 ? Math.round(it.kcal + tonic.kcal) : null,
        set_kcal_single: tonic && it.kcal_single > 0 ? Math.round(it.kcal_single + tonic.kcal) : null
      }))
    }))
  });
});

// ── 今日餐盒出單 + 依店家分組的採購清單 ────────────────────
function buildMealDay(date) {
  const orders = db.prepare(
    `SELECT mo.*, mi.code item_code, mi.display_name, mi.vendor_item_name,
            mi.kcal, mi.kcal_single, mi.price_box, mi.price_single,
            ms.name series_name, ms.id series_id,
            v.id vendor_id, v.name vendor_name, v.branch vendor_branch,
            v.phone vendor_phone, v.walk_minutes,
            co.patient_name case_patient, co.powder_type, co.prescription_id
     FROM meal_orders mo
     JOIN meal_items mi ON mi.id=mo.meal_item_id
     JOIN meal_series ms ON ms.id=mi.series_id
     LEFT JOIN vendors v ON v.id=ms.vendor_id
     LEFT JOIN case_orders co ON co.id=mo.case_order_id
     WHERE mo.date=? ORDER BY mo.meal_time, mo.id`
  ).all(date);

  // 依店家彙總成採購單，同品項同模式合併成一列。
  // 這裡用「菜單上的現價」而不是出單當下的 snap_price：採購單是拿去店裡付錢用的，
  // 要反映今天的牌價。歷史成本走 calcDailyCost，那邊才讀 snap_price。
  const byVendor = {};
  orders.forEach(o => {
    const vid = o.vendor_id || 0;
    if (!byVendor[vid]) {
      byVendor[vid] = {
        vendor_id: vid, vendor: o.vendor_name || '未指定店家',
        branch: o.vendor_branch || '', phone: o.vendor_phone || '',
        walk_minutes: o.walk_minutes || 0, lines: [], total: 0
      };
    }
    const g    = byVendor[vid];
    const key  = o.meal_item_id + '|' + o.purchase_mode;
    const unit = mealItemPrice(o, o.purchase_mode);
    let line   = g.lines.find(l => l.key === key);
    if (!line) {
      line = { key, item: o.vendor_item_name || o.display_name,
               display_name: o.display_name, mode: o.purchase_mode,
               qty: 0, people: 0, unit_price: unit, subtotal: 0,
               all_purchased: true, order_ids: [] };
      g.lines.push(line);
    }
    const boxes = boxesForOrder(o);
    line.qty      += boxes;
    line.people   += Number(o.qty) || 0;
    line.subtotal += unit * boxes;
    line.order_ids.push(o.id);
    if (o.status === '待採購') line.all_purchased = false;
  });
  Object.values(byVendor).forEach(g => { g.total = g.lines.reduce((s, l) => s + l.subtotal, 0); });

  const spent = db.prepare(
    'SELECT COALESCE(SUM(total_price),0) t FROM meal_purchase_log WHERE date=?'
  ).get(date).t;

  const vendorGroups = Object.values(byVendor).sort((a, b) => a.vendor_id - b.vendor_id);

  return {
    date,
    timing: computeDepartBy(orders, vendorGroups),
    orders: orders.map(o => ({
      id: o.id, meal_item_id: o.meal_item_id, item_code: o.item_code,
      display_name: o.display_name, vendor_item_name: o.vendor_item_name,
      series_name: o.series_name, vendor_name: o.vendor_name,
      qty: o.qty, meal_time: o.meal_time,
      patient_name: o.patient_name || o.case_patient || '',
      purchase_mode: o.purchase_mode, status: o.status,
      case_order_id: o.case_order_id, prescription_id: o.prescription_id,
      powder_type: o.powder_type,
      kcal: mealItemKcal(o, o.purchase_mode),
      price: mealItemPrice(o, o.purchase_mode),
      notes: o.notes
    })),
    purchase_lists: vendorGroups,
    planned_total: vendorGroups.reduce((s, g) => s + g.total, 0),
    spent_total:   Math.round(spent * 10) / 10
  };
}

app.get('/api/meals/today', async (req, res) => {
  const date = req.query.date || today();
  try { await syncApptMealOrders(); } catch (err) { console.error('餐盒預約帶入失敗:', err.message); }
  res.json(buildMealDay(date));
});

// 採購用的清單：按店家分組、同款合併數量。
// 出門買便當的人要的不是今日頁那條 3000px 的時間軸，是「去哪幾家、各買什麼」。
// 同一款被三個人點，他要看到的是 ×3，不是三行。
app.get('/api/meals/shopping', (req, res) => {
  const date = req.query.date || today();
  const rows = db.prepare(
    `SELECT o.id, o.qty, o.share_people, o.share_boxes,
            o.meal_time, o.patient_name, o.purchase_mode, o.status, o.notes,
            o.snap_display_name, o.snap_price,
            mi.display_name item_name, mi.vendor_item_name,
            v.id vendor_id, v.name vendor_name, v.branch, v.phone, v.walk_minutes, v.order_note
       FROM meal_orders o
       JOIN meal_items mi ON mi.id = o.meal_item_id
       JOIN meal_series ms ON ms.id = mi.series_id
       JOIN vendors v ON v.id = ms.vendor_id
      WHERE o.date = ?
      ORDER BY v.name, o.meal_time`
  ).all(date);

  const stops = [];
  const byVendor = new Map();
  rows.forEach(r => {
    if (!byVendor.has(r.vendor_id)) {
      const stop = { vendor_id: r.vendor_id, vendor_name: r.vendor_name, branch: r.branch,
                     phone: r.phone, walk_minutes: r.walk_minutes, order_note: r.order_note,
                     lines: [], total_qty: 0, pending_qty: 0, earliest_time: r.meal_time };
      byVendor.set(r.vendor_id, stop); stops.push(stop);
    }
    const stop = byVendor.get(r.vendor_id);
    if (r.meal_time < stop.earliest_time) stop.earliest_time = r.meal_time;
    // 同一款、同一種買法合成一行；點餐時報的是店家的品名
    const key = (r.vendor_item_name || r.item_name) + '|' + r.purchase_mode;
    let ln = stop.lines.find(l => l.key === key);
    if (!ln) {
      ln = { key, order_name: r.vendor_item_name || r.item_name,
             our_name: r.snap_display_name || r.item_name, mode: r.purchase_mode,
             qty: 0, people: 0, share_note: '',
             price_each: r.snap_price, order_ids: [], for_who: [], notes: [], all_bought: true };
      stop.lines.push(ln);
    }
    // 採購的人要買的是「盒」；人數另外標，才知道這幾盒是分給誰
    const boxes = boxesForOrder(r);
    ln.qty    += boxes;
    ln.people += Number(r.qty) || 0;
    if (boxes !== Number(r.qty)) ln.share_note = shareLabel(r);
    ln.order_ids.push(r.id);
    if (r.patient_name) ln.for_who.push(r.patient_name);
    if (r.notes) ln.notes.push(r.notes);
    if (r.status === '待採購') { ln.all_bought = false; stop.pending_qty += boxes; }
    stop.total_qty += boxes;
  });

  // 走路久的先出發
  stops.sort((a, b) => (b.walk_minutes || 0) - (a.walk_minutes || 0));
  res.json({
    date, stops,
    total_qty: stops.reduce((s, v) => s + v.total_qty, 0),
    pending_qty: stops.reduce((s, v) => s + v.pending_qty, 0)
  });
});

// 一次把一行（同款合併後的那些單）標成已採購
app.post('/api/meals/shopping/bought', (req, res) => {
  const ids = Array.isArray(req.body.order_ids) ? req.body.order_ids : [];
  const undo = !!req.body.undo;
  const to = undo ? '待採購' : '已採購';
  const from = undo ? '已採購' : '待採購';
  let n = 0;
  ids.forEach(id => {
    n += db.prepare('UPDATE meal_orders SET status=? WHERE id=? AND status=?').run(to, id, from).changes;
  });
  res.json({ ok: true, changed: n, status: to });
});

app.post('/api/meals/orders', (req, res) => {
  const { meal_item_id, qty, meal_time, patient_name, case_order_id, purchase_mode, notes, date,
          share_people, share_boxes } = req.body;
  const item = db.prepare('SELECT * FROM meal_items WHERE id=?').get(meal_item_id);
  if (!item) return res.status(400).json({ error: '找不到這款餐盒' });

  const mode = purchase_mode === '單點' ? '單點' : '餐盒';
  const r = db.prepare(
    `INSERT INTO meal_orders
       (date,meal_item_id,qty,meal_time,patient_name,case_order_id,purchase_mode,
        snap_display_name,snap_kcal,snap_price,notes,share_people,share_boxes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    date || today(), meal_item_id, qty || 1, meal_time || '1330',
    patient_name || '', case_order_id || null, mode,
    item.display_name, mealItemKcal(item, mode), mealItemPrice(item, mode), notes || '',
    Math.max(1, Number(share_people) || 1), Math.max(1, Number(share_boxes) || 1)
  );
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/meals/orders/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM meal_orders WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '找不到這筆出單' });
  const { qty, meal_time, patient_name, purchase_mode, status, notes, case_order_id,
          share_people, share_boxes } = req.body;
  const mode = purchase_mode === '單點' ? '單點' : (purchase_mode === '餐盒' ? '餐盒' : cur.purchase_mode);

  // 換了採購模式，價格與熱量快照要跟著換
  let snapKcal = cur.snap_kcal, snapPrice = cur.snap_price;
  if (mode !== cur.purchase_mode) {
    const item = db.prepare('SELECT * FROM meal_items WHERE id=?').get(cur.meal_item_id);
    if (item) { snapKcal = mealItemKcal(item, mode); snapPrice = mealItemPrice(item, mode); }
  }

  db.prepare(
    `UPDATE meal_orders SET qty=?, meal_time=?, patient_name=?, purchase_mode=?,
            status=?, notes=?, case_order_id=?, snap_kcal=?, snap_price=?,
            share_people=?, share_boxes=? WHERE id=?`
  ).run(
    qty ?? cur.qty, meal_time || cur.meal_time,
    patient_name ?? cur.patient_name, mode,
    status || cur.status, notes ?? cur.notes,
    case_order_id === undefined ? cur.case_order_id : (case_order_id || null),
    snapKcal, snapPrice,
    share_people === undefined ? cur.share_people : Math.max(1, Number(share_people) || 1),
    share_boxes  === undefined ? cur.share_boxes  : Math.max(1, Number(share_boxes)  || 1),
    req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/meals/orders/:id', (req, res) => {
  const row = db.prepare('SELECT source_key FROM meal_orders WHERE id=?').get(req.params.id);
  tx(() => {
    // 預約帶入的單被刪掉就記下來，之後同步不再重建
    if (row && row.source_key) {
      db.prepare('INSERT OR IGNORE INTO meal_sync_dismissed (source_key) VALUES (?)').run(row.source_key);
    }
    db.prepare('DELETE FROM meal_orders WHERE id=?').run(req.params.id);
  });
  res.json({ ok: true });
});

// 採購回填：記下實付金額，並把對應出單轉為「已採購」。
// 兩種用法：
//   單品項 → 帶 meal_item_id / qty
//   整間店 → 帶 lines[]，一張收據一個總額，這裡按預計金額比例拆回各品項，
//            差額算在最後一列，讓每品項成本仍可分析、總額又和收據一致
app.post('/api/meals/purchase', (req, res) => {
  const { date, meal_item_id, qty, total_price, purchase_mode, order_ids, note, lines } = req.body;
  const d     = date || today();
  const total = Number(total_price) || 0;

  tx(() => {
    const ins = db.prepare(
      `INSERT INTO meal_purchase_log (date,meal_item_id,qty,total_price,purchase_mode,user_id,note)
       VALUES (?,?,?,?,?,?,?)`
    );

    if (Array.isArray(lines) && lines.length) {
      const plannedSum = lines.reduce((s, l) => s + (Number(l.planned) || 0), 0);
      let allocated = 0;
      lines.forEach((l, idx) => {
        const isLast = idx === lines.length - 1;
        const share  = isLast
          ? Math.round((total - allocated) * 10) / 10
          : (plannedSum > 0
              ? Math.round(total * (Number(l.planned) || 0) / plannedSum * 10) / 10
              : Math.round(total / lines.length * 10) / 10);
        allocated += share;
        ins.run(d, l.meal_item_id || null, l.qty || 1, share,
                l.purchase_mode || '餐盒', req.kitchenUser.id, note || '');
      });
    } else {
      ins.run(d, meal_item_id || null, qty || 1, total,
              purchase_mode || '餐盒', req.kitchenUser.id, note || '');
    }

    (order_ids || []).forEach(id => {
      db.prepare("UPDATE meal_orders SET status='已採購' WHERE id=? AND status='待採購'").run(id);
    });
  });
  res.json({ ok: true });
});

app.get('/api/meals/purchases', (req, res) => {
  const month = (req.query.month || today().slice(0, 7)).slice(0, 7);
  res.json(db.prepare(
    `SELECT mp.*, mi.display_name, u.name user_name
     FROM meal_purchase_log mp
     LEFT JOIN meal_items mi ON mi.id=mp.meal_item_id
     LEFT JOIN users u ON u.id=mp.user_id
     WHERE mp.date LIKE ? ORDER BY mp.date DESC, mp.id DESC`
  ).all(`${month}-%`));
});

app.delete('/api/meals/purchases/:id', (req, res) => {
  db.prepare('DELETE FROM meal_purchase_log WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// 品項維護
app.put('/api/meals/items/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM meal_items WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '找不到這款餐盒' });
  const b = req.body;
  db.prepare(
    `UPDATE meal_items SET display_name=?, vendor_item_name=?, kcal=?, protein_g=?,
            kcal_single=?, protein_g_single=?, price_single=?, price_box=?,
            kcal_source=?, nutrition_as_of=?, default_mode=?, active=?, photo=? WHERE id=?`
  ).run(
    b.display_name ?? cur.display_name, b.vendor_item_name ?? cur.vendor_item_name,
    b.kcal ?? cur.kcal, b.protein_g ?? cur.protein_g,
    b.kcal_single ?? cur.kcal_single, b.protein_g_single ?? cur.protein_g_single,
    b.price_single ?? cur.price_single, b.price_box ?? cur.price_box,
    b.kcal_source ?? cur.kcal_source, b.nutrition_as_of ?? cur.nutrition_as_of,
    b.default_mode ?? cur.default_mode,
    b.active === undefined ? cur.active : (b.active ? 1 : 0),
    // 換照片不該需要改程式重新部署
    b.photo ?? cur.photo ?? '',
    req.params.id
  );
  res.json({ ok: true });
});

// ── 同事訂閱 ──────────────────────────────────────────────

// 一輪的概況：日期範圍、取餐日、休診扣掉幾天、每個人的杯數帳
function cycleSummary(cycleStart) {
  const weeks = Number(rotationSetting('rotation_weeks', '2')) || 2;
  const cycleEnd = addDays(cycleStart, weeks * 7 - 1);
  const dows = parseDows(rotationSetting('subscription_dows', '1,3,5'), [1, 3, 5]);
  const closures = closuresBetween(cycleStart, cycleEnd)
    .filter(c => dows.includes(dowOf(c.date)));

  const subs = db.prepare(
    `SELECT ss.*, u.name user_name, p.code rx_code, p.name rx_name, p.is_staff_rx
       FROM staff_subscriptions ss
       JOIN users u ON u.id = ss.user_id
       JOIN prescriptions p ON p.id = ss.prescription_id
      WHERE ss.cycle_start = ? ORDER BY u.id`
  ).all(cycleStart);

  const pickStmt = db.prepare(
    `SELECT sp.date, sp.status, sp.picked_by_user_id, sp.marked_by, sp.marked_at,
            u.name picked_by_name
       FROM subscription_pickups sp
       LEFT JOIN users u ON u.id = sp.picked_by_user_id
      WHERE sp.subscription_id = ? ORDER BY sp.date`);

  return {
    cycle_start: cycleStart, cycle_end: cycleEnd, cycle_weeks: weeks,
    pickup_dows: dows,
    // 休診扣掉的取餐日。畫面上要看得到為什麼 6 杯變 5 杯
    closed_pickup_days: closures,
    subscriptions: subs.map(ss => {
      const picks = pickStmt.all(ss.id);
      const picked = picks.filter(p => p.status === 'picked').length;
      const missed = picks.filter(p => p.status === 'missed').length;
      // 讓杯：實際喝的人不是訂的人
      const shared = picks.filter(
        p => p.status === 'picked' && p.picked_by_user_id && p.picked_by_user_id !== ss.user_id);
      return {
        ...ss,
        charge: Math.round(ss.entitled_cups * ss.unit_price),
        picked, missed,
        remaining: Math.max(0, ss.entitled_cups - picked - missed),
        shared_cups: shared.length,
        pickups: picks
      };
    })
  };
}

app.get('/api/subscriptions', (req, res) => {
  const cs = req.query.cycle_start || cycleStartFor(req.query.date || today());
  const weeks = Number(rotationSetting('rotation_weeks', '2')) || 2;
  res.json({
    ...cycleSummary(cs),
    prev_cycle: addDays(cs, -weeks * 7),
    next_cycle: addDays(cs,  weeks * 7),
    unit_price_default: Number(rotationSetting('subscription_price', '150')) || 150
  });
});

// 開一輪訂閱。杯數在這裡算出來就凍住 —— 以後休診日被補上，
// 已經收過錢的這一輪不會跟著變
app.post('/api/subscriptions', (req, res) => {
  const userId = Number(req.body.user_id || 0);
  const rxId   = Number(req.body.prescription_id || 0);
  const user = db.prepare('SELECT id, name FROM users WHERE id=?').get(userId);
  if (!user) return res.status(400).json({ error: '找不到這個人' });
  const rx = db.prepare('SELECT id, code, name FROM prescriptions WHERE id=? AND active=1').get(rxId);
  if (!rx) return res.status(400).json({ error: '找不到這張配方' });

  const weeks = Number(rotationSetting('rotation_weeks', '2')) || 2;
  const cs = req.body.cycle_start || cycleStartFor(today());
  const dows = parseDows(req.body.pickup_dows
    || rotationSetting('subscription_dows', '1,3,5'), [1, 3, 5]);
  const dates = cycleDates(cs, weeks, dows);
  if (!dates.length)
    return res.status(400).json({ error: '這一輪沒有任何取餐日（可能全部被標成休診）' });

  const price = Number(req.body.unit_price);
  const unitPrice = Number.isFinite(price) && price >= 0
    ? price : (Number(rotationSetting('subscription_price', '150')) || 150);

  try {
    let id;
    tx(() => {
      const r = db.prepare(
        `INSERT INTO staff_subscriptions
           (user_id, prescription_id, cycle_start, cycle_weeks, pickup_dows,
            powder_type, unit_price, entitled_cups, note, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(userId, rxId, cs, weeks, dows.join(','),
            String(req.body.powder_type || '內用'), unitPrice, dates.length,
            String(req.body.note || '').trim(), req.kitchenUser.name);
      id = r.lastInsertRowid;
      // 一杯一列先建好。這樣「訂了幾杯、少掉幾杯」從第一天就查得到，
      // 不必靠事後回推
      const ins = db.prepare(
        'INSERT INTO subscription_pickups (subscription_id, date, status) VALUES (?,?,?)');
      dates.forEach(d => ins.run(id, d, 'pending'));
    });
    res.json({ id, cycle_start: cs, entitled_cups: dates.length,
               unit_price: unitPrice, charge: Math.round(dates.length * unitPrice),
               dates });
  } catch (e) {
    if (String(e.message).includes('UNIQUE'))
      return res.status(400).json({ error: user.name + ' 這一輪已經訂過了' });
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/subscriptions/:id', (req, res) => {
  const id = Number(req.params.id);
  // 已經有人喝掉的杯子不能整輪刪掉 —— 那是已經發生的事，刪了帳就對不起來。
  // 要停訂請停用（active=0），杯數帳留著
  const used = db.prepare(
    "SELECT COUNT(*) c FROM subscription_pickups WHERE subscription_id=? AND status<>'pending'"
  ).get(id).c;
  if (used > 0)
    return res.status(400).json({
      error: '這一輪已經有 ' + used + ' 杯有紀錄了，不能刪。要停訂請改成停用，帳要留著' });
  tx(() => {
    db.prepare('DELETE FROM subscription_pickups WHERE subscription_id=?').run(id);
    db.prepare('DELETE FROM staff_subscriptions WHERE id=?').run(id);
  });
  res.json({ ok: true });
});

app.put('/api/subscriptions/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM staff_subscriptions WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '找不到這一輪訂閱' });
  db.prepare('UPDATE staff_subscriptions SET active=?, note=? WHERE id=?')
    .run(req.body.active === undefined ? cur.active : (req.body.active ? 1 : 0),
         req.body.note === undefined ? cur.note : String(req.body.note).trim(),
         req.params.id);
  res.json({ ok: true });
});

// 標記某一杯：誰喝掉了，或沒人喝。
//
// picked_by 可以不是訂的人 —— 原訂的人把權利讓給別人。權利與付費還是
// 訂的人的，所以兩個欄位分開記，兩邊都查得到。
app.put('/api/subscriptions/:id/pickup', (req, res) => {
  const subId = Number(req.params.id);
  const date  = String(req.body.date || '').trim();
  const status = String(req.body.status || 'picked');
  if (!['picked', 'missed', 'pending'].includes(status))
    return res.status(400).json({ error: 'status 只能是 picked / missed / pending' });
  const ss = db.prepare(
    `SELECT ss.*, p.avoid_proteins, p.contraindications, p.code rx_code
       FROM staff_subscriptions ss JOIN prescriptions p ON p.id=ss.prescription_id
      WHERE ss.id=?`).get(subId);
  if (!ss) return res.status(404).json({ error: '找不到這一輪訂閱' });
  const row = db.prepare(
    'SELECT 1 FROM subscription_pickups WHERE subscription_id=? AND date=?').get(subId, date);
  if (!row) return res.status(400).json({ error: date + ' 不是這一輪的取餐日' });

  const byId = req.body.picked_by_user_id == null || req.body.picked_by_user_id === ''
    ? (status === 'picked' ? ss.user_id : null)
    : Number(req.body.picked_by_user_id);

  // 讓杯的人跟原訂的人配方不一樣時，比對他自己的禁忌。
  // 警告但不擋 —— 擋掉會攔到人家根本不在意的情況，但不講就真的會出事：
  // 代領的人喝到的是「別人的配方」，不是他自己那張
  let warning = '';
  if (status === 'picked' && byId && byId !== ss.user_id) {
    const taker = db.prepare(
      `SELECT u.name, p.code rx_code, COALESCE(p.avoid_proteins,'') avoid
         FROM users u LEFT JOIN prescriptions p
           ON p.id = (SELECT id FROM prescriptions
                       WHERE active=1 AND is_staff_rx=0 AND name = u.name LIMIT 1)
        WHERE u.id=?`).get(byId);
    const avoid = String((taker && taker.avoid) || '').split(',').map(x => x.trim()).filter(Boolean);
    if (avoid.length)
      warning = (taker.name || '代領的人') + ' 不吃 ' + avoid.join('、')
              + '，而這杯是 ' + ss.rx_code + ' 的配方 —— 請確認內容沒有衝突';
    else if (taker && taker.rx_code && taker.rx_code !== ss.rx_code)
      warning = (taker.name || '代領的人') + ' 自己的配方是 ' + taker.rx_code
              + '，這杯是 ' + ss.rx_code + '，內容不一樣';
  }

  db.prepare(
    `UPDATE subscription_pickups
        SET status=?, picked_by_user_id=?, marked_by=?, marked_at=datetime('now','localtime')
      WHERE subscription_id=? AND date=?`
  ).run(status, byId, req.kitchenUser.name, subId, date);
  res.json({ ok: true, warning });
});

// ── 休診日 ────────────────────────────────────────────────
// 廚房哪天不開工。杯數、預估、盤點日、訂閱扣杯都讀這張表
app.get('/api/closures', (req, res) => {
  const from = req.query.from || addDays(today(), -30);
  const to   = req.query.to   || addDays(today(), 180);
  res.json({
    from, to,
    closures: db.prepare(
      `SELECT date, reason, created_by, created_at FROM kitchen_closures
        WHERE date>=? AND date<=? ORDER BY date`
    ).all(from, to)
  });
});

app.post('/api/closures', (req, res) => {
  const date = String(req.body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: '日期格式要是 YYYY-MM-DD' });
  // 已經收過錢的訂閱輪不能被事後改掉杯數 —— 建立訂閱時就把杯數凍住了，
  // 所以這裡只擋「已經過去的日子」，避免有人回頭標假日想改歷史
  if (date < today())
    return res.status(400).json({ error: '不能把已經過去的日子標成休診（那天做了什麼已經記在帳上了）' });
  db.prepare(
    `INSERT INTO kitchen_closures (date, reason, created_by) VALUES (?,?,?)
       ON CONFLICT(date) DO UPDATE SET reason=excluded.reason`
  ).run(date, String(req.body.reason || '').trim(), req.kitchenUser.name);
  res.json({ ok: true, date });
});

app.delete('/api/closures/:date', (req, res) => {
  db.prepare('DELETE FROM kitchen_closures WHERE date=?').run(req.params.date);
  res.json({ ok: true });
});

// ── 隨餐營養衛教小卡 ──────────────────────────────────────
function cardRows() {
  return db.prepare(
    `SELECT nc.*,
            CASE WHEN nc.subject_type='meal_item' THEN mi.display_name ELSE p.name END AS subject_name,
            -- 換店家後舊小卡會留在這裡。標出來，覆核清單才不會要人審已經不出的菜
            CASE WHEN nc.subject_type='meal_item' AND COALESCE(mi.active,1)=0 THEN 1 ELSE 0 END AS retired,
            mi.kcal item_kcal, mi.protein_g item_protein_g,
            ms.name series_name
     FROM nutrition_cards nc
     LEFT JOIN meal_items mi  ON nc.subject_type='meal_item' AND mi.id=nc.subject_id
     LEFT JOIN meal_series ms ON ms.id=mi.series_id
     LEFT JOIN products p     ON nc.subject_type='product' AND p.id=nc.subject_id
     ORDER BY nc.subject_type DESC, ms.sort_order, mi.sort_order`
  ).all().map(c => ({
    ...c,
    // 換了菜卻沒改小卡，就是這裡會抓到的。2026-04 樂芙雞胸換雞腿那次沒人發現
    number_issues: cardNumberIssues(
      [c.headline, c.ratio_line, c.story].join(' '),
      c.subject_type === 'meal_item' ? { kcal: c.item_kcal, protein_g: c.item_protein_g } : null)
  }));
}

app.get('/api/meals/cards', (req, res) => {
  res.json({ cards: cardRows() });
});

app.put('/api/meals/cards/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM nutrition_cards WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '找不到這張小卡' });
  const b = req.body;
  // 覆核是明確的動作：改了文案就把覆核狀態清掉，避免舊簽核蓋到新文字
  const textChanged =
    (b.headline !== undefined && b.headline !== cur.headline) ||
    (b.ratio_line !== undefined && b.ratio_line !== cur.ratio_line) ||
    (b.story !== undefined && b.story !== cur.story);

  let reviewedBy = cur.reviewed_by, reviewedAt = cur.reviewed_at;
  if (b.review === true)  { reviewedBy = req.kitchenUser.name; reviewedAt = today(); }
  if (b.review === false) { reviewedBy = ''; reviewedAt = ''; }
  if (textChanged && b.review === undefined) { reviewedBy = ''; reviewedAt = ''; }

  db.prepare(
    `UPDATE nutrition_cards SET headline=?, ratio_line=?, story=?, reviewed_by=?, reviewed_at=?,
            updated_at=datetime('now','localtime') WHERE id=?`
  ).run(
    b.headline ?? cur.headline, b.ratio_line ?? cur.ratio_line, b.story ?? cur.story,
    reviewedBy, reviewedAt, req.params.id
  );
  res.json({ ok: true });
});

// 今日要印哪幾張小卡：由當日出單決定
app.get('/api/meals/cards/today', (req, res) => {
  const date = req.query.date || today();
  const day  = buildMealDay(date);
  const all  = cardRows();
  const byItem = {};
  all.filter(c => c.subject_type === 'meal_item').forEach(c => { byItem[c.subject_id] = c; });
  const tonicCard = all.find(c => c.subject_type === 'product');

  const out = [];
  day.orders.forEach(o => {
    const card = byItem[o.meal_item_id];
    const tonic = o.prescription_id
      ? calcTonicNutrition(o.prescription_id, powderMultFor(o.powder_type))
      : null;
    for (let i = 0; i < o.qty; i++) {
      out.push({
        order_id: o.id, patient_name: o.patient_name, meal_time: o.meal_time,
        meal: card || null, meal_name: o.display_name,
        meal_kcal: o.kcal, purchase_mode: o.purchase_mode,
        tonic: tonicCard || null,
        tonic_kcal: tonic ? tonic.kcal : null,
        tonic_protein_g: tonic ? tonic.protein_g : null,
        set_kcal: tonic ? Math.round(o.kcal + tonic.kcal) : null,
        printable: !!(card && card.reviewed_at) && !!(tonicCard && tonicCard.reviewed_at)
      });
    }
  });

  const blocked = out.filter(c => !c.printable).length;
  res.json({ date, cards: out, blocked_count: blocked });
});

// ── 預約系統帶入餐盒 ──────────────────────────────────────
// 比對預約項目文字與菜單品名，命中才建單。沒有猜測未知字串。
async function syncApptMealOrders() {
  let appts;
  try { appts = await fetchAppts(); } catch (err) { return { created: 0, error: err.message }; }

  const items = db.prepare(
    'SELECT id, code, display_name, vendor_item_name, kcal, kcal_single, price_box, price_single, default_mode FROM meal_items WHERE active=1'
  ).all();
  if (!items.length) return { created: 0 };

  const byName = {};
  items.forEach(it => {
    [it.display_name, it.vendor_item_name, it.code].forEach(n => {
      if (n) byName[String(n).trim()] = it;
    });
  });

  const from = today();
  const to   = new Date(Date.now() + SYNC_AHEAD_DAYS * 86400000).toISOString().slice(0, 10);
  const dismissed = new Set(
    db.prepare('SELECT source_key FROM meal_sync_dismissed').all().map(r => r.source_key)
  );

  const ins = db.prepare(
    `INSERT OR IGNORE INTO meal_orders
       (date,meal_item_id,qty,meal_time,patient_name,purchase_mode,
        snap_display_name,snap_kcal,snap_price,notes,source_key)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );

  let created = 0;
  Object.keys(appts || {}).forEach(date => {
    if (date < from || date > to) return;
    const raw  = appts[date];
    const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
    list.forEach(a => {
      if (!a || typeof a !== 'object' || !a.id) return;
      (a.items || []).forEach(itemText => {
        const item = byName[String(itemText || '').trim()];
        if (!item) return;
        const key = 'appt-meal:' + a.id + ':' + item.code;
        if (dismissed.has(key)) return;
        const mode = item.default_mode === '單點' ? '單點' : '餐盒';
        const r = ins.run(
          date, item.id, 1, apptTimeToMeal(a.start), String(a.name || '').trim(), mode,
          item.display_name, mealItemKcal(item, mode), mealItemPrice(item, mode),
          '[預約帶入]', key
        );
        if (r.changes) created++;
      });
    });
  });
  if (created) console.log('餐盒預約帶入：新建 ' + created + ' 筆出單');
  return { created };
}

// ════════════════════════════════════════════════════════
// 啟動
// ════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`診所廚房系統運行中 → http://localhost:${PORT}`);
});
