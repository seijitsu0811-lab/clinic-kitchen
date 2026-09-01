// app.js 的匯出清單裡，每一個名字都必須真的有定義。
//
// 這支是踩到之後才加的：改寫 renderForecast 時把 setPlanOverride 與
// clearPlanOverride 一起刪掉了，但匯出清單還留著那兩個名字。
// 結果整個 IIFE 在建立回傳物件時就 ReferenceError，App 這個 const
// 停在 TDZ —— 畫面上每一個 onclick 都變成「App is not defined」。
//
// 語法檢查（node --check）過得了，因為那是執行期才炸的。
// 而且 App 是 const 不是 window 屬性，用 typeof window.App 也驗不出來。
import fs from 'node:fs';

const src = fs.readFileSync('public/app.js', 'utf8');

// 取最後一個 return { ... }; —— 那是 IIFE 的匯出
const start = src.lastIndexOf('\n  return {');
const end   = src.indexOf('\n  };', start);
if (start < 0 || end < 0) {
  console.error('✗ 找不到匯出區塊，這支檢查失效了 —— 修好它，不要拿掉');
  process.exit(1);
}
const block = src.slice(start, end);

// 只取 `name,` 或 `name: xxx` 這種鍵
const names = [...new Set(
  block.split('\n').slice(1)
    .flatMap(l => l.split(','))
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => (x.includes(':') ? x.split(':')[0] : x).trim())
    .filter(x => /^[A-Za-z_$][\w$]*$/.test(x))
)];

const body = src.slice(0, start);
const missing = names.filter(n => {
  const re = new RegExp(`(?:async\\s+)?function\\s+${n}\\b|(?:const|let|var)\\s+${n}\\b`);
  return !re.test(body);
});

console.log(`匯出 ${names.length} 個名字`);
if (missing.length) {
  console.error('✗ 這些被匯出但找不到定義：' + missing.join('、'));
  console.error('  → App 會在建立時 ReferenceError，畫面上所有 onclick 都會失效');
  process.exit(1);
}
console.log('✓ 每一個都找得到定義');
