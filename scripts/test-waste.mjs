// 報廢：知道原因的損失，要跟「說不出原因的差異」分開
//
//   盤點原本只記一個差異（實際 − 帳面）。爛掉丟了、用了沒扣到、扣帳公式有洞，
//   三件事全部混在同一個數字裡。報廢拆出來之後，剩下的「未說明」才是該查的。
//
//   這裡守的是兩條路不會重複扣：
//     隨時報廢  記的當下扣庫存，下次盤點的差異自然不含它
//     盤點時拆  庫存照實際數覆寫，報廢只是把差異拆開來記，不能再多扣一次
const B = 'http://localhost:3999';
const H = { 'X-Kitchen-User-Id': '1', 'Content-Type': 'application/json' };
const api = async (p, m = 'GET', b = null) => {
  const r = await fetch(B + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${m} ${p} → ${r.status}: ${t.slice(0, 160)}`);
  return t ? JSON.parse(t) : null;
};
const tryApi = async (p, m, b) => {
  const r = await fetch(B + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  return { ok: r.ok, status: r.status, body: await r.text() };
};

let pass = 0, fail = 0;
const line = s => console.log(s);
const check = (n, c, d = '') => { c ? (pass++, line(`  ✓ ${n}${d ? '  ' + d : ''}`))
                                   : (fail++, line(`  ✗ ${n}${d ? '  ' + d : ''}`)); };
const today = new Date().toISOString().slice(0, 10);
const r1 = x => Math.round(x * 10) / 10;

const inv = await api('/api/inventory');
const stockOf = async id => (await api('/api/inventory')).find(i => i.id === id).qty;
// 一樣有「顆」的、一樣只有公克的
const withCount = inv.find(i => i.count_unit && i.count_ratio > 1);
// 要挑有進貨紀錄的：單價是 0 的話，「成本 = 量 × 單價」怎麼算都對，等於沒測
let plain = null;
for (const i of inv.filter(i => !i.count_unit && i.unit === 'g' && i.id !== withCount?.id)) {
  const ps = await api('/api/inventory/' + i.id + '/purchases');
  if (ps.some(p => p.qty > 0 && p.total_price > 0)) { plain = i; break; }
}
check('前置：找得到有顆數換算與只有公克的食材', !!withCount && !!plain,
      `${withCount?.name}（1${withCount?.count_unit}=${withCount?.count_ratio}${withCount?.unit}）／${plain?.name}`);
if (!withCount || !plain) { line(`\n通過 ${pass} 項，失敗 ${fail} 項`); process.exit(1); }

const orig = { [withCount.id]: withCount.qty, [plain.id]: plain.qty };
const made = [];
const setStock = (id, q) => api('/api/inventory/' + id, 'PUT', { qty: q });

try {
  line('\n━━ 1. 隨時報廢：當下就扣庫存，成本凍在當下 ━━');
  await setStock(plain.id, 1000);
  const w = await api('/api/waste', 'POST',
    { ingredient_id: plain.id, qty: 200, reason: '腐壞過期', note: '測試用' });
  made.push(w.id);
  check('庫存扣掉 200', r1(await stockOf(plain.id)) === 800, `1000 → ${await stockOf(plain.id)}`);
  const row = (await api('/api/waste?ingredient_id=' + plain.id)).rows.find(x => x.id === w.id);
  check('紀錄留了原因、人、單價', row && row.reason === '腐壞過期' && row.user_id === 1 && row.unit_cost >= 0,
        row ? `單價 ${r1(row.unit_cost * 1000) / 1000}・成本 ${row.cost}` : '');
  check('成本 = 量 × 當時單價，而且不是 0', row && row.unit_cost > 0 && Math.abs(row.cost - r1(200 * row.unit_cost)) < 0.2,
        row ? `200 × ${row.unit_cost} = ${row.cost}` : '');

  line('\n━━ 2. 用顆數報，換算成基本單位 ━━');
  await setStock(withCount.id, withCount.count_ratio * 10);
  const wc = await api('/api/waste', 'POST',
    { ingredient_id: withCount.id, qty: 2, unit: 'count', reason: '掉落污染' });
  made.push(wc.id);
  check(`2${withCount.count_unit} = ${2 * withCount.count_ratio}${withCount.unit}`,
        r1(wc.qty) === r1(2 * withCount.count_ratio), `記成 ${wc.qty}`);
  check('扣 2 顆之後剩 8 顆的量',
        r1(await stockOf(withCount.id)) === r1(withCount.count_ratio * 8));

  line('\n━━ 3. 擋下不合理的報廢 ━━');
  const over = await tryApi('/api/waste', 'POST', { ingredient_id: plain.id, qty: 5000, reason: '腐壞過期' });
  check('比帳上還多 → 擋下，叫人去盤點', over.status === 400 && over.body.includes('盤點'));
  check('擋下之後庫存沒動', r1(await stockOf(plain.id)) === 800);
  const other = await tryApi('/api/waste', 'POST', { ingredient_id: plain.id, qty: 10, reason: '其他' });
  check('原因選「其他」沒寫備註 → 擋下', other.status === 400);
  const badReason = await tryApi('/api/waste', 'POST', { ingredient_id: plain.id, qty: 10, reason: '被偷' });
  check('不在清單裡的原因 → 擋下', badReason.status === 400);
  const future = await tryApi('/api/waste', 'POST',
    { ingredient_id: plain.id, qty: 10, reason: '腐壞過期', date: '2099-01-01' });
  check('未來日期 → 擋下', future.status === 400);
  const zero = await tryApi('/api/waste', 'POST', { ingredient_id: plain.id, qty: 0, reason: '腐壞過期' });
  check('0 → 擋下', zero.status === 400);

  line('\n━━ 4. 記錯了刪掉：還沒盤點過就加回去 ━━');
  const del = await api('/api/waste/' + w.id, 'DELETE');
  made.splice(made.indexOf(w.id), 1);
  check('刪掉後庫存回到 1000', r1(await stockOf(plain.id)) === 1000 && del.restored === 200);

  line('\n━━ 5. 盤點時拆報廢：庫存照實際數，不再多扣 ━━');
  const before = (await api('/api/stocktakes')).length;
  const st = await api('/api/stocktake', 'POST', {
    note: '測試用', items: [{ ingredient_id: plain.id, counted_qty: 600,
                              waste_qty: 300, waste_reason: '腐壞過期' }] });
  check('庫存是實際數的 600（不是 600 − 300）', r1(await stockOf(plain.id)) === 600,
        `→ ${await stockOf(plain.id)}` + (r1(await stockOf(plain.id)) === 300 ? ' ★ 報廢被扣了兩次' : ''));
  check('回報：報廢 1 項、未說明 1 項', st.wasted === 1 && st.unexplained === 1,
        `wasted ${st.wasted}・unexplained ${st.unexplained}`);
  const detail = await api('/api/stocktake/' + st.id);
  const it = detail.items.find(x => x.ingredient_id === plain.id);
  check('差異 −400 拆成：報廢 300、未說明 −100',
        it && r1(it.variance) === -400 && r1(it.waste_qty) === 300 && r1(it.unexplained) === -100,
        it ? `差異 ${it.variance}・報廢 ${it.waste_qty}・未說明 ${it.unexplained}` : '');
  const stw = (await api('/api/waste?ingredient_id=' + plain.id)).rows.find(x => x.stocktake_id === st.id);
  check('報廢表裡有一筆掛在這次盤點上', !!stw && r1(stw.qty) === 300);
  if (stw) made.push(stw.id);

  line('\n━━ 6. 盤點的報廢量不合理就整張不收 ━━');
  const n1 = (await api('/api/stocktakes')).length;
  const badSt = await tryApi('/api/stocktake', 'POST', {
    items: [{ ingredient_id: withCount.id, counted_qty: 1, },
            { ingredient_id: plain.id, counted_qty: 100, waste_qty: 99999, waste_reason: '腐壞過期' }] });
  check('報廢比帳面還多 → 擋下', badSt.status === 400);
  check('一整張都沒寫進去（前一列也沒被覆寫）',
        (await api('/api/stocktakes')).length === n1 && r1(await stockOf(withCount.id)) === r1(withCount.count_ratio * 8));
  const noCount = await tryApi('/api/stocktake', 'POST', {
    items: [{ ingredient_id: plain.id, counted_qty: '', waste_qty: 10 },
            { ingredient_id: withCount.id, counted_qty: 5 }] });
  check('只填報廢沒填實際 → 擋下', noCount.status === 400);

  line('\n━━ 7. 刪掉盤點拆出來的報廢：改回未說明，庫存不動 ━━');
  await api('/api/waste/' + stw.id, 'DELETE');
  made.splice(made.indexOf(stw.id), 1);
  const it2 = (await api('/api/stocktake/' + st.id)).items.find(x => x.ingredient_id === plain.id);
  check('那 300 變回未說明', it2 && r1(it2.unexplained) === -400 && r1(it2.waste_qty) === 0);
  check('庫存還是 600', r1(await stockOf(plain.id)) === 600);

  line('\n━━ 8. 隨時報廢之後盤點過，刪掉不能再加回去 ━━');
  const w3 = await api('/api/waste', 'POST', { ingredient_id: plain.id, qty: 50, reason: '腐壞過期' });
  made.push(w3.id);
  // created_at 只到秒，盤點要晚於報廢
  await new Promise(r => setTimeout(r, 1100));
  await api('/api/stocktake', 'POST', { note: '測試用', items: [{ ingredient_id: plain.id, counted_qty: 540 }] });
  const d3 = await api('/api/waste/' + w3.id, 'DELETE');
  made.splice(made.indexOf(w3.id), 1);
  check('沒加回去，並說明原因', d3.restored === 0 && d3.note.includes('盤點'),
        `庫存 ${await stockOf(plain.id)}`);
  check('庫存維持盤點的 540', r1(await stockOf(plain.id)) === 540);

  line('\n━━ 9. 月結看得到報廢，而且不併進月總支出 ━━');
  const mBefore = await api('/api/costs/monthly?month=' + today.slice(0, 7));
  const w4 = await api('/api/waste', 'POST', { ingredient_id: plain.id, qty: 100, reason: '腐壞過期' });
  made.push(w4.id);
  const mAfter = await api('/api/costs/monthly?month=' + today.slice(0, 7));
  check('月結有 waste 區塊', mAfter.waste && typeof mAfter.waste.total_cost === 'number');
  check('報廢筆數 +1', mAfter.waste.count === mBefore.waste.count + 1,
        `${mBefore.waste.count} → ${mAfter.waste.count}`);
  check('月總支出沒有因為報廢改變', mAfter.month_total === mBefore.month_total);
} finally {
  for (const id of made) await fetch(B + '/api/waste/' + id, { method: 'DELETE', headers: H });
  for (const [id, q] of Object.entries(orig)) await setStock(Number(id), q);
}

line(`\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
