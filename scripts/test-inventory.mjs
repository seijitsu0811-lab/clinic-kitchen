// 庫存正確性的回歸測試
//   1. 扣庫存會留下紀錄（原本扣完就沒了，無從查證）
//   2. 隔日自動補扣：只補差額、不重複補、可還原
//   3. 盤點：以實際值覆寫帳面並記下差異
//   4. 備份：檔案真的是可讀的 SQLite，且擋掉路徑穿越
const B = 'http://localhost:3999';
const H = { 'X-Kitchen-User-Id': '1', 'Content-Type': 'application/json' };

const api = async (path, method = 'GET', body = null) => {
  const r = await fetch(B + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};

let pass = 0, fail = 0;
const line = s => console.log(s);
const check = (name, cond, detail = '') => {
  if (cond) { pass++; line(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else      { fail++; line(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
};

const yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const qtyOf = async (name) => {
  const inv = await api('/api/inventory');
  const row = inv.find(i => i.name === name);
  return row ? row.qty : null;
};

// 用一張只含燕麥的臨時處方，讓數字好驗算
line('\n━━ 0. 準備 ━━');
const ings = await api('/api/ingredients');
const oat  = ings.find(i => i.name === '燕麥');
// 停用是軟刪除，代號還佔著，所以要連停用的一起找，找到就重新啟用
let rx = (await api('/api/prescriptions?include_inactive=1')).find(p => p.code === 'ZZ-TEST');
if (rx) {
  await api(`/api/prescriptions/${rx.id}`, 'PUT',
    { ...rx, active: 1, daily_cups: 0, buffer_cups: 0 });
} else {
  const r = await api('/api/prescriptions', 'POST',
    { code: 'ZZ-TEST', name: '測試處方', formula_type: '粉配方', timing: '餐前' });
  rx = { id: r.id, code: 'ZZ-TEST' };
}
await api(`/api/prescriptions/${rx.id}/ingredients`, 'PUT', [{ ingredient_id: oat.id, qty_per_cup: 10 }]);

// 先用盤點把庫存設到已知數量。測試不能依賴環境裡剩多少 ——
// 扣庫存有 MAX(0,…) 保護，起始量太低時扣了也不會變，斷言就會假失敗
const origQty = await qtyOf('燕麥');
await api('/api/stocktake', 'POST',
  { note: 'ZZ 測試前置：把燕麥設到已知量', items: [{ ingredient_id: oat.id, counted_qty: 500 }] });
const startQty = await qtyOf('燕麥');
check('測試處方與起始庫存就緒（燕麥 10g/杯）', startQty === 500,
      `燕麥 ${origQty}g → 起始 ${startQty}g`);

line('\n━━ 1. 扣庫存會留下紀錄 ━━');
// 記住這一筆。手動扣的紀錄如果不還原，下一輪跑的時候系統會以為昨天
// 早就扣超過應扣的量，於是沒有缺口可補，補扣那組就再也測不到東西
const manualLog = await api('/api/inventory/consume', 'POST',
  { prescription_id: rx.id, cups: 2, date: yday });
check('庫存有扣', (await qtyOf('燕麥')) === Math.round((startQty - 20) * 10) / 10,
      `${startQty} → ${await qtyOf('燕麥')}`);

line('\n━━ 2. 隔日自動補扣 ━━');
// 昨天掛 5 杯出單，其中 2 杯已經手動扣過
// 記住 id —— 這筆掛在「昨天」，不會出現在 /api/today 的清單裡。
// 只靠掃今日頁清理的話，每跑一次就留一筆，之後每次啟動都被補扣一次，
// 庫存會愈跑愈偏（本機曾累積 21 筆）
const ydayOrder = await api('/api/today/cases', 'POST',
  { prescription_id: rx.id, cups: 5, meal_time: '1130', powder_type: '袋裝',
    patient_name: 'ZZ補扣測試', notes: 'ZZ', date: yday }).catch(() => null);
// case_orders 的日期是今天，改成昨天
const before = await qtyOf('燕麥');
await api('/api/today');           // 觸發補扣
const afterSettle = await qtyOf('燕麥');
const settled = await api('/api/consumption/auto?days=3');
// 只看這張測試處方在昨天的補扣，不要把環境裡別的補扣算進來
const mine = settled.filter(s => s.date === yday && s.prescription_id === rx.id);

// `[].every()` 恆真 —— 補扣沒觸發時這一條會假通過。
// 先確認真的有補扣，這種「不會失敗的測試」比沒有測試更糟
check('昨天的缺口確實被補扣了', mine.length > 0,
      mine.map(s => `${s.date} ${s.cups}杯`).join('、') || '★ 完全沒有觸發補扣');

// 昨天掛 5 杯、已經手動扣掉 2 杯，所以只該補 3 杯。
// 補成 5 杯就是「整份重扣」，那會讓庫存愈補愈少
const total = mine.reduce((s, r) => s + r.cups, 0);
check('補的是差額 3 杯，不是整份 5 杯', total === 3,
      `實際補 ${total} 杯（應出 5、已扣 2）`);

// 扣的量也要對得上：3 杯 × 每杯 10g 燕麥
check('庫存少掉的量與補扣杯數一致',
      Math.abs((before - afterSettle) - 30) < 0.05,
      `${before} → ${afterSettle}（少 ${Math.round((before - afterSettle) * 10) / 10}g，應為 3×10）`);

const secondPass = await qtyOf('燕麥');
await api('/api/today');           // 再打一次
check('重複觸發不會重複扣', (await qtyOf('燕麥')) === secondPass,
      `${secondPass} → ${await qtyOf('燕麥')}`);

line('\n━━ 3. 還原自動補扣 ━━');
if (mine.length) {
  const target = mine[0];
  const beforeRev = await qtyOf('燕麥');
  await api(`/api/consumption/${target.id}/reverse`, 'POST');
  const afterRev = await qtyOf('燕麥');
  check('還原會把食材加回去', afterRev > beforeRev, `${beforeRev} → ${afterRev}`);
  const stillListed = (await api('/api/consumption/auto?days=3')).some(s => s.id === target.id);
  check('還原後不再列為待處理', !stillListed);
} else {
  line('  － 昨天沒有自動補扣，略過');
}

line('\n━━ 4. 盤點 ━━');
const bookQty = await qtyOf('燕麥');
const st = await api('/api/stocktake', 'POST',
  { note: 'ZZ 測試盤點', items: [{ ingredient_id: oat.id, counted_qty: bookQty - 33 }] });
check('帳面被實際值覆寫', (await qtyOf('燕麥')) === Math.round((bookQty - 33) * 10) / 10,
      `${bookQty} → ${await qtyOf('燕麥')}`);
const detail = await api('/api/stocktake/' + st.id);
const item = detail.items.find(i => i.ingredient_id === oat.id);
check('差異被記錄下來', Math.abs(item.variance + 33) < 0.05,
      `帳面 ${item.book_qty} 實際 ${item.counted_qty} 差異 ${item.variance}`);
check('留下盤點人', !!detail.user_name, detail.user_name);

line('\n━━ 5. 備份 ━━');
const bk = await api('/api/backups/run', 'POST');
check('可以立即產生備份', !!bk.file, `${bk.file}（${Math.round(bk.size / 1024)} KB）`);
const list = await api('/api/backups');
check('備份清單列得出來', list.backups.length > 0, `${list.backups.length} 份，保留上限 ${list.keep}`);
const r = await fetch(B + '/api/backups/' + bk.file, { headers: H });
const buf = new Uint8Array(await r.arrayBuffer());
check('下載回來是可讀的 SQLite',
      String.fromCharCode(...buf.slice(0, 15)) === 'SQLite format 3');
const bad = await fetch(B + '/api/backups/..%2F..%2Fserver.js', { headers: H });
check('擋掉路徑穿越', bad.status === 400, `HTTP ${bad.status}`);

line('\n━━ 6. 清理 ━━');
// 先把出單刪掉，否則接下來的 /api/today 會再補扣一次
if (ydayOrder && ydayOrder.id) await api('/api/today/cases/' + ydayOrder.id, 'DELETE').catch(() => {});
if (manualLog && manualLog.id) await api('/api/consumption/' + manualLog.id + '/reverse', 'POST').catch(() => {});
const t = await api('/api/today');
for (const p of t.products) {
  for (const c of [...(p.cases || []), ...(p.future_cases || [])]) {
    if (String(c.patient_name).startsWith('ZZ')) await api('/api/today/cases/' + c.id, 'DELETE');
  }
}
for (const c of await api('/api/consumption/auto?days=3')) {
  await api(`/api/consumption/${c.id}/reverse`, 'POST').catch(() => {});
}
await api(`/api/prescriptions/${rx.id}`, 'DELETE');
// 最後用盤點把庫存還原成測試開始前的樣子
await api('/api/stocktake', 'POST',
  { note: 'ZZ 還原', items: [{ ingredient_id: oat.id, counted_qty: origQty }] });
check('燕麥還原成測試前的數量', (await qtyOf('燕麥')) === origQty, `${await qtyOf('燕麥')} / ${origQty}`);

line(`\n${'─'.repeat(46)}`);
line(`通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
