// 休診日：廚房沒開的那天，不做也不扣
//
//   系統原本沒有「休診日」的概念。設定裡只有員工供應日與盤點日，
//   沒有任何地方記得哪天不開工 —— 所以預估、採購、排產一律假設
//   週一到週五都開工。中秋節那天照樣叫你買料。
//
//   但最會出事的是扣庫存那一條。expectedForDate 有一條退路：
//   「當天完全沒有人點過，就照出勤與出單補扣」。休診日這個條件一定成立
//   —— 廚房沒開，當然沒有人點 —— 所以每一個國定假日都會照樣扣掉
//   一整天的料，而且完全不會報錯，要到盤點才發現對不上。
const B = 'http://localhost:3999';
const H = { 'X-Kitchen-User-Id': '1', 'Content-Type': 'application/json' };
const api = async (p, m = 'GET', b = null) => {
  const r = await fetch(B + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${m} ${p} → ${r.status}: ${t.slice(0, 160)}`);
  return t ? JSON.parse(t) : null;
};
const tryApi = async (p, m, b) => {
  const r = await fetch(B + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  return { ok: r.ok, status: r.status, body: await r.text() };
};

let pass = 0, fail = 0;
const line = s => console.log(s);
const check = (n, c, d = '') => { c ? (pass++, line(`  ✓ ${n}${d ? '  ' + d : ''}`))
                                   : (fail++, line(`  ✗ ${n}${d ? '  ' + d : ''}`)); };

const DOW = ['日', '一', '二', '三', '四', '五', '六'];
const addDays = (d, n) =>
  new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const dowOf = d => new Date(d + 'T00:00:00').getDay();
const today = new Date().toISOString().slice(0, 10);

const cupsOf   = async d => (await api('/api/day/cups?date=' + d)).total_cups;
const expectOf = async d => (await api('/api/consumption/expected?date=' + d)).total_cups;

// 找一個未來、而且本來就有杯數的日子。挑不到就整組沒有意義 ——
// 在一個本來就 0 杯的日子上測「標了假日變 0 杯」等於沒測
let target = null, before = 0, beforeExp = 0;
for (let i = 2; i <= 21; i++) {
  const d = addDays(today, i);
  const c = await cupsOf(d);
  if (c > 0) { target = d; before = c; beforeExp = await expectOf(d); break; }
}
check('前置：找到一個本來有杯數的未來日期', !!target,
      target ? `${target} 週${DOW[dowOf(target)]}　排產 ${before} 杯／扣庫存 ${beforeExp} 杯`
             : '★ 未來三週都沒有杯數，這組測不出東西');
if (!target) { line(`\n通過 ${pass} 項，失敗 ${fail} 項`); process.exit(1); }

// 先清掉上一次跑到一半留下的
await fetch(B + '/api/closures/' + target, { method: 'DELETE', headers: H });

line('\n━━ 1. 標成休診日之後，那天不做也不扣 ━━');
await api('/api/closures', 'POST', { date: target, reason: '測試用' });
{
  const c = await cupsOf(target), e = await expectOf(target);
  check('排產變 0 杯', c === 0,
        `${before} → ${c} 杯` + (c === 0 ? '' : ' ★ 廚房沒開卻還在排產，缺料清單會叫你買料'));
  check('扣庫存也變 0 杯', e === 0,
        `${beforeExp} → ${e} 杯` +
        (e === 0 ? '' : ' ★ 這是最嚴重的一種：沒做卻扣料，盤點前查不出來'));
}

line('\n━━ 2. 預估裡那天要標出來，不能只是消失 ━━');
// 0 杯和「那天不開工」在畫面上長得一樣，但意思完全不同 ——
// 前者是今天剛好沒人訂，後者是不可能有人訂
{
  const f = await api('/api/inventory/forecast?days=21');
  const row = f.days.find(d => d.date === target);
  check('預估還是列得出那一天', !!row, row ? `${row.date} ${row.cups} 杯` : '★ 整天不見了');
  check('那一天不缺任何料', !row || !(row.short || []).length,
        row && (row.short || []).length ? '★ 還在報缺 ' + row.short.length + ' 項' : '沒有缺料');
}

line('\n━━ 3. 拿掉之後要回到原本的數字 ━━');
await api('/api/closures/' + target, 'DELETE');
{
  const c = await cupsOf(target), e = await expectOf(target);
  check('排產回來了', c === before, `${c} / ${before}`);
  check('扣庫存也回來了', e === beforeExp, `${e} / ${beforeExp}`);
}

line('\n━━ 4. 不能回頭改歷史 ━━');
// 已經過去的日子做了什麼已經記在消耗紀錄與盤點上了。
// 事後標成休診會讓帳面和實際各說一套，而且看不出來是誰改的
{
  const r = await tryApi('/api/closures', 'POST', { date: addDays(today, -3), reason: '測試' });
  check('過去的日期標不進去', !r.ok && r.status === 400, `HTTP ${r.status}`);
  const r2 = await tryApi('/api/closures', 'POST', { date: '9/25', reason: '測試' });
  check('日期格式擋得住', !r2.ok && r2.status === 400, `HTTP ${r2.status}`);
}

line('\n━━ 5. 收尾：沒有留下測試資料 ━━');
{
  const list = (await api('/api/closures')).closures;
  const left = list.filter(c => c.reason === '測試用');
  check('測試標的休診日已清掉', left.length === 0,
        left.map(c => c.date).join('、') || '沒有殘留');
}

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
