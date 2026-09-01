// 採購籃的回歸測試
//
//   帳面長期是 0（盤點時 16 樣全部帳實不符、而且全是正的）不是因為懶 ——
//   進貨原本一次只能登記一樣，買 13 樣要開 13 次視窗。登記的成本太高，
//   所以就沒有人登記。
//
//   這一組測「市場勾起來 → 回診所整批補金額 → 庫存回補」這整條路。
//   勾選必須存在伺服器：在市場勾的是手機，回診所登記的是另一台。
const B = 'http://localhost:3999';
const H = { 'X-Kitchen-User-Id': '1', 'Content-Type': 'application/json' };
const api = async (p, m = 'GET', b = null) => {
  const r = await fetch(B + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${m} ${p} → ${r.status}: ${t.slice(0, 160)}`);
  return t ? JSON.parse(t) : null;
};
let pass = 0, fail = 0;
const line = s => console.log(s);
const check = (n, c, d = '') => { c ? (pass++, line(`  ✓ ${n}${d ? '  ' + d : ''}`))
                                   : (fail++, line(`  ✗ ${n}${d ? '  ' + d : ''}`)); };

const inv  = async () => Object.fromEntries((await api('/api/inventory')).map(i => [i.id, i.qty]));
const draft = () => api('/api/purchase/draft');
const ings = await api('/api/ingredients');
const [a, b] = [ings.find(i => i.name === '燕麥'), ings.find(i => i.name === '核桃')];

// 先清空籃子，起點才確定
for (const r of (await draft()).rows)
  await api('/api/purchase/draft', 'PUT', { ingredient_id: r.ingredient_id, remove: 1 });

line('\n━━ 1. 在市場勾起來 ━━');
await api('/api/purchase/draft', 'PUT', { ingredient_id: a.id, qty: 500 });
await api('/api/purchase/draft', 'PUT', { ingredient_id: b.id, qty: 300 });
let d = await draft();
check('兩樣都進了籃子', d.count === 2, d.rows.map(r => `${r.name} ${r.qty}${r.unit}`).join('、'));
check('帶得出食材名稱與單位', d.rows.every(r => r.name && r.unit),
      '採購的人要看得懂，不能只有 id');

line('\n━━ 2. 實際買到的量可以改 ━━');
// 店家只剩 800g、或整包 1kg —— 記實際的，帳面才會對
await api('/api/purchase/draft', 'PUT', { ingredient_id: a.id, qty: 820 });
d = await draft();
check('改量會覆蓋，不是新增一筆', d.count === 2,
      `${d.count} 筆（同一樣勾兩次不該變成兩行）`);
check('存的是後來改的量', d.rows.find(r => r.ingredient_id === a.id).qty === 820, '820g');

line('\n━━ 3. 取消勾選 ━━');
await api('/api/purchase/draft', 'PUT', { ingredient_id: b.id, remove: 1 });
d = await draft();
check('取消的會離開籃子', d.count === 1 && d.rows[0].ingredient_id === a.id);
await api('/api/purchase/draft', 'PUT', { ingredient_id: b.id, qty: 300 });   // 放回去

line('\n━━ 4. 整批登記 ━━');
const before = await inv();
const r = await api('/api/purchase/commit', 'POST', {
  lines: [
    { ingredient_id: a.id, qty: 820, total_price: 410 },
    { ingredient_id: b.id, qty: 300, total_price: 600 }
  ]
});
check('一次登記兩樣', r.saved === 2, `saved ${r.saved}／skipped ${r.skipped}`);
const after = await inv();
check('庫存有加回去', Math.abs((after[a.id] - before[a.id]) - 820) < 0.05,
      `燕麥 ${before[a.id]} → ${after[a.id]}`);
check('第二樣也加了', Math.abs((after[b.id] - before[b.id]) - 300) < 0.05,
      `核桃 ${before[b.id]} → ${after[b.id]}`);
check('登記完就離開籃子', (await draft()).count === 0, '不然會重複登記');

line('\n━━ 5. 單價要算得出來（成本靠它）━━');
const hist = await api(`/api/inventory/${a.id}/purchases`);
const last = hist[0];
check('採購紀錄有留下來', !!last && Math.abs(last.qty - 820) < 0.05,
      last ? `${last.qty}${a.unit} / $${last.total_price}` : '缺');
check('單價 = 金額 ÷ 數量',
      last && Math.abs(last.total_price / last.qty - 0.5) < 0.01,
      last ? `$${(last.total_price / last.qty).toFixed(3)}/g` : '');

line('\n━━ 6. 沒填金額的要留著，不能默默丟掉 ━━');
await api('/api/purchase/draft', 'PUT', { ingredient_id: a.id, qty: 100 });
await api('/api/purchase/draft', 'PUT', { ingredient_id: b.id, qty: 100 });
const before6 = await inv();
const r6 = await api('/api/purchase/commit', 'POST', {
  lines: [
    { ingredient_id: a.id, qty: 100, total_price: 50 },
    { ingredient_id: b.id, qty: 100, total_price: '' }      // 還在等發票
  ]
});
check('只登記填了金額的那一樣', r6.saved === 1 && r6.skipped === 1,
      `saved ${r6.saved}／skipped ${r6.skipped}`);
const d6 = await draft();
check('沒填金額的留在籃子裡', d6.count === 1 && d6.rows[0].ingredient_id === b.id,
      '默默丟掉的話，那一樣就永遠不會被登記');
const after6 = await inv();
check('沒登記的庫存不動', Math.abs(after6[b.id] - before6[b.id]) < 0.05,
      `核桃 ${before6[b.id]} → ${after6[b.id]}`);

line('\n━━ 7. 還原 ━━');
await api('/api/purchase/draft', 'PUT', { ingredient_id: b.id, remove: 1 });
// 把這次加進去的量用盤點扣回來
await api('/api/stocktake', 'POST', {
  note: 'ZZ 採購測試還原',
  items: [{ ingredient_id: a.id, counted_qty: before[a.id] },
          { ingredient_id: b.id, counted_qty: before[b.id] }]
});
const end = await inv();
check('庫存還原成測試前', Math.abs(end[a.id] - before[a.id]) < 0.05
      && Math.abs(end[b.id] - before[b.id]) < 0.05,
      `燕麥 ${end[a.id]}／核桃 ${end[b.id]}`);
check('籃子清空', (await draft()).count === 0);

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
