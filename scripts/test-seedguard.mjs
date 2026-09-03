// schema.sql 的處方用料種子，只能在全新資料庫跑
//
//   schema.sql 每次開機都重跑。INSERT OR IGNORE 只擋得住「同一行已經存在」，
//   擋不住「被刻意刪掉」。2026-09 把 AW 的蔬果移到方案層之後，下一次部署
//   就把 7 樣蔬果種回 RX-01 —— 而個人用料會蓋過方案，於是他的檸檬一直是
//   30g 而不是方案的 10g，還多了方案裡沒有的木瓜 30g。
//
//   回填不留任何紀錄：翻配方異動歷史也查不到，因為它沒走 API。
//
//   這一組不打伺服器，直接開兩個暫存資料庫驗：
//     全新的 → 種子要種進去（不然新機器裝起來是空的）
//     已經在用的 → 刪掉的那一行不能被種回來
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let pass = 0, fail = 0;
const line = s => console.log(s);
const check = (n, c, d = '') => { c ? (pass++, line(`  ✓ ${n}${d ? '  ' + d : ''}`))
                                   : (fail++, line(`  ✗ ${n}${d ? '  ' + d : ''}`)); };

const SCHEMA = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const tmp = n => path.join(os.tmpdir(), `zz-seed-${n}-${Date.now()}.db`);

// server.js 開機時做的事：已經有用料就先立旗子
const boot = db => {
  try {
    const s = db.prepare('SELECT COUNT(*) c FROM prescription_ingredients').get();
    if (s && s.c > 0)
      db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('rx_ingredients_seeded','1')").run();
  } catch (e) {}
  db.exec(SCHEMA);
};

const countOf = (db, code) => db.prepare(
  `SELECT COUNT(*) c FROM prescription_ingredients
    WHERE prescription_id=(SELECT id FROM prescriptions WHERE code=?)`).get(code).c;

line('\n━━ 1. 全新資料庫：種子要種進去 ━━');
const f1 = tmp('fresh');
const fresh = new DatabaseSync(f1);
boot(fresh);
const n1 = countOf(fresh, 'RX-01');
check('新資料庫的 RX-01 有用料', n1 > 0, `${n1} 樣`);
check('旗子立起來了',
      !!fresh.prepare("SELECT 1 FROM settings WHERE key='rx_ingredients_seeded'").get(),
      '不然下次開機又會種一次');

line('\n━━ 2. 同一個資料庫再開機一次：不能變多 ━━');
boot(fresh);
check('用料數量沒有變', countOf(fresh, 'RX-01') === n1, `${n1} → ${countOf(fresh, 'RX-01')}`);

line('\n━━ 3. 刻意刪掉一行，重開機不能種回來 ━━');
// 這就是 AW 那件事：蔬果移到方案層＝把個人身上的那幾行刪掉
const lemon = fresh.prepare("SELECT id FROM ingredients WHERE name='檸檬'").get();
fresh.prepare(
  `DELETE FROM prescription_ingredients
    WHERE prescription_id=(SELECT id FROM prescriptions WHERE code='RX-01') AND ingredient_id=?`
).run(lemon.id);
const afterDel = countOf(fresh, 'RX-01');
check('刪掉之後真的少一行', afterDel === n1 - 1, `${n1} → ${afterDel}`);

boot(fresh);
const back = fresh.prepare(
  `SELECT 1 FROM prescription_ingredients
    WHERE prescription_id=(SELECT id FROM prescriptions WHERE code='RX-01') AND ingredient_id=?`
).get(lemon.id);
check('重開機沒有把它種回來', !back,
      back ? '★ 又被種回來了 —— 刪掉的用料會在下一次部署自己長回來'
           : `仍然是 ${countOf(fresh, 'RX-01')} 樣`);
fresh.close();
fs.rmSync(f1, { force: true });

line('\n━━ 4. 舊資料庫（旗子還沒立）也要擋得住 ━━');
// 現有的正式資料庫就是這種：已經有用料，但從來沒有這個 key
const f2 = tmp('legacy');
const legacy = new DatabaseSync(f2);
legacy.exec(SCHEMA);                                    // 當作它當初是這樣建起來的
legacy.prepare("DELETE FROM settings WHERE key='rx_ingredients_seeded'").run();
const apple = legacy.prepare("SELECT id FROM ingredients WHERE name='蘋果'").get();
legacy.prepare(
  `DELETE FROM prescription_ingredients
    WHERE prescription_id=(SELECT id FROM prescriptions WHERE code='RX-01') AND ingredient_id=?`
).run(apple.id);
boot(legacy);
const back2 = legacy.prepare(
  `SELECT 1 FROM prescription_ingredients
    WHERE prescription_id=(SELECT id FROM prescriptions WHERE code='RX-01') AND ingredient_id=?`
).get(apple.id);
check('沒有旗子的舊資料庫，開機時會自己補上', !back2,
      back2 ? '★ 種回來了' : '刪掉的沒有回來');
legacy.close();
fs.rmSync(f2, { force: true });

line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
