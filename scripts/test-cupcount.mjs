// 「今天幾杯」只能有一個答案
//
//   系統裡有兩條路各自在算杯數：
//     expectedForDate  → 決定扣多少庫存
//     cupsOnDate       → 決定做不做得出來、要買多少
//
//   2026-09-03 這兩個數字是 20 和 16。差的 4 杯是三張「用員工配方的個案單」——
//   cupsOnDate 的查詢寫了 p.is_staff_rx=0 想避開重複，但員工那幾杯是從
//   出勤表來的，這些是另外點的單。排掉的結果：那 4 杯照做、照扣庫存，
//   但缺料與採購從頭到尾當它們不存在。帳面庫存會一路虛高。
//
//   沒有例外時，兩條路必須算出同一個數字。
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

const today = new Date().toISOString().slice(0, 10);
const cupsOf = async d => (await api('/api/day/cups?date=' + d)).total_cups;
const expectOf = async d => (await api('/api/consumption/expected?date=' + d)).total_cups;

line('\n━━ 1. 沒有人點過時，兩條路要算出同一個數字 ━━');
// 「扣庫存」現在只算點過的，跟「該做幾杯」本來就會不一樣 ——
// 要比對兩條路有沒有算漏，得站在「沒有人點過」的退路規則上比
const st = await api('/api/today/state?date=' + today);
const orig = st.state ? JSON.parse(JSON.stringify(st.state)) : null;
const clearTaps = () => api('/api/today/state', 'PUT', {
  date: today,
  state: { ...(orig || {}), staff: [], cases: [], staffMissed: [], caseMissed: [] }
});
await clearTaps();
const a = await cupsOf(today), b = await expectOf(today);
check('排產杯數 = 扣庫存杯數', Math.abs(a - b) < 0.05,
      `做得出來算 ${a} 杯／扣庫存算 ${b} 杯` +
      (Math.abs(a - b) < 0.05 ? '' : ' ★ 有一邊漏算，帳會一路歪掉'));

line('\n━━ 2. 用員工配方的個案單不能被漏掉 ━━');
const rxs = await api('/api/prescriptions?include_inactive=1');
const staffRx = rxs.find(r => r.is_staff_rx === 1 && r.active === 1);
check('找得到啟用中的員工配方', !!staffRx, staffRx && staffRx.code);
if (staffRx) {
  await clearTaps();
  const before = await cupsOf(today);
  const o = await api('/api/today/cases', 'POST',
    { date: today, prescription_id: staffRx.id, cups: 3, powder_type: '' });
  const after = await cupsOf(today);
  check('加一張 3 杯的員工配方單，排產要跟著 +3', Math.abs(after - before - 3) < 0.05,
        `${before} → ${after}` +
        (Math.abs(after - before - 3) < 0.05 ? '' : ' ★ 這幾杯照做卻沒人算料'));
  await clearTaps();
  const exp = await expectOf(today);
  check('扣庫存也是同一個數字', Math.abs(exp - after) < 0.05, `扣 ${exp} 杯／做 ${after} 杯`);

  const id = o.id || o.order_id;
  if (id) await api('/api/today/cases/' + id, 'DELETE');
  check('刪掉之後回到原本的數字', Math.abs((await cupsOf(today)) - before) < 0.05,
        `${await cupsOf(today)} / ${before}`);
}

line('\n━━ 2.5 每日固定供應又另外開單 ━━');
// 正式環境就是這樣：AW 設了每日 1 杯，同時每天還會另外建一張單。
// 兩邊各自去重，結果 AW 從排產裡整個消失 —— 那杯照做，卻沒人算料。
// 規則要一致：有單就以單為準，沒單才用每日預設值
const dailyRx = (await api('/api/prescriptions')).find(r => (r.daily_cups || 0) > 0);
if (!dailyRx) { line('  － 沒有每日固定供應的處方，這組略過'); }
else {
  const base = await cupsOf(today);
  const o2 = await api('/api/today/cases', 'POST',
    { date: today, prescription_id: dailyRx.id, cups: 2, powder_type: '' });
  const withOrder = await cupsOf(today);
  await clearTaps();
  const exp2 = await expectOf(today);

  // 預設 1 杯 → 開一張 2 杯的單，總數應該只 +1（單取代預設，不是疊加）
  const delta = withOrder - base;
  check(`${dailyRx.code} 開單後不會憑空消失`, withOrder >= base,
        `${base} → ${withOrder}` + (withOrder >= base ? '' : ' ★ 那杯照做卻沒人算料'));
  check('單取代每日預設值，不是疊加', Math.abs(delta - (2 - dailyRx.daily_cups)) < 0.05,
        `預設 ${dailyRx.daily_cups} 杯、單 2 杯 → 總數 ${delta >= 0 ? '+' : ''}${delta}`);
  check('排產與扣庫存仍然一致', Math.abs(withOrder - exp2) < 0.05,
        `做 ${withOrder} 杯／扣 ${exp2} 杯`);

  const id2 = o2.id || o2.order_id;
  if (id2) await api('/api/today/cases/' + id2, 'DELETE');
  check('刪掉單之後回到每日預設值', Math.abs((await cupsOf(today)) - base) < 0.05,
        `${await cupsOf(today)} / ${base}`);
}

line('\n━━ 3. 有人點了之後，扣庫存要比排產少 ━━');
// 排產是「照排班該做幾杯」，扣庫存是「實際被領走幾杯」——
// 還沒領完時這兩個數字本來就該不一樣，不能硬要相等
const td3 = await api('/api/today');
const att3 = (td3.staff || []).filter(x => x.attending === 1 && x.date === today);
if (!att3.length) { line('  － 今天沒有出勤紀錄，這組略過'); }
else {
  await api('/api/today/state', 'PUT', {
    date: today,
    state: { ...(orig || {}), staff: [att3[0].user_id], cases: [], staffMissed: [], caseMissed: [] }
  });
  const plan = await cupsOf(today), real = await expectOf(today);
  check('只有一個人領走時，扣的比該做的少', real < plan,
        `該做 ${plan} 杯／實扣 ${real} 杯`);
  check('排產不受點選影響', plan > 0, `${plan} 杯`);
  await clearTaps();
}

line('\n━━ 4. 還原 ━━');
if (orig) await api('/api/today/state', 'PUT', { date: today, state: orig });
const back = await api('/api/today/state?date=' + today);
check('當天狀態還原', JSON.stringify(back.state) === JSON.stringify(orig) || !orig);

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
