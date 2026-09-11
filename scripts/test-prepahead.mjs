import { ensureMealDay, ensureAttendance } from './_setup.mjs';
// 提前備料：料哪天離開冰箱，庫存就哪天掉
//
//   現場的做法是週一為週二的員工餐做大量備料。料週一就離開冰箱，
//   但系統原本只在出餐日扣 —— 週一晚上帳面上還有那些料，實際上已經在盒子裡。
//   缺料因此少報一天，採購因此晚一天。
//
//   最要緊的是不能扣兩次。隔日自動補扣（settleDay）比對的是
//   「那天應該扣的」vs「那天實際扣掉的」，所以提前備料那一列的 date
//   必須記成出餐日 —— 這樣補扣自然看到已經扣過，差額是 0。
//   如果改成記備料日，出餐日就會再被補扣一次，而且要到盤點才發現。
const B = 'http://localhost:3999';
const H = { 'X-Kitchen-User-Id': '1', 'Content-Type': 'application/json' };
const api = async (p, m = 'GET', b = null) => {
  const r = await fetch(B + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${m} ${p} → ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};
const tryApi = async (p, m, b) => {
  const r = await fetch(B + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (e) {}
  return { ok: r.ok, status: r.status, json: j };
};

let pass = 0, fail = 0;
const line = s => console.log(s);
const check = (n, c, d = '') => { c ? (pass++, line(`  ✓ ${n}${d ? '  ' + d : ''}`))
                                   : (fail++, line(`  ✗ ${n}${d ? '  ' + d : ''}`)); };

const DOW = ['日', '一', '二', '三', '四', '五', '六'];
const addDays = (d, n) =>
  new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const dowOf = d => new Date(d + 'T00:00:00').getDay();
const today = new Date().toISOString().slice(0, 10);

const stockMap = async () => {
  const inv = await api('/api/inventory');
  const rows = Array.isArray(inv) ? inv : (inv.items || inv.ingredients || []);
  return Object.fromEntries(rows.map(r => [r.id, r.qty]));
};

// 找一個明天之後、有杯數的出餐日。找不到就整組沒有意義
const restoreDow = await ensureMealDay(api, today);
const restoreAtt = await ensureAttendance(api, today);

let SERVE = null, lines = null;
for (let i = 1; i <= 10; i++) {
  const d = addDays(today, i);
  const r = await api('/api/prep-ahead?serve_date=' + d);
  const usable = r.lines.filter(l => l.left_cups > 0);
  if (!r.is_closed && usable.length) { SERVE = d; lines = usable; break; }
}
check('前置：找到一個還沒備料的出餐日', !!SERVE,
      SERVE ? `${SERVE} 週${DOW[dowOf(SERVE)]}　${lines.length} 張配方待備`
            : '★ 未來十天都沒有要備的，這組測不出東西');
if (!SERVE) {
  await restoreDow(); await restoreAtt();
  line(`\n通過 ${pass} 項，失敗 ${fail} 項`); process.exit(1);
}

const target = lines[0];
const madeIds = [];
const cleanup = async () => {
  const c = await api('/api/consumption?date=' + SERVE);
  for (const row of (c.rows || [])) {
    if (row.source === 'prep' || madeIds.includes(row.id))
      await api('/api/consumption/' + row.id + '/reverse', 'POST', {}).catch(() => {});
  }
};
await cleanup();

line('\n━━ 1. 登記備料，庫存當下就要掉 ━━');
{
  const before = await stockMap();
  const r = await api('/api/prep-ahead', 'POST', {
    serve_date: SERVE, prep_date: today,
    lines: [{ prescription_id: target.prescription_id, cups: target.left_cups,
              powder_type: target.powder_type }]
  });
  r.saved.forEach(x => madeIds.push(x.id));
  check('登記成功', r.saved.length === 1,
        `${target.rx_code} ${target.left_cups} 杯　備料日 ${r.prep_date} → 出餐日 ${r.serve_date}`);

  const after = await stockMap();
  const moved = Object.keys(after).filter(k => Math.abs(after[k] - before[k]) > 0.05);
  check('庫存在按下去的當下就掉了', moved.length > 0,
        `${moved.length} 樣食材的量變了　—— 料離開冰箱了，帳就該跟著動`);
  check('庫存是減不是加',
        moved.every(k => after[k] <= before[k] + 0.05), '全部都是減');
}

line('\n━━ 2. 出餐日不能再扣第二次 ━━');
// 這是整支測試的重點。自動補扣比對的是「應該扣的」vs「實際扣掉的」，
// 提前備料那一列記的 date 是出餐日，所以補扣看得到它
{
  const st = await api('/api/prep-ahead?serve_date=' + SERVE);
  const row = st.lines.find(l => l.prescription_id === target.prescription_id);
  check('那張配方已經備滿', row && row.left_cups === 0,
        row ? `要 ${row.need_cups} 杯、已扣 ${row.already_cups} 杯、還要備 ${row.left_cups} 杯` : '');

  const before = await stockMap();
  // 再登記同樣的杯數 → 超過那天的需求，應該被擋
  const again = await tryApi('/api/prep-ahead', 'POST', {
    serve_date: SERVE, prep_date: today,
    lines: [{ prescription_id: target.prescription_id, cups: target.left_cups }]
  });
  check('重複備料被擋住', !again.ok && again.status === 409, `HTTP ${again.status}`);
  check('訊息講得出那天只要幾杯',
        !!(again.json && /最多還能備/.test(again.json.error || '')),
        again.json ? String(again.json.error).slice(0, 100) : '');
  const after = await stockMap();
  const moved = Object.keys(after).filter(k => Math.abs(after[k] - before[k]) > 0.05);
  check('擋下來就不能動到庫存', moved.length === 0,
        moved.length ? '★ 有 ' + moved.length + ' 樣被動了' : '一樣都沒動');
}

line('\n━━ 2.5 隔日自動補扣不會再扣一次 ━━');
// settleDay 的算法是「那天應該扣的」減「那天實際扣掉的」，只補差額。
// 提前備料那一列記的 date 是出餐日，所以差額必須是 0 ——
// 這一條直接驗那個差額，不必等到隔天才知道有沒有扣兩次。
//
// 如果哪天有人把 date 改成記備料日（直覺上很合理，畢竟料是那天離開冰箱的），
// 出餐日就會被補扣一整批，而且要到盤點才看得出來。這條斷言就是為了擋那個改動。
{
  const exp = await api('/api/consumption/expected?date=' + SERVE);
  const got = await api('/api/consumption?date=' + SERVE);
  const diff = Math.round((exp.total_cups - got.total_cups) * 100) / 100;
  check('應該扣的 = 已經扣的', Math.abs(diff) < 0.05,
        `應扣 ${exp.total_cups} 杯／已扣 ${got.total_cups} 杯　差 ${diff}`
        + (Math.abs(diff) < 0.05 ? '　—— 補扣會補 0 杯' : ' ★ 隔天會被補扣這麼多，等於扣兩次'));
}

line('\n━━ 3. 備料日記得住，查得到是哪天備的 ━━');
{
  const st = await api('/api/prep-ahead?serve_date=' + SERVE);
  const p = st.prepped.find(x => x.prescription_id === target.prescription_id);
  check('查得到這批是哪天備的', !!p && p.prep_date === today,
        p ? `${p.rx_code} ${p.cups} 杯　備於 ${p.prep_date}` : '★ 查不到');
  const c = await api('/api/consumption?date=' + SERVE);
  const prepRows = (c.rows || []).filter(r => r.source === 'prep');
  check('消耗紀錄記在出餐日上', prepRows.length > 0,
        `${SERVE} 有 ${prepRows.length} 筆 source=prep　—— 記在出餐日，自動補扣才看得到`);
}

line('\n━━ 4. 日期關係要擋住 ━━');
{
  const back = await tryApi('/api/prep-ahead', 'POST', {
    serve_date: today, prep_date: addDays(today, 3),
    lines: [{ prescription_id: target.prescription_id, cups: 1 }]
  });
  check('出餐日早於備料日，擋住', !back.ok && back.status === 400, `HTTP ${back.status}`);

  // 休診日不出餐，備了也沒用
  await api('/api/closures', 'POST', { date: addDays(today, 8), reason: '備料測試' });
  const closed = await tryApi('/api/prep-ahead', 'POST', {
    serve_date: addDays(today, 8), prep_date: today,
    lines: [{ prescription_id: target.prescription_id, cups: 1 }]
  });
  check('休診日不能備料', !closed.ok && closed.status === 400,
        closed.json ? String(closed.json.error).slice(0, 60) : '');
  await api('/api/closures/' + addDays(today, 8), 'DELETE');
}

line('\n━━ 5. 收尾 ━━');
await cleanup();
await restoreDow();
await restoreAtt();
{
  const st = await api('/api/prep-ahead?serve_date=' + SERVE);
  check('測試登記的備料已還原', st.prepped.length === 0,
        st.prepped.map(p => p.rx_code + ' ' + p.cups).join('、') || '沒有殘留');
  const cl = (await api('/api/closures')).closures.filter(c => c.reason === '備料測試');
  check('測試標的休診日已清掉', cl.length === 0, cl.map(c => c.date).join('、') || '沒有殘留');
}

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
