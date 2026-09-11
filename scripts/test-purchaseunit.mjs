// 採購的單位換算，以及離譜單價的把關
//
//   庫存一律存基本單位（g / ml / 粒 / 包），但買的時候講的是別的單位：
//   蘋果買 2.2 公斤、檸檬買 12 顆。輸入框原本只有一個沒有單位的數字，
//   連 placeholder 都只寫「如：1500」。
//
//   打「2.2」的後果：庫存加 2.2 公克，單價變成 149 元/公克（實際約 0.17）。
//   而平均成本是「總金額 ÷ 總數量」——
//   一筆填錯會污染那樣食材整個回溯期間的均價，而且畫面上只會顯示
//   「有點貴」，不像壞掉。所以擋在寫進去之前，不是事後對帳。
const B = 'http://localhost:3999';
const H = { 'X-Kitchen-User-Id': '1', 'Content-Type': 'application/json' };
const api = async (p, m = 'GET', b = null) => {
  const r = await fetch(B + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${m} ${p} → ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};
const tryApi = async (p, m, b) => {
  const r = await fetch(B + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (e) {}
  return { ok: r.ok, status: r.status, json: j, text: t };
};

let pass = 0, fail = 0;
const line = s => console.log(s);
const check = (n, c, d = '') => { c ? (pass++, line(`  ✓ ${n}${d ? '  ' + d : ''}`))
                                   : (fail++, line(`  ✗ ${n}${d ? '  ' + d : ''}`)); };

const stockOf = async id => {
  const inv = await api('/api/inventory');
  const rows = Array.isArray(inv) ? inv : (inv.items || inv.ingredients || []);
  return rows.find(r => r.id === id);
};

// 自己造一樣食材，不要動到真的品項 —— 採購紀錄會影響均價，
// 在正式品項上跑測試等於把假資料寫進成本
const NAME = 'ZZ單位測試料';
let ing = null;
{
  // 上一次跑完會把它停用，所以要連停用的一起找 —— 只看啟用中的話
  // 第二次跑會去建同名的，然後被唯一索引擋掉，整支測試跑不完
  const all = await api('/api/ingredients?include_inactive=1');
  ing = all.find(i => i.name === NAME);
  if (!ing) {
    const r = await api('/api/ingredients', 'POST',
      { name: NAME, unit: 'g', category: '其他' });
    ing = (await api('/api/ingredients?include_inactive=1')).find(i => i.id === r.id);
  }
  // 給它一個「顆」的換算，跟蘋果一樣：1 顆 = 220 g
  await api('/api/ingredients/' + ing.id, 'PUT',
    { name: NAME, unit: 'g', category: '其他', active: 1, count_unit: '顆', count_ratio: 220 });
  ing = (await api('/api/ingredients?include_inactive=1')).find(i => i.id === ing.id);
}
check('前置：造得出測試食材', !!ing && ing.count_ratio === 220,
      ing ? `${ing.name} 1 ${ing.count_unit} = ${ing.count_ratio} ${ing.unit}` : '★ 造不出來');

const cleanup = async () => {
  for (const p of ((await api('/api/inventory/' + ing.id + '/purchases')).purchases
                   || await api('/api/inventory/' + ing.id + '/purchases') || [])) {
    if (p.id) await api('/api/purchase/' + p.id, 'DELETE').catch(() => {});
  }
  await api('/api/inventory/' + ing.id, 'PUT', { qty: 0 }).catch(() => {});
};
await cleanup();

line('\n━━ 1. 公斤要換成公克 ━━');
{
  const before = (await stockOf(ing.id)).qty;
  const r = await api('/api/inventory/purchase', 'POST',
    { ingredient_id: ing.id, qty: 2.2, input_unit: 'kg', total_price: 374 });
  check('2.2 公斤 = 2200 公克', r.base_qty === 2200, `${r.base_qty} ${r.unit}`);
  check('單價算在公克上', Math.abs(r.unit_price - 0.17) < 0.001, r.unit_price + ' 元/g');
  const after = (await stockOf(ing.id)).qty;
  check('庫存加的是 2200 不是 2.2', Math.abs(after - before - 2200) < 0.05,
        `${before} → ${after}`);
}

line('\n━━ 2. 顆要照換算比例換 ━━');
{
  const before = (await stockOf(ing.id)).qty;
  const r = await api('/api/inventory/purchase', 'POST',
    { ingredient_id: ing.id, qty: 12, input_unit: 'count', total_price: 449 });
  check('12 顆 × 220 = 2640 公克', r.base_qty === 2640, `${r.base_qty} ${r.unit}`);
  const after = (await stockOf(ing.id)).qty;
  check('庫存加 2640', Math.abs(after - before - 2640) < 0.05, `${before} → ${after}`);
}

line('\n━━ 3. 單位填錯要被擋下來 ━━');
// 這是整支測試的重點：買 2.2 公斤卻用公克送出。
// 現在均價約 0.17 元/g，這一筆會算出 170 元/g —— 差 1000 倍
{
  const before = (await stockOf(ing.id)).qty;
  const r = await tryApi('/api/inventory/purchase', 'POST',
    { ingredient_id: ing.id, qty: 2.2, input_unit: 'base', total_price: 374 });
  check('擋住了', !r.ok && r.status === 409, `HTTP ${r.status}`);
  check('訊息講得出差幾倍', !!(r.json && r.json.odd && r.json.odd.factor >= 5),
        r.json && r.json.error ? r.json.error.slice(0, 90) : '');
  check('庫存沒有被動到', Math.abs((await stockOf(ing.id)).qty - before) < 0.05,
        `${before} → ${(await stockOf(ing.id)).qty}　—— 擋下來就不能留下半筆`);

  const forced = await api('/api/inventory/purchase', 'POST',
    { ingredient_id: ing.id, qty: 2.2, input_unit: 'base', total_price: 374,
      confirm_odd_price: true });
  check('確認過就寫得進去', forced.base_qty === 2.2, `${forced.base_qty} ${forced.unit}`);
  // 收拾這一筆，不要讓它留在均價裡
  const ps = await api('/api/inventory/' + ing.id + '/purchases');
  const list = ps.purchases || ps;
  const bad = list.find(p => Number(p.qty) === 2.2);
  if (bad) await api('/api/purchase/' + bad.id, 'DELETE');
  check('收拾掉那一筆', !(await api('/api/inventory/' + ing.id + '/purchases')).purchases
        ?.some(p => Number(p.qty) === 2.2), '已移除');
}

line('\n━━ 4. 換不成的單位要說清楚，不要默默當成基本單位 ━━');
{
  const r = await tryApi('/api/inventory/purchase', 'POST',
    { ingredient_id: ing.id, qty: 5, input_unit: 'l', total_price: 100 });
  check('公升換不成公克，擋住', !r.ok && r.status === 400, `HTTP ${r.status}`);
  check('訊息講得出換不成什麼',
        !!(r.json && /換不成/.test(r.json.error || '')), r.json ? r.json.error : '');
}

line('\n━━ 5. 平均成本是「總金額 ÷ 總數量」━━');
// 兩筆：2200 g / 374 元，2640 g / 449 元 → (374+449)/(2200+2640) = 0.17
{
  const c = await api('/api/costs');
  let seen = null;
  c.prescriptions.forEach(p => (p.breakdown || []).forEach(b => {
    if (b.name === NAME) seen = b;
  }));
  const ps = await api('/api/inventory/' + ing.id + '/purchases');
  const list = ps.purchases || ps;
  const tq = list.reduce((a, p) => a + Number(p.qty), 0);
  const tp = list.reduce((a, p) => a + Number(p.total_price), 0);
  check('採購紀錄只剩換算正確的兩筆', list.length === 2,
        list.map(p => p.qty + 'g/' + p.total_price + '元').join('　'));
  check('均價 = 總金額 ÷ 總數量', Math.abs(tp / tq - 0.17) < 0.005,
        `${tp} ÷ ${tq} = ${(tp / tq).toFixed(4)} 元/g`);
}

line('\n━━ 6. 收尾 ━━');
await cleanup();
await api('/api/ingredients/' + ing.id, 'PUT',
  { name: NAME, unit: 'g', category: '其他', active: 0 }).catch(() => {});
{
  const still = (await api('/api/ingredients')).find(i => i.id === ing.id && i.active !== 0);
  check('測試食材已停用', !still, still ? '★ 還在' : '已清');
}

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
