/**
 * 診所廚房管理系統 - 後端伺服器
 * Node.js + Express + SQLite (better-sqlite3)
 *
 * 啟動：node server.js
 * 開啟：http://localhost:3000
 */

const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'clinic.db');
const PASSWORD = process.env.KITCHEN_PASSWORD || 'clinic2024';

// ── 資料庫初始化 ──────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// ── 密碼保護（HTTP Basic Auth）────────────────────────────
app.use((req, res, next) => {
  const auth = req.headers['authorization'];
  if (auth) {
    const [, creds] = auth.split(' ');
    const [, pass] = Buffer.from(creds, 'base64').toString().split(':');
    if (pass === PASSWORD) return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="診所廚房系統"');
  res.status(401).send('請輸入密碼');
});

// ── 中介層 ────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── 工具函式 ─────────────────────────────────────────────

function getCurrentSeason() {
  // 先看手動設定的 is_current
  const manual = db.prepare('SELECT * FROM seasons WHERE is_current = 1').get();
  if (manual) return manual;
  // 否則依月份自動判斷
  const month = new Date().getMonth() + 1;
  return db.prepare(
    'SELECT * FROM seasons WHERE start_month <= ? AND end_month >= ?'
  ).get(month, month)
    || db.prepare("SELECT * FROM seasons WHERE name = '冬'").get();
}

// 計算員工版批次（依攪拌機容量 3杯滿 / 2杯半）
function calcBatches(cups) {
  const mod = cups % 3;
  const three = mod === 1 ? Math.floor(cups / 3) - 1 : Math.floor(cups / 3);
  const two   = mod === 0 ? 0 : mod === 1 ? 2 : 1;
  return { three, two, total: three + two };
}

function today() {
  return new Date().toISOString().split('T')[0];
}

// ══════════════════════════════════════════════════════════
// API 路由
// ══════════════════════════════════════════════════════════

// ── 今日概覽 ─────────────────────────────────────────────
app.get('/api/today', (req, res) => {
  const date = today();
  const season = getCurrentSeason();

  const orders = db.prepare(`
    SELECT o.*, v.name AS variant_name, v.description AS variant_desc
    FROM daily_orders o
    JOIN variants v ON o.variant_id = v.id
    WHERE o.date = ?
    ORDER BY v.id
  `).all(date);

  const staffOrder = orders.find(o => o.variant_name === '員工版');
  const batches = staffOrder ? calcBatches(staffOrder.cups) : null;

  const warnings = db.prepare(`
    SELECT i.name, i.unit, i.min_stock,
           COALESCE(inv.current_stock, 0) AS stock
    FROM ingredients i
    LEFT JOIN inventory inv ON i.id = inv.ingredient_id
    WHERE COALESCE(inv.current_stock, 0) < i.min_stock AND i.min_stock > 0
  `).all();

  res.json({ date, season, orders, batches, warnings });
});

// 設定今日排程
app.post('/api/today/orders', (req, res) => {
  const { case_cups, staff_cups, deadline, assigned_staff } = req.body;
  const date = today();

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM daily_orders WHERE date = ?').run(date);
    const ins = db.prepare(
      'INSERT INTO daily_orders (date, variant_id, cups, deadline_time, assigned_staff) VALUES (?,?,?,?,?)'
    );
    if (case_cups  > 0) ins.run(date, 1, case_cups,  deadline || '13:30', assigned_staff || '');
    if (staff_cups > 0) ins.run(date, 2, staff_cups, deadline || '13:30', assigned_staff || '');
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true });
});

// ── 配方 ──────────────────────────────────────────────────
app.get('/api/recipe/:variantId', (req, res) => {
  const vid = req.params.variantId;
  const season = getCurrentSeason();

  const base = db.prepare(`
    SELECT r.qty_per_cup, i.id, i.name, i.unit
    FROM recipe_items r
    JOIN ingredients i ON r.ingredient_id = i.id
    WHERE r.variant_id = ?
    ORDER BY r.id
  `).all(vid);

  const seasonal = season
    ? db.prepare(`
        SELECT s.qty_per_cup, i.id, i.name, i.unit
        FROM seasonal_items s
        JOIN ingredients i ON s.ingredient_id = i.id
        WHERE s.variant_id = ? AND s.season_id = ?
        ORDER BY s.id
      `).all(vid, season.id)
    : [];

  res.json({ base, seasonal, season });
});

// 更新季節水果槽
app.put('/api/seasonal/:variantId/:seasonId', (req, res) => {
  const { variantId, seasonId } = req.params;
  const { items } = req.body; // [{ingredient_id, qty_per_cup}]

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM seasonal_items WHERE variant_id = ? AND season_id = ?').run(variantId, seasonId);
    const ins = db.prepare(
      'INSERT INTO seasonal_items (variant_id, season_id, ingredient_id, qty_per_cup) VALUES (?,?,?,?)'
    );
    items.forEach(item => ins.run(variantId, seasonId, item.ingredient_id, item.qty_per_cup));
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true });
});

// ── SOP ───────────────────────────────────────────────────
app.get('/api/sop/:productId', (req, res) => {
  const steps = db.prepare(
    'SELECT * FROM sop_steps WHERE product_id = ? ORDER BY step_number'
  ).all(req.params.productId);

  const result = steps.map(s => ({
    ...s,
    checklist: db.prepare('SELECT * FROM sop_checklist WHERE step_id = ?').all(s.id)
  }));

  res.json(result);
});

// ── 庫存 ──────────────────────────────────────────────────
app.get('/api/inventory', (req, res) => {
  const items = db.prepare(`
    SELECT i.id, i.name, i.unit, i.min_stock, i.cost_per_unit, i.shelf_life_days,
           COALESCE(inv.current_stock, 0) AS current_stock,
           CASE
             WHEN COALESCE(inv.current_stock, 0) = 0            THEN 'empty'
             WHEN COALESCE(inv.current_stock, 0) <= i.min_stock THEN 'danger'
             WHEN COALESCE(inv.current_stock, 0) <= i.min_stock * 1.3 THEN 'warning'
             ELSE 'ok'
           END AS status
    FROM ingredients i
    LEFT JOIN inventory inv ON i.id = inv.ingredient_id
    ORDER BY i.id
  `).all();
  res.json(items);
});

// 進貨
app.post('/api/inventory/purchase', (req, res) => {
  const { ingredient_id, qty, note } = req.body;
  if (!ingredient_id || !qty) return res.status(400).json({ error: '缺少必填欄位' });

  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO inventory_log (ingredient_id, type, qty, note) VALUES (?,?,?,?)').run(
      ingredient_id, 'purchase', qty, note || ''
    );
    db.prepare(`
      INSERT INTO inventory (ingredient_id, current_stock) VALUES (?, ?)
      ON CONFLICT(ingredient_id) DO UPDATE SET current_stock = current_stock + excluded.current_stock
    `).run(ingredient_id, qty);
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true });
});

// 庫存紀錄
app.get('/api/inventory/log', (req, res) => {
  const log = db.prepare(`
    SELECT l.*, i.name, i.unit
    FROM inventory_log l
    JOIN ingredients i ON l.ingredient_id = i.id
    ORDER BY l.id DESC
    LIMIT 100
  `).all();
  res.json(log);
});

// ── 成本 ──────────────────────────────────────────────────
app.get('/api/costs', (req, res) => {
  const season = getCurrentSeason();
  const variants = db.prepare('SELECT * FROM variants').all();

  const result = variants.map(v => {
    const base = db.prepare(`
      SELECT i.name, i.unit, r.qty_per_cup, i.cost_per_unit,
             r.qty_per_cup * i.cost_per_unit AS item_cost
      FROM recipe_items r
      JOIN ingredients i ON r.ingredient_id = i.id
      WHERE r.variant_id = ?
    `).all(v.id);

    const seasonal = season
      ? db.prepare(`
          SELECT i.name, i.unit, s.qty_per_cup, i.cost_per_unit,
                 s.qty_per_cup * i.cost_per_unit AS item_cost
          FROM seasonal_items s
          JOIN ingredients i ON s.ingredient_id = i.id
          WHERE s.variant_id = ? AND s.season_id = ?
        `).all(v.id, season.id)
      : [];

    const all = [...base, ...seasonal];
    const total = all.reduce((sum, r) => sum + (r.item_cost || 0), 0);
    return { variant: v, items: all, total_per_cup: total };
  });

  res.json(result);
});

// 更新食材單價
app.put('/api/ingredients/:id/cost', (req, res) => {
  const { cost_per_unit } = req.body;
  db.prepare('UPDATE ingredients SET cost_per_unit = ? WHERE id = ?').run(
    cost_per_unit, req.params.id
  );
  res.json({ ok: true });
});

// ── 生產批次 ─────────────────────────────────────────────
app.post('/api/batch/start', (req, res) => {
  const { daily_order_id, batch_number, batch_size, operator } = req.body;
  const id = db.prepare(`
    INSERT INTO production_batches (daily_order_id, batch_number, batch_size, operator, start_time, status)
    VALUES (?, ?, ?, ?, datetime('now'), 'in_progress')
  `).run(daily_order_id, batch_number, batch_size, operator || '').lastInsertRowid;
  res.json({ id });
});

// 完成步驟
app.post('/api/batch/step', (req, res) => {
  const { batch_id, step_id, operator } = req.body;
  db.prepare(
    'INSERT INTO step_log (batch_id, step_id, operator) VALUES (?,?,?)'
  ).run(batch_id, step_id, operator || '');
  res.json({ ok: true });
});

// 完成批次（自動扣庫存）
app.post('/api/batch/:id/complete', (req, res) => {
  const batch = db.prepare(`
    SELECT pb.*, o.variant_id
    FROM production_batches pb
    JOIN daily_orders o ON pb.daily_order_id = o.id
    WHERE pb.id = ?
  `).get(req.params.id);

  if (!batch) return res.status(404).json({ error: '找不到此批次' });

  const season = getCurrentSeason();
  const baseItems = db.prepare('SELECT * FROM recipe_items WHERE variant_id = ?').all(batch.variant_id);
  const seasonItems = season
    ? db.prepare('SELECT * FROM seasonal_items WHERE variant_id = ? AND season_id = ?').all(batch.variant_id, season.id)
    : [];

  db.exec('BEGIN');
  try {
    db.prepare(
      "UPDATE production_batches SET status='completed', end_time=datetime('now') WHERE id=?"
    ).run(batch.id);
    [...baseItems, ...seasonItems].forEach(item => {
      const used = item.qty_per_cup * batch.batch_size;
      db.prepare(
        'UPDATE inventory SET current_stock = MAX(0, current_stock - ?) WHERE ingredient_id = ?'
      ).run(used, item.ingredient_id);
      db.prepare(
        "INSERT INTO inventory_log (ingredient_id, type, qty, note) VALUES (?, 'use', ?, ?)"
      ).run(item.ingredient_id, used, `批次 #${batch.batch_number}`);
    });
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true });
});

// 今日生產紀錄
app.get('/api/batch/today', (req, res) => {
  const batches = db.prepare(`
    SELECT pb.*, o.variant_id, v.name AS variant_name
    FROM production_batches pb
    JOIN daily_orders o ON pb.daily_order_id = o.id
    JOIN variants v ON o.variant_id = v.id
    WHERE o.date = ?
    ORDER BY pb.id DESC
  `).all(today());
  res.json(batches);
});

// ── 季節管理 ─────────────────────────────────────────────
app.get('/api/seasons', (req, res) => {
  res.json(db.prepare('SELECT * FROM seasons').all());
});

app.put('/api/seasons/current/:id', (req, res) => {
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE seasons SET is_current = 0').run();
    db.prepare('UPDATE seasons SET is_current = 1 WHERE id = ?').run(req.params.id);
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true });
});

// ── 匯出 CSV ─────────────────────────────────────────────
app.get('/api/export/inventory', (req, res) => {
  const rows = db.prepare(`
    SELECT i.name, i.unit, COALESCE(inv.current_stock,0) AS stock,
           i.min_stock, i.cost_per_unit, i.shelf_life_days
    FROM ingredients i
    LEFT JOIN inventory inv ON i.id = inv.ingredient_id
  `).all();

  const csv = [
    '食材,單位,庫存量,安全庫存,單位成本(元),保存天數',
    ...rows.map(r =>
      `${r.name},${r.unit},${r.stock},${r.min_stock},${r.cost_per_unit},${r.shelf_life_days}`
    )
  ].join('\n');

  const filename = `庫存-${today()}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send('﻿' + csv);
});

app.get('/api/export/log', (req, res) => {
  const rows = db.prepare(`
    SELECT l.date, i.name, l.type, l.qty, i.unit, l.note
    FROM inventory_log l
    JOIN ingredients i ON l.ingredient_id = i.id
    ORDER BY l.id DESC
    LIMIT 1000
  `).all();

  const csv = [
    '日期,食材,異動類型,數量,單位,備註',
    ...rows.map(r =>
      `${r.date},${r.name},${r.type === 'purchase' ? '進貨' : '耗用'},${r.qty},${r.unit},${r.note || ''}`
    )
  ].join('\n');

  const filename = `異動紀錄-${today()}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send('﻿' + csv);
});

// ── 啟動 ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║   診所廚房管理系統  已啟動           ║');
  console.log(`║   http://localhost:${PORT}              ║`);
  console.log('║   按 Ctrl+C 關閉                     ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');
});
