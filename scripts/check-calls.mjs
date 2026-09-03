// app.js 裡呼叫的每一個函式，都必須真的有定義。
//
// check-exports 只擋得住「匯出的名字沒定義」。這支擋的是另一半：
// saveShortagePurchase 裡呼叫了 toast()，但這個檔案從頭到尾用的是 alert。
// node --check 過得了（執行期才炸），匯出檢查也過得了 ——
// 一直到使用者按下「登記進貨」那一刻才爆，而那時東西已經上線了。
import fs from 'node:fs';

const src = fs.readFileSync('public/app.js', 'utf8');

const GLOBALS = new Set([
  // 語言內建
  'Array', 'Object', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date', 'Intl',
  'Promise', 'Set', 'Map', 'WeakMap', 'WeakSet', 'RegExp', 'Error', 'Symbol', 'BigInt',
  'Proxy', 'Reflect', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'eval',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'structuredClone',
  // 瀏覽器
  'alert', 'confirm', 'prompt', 'fetch', 'setTimeout', 'setInterval',
  'clearTimeout', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
  'addEventListener', 'removeEventListener', 'getComputedStyle', 'matchMedia',
  'FormData', 'URLSearchParams', 'URL', 'Blob', 'File', 'FileReader', 'Image', 'Audio',
  'Headers', 'Request', 'Response', 'TextEncoder', 'TextDecoder', 'AbortController',
  'IntersectionObserver', 'MutationObserver', 'ResizeObserver', 'CustomEvent', 'Event',
  'Notification', 'print', 'open', 'close', 'scrollTo', 'postMessage', 'btoa', 'atob',
  'queueMicrotask', 'reportError',
  // 關鍵字，後面接括號長得像呼叫
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await',
  'new', 'delete', 'void', 'do', 'else', 'case', 'in', 'of', 'instanceof', 'yield',
  'throw', 'with', 'import', 'super'
]);

// 註解裡提到某個函式名不是呼叫（「和伺服器的 boxesForOrder() 是同一條規則」），
// 樣式字串裡的 var()／rgba()／repeat() 也不是。先把這些拿掉再掃
const CSS_FN = /\b(var|rgba?|hsla?|calc|repeat|minmax|translate[XYZ]?|translate3d|scale|rotate|skew|blur|brightness|url|clamp|linear-gradient|radial-gradient|conic-gradient|cubic-bezier|steps|env|attr|counter)\s*\(/g;

const scan = src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')        // 區塊註解
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')     // 行註解（避開 https://）
  .replace(CSS_FN, ' 0(');   // 換成不可能是識別字的東西，才不會把「1px solid var(…)」的 solid 當成呼叫

// 有定義的名字
const defs = new Set();
const each = (re, fn) => { for (const m of src.matchAll(re)) fn(m); };
const params = str => str.split(',').forEach(x => {
  const n = x.split('=')[0].trim().replace(/^\.\.\./, '');
  if (/^[A-Za-z_$][\w$]*$/.test(n)) defs.add(n);
});

each(/\bfunction\s+([A-Za-z_$][\w$]*)/g, m => defs.add(m[1]));
each(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g, m => defs.add(m[1]));
each(/\b(?:const|let|var)\s*\{([^}]*)\}/g, m => m[1].split(',').forEach(x => {
  const n = x.split(':').pop().split('=')[0].trim();
  if (/^[A-Za-z_$][\w$]*$/.test(n)) defs.add(n);
}));
each(/\(([^()]*)\)\s*=>/g, m => params(m[1]));
each(/\bfunction\s*[A-Za-z_$\w]*\s*\(([^()]*)\)/g, m => params(m[1]));
each(/([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function|\()/g, m => defs.add(m[1]));

// 裸呼叫：前面不是點、不是引號、不是識別字的一部分
const BARE = /(^|[^.\w$'"`])([A-Za-z_$][\w$]*)\s*\(/gm;
const called = new Set();
for (const m of scan.matchAll(BARE)) called.add(m[2]);

const bad = [...called].filter(n => !defs.has(n) && !GLOBALS.has(n)).sort();

if (bad.length) {
  console.error('✗ 呼叫了不存在的函式：' + bad.join('、'));
  console.error('  這種錯不會在部署時被發現 —— 使用者按下那顆按鈕才會爆。');
  process.exit(1);
}
console.log(`✓ ${called.size} 個呼叫，每一個都找得到定義`);
