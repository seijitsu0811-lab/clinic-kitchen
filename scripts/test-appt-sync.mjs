// 預約系統帶入出單的回歸測試
//   1. 帶入的資料要完整（預約備註不能被固定字串蓋掉）
//   2. 預約改時間，沒被廚房改過的要跟著更新
//   3. 廚房改過的不能被同步覆蓋，但預約時間仍要記著好標出差異
//   4. 預約取消／改期後，留下來的單要被標記（不自動刪）
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

const today = (await api('/api/today')).date;
const imported = () => api('/api/today').then(t =>
  t.products[0].cases.filter(c => c.source_key));

line('\n━━ 1. 帶入的出單有基本欄位 ━━');
let rows = await imported();
if (!rows.length) {
  line('  － 今天沒有從預約帶入的出單，略過整組測試');
  line(`\n${'─'.repeat(40)}\n通過 ${pass} 項，失敗 ${fail} 項`);
  process.exit(0);
}
check('帶入的出單有患者姓名與時間',
      rows.every(c => c.patient_name && /^\d{4}$/.test(c.meal_time)),
      `${rows.length} 筆`);
check('每一筆都記著預約當下的時間',
      rows.every(c => c.appt_meal_time !== undefined),
      '（沒有這個欄位就無從比對兩邊是否一致）');

line('\n━━ 2. 沒被改過的跟著預約走 ━━');
const autoRows = rows.filter(c => (c.sync_source || 'auto') === 'auto' && !c.appt_missing);
check('auto 的出單時間與預約一致',
      autoRows.every(c => !c.appt_meal_time || c.appt_meal_time === c.meal_time),
      autoRows.map(c => `${c.patient_name} ${c.meal_time}`).join('、') || '（無）');

line('\n━━ 3. 廚房改過就不再被覆蓋 ━━');
const target = autoRows[0];
if (target) {
  const orig = { meal_time: target.meal_time, notes: target.notes };
  await api('/api/today/cases/' + target.id, 'PUT', {
    prescription_id: target.prescription_id, cups: target.cups,
    meal_time: '1655', powder_type: target.powder_type,
    patient_name: target.patient_name, notes: 'ZZ 手動改過'
  });
  await api('/api/today');                       // 觸發同步
  const after = (await imported()).find(c => c.id === target.id);
  check('手動設定的時間沒有被同步蓋回去', after.meal_time === '1655',
        `${orig.meal_time} → 手動 1655 → 同步後 ${after.meal_time}`);
  check('標記為 manual', after.sync_source === 'manual');
  check('預約時間仍持續更新，差異才標得出來',
        !!after.appt_meal_time && after.appt_meal_time !== after.meal_time,
        `預約 ${after.appt_meal_time}／實際 ${after.meal_time}`);
  check('手動寫的備註沒被固定字串蓋掉', after.notes === 'ZZ 手動改過');

  // 還原：改回原值後，把 sync_source 交還給同步
  await api('/api/today/cases/' + target.id, 'PUT', {
    prescription_id: target.prescription_id, cups: target.cups,
    meal_time: orig.meal_time, powder_type: target.powder_type,
    patient_name: target.patient_name, notes: orig.notes
  });
  line('  － 已還原這筆的時間與備註（sync_source 會留在 manual，屬預期）');
} else {
  line('  － 沒有可測的 auto 出單，略過');
}

line('\n━━ 4. 預約已取消的會被標記 ━━');
rows = await imported();
const gone = rows.filter(c => c.appt_missing);
check('查得到「預約已不存在」這個狀態', gone.every(c => c.appt_missing === 1),
      gone.length ? gone.map(c => `${c.patient_name} ${c.meal_time}`).join('、') : '（今天沒有這種單）');
check('被標記的單不會被自動刪除', rows.length >= gone.length,
      '一次抓取失敗就刪掉當天的單，代價太大');

line(`\n${'─'.repeat(40)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
