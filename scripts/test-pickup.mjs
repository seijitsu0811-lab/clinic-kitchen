// 預設沒拿，點了才代表領走
//
//   原本是「例外管理」：預設已出餐，點一下是標未領。現場覺得反直覺 ——
//   實際動作是「誰拿了點誰」，所以規則改成點了才算領走。
//
//   風險是漏點：那杯做了卻被當成沒出，庫存不會扣。所以留一條退路 ——
//   那一天完全沒有人點過（歷史資料、或當天根本沒人動畫面）就退回舊規則，
//   照出勤與出單補扣。扣多了盤點看得出來，扣不到才是真的查不出來。
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
const readState = async () => (await api('/api/today/state?date=' + today)).state || {};
const writeState = st => api('/api/today/state', 'PUT', { date: today, state: st });
const expected = () => api('/api/consumption/expected?date=' + today);

const orig0 = await api('/api/today/state?date=' + today);
const orig = orig0.state ? JSON.parse(JSON.stringify(orig0.state)) : null;
const base = { staff: [], cases: [], staffMissed: [], caseMissed: [],
               batchGroups: null, schOrder: null,
               deductedBatches: [], deductedCases: [], notes: {}, qc: {} };

const td = await api('/api/today');
const attending = (td.staff || []).filter(x => x.attending === 1 && x.date === today);
const orders = (td.products && td.products[0] && td.products[0].cases) || [];

line('\n━━ 1. 沒有人點過 → 退回舊規則，不能變成 0 杯 ━━');
// 這一條保護的是所有歷史日期，以及「今天大家都忘了點」
await writeState(base);
const none = await expected();
check('規則標示為退路', none.rule === '沒有人點過，照出勤與出單補扣', none.rule);
check('照樣算得出杯數', none.total_cups > 0,
      `${none.total_cups} 杯` + (none.total_cups > 0 ? '' : ' ★ 整天變成 0 杯，料就這樣消失'));

line('\n━━ 2. 有人點了 → 只算點過的 ━━');
if (!attending.length) { line('  － 今天沒有出勤紀錄，這組略過'); }
else {
  const two = attending.slice(0, 2).map(x => x.user_id);
  await writeState({ ...base, staff: two });
  const some = await expected();
  check('規則切換成「點了才算領」', some.rule === '點了才算領', some.rule);
  const staffRows = some.items.filter(i => /員工/.test(i.rx_name || ''));
  const staffCups = staffRows.reduce((s, i) => s + i.cups, 0);
  check('員工只算點過的那幾位',
        staffCups >= two.length && staffCups - two.length === 0
          || staffCups === two.length,
        `點了 ${two.length} 位，員工那段算 ${staffCups} 杯`);
  check('比全出勤少', some.total_cups < none.total_cups,
        `${none.total_cups} → ${some.total_cups} 杯`);
}

line('\n━━ 3. 個案出單也要點過才算 ━━');
if (!orders.length || !attending.length) { line('  － 今天沒有出單或出勤，這組略過'); }
else {
  const o = orders[0];
  const u = attending[0].user_id;
  // 每日固定供應那種畫面上沒有晶片可以點，不受點選影響 ——
  // 所以不能直接看總數，要比「有點這張單」和「沒點這張單」的差
  await writeState({ ...base, staff: [u], cases: [o.id] });
  const withOrder = (await expected()).total_cups;
  await writeState({ ...base, staff: [u], cases: [] });
  const withoutOrder = (await expected()).total_cups;
  check(`點了那張 ${o.cups} 杯的單，總數就多 ${o.cups} 杯`,
        Math.abs((withOrder - withoutOrder) - o.cups) < 0.05,
        `點了 ${withOrder} 杯／沒點 ${withoutOrder} 杯，差 ${Math.round((withOrder - withoutOrder) * 10) / 10}`);
  check('沒點的單不會被算進去', withoutOrder < withOrder,
        withoutOrder < withOrder ? '' : '★ 沒點也照扣，等於這條規則沒生效');
}

line('\n━━ 4. 點了再取消，要真的退回去 ━━');
if (attending.length) {
  const one = attending[0].user_id;
  await writeState({ ...base, staff: [one] });
  const a = (await expected()).total_cups;
  await writeState({ ...base, staff: [] });
  const b = await expected();
  check('取消之後回到退路規則', b.rule === '沒有人點過，照出勤與出單補扣',
        `${a} 杯 → ${b.total_cups} 杯（${b.rule}）`);
}

line('\n━━ 5. 攤開得出是誰點的 ━━');
if (attending.length) {
  const one = attending[0].user_id;
  await writeState({ ...base, staff: [one] });
  const e = await expected();
  check('列得出點過的名單', e.picked && e.picked.staff.includes(one),
        `staff = [${e.picked.staff}]　—— 查帳時要看得出這個數字怎麼來的`);
}

line('\n━━ 6. 還原 ━━');
await writeState(orig || base);
const back = await readState();
check('當天狀態還原',
      JSON.stringify(back) === JSON.stringify(orig || base) || !orig);

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
