// 「備品還剩幾份」只能有一個答案
//
//   備料狀態頁說剩 10 份，逐日預測同一天卻說剩 0 份、還要再備 5 樣。
//   原因是同一天的用量被扣了兩次：packStatus 的 remaining 是「到 asOf 為止
//   （含當天）用完之後」的數字，逐日預測拿它當起點，又從今天扣一次。
//
//   後果是叫人去做已經做好的東西 —— 而備料會扣原料，做兩次就扣兩次。
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

const today = new Date().toISOString().slice(0, 10);
const status = () => api('/api/prep/status');
const fc = (d = 3) => api('/api/inventory/forecast?days=' + d);

// 今天有幾杯吃方案（那幾杯才會消耗備品）
const day0 = (await fc()).days[0];
const planCups = day0.cups;

line('\n━━ 1. 備一批，兩邊要說同一個數字 ━━');
const before = await status();
const SERVINGS = Math.max(20, Math.ceil(planCups) + 10);
let batchId = null;
try {
  const r = await api('/api/prep/batch', 'POST', { group: '主方案', servings: SERVINGS, note: 'ZZ 備品計數測試' });
  batchId = r.id || (r.status && r.status.batches && r.status.batches.slice(-1)[0] || {}).id;
} catch (e) {
  line('  － 備料建不起來（' + e.message.slice(0, 60) + '），這組略過');
}

if (batchId) {
  const st = await status();
  const f = await fc();
  const d0 = f.days[0];
  check('狀態頁記到這一批', st.made - before.made === SERVINGS,
        `${before.made} → ${st.made} 份`);
  check('狀態頁與預測第一天的剩餘一致',
        Math.abs(st.remaining - d0.packs_left) < 0.05,
        `狀態頁 ${st.remaining} 份／預測 ${d0.packs_left} 份` +
        (Math.abs(st.remaining - d0.packs_left) < 0.05
          ? '' : ' ★ 同一天被扣兩次，會叫人重做已經做好的備料'));

  line('\n━━ 2. 備得夠就不該再叫人備料 ━━');
  const packShort = d0.short.filter(x => x.from_pack);
  check('備品夠時，冷凍包那幾樣不列缺料',
        SERVINGS >= planCups ? packShort.length === 0 : true,
        packShort.length
          ? '仍列 ' + packShort.map(x => x.name).join('、')
          : `做了 ${SERVINGS} 份、今天要 ${planCups} 杯`);

  line('\n━━ 3. 備品用完了才該再備 ━━');
  // 往後看到備品被吃完的那一天，那天之後才該出現冷凍包缺料
  const f7 = await fc(14);
  const firstPackShort = f7.days.find(d => d.short.some(x => x.from_pack));
  const runOut = f7.days.find(d => d.packs_left <= 0 && d.cups > 0);
  check('冷凍包缺料不會早於備品用完',
        !firstPackShort || !runOut || firstPackShort.date >= runOut.date,
        firstPackShort
          ? `${firstPackShort.date} 開始缺（備品在 ${runOut ? runOut.date : '—'} 用完）`
          : '預測範圍內都夠');

  line('\n━━ 4. 還原 ━━');
  await api(`/api/prep/batch/${batchId}/reverse`, 'POST', {});
  const back = await status();
  check('還原後回到測試前', back.made === before.made,
        `${st.made} → ${back.made} 份`);
}

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
