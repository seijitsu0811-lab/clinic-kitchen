# 套餐模組設計文件（Meal Set Module）

**系統**：診所廚房管理系統 `clinic-kitchen`
**版本**：v1.3
**日期**：2026-08-22（2026-08-25 補充交叉引用）
**狀態**：已部署至 Railway production｜本模組測試 26 項全數通過

> 2026-08-25 對整套系統做過一次全面邏輯體檢，找到並修正 13 個問題（其中包含會刪光採購歷史的一顆未爆彈）。
> 那次同時把**員工供應日改為週二、週五**，並改寫了工時與食材成本的計算方式。
> 本文件只涵蓋套餐模組本身，系統層級的變更請看 **`docs/SYSTEM_AUDIT_2026-08.md`**。
> 開發前必讀專案根目錄的 `CLAUDE.md`。

---

## 1. 背景

現行系統管理的是**自製品**：精力湯。它的資料流是

```
prescriptions（處方）
  └─ prescription_ingredients（每杯用量）
       └─ ingredients / inventory（食材與庫存）
            └─ purchase_log（加權平均成本）
                 └─ /api/today（備料單、批次、粉配方）
                      └─ /api/costs（每杯成本、月報）
```

新需求（喜悅診所醫學級精品調理套餐）帶進來的是**外購品**：9 款餐盒，來自 3 間合作店家。

> **套餐 = 1 份外購餐盒（診所重新擺盤）＋ 1 杯自製精力湯 ＋ 1 張隨餐衛教小卡**

外購品和自製品的生命週期完全不同：

|      | 精力湯（現有）           | 餐盒（新增）             |
| :--- | :----------------------- | :----------------------- |
| 來源 | 自製，BOM 展開到食材     | 外部採購，整份買進       |
| 成本 | 食材加權平均 ＋ 工時     | 採購單價（含稅）         |
| 庫存 | 有（有效期、安全庫存）   | 無（當日買當日出）       |
| 熱量 | **可由配方計算**         | **只能引用店家公告值**   |
| 變動 | 處方每人不同             | 菜單／價格由店家決定     |
| 品牌 | 診所自有                 | **對個案必須完全隱形**   |

因此本設計的第一個判斷是：**餐盒不塞進 `ingredients`／`prescription_ingredients`**，另建 domain。

---

## 2. 目標與非目標

### Goals

| ID | 目標 | 驗收方式 |
| :-- | :-- | :-- |
| G1 | 廚房後台每日可建立套餐出單（餐盒 ＋ 精力湯綁定） | 今日頁看得到「今天要買幾個便當、哪家、哪個主菜」 |
| G2 | 熱量有**單一真實來源**，不硬編 | 改處方 → 菜單熱量自動變動 |
| G3 | 客人端菜單**零外部品牌洩漏**，由 API 保證而非 UI 約定 | `/api/public/menu` 回應中不存在 vendor 欄位 |
| G4 | 出餐時可依當日出單自動列印對應衛教小卡 | 一鍵印出今日 N 張小卡 |
| G5 | 餐盒採購成本進入既有成本報表 | 月報出現「餐盒」成本列 |
| G6 | 菜單改版後，歷史單據仍能還原當時的品名／熱量／價格 | 查 3 個月前的單，數字不被今天的菜單覆蓋 |

### Non-goals（本期不做）

- 線上金流／付款／發票
- 與 3 間餐廳的系統 API 對接（本期仍為人工採購，系統只產採購單）
- 動 `/api/today` 現有精力湯的批次／粉配方計算邏輯（**零回歸**是硬要求）
- 個案端自助點餐（本期菜單頁為唯讀展示）

---

## 3. 關鍵設計決策

### D1：熱量用「算」的，不用「填」的 —— 精力湯的 408 kcal 是錯的

原稿菜單把精力湯固定標示為 **408 kcal**。查現行資料庫後，這個數字不成立。

**（a）系統裡的實際配方跟菜單假設不同**

`EMP-00 員工標準` 的實際用量：

| 食材   | 系統實際  | 菜單假設 | 差異                            |
| :----- | -------: | -------: | :------------------------------ |
| 蛋白粉 | **25 g** |     20 g | +5 g ＝ +19 kcal                |
| 橄欖油 | **20 ml**|     20 g | ml≠g，20 ml ≈ 18.3 g ＝ −15 kcal |

用同一組營養密度重算 `EMP-00`，得 **≈ 412 kcal**，不是 408。

**（b）更關鍵：每張處方都不一樣**

實作後用系統實際算出來的數字（袋裝，未乘 1.1）：

> 本專案的 GitHub repo 是公開的，因此下表只列處方代碼，不列個案姓名。
> 對照關係請在系統內（處方管理）查看。

| 處方 | 類型 | 蛋白粉 | 橄欖油 | 食材項數 | **實際熱量** | 蛋白質 |
| :-- | :-- | --: | --: | --: | --: | --: |
| `EMP-00` | 員工標準 | 25 g | 20 ml | 12 | **412 kcal** | 25.2 g |
| `RX-01` | 個案 | 20 g | 20 ml | 18 | **580 kcal** | 21.6 g |
| `RX-02` | 個案 | 30 g | 15 ml | 13 | **365 kcal** | 27.7 g |
| `RX-03` | 個案 | 25 g | 15 ml | 15 | **303 kcal** | 23.1 g |
| `RX-04` | 個案 | 30 g | 15 ml | 17 | **433 kcal** | 30.3 g |
| `RX-05` | 個案 | 20 g | 15 ml | 16 | **363 kcal** | 21.1 g |
| `RX-06` | 個案 | 25 g | 20 ml | 16 | **453 kcal** | 26.4 g |
| `RX-07` | 員工 | 25 g | 20 ml | 11 | **410 kcal** | 25.2 g |

實際跨度是 **303 – 580 kcal**，比原先估的 390–430 大得多 —— 最低與最高差了近一倍。`全配方／罐裝` 的粉類還要再乘 **1.1 倍**（`server.js` 既有邏輯），例如 RX-06 袋裝 453 kcal、全配方 472 kcal。

把 408 印在菜單上，8 位個案沒有一位是對的。

**決策**：

- `ingredients` 增加營養欄位（`kcal_per_unit`、`protein_per_unit`、`nutrition_source`）
- 精力湯熱量 ＝ `Σ(qty_per_cup × kcal_per_unit) × powder_multiplier`，由 API 即時算出
- 餐盒熱量無法計算（外購），存為固定值，但**必須標註來源與日期**
- **不做匿名通用菜單**：菜單一律依個案顯示該處方算出的精確熱量（決議 Q5）

> 這是整份設計中唯一「不照原稿做」的地方。原因是照做會印出可驗證為錯的數字給個案看。

### D2：餐盒自成 domain，用 `vendors → meal_series → meal_items`

不重用 `products`／`prescriptions`。理由：

- `products` 的語意是「可被處方展開成食材的自製品」，`batch_size`／`prescription_ingredients` 對餐盒無意義
- 混用會讓 `/api/today`、`/api/costs` 的既有查詢被迫加 `WHERE type<>'餐盒'` 過濾條件，是典型的技術債起點

三層而非兩層的理由：**「風味系列」是客人看到的分類，「店家」是後台的採購對象**，兩者必須可以獨立變動。換一家供應商時，改的是 `meal_series.vendor_id`，客人端菜單一個字都不用動 —— 這在本專案已經發生過一次（第三系列從「蛋白盒子」換成「樂坡舒肥」）。

### D3：無痕出餐由 API 邊界保證，不靠前端隱藏

診所的「無痕擺盤」規範要求個案看不到任何外部餐廳品牌。若只是前端不渲染 vendor 欄位，一次 DevTools／一次 API 誤用就洩漏。

**決策**：兩條完全獨立的讀取路徑

| 路徑 | 認證 | 內容 |
| :-- | :-- | :-- |
| `GET /api/meals/menu` | 需 `x-kitchen-user-id`（既有中介層） | 完整，含店家、成本、單點價 |
| `GET /api/meals/menu/case` | 需 `x-kitchen-user-id` | **SQL 層就不 SELECT vendor**，只回 display_name / kcal / protein / series |

因為決議 Q5 取消了匿名通用菜單，個案檢視改走 `/api/meals/menu/case`（由診所人員在平板上開啟），**沒有免認證端點**。這條路徑的 SQL 明確列出欄位（不用 `SELECT *`），並加註解說明這是隱私邊界。

驗證方式：對回應全文搜尋 `vendor`、`樂芙`、`七福`、`樂坡`、`Bonbox`、`price`、`cost` —— 全部零命中（已納入測試）。

### D4：出單存「快照」，不只存外鍵

店家價格與菜單會變（本專案 3 週內已換過一次店家、改過多次熱量）。若 `meal_orders` 只存 `meal_item_id`，翻 3 個月前的成本報表時會拿到今天的價格，帳就對不起來。

**決策**：`meal_orders` 建立時寫入不可變快照 `snap_display_name` / `snap_kcal` / `snap_price`。歷史查詢一律讀快照，`meal_item_id` 只用於統計分群。

（此模式與現有 `purchase_log` 記錄當下 `total_price` 的作法一致。）

### D5：衛教小卡是「資料」不是「圖片」

10 張小卡（1 精力湯 ＋ 9 餐盒）存進 `nutrition_cards` 表，列印頁由資料即時渲染。

- 改一句文案不用重做圖
- 可依當日 `meal_orders` 自動決定要印哪幾張
- 精力湯那張可帶入該個案的**實際處方熱量**（呼應 D1）

### D6：沿用既有的 migration 慣例

`server.js` 現有作法是一組 `try/catch` 包住的 idempotent SQL 陣列。新表與新欄位**沿用同一機制**，不引入 migration framework。理由：單檔部署、Railway 上只有一個 instance、既有作法可用且團隊熟悉。

---

## 4. 資料模型

### 4.1 新表

```sql
-- ── 合作店家（僅後台可見）────────────────────────────────
CREATE TABLE IF NOT EXISTS vendors (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  branch        TEXT DEFAULT '',
  phone         TEXT DEFAULT '',
  walk_minutes  INTEGER DEFAULT 0,
  order_note    TEXT DEFAULT '',        -- 訂餐方式／截單時間
  active        INTEGER DEFAULT 1
);

-- ── 風味系列（客人看得到的分類）──────────────────────────
CREATE TABLE IF NOT EXISTS meal_series (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,     -- L1 / J2 / B3
  name        TEXT NOT NULL,            -- 舒肥清爽輕食風味
  tagline     TEXT DEFAULT '',
  vendor_id   INTEGER,                  -- 內部對接；public API 不輸出
  sort_order  INTEGER DEFAULT 0,
  active      INTEGER DEFAULT 1,
  FOREIGN KEY (vendor_id) REFERENCES vendors(id)
);

-- ── 餐盒品項（9 款）──────────────────────────────────────
CREATE TABLE IF NOT EXISTS meal_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT NOT NULL UNIQUE,      -- SET-L1-PORK
  series_id        INTEGER NOT NULL,
  protein          TEXT NOT NULL,             -- 豬 / 雞 / 魚
  display_name     TEXT NOT NULL,             -- 客人看：薑汁味噌甘露豬
  vendor_item_name TEXT DEFAULT '',           -- 後台採購用：薑汁味噌豬
  kcal             REAL DEFAULT 0,
  protein_g        REAL DEFAULT 0,
  kcal_source      TEXT DEFAULT '店家公告',    -- 店家公告 / 內部估算
  nutrition_as_of  TEXT DEFAULT '',           -- 數據取得日期
  price_single     INTEGER DEFAULT 0,         -- 單點主菜價
  price_box        INTEGER DEFAULT 0,         -- 整份餐盒價
  default_mode     TEXT DEFAULT '餐盒',        -- 餐盒 / 單點
  sort_order       INTEGER DEFAULT 0,
  active           INTEGER DEFAULT 1,
  FOREIGN KEY (series_id) REFERENCES meal_series(id)
);

-- ── 隨餐衛教小卡（1 精力湯 + 9 餐盒）────────────────────
CREATE TABLE IF NOT EXISTS nutrition_cards (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL UNIQUE,          -- CARD-TONIC / CARD-L1-PORK
  subject_type TEXT NOT NULL,                 -- product / meal_item
  subject_id   INTEGER NOT NULL,
  headline     TEXT NOT NULL,                 -- 暖胃循行・優質蛋白質滋補
  ratio_line   TEXT DEFAULT '',               -- 黃金營養配比
  story        TEXT DEFAULT '',               -- 健康故事
  reviewed_by  TEXT DEFAULT '',               -- 法遵／醫師覆核人（見 §8）
  reviewed_at  TEXT DEFAULT '',
  updated_at   TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(subject_type, subject_id)
);

-- ── 每日餐盒出單（與 case_orders 平行）──────────────────
CREATE TABLE IF NOT EXISTS meal_orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  date              TEXT NOT NULL,
  meal_item_id      INTEGER NOT NULL,
  qty               INTEGER NOT NULL DEFAULT 1,
  meal_time         TEXT DEFAULT '1330',
  patient_name      TEXT DEFAULT '',
  case_order_id     INTEGER,                  -- 綁定的精力湯出單；NULL = 只訂餐盒
  purchase_mode     TEXT DEFAULT '餐盒',       -- 餐盒 / 單點
  status            TEXT DEFAULT '待採購',      -- 待採購→已採購→已擺盤→已出餐
  -- 不可變快照（D4）
  snap_display_name TEXT DEFAULT '',
  snap_kcal         REAL DEFAULT 0,
  snap_price        INTEGER DEFAULT 0,
  notes             TEXT DEFAULT '',
  source_key        TEXT DEFAULT '',          -- 預約帶入用，比照 case_orders
  created_at        TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (meal_item_id)  REFERENCES meal_items(id),
  FOREIGN KEY (case_order_id) REFERENCES case_orders(id)
);
CREATE INDEX IF NOT EXISTS idx_meal_orders_date ON meal_orders(date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meal_orders_source
  ON meal_orders(source_key) WHERE source_key <> '';
```

### 4.2 既有表擴充

```sql
-- 營養資料（支撐 D1 的熱量計算）
ALTER TABLE ingredients ADD COLUMN kcal_per_unit    REAL DEFAULT 0;
ALTER TABLE ingredients ADD COLUMN protein_per_unit REAL DEFAULT 0;
ALTER TABLE ingredients ADD COLUMN nutrition_source TEXT DEFAULT '';
```

`purchase_log` **不動**：已有 `item_type` / `purpose` 兩欄，但 `purchase_log.ingredient_id` 有 FK 指向 `ingredients`，餐盒沒有對應食材 → **需先確認**：改為 nullable，或另建 `meal_purchase_log`。建議後者（見 §9 未決問題 Q4）。

### 4.3 種子資料（9 款餐盒）

| code | 系列 | 主菜 | 客人看到的品名 | 採購品名 | kcal | 蛋白 | 單點 | 餐盒 | 熱量來源 |
| :-- | :-- | :-: | :-- | :-- | --: | --: | --: | --: | :-- |
| `SET-L1-PORK` | L1 | 豬 | 薑汁味噌甘露豬 | 薑汁味噌豬 | 540 | 33 g | 60 | 140 | 店家公告 |
| `SET-L1-CHICK` | L1 | 雞 | 水嫩舒肥鮮雞胸 | 水嫩雞胸肉 | 453 | 37 g | 70 | 150 | 店家公告 |
| `SET-L1-FISH` | L1 | 魚 | 泰式檸檬清蒸鱸魚 | 泰式檸檬鱸魚 | 553 | 35 g | 90 | 170 | 店家公告 |
| `SET-J2-PORK` | J2 | 豬 | 和風炙燒豚肉 | 豚福燒肉 | 450 | — | 139 | 249 | **內部估算** |
| `SET-J2-CHICK` | J2 | 雞 | 青檸慢烤嫩雞腿 | 青檸烤雞腿 | 480 | — | 179 | 279 | **內部估算** |
| `SET-J2-FISH` | J2 | 魚 | 極鮮鹽烤鯖魚 | 鹽烤鯖魚 | 520 | — | 189 | 269 | **內部估算** |
| `SET-B3-PORK` | B3 | 豬 | 椒鹽輕嫩梅花豬 | 椒鹽梅花豬 | 626 | 33 g | 49 | 125 | 店家公告 |
| `SET-B3-CHICK` | B3 | 雞 | 厚切慢熟嫩雞胸 | 厚切嫩雞胸 | 598 | 51 g | 89 | 155 | 店家公告 |
| `SET-B3-FISH` | B3 | 魚 | 檸香輕嫩巴沙魚 | 檸香巴沙魚 | 474 | — | 59 | 130 | 店家公告 |

系列 → 店家對照（**僅後台**）：

- `L1 → 樂芙健康餐盒（南京龍江店，02-2508-2882）`
- `J2 → 七福食所（遼寧街）`
- `B3 → 樂坡舒肥健康餐 Bonbox（南京龍江店）`

> J2 三款標為「內部估算」：這三筆熱量在需求討論過程中是推估值，不是店家公告。上線前應向七福食所索取正式營養標示並更新 `kcal_source`。菜單上「估算」與「公告」應有不同的標示措辭。

---

## 5. API 設計

全部端點都走既有的 `x-kitchen-user-id` 中介層，沒有新增免認證路徑。

| Method | Path | 用途 |
| :-- | :-- | :-- |
| GET | `/api/nutrition/prescription/:id` | **精力湯熱量計算**（支撐 D1），可帶 `?powder_type=` |
| GET | `/api/meals/menu` | 後台完整菜單（含店家、單點價） |
| GET | `/api/meals/menu/case` | **個案檢視菜單（無店家、無價格）**，帶 `?prescription_id=&powder_type=` |
| GET | `/api/meals/today` | 今日餐盒出單 ＋ 依店家分組的採購清單 |
| POST | `/api/meals/orders` | 新增餐盒出單（可帶 `case_order_id` 綁精力湯） |
| PUT | `/api/meals/orders/:id` | 改數量／時段／模式／狀態（換模式會同步換快照） |
| DELETE | `/api/meals/orders/:id` | 刪單（預約帶入的會記進 `meal_sync_dismissed`） |
| POST | `/api/meals/purchase` | 採購回填（實付金額）→ 寫採購紀錄、狀態轉「已採購」 |
| GET | `/api/meals/purchases` | 某月的餐盒採購明細 |
| DELETE | `/api/meals/purchases/:id` | 刪除採購紀錄 |
| PUT | `/api/meals/items/:id` | 維護品項（改價、改熱量、改來源、停用） |
| GET | `/api/meals/cards` | 全部 10 張小卡（含覆核狀態） |
| PUT | `/api/meals/cards/:id` | 編輯文案或標記覆核 |
| GET | `/api/meals/cards/today` | 今日出單對應的小卡（列印用，含 `printable` 旗標） |

### `/api/public/menu` 回應範例（隱私邊界）

```json
{
  "tonic": {
    "name": "喜悅綠活力精力湯",
    "volume_ml": 250,
    "kcal_display": "約 400–430 kcal",
    "note": "依個人處方微調"
  },
  "series": [{
    "name": "舒肥清爽輕食風味",
    "tagline": "低溫慢煮，好咬好消化",
    "items": [
      { "protein": "豬", "name": "薑汁味噌甘露豬",
        "kcal": 540, "kcal_note": "約",
        "set_kcal_range": "約 940–970 kcal" }
    ]
  }]
}
```

回應中**不存在** `vendor` / `vendor_item_name` / `price_single` / `cost` 任何欄位。

### `/api/meals/today` 的採購清單（後台核心價值）

依店家分組聚合，一家一張採購單，直接對應「走過去買」的動作：

```json
{
  "date": "2026-08-22",
  "purchase_lists": [{
    "vendor": "樂芙健康餐盒",
    "branch": "南京龍江店", "phone": "02-2508-2882", "walk_minutes": 3,
    "lines": [
      { "item": "薑汁味噌豬", "mode": "餐盒", "qty": 2, "unit_price": 140, "subtotal": 280 },
      { "item": "水嫩雞胸肉", "mode": "單點", "qty": 1, "unit_price": 70,  "subtotal": 70 }
    ],
    "total": 350
  }]
}
```

---

## 6. 前端設計

### 6.1 後台：新增第 6 個頁籤 🍱 套餐

沿用既有 `data-tab` ／ `App.switchTab()` ／ `.page` 三件組（`public/index.html:2039`、底部 `tabbar:2155`），無需改動框架。

```
🍱 套餐
├─ 今日採購單    ← 依店家分組，可勾選「已買」
├─ 菜單維護      ← 9 款品項改價／改熱量／停用
└─ 小卡管理      ← 10 張文案編輯、列印預覽
```

### 6.2 今日頁整合

**頁面最上方**是餐盒行動列：買便當是一天中唯一有截止時間的事，所以它排在精力湯備料之前，而不是捲三分之二頁之後。

出發時間由系統算出，不是人工填的：

```
出發時間 = 最早用餐時間 − ( Σ每間店(來回步行 × 2 + 取餐等候 5 分) + 擺盤緩衝 10 分 )
```

超過出發時間，行動列轉紅並標示「已超過出發時間」；全部買完後整條消失。金額只計還沒買的部分。

`#productSections` 之後另有「🍱 今日餐盒」出餐清單，狀態晶片可直接推進。**不動既有精力湯區塊的 DOM**，避免回歸。

### 6.2b 採購／出餐雙檢視

採購清單（上午、依店家）與出餐核對（中午、依個案）是一天中的不同時刻，做成切換而非同時攤開。手機頁高因此從 1495px 降到 1138px。

**採購以店家為單位**：一趟採購 ＝ 一間店 ＝ 一張收據 ＝ 一個總額，所以是「這間買齊了・填總金額」一顆按鈕（3 間店 5 個品項時，點擊數 5 → 3）。後端按預計金額比例把總額拆回各品項、餘數算在最後一列，因此每品項成本仍可分析，總額又與收據精準相符。

### 6.2c 出單狀態

`待採購 → 已採購 → 已擺盤 → 已出餐`，點狀態晶片往前推一格，點錯了在編輯視窗改回來。「已擺盤」對應 SOP 的拆盒轉盤步驟。

### 6.2d 觸控尺寸（僅套餐頁）

廚房是站著操作、手可能是濕的。套餐頁的觸控目標比全站慣例大一號：`.btn-sm` 最小高 44px、店家卡主按鈕 48px、店家資訊 12px → 14px（站在店門口要看電話）。**全站其他頁維持原慣例不動**，避免視覺不一致。

### 6.3 客人端菜單 `/menu.html`（80 歲可讀）

獨立 HTML，不進廚房後台認證流程。可讀性硬規格：

| 項目 | 規格 |
| :-- | :-- |
| 品名字級 | ≥ 32 px bold |
| 內文字級 | ≥ 22 px |
| 文字對比 | ≥ 7:1（WCAG AAA） |
| 主菜標籤 | 🥩豬／🍗雞／🐟魚 色塊 ＋ 圖示雙編碼（不單靠顏色，避免色覺障礙） |
| 版面 | 單欄直式，一頁一系列，無橫向捲動 |
| 分類 | **不出現 A／B／C 代號**，只有風味名稱 |

### 6.4 小卡列印 `/print/cards?date=`

A6 尺寸、每頁 4 張、`@media print` 去除瀏覽器頁首頁尾。依當日 `meal_orders` 自動決定張數與內容。

---

## 7. 上線階段規劃

| Phase | 內容 | 風險 | 可獨立上線 |
| :-: | :-- | :-: | :-: |
| **P0** | 建表 ＋ 種子資料 ＋ `ingredients` 營養欄位 | 極低（純新增，不動既有讀寫） | ✅ |
| **P1** | 熱量計算 API ＋ 後台菜單維護頁 | 低 | ✅ |
| **P2** | 今日餐盒出單 ＋ 採購清單 | 中（碰 `/api/today` 回應結構，需加欄不改欄） | ✅ |
| **P3** | 客人端菜單頁 ＋ 小卡列印 | 低 | ✅ |
| **P4** | 成本報表整合 ＋ 預約系統帶入餐盒 | 中（碰 `/api/costs` 與 `syncApptOrders`） | ✅ |

每個 Phase 都能單獨部署且可回滾（新表 drop、新欄位留著不用即可）。

### 回歸測試底線（每個 Phase 都要過）

1. `/api/today` 的精力湯批次、備料、粉配方數字與上線前完全一致
2. `/api/costs/monthly` 既有月份總額不變
3. `syncApptOrders` 不重複建單（`source_key` unique index 仍生效）
4. 未帶 `x-kitchen-user-id` 時，除 `/api/public/*` 與 `/health` 外全部 401

---

## 8. 風險

### R1：衛教小卡的療效宣稱（**優先度最高，非技術問題**）

原稿小卡包含以下敘述：

- 「提升 **2,000%** 薑黃素生物利用率」
- 「鱸魚自古被譽為**開刀與調養聖品**」
- 「**驅退**體內發炎反應」

診所對個案發放的文宣屬醫療廣告範疇，此類效能宣稱有《醫療法》第 86 條、《食品安全衛生管理法》第 28 條（不得誇大易生誤解）的合規風險。

**設計對策**：`nutrition_cards` 已保留 `reviewed_by` / `reviewed_at` 欄位。建議**未經覆核的小卡不得列印**（列印 API 檢查 `reviewed_at` 非空）。實際文案是否調整由診所醫師／法遵決定，非工程判斷。

### R2：熱量數字的可信度

J2 系列 3 款為內部估算值。菜單上「估算」與「店家公告」需不同措辭，且 `nutrition_as_of` 超過 6 個月應在後台跳提醒。

### R3：店家價格變動

已由 D4 的快照機制吸收。另建議後台菜單維護頁顯示「上次更新日期」。

### R4：`/api/public/menu` 免認證

與既有 `/api/public/users` 同層級。此端點只回菜單文案與熱量，不含個案資料、不含店家、不含成本，無 PII。可接受。

---

## 9. 決議

| # | 問題 | 決議 | 實作方式 |
| :-: | :-- | :-- | :-- |
| **Q1** | 整盒買 vs 只單點主菜 | **兩種都要，逐單決定** | `meal_orders.purchase_mode`。`meal_items` 同時存整盒與單點兩組熱量與價格；建單時選模式，改模式時快照價格與熱量同步換掉 |
| **Q2** | 個案菜單是否公開 | 不公開 | 隨 Q5 一併取消匿名端點，`menu.html` 由診所人員登入後開啟 |
| **Q3** | 套餐售價 | 本期不做 | `settings` 維持原樣，只管採購成本 |
| **Q4** | 餐盒採購紀錄放哪 | **另建 `meal_purchase_log`** | `purchase_log` 的 `unitCost()` 假設每列都對應一個食材，混入非食材列會污染精力湯每杯成本 |
| **Q5** | 精力湯熱量標區間 vs 精確值 | **一律精確值，不做通用菜單** | `menu.html` 需帶 `prescription_id`；熱量由該處方即時算出，含 `全配方／罐裝` 的 1.1 倍 |

### 單點模式的熱量待確認

`kcal_single` 目前是**依整盒熱量推估的主菜佔比**（例如薑汁味噌豬整盒 540 → 單點 250），不是店家公告值。第一次實際單點採購後，請在「套餐 → 菜單維護」把真實數字改進去，並把 `熱量來源` 改成「店家公告」。

---

## 11. 實作結果

### 動到的檔案

| 檔案 | 變更 |
| :-- | :-- |
| `server.js` | 新增套餐模組 schema／種子資料／食材營養密度；13 個 API 端點；`/api/today` 加掛 `meals`；`calcDailyCost` 與月報加入餐盒成本 |
| `public/index.html` | 新增「🍱 套餐」頁籤與三個子頁、今日頁餐盒區塊、5 個 modal、套餐模組樣式 |
| `public/app.js` | 套餐模組的載入、渲染與 CRUD；掛進既有 `switchTab` |
| `public/menu.html` | **新檔**：個案檢視菜單（大字高對比） |
| `public/cards.html` | **新檔**：隨餐小卡列印（A6，A4 一頁四張） |
| `docs/MEAL_SET_MODULE_DESIGN.md` | 本文件 |

既有的精力湯計算邏輯（`buildPrepAndPowder`、`calcBatches`、`unitCost`）**一行都沒有改**。

### 測試

21 項自動測試涵蓋熱量計算、兩種採購模式、快照、店家分組、採購回填、小卡覆核閘門、成本整合，以及精力湯零回歸。

```bash
PORT=3999 node server.js   # 另開一個終端機
node scripts/test-meals.mjs
```

### UI 檢視後的調整（v1.2）

第一版做完後對照實際工作流程檢視，量測結果與修正：

| 問題 | 量測 | 處置 |
| :-- | :-- | :-- |
| 買便當沒有時間資訊 | 店家卡只有步行分鐘數 | 今日頁頂部行動列，算出「幾點要出發」 |
| 買便當埋在頁面 67% 處 | 1314px / 全頁 1961px | 行動列移到頁面最上方 |
| 一趟採購要按 5 次已買 | 3 間店 5 個品項 | 改為每間店一顆按鈕，5 → 3 次 |
| 狀態流只走到一半 | 4 個狀態只有 2 個可達 | 狀態晶片可推進到已出餐 |
| 同一批資料呈現兩次 | 手機頁高 1495px | 採購／出餐改為切換，降到 1138px |
| 觸控目標過小 | 10 個按鈕 < 44px | 套餐頁全部 ≥ 44px，主按鈕 48px |
| 個案菜單要 5 步 | 選處方 → 選包裝 → 開新分頁 | 個案列直接一鍵開啟 |
| 個案菜單對比不足 | 「約略值」5.92:1，低於 7:1 規格 | 改用專用深琥珀，9.74:1 |

### 部署狀態

- 已上線：<https://clinic-kitchen-production.up.railway.app>
- Production DB 在 volume `/data/clinic_v2.db`，migration 為純新增且冪等
- 線上實測 8 張處方熱量皆算得出（範圍 **371–589 kcal**），僅水與 AstragIN 為 0，屬預期

### 仍待處理（本模組）

- **10 張衛教小卡全部未覆核** → 列印功能會擋住不印，這是刻意的（見 R1）
- **單點熱量仍是推估值** → 第一次實際單點採購後請更新
- **七福食所 3 款熱量為內部估算** → 待店家提供正式營養標示

系統層級的待辦（實體盤點、離線備份、工時參數校準）列在 `docs/SYSTEM_AUDIT_2026-08.md`。

---

## 10. 附錄：精力湯熱量計算基準

`ingredients.kcal_per_unit` 初始值（每 1 g，橄欖油為每 1 ml）：

| 食材 | kcal/單位 | 來源 |
| :-- | --: | :-- |
| 羽衣甘藍 | 0.35 | USDA |
| 貝比生菜 | 0.20 | USDA |
| 蘋果(帶皮) | 0.52 | USDA |
| 檸檬 | 0.29 | USDA |
| 莓果 | 0.50 | USDA |
| 香蕉 | 0.89 | USDA |
| 燕麥 | 3.89 | USDA |
| 核桃 | 6.54 | USDA |
| 薑黃粉 | 3.54 | USDA |
| 蛋白粉 | 3.80 | 產品標示 |
| 黑胡椒 | 2.51 | USDA |
| 橄欖油 | **8.10 /ml** | 884 kcal/100 g × 0.916 g/ml |

驗算 `EMP-00`（25 g 蛋白粉、20 ml 橄欖油）＝ **412 kcal**（原稿 408 kcal 的假設為 20 g 蛋白粉、20 g 橄欖油）。

其餘食材（甜菜根、木瓜、鳳梨、奇異果、小麥草、胡蘿蔔、肉桂粉、薑粉、藜麥粉、益生菌、苦茶油、酪梨油、MCT、亞麻仁油、AstragIN、Senactiv、水）於 P0 一併補齊，才能涵蓋 RX-01～RX-07 全部處方。
