// 蔬果方案輪替的回歸測試
//
//   輪替在「蔬果方案」這一層，不在處方那一層 —— 方案一／二只差在蔬果，
//   機能配料是每個人自己的，所以員工只需要一張處方。
//
//   這一組把兩個方案的每一個用量都釘死。配方是廚房每天照著做的東西，
//   改錯一個數字不會有人立刻發現，只驗「有幾樣」擋不住。
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

// 日期加減一律在 UTC 上做。用本地時間加天數再 toISOString() 會被時區平移，
// 台灣是 +8，算出來會少一天，看起來就像輪替算錯
const plus = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const at   = d => api('/api/rotation/plan?date=' + d);

const base   = await at('2026-08-31');
const anchor = base.anchor;
const weeks  = base.weeks;
const cycle  = 7 * weeks;

line('\n━━ 1. 輪替真的會換手 ━━');
const a0 = await at(anchor);
const a1 = await at(plus(anchor, cycle));
const a2 = await at(plus(anchor, cycle * 2));
check('起算日當期用方案一', a0.plan && a0.plan.code === 'PLAN-A', a0.plan && a0.plan.name);
check(`${weeks} 週後換方案二`, a1.plan && a1.plan.code === 'PLAN-B', a1.plan && a1.plan.name);
check(`${weeks * 2} 週後轉回方案一`, a2.plan && a2.plan.code === 'PLAN-A', a2.plan && a2.plan.name);
const mid = await at(plus(anchor, cycle - 1));
check('同一期內不會中途換手', mid.plan.code === a0.plan.code, `第 ${cycle} 天仍是 ${mid.plan.name}`);

line('\n━━ 2. 起算日之前也要算得出來 ━━');
const back = await at(plus(anchor, -cycle));
check('起算日前不會算出範圍外的方案',
      back.plan && ['PLAN-A', 'PLAN-B'].includes(back.plan.code), back.plan && back.plan.name);

line('\n━━ 3. 兩個方案的內容 ━━');
const SET_A = { '羽衣甘藍': 20, '貝比生菜': 20, '胡蘿蔔': 15, '甜菜根': 15, '西洋芹': 15,
  '大黃瓜': 20, '冷凍菠菜': 15, '冷凍花椰菜': 15, '蘋果': 40, '檸檬': 10, '奇異果': 20,
  '鳳梨': 15, '香蕉': 15, '芭樂': 15, '藍莓': 15 };
const SET_B = { '羽衣甘藍': 20, '貝比生菜': 20, '櫻桃蘿蔔': 15, '牛番茄': 20, '紫高麗菜': 15,
  '櫛瓜': 15, '青江菜': 15, '萵苣': 15, '蘋果': 40, '檸檬': 10, '綜合莓': 20, '木瓜': 15,
  '酪梨': 15, '甜橙': 15, '葡萄': 15 };

for (const [code, want, label] of [['PLAN-A', SET_A, '方案一'], ['PLAN-B', SET_B, '方案二']]) {
  const date = code === 'PLAN-A' ? anchor : plus(anchor, cycle);
  const res  = await at(date);
  const got  = Object.fromEntries(res.items.map(i => [i.name, i.qty_per_cup]));
  const missing = Object.keys(want).filter(n => got[n] === undefined);
  const wrong   = Object.keys(want).filter(n => got[n] !== undefined && got[n] !== want[n])
                    .map(n => `${n} 應 ${want[n]} 實 ${got[n]}`);
  const extra   = Object.keys(got).filter(n => want[n] === undefined);
  check(`${label}用料齊全`, missing.length === 0, missing.join('、') || `${Object.keys(got).length} 樣`);
  check(`${label}每一樣的用量都對`, wrong.length === 0, wrong.join('；') || '全部相符');
  check(`${label}沒有多出來的用料`, extra.length === 0, extra.join('、') || '無');
  check(`${label}只有蔬菜與水果`,
        res.items.every(i => ['蔬菜', '水果'].includes(i.category)),
        '機能配料屬於個人，不該進方案');
}

line('\n━━ 4. 換掉的兩樣沒有殘留 ━━');
const allNames = [...(await at(anchor)).items, ...(await at(plus(anchor, cycle))).items].map(i => i.name);
check('甜椒與蘿蔓生菜已從方案移除',
      !allNames.includes('甜椒') && !allNames.includes('蘿蔓生菜'), '已清乾淨');

line('\n━━ 5. 冷凍包標記還在 ━━');
const packA = (await at(anchor)).items.filter(i => i.prep_stage === '冷凍包');
check('方案一分得出冷凍包用料', packA.length > 0, packA.map(i => i.name).join('、'));

line('\n━━ 6. 退役的舊處方 ━━');
const rxs = await api('/api/prescriptions?include_inactive=1');
const by  = Object.fromEntries(rxs.map(r => [r.code, r]));
check('EMP-00 保留但退役 —— 歷史出單還查得到',
      by['EMP-00'] && by['EMP-00'].active === 0 && by['EMP-00'].is_staff_rx === 0);
check('RX-07（EMP-00 的重複）已停用', by['RX-07'] && by['RX-07'].active === 0);
check('EMP-02 已退役 —— 輪替移到方案層，員工只需要一張處方',
      by['EMP-02'] && by['EMP-02'].active === 0);
const activeStaff = rxs.filter(r => r.active === 1 && r.is_staff_rx === 1);
check('只剩一張啟用中的員工處方', activeStaff.length === 1,
      activeStaff.map(r => r.code).join('、'));

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
