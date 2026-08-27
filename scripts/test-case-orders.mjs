// 驗證：改個案出單的處方會真的存進去，而且改成員工標準後會進入員工批次
const B = 'http://localhost:3999';
const H = { 'X-Kitchen-User-Id': '1', 'Content-Type': 'application/json' };
const api = async (p, m = 'GET', b = null) => {
  const r = await fetch(B + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${m} ${p} → ${r.status}: ${t.slice(0, 160)}`);
  return t ? JSON.parse(t) : null;
};
let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? (pass++, console.log(`  ✓ ${n}${d ? '  ' + d : ''}`))
                                    : (fail++, console.log(`  ✗ ${n}${d ? '  ' + d : ''}`)); };

const rxs  = await api('/api/prescriptions');
const emp  = rxs.find(r => r.is_staff_rx);
const other = rxs.find(r => !r.is_staff_rx && r.id !== emp.id);

console.log('\n━━ 建立一筆用個人處方的出單 ━━');
const co = await api('/api/today/cases', 'POST',
  { prescription_id: other.id, cups: 1, meal_time: '1330', powder_type: '內用', patient_name: 'ZZ換方測試' });
let t = await api('/api/today');
let mine = t.products[0].cases.find(c => c.id === co.id);
check('建立時是個人處方', mine.prescription_id === other.id, `${mine.code} ${mine.rx_name}`);
check('個人處方不進員工批次',
      !t.products[0].staff_rx_cases.some(c => c.id === co.id), '（這是正確行為）');

console.log('\n━━ 改成員工標準 ━━');
await api('/api/today/cases/' + co.id, 'PUT',
  { prescription_id: emp.id, cups: 1, meal_time: '1330', powder_type: '內用', patient_name: 'ZZ換方測試' });
t = await api('/api/today');
mine = t.products[0].cases.find(c => c.id === co.id);
check('處方真的被改掉了', mine.prescription_id === emp.id, `${other.code} → ${mine.code}`);
check('改完之後就會進員工批次',
      t.products[0].staff_rx_cases.some(c => c.id === co.id));

console.log('\n━━ 沒帶 prescription_id 時不會被清掉 ━━');
await api('/api/today/cases/' + co.id, 'PUT',
  { cups: 2, meal_time: '1200', powder_type: '內用', patient_name: 'ZZ換方測試' });
t = await api('/api/today');
mine = t.products[0].cases.find(c => c.id === co.id);
check('保留原處方', mine.prescription_id === emp.id, mine.code);
check('其他欄位有更新', mine.cups === 2 && mine.meal_time === '1200', `${mine.cups}杯 ${mine.meal_time}`);

console.log('\n━━ 清理 ━━');
await api('/api/today/cases/' + co.id, 'DELETE');
t = await api('/api/today');
check('測試出單已刪除', !t.products[0].cases.some(c => c.id === co.id));

console.log(`\n${'─'.repeat(40)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
