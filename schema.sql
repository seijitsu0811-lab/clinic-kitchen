PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── 使用者（廚房員工）────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  role TEXT DEFAULT 'staff',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- ── 食材主檔 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ingredients (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  unit         TEXT NOT NULL DEFAULT 'g',
  category     TEXT NOT NULL DEFAULT '其他',
  safety_stock REAL DEFAULT 0,
  storage_note TEXT DEFAULT '',
  active       INTEGER DEFAULT 1
);

-- ── 庫存（目前數量）──────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory (
  ingredient_id INTEGER PRIMARY KEY,
  qty           REAL DEFAULT 0,
  updated_at    TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)
);

-- ── 採購紀錄（計算加權平均成本）─────────────────────────
CREATE TABLE IF NOT EXISTS purchase_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_id INTEGER NOT NULL,
  qty           REAL NOT NULL,
  total_price   REAL NOT NULL,
  purchased_at  TEXT NOT NULL,
  user_id       INTEGER,
  FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)
);

-- ── 產品（精力湯、其他未來產品）────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  unit        TEXT NOT NULL DEFAULT '份',
  batch_size  INTEGER NOT NULL DEFAULT 3,
  description TEXT DEFAULT '',
  sort_order  INTEGER DEFAULT 0,
  active      INTEGER DEFAULT 1
);

-- ── 處方（EMP-00 員工標準 + RX-01..10 個案）─────────────
CREATE TABLE IF NOT EXISTS prescriptions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id        INTEGER DEFAULT 1,
  code              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  formula_type      TEXT NOT NULL DEFAULT '粉配方',
  contraindications TEXT DEFAULT '',
  timing            TEXT DEFAULT '餐前',
  is_staff_rx       INTEGER DEFAULT 0,
  active            INTEGER DEFAULT 1,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- ── 處方食材用量（每杯）────────────────────────────────
CREATE TABLE IF NOT EXISTS prescription_ingredients (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  prescription_id INTEGER NOT NULL,
  ingredient_id   INTEGER NOT NULL,
  qty_per_cup     REAL NOT NULL DEFAULT 0,
  UNIQUE(prescription_id, ingredient_id),
  FOREIGN KEY (prescription_id) REFERENCES prescriptions(id),
  FOREIGN KEY (ingredient_id)   REFERENCES ingredients(id)
);

-- ── 今日員工出席 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff_attendance (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  date      TEXT NOT NULL,
  user_id   INTEGER NOT NULL,
  attending INTEGER DEFAULT 1,
  meal_time TEXT DEFAULT '1330',
  UNIQUE(date, user_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- ── 今日個案出單 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS case_orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL,
  prescription_id INTEGER NOT NULL,
  cups            INTEGER NOT NULL DEFAULT 1,
  meal_time       TEXT DEFAULT '1330',
  powder_type     TEXT NOT NULL DEFAULT '袋裝',
  notes           TEXT DEFAULT '',
  FOREIGN KEY (prescription_id) REFERENCES prescriptions(id)
);

-- ── 操作記錄 ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action  TEXT NOT NULL,
  detail  TEXT,
  ts      TEXT DEFAULT (datetime('now','localtime'))
);

-- ── 系統設定 ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ════════════════════════════════════════════════════════
-- 初始資料
-- ════════════════════════════════════════════════════════

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('labor_rate',           '250'),
  ('labor_min_per_cup',    '15'),
  ('full_formula_price',   '350'),
  ('powder_formula_price', '280');

INSERT OR IGNORE INTO products (id, name, unit, batch_size, sort_order) VALUES (1, '精力湯', '杯', 3, 1);

INSERT OR IGNORE INTO users (name) VALUES
  ('Bonnie'),('Yenti'),('Louise'),('GG'),('Winnie'),
  ('綉綉'),('Ann'),('John'),('孟睿');

INSERT OR IGNORE INTO ingredients (name, unit, category, safety_stock, storage_note) VALUES
  ('芽菜',     'g',  '蔬菜', 0,    '最長5天｜冷藏4°C｜開袋密封5天'),
  ('羽衣甘藍', 'g',  '蔬菜', 0,    '最長5天｜冷藏4°C｜洗後密封5天'),
  ('貝比生菜', 'g',  '蔬菜', 0,    '最長5天｜冷藏4°C｜洗後密封5天'),
  ('小麥草',   'g',  '蔬菜', 0,    ''),
  ('胡蘿蔔',   'g',  '蔬菜', 0,    '完整7天｜切開冷藏5天'),
  ('木瓜',       'g',  '水果', 0,    '完整3天｜切開冷藏2天'),
  ('甜菜根',     'g',  '蔬菜', 0,    '完整7天｜切開冷藏5天'),
  ('蘋果(帶皮)', 'g',  '水果', 1350, '完整7天｜切塊冷凍後30天'),
  ('檸檬',       'g',  '水果', 135,  '完整7天｜切開冷藏3天'),
  ('莓果',       'g',  '水果', 1680, '冷凍-18°C｜開袋密封後30天'),
  ('香蕉',       'g',  '水果', 0,    '完整5天｜切塊冷凍後30天'),
  ('奇異果',     'g',  '水果', 0,    '完整5天｜切塊冷凍後30天'),
  ('鳳梨',     'g',  '水果', 0,    ''),
  ('燕麥',     'g',  '粉類', 800,  '打粉後玻璃罐室溫密封｜最長60天'),
  ('核桃',     'g',  '粉類', 500,  '密封室溫避光｜開袋後30天'),
  ('薑黃粉',   'g',  '粉類', 80,   '密封室溫｜依包裝效期(通常180天)'),
  ('肉桂粉',   'g',  '粉類', 0,    '密封室溫｜依包裝效期'),
  ('薑粉',     'g',  '粉類', 0,    '密封室溫｜依包裝效期'),
  ('藜麥粉',   'g',  '粉類', 0,    '密封室溫｜依包裝效期'),
  ('蛋白粉',   'g',  '粉類', 2000, '1罐=500g｜密封室溫｜開罐後60天'),
  ('黑胡椒',   'g',  '粉類', 80,   '1g≈14~20粒｜密封室溫'),
  ('AstragIN', '粒', '保健品', 0,    '密封室溫｜注意批號效期'),
  ('Senactiv', '粒', '保健品', 0,    '密封室溫｜注意批號效期'),
  ('益生菌',   '包', '保健品', 0,    ''),
  ('橄欖油',   'ml', '油', 1600, '室溫避光｜開瓶後90天'),
  ('苦茶油',   'ml', '油', 0,    '室溫避光｜開瓶後90天'),
  ('酪梨油',   'ml', '油', 0,    '室溫避光｜開瓶後90天');

INSERT OR IGNORE INTO inventory (ingredient_id, qty)
SELECT id, CASE name
  WHEN '芽菜'     THEN 360  WHEN '羽衣甘藍' THEN 350
  WHEN '貝比生菜' THEN 450  WHEN '胡蘿蔔'   THEN 600
  WHEN '蘋果(帶皮)' THEN 5060 WHEN '檸檬'  THEN 500
  WHEN '莓果'       THEN 1650 WHEN '奇異果' THEN 64
  WHEN '燕麥'     THEN 2070 WHEN '核桃'     THEN 1000
  WHEN '薑黃粉'   THEN 170  WHEN '肉桂粉'   THEN 13
  WHEN '薑粉'     THEN 80   WHEN '蛋白粉'   THEN 5000
  WHEN '黑胡椒'   THEN 450  WHEN 'AstragIN' THEN 50
  WHEN 'Senactiv' THEN 50   WHEN '橄欖油'   THEN 1700
  WHEN '苦茶油'   THEN 150  ELSE 0
END FROM ingredients;

INSERT OR IGNORE INTO purchase_log (ingredient_id, qty, total_price, purchased_at) VALUES
  ((SELECT id FROM ingredients WHERE name='莓果'),    1500, 329,  '2026-06-01'),
  ((SELECT id FROM ingredients WHERE name='莓果'),    3815, 1131, '2026-06-01'),
  ((SELECT id FROM ingredients WHERE name='羽衣甘藍'),1500, 831,  '2026-06-01'),
  ((SELECT id FROM ingredients WHERE name='蘋果(帶皮)'),18140, 3058, '2026-06-01'),
  ((SELECT id FROM ingredients WHERE name='芽菜'),     200, 155,  '2026-06-01'),
  ((SELECT id FROM ingredients WHERE name='貝比生菜'),1000, 1111, '2026-06-01'),
  ((SELECT id FROM ingredients WHERE name='胡蘿蔔'),   250, 59,   '2026-06-01'),
  ((SELECT id FROM ingredients WHERE name='檸檬'),1800, 148,  '2026-06-01'),
  ((SELECT id FROM ingredients WHERE name='薑黃粉'),   340, 129,  '2026-06-01'),
  ((SELECT id FROM ingredients WHERE name='橄欖油'),  3000, 1167, '2026-06-01'),
  ((SELECT id FROM ingredients WHERE name='核桃'),    1360, 489,  '2026-06-01'),
  ((SELECT id FROM ingredients WHERE name='燕麥'),    5470, 804,  '2026-06-01'),
  ((SELECT id FROM ingredients WHERE name='苦茶油'),   300, 660,  '2026-06-01'),
  ((SELECT id FROM ingredients WHERE name='蛋白粉'),  4500, 2970, '2026-06-01');

INSERT OR IGNORE INTO prescriptions (code, name, formula_type, contraindications, timing) VALUES
  ('EMP-00', '員工標準', '全配方', '',              '餐前'),
  ('RX-01',  'AW',       '全配方', '無肉桂粉改薑片','餐前'),
  ('RX-02',  '盧張鶯鶯', '粉配方', '',              '隨餐'),
  ('RX-03',  '王長慧',   '粉配方', '',              '隨餐'),
  ('RX-04',  '陶石良',   '粉配方', '',              '餐前');

-- Helper macro: insert one prescription ingredient by name
-- EMP-00
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='EMP-00'),(SELECT id FROM ingredients WHERE name='羽衣甘藍'),15;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='EMP-00'),(SELECT id FROM ingredients WHERE name='貝比生菜'),15;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='EMP-00'),(SELECT id FROM ingredients WHERE name='蘋果(帶皮)'),80;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='EMP-00'),(SELECT id FROM ingredients WHERE name='檸檬'),15;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='EMP-00'),(SELECT id FROM ingredients WHERE name='莓果'),20;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='EMP-00'),(SELECT id FROM ingredients WHERE name='香蕉'),30;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='EMP-00'),(SELECT id FROM ingredients WHERE name='燕麥'),10;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='EMP-00'),(SELECT id FROM ingredients WHERE name='核桃'),1;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='EMP-00'),(SELECT id FROM ingredients WHERE name='薑黃粉'),1;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='EMP-00'),(SELECT id FROM ingredients WHERE name='黑胡椒'),1;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='EMP-00'),(SELECT id FROM ingredients WHERE name='橄欖油'),20;

-- RX-01 (AW)
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-01'),(SELECT id FROM ingredients WHERE name='羽衣甘藍'),20;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-01'),(SELECT id FROM ingredients WHERE name='貝比生菜'),10;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-01'),(SELECT id FROM ingredients WHERE name='木瓜'),30;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-01'),(SELECT id FROM ingredients WHERE name='蘋果(帶皮)'),40;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-01'),(SELECT id FROM ingredients WHERE name='檸檬'),30;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-01'),(SELECT id FROM ingredients WHERE name='莓果'),20;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-01'),(SELECT id FROM ingredients WHERE name='奇異果'),20;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-01'),(SELECT id FROM ingredients WHERE name='燕麥'),20;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-01'),(SELECT id FROM ingredients WHERE name='核桃'),1;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-01'),(SELECT id FROM ingredients WHERE name='薑黃粉'),1;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-01'),(SELECT id FROM ingredients WHERE name='肉桂粉'),1;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-01'),(SELECT id FROM ingredients WHERE name='黑胡椒'),1;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-01'),(SELECT id FROM ingredients WHERE name='AstragIN'),2;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-01'),(SELECT id FROM ingredients WHERE name='橄欖油'),20;

-- RX-02 (盧張鶯鶯)
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-02'),(SELECT id FROM ingredients WHERE name='燕麥'),10;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-02'),(SELECT id FROM ingredients WHERE name='核桃'),1;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-02'),(SELECT id FROM ingredients WHERE name='薑黃粉'),1;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-02'),(SELECT id FROM ingredients WHERE name='肉桂粉'),1;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-02'),(SELECT id FROM ingredients WHERE name='黑胡椒'),1;

-- RX-03 (王長慧)
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-03'),(SELECT id FROM ingredients WHERE name='燕麥'),10;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-03'),(SELECT id FROM ingredients WHERE name='核桃'),1;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-03'),(SELECT id FROM ingredients WHERE name='薑黃粉'),1;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-03'),(SELECT id FROM ingredients WHERE name='薑粉'),1;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-03'),(SELECT id FROM ingredients WHERE name='黑胡椒'),1;

-- RX-04 (陶石良)
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-04'),(SELECT id FROM ingredients WHERE name='燕麥'),20;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-04'),(SELECT id FROM ingredients WHERE name='核桃'),1;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-04'),(SELECT id FROM ingredients WHERE name='薑黃粉'),1;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-04'),(SELECT id FROM ingredients WHERE name='肉桂粉'),1;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-04'),(SELECT id FROM ingredients WHERE name='薑粉'),1;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-04'),(SELECT id FROM ingredients WHERE name='黑胡椒'),1;
INSERT OR IGNORE INTO prescription_ingredients (prescription_id, ingredient_id, qty_per_cup) SELECT (SELECT id FROM prescriptions WHERE code='RX-04'),(SELECT id FROM ingredients WHERE name='AstragIN'),2;
