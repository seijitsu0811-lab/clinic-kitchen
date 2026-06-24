-- ============================================================
-- 診所廚房管理系統 - 資料庫結構
-- 設計原則：Product-Agnostic，可擴充任何 Meal 類型
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 產品（精力湯、未來可新增便當等）
CREATE TABLE IF NOT EXISTS products (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT    NOT NULL,
  status TEXT  NOT NULL DEFAULT 'active'
);

-- 產品變體（個案版、員工版）
CREATE TABLE IF NOT EXISTS variants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  description TEXT,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- 季節
CREATE TABLE IF NOT EXISTS seasons (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  start_month  INTEGER NOT NULL,
  end_month    INTEGER NOT NULL,
  is_current   INTEGER NOT NULL DEFAULT 0
);

-- 食材主檔
CREATE TABLE IF NOT EXISTS ingredients (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  unit             TEXT    NOT NULL,
  cost_per_unit    REAL    NOT NULL DEFAULT 0,
  min_stock        REAL    NOT NULL DEFAULT 0,
  shelf_life_days  INTEGER NOT NULL DEFAULT 0
);

-- 配方固定食材（每個 variant 的基底，全年不變）
CREATE TABLE IF NOT EXISTS recipe_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id     INTEGER NOT NULL,
  ingredient_id  INTEGER NOT NULL,
  qty_per_cup    REAL    NOT NULL,
  FOREIGN KEY (variant_id)    REFERENCES variants(id),
  FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)
);

-- 配方季節水果槽（每個 variant × season 的水果）
CREATE TABLE IF NOT EXISTS seasonal_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id     INTEGER NOT NULL,
  season_id      INTEGER NOT NULL,
  ingredient_id  INTEGER NOT NULL,
  qty_per_cup    REAL    NOT NULL,
  FOREIGN KEY (variant_id)    REFERENCES variants(id),
  FOREIGN KEY (season_id)     REFERENCES seasons(id),
  FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)
);

-- SOP 步驟
CREATE TABLE IF NOT EXISTS sop_steps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL,
  step_number   INTEGER NOT NULL,
  title         TEXT    NOT NULL,
  description   TEXT,
  timer_seconds INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- SOP 步驟確認清單
CREATE TABLE IF NOT EXISTS sop_checklist (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id INTEGER NOT NULL,
  item    TEXT    NOT NULL,
  FOREIGN KEY (step_id) REFERENCES sop_steps(id)
);

-- 庫存現況（每種食材一筆）
CREATE TABLE IF NOT EXISTS inventory (
  ingredient_id  INTEGER PRIMARY KEY,
  current_stock  REAL    NOT NULL DEFAULT 0,
  FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)
);

-- 庫存異動紀錄（進貨 / 生產耗用）
CREATE TABLE IF NOT EXISTS inventory_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_id  INTEGER NOT NULL,
  type           TEXT    NOT NULL, -- 'purchase' | 'use'
  qty            REAL    NOT NULL,
  date           TEXT    NOT NULL DEFAULT (date('now')),
  note           TEXT,
  FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)
);

-- 每日排程
CREATE TABLE IF NOT EXISTS daily_orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  date           TEXT    NOT NULL,
  variant_id     INTEGER NOT NULL,
  cups           INTEGER NOT NULL,
  deadline_time  TEXT    NOT NULL DEFAULT '13:30',
  assigned_staff TEXT,
  status         TEXT    NOT NULL DEFAULT 'pending',
  FOREIGN KEY (variant_id) REFERENCES variants(id)
);

-- 生產批次
CREATE TABLE IF NOT EXISTS production_batches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  daily_order_id  INTEGER NOT NULL,
  batch_number    INTEGER NOT NULL,
  batch_size      INTEGER NOT NULL,
  operator        TEXT,
  start_time      TEXT,
  end_time        TEXT,
  status          TEXT    NOT NULL DEFAULT 'pending',
  FOREIGN KEY (daily_order_id) REFERENCES daily_orders(id)
);

-- 步驟完成紀錄（防呆 log）
CREATE TABLE IF NOT EXISTS step_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id    INTEGER NOT NULL,
  step_id     INTEGER NOT NULL,
  completed_at TEXT   NOT NULL DEFAULT (datetime('now')),
  operator    TEXT,
  FOREIGN KEY (batch_id) REFERENCES production_batches(id),
  FOREIGN KEY (step_id)  REFERENCES sop_steps(id)
);

-- ============================================================
-- 初始資料
-- ============================================================

INSERT OR IGNORE INTO products (id, name) VALUES (1, '精力湯');

INSERT OR IGNORE INTO variants (id, product_id, name, description) VALUES
  (1, 1, '個案版', '低糖，高蔬菜比例，針對治療需求'),
  (2, 1, '員工版', '均衡口感，標準配方');

INSERT OR IGNORE INTO seasons (id, name, start_month, end_month, is_current) VALUES
  (1, '春', 3, 5, 0),
  (2, '夏', 6, 8, 1),
  (3, '秋', 9, 11, 0),
  (4, '冬', 12, 2, 0);

INSERT OR IGNORE INTO ingredients (id, name, unit, cost_per_unit, min_stock, shelf_life_days) VALUES
  (1,  '蛋白粉',   'g',  0, 500,  365),
  (2,  '燕麥粉',   'g',  0, 300,  180),
  (3,  '薑黃',     'g',  0, 100,  365),
  (4,  '羽衣甘藍', 'g',  0, 300,  5),
  (5,  '奶油萵苣', 'g',  0, 300,  5),
  (6,  '冷壓油',   'ml', 0, 200,  90),
  (7,  '水',       'ml', 0, 0,    0),
  (8,  '芒果',     'g',  0, 500,  30),
  (9,  '奇異果',   'g',  0, 300,  30),
  (10, '鳳梨',     'g',  0, 500,  30),
  (11, '草莓',     'g',  0, 300,  7),
  (12, '藍莓',     'g',  0, 200,  7),
  (13, '香蕉',     'g',  0, 200,  5),
  (14, '蘋果',     'g',  0, 500,  14),
  (15, '葡萄',     'g',  0, 300,  7),
  (16, '柳橙',     'g',  0, 300,  14),
  (17, '梨子',     'g',  0, 300,  14),
  (18, '柑橘',     'g',  0, 300,  14);

-- 個案版固定食材
INSERT OR IGNORE INTO recipe_items (variant_id, ingredient_id, qty_per_cup) VALUES
  (1, 1, 15), (1, 2, 10), (1, 3, 3), (1, 4, 50), (1, 5, 30), (1, 6, 10), (1, 7, 200);

-- 員工版固定食材
INSERT OR IGNORE INTO recipe_items (variant_id, ingredient_id, qty_per_cup) VALUES
  (2, 1, 10), (2, 2, 10), (2, 3, 2), (2, 4, 40), (2, 5, 30), (2, 6, 10), (2, 7, 200);

-- 季節水果槽
INSERT OR IGNORE INTO seasonal_items (variant_id, season_id, ingredient_id, qty_per_cup) VALUES
  -- 個案版 × 春
  (1, 1, 11, 50), (1, 1, 12, 30),
  -- 員工版 × 春
  (2, 1, 11, 60), (2, 1, 12, 40), (2, 1, 13, 30),
  -- 個案版 × 夏
  (1, 2, 8, 40),  (1, 2, 9, 40),
  -- 員工版 × 夏
  (2, 2, 8, 60),  (2, 2, 10, 50), (2, 2, 9, 40),
  -- 個案版 × 秋
  (1, 3, 14, 50), (1, 3, 15, 30),
  -- 員工版 × 秋
  (2, 3, 14, 50), (2, 3, 15, 40), (2, 3, 16, 40),
  -- 個案版 × 冬
  (1, 4, 17, 60), (1, 4, 18, 40),
  -- 員工版 × 冬
  (2, 4, 17, 60), (2, 4, 18, 50), (2, 4, 9, 40);

-- SOP 步驟
INSERT OR IGNORE INTO sop_steps (id, product_id, step_number, title, description, timer_seconds) VALUES
  (1, 1, 1, '加入粉末',     '依序加入蛋白粉、燕麥粉、薑黃，確認每項克數正確', 0),
  (2, 1, 2, '加水低速攪拌', '加入清水，低速攪拌 10 秒讓粉末充分溶解',           10),
  (3, 1, 3, '加入蔬菜',     '加入已三洗的羽衣甘藍與奶油萵苣',                   0),
  (4, 1, 4, '加入冷凍水果', '加入當季冷凍水果，高速攪拌 40 秒',                  40),
  (5, 1, 5, '停機加冷壓油', '停止攪拌後加入冷壓油，輕搖均勻',                   0),
  (6, 1, 6, '完成出杯',     '2小時內需完成食用，填寫完成記錄',                   0);

INSERT OR IGNORE INTO sop_checklist (step_id, item) VALUES
  (1, '確認蛋白粉克數正確'),
  (1, '確認燕麥粉克數正確'),
  (1, '確認薑黃克數正確'),
  (3, '蔬菜已完成三洗'),
  (3, '蔬菜外觀正常、無異味'),
  (5, '確認機器已完全停止'),
  (6, '記錄完成時間'),
  (6, '確認出杯數量正確');
