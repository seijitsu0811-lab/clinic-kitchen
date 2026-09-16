// 個管師先選好一家，再把手機遞過去
//
//   現場的做法是一次只給客人看一家餐廳的三個選項。原本客人模式是
//   「自己挑一家 → 看那一家」，畫面上還留著「← 換一間」和
//   「← 回個管師檢視」—— 手機遞出去之後，客人一按就看到全部四家。
//
//   鎖定（series=<id>&lock=1）把那兩條退路關掉。這支測試就是確認
//   鎖真的鎖得住 —— 鎖不住的話這個功能等於沒做，而且沒有人會發現，
//   因為畫面第一眼看起來是對的。
//
//   另外驗加菜：阿北那一家只有 1 道主餐＋1 道加菜（燙青菜）。
//   算成兩道會讓「一家三個選項」那張卡寫錯數字，而且客人會以為
//   燙青菜是第三個選項。
const B = 'http://localhost:3999';
const H = { 'X-Kitchen-User-Id': '1', 'Content-Type': 'application/json' };
const api = async (p, m = 'GET', b = null) => {
  const r = await fetch(B + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${m} ${p} → ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};
const page = async q => {
  const r = await fetch(B + '/menu.html' + q, { headers: H });
  return await r.text();
};

let pass = 0, fail = 0;
const line = s => console.log(s);
const check = (n, c, d = '') => { c ? (pass++, line(`  ✓ ${n}${d ? '  ' + d : ''}`))
                                   : (fail++, line(`  ✗ ${n}${d ? '  ' + d : ''}`)); };

const menu = await api('/api/meals/menu/case');
check('前置：抓得到給客人看的菜單', (menu.series || []).length > 0,
      `${menu.series.length} 個系列`);

line('\n━━ 1. 加菜不算一道主餐 ━━');
{
  check('每一道都帶得出品項類型',
        menu.series.every(s => s.items.every(i => typeof i.item_type === 'string')),
        menu.series.flatMap(s => s.items).length + ' 道');

  const withExtra = menu.series.filter(s => s.items.some(i => i.item_type === '加菜'));
  check('找得到有加菜的那一家', withExtra.length > 0,
        withExtra.map(s => s.name).join('、') || '★ 沒有加菜品項，這一組測不出東西');
  if (withExtra.length) {
    const s = withExtra[0];
    const mains = s.items.filter(i => i.item_type !== '加菜');
    const extras = s.items.filter(i => i.item_type === '加菜');
    check('主餐與加菜分得開', mains.length > 0 && extras.length > 0,
          `${s.name}：主餐 ${mains.length} 道、加菜 ${extras.length} 樣（${extras.map(i => i.name).join('、')}）`);
  }

  // 客人菜單絕不能出現店名、店家品項名或價格
  const txt = JSON.stringify(menu);
  const leaks = ['蛋白盒子', '樂芙', '七福', '大鼎', '樂坡', 'vendor', 'price']
    .filter(k => txt.includes(k));
  check('沒有外洩店名或價格', leaks.length === 0,
        leaks.length ? '★ 出現了：' + leaks.join('、') : '乾淨');
}

line('\n━━ 2. 鎖定之後不能有退路 ━━');
// 這是整支測試的重點。那兩顆按鈕是漏洞 ——
// 手機遞出去，客人一按就看到全部四家
{
  const target = menu.series[0];
  const html = await page('?mode=guest&series=' + target.id + '&lock=1');
  check('頁面載得到', html.includes('調理套餐菜單'), html.length + ' bytes');
  // 鎖定是由 URL 參數決定的，所以驗程式裡真的有讀它
  check('程式讀得到 series 與 lock',
        html.includes("Number(qs.get('series'))") && html.includes("qs.get('lock') === '1'"),
        '兩個參數都有讀');
  check('鎖定時強制客人模式', html.includes('if (locked) mode = \'guest\';'),
        '個管師檢視不會出現在遞出去的那一份');
  // 兩條退路都必須掛在 !locked 之下
  const unpickGuarded = /locked \? '' : `<button class="back" onclick="window.__unpick\(\)">/.test(html);
  const staffGuarded  = /locked \? '' : `<button class="back" onclick="window.__staff\(\)">/.test(html);
  check('「換一間」掛在鎖定判斷之下', unpickGuarded,
        unpickGuarded ? '' : '★ 沒有守住，客人按得到');
  check('「回個管師檢視」也掛在鎖定判斷之下', staffGuarded,
        staffGuarded ? '' : '★ 沒有守住，客人按得到');
}

line('\n━━ 3. 沒鎖的時候退路要留著 ━━');
// 個管師自己看的時候需要那兩顆按鈕。鎖定不能把它們永久拿掉
{
  const html = await page('?mode=guest');
  check('沒帶參數時 locked 為假',
        html.includes("const locked = lockedSeries != null && qs.get('lock') === '1';"),
        '要 series 與 lock 同時出現才算鎖定');
  const html2 = await page('?mode=guest&series=' + menu.series[0].id);
  check('只給 series、沒給 lock，仍然可以換一間',
        html2 === html || html2.includes('__unpick'),
        '只指定看哪一家，不等於鎖住');
}

line('\n━━ 4. 鎖定的那一家要真的存在 ━━');
{
  const html = await page('?mode=guest&series=999999&lock=1');
  check('指到不存在的系列不會整頁爆掉', html.includes('調理套餐菜單'),
        'render 裡 s 可能是 undefined，要撐得住');
  check('程式有對 s 做防護', html.includes('(s ? seriesHtml(s) : \'\')'),
        '找不到那一家就顯示空的，不是丟例外');
}

line('\n━━ 5. 挑店選單算的是主餐數 ━━');
{
  const app = await (await fetch(B + '/app.js', { headers: H })).text();
  check('選單的道數排除加菜',
        app.includes("(s.items || []).filter(i => i.item_type !== '加菜').length"),
        '阿北那一家要寫「1 道」，不是「2 道」');
  check('鎖定會帶進 iframe 的網址',
        app.includes("'&series=' + encodeURIComponent(lockTo) + '&lock=1'"),
        '嵌在套餐頁裡那一份');
  check('開新視窗也會帶鎖定',
        app.includes("'&series=' + encodeURIComponent(sr.value) + '&lock=1'"),
        '遞出去的那台裝置才是真正要鎖的');
}
line('\n━━ 6. 店名只能出現在個管師那一面 ━━');
// 店名是個管師要的（他口頭說「這是蛋白盒子那家」，畫面上要對得上），
// 但客人那一支 API 從頭到尾不回傳 vendor —— 那是後端守的界線。
//
// 所以店名得從管理端那一支另外抓。而鎖定的那一份是遞到客人手上的：
// 資料一旦進了那個頁面的記憶體，界線就只剩「畫面上沒顯示」在守，那不算守。
// 這一組驗的是「鎖定時根本不去抓」，不是「抓了但沒顯示」。
{
  const html = await page('?mode=staff');
  check('個管師那一面會去抓店名',
        html.includes("await fetch('/api/meals/menu', { headers })"),
        '從管理端那一支拿');
  const guarded = /if \(!locked\) \{[\s\S]{0,400}?\/api\/meals\/menu'/.test(html);
  check('抓店名這件事掛在「沒鎖定」之下', guarded,
        guarded ? '鎖定的那一份不去抓 —— 資料不進頁面，才叫守住'
                : '★ 沒守住：店名會進到遞出去的那個頁面');
  check('還有第二道：客人模式一律不顯示店名',
        html.includes('body.guest .vendor { display: none; }'),
        'CSS 那一層擋，萬一哪天邏輯被改壞還有一層');
  check('店名只在個管師模式才渲染',
        html.includes("mode === 'staff' && vendorOf[s.id]"),
        '不是「抓了再用 CSS 藏起來」');

  // 客人那一支 API 仍然一家店名都不能有。test-casemenu 也在盯這件事，
  // 但鎖定這次動了那支 API 的回傳欄位（多了 item_type），所以再確認一次
  const blob = JSON.stringify(await api('/api/meals/menu/case'));
  const vendors = (await api('/api/meals/menu')).vendors.map(v => v.name);
  const leaked = vendors.filter(v => blob.includes(v));
  check('客人的資料裡一家店名都沒有', leaked.length === 0,
        leaked.join('、') || vendors.length + ' 家都沒出現');
}


line(`\n${'─'.repeat(48)}\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
