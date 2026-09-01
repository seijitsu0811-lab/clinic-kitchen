// 配方異動留痕的回歸測試
//
//   這個系統裡放的是具名個案的醫療配方。2026-06 那次把「蘋果(去皮)」
//   改名成「蘋果(純皮)」，語意整個翻轉 —— 是靠翻 git log 才查出來的，
//   資料本身什麼都沒有留下。
//
//   操作紀錄（user_logs）只記「誰動了哪個端點」，查不出「份量從幾克變成
//   幾克」。所以要另外留配方的前後快照與可讀的差異。
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

// 用一張複製出來的處方測，不要動到真的在用的配方
const all = await api('/api/prescriptions?include_inactive=1');
const src = all.find(r => r.code === 'EMP-01');
const used = new Set(all.map(r => r.code));
let n = 1; while (used.has('ZZ-HIST' + n)) n++;
const rx = await api(`/api/prescriptions/${src.id}/duplicate`, 'POST',
  { code: 'ZZ-HIST' + n, name: 'ZZ 留痕測試' });

const hist = () => api('/api/prescriptions/' + rx.id + '/history');
const items = () => api('/api/prescriptions/' + rx.id + '/ingredients');
const toBody = list => list.filter(i => i.qty_per_cup > 0).map(i =>
  ({ ingredient_id: i.id, qty_per_cup: i.qty_per_cup, prep: i.prep, prep_stage: i.prep_stage }));

line('\n━━ 1. 改份量會留痕 ━━');
const base = await items();
const orig = toBody(base);
const prot = base.find(i => i.name === '蛋白粉');
await api('/api/prescriptions/' + rx.id + '/ingredients', 'PUT',
  orig.map(x => x.ingredient_id === prot.id ? { ...x, qty_per_cup: 35 } : x));
let h = await hist();
check('留下一筆', h.total >= 1, `${h.total} 筆`);
check('摘要看得出從幾克改成幾克', /蛋白粉 30g → 35g/.test(h.rows[0].summary),
      h.rows[0].summary);
check('記得下是誰改的', !!h.rows[0].by && h.rows[0].by !== '—', h.rows[0].by);
check('記得下什麼時候', /^\d{4}-\d{2}-\d{2}/.test(h.rows[0].changed_at || ''), h.rows[0].changed_at);

line('\n━━ 2. 新增與移除也要說得出來 ━━');
const cur = await items();
const walnut = cur.find(i => i.name === '核桃');
const blue   = cur.find(i => i.name === '藍莓');
const next = toBody(cur).filter(x => x.ingredient_id !== walnut.id);
next.push({ ingredient_id: blue.id, qty_per_cup: 12, prep: '冷凍直取', prep_stage: '' });
await api('/api/prescriptions/' + rx.id + '/ingredients', 'PUT', next);
h = await hist();
check('說得出新增了什麼', /新增 藍莓 12g/.test(h.rows[0].summary), h.rows[0].summary);
check('說得出移除了什麼', /移除 核桃/.test(h.rows[0].summary));

line('\n━━ 3. 處理方式改變也要記 ━━');
// 「去皮」變「純皮」正是六月那次出事的形態 —— 份量沒動，意思整個相反
const c3 = await items();
// 一定要挑這張處方自己有用量的品項。蘋果在蔬果方案裡，
// 從這個端點看它的 qty_per_cup 是 0，送出的內容根本不含那一行
const apple = c3.find(i => i.qty_per_cup > 0);
const b3 = toBody(c3).map(x => x.ingredient_id === apple.id ? { ...x, prep: 'ZZ純皮' } : x);
await api('/api/prescriptions/' + rx.id + '/ingredients', 'PUT', b3);
h = await hist();
check('份量沒變但處理方式變了，仍然留痕',
      /處理方式/.test(h.rows[0].summary), h.rows[0].summary);

line('\n━━ 4. 沒改東西就不要留 ━━');
const before4 = (await hist()).total;
const same = toBody(await items());
await api('/api/prescriptions/' + rx.id + '/ingredients', 'PUT', same);
check('存檔但沒有實質改動，不留紀錄', (await hist()).total === before4,
      `${before4} 筆（每次存檔都留一筆會把真正的異動淹掉）`);

line('\n━━ 5. 基本資料改動 ━━');
const before5 = (await hist()).total;
await api('/api/prescriptions/' + rx.id, 'PUT',
  { name: 'ZZ 留痕測試（改名）', formula_type: src.formula_type,
    timing: src.timing, contraindications: 'ZZ 測試禁忌', active: 1 });
h = await hist();
check('改名與禁忌註記有記到', h.total > before5 && /名稱|禁忌/.test(h.rows[0].summary),
      h.rows[0].summary);
check('分得出是哪一種異動', h.rows[0].change_type === '基本資料', h.rows[0].change_type);

line('\n━━ 6. 前後完整快照都留著 ━━');
const r6 = (await hist()).rows.find(r => r.change_type === '用料');
check('有改動前的完整配方', !!(r6 && r6.before && Array.isArray(r6.before.items)),
      r6 && r6.before ? `${r6.before.items.length} 樣` : '缺');
check('有改動後的完整配方', !!(r6 && r6.after && Array.isArray(r6.after.items)),
      r6 && r6.after ? `${r6.after.items.length} 樣` : '缺');

line('\n━━ 7. 蔬果方案不算個人配方的異動 ━━');
const anyProduce = (await hist()).rows.some(r =>
  (r.after?.items || []).some(i => ['羽衣甘藍', '蘋果', '藍莓'].includes(i.name) && i.name === '羽衣甘藍'));
check('快照只含這張處方自己的用料', !anyProduce,
      '蔬果來自方案，改方案是另一件事，不該記成某個人的配方異動');

line('\n━━ 8. 清理 ━━');
await api('/api/prescriptions/' + rx.id, 'DELETE');
const gone = (await api('/api/prescriptions')).find(r => r.id === rx.id);
check('測試處方已停用', !gone);
check('停用之後紀錄仍查得到', (await hist()).total > 0,
      '處方停用不代表歷史可以消失');

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
