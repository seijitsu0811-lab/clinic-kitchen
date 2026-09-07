import { ensureMealDay } from './_setup.mjs';
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

// 這一組原本要當天剛好有出勤、有出單才跑得起來。週一早上、週末、或
// 任何還沒有人按出勤的時候，整組會「略過」然後回報通過 ——
// 通過 0 項的測試等於沒有測試。所以自己造，跑完再還原。
// 今天不一定是員工供餐日（現在是週二、週四）。不是的話員工那段一律 0 杯，
// 整組測不出東西 —— 所以測試自己把今天設成供餐日，跑完還原。
// 靠「今天剛好是週二」才跑得起來的測試，一週有五天等於沒有測試。
const restoreDow = await ensureMealDay(api, today);

const td0 = await api('/api/today');
const users = await api('/api/users');
const rxAll = await api('/api/prescriptions');
const caseRx = rxAll.find(r => !r.is_staff_rx && !(r.daily_cups > 0)) || rxAll[0];

// 出勤：記下原本的樣子，最後放回去
const attBefore = Object.fromEntries(
  (td0.staff || []).filter(x => x.date === today).map(x => [x.user_id, x.attending]));
const madeAtt = [];
for (const u of (users || []).slice(0, 2)) {
  if (attBefore[u.id] !== 1) {
    await api('/api/today/attendance/' + u.id, 'PUT', { attending: 1, meal_time: '1130' });
    madeAtt.push(u.id);
  }
}

// 先清掉上一次跑到一半留下的殘留 —— 測試中斷過就會留在那裡，
// 下一次跑就會因為「還有 ZZ 單」而失敗，看起來像新的問題
for (const c of ((await api('/api/today')).products[0].cases || [])) {
  if (String(c.patient_name || '').startsWith('ZZ'))
    await api('/api/today/cases/' + c.id, 'DELETE').catch(() => {});
}

// 出單：自己開一張，測完刪掉
let madeOrder = null;
const o0 = await api('/api/today/cases', 'POST',
  { date: today, prescription_id: caseRx.id, cups: 2, powder_type: '內用',
    patient_name: 'ZZ 取餐測試', meal_time: '1130' });
madeOrder = o0.id || o0.order_id;

const td = await api('/api/today');
const attending = (td.staff || []).filter(x => x.attending === 1 && x.date === today);
const orders = (td.products && td.products[0] && td.products[0].cases) || [];
check('前置：今天算得上供餐日', (await api('/api/today')).is_meal_day === true,
      '（測試會確保今天算供餐日，跑完還原）');
check('前置：造得出出勤與出單', attending.length > 0 && orders.length > 0,
      `出勤 ${attending.length} 位、出單 ${orders.length} 筆`);

line('\n━━ 1. 沒有人點過 → 退回舊規則，不能變成 0 杯 ━━');
// 這一條保護的是所有歷史日期，以及「今天大家都忘了點」
await writeState(base);
const none = await expected();
check('規則標示為退路', none.rule === '沒有人點過，照出勤與出單補扣', none.rule);
check('照樣算得出杯數', none.total_cups > 0,
      `${none.total_cups} 杯` + (none.total_cups > 0 ? '' : ' ★ 整天變成 0 杯，料就這樣消失'));

line('\n━━ 2. 有人點了 → 只算點過的 ━━');
{
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
{
  const o = orders.find(x => x.id === madeOrder) || orders[0];
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
{
  const one = attending[0].user_id;
  await writeState({ ...base, staff: [one] });
  const a = (await expected()).total_cups;
  await writeState({ ...base, staff: [] });
  const b = await expected();
  check('取消之後回到退路規則', b.rule === '沒有人點過，照出勤與出單補扣',
        `${a} 杯 → ${b.total_cups} 杯（${b.rule}）`);
}

line('\n━━ 5. 攤開得出是誰點的 ━━');
{
  const one = attending[0].user_id;
  await writeState({ ...base, staff: [one] });
  const e = await expected();
  check('列得出點過的名單', e.picked && e.picked.staff.includes(one),
        `staff = [${e.picked.staff}]　—— 查帳時要看得出這個數字怎麼來的`);
}

line('\n━━ 6. 還原 ━━');
await writeState(orig || base);
if (madeOrder) await api('/api/today/cases/' + madeOrder, 'DELETE').catch(() => {});
await restoreDow();
for (const uid of madeAtt) {
  await api('/api/today/attendance/' + uid, 'PUT', { attending: 0, meal_time: '1130' })
    .catch(() => {});
}
const back = await readState();
check('當天狀態還原',
      JSON.stringify(back) === JSON.stringify(orig || base) || !orig);
const leftover = ((await api('/api/today')).products[0].cases || [])
  .filter(c => String(c.patient_name || '').startsWith('ZZ'));
check('測試造的出單已清掉', leftover.length === 0,
      leftover.map(c => c.patient_name).join('、') || '沒有殘留');

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
