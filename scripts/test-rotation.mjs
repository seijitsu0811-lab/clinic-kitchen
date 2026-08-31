// 雙週輪替配方的回歸測試
//   1. 同一組的兩張處方會依日期換手，沒有人需要每兩週去按一次
//   2. 起算日之前的日期也算得出組別（負數餘數不能落到範圍外）
//   3. 員工處方只有一個決定點，不會因為兩張同時啟用而變成不確定
//   4. 退役的舊處方不會再被當成員工處方
//   5. 冷凍包標記分得出「每週分裝」與「當天現秤」
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

line('\n━━ 1. 兩組配方都建起來了 ━━');
const rxs = await api('/api/prescriptions?include_inactive=1');
const byCode = Object.fromEntries(rxs.map(r => [r.code, r]));
check('員工兩組都在且啟用', !!byCode['EMP-01'] && !!byCode['EMP-02']
      && byCode['EMP-01'].active === 1 && byCode['EMP-02'].active === 1);
check('個案兩組都在且啟用', !!byCode['RX-08'] && !!byCode['RX-09']
      && byCode['RX-08'].active === 1 && byCode['RX-09'].active === 1);
check('員工與個案是不同處方，可以各自演進',
      byCode['EMP-01'].id !== byCode['RX-08'].id,
      `EMP-01 #${byCode['EMP-01'].id} / RX-08 #${byCode['RX-08'].id}`);

line('\n━━ 2. 舊的重複處方已退役 ━━');
check('RX-07（EMP-00 的重複）已停用', byCode['RX-07'] && byCode['RX-07'].active === 0);
check('EMP-00 保留但退役 —— 歷史出單還查得到',
      byCode['EMP-00'] && byCode['EMP-00'].active === 0 && byCode['EMP-00'].is_staff_rx === 0);

line('\n━━ 3. 輪替真的會換手 ━━');
const at = d => api('/api/rotation/active?group=EMP&date=' + d);
// 起算日直接問輪替端點，不另外假設一份
const anchor = (await at('2026-09-07')).anchor;
// 日期加減一律在 UTC 上做。用本地時間加天數再 toISOString() 會被時區平移，
// 台灣是 +8，算出來會少一天，看起來就像輪替算錯
const plus = (d, days) => new Date(Date.parse(d + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const a0 = await at(anchor);            // 第 0 個雙週
const a1 = await at(plus(anchor, 14));  // 第 1 個雙週
const a2 = await at(plus(anchor, 28));  // 第 2 個雙週 → 回到第 1 組
check('起算日當週用第 1 組', a0.code === 'EMP-01', a0.code);
check('兩週後換第 2 組',      a1.code === 'EMP-02', a1.code);
check('四週後轉回第 1 組',    a2.code === 'EMP-01', a2.code);
const a13 = await at(plus(anchor, 13));
check('同一個雙週內不會中途換手', a13.code === a0.code, `第14天仍是 ${a13.code}`);

line('\n━━ 4. 起算日之前也要算得出來 ━━');
const back = await at(plus(anchor, -14));
check('起算日前兩週不會算出範圍外的組別',
      back && ['EMP-01', 'EMP-02'].includes(back.code), back && back.code);

line('\n━━ 5. 今日頁抓到的是輪替決定的那一張 ━━');
const t = await api('/api/today');
const expected = (await at(t.date)).code;
const used = t.products[0].staff_rx && t.products[0].staff_rx.code;
check('今日頁的員工處方＝輪替算出來的那一張', used === expected, `用 ${used}／應為 ${expected}`);

line('\n━━ 6. 冷凍包分得出來 ━━');
// 這個端點會回全部食材（沒用到的份量 0），只看真的有用到的那些
const ings = (await api('/api/prescriptions/' + byCode['EMP-01'].id + '/ingredients'))
               .filter(i => i.qty_per_cup > 0);
const pack = ings.filter(i => i.prep_stage === '冷凍包');
const fresh = ings.filter(i => !i.prep_stage);
check('第1組有冷凍包用料', pack.length > 0, pack.map(i => i.name).join('、'));
check('第1組有當天現秤用料', fresh.length > 0, `${fresh.length} 樣`);
check('兩者相加等於全部用料', pack.length + fresh.length === ings.length,
      `${pack.length} + ${fresh.length} = ${ings.length}`);

line('\n━━ 7. 兩組配方的內容 ━━');
// 用量釘死在測試裡。配方是每天照著做的東西，改錯一個數字不會有人立刻發現
const SET_A = { '羽衣甘藍':20, '貝比生菜':20, '胡蘿蔔':15, '甜菜根':15, '西洋芹':15,
  '大黃瓜':20, '冷凍菠菜':15, '冷凍花椰菜':15, '蘋果':40, '檸檬':10, '奇異果':20,
  '鳳梨':15, '香蕉':15, '芭樂':15, '藍莓':15, '蛋白粉':30, '肉桂粉':1, '黑胡椒':1,
  '核桃':10, '橄欖油':10, '水':275 };
const SET_B = { '羽衣甘藍':20, '貝比生菜':20, '櫻桃蘿蔔':15, '牛番茄':20, '紫高麗菜':15,
  '櫛瓜':15, '青江菜':15, '萵苣':15, '蘋果':40, '檸檬':10, '綜合莓':20, '木瓜':15,
  '酪梨':15, '甜橙':15, '葡萄':15, '蛋白粉':30, '肉桂粉':1, '黑胡椒':1,
  '核桃':10, '橄欖油':10, '水':275 };

const recipeOf = async id =>
  Object.fromEntries((await api('/api/prescriptions/' + id + '/ingredients'))
    .filter(i => i.qty_per_cup > 0).map(i => [i.name, i.qty_per_cup]));

for (const [code, want, label] of [['EMP-01', SET_A, '第1組'], ['EMP-02', SET_B, '第2組']]) {
  const got = await recipeOf(byCode[code].id);
  const missing = Object.keys(want).filter(n => got[n] === undefined);
  const wrong   = Object.keys(want).filter(n => got[n] !== undefined && got[n] !== want[n])
                    .map(n => `${n} 應 ${want[n]} 實 ${got[n]}`);
  const extra   = Object.keys(got).filter(n => want[n] === undefined);
  check(`${code}（${label}）用料齊全`, missing.length === 0, missing.join('、') || `${Object.keys(got).length} 樣`);
  check(`${code} 每一樣的用量都對`, wrong.length === 0, wrong.join('；') || '全部相符');
  check(`${code} 沒有多出來的用料`, extra.length === 0, extra.join('、') || '無');
}

// 換掉的兩樣不該再出現在任何配方裡
const allRx = await api('/api/prescriptions?include_inactive=1');
let stale = [];
for (const r of allRx.filter(x => x.active === 1)) {
  const got = await recipeOf(r.id);
  ['甜椒', '蘿蔓生菜'].forEach(n => { if (got[n] !== undefined) stale.push(`${r.code}:${n}`); });
}
check('換掉的甜椒與蘿蔓生菜沒有殘留', stale.length === 0, stale.join('、') || '已清乾淨');

line(`\n${'─'.repeat(46)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
