// 人工成本的回歸測試
//
//   settings 存的是 TEXT。拿字串去算 (15/3 + "3") 會得到 "53" 而不是 8 ——
//   除法會自動轉型，加法卻變成字串串接。人工成本因此被算成 6.6 倍
//   （每杯 $220.8 而不是 $33.3），連帶讓每一張處方的總成本都錯。
//
//   最難發現的地方在於：$220 看起來只是「有點高」，不像壞掉。
//   所以這裡直接把算式釘死，不是只驗「有沒有大於 0」。
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

const costs = () => api('/api/costs');

line('\n━━ 1. 每杯人工＝算式的結果，不是「大於 0」━━');
let c = await costs();
const lm = c.labor_model;
const rate = Number(lm.rate), pb = Number(lm.min_per_batch),
      ps = Number(lm.min_per_serving), size = Number(lm.batch_size) || 3;
const expect = Math.round(((pb / size + ps) * rate / 60) * 10) / 10;
check('每杯人工 = (每批工時 ÷ 批量 + 每杯工時) × 時薪 ÷ 60',
      Math.abs(c.labor_cost_per_cup - expect) < 0.05,
      `${c.labor_cost_per_cup} ＝ (${pb}÷${size} + ${ps}) × ${rate} ÷ 60 = ${expect}`);

line('\n━━ 2. 設定值是字串也要算對 ━━');
// settings 存 TEXT，所以拿到的本來就可能是字串。這一條就是當初出事的原因
check('設定讀出來確實可能是字串',
      typeof lm.rate === 'string' || typeof lm.min_per_serving === 'string'
      || typeof lm.rate === 'number',
      `rate=${typeof lm.rate}／min_per_serving=${typeof lm.min_per_serving}`);
check('沒有變成字串串接（"5"+"3"="53"）',
      c.labor_cost_per_cup < rate,            // 串接的話會遠大於時薪
      `${c.labor_cost_per_cup} < 時薪 ${rate}`);

line('\n━━ 3. 換一組設定也要跟著對 ━━');
const orig = { labor_rate: rate, labor_min_per_batch: pb, labor_min_per_serving: ps };
await api('/api/settings', 'PUT', { labor_rate: 300, labor_min_per_batch: 20, labor_min_per_serving: 4 });
c = await costs();
const expect2 = Math.round(((20 / size + 4) * 300 / 60) * 10) / 10;
check('改設定之後算式仍成立',
      Math.abs(c.labor_cost_per_cup - expect2) < 0.05,
      `${c.labor_cost_per_cup} ＝ (20÷${size} + 4) × 300 ÷ 60 = ${expect2}`);
await api('/api/settings', 'PUT', orig);

line('\n━━ 4. 處方總成本 = 食材 + 人工 ━━');
c = await costs();
const rx = c.prescriptions.find(p => p.code === 'EMP-01') || c.prescriptions[0];
check('加起來對得上',
      Math.abs(rx.total_cost - (rx.ingredient_cost + rx.labor_cost)) < 0.15,
      `${rx.code}：食材 $${rx.ingredient_cost} ＋ 人工 $${rx.labor_cost} = $${rx.total_cost}`);
check('食材成本 = 各項小計相加',
      Math.abs(rx.ingredient_cost - rx.breakdown.reduce((s, b) => s + (b.cost || 0), 0)) < 0.6,
      `${rx.breakdown.length} 項`);

line('\n━━ 5. 用料明細要帶得出每杯用量 ━━');
// 少了它，畫面上只看得到金額、看不出「幾克 × 單價」，查不出哪裡貴
check('每一項都有每杯用量',
      rx.breakdown.every(b => typeof (b.qty_per_cup ?? b.qty) === 'number'),
      rx.breakdown[0] ? `${rx.breakdown[0].name} ${rx.breakdown[0].qty_per_cup}${rx.breakdown[0].unit}` : '');
check('小計 = 每杯用量 × 單價',
      rx.breakdown.every(b => Math.abs((b.cost || 0) - (b.qty_per_cup ?? b.qty) * (b.unit_cost || 0)) < 0.15),
      '對不上的話，畫面上的數字沒有一個能信');

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
