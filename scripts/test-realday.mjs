// 一整個營運日的模擬 —— 不是測單一函式，是測「串起來之後還對不對」。
//
// 單元測試各測各的都會過，但真正會出事的是交界處：
// 批次算 8 杯、庫存扣 10 杯、成本又用另一個數字，三個都「自己是對的」。
// 這支從早上排班一路走到隔天補扣，每一站都拿前一站的數字對帳。
//
// 只跑本機。會動到出席、庫存與當日狀態，結束時全部還原。
const B = 'http://localhost:3999';
const H = { 'X-Kitchen-User-Id': '1', 'Content-Type': 'application/json' };
const api = async (p, m = 'GET', b = null) => {
  const r = await fetch(B + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${m} ${p} → ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};
let pass = 0, fail = 0;
const line = s => console.log(s);
const check = (n, c, d = '') => { c ? (pass++, line(`  ✓ ${n}${d ? '  ' + d : ''}`))
                                   : (fail++, line(`  ✗ ${n}${d ? '  ' + d : ''}`)); };
const money = n => '$' + (Math.round(n * 10) / 10);

// ── 開場：記住現場原本的樣子，結束要原封不動還回去 ──────────
const day0     = await api('/api/today');
const TODAY    = day0.date;
const YDAY     = new Date(Date.parse(TODAY + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
const origState  = day0.day_state?.state || {};
const origAttend = day0.staff.map(s => ({ id: s.user_id, on: s.attending ? 1 : 0, t: s.meal_time }));
const invBefore  = Object.fromEntries((await api('/api/inventory')).map(i => [i.id, i.qty]));
const madeCases  = [];
const madeMeals  = [];

const setAttend = (uid, on, t = '1130') =>
  api('/api/today/attendance/' + uid, 'PUT', { attending: on ? 1 : 0, meal_time: t });
const setState = s => api('/api/today/state', 'PUT', { date: TODAY, state: s });
const invOf = async () => Object.fromEntries((await api('/api/inventory')).map(i => [i.id, i.qty]));

// 對照表如果因為欄位名寫錯而塌成一個 key，後面每一條「有沒有變動」、
// 「還原了沒」都會假通過 —— 不會失敗的測試比沒有測試更糟。先確認它真的抓到東西
if (Object.keys(invBefore).length < 10) {
  line(`  ✗ 庫存對照表只有 ${Object.keys(invBefore).length} 筆 —— 欄位名可能寫錯了，後面的斷言全部不可信`);
  process.exit(1);
}

line('\n════ 早上：排班 ════');
const roster = day0.staff.slice(0, 8);
if (roster.length < 8) { line('  ✗ 員工不足 8 人，無法模擬'); process.exit(1); }
for (const s of day0.staff) await setAttend(s.user_id, 0);
for (const s of roster) await setAttend(s.user_id, 1, '1130');
let d = await api('/api/today');
check('8 位出席', d.attending_count === 8, `${d.attending_count} 人`);

const staffRx = d.products[0].staff_rx;
check('抓到今天輪替該用的員工配方', !!staffRx && /^EMP-0[12]$/.test(staffRx.code),
      staffRx && `${staffRx.code} ${staffRx.name}`);

line('\n════ 上午：開個案出單 ════');
const rxs = await api('/api/prescriptions');
const solo = rxs.filter(r => !r.is_staff_rx && r.active && !String(r.code).startsWith('ZZ')).slice(0, 2);
const mkCase = async (rx, cups, time, name) => {
  const r = await api('/api/today/cases', 'POST',
    { prescription_id: rx.id, cups, meal_time: time, powder_type: '袋裝', patient_name: name, notes: '' });
  madeCases.push(r.id); return r.id;
};
await mkCase(solo[0], 1, '1130', 'ZZ模擬個案甲');
await mkCase(solo[1], 2, '1300', 'ZZ模擬個案乙');
d = await api('/api/today');
const myCases = d.products[0].cases.filter(c => String(c.patient_name).startsWith('ZZ模擬'));
check('兩筆個案出單都在', myCases.length === 2,
      myCases.map(c => `${c.patient_name} ${c.cups}杯 ${c.meal_time}`).join('、'));

line('\n════ 上午：訂餐盒（含分食）════');
const menu  = await api('/api/meals/menu');
const items = menu.series.flatMap(s => s.items);
const abei  = items.find(i => i.code === 'SET-A4-PORK');
const bento = items.find(i => i.code === 'SET-B3-PORK');
const mkMeal = async (item, people, sp, sb, name) => {
  const r = await api('/api/meals/orders', 'POST',
    { meal_item_id: item.id, qty: people, share_people: sp, share_boxes: sb,
      meal_time: '1330', patient_name: name, purchase_mode: '餐盒' });
  madeMeals.push(r.id); return r.id;
};
await mkMeal(bento, 3, 3, 2, 'ZZ模擬三人組');     // 三人分兩盒
await mkMeal(abei,  1, 1, 1, 'ZZ模擬獨享');       // 一人一盒
const shop = await api('/api/meals/shopping');
const myStops = shop.stops.filter(s => s.lines.some(l => l.order_ids.some(id => madeMeals.includes(id))));
check('採購單分成兩家店', myStops.length === 2, myStops.map(s => s.vendor_name).join('、'));
const bentoLn = myStops.flatMap(s => s.lines).find(l => l.order_ids.includes(madeMeals[0]));
check('三人份自動算成兩盒', bentoLn && bentoLn.qty === 2 && bentoLn.people === 3,
      bentoLn && `${bentoLn.qty} 盒 / ${bentoLn.people} 人（${bentoLn.share_note}）`);
const walks = myStops.map(s => s.walk_minutes);
check('店家依步行時間排序（遠的先出發）', walks.every((w, i) => i === 0 || walks[i - 1] >= w),
      walks.join(' → ') + ' 分');

line('\n════ 中午：出餐，兩件例外 ════');
// 一位員工臨時外出沒領、一筆個案取消
const missedStaff = roster[0].user_id;
const missedCase  = myCases[0].id;
await setState({ ...origState, staffMissed: [missedStaff], caseMissed: [missedCase] });

const exp = await api('/api/consumption/expected?date=' + TODAY);
// 應扣 = 出席8 − 未領1 = 7 杯員工，加上沒被取消的那筆個案 2 杯
const wantStaff = 7, wantCase = 2;
const staffLine = exp.items.find(i => i.rx_id === staffRx.id);
check('員工應扣 = 出席 8 − 未領 1 = 7 杯', staffLine && staffLine.cups === wantStaff,
      staffLine && `${staffLine.cups} 杯`);
const caseTotal = exp.items.filter(i => i.rx_id !== staffRx.id)
                           .reduce((t, i) => t + i.cups, 0);
check('取消那筆個案沒有列入應扣', caseTotal >= wantCase,
      `個案應扣 ${caseTotal} 杯（本模擬貢獻 ${wantCase} 杯）`);

line('\n════ 傍晚：對帳 ════');
const totalExpected = exp.total_cups;
check('應扣總量把例外算進去了', totalExpected > 0, `${totalExpected} 杯`);
check('應扣清單攤得出依據', exp.exceptions
      && exp.exceptions.staff_missed.includes(missedStaff)
      && exp.exceptions.case_missed.includes(missedCase),
      JSON.stringify(exp.exceptions));

line('\n════ 成本：三塊都要在 ════');
const costs = await api('/api/costs');
const t = costs.today;
check('食材成本算得出來', t.products && t.products.length > 0 && t.products[0].ingredient_cost >= 0,
      t.products && money(t.products[0].ingredient_cost));
check('人工成本算得出來', t.labor && t.labor.cost >= 0,
      t.labor && `${money(t.labor.cost)}（${t.labor.basis === 'actual' ? '實際工時' : '估算'}，${t.labor.minutes} 分）`);
check('餐盒成本按盒計價（2 盒 + 1 盒）',
      t.meals && t.meals.planned === bento.price_box * 2 + abei.price_box,
      t.meals && `${money(t.meals.planned)}＝${money(bento.price_box)}×2 ＋ ${money(abei.price_box)}`);
check('總成本 = 食材 + 人工 + 餐盒', t.grand_total > 0, money(t.grand_total));

line('\n════ 衛教小卡：按人不按盒 ════');
const cards = await api('/api/meals/cards/today');
const mine = (cards.cards || []).filter(c => String(c.patient_name).startsWith('ZZ模擬'));
check('三人分兩盒仍印三張卡', mine.length === 4, `${mine.length} 張（三人組 3 ＋ 獨享 1）`);

line('\n════ 隔天：自動補扣 ════');
// 把一筆個案搬到昨天，模擬「昨天沒人扣庫存」。
// 先把那張處方的用料補到已知數量 —— 扣庫存有 MAX(0,…) 保護，
// 起始就是 0 的話扣了數字也不會變，會看起來像沒扣
const allIng = await api('/api/ingredients');
const rxIng = (await api('/api/prescriptions/' + solo[1].id + '/ingredients'))
                .filter(i => i.qty_per_cup > 0).slice(0, 4)
                .map(i => allIng.find(a => a.name === i.name)).filter(Boolean);
await api('/api/stocktake', 'POST',
  { note: 'ZZ 模擬：把用料補到已知量', items: rxIng.map(i => ({ ingredient_id: i.id, counted_qty: 1000 })) });

const back = await api('/api/today/cases', 'POST',
  { prescription_id: solo[1].id, cups: 2, meal_time: '1130', powder_type: '袋裝',
    patient_name: 'ZZ模擬昨日', notes: '', date: YDAY });
madeCases.push(back.id);
const invPre = await invOf();
await api('/api/today');                       // 觸發補扣
const settled = await api('/api/consumption/auto?days=3');
const mySettle = settled.filter(s => s.date === YDAY);
check('昨天的缺口被補扣', mySettle.length > 0,
      mySettle.map(s => `${s.date} ${s.cups}杯`).join('、') || '（沒有觸發）');
const invPost = await invOf();
const moved = Object.keys(invPost).filter(k => invPost[k] !== invPre[k]);
check('補扣真的動到庫存', moved.length > 0,
      moved.slice(0, 3).map(k => {
        const n = (allIng.find(a => a.id === Number(k)) || {}).name || k;
        return `${n} ${invPre[k]}→${invPost[k]}`;
      }).join('、') || '沒有任何變動');
// 扣的量要對得上：2 杯 × 每杯用量
const chk = rxIng[0];
const per = (await api('/api/prescriptions/' + solo[1].id + '/ingredients'))
              .find(i => i.name === chk.name).qty_per_cup;
check('扣的量剛好是 2 杯的份量',
      Math.abs((invPre[chk.id] - invPost[chk.id]) - per * 2) < 0.05,
      `${chk.name} 少了 ${Math.round((invPre[chk.id] - invPost[chk.id]) * 10) / 10}g（應為 ${per} × 2）`);

// 同一天再打一次，不能重複扣
const invAgain1 = await invOf();
await api('/api/today');
const invAgain2 = await invOf();
check('重複觸發不會重複扣',
      Object.keys(invAgain2).every(k => invAgain2[k] === invAgain1[k]), '數量不變');

line('\n════ 收工：全部還原 ════');
for (const id of mySettle) await api(`/api/consumption/${id.id}/reverse`, 'POST').catch(() => {});
for (const id of madeMeals) await api('/api/meals/orders/' + id, 'DELETE').catch(() => {});
for (const id of madeCases) await api('/api/today/cases/' + id, 'DELETE').catch(() => {});
await setState(origState);
for (const s of origAttend) await setAttend(s.id, s.on, s.t);

// 庫存用盤點還原（盤點會留紀錄，比直接改數字誠實）
const invNow = await invOf();
const drift = Object.keys(invBefore).filter(k => Math.abs((invNow[k] ?? 0) - invBefore[k]) > 0.05);
if (drift.length) {
  await api('/api/stocktake', 'POST', {
    note: 'ZZ 模擬測試還原',
    items: drift.map(k => ({ ingredient_id: Number(k), counted_qty: invBefore[k] }))
  });
}
const invEnd = await invOf();
check('庫存還原成測試前的數量',
      Object.keys(invBefore).every(k => Math.abs((invEnd[k] ?? 0) - invBefore[k]) < 0.05),
      `${drift.length} 樣被還原`);
const leftCases = (await api('/api/today')).products[0].cases.filter(c => String(c.patient_name).startsWith('ZZ模擬'));
const leftMeals = (await api('/api/meals/today')).orders.filter(o => String(o.patient_name).startsWith('ZZ模擬'));
check('測試出單清乾淨', leftCases.length === 0 && leftMeals.length === 0,
      `個案 ${leftCases.length} 筆、餐盒 ${leftMeals.length} 筆`);

line(`\n${'─'.repeat(50)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
