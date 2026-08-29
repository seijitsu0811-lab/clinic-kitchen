// 例外管理的回歸測試
//   排程上的東西預設就是做了、送出去了，只有被明確標記的才是沒發生。
//   這組測的是「例外會不會真的影響應扣量」——
//   例外若只存在畫面上、沒進到伺服器的計算，隔天的自動補扣就會把沒做的也扣掉。
//
//   測試自己造出席與出單，不依賴今天剛好有資料 ——
//   週末跑起來全部略過而「通過」的測試，等於沒有測試。
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

const day = await api('/api/today');
const today = day.date;
const setState = s => api('/api/today/state', 'PUT', { date: today, state: s });
const getState = async () => (await api('/api/today')).day_state?.state || {};
const expected = () => api('/api/consumption/expected?date=' + today);
const attend = (uid, on) =>
  api('/api/today/attendance/' + uid, 'PUT', { attending: on ? 1 : 0, meal_time: '1130' });

// ── 前置：造出兩位出席員工和一筆個案出單 ──────────────────
line('\n━━ 0. 準備 ━━');
const origState = await getState();
const origAttend = new Map(day.staff.map(s => [s.user_id, s.attending ? 1 : 0]));
const [uA, uB] = day.staff.slice(0, 2);
if (!uA || !uB) { line('  ✗ 至少要有兩位員工才能測'); process.exit(1); }
for (const s of day.staff) await attend(s.user_id, 0);      // 全部清成沒出席
await attend(uA.user_id, 1); await attend(uB.user_id, 1);        // 只留兩位

const rx = (await api('/api/prescriptions')).find(r => r.code && !r.code.startsWith('EMP'));
const mk = await api('/api/today/cases', 'POST',
  { prescription_id: rx.id, cups: 3, meal_time: '1130', powder_type: '袋裝',
    patient_name: 'ZZ例外測試', notes: '' });
const caseId = mk.id;
await setState({ ...origState, staffMissed: [], caseMissed: [] });
const base = await expected();
check('前置就緒：2 位出席 ＋ 1 筆 3 杯的出單', base.total_cups === 5,
      `應扣 ${base.total_cups} 杯（員工 2 ＋ 個案 3）`);

line('\n━━ 1. 標記員工未領，應扣量要跟著少 ━━');
await setState({ ...origState, staffMissed: [uA.user_id], caseMissed: [] });
let after = await expected();
check('少一位員工＝少一杯', after.total_cups === 4, `5 → ${after.total_cups}`);

line('\n━━ 2. 標記個案未出餐，整筆不列入 ━━');
await setState({ ...origState, staffMissed: [], caseMissed: [caseId] });
after = await expected();
check('少一筆 3 杯的個案', after.total_cups === 2, `5 → ${after.total_cups}`);

line('\n━━ 3. 兩種例外同時存在 ━━');
await setState({ ...origState, staffMissed: [uA.user_id, uB.user_id], caseMissed: [caseId] });
after = await expected();
check('全部標掉就沒有東西要扣', after.total_cups === 0, `5 → ${after.total_cups}`);

line('\n━━ 4. 沒出席的人被標未領，不會扣兩次 ━━');
const absent = day.staff.find(s => s.user_id !== uA.user_id && s.user_id !== uB.user_id);
if (absent) {
  await setState({ ...origState, staffMissed: [absent.user_id], caseMissed: [] });
  after = await expected();
  check('沒出席的人標未領不影響應扣量', after.total_cups === 5, `應維持 5，實際 ${after.total_cups}`);
} else {
  line('  － 沒有第三位員工可測，略過');
}

line('\n━━ 5. 例外是全廚房共用的，不是存在某一台裝置 ━━');
await setState({ ...origState, staffMissed: [uA.user_id], caseMissed: [caseId] });
const back = await getState();
check('例外存得回伺服器也讀得回來',
      (back.staffMissed || []).includes(uA.user_id) && (back.caseMissed || []).includes(caseId));
const exposed = (await expected()).exceptions;
check('應扣清單會攤開它根據哪些例外算出來',
      exposed.staff_missed.includes(uA.user_id) && exposed.case_missed.includes(caseId));

line('\n━━ 6. 清理 ━━');
await api('/api/today/cases/' + caseId, 'DELETE');
for (const [id, on] of origAttend) await attend(id, on);
await setState(origState);
const restored = await getState();
check('狀態還原成測試前的樣子',
      JSON.stringify(restored.staffMissed || []) === JSON.stringify(origState.staffMissed || []));

line(`\n${'─'.repeat(46)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
