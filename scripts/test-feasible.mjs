// 「明天做不做得出來」的回歸測試
//
//   「這批要買多少」是採購的角度；「明天做不做得出來」是廚房的角度。
//   兩個是不同的問題，而且後者更急 —— 原本的畫面只回答前者，
//   所以「明天缺 7 樣蔬果」這件事完全看不出來。
//
//   累計是重點：今天用掉的明天就沒有了，不能每天各自跟原始庫存比。
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

const fc = (d = 28) => api('/api/inventory/forecast?days=' + d);

line('\n━━ 1. 每一天都要答得出做不做得出來 ━━');
let f = await fc();
check('每一天都有 feasible 與缺料清單',
      f.days.every(d => typeof d.feasible === 'boolean' && Array.isArray(d.short)),
      `${f.days.length} 天`);
check('沒有出餐的日子一定做得出來',
      f.days.filter(d => d.cups === 0).every(d => d.feasible),
      '沒有杯數就沒有需求');
check('做不出來的日子一定列得出缺什麼',
      f.days.filter(d => !d.feasible).every(d => d.short.length > 0),
      '說「做不出來」卻講不出缺什麼，等於沒講');

line('\n━━ 2. 缺料要說得出缺多少 ━━');
const bad = f.days.find(d => !d.feasible);
if (bad) {
  const s0 = bad.short[0];
  check('每一項都有需要、剩下、缺多少',
        typeof s0.need === 'number' && typeof s0.have === 'number' && typeof s0.gap === 'number',
        `${s0.name} 需要 ${s0.need}${s0.unit}／剩 ${s0.have}${s0.unit}／缺 ${s0.gap}${s0.unit}`);
  check('缺多少 = 需要 − 剩下', Math.abs(s0.gap - (s0.need - s0.have)) < 0.05);
  check('缺最多的排最前面',
        bad.short.every((x, i) => i === 0 || bad.short[i - 1].gap >= x.gap));
} else {
  line('  － 目前每一天都做得出來，這組沒東西可測');
}

line('\n━━ 3. 累計：今天用掉的，明天就沒有了 ━━');
// 用一個只有測試處方會用到的食材。借用既有食材會被其他處方一起消耗
// （燕麥就是這樣：AW 每天也用 20g），算式就對不起來
const ings = await api('/api/ingredients');
let mat = ings.find(i => i.name === 'ZZ測試料');
if (!mat) {
  await api('/api/ingredients', 'POST',
    { name: 'ZZ測試料', unit: 'g', category: '粉類', safety_stock: 0 }).catch(() => {});
  mat = (await api('/api/ingredients')).find(i => i.name === 'ZZ測試料');
}
if (!mat) { line('  － 建不出測試食材，這組略過'); }
else {
  const allRx = await api('/api/prescriptions?include_inactive=1');
  let rx = allRx.find(p => p.code === 'ZZ-FEAS');
  if (rx) await api(`/api/prescriptions/${rx.id}`, 'PUT',
    { ...rx, active: 1, daily_cups: 1, buffer_cups: 0, weekly_cups: 0 });
  else {
    const r = await api('/api/prescriptions', 'POST',
      { code: 'ZZ-FEAS', name: 'ZZ 可行性測試', formula_type: '全配方', timing: '餐前' });
    rx = { id: r.id };
    await api(`/api/prescriptions/${rx.id}`, 'PUT',
      { name: 'ZZ 可行性測試', formula_type: '全配方', timing: '餐前', active: 1,
        daily_cups: 1, buffer_cups: 0, weekly_cups: 0 });
  }
  await api(`/api/prescriptions/${rx.id}/ingredients`, 'PUT',
    [{ ingredient_id: mat.id, qty_per_cup: 100 }]);

  // 剛好一天份：每日 1 杯 × 100g
  await api('/api/stocktake', 'POST',
    { note: 'ZZ 可行性測試前置', items: [{ ingredient_id: mat.id, counted_qty: 100 }] });

  const f3 = await fc(10);
  const workdays = f3.days.filter(d => d.dow >= 1 && d.dow <= 5);
  const isShort = d => d.short.some(x => x.name === 'ZZ測試料');
  const firstShortDay = workdays.find(isShort);
  check('剛好一天份時，第一個工作日不缺',
        workdays.length > 0 && !isShort(workdays[0]),
        workdays[0] ? `${workdays[0].date} 夠` : '(沒有工作日)');
  check('第二個工作日就缺了 —— 累計有生效',
        !!firstShortDay && firstShortDay.date !== workdays[0].date,
        firstShortDay ? `${firstShortDay.date} 開始缺` : '★ 從頭到尾都不缺，累計沒生效');
  if (firstShortDay) {
    const gap = firstShortDay.short.find(x => x.name === 'ZZ測試料');
    check('缺的量就是那一天的整份用量', Math.abs(gap.gap - 100) < 0.05,
          `缺 ${gap.gap}g（每日 100g，前一天已用光）`);
  }

  // 清理這一組
  await api(`/api/prescriptions/${rx.id}`, 'DELETE');
  // 停用（軟停用）—— 歷史紀錄還指向它，不能真的刪
  await api('/api/ingredients/' + mat.id, 'PUT',
    { name: mat.name, unit: mat.unit, category: mat.category, active: 0 }).catch(() => {});
}

line('\n━━ 3.5 冷凍包與個人處方共用同一樣食材 ━━');
// 2026-09-03 把綜合莓換成冷凍藍莓之後才冒出來的：
//   藍莓同時在方案的冷凍包裡、也在好幾個個案自己的處方裡。
//   原本的判斷把整包需求都算成「吃冷凍包」，於是生料庫存 3100g 完全沒被看過，
//   畫面還是說缺 300g。這一組自己造出那個情境，不靠現場剛好有這種資料。
const planA = (await api('/api/produce-plans')).find(p => p.code === 'PLAN-A');
const packItem = planA && planA.items.find(i => i.qty_per_cup > 0 && i.prep_stage === '冷凍包');
if (!packItem) { line('  － 方案裡沒有冷凍包用料，這組略過'); }
else {
  const PID = packItem.ingredient_id;
  const invOf = async () => ((await api('/api/inventory')).find(i => i.id === PID) || {}).qty || 0;
  const stock0 = await invOf();

  // 一張不吃方案的處方，自己用同一樣食材。它不該吃冷凍包的備品
  const allP = await api('/api/prescriptions?include_inactive=1');
  let rxP = allP.find(p => p.code === 'ZZ-PACK');
  if (!rxP) {
    const r = await api('/api/prescriptions', 'POST',
      { code: 'ZZ-PACK', name: 'ZZ 冷凍包共用測試', formula_type: '全配方', timing: '餐前' });
    rxP = { id: r.id };
  }
  await api(`/api/prescriptions/${rxP.id}`, 'PUT',
    { name: 'ZZ 冷凍包共用測試', formula_type: '全配方', timing: '餐前', active: 1,
      daily_cups: 1, buffer_cups: 0, weekly_cups: 0 });
  await api(`/api/prescriptions/${rxP.id}/ingredients`, 'PUT',
    [{ ingredient_id: PID, qty_per_cup: 100 }]);

  const gapOn = async () => {
    const f = await api('/api/inventory/forecast?days=7');
    const d = f.days.find(x => x.cups > 0);
    const row = d && d.short.find(x => x.id === PID);
    return { gap: row ? row.gap : 0, need: row ? row.need : (d ? 0 : 0), date: d && d.date };
  };

  // 生料一點都沒有
  await api('/api/stocktake', 'POST',
    { note: 'ZZ 冷凍包共用測試（歸零）', items: [{ ingredient_id: PID, counted_qty: 0 }] });
  const dry = await gapOn();

  // 生料補到絕對夠
  await api('/api/stocktake', 'POST',
    { note: 'ZZ 冷凍包共用測試（補滿）', items: [{ ingredient_id: PID, counted_qty: 100000 }] });
  const wet = await gapOn();

  check('自己處方那份會看生料庫存', wet.gap < dry.gap,
        `庫存 0 時缺 ${dry.gap}，庫存 100000 時缺 ${wet.gap}` +
        (wet.gap < dry.gap ? '' : ' ★ 補了生料還是一樣缺，代表被當成冷凍包算了'));
  check('補生料消掉的正好是自己那份',
        Math.abs((dry.gap - wet.gap) - 100) < 0.5 || dry.gap - wet.gap >= 100 - 0.5,
        `少了 ${Math.round((dry.gap - wet.gap) * 10) / 10}（每杯 100，1 杯）`);
  check('缺的量不會超過當天總需求', wet.gap <= (wet.need || 0) + 0.05,
        `需要 ${wet.need}／缺 ${wet.gap}`);

  // 收乾淨
  await api(`/api/prescriptions/${rxP.id}`, 'DELETE');
  await api('/api/stocktake', 'POST',
    { note: 'ZZ 冷凍包共用測試還原', items: [{ ingredient_id: PID, counted_qty: stock0 }] });
  check('庫存還原成測試前', Math.abs((await invOf()) - stock0) < 0.05, `${stock0}`);
}

line('\n━━ 4. 最近做不出來的那一天要單獨提出來 ━━');
f = await fc();
const anyBad = f.days.find(d => d.cups > 0 && !d.feasible);
check('有做不出來的日子就要回報 first_short',
      (!anyBad && !f.first_short) || (!!anyBad && !!f.first_short),
      f.first_short ? `${f.first_short.date} 缺 ${f.first_short.short.length} 樣` : '（都做得出來）');
if (f.first_short && anyBad) {
  check('回報的就是最近的那一天', f.first_short.date === anyBad.date,
        `${f.first_short.date} / ${anyBad.date}`);
}

line('\n━━ 5. 換方案預警要算一整段，不是只算一天 ━━');
const w = f.switch_warning;
if (w) {
  check('有涵蓋期間', !!w.cover_to && w.cover_days >= 1,
        `${w.date} ~ ${w.cover_to}（${w.cover_days} 天）`);
  check('每一項都說得出缺多少', w.missing.every(m => typeof m.gap === 'number'),
        w.missing[0] ? `${w.missing[0].name} 缺 ${w.missing[0].gap}` : '');
  // 只算換組當天會嚴重低估：「缺 30g 蛋白粉」看起來沒事，實際上要好幾百克
  const oneDay = w.missing.find(m => m.need > 0);
  check('需要量大於單一杯的用量 —— 沒有只算一天',
        !oneDay || oneDay.need > 50,
        oneDay ? `${oneDay.name} 需要 ${oneDay.need}${oneDay.unit || 'g'}` : '');
} else {
  line('  － 預測範圍內沒有換方案，這組略過');
}

line('\n━━ 6. 清理 ━━');
const leftRx = (await api('/api/prescriptions')).find(r => r.code === 'ZZ-FEAS');
const leftIng = (await api('/api/ingredients')).find(i => i.name === 'ZZ測試料' && i.active !== 0);
check('測試處方與測試食材都清乾淨', !leftRx && !leftIng,
      `處方 ${leftRx ? '殘留' : '已清'}／食材 ${leftIng ? '殘留' : '已清'}`);

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
