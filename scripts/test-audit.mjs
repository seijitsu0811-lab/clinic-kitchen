// 操作紀錄的回歸測試
//
//   原本的設計是「前端呼叫 /api/log」，結果沒有人呼叫過，線上累積 0 筆 ——
//   表在、API 在、查詢頁在，就是沒有任何資料。靠每個新功能記得自己去記一筆，
//   注定會漏。現在改成伺服器每次改資料就自己記。
//
//   這一組最重要的斷言是「做了事之後筆數要增加」—— 少了它，紀錄再度失效
//   也不會有人發現，跟原本的狀況一模一樣。
const B = 'http://localhost:3999';
const H = { 'X-Kitchen-User-Id': '1', 'Content-Type': 'application/json' };
const raw = async (p, m = 'GET', b = null) =>
  fetch(B + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
const api = async (p, m = 'GET', b = null) => {
  const r = await raw(p, m, b);
  const t = await r.text();
  if (!r.ok) throw new Error(`${m} ${p} → ${r.status}: ${t.slice(0, 160)}`);
  return t ? JSON.parse(t) : null;
};
let pass = 0, fail = 0;
const line = s => console.log(s);
const check = (n, c, d = '') => { c ? (pass++, line(`  ✓ ${n}${d ? '  ' + d : ''}`))
                                   : (fail++, line(`  ✗ ${n}${d ? '  ' + d : ''}`)); };

const logs = (q) => api('/api/logs?limit=200' + (q ? '&q=' + encodeURIComponent(q) : ''));

line('\n━━ 1. 改資料就會留下紀錄 ━━');
const before = (await logs()).total;
const rxs = await api('/api/prescriptions');
const emp = rxs.find(r => r.code === 'EMP-01');
const c = await api('/api/today/cases', 'POST',
  { prescription_id: emp.id, cups: 2, meal_time: '1200', powder_type: '內用', patient_name: 'ZZ稽核測試' });
const after = (await logs()).total;
check('新增出單之後筆數增加', after > before, `${before} → ${after}`);

const recent = (await logs()).rows[0];
check('記得下是誰做的', !!recent.user_name, recent.user_name);
check('動作名稱看得懂，不是 REST 路徑', recent.action === '新增出單',
      recent.action);
check('內容有記下來', /cups/.test(recent.detail || ''), (recent.detail || '').slice(0, 60));

line('\n━━ 2. 修改與刪除也要記 ━━');
await api('/api/today/cases/' + c.id, 'PUT',
  { prescription_id: emp.id, cups: 3, meal_time: '1230', powder_type: '內用',
    patient_name: 'ZZ稽核測試', notes: '' });
check('修改有記到', (await logs()).rows[0].action === '修改出單');
await api('/api/today/cases/' + c.id, 'DELETE');
check('刪除有記到', (await logs()).rows[0].action === '刪除出單');

line('\n━━ 3. 該排除的要排除 ━━');
const t = await api('/api/today');
const n1 = (await logs()).total;
// 當日狀態每次勾選都會存（400ms 一次），記了會把紀錄淹掉
await api('/api/today/state', 'PUT', { date: t.date, state: t.day_state?.state || {} });
const n2 = (await logs()).total;
check('勾選狀態不進紀錄', n2 === n1, `${n1} → ${n2}（記了會被淹掉）`);

// 讀取不該留紀錄
await api('/api/prescriptions');
await api('/api/inventory');
check('純讀取不留紀錄', (await logs()).total === n2);

line('\n━━ 4. 失敗的請求不記 ━━');
const n3 = (await logs()).total;
const bad = await raw('/api/prescriptions/' + emp.id + '/duplicate', 'POST', { code: 'EMP-01' });
check('請求確實失敗了', bad.status === 400, `HTTP ${bad.status}`);
check('失敗的不留紀錄', (await logs()).total === n3,
      '什麼都沒改，記了只是雜訊');

line('\n━━ 5. 密碼不能進紀錄 ━━');
const n4 = (await logs()).total;
await raw('/api/users', 'POST', { name: 'ZZ稽核', password: 'super-secret-1234' }).catch(() => {});
const all = (await logs()).rows.map(r => r.detail || '').join(' ');
check('紀錄裡找不到密碼原文', !all.includes('super-secret-1234'),
      '密碼進了紀錄，等於換一個地方外洩');
const pwRow = (await logs()).rows.find(r => /password/.test(r.detail || ''));
check('密碼欄位被遮成 ***', !pwRow || /\*\*\*/.test(pwRow.detail),
      pwRow ? pwRow.detail.slice(0, 60) : '（這次沒有帶密碼的紀錄）');

line('\n━━ 6. 查詢 ━━');
const found = await logs('出單');
check('搜尋動作名稱找得到', found.rows.length > 0 && found.rows.every(r => /出單/.test(r.action)),
      `${found.rows.length} 筆`);
const none = await logs('ZZ絕對不存在的動作');
check('查無資料時回空清單，不是報錯', Array.isArray(none.rows) && none.rows.length === 0);

line('\n━━ 7. 清理 ━━');
const users = await api('/api/users').catch(() => []);
const zz = (Array.isArray(users) ? users : []).find(u => u.name === 'ZZ稽核');
if (zz) await api('/api/users/' + zz.id, 'DELETE').catch(() => {});
const left = (await api('/api/today')).products[0].cases.filter(x => String(x.patient_name).startsWith('ZZ稽核'));
check('測試出單已清掉', left.length === 0);

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
