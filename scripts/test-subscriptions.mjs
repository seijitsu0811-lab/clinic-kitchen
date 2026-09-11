// 同事訂閱：兩週一輪、週一三五取餐、一杯 150 元
//
//   規則（2026-09-11 跟 John 確認過的）：
//     • 一杯 150 元，收費 = 該輪取餐日數 × 150，休診日先扣掉
//     • 輪的邊界沿用蔬果方案的輪替基準，所以一個訂閱輪 = 一個方案期
//     • 訂了沒拿可以讓別人喝，不退費 —— 所以那杯一定會做、料一定會用掉
//     • 代領的人配方不同要跳警告，但不擋
//
//   最容易出事的地方是杯數。系統裡有兩條路各自在算：
//     cupsOnDate       → 決定做不做得出來、要買多少
//     expectedForDate  → 決定扣多少庫存
//   2026-09-03 那次這兩個數字是 20 和 16，差的 4 杯照做照扣，
//   但採購從頭到尾當它們不存在。所以這裡一定要斷言兩邊相等。
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
  return { ok: r.ok, status: r.status, body: await r.text() };
};

let pass = 0, fail = 0;
const line = s => console.log(s);
const check = (n, c, d = '') => { c ? (pass++, line(`  ✓ ${n}${d ? '  ' + d : ''}`))
                                   : (fail++, line(`  ✗ ${n}${d ? '  ' + d : ''}`)); };

const DOW = ['日', '一', '二', '三', '四', '五', '六'];
const addDays = (d, n) =>
  new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const dowOf = d => new Date(d + 'T00:00:00').getDay();
const cupsOf   = async d => (await api('/api/day/cups?date=' + d)).total_cups;
const expectOf = async d => (await api('/api/consumption/expected?date=' + d)).total_cups;

// ── 收拾上一次跑到一半留下的 ────────────────────────────
const users = await api('/api/users');
const rxs   = await api('/api/prescriptions');
const staffRx = rxs.find(r => r.is_staff_rx === 1 && r.active === 1);
const ownRx   = rxs.find(r => !r.is_staff_rx && r.active === 1 && !(r.daily_cups > 0));
const A = users[0], Bu = users[1];

const head = await api('/api/subscriptions');
// 用未來那一輪，不要動到今天的排產
const CYCLE = head.next_cycle;
const cleanup = async () => {
  const cur = await api('/api/subscriptions?cycle_start=' + CYCLE);
  for (const ss of cur.subscriptions) {
    for (const p of ss.pickups) {
      if (p.status !== 'pending')
        await api('/api/subscriptions/' + ss.id + '/pickup', 'PUT',
          { date: p.date, status: 'pending' }).catch(() => {});
    }
    await api('/api/subscriptions/' + ss.id, 'DELETE').catch(() => {});
  }
  for (const c of (await api('/api/closures')).closures) {
    if (c.reason === '訂閱測試') await api('/api/closures/' + c.date, 'DELETE').catch(() => {});
  }
};
await cleanup();

check('前置：抓得到人與配方', !!(A && Bu && staffRx && ownRx),
      `${A && A.name} / ${Bu && Bu.name} / ${staffRx && staffRx.code} / ${ownRx && ownRx.code}`);
check('前置：輪的起算日是週一', dowOf(CYCLE) === 1, `${CYCLE} 週${DOW[dowOf(CYCLE)]}`);

line('\n━━ 1. 一輪的杯數 = 取餐日數，收費照杯數 ━━');
let subA;
{
  const r = await api('/api/subscriptions', 'POST',
    { user_id: A.id, prescription_id: staffRx.id, cycle_start: CYCLE, powder_type: '內用' });
  subA = r.id;
  const expectDays = r.dates.length;
  check('取餐日全部落在週一三五',
        r.dates.every(d => [1, 3, 5].includes(dowOf(d))),
        r.dates.map(d => d.slice(5) + '(' + DOW[dowOf(d)] + ')').join(' '));
  check('兩週應該有 6 個取餐日', expectDays === 6, expectDays + ' 天');
  check('收費 = 杯數 × 150', r.charge === expectDays * 150,
        `${expectDays} × ${r.unit_price} = ${r.charge} 元`);
}

line('\n━━ 2. 休診日要把杯數扣掉，不是照收 ━━');
// John 給的例子：那一輪本來 6 杯，9/25 是國定假日，就變 5 杯、收 750
{
  const d6 = (await api('/api/subscriptions?cycle_start=' + CYCLE))
    .subscriptions.find(x => x.id === subA);
  const lastDay = d6.pickups[d6.pickups.length - 1].date;
  await api('/api/closures', 'POST', { date: lastDay, reason: '訂閱測試' });

  const r = await api('/api/subscriptions', 'POST',
    { user_id: Bu.id, prescription_id: ownRx.id, cycle_start: CYCLE });
  check('後訂的人杯數少一杯', r.entitled_cups === 5,
        `${lastDay} 標成休診 → ${r.entitled_cups} 杯`);
  check('收費跟著少 150', r.charge === 750, r.charge + ' 元');
  check('休診那天不在取餐日裡', !r.dates.includes(lastDay),
        r.dates.map(x => x.slice(5)).join(' '));

  const sum = await api('/api/subscriptions?cycle_start=' + CYCLE);
  check('畫面看得出為什麼少一杯',
        sum.closed_pickup_days.some(c => c.date === lastDay),
        sum.closed_pickup_days.map(c => c.date + ' ' + c.reason).join('、'));

  // 先訂的那一輪杯數要凍住 —— 已經收過錢的不能被事後補的假日改掉
  const after = sum.subscriptions.find(x => x.id === subA);
  check('先訂的那一輪杯數不受影響', after.entitled_cups === 6,
        `${after.entitled_cups} 杯、收 ${after.charge} 元　—— 已經收過錢的不能事後偷偷變`);

  await api('/api/closures/' + lastDay, 'DELETE');
}

line('\n━━ 3. 一輪訂閱在兩條路上要多出同樣的杯數 ━━');
// 不能直接比當天的總杯數：沒有人按出勤的日子，排產用「在編人數」估、
// 扣庫存用實際出勤，那是既有的合理落差。所以量的是「加一輪訂閱，
// 兩條路各自多了幾杯」——差值才是我加的東西該負責的部分。
{
  const sum0 = await api('/api/subscriptions?cycle_start=' + CYCLE);
  const day = sum0.subscriptions[0].pickups[0].date;
  const cups0 = await cupsOf(day), exp0 = await expectOf(day);

  const C = users[2] || users[0];
  const third = users[2]
    ? await api('/api/subscriptions', 'POST',
        { user_id: C.id, prescription_id: ownRx.id, cycle_start: CYCLE })
    : null;
  check('前置：造得出第三筆訂閱來量差值', !!third, third ? C.name : '★ 人數不足');

  const cups1 = await cupsOf(day), exp1 = await expectOf(day);
  const dPlan = cups1 - cups0, dStock = exp1 - exp0;
  check('排產多 1 杯', Math.abs(dPlan - 1) < 0.05, `${cups0} → ${cups1}`);
  check('扣庫存也多 1 杯', Math.abs(dStock - 1) < 0.05, `${exp0} → ${exp1}`);
  check('兩條路多出來的杯數一樣', Math.abs(dPlan - dStock) < 0.05,
        `排產 +${dPlan}／扣庫存 +${dStock}` +
        (Math.abs(dPlan - dStock) < 0.05 ? '' : ' ★ 有一邊漏算，帳會一路歪掉'));

  if (third) await api('/api/subscriptions/' + third.id, 'DELETE');
}

line('\n━━ 3.5 訂閱不靠員工供應日 ━━');
// 訂閱走週一三五、員工餐走週二四，兩條線互不相干。掛在 isStaffMealDay
// 底下的話，訂閱的日子一杯都不會做。這裡把那一天從員工供應日移掉再驗，
// 不靠「今天剛好不是供應日」——那樣一週有兩天等於沒有測試
{
  const sum = await api('/api/subscriptions?cycle_start=' + CYCLE);
  const day = sum.subscriptions[0].pickups[0].date;
  const t0 = await api('/api/today');
  const before = t0.staff_meal_dows.join(',');
  const without = t0.staff_meal_dows.filter(x => x !== dowOf(day));
  await api('/api/settings', 'PUT', { staff_meal_dows: without.join(',') || '2' });
  const cups = await cupsOf(day), exp = await expectOf(day);
  check('非員工供應日照樣做得出訂閱杯', cups > 0,
        `${day} 週${DOW[dowOf(day)]}（已從員工供應日移除）排產 ${cups} 杯`);
  check('扣庫存也算得到', exp > 0, exp + ' 杯');
  await api('/api/settings', 'PUT', { staff_meal_dows: before });
  check('員工供應日已還原',
        (await api('/api/today')).staff_meal_dows.join(',') === before, before);
}

line('\n━━ 4. 休診日連訂閱杯一起停 ━━');
{
  const sum = await api('/api/subscriptions?cycle_start=' + CYCLE);
  const day = sum.subscriptions[0].pickups[1].date;
  const before = await cupsOf(day);
  await api('/api/closures', 'POST', { date: day, reason: '訂閱測試' });
  const cups = await cupsOf(day), exp = await expectOf(day);
  check('那天排產變 0', cups === 0, `${before} → ${cups} 杯`);
  check('那天也不扣庫存', exp === 0, exp + ' 杯');
  await api('/api/closures/' + day, 'DELETE');
  check('拿掉休診就回來', (await cupsOf(day)) === before, `${await cupsOf(day)} / ${before}`);
}

line('\n━━ 5. 讓杯：權利是 A 的，喝的人是 B ━━');
{
  const sum = await api('/api/subscriptions?cycle_start=' + CYCLE);
  const ss = sum.subscriptions.find(x => x.id === subA);
  const d1 = ss.pickups[0].date, d2 = ss.pickups[1].date;

  await api('/api/subscriptions/' + subA + '/pickup', 'PUT', { date: d1, status: 'picked' });
  const r2 = await api('/api/subscriptions/' + subA + '/pickup', 'PUT',
    { date: d2, status: 'picked', picked_by_user_id: Bu.id });

  const after = (await api('/api/subscriptions?cycle_start=' + CYCLE))
    .subscriptions.find(x => x.id === subA);
  check('喝掉 2 杯', after.picked === 2, `picked ${after.picked}`);
  check('其中 1 杯是讓給別人的', after.shared_cups === 1,
        `shared ${after.shared_cups} 杯　—— 付錢的還是 ${A.name}`);
  check('查得到實際是誰喝的',
        after.pickups.find(p => p.date === d2).picked_by_name === Bu.name,
        `${d2} → ${after.pickups.find(p => p.date === d2).picked_by_name}`);
  check('剩下的杯數算得出來', after.remaining === after.entitled_cups - 2,
        `訂 ${after.entitled_cups}、喝 ${after.picked}、剩 ${after.remaining}`);
  line(`  － 代領警告：${r2.warning || '（這位沒有設定不吃的蛋白質，所以沒有警告）'}`);
}

line('\n━━ 6. 沒人喝的那杯要記下來 ━━');
// 不退費，但那杯已經做出來了，成本花掉了 —— 這個數字才是真的浪費
{
  const ss = (await api('/api/subscriptions?cycle_start=' + CYCLE))
    .subscriptions.find(x => x.id === subA);
  const d = ss.pickups[2].date;
  await api('/api/subscriptions/' + subA + '/pickup', 'PUT', { date: d, status: 'missed' });
  const after = (await api('/api/subscriptions?cycle_start=' + CYCLE))
    .subscriptions.find(x => x.id === subA);
  check('沒人喝的杯數記得住', after.missed === 1, `missed ${after.missed} 杯`);
  check('沒人喝也照樣扣庫存', (await expectOf(d)) > 0,
        `${d} 扣 ${await expectOf(d)} 杯　—— 料下鍋了，誰喝的不影響扣料`);
}

line('\n━━ 7. 有紀錄的輪不能刪掉 ━━');
{
  const r = await tryApi('/api/subscriptions/' + subA, 'DELETE');
  check('擋得住', !r.ok && r.status === 400, `HTTP ${r.status}`);
  const dup = await tryApi('/api/subscriptions', 'POST',
    { user_id: A.id, prescription_id: staffRx.id, cycle_start: CYCLE });
  check('同一人同一輪不能訂兩次', !dup.ok && dup.status === 400, `HTTP ${dup.status}`);
}

line('\n━━ 8. 收尾 ━━');
await cleanup();
{
  const sum = await api('/api/subscriptions?cycle_start=' + CYCLE);
  check('測試建的訂閱已清掉', sum.subscriptions.length === 0,
        sum.subscriptions.length + ' 筆殘留');
  const cl = (await api('/api/closures')).closures.filter(c => c.reason === '訂閱測試');
  check('測試標的休診日已清掉', cl.length === 0, cl.map(c => c.date).join('、') || '沒有殘留');
}

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
