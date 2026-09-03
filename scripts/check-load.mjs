// app.js 要能「載入得起來」，不只是語法正確。
//
//   2026-09-03 一次補丁把整段程式碼塞到檔案第 3 行（indexOf 抓錯位置），
//   於是 IIFE 一開始就 `ReferenceError: day is not defined`。
//   node --check 過、匯出檢查過、呼叫檢查也過 —— 因為那三支都不執行程式碼。
//   線上整個系統掛掉，每一顆按鈕都變成 App is not defined。
//
//   這支真的把 app.js 跑一遍（給假的 document/window），
//   只要 IIFE 頂層有任何東西炸掉，就會在部署前被抓到。
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync('public/app.js', 'utf8');

// 假的瀏覽器：什麼都回一個空殼，讓頂層跑得完
const el = new Proxy({}, {
  get: (t, k) => {
    if (k === 'style' || k === 'dataset' || k === 'classList') return el;
    if (k === 'value' || k === 'textContent' || k === 'innerHTML' || k === 'className') return '';
    if (k === 'length') return 0;
    if (k === Symbol.iterator) return [][Symbol.iterator].bind([]);
    if (typeof k === 'symbol') return undefined;
    return () => el;
  },
  set: () => true
});

const doc = {
  getElementById: () => el, querySelector: () => el, querySelectorAll: () => [],
  createElement: () => el, addEventListener: () => {}, removeEventListener: () => {},
  body: el, documentElement: el, head: el, readyState: 'complete', cookie: ''
};

const store = { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} };

const sandbox = {
  document: doc, localStorage: store, sessionStorage: store,
  console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
  // 永遠不 resolve：我們只驗頂層載得起來，不要讓非同步流程繼續跑下去
  fetch: () => new Promise(() => {}),
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame: () => 0, alert: () => {}, confirm: () => true, prompt: () => '',
  location: { href: '', reload() {}, search: '', pathname: '/' },
  navigator: { userAgent: 'node', language: 'zh-TW' },
  history: { pushState() {}, replaceState() {} },
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  URLSearchParams, URL, FormData: class {}, Intl,
};
sandbox.addEventListener = () => {};
sandbox.removeEventListener = () => {};
sandbox.dispatchEvent = () => true;
sandbox.scrollTo = () => {};
sandbox.getComputedStyle = () => ({ getPropertyValue: () => '' });
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

try {
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'app.js', timeout: 10000 });
} catch (e) {
  console.error('✗ app.js 載入就爆了：' + e.message);
  const at = String(e.stack || '').split('\n')[1];
  if (at) console.error('  ' + at.trim());
  console.error('  這代表線上每一顆按鈕都會變成「App is not defined」。');
  process.exit(1);
}

// IIFE 的回傳值指派給 const App —— 沙箱裡拿不到 const，
// 但只要上面沒丟例外，就表示回傳物件建得起來
console.log('✓ app.js 載入得起來（IIFE 頂層沒有炸掉）');
process.exit(0);   // 別讓沙箱裡殘留的非同步工作把離開碼弄髒
