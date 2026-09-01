// 複製處方的回歸測試
//
//   很多個案的內用配方跟員工／AW 幾乎一樣，只差益生菌那幾樣。
//   複製再微調比從頭建快得多 —— 但複製出來必須是**獨立**的一份：
//   改來源不會連帶改到它。這一點如果錯了，改一張處方會悄悄改到別人的餐。
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
const src = rxs.find(r => r.code === 'EMP-01');
// 刪除是軟刪除，代號仍被佔著（歷史出單指向它）。所以每一輪用不同的代號，
// 不去依賴「清理會把代號釋放出來」—— 那個假設不成立
const used = new Set(rxs.map(r => r.code));
let n = 1; while (used.has('ZZ-DUP' + n)) n++;
const CODE = 'ZZ-DUP' + n;

const own = async id => Object.fromEntries(
  (await api('/api/prescriptions/' + id + '/ingredients'))
    .filter(i => i.qty_per_cup > 0).map(i => [i.name, i.qty_per_cup]));
const effective = async id =>
  (await api('/api/nutrition/prescription/' + id)).breakdown.map(b => b.name);

line('\n━━ 1. 複製出一張新的 ━━');
const srcOwn = await own(src.id);
const dup = await api(`/api/prescriptions/${src.id}/duplicate`, 'POST',
  { code: CODE, name: 'ZZ 複製測試' });
check('建立成功並回報複製了幾項', !!dup.id && dup.copied_items > 0,
      `${dup.code}「${dup.name}」複製 ${dup.copied_items} 項`);
check('代號與名稱照給的', dup.code === CODE && dup.name === 'ZZ 複製測試');
check('不會把員工旗標一起複製過去', dup.is_staff_rx === 0,
      '複製一張出來不該變成第二張員工處方');

line('\n━━ 2. 自己的用料完整帶過來 ━━');
const dupOwn = await own(dup.id);
const missing = Object.keys(srcOwn).filter(n => dupOwn[n] !== srcOwn[n]);
check('每一項用料與份量都一致', missing.length === 0,
      missing.map(n => `${n} 應 ${srcOwn[n]} 實 ${dupOwn[n]}`).join('；') ||
      `${Object.keys(dupOwn).length} 項相符`);

line('\n━━ 3. 蔬果方案跟著沿用，不是複製成獨立的一份 ━━');
check('方案組沿用來源', dup.produce_plan_group === src.produce_plan_group,
      `[${dup.produce_plan_group}]`);
const dupProduce = (await api('/api/prescriptions/' + dup.id + '/ingredients'))
  .filter(i => i.qty_per_cup > 0 && ['蔬菜', '水果'].includes(i.category));
check('蔬果沒有被複製成自己的用料', dupProduce.length === 0,
      dupProduce.map(i => i.name).join('、') || '蔬果來自方案，會隨輪替換');
const srcEff = await effective(src.id), dupEff = await effective(dup.id);
check('湊出來的完整配方與來源相同', srcEff.length === dupEff.length,
      `來源 ${srcEff.length} 樣／複本 ${dupEff.length} 樣`);

line('\n━━ 4. 複本是獨立的 —— 改它不會動到來源 ━━');
const items = await api('/api/prescriptions/' + dup.id + '/ingredients');
const probiotic = items.find(i => i.name === '益生菌');
if (probiotic) {
  await api('/api/prescriptions/' + dup.id + '/ingredients', 'PUT',
    items.map(i => ({ ingredient_id: i.id,
                      qty_per_cup: i.id === probiotic.id ? 1 : i.qty_per_cup,
                      prep: i.prep, prep_stage: i.prep_stage })));
  const after = await own(dup.id);
  const srcAfter = await own(src.id);
  check('複本加了益生菌', after['益生菌'] === 1, `益生菌 ${after['益生菌']}g`);
  check('來源沒有被連帶改到', srcAfter['益生菌'] === undefined,
        '這正是「複製」和「共用基礎配方」的差別');
} else {
  line('  － 找不到益生菌這個品項，略過這組');
}

line('\n━━ 5. 代號重複要擋下來 ━━');
let blocked = false;
try { await api(`/api/prescriptions/${src.id}/duplicate`, 'POST', { code: CODE, name: 'x' }); }
catch (e) { blocked = /代號/.test(e.message); }
check('同代號不能建第二張', blocked);
let explained = false;
try { await api(`/api/prescriptions/${src.id}/duplicate`, 'POST', { code: 'EMP-01', name: 'x' }); }
catch (e) { explained = /已經是/.test(e.message); }
check('被佔用時說得出是誰在用', explained, '只說「已經有人用了」查不出原因');
let noCode = false;
try { await api(`/api/prescriptions/${src.id}/duplicate`, 'POST', { name: 'x' }); }
catch (e) { noCode = true; }
check('沒給代號要擋下來', noCode);

line('\n━━ 6. 清理 ━━');
await api('/api/prescriptions/' + dup.id, 'DELETE');
const gone = (await api('/api/prescriptions')).find(r => r.code === CODE);
check('測試處方已停用', !gone);

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
