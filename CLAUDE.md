# clinic-kitchen 開發須知

診所廚房管理系統。管兩件事：**自製的精力湯**（處方展開成食材、批次製作、扣庫存、算成本）與**外購的套餐餐盒**（採購、擺盤、隨餐衛教小卡）。

上線位置：<https://clinic-kitchen-production.up.railway.app>

---

## 動手之前一定要知道的五件事

### 1. 部署是 `railway up`，不是 git push

Railway **沒有連 GitHub**（`railway status --json` 的 `source` 是 null）。推上 GitHub 不會觸發任何部署。

```bash
git push origin main      # 只是存檔
railway up --detach       # 這行才會上線
```

部署完務必實際打線上端點確認新版真的生效，不要只看 CLI 沒報錯。

### 2. GitHub repo 是**公開**的

`seijitsu0811-lab/clinic-kitchen` 是 public。**任何個案姓名、員工姓名、處方對應關係都不能出現在程式碼、註解或 `docs/` 裡。** 需要舉例就寫「某位個案」或用處方代碼（`RX-03`）。

`*.db` 已在 `.gitignore`，資料庫本身不會進版控 —— 但文件裡引用的資料會。

### 3. 資料庫在 volume 上，動 schema 前先備份

Production DB：`/data/clinic_v2.db`（`DB_PATH` 環境變數）。
系統每天自動備份到 `/data/backups`，保留 14 份，也可從設定畫面下載。

**新增 migration 一律用「純新增、冪等」的寫法**（`ALTER TABLE ... ADD COLUMN` 包在 try/catch、`CREATE TABLE IF NOT EXISTS`），放進 `server.js` 既有的 migration 陣列。

> ⚠️ **絕對不要寫「偵測到某種資料就重建整張表」的一次性遷移。**
> 這個專案發生過：`schema.sql` 每次啟動塞 14 筆固定日期的採購，而那個日期正好是某個遷移的觸發條件，該遷移又沒留執行標記 —— 結果**每次部署都把採購歷史刪光**，兩個月的資料就這樣沒了。
> 一次性遷移一定要在 `settings` 寫永久標記。

### 3.5 配方是雙週輪替的，不要寫死代號

員工與個案各有兩張處方輪流用（`rotation_group` + `rotation_index`），週期與起算日在 `settings`（`rotation_weeks` / `rotation_anchor`）。

**要拿「現在的員工處方」一律呼叫 `staffRxFor(date)`，不要自己寫 `WHERE is_staff_rx=1 ... LIMIT 1`** —— 兩張同時啟用時 LIMIT 1 是不確定的，批次和庫存會各算各的。前端與測試問 `/api/rotation/active`。

`EMP-00` 與 `RX-07` 已退役（`active=0`）但保留：歷史出單指向它們，砍掉過去的成本就算不出來。

新配方**不寫進 `schema.sql`**，而是 `installFormulaSets()` 這個有永久標記的一次性遷移 —— 放進種子的話，使用者在畫面上刪掉的用料行每次部署都會復活。

### 4. 精力湯的計算邏輯是凍結的

`buildPrepAndPowder()`、`calcBatches()`、粉類 ×1.1 的規則 —— 這些是廚房每天照著做的東西，**改動前必須先問**。加功能時只加欄位、不改既有回傳值的意義。

回歸測試的底線：`/api/today` 的批次、備料、粉配方數字必須與改動前完全一致。

### 5. 出餐狀態是「例外管理」，預設就是已出餐

排程上的東西**預設就是做了、送出去了**。使用者只標記「沒發生」的那些（`staffMissed` / `caseMissed`），正常的一天不必點任何一下。

會這樣設計是因為原本的做法失敗了：舊版要人逐一勾「拿取」，一個十人的員工日加上個案要按十四次。實際資料顯示 **8/20、8/21、8/24、8/25、8/27 幾乎每個工作日都靠隔天的自動補扣收尾**，其中兩天是整批十杯完全沒勾 —— 也就是沒有人在按。庫存準確度當時是靠安全網撐著，不是靠工作流程。

**唯一的例外：有禁忌註記（`contraindications`）的個案仍要人工核對過才算出餐。** 那是安全閘門，不能為了省點擊拿掉。

判定規則只定義在 `public/app.js` 的 `_caseDelivered()` / `_memberDelivered()` / `_batchDone()`，伺服器端在 `expectedForDate()` 讀同一份 `day_state`。**要在別處判斷有沒有出餐，從這些函式讀，不要自己再寫一次。**

扣庫存有一道時間閘門（`_timePassed()`）：預設已出餐之後，一開頁面所有批次就都是完成狀態，沒有這道閘門早上八點就會把中午的料扣掉。過了出餐時間才扣，真的沒扣到的由隔天的自動補扣接住。

---

## 三條原則（這些是踩過坑換來的）

### 一、任何規則只定義一次

2026-08 的體檢找到 13 個問題，**幾乎全是同一個病**：同一件事在兩個地方各算一次。

- 員工供應日曾寫死在 6 個地方（出席判定、庫存試算、SOP 文字 ×4）
- 休假姓名比對前端做小寫轉換、後端沒做 → 前後端算出不同杯數
- 批次分組前端自己算一份、伺服器也算一份

現在供應日只在 `STAFF_MEAL_DOWS` 定義一次，連 SOP 頁面的文字都是讀它產生的。**要在別處用，就從定義讀，不要複製。**

同一件事的另一面：**一個實體只建一筆資料**。

蘋果曾被建成「蘋果(帶皮)」與「蘋果(純皮)」兩個食材 —— 那是同一堆蘋果的兩種處理方式。結果純皮那項從來沒被採購過，庫存永遠 0、單價永遠 $0，用到它的處方成本算不出來又永遠顯示缺貨，而真正的蘋果消耗沒被算進需求，系統於是說「夠」，實際上差 20g 就見底。

**處理方式（帶皮／去皮／打泥）是配方那一行的屬性（`prescription_ingredients.prep`），不是另一種物料。** 要新增食材前先問：這是不是已經有的東西換個做法？

> 改食材名稱時注意：**改名必須在 `db.exec(schema.sql)` 之前**。schema 的種子資料是用名稱找食材的，改名放在後面會讓它以為食材不存在而新建一筆（id 也變），接著 `prescription_ingredients` 的種子就用預設份量把真實配方蓋掉。
>
> 這條規則在 2026-08 被踩了第二次：把「莓果」改名成「綜合莓」的那段寫在遷移裡（schema.sql 之後），
> 種子就重新建了一個「莓果」並塞回 EMP-00 與 RX-01 的配方，同一張處方同時有兩種莓，熱量多算 10 kcal。
> 改名一律放進檔案上方那個「schema.sql 之前」的區塊，**而且 `schema.sql` 裡的種子名稱要一起改**，否則下次部署又生一筆。

### 二、讓系統自己抓矛盾，不要靠人用眼睛核對

已經做了四處，新功能請比照：

| 位置 | 抓什麼 |
| :-- | :-- |
| 今日頁對帳列 | 批次杯數 ＋ 個別現打 ≠ 應有總數 → 跳紅字 |
| 批次分組 | 已入批人數 ≠ 名單人數 → 重排並報錯 |
| 批次時間 | 同一批成員取餐時間不一致 → 標警告 |
| 消耗紀錄 | 應扣的 vs 實際扣的 → 隔日補差額 |

### 三、會刪資料或自動改資料的程式，一定要留痕跡而且能還原

- 刪資料 → 寫執行標記，記錄做了什麼
- 自動改資料 → 使用者看得到（今日頁的自動補扣通知），而且有還原按鈕
- 盤點覆寫庫存 → 存 who／when／帳面／實際／差異

---

## 架構速覽

```
自製品（精力湯）
  prescriptions → prescription_ingredients → ingredients / inventory
                                                    ↓
                                              purchase_log（加權平均，只看近 N 天）
                                                    ↓
  staff_attendance + case_orders → /api/today（批次、備料、粉配方）→ /api/costs

外購品（餐盒）             ← 刻意與上面分開，生命週期完全不同
  vendors → meal_series → meal_items → meal_orders → meal_purchase_log

共用狀態（整個廚房看同一份，不是每台裝置一份）
  day_state：批次分組、拿取勾選、已扣庫存、備註、品質確認清單

稽核
  consumption_log：每一次扣庫存
  stocktakes / stocktake_items：盤點與差異
```

**共用狀態一律放伺服器。** `localStorage` 只准放兩種東西：這台裝置登入誰（`kitchen_user`）、離線備援（`clinic_day_*`）。批次分組曾經存在 localStorage，導致兩台裝置看到不同的批次還少了一個人。

---

## 測試

改完一定要跑，六套都要過（共 65 項）。

```bash
PORT=3999 node server.js            # 另一個終端機
node scripts/test-meals.mjs         # 26 項：套餐、熱量、採購模式、小卡閘門
node scripts/test-day-state.mjs     # 10 項：休假比對、出席自洽、狀態共用
node scripts/test-inventory.mjs     # 14 項：消耗紀錄、補差額、盤點、備份
node scripts/test-case-orders.mjs   #  7 項：出單 CRUD、改處方會存進去
node scripts/test-exceptions.mjs    #  8 項：例外管理有沒有真的影響應扣量
node scripts/test-appt-sync.mjs     #  9 項：預約帶入、改過的不被覆蓋（假日會略過）
```

`test-exceptions` 會自己造出席與出單，不依賴當天剛好有資料 —— 週末跑起來全部略過而「通過」的測試等於沒有測試。

測試會自己清乾淨，但**跑之前先確認沒有殘留的 node 行程開著同一個資料庫** —— 多個伺服器同時跑會讓數字對不上，查半天以為是 bug。

```bash
Get-Process node | Stop-Process -Force    # PowerShell
```

---

## 認證

所有 `/api/*` 都在中介層後面（需要 `X-Kitchen-User-Id`），只有 `/api/public/users` 是公開的（登入畫面要列人員）。新端點註冊位置一定要在中介層**之後**。

只有 `John` 這個帳號有密碼（`KITCHEN_PASSWORD` 環境變數），其餘免密碼。這不是權限分級，只是單一帳號保護。

---

## 相關文件

| 文件 | 內容 |
| :-- | :-- |
| `docs/SYSTEM_AUDIT_2026-08.md` | 全系統邏輯檢查：13 個問題與修正 |
| `docs/MEAL_SET_MODULE_DESIGN.md` | 套餐模組設計：資料模型、API 邊界、決議 |
