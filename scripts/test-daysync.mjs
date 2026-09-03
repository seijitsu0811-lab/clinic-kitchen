// 兩台裝置同時開著時，後存檔的不能蓋掉先存檔的
//
//   day_state 是「整包」存回伺服器的：載入時抓一份，之後每次改動都把整包
//   蓋上去。兩台手機同時開著就會變成「最後存檔的人贏」——
//
//   2026-09-03 現場就發生了：孟睿 10:58 把批次 1 的三個人標成未領，
//   11:56 Bonnie 的裝置存了一次（她那份是 10:30 載入的，沒有那三筆），
//   三個未領就這樣消失，而且兩邊都不會發現。
//
//   未領決定要扣多少庫存，無聲消失等於帳直接記錯。
//
//   這一組模擬兩台裝置，驗合併邏輯。合併是在前端做的，所以這裡直接把
//   同一套規則跑一遍 —— 前端改了規則、這裡沒跟著改，數字就會對不起來。
import fs from 'node:fs';
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

// ── 直接用 app.js 裡那一份合併規則 ──────────────────────────
//   在這裡另外抄一份的話，前端改了、測試沒跟著改，就會兩邊都「通過」
//   卻對不起來。所以把真正在跑的那段程式碼挖出來執行。
const APP = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const grab = (name, kind) => {
  const re = kind === 'fn'
    ? new RegExp('\\n\\s*function ' + name + '\\s*\\([\\s\\S]*?\\n  \\}', 'm')
    : new RegExp('\\n\\s*const ' + name + '\\s*=[\\s\\S]*?;', 'm');
  const m = APP.match(re);
  if (!m) { console.error('✗ 在 app.js 裡找不到 ' + name + ' —— 這支檢查失效了，修好它不要拿掉'); process.exit(1); }
  return m[0];
};
const mergeSrc = [
  grab('SET_KEYS'), grab('REPLACE_KEYS'), grab('_same'),
  grab('_mergeOnto', 'fn'),
  'return { _mergeOnto, SET_KEYS, REPLACE_KEYS, _same };'
].join('\n');
const real = new Function(mergeSrc)();
const mergeOnto = real._mergeOnto;
const same = real._same;

const today = new Date().toISOString().slice(0, 10);
const readState = async () => (await api('/api/today/state?date=' + today)).state || {};
const writeState = st => api('/api/today/state', 'PUT', { date: today, state: st });

const origWrap = await api('/api/today/state?date=' + today);
const orig = origWrap.state ? JSON.parse(JSON.stringify(origWrap.state)) : null;

const blank = { staff: [], cases: [], staffMissed: [], caseMissed: [],
                batchGroups: null, schOrder: null,
                deductedBatches: [], deductedCases: [], notes: {}, qc: {} };

// 一台裝置存檔＝先讀伺服器、把自己改的套上去、再寫回去
const deviceSave = async (base, mine) => {
  const server = await readState();
  const merged = mergeOnto(server, base, mine);
  await writeState(merged);
  return merged;
};

line('\n━━ 1. 現場那一次：A 標未領，B 後存檔 ━━');
await writeState(blank);
const baseA = await readState();          // 孟睿 10:00 載入
const baseB = JSON.parse(JSON.stringify(baseA));  // Bonnie 10:30 載入，內容一樣

// 孟睿把三個人標成未領
await deviceSave(baseA, { ...baseA, staffMissed: [101, 102, 103] });
check('A 標的未領存進去了', (await readState()).staffMissed.length === 3);

// Bonnie 後來動了別的東西（她手上那份沒有那三筆未領）
await deviceSave(baseB, { ...baseB, notes: { x: 'Bonnie 寫的備註' } });
const after = await readState();
check('B 存檔沒有蓋掉 A 標的未領',
      (after.staffMissed || []).length === 3,
      `staffMissed = [${after.staffMissed}]` +
      ((after.staffMissed || []).length === 3 ? '' : ' ★ 未領被抹掉了，庫存會扣錯'));
check('B 自己改的也有存進去', after.notes && after.notes.x === 'Bonnie 寫的備註');

line('\n━━ 2. 取消勾選要生效，不能被合併「救回來」━━');
// 合併不是無腦聯集：我把某個人從未領改回已出餐，那就該真的拿掉
const base2 = await readState();
await deviceSave(base2, { ...base2, staffMissed: [101, 103] });   // 把 102 改回已出餐
const after2 = await readState();
check('拿掉的那一個真的不見了',
      !(after2.staffMissed || []).includes(102) && (after2.staffMissed || []).length === 2,
      `staffMissed = [${after2.staffMissed}]`);

line('\n━━ 3. 兩台各標各的，兩邊都要留下 ━━');
await writeState({ ...blank });
const b3 = await readState();
const b3b = JSON.parse(JSON.stringify(b3));
await deviceSave(b3,  { ...b3,  staffMissed: [201] });
await deviceSave(b3b, { ...b3b, caseMissed:  [301] });
const after3 = await readState();
check('A 標的員工未領還在', (after3.staffMissed || []).includes(201),
      `staffMissed = [${after3.staffMissed}]`);
check('B 標的個案未出也在', (after3.caseMissed || []).includes(301),
      `caseMissed = [${after3.caseMissed}]`);

line('\n━━ 4. 已扣庫存的批次不能被蓋掉 ━━');
// 這個被蓋掉的後果更糟：同一批會被扣第二次
await writeState({ ...blank });
const b4 = await readState();
const b4b = JSON.parse(JSON.stringify(b4));
await deviceSave(b4, { ...b4, deductedBatches: ['s_1|s_2|s_3'] });
await deviceSave(b4b, { ...b4b, notes: { y: '1' } });
const after4 = await readState();
check('扣過的批次紀錄還在',
      (after4.deductedBatches || []).includes('s_1|s_2|s_3'),
      (after4.deductedBatches || []).includes('s_1|s_2|s_3')
        ? '' : '★ 這一批會被扣第二次');

line('\n━━ 5. 還原 ━━');
await writeState(orig || blank);
const back = await readState();
check('當天狀態還原', same(back, orig || blank) || !orig);

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
