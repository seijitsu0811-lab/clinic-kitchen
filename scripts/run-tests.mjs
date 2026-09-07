// 一次跑完所有測試，並且擋住「通過 0 項」這種假綠燈。
//
//   靠當天現場剛好有資料才跑得起來的測試，沒資料時會整組略過然後回報通過。
//   test-appt-sync 就這樣長期通過 0 項 —— 而它守的是最會出事的那條路。
//
//   規則：任何一支測試通過 0 項，一律視為失敗。要嘛自己造資料，要嘛刪掉。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(DIR).filter(f => /^test-.*\.mjs$/.test(f)).sort();
const CHECKS = ['check-load.mjs', 'check-calls.mjs', 'check-exports.mjs'];

let total = 0, failed = 0, empty = 0, broken = 0;
const rows = [];

for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(DIR, f)],
    { encoding: 'utf8', timeout: 300000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/通過 (\d+) 項，失敗 (\d+) 項/);
  const skipped = (out.match(/略過/g) || []).length;
  if (!m) {
    broken++;
    rows.push({ f, note: '✗ 跑不完（沒有輸出結果）', out: out.slice(-400) });
    continue;
  }
  const p = Number(m[1]), q = Number(m[2]);
  total += p; failed += q;
  let note = `${String(p).padStart(3)} 通過 / ${q} 失敗`;
  if (q > 0) note = '✗ ' + note;
  else if (p === 0) { empty++; note = '✗ ' + note + '　通過 0 項＝沒有測試'; }
  else if (skipped) note += `　（略過 ${skipped} 組）`;
  rows.push({ f, note, out: q > 0 ? out.split('\n').filter(l => l.includes('✗')).join('\n') : '' });
}

rows.forEach(r => {
  console.log(`  ${r.f.padEnd(26)}${r.note}`);
  if (r.out) console.log(r.out.split('\n').map(l => '      ' + l).join('\n'));
});

console.log('');
for (const c of CHECKS) {
  const r = spawnSync(process.execPath, [path.join(DIR, c)], { encoding: 'utf8' });
  const ok = r.status === 0;
  if (!ok) { broken++; console.log(`  ✗ ${c}\n${(r.stdout || r.stderr || '').trim()}`); }
  else console.log(`  ✓ ${c}`);
}

console.log('\n' + '─'.repeat(56));
console.log(`  合計通過 ${total} 項，失敗 ${failed} 項`);
if (empty)  console.log(`  ✗ 有 ${empty} 支測試通過 0 項 —— 那不是綠燈，是沒在測`);
if (broken) console.log(`  ✗ 有 ${broken} 支跑不完`);
process.exit(failed || empty || broken ? 1 : 0);
