// 餐盒分食的回歸測試
//   一盒可以幾個人分是「這一單」的選擇，不是這款餐盒的固定屬性 ——
//   同一款便當，有人要一人一盒，有人三個人分兩盒。
//   錢和採購按「盒」算，衛教小卡按「人」算，兩邊不能混。
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

const menu = await api('/api/meals/menu');
const items = menu.series.flatMap(s => s.items);
const box = items.find(i => i.code === 'SET-B3-PORK') || items[0];
const made = [];
const mk = async (people, sp, sb, name) => {
  const r = await api('/api/meals/orders', 'POST',
    { meal_item_id: box.id, qty: people, share_people: sp, share_boxes: sb,
      meal_time: '1330', patient_name: name, purchase_mode: '餐盒' });
  made.push(r.id); return r.id;
};
const shopLine = async () => {
  const s = await api('/api/meals/shopping');
  const stop = s.stops.find(st => st.lines.some(l => l.order_ids.some(id => made.includes(id))));
  return stop && stop.lines.find(l => l.order_ids.some(id => made.includes(id)));
};

line('\n━━ 1. 阿北套餐建好了 ━━');
const abei = items.find(i => i.code === 'SET-A4-PORK');
check('阿北套餐在菜單上', !!abei, abei ? `${abei.display_name} $${abei.price_box}` : '(缺)');
check('價格 125', abei && abei.price_box === 125, abei && String(abei.price_box));
check('報給店家的品名是內容物', abei && /小肉|豬血湯/.test(abei.vendor_item_name || ''),
      abei && abei.vendor_item_name);
check('熱量標為待確認，不用估算值充數',
      abei && abei.kcal === 0, abei && `${abei.kcal} kcal`);

line('\n━━ 2. 一人一盒 ━━');
await mk(3, 1, 1, 'ZZ分食測試甲');
let ln = await shopLine();
check('3 人份要買 3 盒', ln && ln.qty === 3, ln && `${ln.qty} 盒 / ${ln.people} 人`);

line('\n━━ 3. 兩人一盒 ━━');
for (const id of made) await api('/api/meals/orders/' + id, 'DELETE');
made.length = 0;
await mk(4, 2, 1, 'ZZ分食測試乙');
ln = await shopLine();
check('4 人份、兩人一盒 → 買 2 盒', ln && ln.qty === 2, ln && `${ln.qty} 盒 / ${ln.people} 人`);
check('採購單標出分法', ln && ln.share_note === '2 人 1 盒', ln && ln.share_note);

line('\n━━ 4. 三人兩盒 ━━');
for (const id of made) await api('/api/meals/orders/' + id, 'DELETE');
made.length = 0;
await mk(3, 3, 2, 'ZZ分食測試丙');
ln = await shopLine();
check('3 人份、三人兩盒 → 買 2 盒', ln && ln.qty === 2, ln && `${ln.qty} 盒 / ${ln.people} 人`);

line('\n━━ 5. 分不盡要無條件進位，不能少買 ━━');
for (const id of made) await api('/api/meals/orders/' + id, 'DELETE');
made.length = 0;
await mk(5, 2, 1, 'ZZ分食測試丁');
ln = await shopLine();
check('5 人份、兩人一盒 → 買 3 盒（不是 2.5）', ln && ln.qty === 3,
      ln && `${ln.qty} 盒 / ${ln.people} 人`);

line('\n━━ 6. 錢按盒算，不是按人算 ━━');
const costs = await api('/api/costs');
const meal = costs.today && costs.today.meals;
check('成本以盒計價', meal && meal.planned === 3 * box.price_box,
      meal ? `預估 $${meal.planned}（3 盒 × $${box.price_box}）` : '(無)');

line('\n━━ 7. 衛教小卡按人算 ━━');
const cards = await api('/api/meals/cards/today');
const mine = (cards.cards || []).filter(c => String(c.patient_name).startsWith('ZZ分食'));
check('5 人份印 5 張卡，不是 3 張', mine.length === 5, `${mine.length} 張`);

line('\n━━ 8. 舊資料不受影響 ━━');
for (const id of made) await api('/api/meals/orders/' + id, 'DELETE');
made.length = 0;
const legacy = await api('/api/meals/orders', 'POST',
  { meal_item_id: box.id, qty: 2, meal_time: '1330', patient_name: 'ZZ舊資料', purchase_mode: '餐盒' });
made.push(legacy.id);
ln = await shopLine();
check('沒指定分法就是一人一盒', ln && ln.qty === 2, ln && `${ln.qty} 盒 / ${ln.people} 人`);

line('\n━━ 9. 清理 ━━');
for (const id of made) await api('/api/meals/orders/' + id, 'DELETE');
const left = (await api('/api/meals/today')).orders.filter(o => String(o.patient_name).startsWith('ZZ'));
check('測試資料清乾淨', left.length === 0, `殘留 ${left.length} 筆`);

line(`\n${'─'.repeat(46)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
