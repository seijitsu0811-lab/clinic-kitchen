// 預約系統帶入出單
//
//   這一組原本要「今天剛好有從預約帶進來的單」才跑得起來，沒有就整組略過
//   然後回報通過 —— 通過 0 項的測試等於沒有測試，而它守的又正是最會出事的
//   那條路：8/29 預約系統改成要憑證，廚房收到 401 卻靜默當成「今天沒預約」。
//
//   現在自己架一個假的預約來源，配一個乾淨的資料庫，把真正的同步邏輯跑一遍。
//   正式環境不必開任何後門 —— APPTS_URL 與 DB_PATH 本來就是環境變數。
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const line = s => console.log(s);
const check = (n, c, d = '') => { c ? (pass++, line(`  ✓ ${n}${d ? '  ' + d : ''}`))
                                   : (fail++, line(`  ✗ ${n}${d ? '  ' + d : ''}`)); };

const REPO  = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB    = path.join(os.tmpdir(), `zz-appt-${Date.now()}.db`);
const KPORT = 3997;

// ── 假的預約來源 ────────────────────────────────────────────
let apptPayload = {};
let stubStatus = 200;
const stub = http.createServer((req, res) => {
  res.writeHead(stubStatus, { 'content-type': 'application/json' });
  // 401 回的是合法 JSON，這正是當初被當成正常資料收下的形狀
  res.end(JSON.stringify(stubStatus === 200 ? apptPayload : { error: 'Permission denied' }));
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
const STUB_URL = `http://127.0.0.1:${stub.address().port}/appts.json`;

// ── 廚房伺服器：指到假來源、用一個乾淨資料庫 ────────────────
let child = null;
const startKitchen = async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: REPO, stdio: 'ignore',
    env: { ...process.env, PORT: String(KPORT), DB_PATH: DB, APPTS_URL: STUB_URL }
  });
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const r = await fetch(`http://127.0.0.1:${KPORT}/api/ingredients`,
        { headers: { 'X-Kitchen-User-Id': '1' } });
      if (r.ok) return true;
    } catch (e) { /* 還沒起來 */ }
  }
  return false;
};
const stopKitchen = async () => {
  if (!child) return;
  child.kill();
  child = null;
  await new Promise(r => setTimeout(r, 700));
};

const H = { 'X-Kitchen-User-Id': '1', 'Content-Type': 'application/json' };
const api = async (p, m = 'GET', b = null) => {
  const r = await fetch(`http://127.0.0.1:${KPORT}` + p,
    { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${m} ${p} → ${r.status}: ${t.slice(0, 160)}`);
  return t ? JSON.parse(t) : null;
};
// /api/today 會觸發同步。預約資料有 2 分鐘快取，所以每一階段都重開一次伺服器
const syncAndRead = async () => {
  const t = await api('/api/today');
  return { day: t, cases: (t.products[0].cases || []).filter(c => c.source_key) };
};

const cleanup = async () => {
  await stopKitchen();
  try { stub.close(); } catch (e) {}
  for (const f of [DB, DB + '-wal', DB + '-shm']) {
    try { fs.rmSync(f, { force: true }); } catch (e) {}
  }
};
process.on('exit', () => { try { child && child.kill(); } catch (e) {} });

try {
  const today = new Date().toISOString().slice(0, 10);

  line('\n━━ 1. 預約帶進來 ━━');
  apptPayload = { [today]: [
    // 預約系統是用「重複列出同一個項目」表達數量的：這是兩杯內用
    { id: 'ZZ1', name: 'ZZ 測試甲', start: '10:30',
      items: ['內用精力湯', '內用精力湯'], note: '先.BIPAP\n後.精力湯' },
    { id: 'ZZ2', name: 'ZZ 測試乙', start: '14:00', items: ['全配方精力湯'], note: '' }
  ] };
  // 這一行同時守住「全新資料庫開得起來」：建表順序錯了（ALTER 或種子函式
  // 跑在 CREATE TABLE 之前）伺服器就起不來，而既有資料庫完全看不出來 ——
  // 真正會踩到的時機是 Railway 磁碟重置或新機器裝起來，也就是最不能掛的時候
  check('全新資料庫上，伺服器起得來', await startKitchen(),
        '起不來的話下面整組都跑不了 —— 先看 server.js 的建表順序');

  let { day, cases } = await syncAndRead();
  check('預約讀得到，沒有靜默失敗',
        !!day.appt_sync && day.appt_sync.ok !== false,
        day.appt_sync ? (day.appt_sync.error || '正常') : '（沒有回報狀態）');
  check('兩筆預約都帶進來了', cases.length === 2, `${cases.length} 筆`);

  const a = cases.find(c => c.patient_name === 'ZZ 測試甲');
  check('重複列出的項目要算成杯數，不是一杯', !!a && a.cups === 2,
        a ? `${a.cups} 杯` : '找不到');
  check('取餐時間照預約', !!a && a.meal_time === '1030', a && a.meal_time);
  check('預約備註帶進來，沒被固定字串蓋掉',
        !!a && /BIPAP/.test(a.notes || ''), a && a.notes);
  check('也記著預約當下的時間', !!a && a.appt_meal_time === '1030', a && a.appt_meal_time);

  line('\n━━ 2. 預約改時間，沒被廚房改過的要跟著走 ━━');
  await stopKitchen();
  apptPayload[today][0].start = '11:45';
  check('重開後接上同一個資料庫', await startKitchen());
  ({ cases } = await syncAndRead());
  const a2 = cases.find(c => c.patient_name === 'ZZ 測試甲');
  check('時間跟著預約更新', !!a2 && a2.meal_time === '1145',
        a2 ? `1030 → ${a2.meal_time}` : '找不到');
  check('不會變成兩筆', cases.filter(c => c.patient_name === 'ZZ 測試甲').length === 1);

  line('\n━━ 3. 廚房改過的不能被同步蓋回去 ━━');
  await api('/api/today/cases/' + a2.id, 'PUT', {
    prescription_id: a2.prescription_id, cups: a2.cups, meal_time: '1655',
    powder_type: a2.powder_type, patient_name: a2.patient_name, notes: 'ZZ 手動改過'
  });
  await stopKitchen();
  apptPayload[today][0].start = '09:00';          // 預約又改了一次
  await startKitchen();
  ({ cases } = await syncAndRead());
  const a3 = cases.find(c => c.id === a2.id);
  check('手動設定的時間沒被蓋回去', !!a3 && a3.meal_time === '1655',
        a3 && `預約改成 0900，實際仍是 ${a3.meal_time}`);
  check('標記成 manual', !!a3 && a3.sync_source === 'manual', a3 && a3.sync_source);
  check('預約時間仍持續更新，差異才標得出來',
        !!a3 && a3.appt_meal_time === '0900',
        a3 && `預約 ${a3.appt_meal_time}／實際 ${a3.meal_time}`);
  check('手動寫的備註沒被蓋掉', !!a3 && a3.notes === 'ZZ 手動改過', a3 && a3.notes);

  line('\n━━ 4. 預約取消了，要標記而不是直接刪 ━━');
  await stopKitchen();
  apptPayload = { [today]: [apptPayload[today][1]] };   // 甲的預約沒了
  await startKitchen();
  ({ cases } = await syncAndRead());
  const a4 = cases.find(c => c.id === a2.id);
  check('單還在，沒有被自動刪掉', !!a4,
        '一次抓取失敗就刪掉當天的單，代價太大');
  check('標記成「預約已不存在」', !!a4 && a4.appt_missing === 1, a4 && String(a4.appt_missing));
  check('其他人的單不受影響',
        cases.some(c => c.patient_name === 'ZZ 測試乙' && !c.appt_missing));

  line('\n━━ 5. 回 401 時不能靜默當成「今天沒預約」━━');
  // 8/29 真的發生過：權限改成要憑證，廚房回報「同步成功、0 筆」，
  // 現場以為是自己忘了 key，整天改成手動建單
  await stopKitchen();
  stubStatus = 401;
  await startKitchen();
  const d5 = await api('/api/today');
  check('狀態回報成失敗', !!d5.appt_sync && d5.appt_sync.ok === false,
        d5.appt_sync ? String(d5.appt_sync.error).slice(0, 60) : '（沒有回報）');
  check('已經帶進來的單沒有被當成「預約取消」清掉',
        (d5.products[0].cases || []).filter(c => c.source_key).length >= 2,
        '抓不到資料的日期不能當作預約沒了');
  stubStatus = 200;

  line('\n━━ 6. 收乾淨 ━━');
  await cleanup();
  check('暫存資料庫已刪除', !fs.existsSync(DB), DB);
} catch (e) {
  fail++;
  line('  ✗ 測試中斷：' + e.message);
  await cleanup();
}

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
