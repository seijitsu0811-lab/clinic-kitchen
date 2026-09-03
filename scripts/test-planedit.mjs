// 蔬果方案編修的回歸測試
//
//   方案改一次全體生效（員工、AW、所有引用它的個案），影響比改單一處方
//   更大 —— 但它原本是唯一沒有編輯端點、也沒有異動留痕的地方，
//   只能靠寫一次性遷移偷偷改。那正是「改了不留痕」的老問題。
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

const plans = () => api('/api/produce-plans');
const ings  = () => api('/api/ingredients');
const toBody = p => p.items.filter(i => i.qty_per_cup > 0).map(i =>
  ({ ingredient_id: i.ingredient_id, qty_per_cup: i.qty_per_cup, prep: i.prep, prep_stage: i.prep_stage }));

const A = (await plans()).find(p => p.code === 'PLAN-A');
const orig = toBody(A);
const hist = () => api('/api/produce-plans/' + A.id + '/history');

line('\n━━ 1. 讀得到方案內容 ━━');
check('方案有蔬果', A.items.length > 0, `${A.name} ${A.items.length} 樣`);
check('每一樣都帶得出名稱與類別',
      A.items.every(i => i.name && i.category), '編輯畫面要看得懂');

line('\n━━ 2. 只放蔬菜與水果 ━━');
check('現有內容全是蔬果',
      A.items.every(i => ['蔬菜', '水果'].includes(i.category)),
      '機能配料屬於個人，混進方案會讓所有人一起被改到');
const powder = (await ings()).find(i => i.category === '粉類');
let blocked = false;
try {
  await api('/api/produce-plans/' + A.id + '/items', 'PUT',
    [...orig, { ingredient_id: powder.id, qty_per_cup: 5 }]);
} catch (e) { blocked = /只放蔬菜與水果/.test(e.message); }
check('放粉類進去會被擋下來', blocked, `試著加入 ${powder.name}`);
check('被擋下來時內容沒有被改掉',
      (await plans()).find(p => p.code === 'PLAN-A').items.filter(i => i.qty_per_cup > 0).length === orig.length,
      '擋下來卻已經先刪掉舊的，等於把方案清空');

line('\n━━ 3. 改內容會留痕 ━━');
const before3 = (await hist()).total;
const first = A.items.find(i => i.qty_per_cup > 0);
await api('/api/produce-plans/' + A.id + '/items', 'PUT',
  orig.map(x => x.ingredient_id === first.ingredient_id ? { ...x, qty_per_cup: x.qty_per_cup + 5 } : x));
let h = await hist();
check('留下一筆', h.total === before3 + 1, `${before3} → ${h.total}`);
check('摘要看得出從幾克改成幾克',
      new RegExp(`${first.name} ${first.qty_per_cup}g → ${first.qty_per_cup + 5}g`).test(h.rows[0].summary),
      h.rows[0].summary);
check('記得下是誰改的', !!h.rows[0].by && h.rows[0].by !== '—', h.rows[0].by);

line('\n━━ 4. 換品項說得出換了什麼 ━━');
const all = await ings();
const other = all.find(i => i.category === '水果' && !A.items.some(x => x.ingredient_id === i.id));
if (other) {
  const fruit = A.items.find(i => i.category === '水果' && i.qty_per_cup > 0);
  await api('/api/produce-plans/' + A.id + '/items', 'PUT',
    orig.map(x => x.ingredient_id === fruit.ingredient_id
      ? { ingredient_id: other.id, qty_per_cup: fruit.qty_per_cup, prep: 'ZZ測試', prep_stage: '' } : x));
  h = await hist();
  check('說得出移除了什麼', new RegExp(`移除 ${fruit.name}`).test(h.rows[0].summary), h.rows[0].summary);
  check('說得出換成什麼', new RegExp(`新增 ${other.name}`).test(h.rows[0].summary));
} else {
  line('  － 沒有可換的水果，略過');
}

line('\n━━ 5. 沒改就不要留 ━━');
const before5 = (await hist()).total;
await api('/api/produce-plans/' + A.id + '/items', 'PUT', toBody((await plans()).find(p => p.code === 'PLAN-A')));
check('存檔但沒有實質改動，不留紀錄', (await hist()).total === before5,
      `${before5} 筆（每次存檔都留一筆會把真正的異動淹掉）`);

line('\n━━ 6. 改方案要影響到所有引用它的人 ━━');
const rxs = await api('/api/prescriptions');
const users = rxs.filter(r => r.produce_plan_group);
check('有處方引用這個方案', users.length > 0, users.map(r => r.code).join('、'));
if (users.length) {
  const n = await api('/api/nutrition/prescription/' + users[0].id);
  const cur = (await plans()).find(p => p.code === 'PLAN-A');
  const planNames = new Set(cur.items.filter(i => i.qty_per_cup > 0).map(i => i.name));
  const got = new Set(n.breakdown.filter(b => (b.qty ?? b.qty_per_cup) > 0).map(b => b.name));
  const missing = [...planNames].filter(x => !got.has(x));
  check('方案的每一樣都出現在他的有效配方裡', missing.length === 0,
        missing.join('、') || `${users[0].code} 湊出 ${got.size} 樣`);
}

line('\n━━ 7. 還原 ━━');
await api('/api/produce-plans/' + A.id + '/items', 'PUT', orig);
const back = (await plans()).find(p => p.code === 'PLAN-A');
const names = back.items.filter(i => i.qty_per_cup > 0).map(i => i.ingredient_id).sort().join();
check('內容回到測試前', names === orig.map(x => x.ingredient_id).sort().join(),
      `${back.items.filter(i => i.qty_per_cup > 0).length} 樣`);
check('還原本身也是一次異動，同樣留痕', (await hist()).total > before3,
      '還原不是「取消」，它就是一次改動');

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
