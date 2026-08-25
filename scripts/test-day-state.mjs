// 當日狀態與出席判定的回歸測試
// 針對「同一系統同一時間，兩台裝置顯示不同批次」那次事故：
//   1. 休假姓名大小寫比對
//   2. auto/manual 出席來源
//   3. 當日工作狀態存在伺服器（不是 localStorage）
//   4. 出席人數與批次杯數必須自洽
const B = 'http://localhost:3999';
const H = { 'X-Kitchen-User-Id': '1', 'Content-Type': 'application/json' };

const api = async (path, method = 'GET', body = null) => {
  const r = await fetch(B + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};

let pass = 0, fail = 0;
const line = s => console.log(s);
const check = (name, cond, detail = '') => {
  if (cond) { pass++; line(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else      { fail++; line(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
};
const norm = s => String(s || '').toLowerCase().trim();

line('\n━━ 1. 休假比對不分大小寫 ━━');
const d = await api('/api/today');
const leaves = (d.leaves || []).map(norm);
const attending = d.staff.filter(s => s.attending);
const leakedIn = attending.filter(s => leaves.includes(norm(s.name)));
check('休假的人不會被算成出席',
      leakedIn.length === 0,
      leaves.length ? `休假 ${d.leaves.join('、')}｜誤算 ${leakedIn.map(s => s.name).join('、') || '無'}`
                    : '（今天沒有人休假，此項未實質受測）');

line('\n━━ 2. 出席人數與批次杯數自洽 ━━');
const p = d.products[0];
const batchCups = p.batches.reduce((s, b) => s + b.size * b.count, 0);
check('批次總杯數 = 出席人數 + 員工配方個案杯數',
      batchCups === p.total_staff_cups,
      `批次 ${p.batches.flatMap(b => Array(b.count).fill(b.size)).join('+')} = ${batchCups}｜出席 ${d.attending_count} + 個案 ${p.extra_cups} = ${p.total_staff_cups}`);
check('total_staff_cups 等於 attending_count + extra_cups',
      p.total_staff_cups === d.attending_count + p.extra_cups);

line('\n━━ 3. 出席來源 auto / manual ━━');
const someone = d.staff[0];
const before = someone.attending;
await api('/api/today/attendance/' + someone.user_id, 'PUT',
          { attending: !before, meal_time: someone.meal_time || '1330' });
const d2 = await api('/api/today');
const after = d2.staff.find(s => s.user_id === someone.user_id);
check('手動改過的出席狀態不會被休假同步覆蓋',
      !!after.attending === !before,
      `${someone.name}：${before ? '出席' : '不出席'} → ${after.attending ? '出席' : '不出席'}`);
check('手動改過會標記為 manual', after.source === 'manual', `source=${after.source}`);
// 還原
await api('/api/today/attendance/' + someone.user_id, 'PUT',
          { attending: before, meal_time: someone.meal_time || '1330' });

line('\n━━ 4. 當日工作狀態存在伺服器 ━━');
const probe = {
  staff: [1, 2], cases: [], schOrder: null,
  batchGroups: [{ manualTime: null, memberIds: ['s_1', 's_2'] }],
  deductedBatches: [0], deductedCases: []
};
await api('/api/today/state', 'PUT', { date: d.date, state: probe });
const got = await api('/api/today/state?date=' + d.date);
check('狀態寫得進伺服器', !!got.state, `更新者 ${got.updated_by}｜${got.updated_at}`);
check('批次分組原樣讀得回來',
      JSON.stringify(got.state.batchGroups) === JSON.stringify(probe.batchGroups));
check('庫存已扣紀錄也一起共用（避免兩台裝置各扣一次）',
      JSON.stringify(got.state.deductedBatches) === JSON.stringify(probe.deductedBatches));

const d3 = await api('/api/today');
check('/api/today 一併帶回當日狀態，前端不必多打一次',
      !!(d3.day_state && d3.day_state.state));

line('\n━━ 5. 清理 ━━');
await api('/api/today/state', 'PUT', { date: d.date, state: {} });
const cleaned = await api('/api/today/state?date=' + d.date);
check('測試狀態已清空',
      !cleaned.state.batchGroups && !(cleaned.state.staff || []).length);

line(`\n${'─'.repeat(46)}`);
line(`通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
