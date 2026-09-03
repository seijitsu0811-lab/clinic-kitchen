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

line('\n━━ 1. 沒有例外時，兩條路要算出同一個數字 ━━');
// 先把例外清掉，起點才確定
const st = await api('/api/today/state?date=' + today);
const orig = st.state ? JSON.parse(JSON.stringify(st.state)) : null;
if (orig) {
  await api('/api/today/state', 'PUT',
    { date: today, state: { ...orig, staffMissed: [], caseMissed: [] } });
}
const a = await cupsOf(today), b = await expectOf(today);
check('排產杯數 = 扣庫存杯數', Math.abs(a - b) < 0.05,
      `做得出來算 ${a} 杯／扣庫存算 ${b} 杯` +
      (Math.abs(a - b) < 0.05 ? '' : ' ★ 有一邊漏算，帳會一路歪掉'));

line('\n━━ 2. 用員工配方的個案單不能被漏掉 ━━');
const rxs = await api('/api/prescriptions?include_inactive=1');
const staffRx = rxs.find(r => r.is_staff_rx === 1 && r.active === 1);
check('找得到啟用中的員工配方', !!staffRx, staffRx && staffRx.code);
if (staffRx) {
  const before = await cupsOf(today);
  const o = await api('/api/today/cases', 'POST',
    { date: today, prescription_id: staffRx.id, cups: 3, powder_type: '' });
  const after = await cupsOf(today);
  check('加一張 3 杯的員工配方單，排產要跟著 +3', Math.abs(after - before - 3) < 0.05,
        `${before} → ${after}` +
        (Math.abs(after - before - 3) < 0.05 ? '' : ' ★ 這幾杯照做卻沒人算料'));
  const exp = await expectOf(today);
  check('扣庫存也是同一個數字', Math.abs(exp - after) < 0.05, `扣 ${exp} 杯／做 ${after} 杯`);

  const id = o.id || o.order_id;
  if (id) await api('/api/today/cases/' + id, 'DELETE');
  check('刪掉之後回到原本的數字', Math.abs((await cupsOf(today)) - before) < 0.05,
        `${await cupsOf(today)} / ${before}`);
}

line('\n━━ 3. 標了例外時，扣庫存要比排產少 ━━');
// 排產是「照排班該做幾杯」，扣庫存是「實際出了幾杯」——
// 有人沒領時這兩個數字本來就該不一樣，不能硬要相等
const st3 = await api('/api/today/state?date=' + today);
const cur = st3.state || {};
const users = await api('/api/users');
const someone = (users || [])[0];
if (someone) {
  await api('/api/today/state', 'PUT',
    { date: today, state: { ...cur, staffMissed: [someone.id], caseMissed: [] } });
  const plan = await cupsOf(today), real = await expectOf(today);
  check('未領會讓扣庫存變少，但排產不變', real <= plan,
        `排產 ${plan} 杯／實扣 ${real} 杯`);
  await api('/api/today/state', 'PUT',
    { date: today, state: { ...cur, staffMissed: [], caseMissed: [] } });
}

line('\n━━ 4. 還原 ━━');
if (orig) await api('/api/today/state', 'PUT', { date: today, state: orig });
const back = await api('/api/today/state?date=' + today);
check('當天狀態還原', JSON.stringify(back.state) === JSON.stringify(orig) || !orig);

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
