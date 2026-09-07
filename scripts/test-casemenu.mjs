// 給客人看的套餐菜單
//
//   這一頁會被拿到客人面前，所以有兩條硬規格：
//     一、店家名稱、店家品名、價格永遠不能出現（隱私邊界在後端擋，不是在前端藏）
//     二、這個人不吃的類別要擋得住
//
//   「不吃什麼」讀的是 avoid_proteins 這個明確欄位，不是 contraindications。
//   後者現在放的是「無肉桂粉改薑片」「早餐」這種自由備註 ——
//   拿它去比對關鍵字，猜錯的方向是「漏掉過敏」，那不能賭。
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

const rxs = await api('/api/prescriptions');
const rx = rxs.find(r => !r.is_staff_rx) || rxs[0];
const orig = { name: rx.name, formula_type: rx.formula_type, timing: rx.timing,
               contraindications: rx.contraindications || '', active: 1,
               avoid_proteins: rx.avoid_proteins || '' };
const setAvoid = v => api(`/api/prescriptions/${rx.id}`, 'PUT', { ...orig, avoid_proteins: v });
const menu = () => api('/api/meals/menu/case?prescription_id=' + rx.id);
const allItems = m => m.series.flatMap(s => s.items);

line('\n━━ 1. 隱私邊界：客人看不到店家與價格 ━━');
await setAvoid('');
const m1 = await menu();
const blob = JSON.stringify(m1);
check('沒有店家名稱', !/vendor/i.test(blob), '欄位名本身也不該出現');
check('沒有價格', !/price/i.test(blob));
check('沒有店家品名', !/vendor_item_name/i.test(blob));
// 這條是硬規格，不能靠前端藏 —— 前端藏的東西，檢視原始碼就看得到
const vendors = (await api('/api/meals/menu')).vendors.map(v => v.name);
check('店家的名字一個都沒漏出去',
      vendors.every(v => !blob.includes(v)),
      vendors.filter(v => blob.includes(v)).join('、') || `${vendors.length} 家都沒出現`);

line('\n━━ 2. 不吃的類別要擋得住 ━━');
await setAvoid('魚');
const m2 = await menu();
const fish = allItems(m2).filter(i => i.protein === '魚');
check('這個人的清單標出「不吃 魚」', (m2.case.avoid || []).includes('魚'),
      JSON.stringify(m2.case.avoid));
check('每一道魚都被標記', fish.length > 0 && fish.every(i => i.avoid),
      `${fish.length} 道魚`);
check('其他類別不受影響',
      allItems(m2).filter(i => i.protein !== '魚').every(i => !i.avoid));

await setAvoid('魚,豬');
const m3 = await menu();
check('可以一次擋兩類',
      allItems(m3).filter(i => ['魚', '豬'].includes(i.protein)).every(i => i.avoid) &&
      allItems(m3).filter(i => i.protein === '雞').every(i => !i.avoid),
      '魚＋豬');

line('\n━━ 3. 自由備註不會被拿來當禁忌 ━━');
// 「早餐」「無肉桂粉改薑片」這種備註，比對關鍵字會出現莫名其妙的封鎖
await api(`/api/prescriptions/${rx.id}`, 'PUT',
  { ...orig, contraindications: '海鮮過敏', avoid_proteins: '' });
const m4 = await menu();
check('備註寫「海鮮過敏」但沒勾，系統不會自己擋',
      allItems(m4).every(i => !i.avoid),
      '要擋就要勾 —— 猜關鍵字會漏掉沒寫在備註裡的過敏');
check('但備註仍然帶給個管師看', m4.case.note === '海鮮過敏', m4.case.note);

line('\n━━ 4. 店家沒給的數字不要寫成 0 ━━');
// 菜單上寫「蛋白質 0 公克」，客人會以為那盒真的沒有蛋白質 —— 比不寫還糟
const zeroProt = allItems(m4).filter(i => i.protein_g === 0);
check('沒有任何一道寫 0 公克蛋白質', zeroProt.length === 0,
      zeroProt.map(i => i.name).join('、') || '沒給的都回 null');
const noProt = allItems(m4).filter(i => i.protein_g == null);
check('沒給的用 null 表示，前端才顯示得出「—」', noProt.length > 0,
      `${noProt.length} 道未提供`);
const zeroKcal = allItems(m4).filter(i => i.kcal_unknown);
check('熱量沒給的也標得出來', zeroKcal.every(i => i.set_kcal === null),
      `${zeroKcal.length} 道熱量未提供，不會算出假的套餐總熱量`);

line('\n━━ 5. 幾個人吃要幾盒 ━━');
check('帶得出共食比例', Array.isArray(m4.share_ratios) && m4.share_ratios.length > 0,
      m4.share_ratios.map(r => `${r.people}:${r.boxes}`).join('、'));
check('比例是數字，不是字串', m4.share_ratios.every(r =>
      Number.isFinite(r.people) && Number.isFinite(r.boxes)));

line('\n━━ 6. 改了「不吃什麼」要留痕 ━━');
const h = await api(`/api/prescriptions/${rx.id}/history`);
check('異動紀錄看得出來', h.rows.some(r => /不吃的蛋白質/.test(r.summary || '')),
      (h.rows[0] || {}).summary);

line('\n━━ 7. 還原 ━━');
await api(`/api/prescriptions/${rx.id}`, 'PUT', orig);
const back = (await api('/api/prescriptions')).find(r => r.id === rx.id);
check('處方還原成測試前',
      (back.avoid_proteins || '') === (orig.avoid_proteins || '') &&
      (back.contraindications || '') === (orig.contraindications || ''),
      `avoid=「${back.avoid_proteins || ''}」note=「${back.contraindications || ''}」`);

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
