const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const fs   = require('fs');
const path = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'clinic.db');

// ── 資料庫 ────────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

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

// 清除重複食材：schema.sql 每次啟動 INSERT OR IGNORE，rename 後舊名再度被插入
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
      // 刪掉舊名在同一處方中與新名衝突的列（FK 衝突會擋住後面 DELETE）
      db.prepare(`DELETE FROM prescription_ingredients WHERE ingredient_id=? AND prescription_id IN (SELECT prescription_id FROM prescription_ingredients WHERE ingredient_id=?)`).run(oldRow.id, newRow.id);
      // 剩餘列改指向新 id
      db.prepare("UPDATE prescription_ingredients SET ingredient_id=? WHERE ingredient_id=?").run(newRow.id, oldRow.id);
      db.prepare("DELETE FROM inventory WHERE ingredient_id=?").run(oldRow.id);
      db.prepare("DELETE FROM ingredients WHERE id=?").run(oldRow.id);
    }
  } catch(e) { console.error('dedup', oldName, e.message); }
});

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

app.get('/api/today', (req, res) => {
  const date = today();

  // 確保所有員工今日出席記錄存在（預設出席）
  db.prepare('SELECT * FROM users').all().forEach(u => {
    db.prepare(
      `INSERT OR IGNORE INTO staff_attendance (date,user_id,attending,meal_time) VALUES (?,?,1,'1330')`
    ).run(date, u.id);
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
      const pm = c.powder_type === '罐裝' ? 1.1 : 1.0;
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
        cups: c.cups, meal_time: c.meal_time
      })),
      batches,
      staff_rx:         staffRx || null,
      staff_prep:       staffPrep,
      staff_powder:     staffPowder,
      cases:            casesWithPrep
    };
  });

  res.json({ date, staff, attending_count: attendingCount, products: productData });
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
  const { name, unit, category, safety_stock, storage_note } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: '請輸入食材名稱' });
  try {
    const r = db.prepare(
      `INSERT INTO ingredients (name,unit,category,safety_stock,storage_note) VALUES (?,?,?,?,?)`
    ).run(name.trim(), unit||'g', category||'其他', safety_stock||0, storage_note||'');
    db.prepare('INSERT OR IGNORE INTO inventory (ingredient_id, qty) VALUES (?,0)').run(r.lastInsertRowid);
    res.json({ id: r.lastInsertRowid });
  } catch(e) {
    res.status(400).json({ error: '食材名稱已存在' });
  }
});

app.put('/api/ingredients/:id', (req, res) => {
  const { name, unit, category, safety_stock, storage_note } = req.body;
  db.prepare(
    `UPDATE ingredients SET name=?,unit=?,category=?,safety_stock=?,storage_note=? WHERE id=?`
  ).run(name, unit, category, safety_stock||0, storage_note||'', req.params.id);
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
  const { ingredient_id, qty, total_price, purchased_at, user_id } = req.body;
  tx(() => {
    db.prepare(
      `INSERT INTO purchase_log (ingredient_id,qty,total_price,purchased_at,user_id) VALUES (?,?,?,?,?)`
    ).run(ingredient_id, qty, total_price, purchased_at || today(), user_id||null);
    db.prepare(
      `INSERT INTO inventory (ingredient_id,qty,updated_at) VALUES (?,?,datetime('now','localtime'))
       ON CONFLICT(ingredient_id) DO UPDATE SET qty=qty+excluded.qty, updated_at=excluded.updated_at`
    ).run(ingredient_id, qty);
  });
  res.json({ ok: true });
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
// 啟動
// ════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`診所廚房系統運行中 → http://localhost:${PORT}`);
});
