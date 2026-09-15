// 基底粉的單只給粉類
//
//   處方是完整的臨床配方，個案的處方會整張 key 上去。但實際出給他的
//   可能只有粉 —— 袋裝基底粉、罐裝基底粉就是這種：客人自己回家沖，不拿菜。
//
//   系統原本拿處方當生產規格，所以基底粉的單照樣扣掉一整份蔬果。
//   2026-09 量過：過去 30 天 112 杯裡 41 杯是基底粉（37%）。
//   9/11 那天一張 21 杯的袋裝粉單，生出 220 g 甜菜根的需求 ——
//   而那樣食材早就換成火龍果了，甜菜根根本沒進貨。
//
//   規則只定義在 servedItems() 一支裡，但有六個地方要讀它：
//   扣庫存、排產、缺料、採購、備料表、成本。這支測試就是確認六邊一致 ——
//   「同一個數字兩套算法」是這個系統最貴的那一類 bug。
const B = 'http://localhost:3999';
const H = { 'X-Kitchen-User-Id': '1', 'Content-Type': 'application/json' };
const api = async (p, m = 'GET', b = null) => {
  const r = await fetch(B + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${m} ${p} → ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};

let pass = 0, fail = 0;
const line = s => console.log(s);
const check = (n, c, d = '') => { c ? (pass++, line(`  ✓ ${n}${d ? '  ' + d : ''}`))
                                   : (fail++, line(`  ✗ ${n}${d ? '  ' + d : ''}`)); };

const today = (await api('/api/today')).date;

// 找一張同時有粉類與蔬果的個案處方 —— 兩種都沒有的話這組測不出東西
const rxs = await api('/api/prescriptions');
let target = null, veg = null, pow = null;
for (const r of rxs) {
  if (r.is_staff_rx) continue;
  // 「每日固定供應」與「每週攤平」那兩種不能挑：cupsOnDate 對它們的規則是
  // 「有單就以單為準」，所以加一張 4 杯的單，總數只會多 3 杯（單取代預設）。
  // 那樣量出來的差值就不是我要驗的東西。
  //
  // 原本沒有這道過濾，於是這支測試只在週末會過 —— 週末每日供應不生效，
  // 差值剛好乾淨。一週有五天會紅燈的測試，遲早被當成雜訊。
  if ((r.daily_cups || 0) > 0 || (r.weekly_cups || 0) > 0) continue;
  const items = (await api('/api/prescriptions/' + r.id + '/ingredients'))
    .filter(i => i.qty_per_cup > 0);
  const v = items.find(i => i.category === '蔬菜' || i.category === '水果');
  const p = items.find(i => i.category === '粉類');
  if (v && p) { target = r; veg = v; pow = p; break; }
}
check('前置：找到一張同時有菜與粉的處方', !!target,
      target ? `${target.code}　菜：${veg.name} ${veg.qty_per_cup}${veg.unit}　粉：${pow.name} ${pow.qty_per_cup}${pow.unit}`
             : '★ 找不到，這組測不出東西');
if (!target) { line(`\n通過 ${pass} 項，失敗 ${fail} 項`); process.exit(1); }

const cleanup = async () => {
  for (const o of ((await api('/api/today')).products[0].cases || []))
    if (String(o.patient_name || '').startsWith('ZZ粉'))
      await api('/api/today/cases/' + o.id, 'DELETE').catch(() => {});
};
await cleanup();

// 某一天某一樣食材的需求量（走 /api/day/cups 的 ingredient 參數）
const needOf = async (date, name) => {
  const d = await api('/api/day/cups?date=' + date + '&ingredient=' + encodeURIComponent(name));
  return (d.ingredient && d.ingredient.from || []).reduce((s, x) => s + x.total, 0);
};
const forecastNeed = async name => {
  const f = await api('/api/inventory/forecast?days=7');
  const row = f.ingredients.find(i => i.name === name);
  return row ? row.need_horizon : 0;
};

const CUPS = 4;
const mk = powderType => api('/api/today/cases', 'POST',
  { date: today, prescription_id: target.id, cups: CUPS,
    powder_type: powderType, patient_name: 'ZZ粉測試' });

line('\n━━ 1. 內用精力湯：菜和粉都要算 ━━');
let baseVeg = 0, basePow = 0;
{
  baseVeg = await needOf(today, veg.name);
  basePow = await needOf(today, pow.name);
  const o = await mk('內用');
  const v1 = await needOf(today, veg.name);
  const p1 = await needOf(today, pow.name);
  check(`菜多了 ${CUPS} 杯的量`, Math.abs((v1 - baseVeg) - veg.qty_per_cup * CUPS) < 0.5,
        `${veg.name} ${baseVeg} → ${v1}（每杯 ${veg.qty_per_cup}）`);
  check('粉也多了', p1 - basePow > 0, `${pow.name} ${basePow} → ${p1}`);
  await api('/api/today/cases/' + (o.id || o.order_id), 'DELETE');
}

line('\n━━ 2. 袋裝基底粉：只算粉，不算菜 ━━');
// 這是整支測試的重點
{
  const v0 = await needOf(today, veg.name);
  const p0 = await needOf(today, pow.name);
  const o = await mk('袋裝');
  const v1 = await needOf(today, veg.name);
  const p1 = await needOf(today, pow.name);
  check('菜完全沒有增加', Math.abs(v1 - v0) < 0.5,
        `${veg.name} ${v0} → ${v1}` +
        (Math.abs(v1 - v0) < 0.5 ? '　—— 客人只拿粉，不該算菜'
          : ` ★ 多算了 ${(v1 - v0).toFixed(1)}${veg.unit}，這就是 9/11 那 220g 甜菜根`));
  check('粉照樣算', p1 - p0 > 0, `${pow.name} ${p0} → ${p1}`);
  await api('/api/today/cases/' + (o.id || o.order_id), 'DELETE');
}

line('\n━━ 3. 罐裝基底粉也一樣，而且粉要 ×1.1 ━━');
{
  // 比的是「這張單造成的差值」，不是當天的總數。
  // 總數裡含著員工那幾杯的粉，那部分不乘 1.1 ——
  // 拿總數去算比例，員工杯數一多，比例就會被稀釋成 1.07、1.03…
  const v0 = await needOf(today, veg.name);
  const pBase = await needOf(today, pow.name);
  const pBag = await (async () => {
    const o = await mk('袋裝');
    const n = await needOf(today, pow.name);
    await api('/api/today/cases/' + (o.id || o.order_id), 'DELETE');
    return n - pBase;
  })();
  const oCan = await mk('罐裝');
  const v1 = await needOf(today, veg.name);
  const pCan = (await needOf(today, pow.name)) - pBase;
  check('罐裝也不算菜', Math.abs(v1 - v0) < 0.5, `${veg.name} ${v0} → ${v1}`);
  check('罐裝的粉是袋裝的 1.1 倍', pBag > 0 && Math.abs(pCan / pBag - 1.1) < 0.02,
        `這張單貢獻：袋裝 ${pBag} → 罐裝 ${pCan}（${pBag > 0 ? (pCan / pBag).toFixed(2) : '?'} 倍）`);
  await api('/api/today/cases/' + (oCan.id || oCan.order_id), 'DELETE');
}

line('\n━━ 4. 扣庫存那一邊也要一致 ━━');
// 排產不算菜、扣庫存卻照扣，就是 2026-09-03 那種兩套算法的病
{
  const inv = async () => {
    const d = await api('/api/inventory');
    const rows = Array.isArray(d) ? d : (d.items || d.ingredients || []);
    return Object.fromEntries(rows.map(r => [r.name, r.qty]));
  };
  const b = await inv();
  await api('/api/inventory/consume', 'POST',
    { prescription_id: target.id, cups: CUPS, powder_type: '袋裝', date: today });
  const a = await inv();
  check('扣庫存不動菜', Math.abs(a[veg.name] - b[veg.name]) < 0.5,
        `${veg.name} ${b[veg.name]} → ${a[veg.name]}` +
        (Math.abs(a[veg.name] - b[veg.name]) < 0.5 ? '' : ' ★ 排產不算、扣庫存卻扣，帳會一路歪'));
  check('扣庫存有動粉', b[pow.name] - a[pow.name] > 0,
        `${pow.name} ${b[pow.name]} → ${a[pow.name]}`);
  // 還原：把剛才那筆消耗反轉
  // /api/consumption 回的是 rx_code / rx_name，沒有 prescription_id ——
  // 過濾條件寫錯的話這裡會靜默地什麼都沒還原，然後下一條斷言才失敗
  const c = await api('/api/consumption?date=' + today);
  const mine = (c.rows || []).filter(r =>
    r.rx_code === target.code && r.powder_type === '袋裝' && r.source === 'manual');
  for (const r of mine) await api('/api/consumption/' + r.id + '/reverse', 'POST', {}).catch(() => {});
  const back = await inv();
  check('還原後回到原本的量', Math.abs(back[pow.name] - b[pow.name]) < 0.5,
        `${pow.name} ${back[pow.name]} / ${b[pow.name]}`);
}

line('\n━━ 5. 備料表不要叫人去秤用不到的菜 ━━');
{
  const o = await mk('袋裝');
  const t = await api('/api/today');
  const mineCase = (t.products[0].cases || []).find(c => c.id === (o.id || o.order_id));
  check('那一單抓得到', !!mineCase, mineCase ? mineCase.patient_name : '★ 抓不到');
  if (mineCase) {
    const prepNames = (mineCase.prep || []).map(x => x.name);
    check('備料表沒有菜', !prepNames.includes(veg.name),
          prepNames.length ? '鮮食欄：' + prepNames.join('、') : '鮮食欄是空的');
    const powNames = ((mineCase.powder || {}).items || []).map(x => x.name);
    check('備料表有粉', powNames.includes(pow.name), '粉欄：' + powNames.join('、'));
  }
  await api('/api/today/cases/' + (o.id || o.order_id), 'DELETE');
}

line('\n━━ 6. 缺料與採購也跟著 ━━');
{
  const v0 = await forecastNeed(veg.name);
  const o = await mk('袋裝');
  const v1 = await forecastNeed(veg.name);
  check('採購預估不會因為粉單而多抓菜', Math.abs(v1 - v0) < 0.5,
        `${veg.name} 整段需求 ${v0} → ${v1}`);
  await api('/api/today/cases/' + (o.id || o.order_id), 'DELETE');
}

line('\n━━ 7. 收尾 ━━');
await cleanup();
{
  const left = ((await api('/api/today')).products[0].cases || [])
    .filter(c => String(c.patient_name || '').startsWith('ZZ粉'));
  check('測試出單已清掉', left.length === 0, left.map(c => c.patient_name).join('、') || '沒有殘留');
}

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
