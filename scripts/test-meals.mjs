// 套餐模組流程測試（對 localhost:3999 的測試伺服器）
const B = 'http://localhost:3999';
const H = { 'X-Kitchen-User-Id': '1', 'Content-Type': 'application/json' };

const api = async (path, method = 'GET', body = null) => {
  const r = await fetch(B + path, {
    method, headers: H, body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

const line = (s) => console.log(s);
const money = (n) => '$' + n;

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; line(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else      { fail++; line(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
};

// ── 0. 先清掉先前測試殘留 ───────────────────────────────
const existing = await api('/api/meals/today');
for (const o of existing.orders) {
  if (String(o.patient_name).startsWith('測試')) await api('/api/meals/orders/' + o.id, 'DELETE');
}

line('\n━━ 1. 精力湯熱量計算 ━━');
const emp = await api('/api/nutrition/prescription/1');
check('EMP-00 由配方算出熱量', emp.kcal === 412, `${emp.kcal} kcal / ${emp.protein_g}g protein`);

const rx06bag  = await api('/api/nutrition/prescription/27');
const rx06full = await api('/api/nutrition/prescription/27?powder_type=' + encodeURIComponent('全配方'));
check('全配方粉類 ×1.1 生效', rx06full.kcal > rx06bag.kcal,
      `袋裝 ${rx06bag.kcal} → 全配方 ${rx06full.kcal} kcal`);

line('\n━━ 2. 建立出單（兩種採購模式）━━');
const o1 = await api('/api/meals/orders', 'POST',
  { meal_item_id: 1, qty: 2, meal_time: '1200', patient_name: '測試甲', purchase_mode: '餐盒' });
const o2 = await api('/api/meals/orders', 'POST',
  { meal_item_id: 2, qty: 1, meal_time: '1330', patient_name: '測試乙', purchase_mode: '單點' });
const o3 = await api('/api/meals/orders', 'POST',
  { meal_item_id: 8, qty: 1, meal_time: '1330', patient_name: '測試丙', purchase_mode: '餐盒' });
check('三筆出單建立成功', !!(o1.id && o2.id && o3.id), `id ${o1.id}, ${o2.id}, ${o3.id}`);

const day = await api('/api/meals/today');
const mine = day.orders.filter(o => String(o.patient_name).startsWith('測試'));
const single = mine.find(o => o.id === o2.id);
check('單點模式套用單點價與單點熱量',
      single.purchase_mode === '單點' && single.price === 70 && single.kcal === 180,
      `${single.display_name} ${money(single.price)} / ${single.kcal} kcal`);

line('\n━━ 3. 依店家分組的採購清單 ━━');
day.purchase_lists.forEach(g => {
  line(`  ■ ${g.vendor}（${g.branch}）步行 ${g.walk_minutes} 分  ${g.phone || ''}`);
  g.lines.forEach(l => line(`      ${l.item} [${l.mode}] ×${l.qty} @${money(l.unit_price)} = ${money(l.subtotal)}`));
  line(`      小計 ${money(g.total)}`);
});
line(`  預計總額 ${money(day.planned_total)}｜已回填 ${money(day.spent_total)}`);
check('採購清單依店家分組', day.purchase_lists.length === 2,
      `${day.purchase_lists.length} 間店家`);
check('同店家同品項合併成一列',
      day.purchase_lists.every(g => new Set(g.lines.map(l => l.key)).size === g.lines.length));

line('\n━━ 4. 改採購模式時快照跟著換 ━━');
await api('/api/meals/orders/' + o3.id, 'PUT', { purchase_mode: '單點' });
const day2 = await api('/api/meals/today');
const changed = day2.orders.find(o => o.id === o3.id);
check('餐盒 → 單點，價格與熱量同步',
      changed.price === 89 && changed.kcal === 280,
      `${changed.display_name} ${money(changed.price)} / ${changed.kcal} kcal`);

line('\n━━ 5. 採購回填 ━━');
const l1 = day2.purchase_lists[0].lines[0];
await api('/api/meals/purchase', 'POST', {
  meal_item_id: 1, qty: l1.qty, total_price: 280, purchase_mode: '餐盒', order_ids: l1.order_ids
});
const day3 = await api('/api/meals/today');
const purchased = day3.orders.filter(o => l1.order_ids.includes(o.id));
check('出單轉為已採購', purchased.every(o => o.status === '已採購'));
check('實付金額入帳', day3.spent_total === 280, money(day3.spent_total));

line('\n━━ 6. 隨餐小卡 ━━');
const cards = await api('/api/meals/cards/today');
check('每份餐點各一張小卡', cards.cards.length === 4, `${cards.cards.length} 張`);
check('未覆核的小卡擋住列印', cards.blocked_count === cards.cards.length,
      `${cards.blocked_count} 張待覆核`);
const c0 = cards.cards[0];
check('小卡帶入該個案的套餐總熱量', c0.meal_kcal > 0, `${c0.meal_name} ${c0.meal_kcal} kcal`);

line('\n━━ 7. 覆核流程 ━━');
const all = await api('/api/meals/cards');
const tonicCard = all.cards.find(c => c.subject_type === 'product');
await api('/api/meals/cards/' + tonicCard.id, 'PUT', { review: true });
const after = await api('/api/meals/cards');
const t2 = after.cards.find(c => c.id === tonicCard.id);
check('覆核記下人與日期', !!t2.reviewed_at && !!t2.reviewed_by, `${t2.reviewed_by} @ ${t2.reviewed_at}`);
await api('/api/meals/cards/' + tonicCard.id, 'PUT', { story: t2.story + '（改）' });
const after2 = await api('/api/meals/cards');
check('改文案後覆核狀態自動失效',
      !after2.cards.find(c => c.id === tonicCard.id).reviewed_at);
// 還原
await api('/api/meals/cards/' + tonicCard.id, 'PUT', { story: t2.story });

line('\n━━ 8. 成本整合 ━━');
const costs = await api('/api/costs');
check('今日成本含餐盒', !!costs.today.meals, JSON.stringify(costs.today.meals));
const monthly = await api('/api/costs/monthly');
check('月報含餐盒合計', !!monthly.meals,
      `${monthly.meals.count} 份 / ${money(monthly.meals.total)} / 每份 ${money(monthly.meals.cost_per_box)}`);

line('\n━━ 9. 精力湯零回歸 ━━');
const t = await api('/api/today');
check('/api/today 仍回傳 products', Array.isArray(t.products) && t.products.length > 0);
check('精力湯批次計算未受影響', !!t.products[0].batches);
check('/api/today 新增 meals 區塊', !!t.meals);
const rxCost = costs.prescriptions.find(p => p.code === 'EMP-00');
check('處方成本表仍正常', rxCost && rxCost.total_cost > 0, `EMP-00 每杯 ${money(rxCost.total_cost)}`);

line('\n━━ 10. 清理測試資料 ━━');
for (const o of (await api('/api/meals/today')).orders) {
  if (String(o.patient_name).startsWith('測試')) await api('/api/meals/orders/' + o.id, 'DELETE');
}
const purchases = await api('/api/meals/purchases');
for (const p of purchases) if (p.total_price === 280) await api('/api/meals/purchases/' + p.id, 'DELETE');
const final = await api('/api/meals/today');
check('測試資料清乾淨', final.orders.filter(o => String(o.patient_name).startsWith('測試')).length === 0);

line(`\n${'─'.repeat(46)}`);
line(`通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
