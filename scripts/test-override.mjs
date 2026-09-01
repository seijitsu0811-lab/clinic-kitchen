// 方案手動切換的回歸測試
//
//   預設照日期自動輪替 —— 需要人定期去按的東西一定會失守（這個專案的
//   「拿取」就是這樣：資料顯示幾乎每一天都沒人做）。
//   但現實會偏離排程（食材沒到、想延一週），所以要改得動。
//   手動指定優先，過了那段期間自己回到自動。
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
const plus = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

// 先清掉殘留的覆寫，否則起點就不是「自動」
for (const o of (await api('/api/rotation/plans')).overrides || [])
  await api('/api/rotation/plan/override/' + o.id, 'DELETE').catch(() => {});

const s0 = await api('/api/rotation/plans');
const auto = s0.current;
const other = s0.plans.find(p => p.code !== auto.code);

line('\n━━ 1. 預設是自動 ━━');
check('沒有覆寫時走自動輪替', s0.is_override === false, `${auto.name}（自動）`);
check('兩個方案都選得到', s0.plans.length === 2, s0.plans.map(p => p.name).join('、'));

line('\n━━ 2. 手動切換 ━━');
const ov = await api('/api/rotation/plan/override', 'POST',
  { plan_id: other.id, note: 'ZZ 測試：食材沒到' });
check('切換成功', ov.plan === other.name, `${ov.date_from} 至 ${ov.date_to} 改用 ${ov.plan}`);
check('結束日抓在下次自然換組的前一天', !!ov.next_from
      && Date.parse(ov.next_from) === Date.parse(plus(ov.date_to, 1)),
      `${ov.date_from}~${ov.date_to}，${ov.next_from} 起回到輪替（${ov.next_plan}）`);
// 覆寫只換這一期、輪替時鐘不動，所以有可能連續兩期同一個方案。
// 行為是對的，但要講出來 —— 使用者不會自己發現
check('連續兩期同方案時會提醒', ov.next_plan !== ov.plan || !!ov.warning,
      ov.warning || '下一期是不同方案，不需要提醒');

const s1 = await api('/api/rotation/plans');
check('狀態標成手動', s1.is_override === true && s1.current.code === other.code,
      `${s1.current.name}（手動）`);

line('\n━━ 3. 切換要真的影響下游 ━━');
const f = await api('/api/inventory/forecast');
check('庫存預測跟著換', f.plan_today.code === other.code, f.plan_today.name);
const day = await api('/api/rotation/plan?date=' + ov.date_from);
check('查某一天也看得出是手動指定的', day.is_override === true,
      '沒有這個標記，沒人知道現在是被改過的');
// 跟「這一天原本會是什麼」比，不是跟覆寫結束後那天比 ——
// 那天可能剛好自然輪到同一個方案
const items = day.items.map(i => i.name).sort().join();
const wouldBe = (await api('/api/rotation/plan?date=' + plus(ov.date_from, -1))).items
  .map(i => i.name).sort().join();
check('覆寫期間的蔬果與原本不同', items !== wouldBe,
      `${day.plan.name} 的蔬果已經換掉原本那一組`);

line('\n━━ 4. 期間之外仍照自動走 ━━');
const before = await api('/api/rotation/plan?date=' + plus(ov.date_from, -1));
check('覆寫起始日之前不受影響', before.is_override !== true, before.plan.name);

line('\n━━ 5. 改回自動 ━━');
await api('/api/rotation/plan/override/' + ov.id, 'DELETE');
const s2 = await api('/api/rotation/plans');
check('取消後回到自動', s2.is_override === false && s2.current.code === auto.code,
      `${s2.current.name}（自動）`);
check('沒有殘留的覆寫', (s2.overrides || []).length === 0);

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
