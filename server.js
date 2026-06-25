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
].forEach(sql => { try { db.exec(sql); } catch(e) {} });
db.exec("UPDATE prescriptions SET is_staff_rx=1 WHERE code='EMP-00'");
db.exec("UPDATE prescriptions SET product_id=1 WHERE product_id IS NULL");

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

function buildPrepAndPowder(rxId, multiplier, unit) {
  const allItems = db.prepare(
    `SELECT pi.qty_per_cup, i.name, i.unit, i.category FROM prescription_ingredients pi
     JOIN ingredients i ON i.id=pi.ingredient_id
     WHERE pi.prescription_id=? AND pi.qty_per_cup>0 ORDER BY i.category, i.name`
  ).all(rxId);
  const prep = allItems.filter(r => r.category !== '粉類').map(r => ({
    name: r.name, unit: r.unit,
    per_serving: r.qty_per_cup,
    total: Math.round(r.qty_per_cup * multiplier * 10) / 10
  }));
  const powderItems = allItems.filter(r => r.category === '粉類');
  const powderPerServing = powderItems.reduce((s, r) => s + r.qty_per_cup, 0);
  const powder = {
    per_serving: Math.round(powderPerServing * 10) / 10,
    total:       Math.round(powderPerServing * multiplier * 10) / 10,
    items:       powderItems.map(r => ({ name: r.name, qty: r.qty_per_cup, unit: r.unit }))
  };
  return { prep, powder };
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
    const batches = calcBatches(attendingCount, prod.batch_size);

    // 員工標準處方
    const staffRx = db.prepare(
      `SELECT * FROM prescriptions WHERE product_id=? AND is_staff_rx=1 AND active=1 LIMIT 1`
    ).get(prod.id);

    let staffPrep = [], staffPowder = { per_serving: 0, items: [], batches: [] };
    if (staffRx && attendingCount > 0) {
      const { prep, powder } = buildPrepAndPowder(staffRx.id, attendingCount, prod.unit);
      staffPrep = prep;
      // 粉包per批次
      const powderBatches = batches.map(b => ({
        label: `${b.size}${prod.unit}批 ×${b.count}`,
        per_batch: Math.round(powder.per_serving * b.size * 10) / 10,
        count: b.count
      }));
      staffPowder = { ...powder, batches: powderBatches };
    }

    // 個案出單（今日，此產品）
    const cases = db.prepare(
      `SELECT co.*, p.code, p.name as rx_name, p.formula_type, p.contraindications, p.timing
       FROM case_orders co
       JOIN prescriptions p ON p.id=co.prescription_id
       WHERE co.date=? AND p.product_id=? ORDER BY co.meal_time`
    ).all(date, prod.id);

    const casesWithPrep = cases.map(c => {
      const { prep, powder } = buildPrepAndPowder(c.prescription_id, c.cups, prod.unit);
      return { ...c, prep, powder };
    });

    return {
      id:          prod.id,
      name:        prod.name,
      unit:        prod.unit,
      batch_size:  prod.batch_size,
      description: prod.description,
      batches,
      staff_rx:    staffRx || null,
      staff_prep:  staffPrep,
      staff_powder: staffPowder,
      cases:       casesWithPrep
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

// 新增今日個案出單
app.post('/api/today/cases', (req, res) => {
  const { prescription_id, cups, meal_time, notes } = req.body;
  const date = today();
  const r = db.prepare(
    `INSERT INTO case_orders (date,prescription_id,cups,meal_time,notes) VALUES (?,?,?,?,?)`
  ).run(date, prescription_id, cups||1, meal_time||'1330', notes||'');
  res.json({ id: r.lastInsertRowid });
});

// 更新今日個案出單
app.put('/api/today/cases/:id', (req, res) => {
  const { cups, meal_time, notes } = req.body;
  db.prepare(
    `UPDATE case_orders SET cups=?,meal_time=?,notes=? WHERE id=?`
  ).run(cups, meal_time, notes||'', req.params.id);
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
  const all = db.prepare('SELECT id, name, unit, category FROM ingredients WHERE active=1 ORDER BY category, name').all();
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
  res.json(db.prepare('SELECT * FROM ingredients WHERE active=1 ORDER BY category, name').all());
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
     WHERE i.active=1 ORDER BY i.category, i.name`
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

  const rxs = db.prepare('SELECT * FROM prescriptions WHERE active=1 ORDER BY code').all();

  const result = rxs.map(rx => {
    const items = db.prepare(
      `SELECT pi.qty_per_cup, i.name, i.unit, i.id as iid FROM prescription_ingredients pi
       JOIN ingredients i ON i.id=pi.ingredient_id
       WHERE pi.prescription_id=? AND pi.qty_per_cup>0`
    ).all(rx.id);

    let ingredient_cost = 0;
    const breakdown = items.map(it => {
      const uc = unitCost(it.iid);
      const cost = uc * it.qty_per_cup;
      ingredient_cost += cost;
      return { name: it.name, unit: it.unit, qty: it.qty_per_cup, unit_cost: uc, cost };
    });

    return {
      ...rx,
      ingredient_cost: Math.round(ingredient_cost * 10) / 10,
      labor_cost: Math.round(laborCostPerCup * 10) / 10,
      total_cost: Math.round((ingredient_cost + laborCostPerCup) * 10) / 10,
      breakdown
    };
  });

  res.json({ settings, labor_cost_per_cup: laborCostPerCup, prescriptions: result });
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
