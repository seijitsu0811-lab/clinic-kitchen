import fs from 'node:fs';
let s = fs.readFileSync('public/app.js', 'utf8');
const R = [];

// 1) 批次成員晶片要顯示杯數。一個人點兩杯時，批次總數是 3 但只看到兩個名字，
//    對不起來，會讓人以為算錯
R.push([`            return \`<div class="bmember-chip\${picked ? ' picked' : ''}\${m.type === 'case' ? ' bmember-case' : ''}"
                         draggable="true"
                         ondragstart="App.batchDragStart(event,\${bi},'\${m.id}')"
                         ondragend="App.batchDragEnd()"
                         onclick="\${onclick}">
              \${esc(m.name)}\${picked ? ' ✓' : ''}
            </div>\`;`,
`            // 一個人點兩杯時，批次寫 3 杯但只看到兩個名字，對不起來。
            // 把杯數標在名字後面
            const cups = m.type === 'case' ? (m.cups || 1) : 1;
            return \`<div class="bmember-chip\${picked ? ' picked' : ''}\${m.type === 'case' ? ' bmember-case' : ''}"
                         draggable="true"
                         ondragstart="App.batchDragStart(event,\${bi},'\${m.id}')"
                         ondragend="App.batchDragEnd()"
                         onclick="\${onclick}">
              \${esc(m.name)}\${cups > 1 ? \` <b>×\${cups}</b>\` : ''}\${picked ? ' ✓' : ''}
            </div>\`;`]);

// 2) 個案晶片要能編輯。用員工配方的個案不會出現在時間軸（那裡才有編輯鈕），
//    所以只剩這張晶片，卻只能勾拿取 —— 時間和內容都改不了
R.push([`      return \`<div class="case-chip \${cls}" data-type="\${type}" data-inuse="\${isInuse?1:0}"
                   onclick="App.toggleCasePickup(\${c.id})">
        <div class="sname">\${esc(name)}\${needsTap ? ' ⚠' : (delivered ? '' : ' 未出餐')}</div>
        <div class="chip-sub">\${isInuse ? '🍽 內用精力湯' : ''}\${sub}</div>
      </div>\`;`,
`      // 用員工配方的個案不會出現在出餐時間軸（那裡有編輯鈕），
      // 所以編輯的入口只能放在這裡，否則時間和內容都改不了
      return \`<div class="case-chip \${cls}" data-type="\${type}" data-inuse="\${isInuse?1:0}"
                   onclick="App.toggleCasePickup(\${c.id})">
        <button class="chip-edit" title="編輯這筆出單"
                onclick="event.stopPropagation();App.openEditCase(\${c.id})">✎</button>
        <div class="sname">\${esc(name)}\${c.cups > 1 ? \` ×\${c.cups}\` : ''}\${
          needsTap ? ' ⚠' : (delivered ? '' : ' 未出餐')}</div>
        <div class="chip-sub">\${isInuse ? '🍽 內用精力湯' : ''}\${sub}</div>
      </div>\`;`]);

// 3) 現打晶片的說明也要帶杯數
R.push([`      const sub = type === 'fresh'
        ? \`\${esc(c.rx_name)}\${mt ? ' · ' + mt : ''}\``,
`      const sub = type === 'fresh'
        ? \`\${esc(c.rx_name)} \${c.cups}杯\${mt ? ' · ' + mt : ''}\``]);

let n = 0;
for (const [o, v] of R) {
  if (!s.includes(o)) { console.error('✗ 找不到：', o.slice(0, 60).replace(/\n/g, ' ')); process.exit(1); }
  s = s.replace(o, v); n++;
}
fs.writeFileSync('public/app.js', s);
console.log('✓ 前端修正 ' + n + ' 處');
