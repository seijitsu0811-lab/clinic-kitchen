// 把 cardNumberIssues 從 server.js 裡挖出來單獨驗，確認它抓得到 4 月那個錯
import fs from 'node:fs';
const src = fs.readFileSync('server.js', 'utf8');
const m = src.match(/function cardNumberIssues\(text, item\) \{[\s\S]*?\n\}/);
if (!m) { console.error('找不到函式'); process.exit(1); }
const cardNumberIssues = eval('(' + m[0].replace('function cardNumberIssues', 'function') + ')');

const cases = [
  ['4 月那張錯的（雞胸 37g vs 雞腿 48g）',
   '極致純淨・高效率肌肉修復 低脂雞胸蛋白質 37g ｜ 豐富支鏈胺基酸 BCAA 每份提供 37g 優質蛋白質',
   { kcal: 674, protein_g: 48 }, true],
  ['改好之後的（48 公克）',
   '去骨雞腿・高效率肌肉修復 去骨烤雞腿 蛋白質 48 公克 每份提供 48 公克優質蛋白質，熱量也最高（674 大卡）',
   { kcal: 674, protein_g: 48 }, false],
  ['約略值的四捨五入（約 20 公克 vs 20.3）',
   '蛋白質約 20 公克 ｜ 熱量約 485 大卡', { kcal: 485, protein_g: 20.3 }, false],
  ['維生素 B12 不能被當成克數',
   '鐵質與維生素 B12 來源 ｜ 蛋白質約 17 公克', { kcal: 575, protein_g: 17 }, false],
  ['Omega-3 與 n-3 不能被當成克數',
   'EPA & DHA 脂肪酸 ｜ 天然 Omega-3 ｜ n-3 多元不飽和脂肪酸', { kcal: 520, protein_g: 25 }, false],
  ['熱量寫錯也要抓到',
   '熱量約 900 大卡', { kcal: 485, protein_g: 20.3 }, true],
  ['精力湯那種沒有對應品項的，不比對',
   '蛋白質 99 公克', null, false]
];

let pass = 0, fail = 0;
for (const [name, text, item, shouldFlag] of cases) {
  const out = cardNumberIssues(text, item);
  const ok = (out.length > 0) === shouldFlag;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}  ${out.length ? '→ ' + out.join('；') : '→ 沒問題'}`);
}
console.log(`\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
