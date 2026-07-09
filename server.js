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
    db.prepare("UPDATE users SET password=? WHERE name='John' AND (password IS NULL OR password='')").run(KITCHEN_PASSWORD);
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
    db.prepare("UPDATE users SET password=? WHERE name='John' AND (password IS NULL OR password='')").run(KITCHEN_PASSWORD);
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

  return { date, products: productCosts, grand_total: Math.round(grandTotal * 10) / 10 };
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

  res.json({ date, staff, attending_count: attendingCount, products: productData, leaves: leavesToday, is_meal_day: isMealDay });
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

  res.json({ month, days, month_total, by_product });
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
// 啟動
// ════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`診所廚房系統運行中 → http://localhost:${PORT}`);
});
