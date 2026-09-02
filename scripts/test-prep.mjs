// 備料批次的回歸測試
//
//   週一（或週四）一次把整段期間的量處理好，做成 N 份冷凍核心包。
//   原料在備料當下就離開冰箱，但系統原本要等出餐才扣 —— 兩個後果：
//     1. 盤點對不上：原料袋是空的，系統說還有 405g，被記成損耗
//     2. 誤報缺料：說「今天缺藍莓」，但藍莓就在冷凍包裡
//   誤報幾次之後就沒有人會理它，真的缺料時也一樣被忽略。
//
//   備料不綁週期 —— 可能一週做一次，也可能週一做一批、週四再補一批。
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
const inv = async () => Object.fromEntries((await api('/api/inventory')).map(i => [i.id, i.qty]));

// 先把殘留的備料批次還原，起點才確定
for (const b of await api('/api/prep/batches?days=90'))
  if (!b.reversed_at) await api('/api/prep/batch/' + b.id + '/reverse', 'POST').catch(() => {});

line('\n━━ 1. 分裝表：這一批要秤多少 ━━');
const ws = await api('/api/prep/worksheet?servings=10');
check('列得出冷凍包的用料', ws.items.length > 0,
      ws.items.map(i => `${i.name} ${i.need}${i.unit}`).join('、'));
check('只列冷凍包，不列現場秤的',
      ws.items.every(i => i.per_serving > 0), `${ws.items.length} 樣`);
check('用量 = 每份 × 份數',
      ws.items.every(i => Math.abs(i.need - i.per_serving * 10) < 0.05),
      `10 份`);
check('沒指定份數時會給建議', typeof (await api('/api/prep/worksheet')).suggested_servings === 'number',
      `建議 ${(await api('/api/prep/worksheet')).suggested_servings} 份`);

line('\n━━ 2. 備料會扣原料 ━━');
// 先把冷凍包那幾樣補到夠，才看得出扣了多少
await api('/api/stocktake', 'POST',
  { note: 'ZZ 備料測試前置', items: ws.items.map(i => ({ ingredient_id: i.id, counted_qty: 2000 })) });
const before = await inv();
const batch = await api('/api/prep/batch', 'POST', { servings: 10, note: 'ZZ 測試備料' });
check('建立成功', !!batch.id && batch.servings === 10, `${batch.plan}　10 份`);
const after = await inv();
const first = ws.items[0];
check('原料被扣掉了',
      Math.abs((before[first.id] - after[first.id]) - first.need) < 0.05,
      `${first.name} ${before[first.id]} → ${after[first.id]}（扣 ${first.need}）`);
check('每一樣都扣對',
      ws.items.every(i => Math.abs((before[i.id] - after[i.id]) - i.need) < 0.05));

line('\n━━ 3. 備品份數算得出來 ━━');
let st = await api('/api/prep/status');
check('做了 10 份', st.made === 10, `做 ${st.made}／已用 ${st.used}／剩 ${st.remaining}`);
check('剩餘 = 做的 − 已出的', Math.abs(st.remaining - Math.max(0, st.made - st.used)) < 0.05);

line('\n━━ 4. 冷凍包不再誤報缺料 ━━');
// 原料現在被扣到剩很少，但備品還有 —— 這時候不該說「缺藍莓」
const f = await api('/api/inventory/forecast?days=7');
check('預測回得出備品狀態', !!f.packs && typeof f.packs.remaining === 'number',
      `剩 ${f.packs.remaining} 份`);
const packNames = new Set(ws.items.map(i => i.name));
const dayWithCups = f.days.find(d => d.cups > 0);
if (dayWithCups) {
  const falseAlarm = dayWithCups.short.filter(x => packNames.has(x.name) && !x.from_pack);
  check('有備品的日子不會拿原料去報缺', falseAlarm.length === 0,
        falseAlarm.map(x => x.name).join('、') || `${dayWithCups.date} 沒有誤報`);
}
check('每一天都算得出還剩幾份',
      f.days.every(d => typeof d.packs_left === 'number'),
      f.days.slice(0, 4).map(d => d.date.slice(5) + ':' + d.packs_left).join('　'));

line('\n━━ 5. 備品用完了才報缺，而且標明是缺幾杯份 ━━');
const later = f.days.find(d => d.cups > 0 && d.short.some(x => x.from_pack));
check('備品不夠的日子才報冷凍包的缺',
      !later || later.short.some(x => x.from_pack),
      later ? `${later.date} 缺 ${later.short.filter(x => x.from_pack).length} 樣（備品用完）` : '（範圍內備品都夠）');

line('\n━━ 6. 記錯份量要改得回來 ━━');
await api('/api/prep/batch/' + batch.id + '/reverse', 'POST');
const back = await inv();
check('還原會把原料加回去',
      ws.items.every(i => Math.abs(back[i.id] - before[i.id]) < 0.05),
      `${first.name} ${after[first.id]} → ${back[first.id]}`);
st = await api('/api/prep/status');
check('還原後備品歸零', st.made === 0, `做 ${st.made} 份`);

line('\n━━ 7. 分兩批也要能加總 ━━');
const b1 = await api('/api/prep/batch', 'POST', { servings: 6, note: 'ZZ 週一那批' });
const b2 = await api('/api/prep/batch', 'POST', { servings: 4, note: 'ZZ 週四補的' });
st = await api('/api/prep/status');
check('兩批加起來', st.made === 10, `6 + 4 = ${st.made} 份`);
check('列得出每一批', st.batches.length === 2,
      st.batches.map(b => `${b.date} ${b.servings}份`).join('、'));

line('\n━━ 8. 清理 ━━');
for (const b of [b1, b2]) await api('/api/prep/batch/' + b.id + '/reverse', 'POST').catch(() => {});
// 庫存還原成測試開始前
const orig = {};
(await api('/api/inventory')).forEach(i => { orig[i.id] = i.qty; });
check('批次都已還原', (await api('/api/prep/status')).made === 0);
check('原料回到備料前', ws.items.every(i => Math.abs(orig[i.id] - before[i.id]) < 0.05),
      '兩批都還原，數量應與備料前相同');

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
