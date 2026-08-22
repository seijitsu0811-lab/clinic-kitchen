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
// 採購歷史合併與重置為 2026-06-20 (一次性遷移)
try {
  const hasOldLogs = db.prepare("SELECT 1 FROM purchase_log WHERE purchased_at='2026-06-01' LIMIT 1").get();
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
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
try { db.exec("ALTER TABLE users ADD COLUMN password TEXT DEFAULT ''"); } catch(e) {}
if (KITCHEN_PASSWORD) {
  try {
    db.prepare("UPDATE users SET password=? WHERE name='John'").run(KITCHEN_PASSWORD);
  } catch(e) {}
}

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
].forEach(sql => { try { db.exec(sql); } catch(e) {} });
db.exec("UPDATE prescriptions SET is_staff_rx=1 WHERE code='EMP-00'");
db.exec("UPDATE prescriptions SET product_id=1 WHERE product_id IS NULL");

// ── 食材資料整理（idempotent）───────────────────────────
[
  // 重新命名
  "UPDATE ingredients SET name='蘋果(帶皮)' WHERE name='蘋果'",
  "UPDATE ingredients SET name='蘋果(純皮)' WHERE name='蘋果(去皮)'",
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
  "UPDATE ingredients SET count_unit='顆', count_ratio=220 WHERE name='蘋果(帶皮)'",
  "UPDATE ingredients SET count_unit='顆', count_ratio=80  WHERE name='檸檬'",
].forEach(sql => { try { db.exec(sql); } catch(e) {} });

// 清除重複食材：暫停 FK 檢查，安全地搬移再刪除
db.exec('PRAGMA foreign_keys = OFF');
[
  ['蘋果',       '蘋果(帶皮)'],
  ['蘋果(去皮)', '蘋果(純皮)'],
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

// 新增食材（不存在才加）
[
  ['蘋果(純皮)', 'g',  '水果', 21],
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
  ['蘋果(帶皮)',20],['蘋果(純皮)',21],['檸檬',22],['莓果',23],['奇異果',24],['香蕉',25],['木瓜',26],['鳳梨',27],
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

// ── 食材營養密度（每 1 單位；油品的單位是 ml）──────────────
[
  ['芽菜',       0.23,  0.040, 'USDA'],
  ['羽衣甘藍',   0.35,  0.029, 'USDA'],
  ['貝比生菜',   0.20,  0.020, 'USDA'],
  ['小麥草',     0.21,  0.021, 'USDA'],
  ['胡蘿蔔',     0.41,  0.009, 'USDA'],
  ['甜菜根',     0.43,  0.016, 'USDA'],
  ['蘋果(帶皮)', 0.52,  0.003, 'USDA'],
  ['蘋果(純皮)', 0.57,  0.004, 'USDA'],
  ['檸檬',       0.29,  0.011, 'USDA'],
  ['莓果',       0.50,  0.008, 'USDA'],
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

async function fetchAppts() {
  const now = Date.now();
  if (_apptCache.data && now - _apptCache.at < 120000) return _apptCache.data;   // 快取 2 分鐘
  const r = await fetch(APPTS_URL, { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  _apptCache = { at: now, data: j || {} };
  return _apptCache.data;
}

// '09:30' → '0930'；取不到就用預設用餐時間
function apptTimeToMeal(t) {
  const m = String(t || '').match(/(\d{1,2}):(\d{2})/);
  return m ? String(m[1]).padStart(2, '0') + m[2] : '1330';
}

async function syncApptOrders() {
  let appts;
  try {
    appts = await fetchAppts();
  } catch (err) {
    console.error('讀取預約系統失敗:', err.message);
    return { created: 0, error: err.message };
  }

  const from = today();
  const to   = new Date(Date.now() + SYNC_AHEAD_DAYS * 86400000).toISOString().slice(0, 10);

  // 患者姓名 → 自己的處方（個案處方，不含員工標準）
  const rxByName = {};
  db.prepare("SELECT id,name FROM prescriptions WHERE active=1 AND is_staff_rx=0").all()
    .forEach(r => { if (r.name) rxByName[String(r.name).trim()] = r.id; });
  // 沒有自己處方的患者，先掛員工標準配方並在備註標明，讓廚房人員確認
  const emp = db.prepare("SELECT id FROM prescriptions WHERE code='EMP-00'").get();
  const fallbackId = emp ? emp.id : 1;

  // 已被廚房人員刪掉的，不再重建
  const dismissed = new Set(
    db.prepare('SELECT source_key FROM appt_sync_dismissed').all().map(r => r.source_key)
  );

  const ins = db.prepare(
    `INSERT OR IGNORE INTO case_orders
       (date,prescription_id,cups,meal_time,powder_type,patient_name,notes,source_key)
     VALUES (?,?,?,?,?,?,?,?)`
  );

  let created = 0, skipped = 0;
  Object.keys(appts || {}).forEach(date => {
    if (date < from || date > to) return;
    const raw = appts[date];
    const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
    list.forEach(a => {
      if (!a || typeof a !== 'object' || !a.id) return;
      (a.items || []).forEach(item => {
        const powder = APPT_ITEM_MAP[item];
        if (!powder) return;
        if (dismissed.has('appt:' + a.id + ':' + powder)) return;
        const name = String(a.name || '').trim();
        const rxId = rxByName[name];
        const note = rxId
          ? '[預約帶入]'
          : '[預約帶入] 此患者尚未建立處方，暫用員工標準配方，請確認';
        const r = ins.run(
          date, rxId || fallbackId, 1, apptTimeToMeal(a.start),
          powder, name, note, 'appt:' + a.id + ':' + powder
        );
        if (r.changes) created++; else skipped++;
      });
    });
  });
  if (created) console.log('預約帶入：新建 ' + created + ' 筆出單（已存在 ' + skipped + ' 筆略過）');
  return { created, skipped };
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
function unitCost(ingredientId) {
  const r = db.prepare(
    `SELECT SUM(qty) as tq, SUM(total_price) as tp
     FROM purchase_log WHERE ingredient_id=?`
  ).get(ingredientId);
  if (!r || !r.tq || r.tq === 0) return 0;
  return r.tp / r.tq;
}

// 所有食材加權均價一次撈完（避免 N+1）
function buildUnitCostCache() {
  const rows = db.prepare(
    `SELECT ingredient_id, SUM(total_price) as tp, SUM(qty) as tq
     FROM purchase_log GROUP BY ingredient_id`
  ).all();
  const cache = {};
  rows.forEach(r => { cache[r.ingredient_id] = r.tq > 0 ? r.tp / r.tq : 0; });
  return cache;
}

// 計算某日各產品實際成本（員工批次 + 個案）
function calcDailyCost(date, ucCache, laborCostPerCup) {
  const products = db.prepare(
    'SELECT * FROM products WHERE active=1 ORDER BY sort_order, id'
  ).all();
  const attendingCount = db.prepare(
    'SELECT COUNT(*) as c FROM staff_attendance WHERE date=? AND attending=1'
  ).get(date)?.c || 0;

  const productCosts = [];
  let grandTotal = 0;

  for (const prod of products) {
    let ingCost = 0, staffCups = 0, caseCups = 0;

    // 員工批次
    const staffRx = db.prepare(
      'SELECT id FROM prescriptions WHERE product_id=? AND is_staff_rx=1 AND active=1 LIMIT 1'
    ).get(prod.id);
    if (staffRx && attendingCount > 0) {
      staffCups = attendingCount;
      db.prepare(
        'SELECT ingredient_id, qty_per_cup FROM prescription_ingredients WHERE prescription_id=?'
      ).all(staffRx.id).forEach(ri => {
        ingCost += ri.qty_per_cup * staffCups * (ucCache[ri.ingredient_id] || 0);
      });
    }

    // 個案出單
    db.prepare(
      `SELECT co.cups, co.prescription_id FROM case_orders co
       JOIN prescriptions p ON p.id=co.prescription_id
       WHERE co.date=? AND p.product_id=?`
    ).all(date, prod.id).forEach(o => {
      caseCups += o.cups;
      db.prepare(
        'SELECT ingredient_id, qty_per_cup FROM prescription_ingredients WHERE prescription_id=?'
      ).all(o.prescription_id).forEach(ri => {
        ingCost += ri.qty_per_cup * o.cups * (ucCache[ri.ingredient_id] || 0);
      });
    });

    const totalCups = staffCups + caseCups;
    if (totalCups > 0) {
      const laborCost = totalCups * laborCostPerCup;
      const total = ingCost + laborCost;
      grandTotal += total;
      productCosts.push({
        product_id:      prod.id,
        product_name:    prod.name,
        product_unit:    prod.unit,
        staff_cups:      staffCups,
        case_cups:       caseCups,
        total_cups:      totalCups,
        ingredient_cost: Math.round(ingCost * 10) / 10,
        labor_cost:      Math.round(laborCost * 10) / 10,
        total_cost:      Math.round(total * 10) / 10,
        cost_per_cup:    Math.round(total / totalCups * 10) / 10
      });
    }
  }

  // 餐盒是外購品，成本不走食材加權平均，直接看實付金額。
  // 還沒回填採購的日子先用出單快照價當預估，並標明來源。
  let mealCost = { count: 0, planned: 0, actual: 0, basis: 'none', total: 0 };
  try {
    const planned = db.prepare(
      'SELECT COALESCE(SUM(snap_price*qty),0) p, COALESCE(SUM(qty),0) c FROM meal_orders WHERE date=?'
    ).get(date);
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

app.post('/api/log', (req, res) => {
  const { user_id, action, detail } = req.body;
  db.prepare('INSERT INTO user_logs (user_id,action,detail) VALUES (?,?,?)')
    .run(user_id||null, action||'', detail||'');
  res.json({ ok: true });
});

app.get('/api/logs', (req, res) => {
  const rows = db.prepare(
    `SELECT l.*, u.name as user_name FROM user_logs l
     LEFT JOIN users u ON u.id=l.user_id
     ORDER BY l.ts DESC LIMIT 100`
  ).all();
  res.json(rows);
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
function buildPrepAndPowder(rxId, multiplier, unit, powderMultiplier) {
  powderMultiplier = powderMultiplier || 1.0;
  const allItems = db.prepare(
    `SELECT pi.qty_per_cup, i.name, i.unit, i.category FROM prescription_ingredients pi
     JOIN ingredients i ON i.id=pi.ingredient_id
     WHERE pi.prescription_id=? AND pi.qty_per_cup>0 ORDER BY i.sort_order, i.category, i.name`
  ).all(rxId);
  // prep = 鮮食（蔬菜/水果/油/水/其他）
  const freshCats = new Set(['蔬菜', '水果', '油水', '油', '水', '其他']);
  const prep = allItems.filter(r => freshCats.has(r.category)).map(r => ({
    name: r.name, unit: r.unit, category: r.category,
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

  // 1. Fetch leaves from Firebase clinic system
  const leavesSet = new Set();
  const leavesToday = [];
  try {
    const response = await fetch('https://clinic-system-1224f-default-rtdb.asia-southeast1.firebasedatabase.app/clinic_v3/leaves.json', { signal: AbortSignal.timeout(3000) });
    const leavesList = await response.json();
    if (Array.isArray(leavesList)) {
      leavesList.forEach(l => {
        if (l && l.date === date && l.name) {
          leavesSet.add(l.name);
          leavesToday.push(l.name);
        }
      });
    }
  } catch (err) {
    console.error('Failed to fetch leaves from clinic system:', err.message);
  }

  // 2. Check if it's Tuesday, Thursday, or Friday (2, 4, 5)
  const dow = new Date(date).getDay(); // Sunday=0, Monday=1, Tuesday=2, Wednesday=3, Thursday=4, Friday=5, Saturday=6
  const isMealDay = [2, 4, 5].includes(dow);

  // 3. Initialize attendance table
  const users = db.prepare('SELECT * FROM users').all();
  users.forEach(u => {
    const exists = db.prepare('SELECT 1 FROM staff_attendance WHERE date=? AND user_id=?').get(date, u.id);
    if (!exists) {
      const isOnLeave = leavesSet.has(u.name);
      const defaultAttending = (isMealDay && !isOnLeave) ? 1 : 0;
      db.prepare(
        `INSERT INTO staff_attendance (date,user_id,attending,meal_time) VALUES (?,?,?, '1330')`
      ).run(date, u.id, defaultAttending);
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
    const staffRx = db.prepare(
      `SELECT * FROM prescriptions WHERE product_id=? AND is_staff_rx=1 AND active=1 LIMIT 1`
    ).get(prod.id);

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
      const { prep, powder } = buildPrepAndPowder(staffRx.id, totalStaffCups, prod.unit);
      staffPrep = prep;
      const powderBatches = batches.map(b => ({
        label: `${b.size}${prod.unit}批 ×${b.count}`,
        per_batch: Math.round(powder.per_serving * b.size * 10) / 10,
        count: b.count
      }));
      staffPowder = { ...powder, batches: powderBatches };
    }

    const casesWithPrep = cases.map(c => {
      const pm = (c.powder_type === '罐裝' || c.powder_type === '全配方') ? 1.1 : 1.0;
      const { prep, powder, supplements } = buildPrepAndPowder(c.prescription_id, c.cups, prod.unit, pm);
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
      const pm = (c.powder_type === '罐裝' || c.powder_type === '全配方') ? 1.1 : 1.0;
      const { prep, powder, supplements } = buildPrepAndPowder(c.prescription_id, c.cups, prod.unit, pm);
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

  res.json({ date, staff, attending_count: attendingCount, products: productData, leaves: leavesToday, is_meal_day: isMealDay, meals: buildMealDay(date) });
});

// 更新員工出席
app.put('/api/today/attendance/:userId', (req, res) => {
  const { attending, meal_time } = req.body;
  const date = today();
  db.prepare(
    `INSERT INTO staff_attendance (date,user_id,attending,meal_time) VALUES (?,?,?,?)
     ON CONFLICT(date,user_id) DO UPDATE SET attending=excluded.attending, meal_time=excluded.meal_time`
  ).run(date, req.params.userId, attending ? 1 : 0, meal_time || '1330');
  res.json({ ok: true });
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
  const { cups, meal_time, powder_type, patient_name, notes, date } = req.body;
  const orderDate = date || today();
  db.prepare(
    `UPDATE case_orders SET date=?,cups=?,meal_time=?,powder_type=?,patient_name=?,notes=? WHERE id=?`
  ).run(orderDate, cups, meal_time, powder_type||'袋裝', patient_name||'', notes||'', req.params.id);
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
  const rxs = db.prepare(
    `SELECT p.*, pr.name as product_name, pr.unit as product_unit
     FROM prescriptions p
     LEFT JOIN products pr ON pr.id=p.product_id
     WHERE p.active=1 ORDER BY pr.sort_order, p.product_id, p.is_staff_rx DESC, p.code`
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
  const { product_id, name, formula_type, contraindications, timing, is_staff_rx, active } = req.body;
  db.prepare(
    `UPDATE prescriptions SET product_id=?,name=?,formula_type=?,contraindications=?,timing=?,is_staff_rx=?,active=? WHERE id=?`
  ).run(product_id||1, name, formula_type, contraindications||'', timing, is_staff_rx?1:0, active===undefined?1:active, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/prescriptions/:id', (req, res) => {
  db.prepare('UPDATE prescriptions SET active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// 取得處方食材
app.get('/api/prescriptions/:id/ingredients', (req, res) => {
  const all = db.prepare('SELECT id, name, unit, category, sort_order FROM ingredients WHERE active=1 ORDER BY sort_order, category, name').all();
  const used = db.prepare(
    `SELECT pi.ingredient_id, pi.qty_per_cup FROM prescription_ingredients pi WHERE pi.prescription_id=?`
  ).all(req.params.id);
  const usedMap = {};
  used.forEach(u => { usedMap[u.ingredient_id] = u.qty_per_cup; });
  res.json(all.map(i => ({ ...i, qty_per_cup: usedMap[i.id] || 0 })));
});

// 更新處方食材（完整覆蓋）
app.put('/api/prescriptions/:id/ingredients', (req, res) => {
  const items = req.body; // [{ingredient_id, qty_per_cup}]
  tx(() => {
    db.prepare('DELETE FROM prescription_ingredients WHERE prescription_id=?').run(req.params.id);
    const ins = db.prepare(
      'INSERT INTO prescription_ingredients (prescription_id,ingredient_id,qty_per_cup) VALUES (?,?,?)'
    );
    items.forEach(item => {
      if (item.qty_per_cup > 0) ins.run(req.params.id, item.ingredient_id, item.qty_per_cup);
    });
  });
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════
// API: 食材管理
// ════════════════════════════════════════════════════════

app.get('/api/ingredients', (req, res) => {
  res.json(db.prepare('SELECT * FROM ingredients WHERE active=1 ORDER BY sort_order, category, name').all());
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
  const { name, unit, category, safety_stock, storage_note, shelf_life_days } = req.body;
  db.prepare(
    `UPDATE ingredients SET name=?,unit=?,category=?,safety_stock=?,storage_note=?,shelf_life_days=? WHERE id=?`
  ).run(name, unit, category, safety_stock||0, storage_note||'', shelf_life_days||0, req.params.id);
  res.json({ ok: true });
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
app.post('/api/inventory/purchase', (req, res) => {
  const { ingredient_id, qty, total_price, purchased_at, user_id, item_type, purpose } = req.body;
  tx(() => {
    db.prepare(
      `INSERT INTO purchase_log (ingredient_id,qty,total_price,purchased_at,user_id,item_type,purpose) VALUES (?,?,?,?,?,?,?)`
    ).run(ingredient_id, qty, total_price, purchased_at || today(), user_id||null, item_type||'食材', purpose||'精力湯');
    db.prepare(
      `INSERT INTO inventory (ingredient_id,qty,updated_at) VALUES (?,?,datetime('now','localtime'))
       ON CONFLICT(ingredient_id) DO UPDATE SET qty=qty+excluded.qty, updated_at=excluded.updated_at`
    ).run(ingredient_id, qty);
  });
  res.json({ ok: true });
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
app.post('/api/inventory/consume', (req, res) => {
  const { prescription_id, cups, powder_type } = req.body;
  if (!prescription_id || !cups || cups <= 0) return res.status(400).json({ error: 'invalid' });
  const pm = (powder_type === '罐裝' || powder_type === '全配方') ? 1.1 : 1.0;
  const freshCats = new Set(['蔬菜','水果','油水','油','水','其他']);
  const ingRows = db.prepare(
    `SELECT pi.ingredient_id, pi.qty_per_cup, i.category
     FROM prescription_ingredients pi JOIN ingredients i ON i.id=pi.ingredient_id
     WHERE pi.prescription_id=? AND pi.qty_per_cup>0`
  ).all(prescription_id);
  tx(() => {
    ingRows.forEach(r => {
      const mult = freshCats.has(r.category) ? 1.0 : pm;
      const amount = Math.round(r.qty_per_cup * cups * mult * 100) / 100;
      db.prepare(
        `UPDATE inventory SET qty=MAX(0, ROUND(qty-?,1)), updated_at=datetime('now','localtime') WHERE ingredient_id=?`
      ).run(amount, r.ingredient_id);
    });
  });
  res.json({ ok: true });
});

// 庫存充足性檢查：依星期幾遞減的本週剩餘需求 + 安全緩衝 7 杯
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
  function addRxNeeds(rxId, cups, powderMult) {
    if (cups <= 0) return;
    powderMult = powderMult || 1.0;
    db.prepare(
      `SELECT pi.ingredient_id, pi.qty_per_cup, i.category
       FROM prescription_ingredients pi JOIN ingredients i ON i.id=pi.ingredient_id
       WHERE pi.prescription_id=? AND pi.qty_per_cup>0`
    ).all(rxId).forEach(r => {
      const freshCats = new Set(['蔬菜','水果','油水','油','水','其他']);
      const mult = freshCats.has(r.category) ? 1.0 : powderMult;
      needs[r.ingredient_id] = (needs[r.ingredient_id] || 0) + r.qty_per_cup * cups * mult;
    });
  }

  // 1. AW 本週剩餘杯數（週五備週六日外帶，週六日已備妥算 0）
  //    週一=7, 週二=6, 週三=5, 週四=4, 週五=3(含週六日), 週六=0, 週日=0
  const awCups = (dow >= 1 && dow <= 4) ? (8 - dow) : (dow === 5 ? 3 : 0);
  const awRx = db.prepare("SELECT id FROM prescriptions WHERE name='AW' LIMIT 1").get();
  if (awRx) {
    addRxNeeds(awRx.id, awCups);
    // 安全緩衝：多備 7 杯 AW 以應對臨時個案需求
    addRxNeeds(awRx.id, 7);
  }

  // 2. 員工本週剩餘餐次（週二=2,週四=4,週五=5）× 9 人
  //    週六日 dow=6/0 → 0；其餘計算今天（含）到週五還有幾個員工餐日
  const empMealDays = [2, 4, 5]; // 週二四五
  const empDays = (dow === 0 || dow === 6) ? 0 : empMealDays.filter(d => d >= dow).length;
  const empCups = empDays * 9;
  const empRx = db.prepare("SELECT id FROM prescriptions WHERE is_staff_rx=1 LIMIT 1").get();
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
    addRxNeeds(c.prescription_id, c.cups, pm);
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

  res.json({
    check,
    insufficient_count: check.filter(r => !r.sufficient).length,
    week_info: { dow, weekLabel, awCups, empCups, bufferCups: 7, endStr }
  });
});

// ════════════════════════════════════════════════════════
// API: 成本
// ════════════════════════════════════════════════════════

app.get('/api/costs', (req, res) => {
  const settings = {};
  db.prepare('SELECT key,value FROM settings').all().forEach(r => { settings[r.key] = parseFloat(r.value); });
  const laborCostPerCup = (settings.labor_rate || 250) * (settings.labor_min_per_cup || 15) / 60;
  const ucCache = buildUnitCostCache();

  // 今日實際成本（按產品）
  const todayCost = calcDailyCost(today(), ucCache, laborCostPerCup);

  // 處方成本參考表（每份標準成本）
  const rxs = db.prepare(
    `SELECT p.*, pr.name as product_name, pr.unit as product_unit
     FROM prescriptions p LEFT JOIN products pr ON pr.id=p.product_id
     WHERE p.active=1 ORDER BY pr.sort_order, p.product_id, p.is_staff_rx DESC, p.code`
  ).all();

  const prescriptions = rxs.map(rx => {
    const items = db.prepare(
      `SELECT pi.qty_per_cup, i.name, i.unit, i.id as iid FROM prescription_ingredients pi
       JOIN ingredients i ON i.id=pi.ingredient_id
       WHERE pi.prescription_id=? AND pi.qty_per_cup>0`
    ).all(rx.id);

    let ingCost = 0;
    const breakdown = items.map(it => {
      const uc = ucCache[it.iid] || 0;
      const cost = uc * it.qty_per_cup;
      ingCost += cost;
      return { name: it.name, unit: it.unit, qty: it.qty_per_cup,
               unit_cost: Math.round(uc * 1000) / 1000, cost: Math.round(cost * 10) / 10 };
    });

    return {
      ...rx,
      ingredient_cost: Math.round(ingCost * 10) / 10,
      labor_cost:      Math.round(laborCostPerCup * 10) / 10,
      total_cost:      Math.round((ingCost + laborCostPerCup) * 10) / 10,
      breakdown
    };
  });

  res.json({ settings, labor_cost_per_cup: Math.round(laborCostPerCup * 10) / 10,
             today: todayCost, prescriptions });
});

// 月報：某月每日成本 + 月合計
app.get('/api/costs/monthly', (req, res) => {
  const month = (req.query.month || today().slice(0, 7)).slice(0, 7);
  const settings = {};
  db.prepare('SELECT key,value FROM settings').all().forEach(r => { settings[r.key] = parseFloat(r.value); });
  const laborCostPerCup = (settings.labor_rate || 250) * (settings.labor_min_per_cup || 15) / 60;
  const ucCache = buildUnitCostCache();

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
    .map(d => calcDailyCost(d, ucCache, laborCostPerCup));

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
// API: 人力記錄（196元/hr）
// ════════════════════════════════════════════════════════

app.get('/api/labor', (req, res) => {
  const date = req.query.date || today();
  const rows = db.prepare(
    `SELECT lr.*, u.name as user_name
     FROM labor_records lr LEFT JOIN users u ON u.id=lr.user_id
     WHERE lr.date=? ORDER BY lr.id`
  ).all(date);
  const total_minutes = rows.reduce((s, r) => s + (r.minutes || 0), 0);
  const total_cost = Math.round(total_minutes / 60 * 196 * 10) / 10;
  res.json({ date, records: rows, total_minutes, total_cost });
});

app.post('/api/labor', (req, res) => {
  const { date, user_id, role, task_type, purpose, minutes } = req.body;
  if (!minutes || minutes <= 0) return res.status(400).json({ error: 'invalid' });
  const r = db.prepare(
    `INSERT INTO labor_records (date,user_id,role,task_type,purpose,minutes,hourly_rate) VALUES (?,?,?,?,?,?,196)`
  ).run(date || today(), user_id||null, role||'', task_type||'製作', purpose||'精力湯', minutes);
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
// API: 套餐模組（Meal Set）
// ════════════════════════════════════════════════════════

// 精力湯營養：由處方即時算出。粉類的 1.1 倍與 buildPrepAndPowder 一致
function calcTonicNutrition(rxId, powderMultiplier) {
  const pm = powderMultiplier || 1.0;
  const rows = db.prepare(
    `SELECT pi.qty_per_cup, i.name, i.unit, i.category,
            COALESCE(i.kcal_per_unit,0) kcal_per_unit,
            COALESCE(i.protein_per_unit,0) protein_per_unit
     FROM prescription_ingredients pi JOIN ingredients i ON i.id=pi.ingredient_id
     WHERE pi.prescription_id=? AND pi.qty_per_cup>0
     ORDER BY i.sort_order, i.name`
  ).all(rxId);

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
  );
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

  const series = db.prepare(
    `SELECT id, name, tagline FROM meal_series WHERE active=1 ORDER BY sort_order, id`
  ).all();
  const itemStmt = db.prepare(
    `SELECT id, protein, display_name, kcal, protein_g, kcal_single, protein_g_single,
            kcal_source, default_mode
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
    case: rx ? { name: rx.name, code: rx.code, formula_type: rx.formula_type } : null,
    series: series.map(s => ({
      name:    s.name,
      tagline: s.tagline,
      items:   itemStmt.all(s.id).map(it => ({
        id:           it.id,
        protein:      it.protein,
        name:         it.display_name,
        kcal:         it.kcal,
        kcal_single:  it.kcal_single,
        protein_g:    it.protein_g,
        estimated:    it.kcal_source === '內部估算',
        set_kcal:     tonic ? Math.round(it.kcal + tonic.kcal) : null,
        set_kcal_single: tonic ? Math.round(it.kcal_single + tonic.kcal) : null
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
               qty: 0, unit_price: unit, subtotal: 0,
               all_purchased: true, order_ids: [] };
      g.lines.push(line);
    }
    line.qty      += o.qty;
    line.subtotal += unit * o.qty;
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

app.post('/api/meals/orders', (req, res) => {
  const { meal_item_id, qty, meal_time, patient_name, case_order_id, purchase_mode, notes, date } = req.body;
  const item = db.prepare('SELECT * FROM meal_items WHERE id=?').get(meal_item_id);
  if (!item) return res.status(400).json({ error: '找不到這款餐盒' });

  const mode = purchase_mode === '單點' ? '單點' : '餐盒';
  const r = db.prepare(
    `INSERT INTO meal_orders
       (date,meal_item_id,qty,meal_time,patient_name,case_order_id,purchase_mode,
        snap_display_name,snap_kcal,snap_price,notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    date || today(), meal_item_id, qty || 1, meal_time || '1330',
    patient_name || '', case_order_id || null, mode,
    item.display_name, mealItemKcal(item, mode), mealItemPrice(item, mode), notes || ''
  );
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/meals/orders/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM meal_orders WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '找不到這筆出單' });
  const { qty, meal_time, patient_name, purchase_mode, status, notes, case_order_id } = req.body;
  const mode = purchase_mode === '單點' ? '單點' : (purchase_mode === '餐盒' ? '餐盒' : cur.purchase_mode);

  // 換了採購模式，價格與熱量快照要跟著換
  let snapKcal = cur.snap_kcal, snapPrice = cur.snap_price;
  if (mode !== cur.purchase_mode) {
    const item = db.prepare('SELECT * FROM meal_items WHERE id=?').get(cur.meal_item_id);
    if (item) { snapKcal = mealItemKcal(item, mode); snapPrice = mealItemPrice(item, mode); }
  }

  db.prepare(
    `UPDATE meal_orders SET qty=?, meal_time=?, patient_name=?, purchase_mode=?,
            status=?, notes=?, case_order_id=?, snap_kcal=?, snap_price=? WHERE id=?`
  ).run(
    qty ?? cur.qty, meal_time || cur.meal_time,
    patient_name ?? cur.patient_name, mode,
    status || cur.status, notes ?? cur.notes,
    case_order_id === undefined ? cur.case_order_id : (case_order_id || null),
    snapKcal, snapPrice, req.params.id
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
            kcal_source=?, nutrition_as_of=?, default_mode=?, active=? WHERE id=?`
  ).run(
    b.display_name ?? cur.display_name, b.vendor_item_name ?? cur.vendor_item_name,
    b.kcal ?? cur.kcal, b.protein_g ?? cur.protein_g,
    b.kcal_single ?? cur.kcal_single, b.protein_g_single ?? cur.protein_g_single,
    b.price_single ?? cur.price_single, b.price_box ?? cur.price_box,
    b.kcal_source ?? cur.kcal_source, b.nutrition_as_of ?? cur.nutrition_as_of,
    b.default_mode ?? cur.default_mode,
    b.active === undefined ? cur.active : (b.active ? 1 : 0),
    req.params.id
  );
  res.json({ ok: true });
});

// ── 隨餐營養衛教小卡 ──────────────────────────────────────
function cardRows() {
  return db.prepare(
    `SELECT nc.*,
            CASE WHEN nc.subject_type='meal_item' THEN mi.display_name ELSE p.name END AS subject_name,
            ms.name series_name
     FROM nutrition_cards nc
     LEFT JOIN meal_items mi  ON nc.subject_type='meal_item' AND mi.id=nc.subject_id
     LEFT JOIN meal_series ms ON ms.id=mi.series_id
     LEFT JOIN products p     ON nc.subject_type='product' AND p.id=nc.subject_id
     ORDER BY nc.subject_type DESC, ms.sort_order, mi.sort_order`
  ).all();
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
