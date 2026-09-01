import fs from 'node:fs';

let s = fs.readFileSync('public/app.js', 'utf8');

// 讀不到預約時要講出來。「今天沒有預約」和「讀不到預約系統」看起來一樣，
// 但意思完全不同 —— 實際發生過：權限被改成 401 之後什麼都沒帶進來，
// 大家以為是自己忘了 key，默默改成全部手動建單
const o = `  function renderAutoSettle() {`;
const v = `  function renderApptSyncWarning(d) {
    const el = document.getElementById('apptSyncWarn');
    if (!el) return;
    const s = d && d.appt_sync;
    if (!s || s.ok !== false) { el.innerHTML = ''; return; }
    el.innerHTML = \`<div class="sync-down">
      <b>⚠ 讀不到預約系統</b>
      <div>預約上的精力湯不會自動帶進來，今天的單要自己建。
           這不是「今天沒有預約」—— 是連不上。</div>
      <div class="sync-when">最後嘗試 \${esc(s.at || '')}　\${esc(s.error || '')}</div>
    </div>\`;
  }

  function renderAutoSettle() {`;
if (!s.includes(o)) { console.error('✗ 找不到 renderAutoSettle'); process.exit(1); }
s = s.replace(o, v);

// 在載入今日資料時呼叫
const o2 = `    renderAutoSettle();`;
if (!s.includes(o2)) { console.error('✗ 找不到 renderAutoSettle 呼叫'); process.exit(1); }
s = s.replace(o2, `    renderApptSyncWarning(d);
    renderAutoSettle();`);

fs.writeFileSync('public/app.js', s);
console.log('✓ 同步失敗警告已接上');

// 容器與樣式
let h = fs.readFileSync('public/index.html', 'utf8');
const o3 = `    <div id="autoSettleBox"></div>`;
const v3 = `    <div id="apptSyncWarn"></div>
    <div id="autoSettleBox"></div>`;
if (!h.includes(o3)) { console.error('✗ 找不到 autoSettleBox'); process.exit(1); }
h = h.replace(o3, v3);

const o4 = `    .fc-mode {`;
const v4 = `    .sync-down {
      background: rgba(239,68,68,.08); border: 1px solid rgba(239,68,68,.35);
      border-radius: var(--radius-md); padding: 12px 14px; margin-bottom: 10px;
      font-size: 14px; color: var(--text);
    }
    .sync-down b { color: var(--red); font-size: 15px; display: block; margin-bottom: 4px; }
    .sync-down .sync-when { color: var(--text3); font-size: 12px; margin-top: 6px; }
    /* 個案晶片上的編輯入口。這些個案不會出現在時間軸，這是唯一的編輯路徑 */
    .case-chip { position: relative; }
    .chip-edit {
      position: absolute; top: 4px; right: 4px;
      width: 30px; height: 30px; border-radius: 8px;
      border: 1px solid var(--border); background: var(--card-solid);
      color: var(--text3); font-size: 13px; cursor: pointer; line-height: 1;
      display: flex; align-items: center; justify-content: center;
    }
    .chip-edit:hover { color: var(--primary); border-color: var(--primary); }
    .fc-mode {`;
if (!h.includes(o4)) { console.error('✗ 找不到 fc-mode 樣式'); process.exit(1); }
h = h.replace(o4, v4);
fs.writeFileSync('public/index.html', h);
console.log('✓ 容器與樣式已加入');
