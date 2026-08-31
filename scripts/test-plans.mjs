// 蔬果方案與逐日庫存預測的回歸測試
//
//   方案一／二只差在蔬果，機能配料是每個人自己的。把會輪替的那部分抽出來，
//   處方指向它 —— 這樣改方案的胡蘿蔔只要改一個地方，改 AW 的蛋白粉不會動到員工。
//
//   庫存預測要逐日展開：兩週後換方案，屆時要用到的東西現在完全不會被碰到，
//   也不會有任何警告。換組當天早上才發現就來不及叫貨了。
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

const rxs = await api('/api/prescriptions?include_inactive=1');
const byCode = Object.fromEntries(rxs.map(r => [r.code, r]));
const recipe = async id => (await api('/api/nutrition/prescription/' + id)).breakdown.map(b => b.name);

line('\n━━ 1. 蔬果抽出來了 ━━');
const emp = byCode['EMP-01'];
check('員工只剩一張處方，第二張已退役',
      emp.active === 1 && byCode['EMP-02'] && byCode['EMP-02'].active === 0,
      `EMP-01 啟用、EMP-02 停用`);
check('員工處方指向蔬果方案', emp.produce_plan_group === '主方案', emp.produce_plan_group);
check('AW 也指向同一組方案', byCode['RX-01'].produce_plan_group === '主方案');

const empOwn = await api('/api/prescriptions/' + emp.id + '/ingredients');
const ownProduce = empOwn.filter(i => i.qty_per_cup > 0 && ['蔬菜', '水果'].includes(i.category));
check('處方自己身上不再留任何蔬果', ownProduce.length === 0,
      ownProduce.map(i => i.name).join('、') || '已清空');

line('\n━━ 2. 有效配方 = 自己的 ＋ 方案的 ━━');
const empAll = await recipe(emp.id);
check('員工湊出 21 樣', empAll.length === 21, `${empAll.length} 樣`);
check('湊出來的有蔬果', empAll.includes('羽衣甘藍') && empAll.includes('蘋果'));
check('也有自己的粉', empAll.includes('蛋白粉') && empAll.includes('黑胡椒'));

line('\n━━ 3. AW 保有自己的機能配料 ━━');
const awAll = await recipe(byCode['RX-01'].id);
['AstragIN', '益生菌', '燕麥', '薑黃粉', '苦茶油'].forEach(n =>
  check(`AW 仍有 ${n}`, awAll.includes(n)));
check('AW 也吃到方案的蔬果', awAll.includes('羽衣甘藍') && awAll.includes('芭樂'));

line('\n━━ 4. 其他個案完全不受影響 ━━');
const others = rxs.filter(r => r.active === 1 && !r.produce_plan_group
                            && !String(r.code).startsWith('ZZ') && r.code !== 'EMP-01');
check('其他個案的方案組都是空的', others.every(r => !r.produce_plan_group),
      others.map(r => r.code).join('、'));
if (others.length) {
  const o = await recipe(others[0].id);
  check(`${others[0].code} 的配方沒有被方案灌進來`, o.length > 0 && o.length < 21,
        `${o.length} 樣（方案是 15 樣蔬果，混進來會超過 21）`);
}

line('\n━━ 5. 逐日預測跟著方案走 ━━');
const f = await api('/api/inventory/forecast?days=28');
check('算得出今天用哪個方案', !!f.plan_today, f.plan_today && f.plan_today.name);
check('逐日展開，不是打成一坨', Array.isArray(f.days) && f.days.length >= 28, `${f.days.length} 天`);
const planNames = [...new Set(f.days.map(d => d.plan_name))];
check('28 天內看得到換方案', planNames.length === 2, planNames.join(' → '));
const firstB = f.days.find(d => d.plan_name !== f.plan_today.name);
check('同一個雙週內不會中途換', firstB && f.days.slice(0, f.days.indexOf(firstB))
      .every(d => d.plan_name === f.plan_today.name), firstB && `${firstB.date} 才換`);

line('\n━━ 6. 換方案要提前警告 ━━');
const w = f.switch_warning;
check('有換組預警', !!w, w && `${w.date}（${w.days_ahead} 天後）${w.from} → ${w.to}`);
check('預警列出屆時會缺什麼', w && Array.isArray(w.missing) && w.missing.length > 0,
      w && `${w.missing.length} 樣不足`);
check('預警提前超過一週，來得及叫貨', w && w.days_ahead >= 7, w && `${w.days_ahead} 天`);

line('\n━━ 7. 備料區間照盤點日算 ━━');
check('讀得到盤點日設定', Array.isArray(f.stocktake_dows) && f.stocktake_dows.length > 0,
      '週' + f.stocktake_dows.join('、週'));
check('備料區間結束在盤點日',
      f.stocktake_dows.includes(new Date(f.prep_window.to + 'T00:00:00').getDay()),
      `${f.prep_window.from} → ${f.prep_window.to}`);

line('\n━━ 8. 緩衝：比例與絕對杯數取大者 ━━');
check('讀得到緩衝設定', f.buffer.pct > 0 && f.buffer.cups > 0,
      `${f.buffer.pct}% 或 ${f.buffer.cups} 杯份`);
const withNeed = f.ingredients.filter(i => i.need_window > 0);
check('每一樣都算了緩衝', withNeed.length > 0 && withNeed.every(i => i.buffer > 0),
      `${withNeed.length} 樣`);
check('緩衝不小於比例算出來的',
      withNeed.every(i => i.buffer >= Math.round(i.need_window * f.buffer.pct / 100 * 10) / 10 - 0.05),
      '突發外帶 3~5 杯時，20% 在小週會不夠');

line('\n━━ 9. 見底日 ━━');
const runOut = f.ingredients.filter(i => i.runs_out_on);
check('算得出哪天見底', runOut.length > 0, `${runOut.length} 樣有見底日`);
check('見底日在預測範圍內',
      runOut.every(i => i.runs_out_on >= f.date), '不會算出過去的日期');

line('\n━━ 10. 水不進採購清單 ━━');
check('水不出現在要買的東西裡', !f.ingredients.some(i => i.name === '水'),
      '自來水不用買，但配方仍記著每杯 275ml');

line('\n━━ 11. 盤點清單會縮短 ━━');
const sl = await api('/api/stocktake/shortlist');
const allIng = (await api('/api/ingredients')).filter(i => i.active !== 0);
check('盤點清單比全部食材短', sl.count > 0 && sl.count < allIng.length,
      `${sl.count} / ${allIng.length} 樣 —— 盤太多就會開始亂填`);
check('每一項都說得出為什麼要盤', sl.items.every(i => i.reasons && i.reasons.length > 0));
check('知道今天是不是盤點日', typeof sl.is_stocktake_day === 'boolean',
      sl.is_stocktake_day ? '今天要盤' : '今天不用盤');

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
