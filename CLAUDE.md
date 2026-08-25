# clinic-kitchen 開發須知

診所廚房管理系統。管兩件事：**自製的精力湯**（處方展開成食材、批次製作、扣庫存、算成本）與**外購的套餐餐盒**（採購、擺盤、隨餐衛教小卡）。

上線位置：<https://clinic-kitchen-production.up.railway.app>

---

## 動手之前一定要知道的四件事

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

### 4. 精力湯的計算邏輯是凍結的

`buildPrepAndPowder()`、`calcBatches()`、粉類 ×1.1 的規則 —— 這些是廚房每天照著做的東西，**改動前必須先問**。加功能時只加欄位、不改既有回傳值的意義。

回歸測試的底線：`/api/today` 的批次、備料、粉配方數字必須與改動前完全一致。

---

## 三條原則（這些是踩過坑換來的）

### 一、任何規則只定義一次

2026-08 的體檢找到 13 個問題，**幾乎全是同一個病**：同一件事在兩個地方各算一次。

- 員工供應日曾寫死在 6 個地方（出席判定、庫存試算、SOP 文字 ×4）
- 休假姓名比對前端做小寫轉換、後端沒做 → 前後端算出不同杯數
- 批次分組前端自己算一份、伺服器也算一份

現在供應日只在 `STAFF_MEAL_DOWS` 定義一次，連 SOP 頁面的文字都是讀它產生的。**要在別處用，就從定義讀，不要複製。**

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

改完一定要跑，三套都要過（共 50 項）。

```bash
PORT=3999 node server.js          # 另一個終端機
node scripts/test-meals.mjs       # 26 項：套餐、熱量、採購模式、小卡閘門
node scripts/test-day-state.mjs   # 10 項：休假比對、出席自洽、狀態共用
node scripts/test-inventory.mjs   # 14 項：消耗紀錄、補差額、盤點、備份
```

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
