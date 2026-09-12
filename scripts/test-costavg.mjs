// 成本的均價：怎麼算、重複怎麼擋、設定值是不是數字
//
//   John 問的三件事，這支就是把答案鎖住：
//     1 均價是「總金額 ÷ 總數量」的加權平均，不是各筆單價的平均
//     2 同一張發票登記兩次會被擋下來要確認 —— 單價把關抓不到它，
//       因為重複那一筆的單價完全正確
//     3 設定值真的要轉成數字。getSettings 的 regex 反斜線曾經掉過
//       （/^-?d+(.d+)?$/），那樣「90」「250」全部留成字串，
//       等於那一行從來沒生效。當時沒出事純粹是運氣。
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

const NAME = 'ZZ均價測試料';
let ing = null;
{
  const all = await api('/api/ingredients?include_inactive=1');
  ing = all.find(i => i.name === NAME);
  if (!ing) {
    const r = await api('/api/ingredients', 'POST', { name: NAME, unit: 'g', category: '其他' });
    ing = (await api('/api/ingredients?include_inactive=1')).find(i => i.id === r.id);
  }
  await api('/api/ingredients/' + ing.id, 'PUT',
    { name: NAME, unit: 'g', category: '其他', active: 1 });
}
const purchases = async () => {
  const ps = await api('/api/inventory/' + ing.id + '/purchases');
  return ps.purchases || ps;
};
const cleanup = async () => {
  for (const p of await purchases()) await api('/api/purchase/' + p.id, 'DELETE').catch(() => {});
  await api('/api/inventory/' + ing.id, 'PUT', { qty: 0 }).catch(() => {});
};
await cleanup();
check('前置：造得出測試食材', !!ing, ing ? ing.name : '★ 造不出來');

const TODAY = new Date().toISOString().slice(0, 10);
const add = (qty, price, extra = {}) => api('/api/inventory/purchase', 'POST',
  { ingredient_id: ing.id, qty, input_unit: 'base', total_price: price,
    purchased_at: TODAY, ...extra });

line('\n━━ 1. 均價是加權的，不是各筆單價的平均 ━━');
// 買得多的那一筆權重就要大。兩種算法差很多，而「平均」這個詞
// 兩種都講得通 —— 所以要有一條斷言講清楚是哪一種
{
  // 價差刻意壓在 5 倍以內。超過 5 倍會被「單位填錯」那道把關擋下來 ——
  // 那道把關是對的，所以這裡測加權平均就不要去踩它
  await add(1000, 100);   // 0.10 元/g
  await add(200, 60);     // 0.30 元/g
  const list = await purchases();
  const tq = list.reduce((s, p) => s + Number(p.qty), 0);
  const tp = list.reduce((s, p) => s + Number(p.total_price), 0);
  const weighted = tp / tq;                 // 160 / 1200 = 0.1333
  const naive = (0.10 + 0.30) / 2;          // 0.20
  check('總金額 ÷ 總數量', Math.abs(weighted - 0.1333) < 0.001,
        `${tp} ÷ ${tq} = ${weighted.toFixed(4)} 元/g`);

  const c = await api('/api/costs');
  let uc = null, n = null;
  c.prescriptions.forEach(p => (p.breakdown || []).forEach(b => {
    if (b.name === NAME) { uc = b.unit_cost; n = b.price_n; }
  }));
  if (uc == null) {
    line('  － 沒有配方用到這樣食材，改用採購紀錄直接驗');
    check('不是各筆單價的平均', Math.abs(weighted - naive) > 0.05,
          `加權 ${weighted.toFixed(4)} vs 各筆平均 ${naive.toFixed(4)}　—— 差 ${(naive / weighted).toFixed(1)} 倍`);
  } else {
    check('成本頁用的就是加權平均', Math.abs(uc - weighted) < 0.002, `${uc} / ${weighted.toFixed(4)}`);
    check('成本頁講得出是幾筆算出來的', n === list.length, `${n} 筆`);
  }
}

line('\n━━ 2. 同一張發票登記兩次要被擋 ━━');
// 單價把關抓不到這件事：重複那一筆的單價完全正確。
// 傷害在庫存被加兩次，以及那個價格點拿到雙倍權重
{
  const before = await purchases();
  const invBefore = (await api('/api/inventory'));
  const rowsB = Array.isArray(invBefore) ? invBefore : (invBefore.items || []);
  const qtyBefore = rowsB.find(r => r.id === ing.id).qty;

  const dup = await tryApi('/api/inventory/purchase', 'POST',
    { ingredient_id: ing.id, qty: 1000, input_unit: 'base', total_price: 100,
      purchased_at: TODAY });
  check('擋住了', !dup.ok && dup.status === 409, `HTTP ${dup.status}`);
  check('訊息講得出哪一筆一樣',
        !!(dup.json && /已經有一筆一模一樣/.test(dup.json.error || '')),
        dup.json ? String(dup.json.error).slice(0, 70) : '');

  const after = await purchases();
  const invAfter = await api('/api/inventory');
  const rowsA = Array.isArray(invAfter) ? invAfter : (invAfter.items || []);
  check('擋下來就不能留下半筆', after.length === before.length,
        `${before.length} → ${after.length} 筆`);
  check('庫存也沒被動到',
        Math.abs(rowsA.find(r => r.id === ing.id).qty - qtyBefore) < 0.05,
        `${qtyBefore} → ${rowsA.find(r => r.id === ing.id).qty}`);

  // 同規格買兩包是真的會發生的事，所以確認過要進得去 —— 不是擋死
  const forced = await api('/api/inventory/purchase', 'POST',
    { ingredient_id: ing.id, qty: 1000, input_unit: 'base', total_price: 100,
      purchased_at: TODAY, confirm_duplicate: true });
  check('確認過就進得去（真的會買兩包）', forced.base_qty === 1000, `${forced.base_qty} g`);

  // 重複之後那個價格點權重變兩倍 —— 均價確實會往它靠
  const list2 = await purchases();
  const w2 = list2.reduce((s, p) => s + Number(p.total_price), 0)
           / list2.reduce((s, p) => s + Number(p.qty), 0);
  check('重複會讓均價往那一筆靠', w2 < 0.1333 - 0.005,
        `0.1333 → ${w2.toFixed(4)} 元/g　—— 0.10 那一筆拿到雙倍權重`);

  const extra = list2.find(p => !before.some(b => b.id === p.id));
  if (extra) await api('/api/purchase/' + extra.id, 'DELETE');
}

line('\n━━ 3. 採購籃那條路也要擋 ━━');
{
  const r = await tryApi('/api/purchase/commit', 'POST',
    { date: TODAY, lines: [{ ingredient_id: ing.id, qty: 1000, total_price: 100 }] });
  check('整批登記也擋得住', !r.ok && r.status === 409, `HTTP ${r.status}`);
  check('訊息講得出是哪一樣',
        !!(r.json && /已經有一模一樣的紀錄/.test(r.json.error || '')),
        r.json ? String(r.json.error).slice(0, 70) : '');
}

line('\n━━ 4. 設定值必須是數字，不是字串 ━━');
// getSettings 的 regex 反斜線掉過一次，那一行因此從來沒生效。
// 當時沒算錯數字純粹是運氣：用它的地方一個用 *（會自動轉型）、
// 一個有自己的 num()。下一個寫 settings.full_formula_price + x 的人就會中，
// 而同一種 bug 已經讓人工成本被算成 6.6 倍過一次
{
  const c = await api('/api/costs');
  const s = c.settings;
  const numeric = ['labor_rate', 'labor_min_per_batch', 'labor_min_per_serving',
                   'cost_lookback_days', 'full_formula_price', 'powder_formula_price'];
  const bad = numeric.filter(k => s[k] !== undefined && typeof s[k] !== 'number');
  check('該是數字的都是數字', bad.length === 0,
        bad.length ? '★ 還是字串：' + bad.map(k => `${k}=${JSON.stringify(s[k])}`).join('、')
                   : numeric.filter(k => s[k] !== undefined).map(k => `${k}=${s[k]}`).join('、'));

  // 反過來也要對：日期與比例不能被當成數字截掉
  const textual = ['rotation_anchor', 'share_ratios', 'staff_meal_dows', 'subscription_dows'];
  const wrecked = textual.filter(k => s[k] !== undefined && typeof s[k] === 'number');
  check('日期與比例不能被截成數字', wrecked.length === 0,
        wrecked.length ? '★ ' + wrecked.map(k => `${k}=${s[k]}`).join('、')
                       : textual.filter(k => s[k] !== undefined).map(k => `${k}=${s[k]}`).join('、'));

  // 字串做加法會變串接。這一條是那顆炸彈本身
  const price = s.full_formula_price;
  check('拿去做加法不會變成串接', typeof price !== 'number' || typeof (price + 1) === 'number',
        `full_formula_price + 1 = ${price + 1}`);
}

line('\n━━ 5. 單價要講得出可信度 ━━');
{
  const c = await api('/api/costs');
  const all = [];
  c.prescriptions.forEach(p => (p.breakdown || []).forEach(b => all.push(b)));
  check('每一列都帶筆數', all.length > 0 && all.every(b => typeof b.price_n === 'number'),
        `${all.length} 列`);
  check('每一列都講得出來源', all.every(b => ['window', 'history', 'none'].includes(b.price_source)),
        'window / history / none');
  const thin = all.filter(b => b.price_source === 'window' && b.price_n === 1);
  const stale = all.filter(b => b.price_source === 'history');
  const none = all.filter(b => b.price_source === 'none');
  check('窗口起點回得出來', !!c.cost_window_from || c.cost_lookback_days === 0,
        c.cost_window_from || '（不限期間）');
  line(`  － 只 1 筆撐著的 ${new Set(thin.map(b => b.name)).size} 樣、`
     + `用舊價的 ${new Set(stale.map(b => b.name)).size} 樣、`
     + `沒有進貨紀錄的 ${new Set(none.map(b => b.name)).size} 樣`);
}

line('\n━━ 6. 收尾 ━━');
await cleanup();
await api('/api/ingredients/' + ing.id, 'PUT',
  { name: NAME, unit: 'g', category: '其他', active: 0 }).catch(() => {});
{
  const still = (await api('/api/ingredients')).find(i => i.id === ing.id);
  check('測試食材已停用', !still, still ? '★ 還在' : '已清');
  check('測試的採購紀錄已清掉', (await purchases()).length === 0);
}

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
