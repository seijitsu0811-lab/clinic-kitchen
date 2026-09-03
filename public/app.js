/* 診所廚房管理系統 v2 */

const App = (() => {
  let currentUser = null;
  let kitchenPassword = sessionStorage.getItem('kitchen_password') || '';
  let allIngredients = [];
  let allPrescriptions = [];
  let caseDataMap = {};
  let costMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
  let currentCostTab = 'today';
  let lastTodayData = null;
  let staffPickedUp = new Set();  // 只用在「需人工核對」的個案（有禁忌註記那種）
  let casePickedUp  = new Set();
  // 例外管理：排程上的預設是「已出餐」，這兩份記的是「沒發生」的那些。
  // 舊的 staffPickedUp/casePickedUp 保留不動，歷史資料才不會被誤讀
  let staffMissed   = new Set();  // 出席但沒領到的員工 userId
  let caseMissed    = new Set();  // 沒出餐的個案 caseId
  let staffBatchGroups = null; // [{size, members:[{id,name,type,userId?,caseId?}]}]
  let batchInitDate    = null; // prevent re-init within same day
  let schCustomOrder   = null; // [key,...] null=auto time-sort
  let schDragKey       = null;
  let batchDragSrc     = null;
  let _allMembersMap   = {}; // id → member, populated by _syncBatchGroups
  let empRxId          = null; // employee formula prescription id
  let deductedBatches  = new Set(); // 今日已扣庫存的批次（以成員組成為 key，不用位置編號）
  let deductedCases    = new Set(); // case ids already inventory-deducted today
  let restoredLeaves   = new Set(); // 休假卻仍出席者，由伺服器狀態推導
  let showPrepBatches  = false;     // 鮮食表的分批量預設收起（秤料看總量就夠）
  let showFutureCases  = false;     // 預約出單預設收起（那不是今天要做的事）
  let schFilter        = 'all';     // 出餐時間軸的篩選：all / tonic / meal
  let schMoreOpen      = new Set(); // 哪幾列展開了次要動作（配方／菜單／編輯）
  let dayNotes         = {};        // 每個產品的今日備料備註（跟著日期走，全廚房共用）
  let dayQc            = {};        // 今日品質確認清單（全廚房共用）

  const PTYPE_LABEL = { '袋裝': '袋裝基底粉', '罐裝': '罐裝基底粉', '全配方': '全配方精力湯', '內用': '內用精力湯' };
  function ptLabel(v) { return PTYPE_LABEL[v] || v || '袋裝基底粉'; }

  // ── 初始化 ─────────────────────────────────────────────
  async function init() {
    const saved = localStorage.getItem('kitchen_user');
    if (saved) {
      try { currentUser = JSON.parse(saved); showMain(); return; } catch(e) {}
    }
    showUserSelect();
  }

  async function showUserSelect() {
    document.getElementById('screen-user').style.display = 'flex';
    document.getElementById('screen-main').style.display = 'none';
    const users = await publicApi('/api/public/users');
    const grid = document.getElementById('userGrid');
    grid.innerHTML = users.map(u => `
      <div class="user-card" onclick="App.selectUser(${u.id},'${esc(u.name)}',${u.requires_password ? 'true' : 'false'})">
        <div class="avatar">${u.name[0]}</div>
        <div class="uname">${esc(u.name)}</div>
      </div>
    `).join('') + `
      <div class="btn-add-user" onclick="App.openAddUser()">
        <div class="avatar" style="background:var(--bg);color:var(--blue)">＋</div>
        新增人員
      </div>`;
  }

  async function selectUser(id, name, requiresPassword = false) {
    try {
      currentUser = { id, name, requires_password: !!requiresPassword };
      if (currentUser.requires_password) ensureKitchenPassword(true, name);
      await api('/api/users');
      localStorage.setItem('kitchen_user', JSON.stringify(currentUser));
      showMain();
    } catch (e) {
      currentUser = null;
      alert(e.message || '密碼驗證失敗');
    }
  }

  function showMain() {
    document.getElementById('screen-user').style.display = 'none';
    document.getElementById('screen-main').style.display = 'block';
    document.getElementById('currName').textContent = currentUser.name;
    document.getElementById('currAv').textContent = currentUser.name[0];
    switchTab('today');
  }

  function logout() {
    if (!confirm('切換使用者？')) return;
    localStorage.removeItem('kitchen_user');
    currentUser = null;
    showUserSelect();
  }

  // ── Tab 切換 ────────────────────────────────────────────
  function switchTab(tab) {
    document.querySelectorAll('[data-tab]').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + tab));
    if (tab === 'today') loadToday();
    if (tab === 'rx')    loadRx();
    if (tab === 'inv')   loadInventory();
    if (tab === 'cost')  loadCost();
    if (tab === 'meal')  loadMeals();
    if (tab === 'sop')   loadSOP();
  }

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // ── 今日工作單 ─────────────────────────────────────────
  // 批次分組、拿取勾選、庫存已扣紀錄都是「整個廚房共用」的當日狀態，
  // 不是個人偏好。存在瀏覽器 localStorage 會讓兩台裝置看到不同的批次，
  // 而且「已扣庫存」各存各的，同一批有機會被扣兩次。一律以伺服器為準。
  let _saveTimer = null;

  function _dayStatePayload() {
    return {
      staff: [...staffPickedUp],
      cases: [...casePickedUp],
      staffMissed: [...staffMissed],
      caseMissed:  [...caseMissed],
      batchGroups: staffBatchGroups ? staffBatchGroups.map(b => ({
        manualTime: b.manualTime || null,
        memberIds: b.members.map(m => m.id)
      })) : null,
      schOrder: schCustomOrder || null,
      deductedBatches: [...deductedBatches],
      deductedCases: [...deductedCases],
      notes: dayNotes,
      qc: dayQc
    };
  }

  // 存不回伺服器時，以前只寫進 console —— 現場完全不會知道。
  // 廚房的 wifi 本來就不穩，這條路徑會讓兩台裝置看到不一樣的東西而且雙方都沒發覺。
  function _showSyncTrouble(msg) {
    let bar = document.getElementById('syncTrouble');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'syncTrouble';
      bar.className = 'sync-trouble';
      document.body.appendChild(bar);
    }
    bar.innerHTML = `<span>⚠ ${esc(msg)}</span>
      <button onclick="App.retrySync()">立即重試</button>`;
    bar.style.display = 'flex';
  }
  function _clearSyncTrouble() {
    const bar = document.getElementById('syncTrouble');
    if (bar) bar.style.display = 'none';
  }
  function retrySync() {
    if (lastTodayData) _pushDayState(lastTodayData.date, _dayStatePayload());
  }

  let _pendingState = null;   // 最後一次沒送成功的狀態，連線回來就補送
  function _pushDayState(date, payload) {
    return api('/api/today/state', 'PUT', { date, state: payload })
      .then(() => { _pendingState = null; _clearSyncTrouble(); })
      .catch(e => {
        _pendingState = { date, payload };
        _showSyncTrouble('這次的變更還沒存回伺服器，其他裝置看不到。' + (e.message || ''));
      });
  }

  function _saveDayState(date) {
    const payload = _dayStatePayload();
    // 連線斷掉時還能撐住，但它只是備援，不是真實來源
    try { localStorage.setItem(`clinic_day_${date}`, JSON.stringify(payload)); } catch (e) {}
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => _pushDayState(date, payload), 400);
  }

  // 連線回來就自動補送，不必等人按
  setInterval(() => {
    if (_pendingState) _pushDayState(_pendingState.date, _pendingState.payload);
  }, 15000);
  window.addEventListener('online', () => {
    if (_pendingState) _pushDayState(_pendingState.date, _pendingState.payload);
  });

  function _loadDayState(d) {
    // 伺服器優先；沒有才回頭看本機備援
    let s = d && d.day_state && d.day_state.state;
    if (!s) {
      try { s = JSON.parse(localStorage.getItem(`clinic_day_${d.date}`) || 'null'); } catch (e) { s = null; }
    }
    if (!s) return null;
    staffPickedUp   = new Set(s.staff || []);
    casePickedUp    = new Set(s.cases || []);
    staffMissed     = new Set(s.staffMissed || []);
    caseMissed      = new Set(s.caseMissed  || []);
    deductedBatches = new Set(s.deductedBatches || []);
    deductedCases   = new Set(s.deductedCases || []);
    dayNotes        = s.notes || {};
    dayQc           = s.qc || {};
    if (s.schOrder) schCustomOrder = s.schOrder;
    return s.batchGroups || null;
  }

  function updateLeaveAlert(d) {
    const leavesAlert = document.getElementById('todayLeavesAlert');
    if (!leavesAlert) return;
    if (!d || !d.leaves || d.leaves.length === 0) { leavesAlert.style.display = 'none'; return; }
    const chips = d.leaves.map(name => {
      const lower = name.toLowerCase().trim();
      const restored = restoredLeaves.has(lower);
      return `<span class="leave-chip${restored ? ' leave-restored' : ''}" onclick="App.toggleLeaveRestore('${name.replace(/'/g, "\\'")}')" title="${restored ? '點擊重新排除' : '點擊恢復出單'}">${esc(name)}${restored ? ' ↩' : ''}</span>`;
    }).join('');
    leavesAlert.innerHTML = `🌴 今日休假：${chips}<span class="leave-tip">（點姓名可復原出單）</span>`;
    leavesAlert.style.display = 'block';
  }

  // 復原／重新排除休假人員：直接改伺服器的出席狀態，
  // 讓杯數、批次、粉量、成本全部跟著一起變，而不是只有這台裝置的畫面變
  async function toggleLeaveRestore(name) {
    const lower = name.toLowerCase().trim();
    const s = (lastTodayData?.staff || []).find(x => x.name.toLowerCase().trim() === lower);
    if (!s) return;
    const restore = !restoredLeaves.has(lower);
    try {
      await api('/api/today/attendance/' + s.user_id, 'PUT',
        { attending: restore, meal_time: s.meal_time || '1330' });
      await loadToday();
    } catch (e) { alert(e.message); }
  }

  async function loadToday() {
    const d = await api('/api/today');
    lastTodayData = d;
    empRxId = d.products?.[0]?.staff_rx?.id || null;
    checkInvWarning();

    // 每次拿到伺服器資料就對帳一次，新出單才不會被舊分組擋在外面
    if (batchInitDate !== d.date) { batchInitDate = d.date; schCustomOrder = null; }
    const savedGroups = _loadDayState(d);
    _syncBatchGroups(d, savedGroups);

    // 伺服器上還沒有這天的狀態時，把手上這份推上去。
    // 否則每台裝置各自沿用自己的 localStorage 舊資料，畫面又會分岔。
    if (!d.day_state) _saveDayState(d.date);

    // 休假卻仍列出席的人 = 有人手動復原過，由伺服器狀態推導，不再另存一份
    const leaveSet = new Set((d.leaves || []).map(n => n.toLowerCase().trim()));
    restoredLeaves = new Set(
      (d.staff || [])
        .filter(s => s.attending && leaveSet.has(s.name.toLowerCase().trim()))
        .map(s => s.name.toLowerCase().trim())
    );

    // 顯示日期與星期
    const dowNames = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
    const dow = new Date(d.date).getDay();
    const dowName = dowNames[dow];
    const mealDayHint = d.is_meal_day ? ' (員工餐日)' : ' (非員工餐日)';
    const dateLabel = document.getElementById('todayDateLabel');
    if (dateLabel) {
      dateLabel.textContent = `${d.date} ${dowName}${mealDayHint}`;
    }

    // 顯示今日休假人員
    updateLeaveAlert(d);

    document.getElementById('staffCount').textContent = `${d.attending_count}人`;
    renderTodaySection1(d);
    _runDeductions();

    // 2+3. 每個產品的批次 + 個案
    caseDataMap = {};
    document.getElementById('productSections').innerHTML = d.products.map(prod => renderProductSection(prod, d.attending_count)).join('');

    renderTodayMeals(d.meals);
    renderTodayShortage(d);
    renderApptSyncWarning(d);
    renderAutoSettle();

    laborDate = d.date;
    loadLaborSection(d.date);
  }

  // ── 批次分組：以伺服器名單為準，並與既有分組對帳 ────────────────
  // 出席與否完全由伺服器的 staff_attendance 決定（休假的人那邊已經排除），
  // 前端不再自己過濾一次休假名單 —— 兩邊各算各的正是杯數對不上的來源。
  function _todayMembers(d) {
    const prod = d.products && d.products[0];
    const members = [];
    if (!prod) return members;
    (d.staff || []).filter(s => s.attending).forEach(s =>
      members.push({ id: `s_${s.user_id}`, name: s.name, type: 'staff', userId: s.user_id })
    );
    (prod.staff_rx_cases || []).forEach(c =>
      members.push({ id: `c_${c.id}`, name: c.patient_name || '個案', type: 'case', caseId: c.id, mealTime: c.meal_time || null, cups: c.cups || 1, prescriptionId: c.prescription_id || null })
    );
    return members;
  }

  // 切批次的規則與伺服器 calcBatches 一致：3 杯一批，餘 1 杯時改成 3+2+2，
  // 避免出現只有 1 杯的批次
  function _batchSizes(n, size) {
    size = size || 3;
    if (size === 3) {
      const mod = n % 3;
      const three = mod === 1 ? Math.floor(n / 3) - 1 : Math.floor(n / 3);
      const two   = mod === 0 ? 0 : mod === 1 ? 2 : 1;
      return [...Array(Math.max(three, 0)).fill(3), ...Array(two).fill(2)];
    }
    const full = Math.floor(n / size), rem = n % size;
    return [...Array(full).fill(size), ...(rem ? [rem] : [])];
  }

  // 全新排一次：先依「該取餐的時間」分群，再各自切批次。
  // 不同時間的人本來就不該同一鍋做 —— 混在一起才會發生某一邊的時間被蓋掉。
  function _layoutFresh(members, prod) {
    const size = prod.batch_size || 3;
    staffBatchGroups = [];

    const byTime = new Map();
    members.forEach(m => {
      const t = _memberTime(m);
      if (!byTime.has(t)) byTime.set(t, []);
      byTime.get(t).push(m);
    });

    [...byTime.keys()].sort().forEach(t => {
      const group = byTime.get(t);
      let mi = 0;
      _batchSizes(group.length, size).forEach(sz => {
        const bm = group.slice(mi, mi + sz);
        mi += sz;
        if (bm.length) staffBatchGroups.push({ size: bm.length, members: bm });
      });
      if (mi < group.length) {
        staffBatchGroups.push({ size: group.length - mi, members: group.slice(mi) });
      }
    });
  }

  // 還沒進任何批次的人補進去：先填未滿的批次，再開新批次
  function _appendMembers(missing, batchSize) {
    missing.forEach(m => {
      const slot = staffBatchGroups.find(b => b.members.length < batchSize);
      if (slot) slot.members.push(m);
      else staffBatchGroups.push({ size: 1, members: [m] });
    });
  }

  function _syncBatchGroups(d, savedGroups) {
    const prod = d.products && d.products[0];
    if (!prod) { staffBatchGroups = []; _allMembersMap = {}; return; }

    const members = _todayMembers(d);
    _allMembersMap = {};
    members.forEach(m => { _allMembersMap[m.id] = m; });

    if (!members.length) { staffBatchGroups = []; return; }

    if (savedGroups && savedGroups.length) {
      // 沿用大家已經拖好的分組，但一定要跟今天的名單對帳：
      // 不在名單上的移除、重複出現的只留一次、還沒入批的補進去。
      // 少了對帳這一步，新建立的出單就會整杯消失。
      const seen = new Set();
      staffBatchGroups = savedGroups.map(b => ({
        manualTime: b.manualTime || null,
        members: (b.memberIds || []).map(id => {
          if (seen.has(id)) return null;
          seen.add(id);
          return _allMembersMap[id];
        }).filter(Boolean)
      })).filter(b => b.members.length > 0);

      const missing = members.filter(m => !seen.has(m.id));
      if (missing.length) _appendMembers(missing, prod.batch_size || 3);

      if (!staffBatchGroups.length) _layoutFresh(members, prod);
    } else {
      _layoutFresh(members, prod);
    }

    // 對帳後的總杯數必須等於名單人數，不等就是有人被漏掉
    const placed = staffBatchGroups.reduce((s, b) => s + b.members.length, 0);
    if (placed !== members.length) {
      console.error(`批次對帳異常：名單 ${members.length} 人，已入批 ${placed} 人，重新排列`);
      _layoutFresh(members, prod);
    }

    // 舊資料的「已扣庫存」記的是批次位置編號，換算成成員組成，
    // 免得換算前後對不上而重複扣或漏扣
    if ([...deductedBatches].some(k => /^\d+$/.test(String(k)))) {
      const converted = new Set();
      deductedBatches.forEach(k => {
        if (/^\d+$/.test(String(k))) {
          const b = staffBatchGroups[Number(k)];
          if (b) converted.add(_batchKey(b));
        } else converted.add(k);
      });
      deductedBatches = converted;
    }
  }

  // ── 批次實際杯數（員工1杯，個案用自己的cups）────────────────────
  function _batchCups(batch) {
    return batch.members.reduce((sum, m) => sum + (m.type === 'case' ? (m.cups || 1) : 1), 0);
  }

  // ── 批次時間計算（可被手動覆蓋）────────────────────────────────
  // 每位成員都有自己該取餐的時間：員工預設 11:30，個案用自己出單的時間。
  // 舊版只要批次裡有員工就一律顯示 11:30，會把個案的時間蓋掉 ——
  // 同一位個案因為被分到哪一批而顯示不同時間，正是這次對不上的原因之一。
  // 現在取最早的時間，並在成員時間不一致時標出來讓人處理。
  const STAFF_DEFAULT_TIME = '1130';

  function _memberTime(m) {
    return m.type === 'case' ? (m.mealTime || STAFF_DEFAULT_TIME) : STAFF_DEFAULT_TIME;
  }

  function _getBatchTime(batch) {
    if (batch.manualTime) {
      const t = batch.manualTime;
      return { sk: `${t}_0`, label: `${t.slice(0,2)}:${t.slice(2)}`, conflict: false };
    }
    const times = [...new Set(batch.members.map(_memberTime))].sort();
    if (!times.length) return { sk: `${STAFF_DEFAULT_TIME}_0`, label: '11:30', conflict: false };
    const t = times[0];
    return {
      sk: `${t}_0`,
      label: t.length === 4 ? `${t.slice(0,2)}:${t.slice(2)}` : t,
      conflict: times.length > 1,
      times
    };
  }

  // ── 渲染左側批次分組 ──────────────────────────────────────────
  // 對帳列：批次只裝「員工標準配方」的人，自己有處方的個案是個別現打。
  // 把兩邊加起來對總數，才不會有人以為某位個案「不見了」。
  function _renderBatchTally() {
    const d = lastTodayData;
    if (!d) return '';
    const prod = d.products && d.products[0];
    if (!prod) return '';

    const inBatch = (staffBatchGroups || []).reduce((s, b) => s + _batchCups(b), 0);
    const solo    = d.products.flatMap(p => p.cases)
                     .filter(c => !c.is_staff_rx)
                     .reduce((s, c) => s + (c.cups || 1), 0);
    const expected = prod.total_staff_cups || 0;
    const ok = inBatch === expected;

    return `
      <div class="batch-tally${ok ? '' : ' batch-tally-bad'}">
        <span>今日共 <strong>${inBatch + solo}</strong> 杯</span>
        <span class="bt-sep">＝</span>
        <span>批次（員工標準配方） <strong>${inBatch}</strong> 杯</span>
        <span class="bt-sep">＋</span>
        <span>個別現打（自己的處方） <strong>${solo}</strong> 杯</span>
        ${ok ? '' : `<span class="bt-warn">⚠ 批次應為 ${expected} 杯，少了 ${expected - inBatch} 杯</span>`}
      </div>`;
  }

  function _renderBatchGroups() {
    if (!staffBatchGroups || staffBatchGroups.length === 0) return '';
    let html = _renderBatchTally() + '<div class="batch-groups-wrap">';
    staffBatchGroups.forEach((batch, bi) => {
      const allDone = _batchDone(batch);
      const { label: timeLabel, conflict, times } = _getBatchTime(batch);
      // 同一批裡有人要 11:30、有人要 12:30，就把衝突標出來讓人自己決定要不要拆批
      const conflictTag = conflict
        ? `<span class="batch-grp-conflict" title="這批的成員取餐時間不一致：${times.map(t => t.slice(0,2)+':'+t.slice(2)).join('、')}。可以拖出來另開一批，或點時間手動指定。">⚠ 時間不一致</span>`
        : '';
      html += `<div class="batch-grp${allDone ? ' batch-grp-done' : ''}"
                    ondragover="event.preventDefault()" ondrop="App.batchDrop(event,${bi})">
        <div class="batch-grp-head">
          <span class="batch-grp-label">批次 ${bi + 1}</span>
          <span class="batch-grp-sz">${_batchCups(batch)}杯</span>
          <span class="batch-time-wrap"><span class="batch-grp-time${batch.manualTime ? ' bt-manual' : ''}"
                  title="${batch.manualTime ? '手動指定的時間' : '依成員取餐時間自動判定'}">⏰ ${timeLabel}</span><button
                  class="batch-time-edit" title="修改這批的時間"
                  onclick="App.editBatchTime(${bi},this)">✎</button></span>
          ${conflictTag}
          ${allDone ? '<span class="batch-grp-done-tag">✓ 完成</span>' : ''}
          <button class="batch-grp-del" onclick="App.removeBatch(${bi})">×</button>
        </div>
        <div class="batch-grp-members">
          ${batch.members.map(m => {
            const delivered = _memberDelivered(m);
            const needsTap  = m.type === 'case' && _needsCheck(_findCase(m.caseId)) && !delivered;
            const onclick = m.type === 'staff'
              ? `App.handleStaffChipClick(${m.userId},1)`
              : `App.toggleCasePickup(${m.caseId})`;
            const cls = needsTap ? ' needs-check' : (delivered ? '' : ' missed');
            const tag = needsTap ? ' ⚠' : (delivered ? '' : ' 未領');
            const title = needsTap ? '這位有禁忌註記，要核對過才算出餐'
                        : (delivered ? '預設已出餐。點一下標記為未領' : '已標記未領。點一下改回已出餐');
            // 一個人點兩杯時，批次寫「3杯」但只看到兩個名字，對不起來。
            // 把杯數標在名字後面
            const mCups = m.type === 'case' ? (m.cups || 1) : 1;
            return `<div class="bmember-chip${cls}${m.type === 'case' ? ' bmember-case' : ''}"
                         draggable="true" title="${title}"
                         ondragstart="App.batchDragStart(event,${bi},'${m.id}')"
                         ondragend="App.batchDragEnd()"
                         onclick="${onclick}">
              ${esc(m.name)}${mCups > 1 ? ` ×${mCups}` : ''}${tag}
            </div>`;
          }).join('')}
        </div>
      </div>`;
    });
    html += `<button class="batch-add-btn" onclick="App.addBatch()">＋ 新增批次</button>`;
    html += `<div id="batchDeleteZone" class="batch-delete-zone" style="display:none"
                  ondragover="event.preventDefault();this.classList.add('bdz-over')"
                  ondragleave="this.classList.remove('bdz-over')"
                  ondrop="App.batchDropDelete(event)">🗑 拖到這裡刪除</div>`;
    html += '</div>';
    return html;
  }

  // ── 渲染右側出餐順序 ──────────────────────────────────────────
  function _renderSchedule(d) {
    const prod = d.products && d.products[0];
    const allCases = d.products.flatMap(p => p.cases);
    const items = [];

    // 員工批次
    if (staffBatchGroups && staffBatchGroups.length > 0) {
      staffBatchGroups.forEach((batch, bi) => {
        const allDone = _batchDone(batch);
        const { sk: bSk, label: bTimeLabel } = _getBatchTime(batch);
        items.push({
          key: `batch_${bi}`,
          sk: `${bSk}_${String(bi).padStart(2,'0')}`, timeLabel: bTimeLabel, type: 'staff',
          name: `🫙 批次 ${bi + 1}（${_batchCups(batch)}杯）`,
          detail: batch.members.map(m => m.name).join('、') || '（空）',
          noteText: '', done: allDone
        });
      });
    } else if ((prod?.total_staff_cups || 0) > 0) {
      items.push({ key: 'staff_all', sk: '1130_0', timeLabel: '11:30', type: 'staff',
        name: '👥 員工出餐', detail: `${d.attending_count}人 · 共 ${prod.total_staff_cups} 杯`, noteText: '', done: false });
    }

    // 個案（跳過已在批次裡的 is_staff_rx）
    allCases.filter(c => !c.is_staff_rx).forEach(c => {
      const mt = c.meal_time || '0000';
      const tFmt = mt.length === 4 ? `${mt.slice(0,2)}:${mt.slice(2)}` : mt;
      const who = c.patient_name || c.rx_name || '';
      let icon, detail;
      if (c.formula_type === '粉配方')  { icon = '🧪'; detail = `粉配方 ${c.cups}天 ${ptLabel(c.powder_type)}`; }
      else if (c.powder_type === '全配方') { icon = '📦'; detail = `全配方外帶 ${c.cups}天`; }
      else                                 { icon = '🥤'; detail = `${c.rx_name} ${c.cups}杯`; }
      const noteText = [c.contraindications, c.notes].filter(Boolean).join(' · ');
      // 被廚房改過時間的，預約那邊的時間留在 appt_meal_time。
      // 兩邊不同就標出來 —— 才分得出是刻意調的，還是預約改了沒跟上
      const apptT = (c.appt_meal_time && c.appt_meal_time !== c.meal_time) ? c.appt_meal_time : '';
      items.push({ key: `case_${c.id}`, sk: `${mt}_1`, timeLabel: tFmt, type: 'case',
        name: `${icon} ${who}`, detail, noteText, done: _caseDelivered(c),
        needsCheck: _needsCheck(c),
        apptTime: apptT ? hhmm(apptT) : '', apptMissing: !!c.appt_missing,
        caseId: c.id, prescriptionId: c.prescription_id, powderType: c.powder_type || '袋裝',
        recipe: _caseRecipeBody(c, (prod && prod.unit) || '杯') });
    });

    // 餐盒。出餐時精力湯和便當是一起端出去的，放同一條時間軸，
    // 不再自成一段掛在頁尾
    ((d.meals && d.meals.orders) || []).forEach(o => {
      const mt = o.meal_time || '0000';
      const tFmt = mt.length === 4 ? `${mt.slice(0,2)}:${mt.slice(2)}` : mt;
      items.push({
        key: `meal_${o.id}`, sk: `${mt}_2`, timeLabel: tFmt, type: 'meal',
        name: `🍱 ${o.patient_name || '員工'}`,
        detail: [o.display_name + (o.qty > 1 ? ' ×' + o.qty : ''), o.kcal + ' kcal', o.vendor_name]
                  .filter(Boolean).join(' · '),
        noteText: o.notes || '', done: o.status === '已出餐',
        mealId: o.id, mealStatus: o.status
      });
    });

    // 套用手動順序或依時間排序
    let ordered;
    if (schCustomOrder) {
      const km = {}; items.forEach(it => { km[it.key] = it; });
      ordered = schCustomOrder.map(k => km[k]).filter(Boolean);
      items.filter(it => !schCustomOrder.includes(it.key)).forEach(it => ordered.push(it));
    } else {
      ordered = [...items].sort((a, b) => a.sk.localeCompare(b.sk));
    }

    if (ordered.length === 0) return '<div class="sch-empty">今日無出單</div>';

    // 中午出餐時精力湯和餐盒混在一起，需要時可以只看其中一種。
    // 筆數一起顯示，才知道被藏起來的有多少。這是看的人的偏好，不進共用狀態
    const isMeal = it => it.type === 'meal';
    const counts = {
      all:   ordered.length,
      tonic: ordered.filter(it => !isMeal(it)).length,
      meal:  ordered.filter(isMeal).length
    };
    if (schFilter === 'tonic') ordered = ordered.filter(it => !isMeal(it));
    if (schFilter === 'meal')  ordered = ordered.filter(isMeal);

    const filterBar = counts.meal > 0 ? `
      <div class="sch-filter">
        ${[['all', '全部'], ['tonic', '🥤 精力湯'], ['meal', '🍱 餐盒']].map(([k, label]) =>
          `<button class="${schFilter === k ? 'on' : ''}"${counts[k] ? '' : ' disabled'}
                   onclick="App.setSchFilter('${k}')">${label} ${counts[k]}</button>`).join('')}
      </div>` : '';

    const rows = ordered.map(it => `
      <div class="sch-item sch-draggable${it.type==='staff'?' sch-staff':''}${it.done?' sch-done':''}"
           draggable="true" data-key="${it.key}"
           ondragstart="App.schDragStart(event,'${it.key}')"
           ondragover="App.schDragOver(event)"
           ondragleave="App.schDragLeave(event)"
           ondrop="App.schDrop(event,'${it.key}')">
        <div class="sch-drag-handle">⠿</div>
        <div class="sch-time">${it.timeLabel}</div>
        <div class="sch-body">
          <div class="sch-name">${esc(it.name)}</div>
          <div class="sch-detail">${esc(it.detail)}${it.apptTime
            ? `<span class="sch-appt" title="預約系統上的時間和這裡不同。這一筆被改過，同步不會再覆蓋">預約 ${esc(it.apptTime)}</span>` : ''}${
            it.apptMissing
            ? `<span class="sch-gone" title="這筆是從預約帶入的，但那筆預約現在查不到了（可能已取消或改期）。確認後可以直接刪除">⚠ 預約已不存在</span>` : ''}</div>
          ${it.noteText ? `<div class="sch-note">📝 ${esc(it.noteText)}</div>` : ''}
          ${_schActions(it)}
          ${it.type === 'case' && it.recipe && openCaseRecipes.has(it.caseId)
            ? `<div class="sch-recipe">${it.recipe}</div>` : ''}
        </div>
        ${it.done ? '<div class="sch-done-mark">✓</div>' : ''}
      </div>`).join('');
    return `
      <div class="schedule-title">
        📋 今日出餐順序
        <button class="btn btn-primary btn-sm" style="margin-left:auto"
                onclick="App.openAddCase(${prod ? prod.id : 1})">＋ 出單</button>
      </div>
      ${filterBar}
      <div id="schList">${rows.length ? rows : '<div class="sch-empty">這個篩選下沒有項目</div>'}</div>`;
  }

  // 每一列自己帶操作 —— 以前要捲到下面的個案卡片才能編輯或刪除
  // 刪除不再放在這一排。它換行後會落在最常按的那顆正下方，位置一樣、大小一樣，
  // 忙起來很容易按錯 —— 改放進編輯視窗，那裡本來就是刻意進去的地方。
  function _schActions(it) {
    if (it.type === 'case') {
      // 一列只放一顆主要動作。配方／菜單／編輯是偶爾才用的，
      // 全部攤開來每列要換行兩次，整頁高度會翻倍 —— 在手機上等於一直捲
      const mark = it.needsCheck && !it.done
        ? `<button class="sch-primary" onclick="event.stopPropagation();App.toggleCasePickup(${it.caseId})">⚠ 核對出餐</button>`
        : `<button class="${it.done ? '' : 'sch-missed'}" onclick="event.stopPropagation();App.toggleCasePickup(${it.caseId})">${it.done ? '標未出餐' : '改回已出餐'}</button>`;
      const open = schMoreOpen.has(it.key);
      return `<div class="sch-actions">
        ${mark}
        <button class="sch-more${open ? ' on' : ''}" title="其他操作"
                onclick="event.stopPropagation();App.toggleSchMore('${it.key}')">${open ? '收起' : '⋯'}</button>
      </div>
      ${open ? `<div class="sch-actions sch-more-row">
        ${it.recipe ? `<button onclick="event.stopPropagation();App.toggleCaseRecipe(${it.caseId})">${openCaseRecipes.has(it.caseId) ? '收起配方' : '配方'}</button>` : ''}
        <button onclick="event.stopPropagation();App.openCaseMenuFor(${it.prescriptionId},'${esc(it.powderType)}')">菜單</button>
        <button onclick="event.stopPropagation();App.openEditCase(${it.caseId})">編輯</button>
      </div>` : ''}`;
    }
    if (it.type === 'meal') {
      const mopen = schMoreOpen.has(it.key);
      return `<div class="sch-actions">
        <span class="sch-status">${esc(it.mealStatus)}</span>
        <button onclick="event.stopPropagation();App.advanceMealStatus(${it.mealId})">推進狀態</button>
        <button class="sch-more${mopen ? ' on' : ''}" title="其他操作"
                onclick="event.stopPropagation();App.toggleSchMore('${it.key}')">${mopen ? '收起' : '⋯'}</button>
      </div>
      ${mopen ? `<div class="sch-actions sch-more-row">
        <button onclick="event.stopPropagation();App.openEditMealOrder(${it.mealId})">編輯</button>
      </div>` : ''}`;
    }
    return '';
  }

  function toggleSchMore(key) {
    if (schMoreOpen.has(key)) schMoreOpen.delete(key);
    else schMoreOpen.add(key);
    if (lastTodayData) renderTodaySection1(lastTodayData);
  }

  function renderTodaySection1(d) {
    const prod = d.products && d.products[0];

    // 批次分組已在 loadToday 取得資料時對帳完成，這裡只負責畫

    // 左側：批次分組（覆蓋 grid 排版為 block，避免 auto-fill 把批次擠進 80px 欄位）
    const sg = document.getElementById('staffGrid');
    sg.style.display = (staffBatchGroups && staffBatchGroups.length > 0) ? 'block' : '';
    sg.innerHTML = _renderBatchGroups();

    // 個案 chips（外帶/內用分組）
    const allCases = d.products.flatMap(p => p.cases);
    const fullPackageCases = allCases.filter(c => c.powder_type === '全配方');
    const freshCases  = allCases.filter(c => c.formula_type === '全配方' && c.powder_type !== '全配方');
    const powderCases = allCases.filter(c => c.formula_type === '粉配方');

    function caseChip(c, type) {
      const delivered = _caseDelivered(c);
      const needsTap  = _needsCheck(c) && !delivered;
      const isInuse = c.powder_type === '內用';
      const name = c.patient_name || c.rx_name || c.code;
      const mt = c.meal_time && c.meal_time.length === 4
        ? `${c.meal_time.slice(0,2)}:${c.meal_time.slice(2)}` : (c.meal_time || '');
      const sub = type === 'fresh'
        ? `${esc(c.rx_name)} ${c.cups}杯${mt ? ' · ' + mt : ''}`
        : `${c.cups}天 ${esc(ptLabel(c.powder_type))}${mt ? ' · ' + mt : ''}`;
      const cls = needsTap ? 'needs-check' : (delivered ? '' : 'missed');
      // 用員工配方的個案不會出現在出餐時間軸（編輯鈕在那裡），
      // 所以編輯入口只能放這張晶片上，否則時間和內容都改不了
      return `<div class="case-chip ${cls}" data-type="${type}" data-inuse="${isInuse?1:0}"
                   onclick="App.toggleCasePickup(${c.id})">
        <button class="chip-edit" title="編輯這筆出單"
                onclick="event.stopPropagation();App.openEditCase(${c.id})">✎</button>
        <div class="sname">${esc(name)}${c.cups > 1 ? ` ×${c.cups}` : ''}${
          needsTap ? ' ⚠' : (delivered ? '' : ' 未出餐')}</div>
        <div class="chip-sub">${isInuse ? '🍽 內用精力湯' : ''}${sub}</div>
      </div>`;
    }
    function chipGroup(cases, type, label) {
      if (cases.length === 0) return '';
      const chips = [...cases.filter(c=>c.powder_type!=='內用'), ...cases.filter(c=>c.powder_type==='內用')]
        .map(c => caseChip(c, type)).join('');
      return `<div class="today-group"><div class="today-group-label">${label}</div><div class="chips-row">${chips}</div></div>`;
    }
    let groupsHtml = '';
    groupsHtml += chipGroup(fullPackageCases, 'full',   '📦 全配方外帶');
    groupsHtml += chipGroup(freshCases,       'fresh',  '現打精力湯');
    groupsHtml += chipGroup(powderCases,      'powder', '粉配方');
    document.getElementById('caseChips').innerHTML = groupsHtml;

    // 右側：出餐順序
    document.getElementById('todaySchedule').innerHTML = _renderSchedule(d);
  }

  // 用成員組成當識別，不用批次位置。
  // 位置會因為新增／刪除／拖動而平移，原本扣過的批次會被當成沒扣過（重複扣庫存），
  // 或沒扣過的被當成扣過（永遠不扣）。
  // ── 「已出餐」判定：整份系統只定義這一次 ───────────────────────
  // 預設是做了、送出去了；只有被明確標記的例外才是沒發生。
  // 唯一的例外是有禁忌註記的個案 —— 那個要人核對過才算，安全閘門不能因為省點擊就拿掉。
  function _needsCheck(c) {
    return !!(c && c.contraindications && String(c.contraindications).trim());
  }
  function _findCase(caseId) {
    const all = (lastTodayData && lastTodayData.products)
      ? lastTodayData.products.flatMap(p => p.cases || []) : [];
    return all.find(x => x.id === caseId) || null;
  }
  function _caseDelivered(c) {
    if (!c) return false;
    return _needsCheck(c) ? casePickedUp.has(c.id) : !caseMissed.has(c.id);
  }
  function _memberDelivered(m) {
    if (m.type === 'staff') return !staffMissed.has(m.userId);
    const c = _findCase(m.caseId);
    return c ? _caseDelivered(c) : !caseMissed.has(m.caseId);
  }
  // 這一批是不是全部都出餐了（空批次不算完成）
  function _batchDone(batch) {
    return batch.members.length > 0 && batch.members.every(_memberDelivered);
  }

  function _batchKey(batch) {
    return batch.members.map(m => m.id).sort().join('|');
  }

  // 只看時間，不看日期 —— 這幾個判定都只用在「今天」這一頁
  function _timePassed(hhmm) {
    if (!hhmm || hhmm.length !== 4) return false;
    const now = new Date();
    return (now.getHours() * 100 + now.getMinutes()) >= Number(hhmm);
  }

  // 改成預設已出餐之後，一開頁面所有批次就都是「完成」狀態。
  // 沒有這道時間閘門的話，早上八點就會把中午的料扣掉 —— 那時候還可能有人請假或加單。
  // 過了出餐時間才扣；真的沒扣到的，隔天伺服器的自動補扣會接住
  function _checkBatchDeductions() {
    if (!staffBatchGroups) return;
    staffBatchGroups.forEach(batch => {
      const key = _batchKey(batch);
      if (!key || deductedBatches.has(key)) return;
      if (!_batchDone(batch)) return;
      const { sk } = _getBatchTime(batch);
      if (!_timePassed(String(sk).slice(0, 4))) return;
      deductedBatches.add(key);
      // 員工人數 → 員工配方（被標未領的不算）
      const staffCount = batch.members.filter(m => m.type === 'staff' && !staffMissed.has(m.userId)).length;
      if (staffCount > 0 && empRxId) {
        api('/api/inventory/consume', 'POST', { prescription_id: empRxId, cups: staffCount }).catch(() => {});
      }
      // 個案（is_staff_rx）→ 各自配方
      batch.members.filter(m => m.type === 'case' && m.prescriptionId).forEach(m => {
        api('/api/inventory/consume', 'POST', { prescription_id: m.prescriptionId, cups: m.cups }).catch(() => {});
      });
    });
  }

  // 個案（自己的處方）過了出餐時間就扣。和批次那條走同一個規則，只是資料來源不同
  function _checkCaseDeductions() {
    if (!lastTodayData) return;
    (lastTodayData.products || []).flatMap(p => p.cases || []).forEach(c => {
      if (c.is_staff_rx) return;                 // 員工標準配方走批次那條路
      if (!_caseDelivered(c)) return;            // 標了未出餐的不扣
      if (!_timePassed(c.meal_time)) return;     // 還沒到出餐時間
      _deductCaseOnce(c);
    });
  }

  // 扣庫存的唯一入口。頁面開著的時候每分鐘跑一次，時間一到就自動扣，不必有人按
  function _runDeductions() {
    _checkBatchDeductions();
    _checkCaseDeductions();
    if (lastTodayData) _saveDayState(lastTodayData.date);
  }
  setInterval(() => { if (lastTodayData) _runDeductions(); }, 60000);

  // 點一下不是「勾我領了」，而是「標記這個人沒領到」。正常的一天不必點任何一下
  function handleStaffChipClick(userId, isAttending) {
    if (!isAttending) {
      toggleAttendance(userId, 1);
      return;
    }
    if (staffMissed.has(userId)) staffMissed.delete(userId);
    else staffMissed.add(userId);
    _checkBatchDeductions();
    _checkCaseDeductions();
    if (lastTodayData) { _saveDayState(lastTodayData.date); renderTodaySection1(lastTodayData); }
  }

  function _showContraConfirm(name, contraText, onConfirm) {
    const div = document.createElement('div');
    div.className = 'contra-confirm';
    div.innerHTML = `
      <div class="contra-box">
        <div class="contra-icon">⚠️</div>
        <div class="contra-title">取餐前確認</div>
        <div class="contra-name">${esc(name)}</div>
        <div class="contra-warn">📋 禁忌注意：${esc(contraText)}</div>
        <div class="contra-actions">
          <button class="btn btn-ghost" id="contraCancel">取消</button>
          <button class="btn btn-primary" id="contraOk">已核對，確認取餐</button>
        </div>
      </div>`;
    document.body.appendChild(div);
    div.querySelector('#contraOk').onclick = () => { div.remove(); onConfirm(); };
    div.querySelector('#contraCancel').onclick = () => div.remove();
  }

  // 兩種個案走不同路：
  //   有禁忌註記 → 維持原本的人工核對，核對過才算出餐（安全閘門）
  //   其餘       → 預設已出餐，點一下是標「沒出餐」
  function toggleCasePickup(caseId) {
    const c = _findCase(caseId);
    const after = () => {
      _checkBatchDeductions();
      _checkCaseDeductions();
      if (lastTodayData) { _saveDayState(lastTodayData.date); renderTodaySection1(lastTodayData); }
    };

    if (_needsCheck(c)) {
      if (casePickedUp.has(caseId)) { casePickedUp.delete(caseId); return after(); }
      _showContraConfirm(c.patient_name || c.rx_name, c.contraindications, () => {
        casePickedUp.add(caseId);
        _deductCaseOnce(c);
        after();
      });
      return;
    }

    if (caseMissed.has(caseId)) { caseMissed.delete(caseId); return after(); }
    caseMissed.add(caseId);
    after();
  }

  // 扣庫存只扣一次。個案自己的處方才在這裡扣，員工標準配方走批次那條路
  function _deductCaseOnce(c) {
    if (!c || c.is_staff_rx || deductedCases.has(c.id)) return;
    deductedCases.add(c.id);
    api('/api/inventory/consume', 'POST', {
      prescription_id: c.prescription_id, cups: c.cups, powder_type: c.powder_type
    }).catch(() => {});
  }

  // ── 批次拖曳（左側員工重新分批）────────────────────────────────
  function batchDragStart(event, fromBatch, memberId) {
    batchDragSrc = { fromBatch: +fromBatch, memberId };
    event.dataTransfer.effectAllowed = 'move';
    setTimeout(() => {
      const dz = document.getElementById('batchDeleteZone');
      if (dz) dz.style.display = '';
    }, 0);
  }
  function batchDragEnd() {
    const dz = document.getElementById('batchDeleteZone');
    if (dz) { dz.style.display = 'none'; dz.classList.remove('bdz-over'); }
    batchDragSrc = null;
  }
  function batchDrop(event, toBatch) {
    event.preventDefault();
    if (!batchDragSrc) return;
    const { fromBatch, memberId } = batchDragSrc;
    toBatch = +toBatch;
    batchDragSrc = null;
    const dz = document.getElementById('batchDeleteZone');
    if (dz) { dz.style.display = 'none'; dz.classList.remove('bdz-over'); }
    if (fromBatch === toBatch) return;
    const from = staffBatchGroups[fromBatch];
    const to   = staffBatchGroups[toBatch];
    if (!from || !to) return;
    const idx = from.members.findIndex(m => m.id === memberId);
    if (idx === -1) return;
    const [member] = from.members.splice(idx, 1);
    to.members.push(member);
    if (lastTodayData) { _saveDayState(lastTodayData.date); renderTodaySection1(lastTodayData); }
  }
  async function batchDropDelete(event) {
    event.preventDefault();
    const dz = event.currentTarget;
    if (dz) { dz.style.display = 'none'; dz.classList.remove('bdz-over'); }
    if (!batchDragSrc) return;
    const { fromBatch, memberId } = batchDragSrc;
    batchDragSrc = null;
    const batch = staffBatchGroups[fromBatch];
    if (!batch) return;
    const idx = batch.members.findIndex(m => m.id === memberId);
    if (idx === -1) return;
    const member = batch.members[idx];
    if (member.type === 'case') {
      if (!confirm(`確定要刪除 ${member.name} 的出單嗎？`)) return;
      await api(`/api/today/cases/${member.caseId}`, 'DELETE');
      loadToday();
    } else {
      batch.members.splice(idx, 1);
      if (lastTodayData) { _saveDayState(lastTodayData.date); renderTodaySection1(lastTodayData); }
    }
  }
  // 時間編輯只能從 ✎ 進入，時間本身不再是按鈕 ——
  // 原本整顆時間標籤都可點，手機上很容易誤觸，畫面上就多一個看起來壞掉的空白框
  function editBatchTime(bi, el) {
    const batch = staffBatchGroups && staffBatchGroups[bi];
    if (!batch) return;
    const wrap = el.closest('.batch-time-wrap');
    if (!wrap || wrap.querySelector('.batch-time-input')) return;   // 已經在編輯中

    const cur = batch.manualTime || _getBatchTime(batch).sk.slice(0, 4);
    const box = document.createElement('span');
    box.className = 'batch-time-edit-box';
    box.innerHTML = `
      <input type="time" class="batch-time-input" value="${cur.slice(0,2)}:${cur.slice(2)}">
      <button class="bt-ok" title="確定">✓</button>
      <button class="bt-auto" title="改回自動（依成員取餐時間）">自動</button>
      <button class="bt-cancel" title="取消">✕</button>`;
    const original = wrap.innerHTML;
    wrap.innerHTML = '';
    wrap.appendChild(box);

    const input = box.querySelector('.batch-time-input');
    input.focus();

    const done = () => { if (lastTodayData) { _saveDayState(lastTodayData.date); renderTodaySection1(lastTodayData); } };
    box.querySelector('.bt-ok').onclick = () => {
      const v = (input.value || '').replace(':', '');
      if (/^\d{4}$/.test(v)) batch.manualTime = v;
      done();
    };
    box.querySelector('.bt-auto').onclick = () => { delete batch.manualTime; done(); };
    box.querySelector('.bt-cancel').onclick = () => { wrap.innerHTML = original; };
  }
  function addBatch() {
    if (!staffBatchGroups) staffBatchGroups = [];
    staffBatchGroups.push({ size: 0, members: [] });
    if (lastTodayData) { _saveDayState(lastTodayData.date); renderTodaySection1(lastTodayData); }
  }
  function removeBatch(batchIdx) {
    if (!staffBatchGroups) return;
    const batch = staffBatchGroups[batchIdx];
    if (!batch) return;
    if (batch.members.length > 0) {
      const targetIdx = batchIdx === 0 ? (staffBatchGroups.length > 1 ? 1 : -1) : 0;
      if (targetIdx >= 0) staffBatchGroups[targetIdx].members.push(...batch.members);
    }
    staffBatchGroups.splice(batchIdx, 1);
    if (lastTodayData) { _saveDayState(lastTodayData.date); renderTodaySection1(lastTodayData); }
  }

  // ── 出餐順序拖曳（右側上下排序）────────────────────────────────
  function schDragStart(event, key) {
    schDragKey = key;
    event.dataTransfer.effectAllowed = 'move';
  }
  function schDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const el = event.currentTarget;
    if (el) el.classList.add('sch-drag-over');
  }
  function schDragLeave(event) {
    const el = event.currentTarget;
    if (el) el.classList.remove('sch-drag-over');
  }
  function schDrop(event, targetKey) {
    event.preventDefault();
    document.querySelectorAll('.sch-drag-over').forEach(el => el.classList.remove('sch-drag-over'));
    if (!schDragKey || schDragKey === targetKey) { schDragKey = null; return; }
    const schList = document.getElementById('schList');
    if (!schList) { schDragKey = null; return; }
    const currentKeys = [...schList.querySelectorAll('[data-key]')].map(el => el.dataset.key);
    if (!schCustomOrder) schCustomOrder = [...currentKeys];
    const fi = schCustomOrder.indexOf(schDragKey);
    const ti = schCustomOrder.indexOf(targetKey);
    if (fi === -1 || ti === -1) { schDragKey = null; return; }
    schCustomOrder.splice(fi, 1);
    schCustomOrder.splice(ti, 0, schDragKey);
    schDragKey = null;
    if (lastTodayData) { _saveDayState(lastTodayData.date); renderTodaySection1(lastTodayData); }
  }

  function renderProductSection(prod, attendingCount) {
    const unit = prod.unit;
    const batches = prod.batches;
    const batchDesc = batches.map(b => `${b.count}批×${b.size}${unit}`).join('　+　');

    // ── LEFT：員工批次 ──────────────────────────────────────
    let leftHtml = '';
    if (attendingCount === 0) {
      leftHtml = `<div class="empty" style="margin-bottom:8px"><div class="ei">😴</div>今日無員工出席</div>`;
    } else if (!prod.staff_rx) {
      leftHtml = `<div class="product-no-staff">尚未設定員工標準處方</div>`;
    } else {
      const pw = prod.staff_powder;
      let powderHtml = '';
      if (pw && pw.per_serving > 0) {
        // Collect all distinct batch sizes active today (e.g. 2, 3, etc.)
        const activeSizes = Array.from(new Set(batches.map(b => b.size))).sort((a, b) => a - b);
        // We always want to make sure we show 1, 2, and 3 cups ratios!
        const sizesToShow = Array.from(new Set([1, 2, 3, ...activeSizes])).sort((a, b) => a - b);

        const tableHeaders = sizesToShow.map(s => `<th style="padding:6px 8px; text-align:right; border-left:1px solid var(--border)">${s}杯量</th>`).join('');
        
        const tableRows = pw.items.map(item => {
          const cols = sizesToShow.map(s => {
            const val = Math.round(item.qty * s * 100) / 100;
            return `<td style="padding:6px 8px; text-align:right; border-left:1px solid var(--border); font-weight:600">${val}${item.unit}</td>`;
          }).join('');
          return `
            <tr style="border-bottom:1px solid var(--border)">
              <td style="padding:6px 8px; font-weight:500; color:var(--text1)">${esc(item.name)}</td>
              ${cols}
            </tr>`;
        }).join('');

        // Total powder row
        const totalCols = sizesToShow.map(s => {
          const val = Math.round(pw.per_serving * s * 100) / 100;
          return `<td style="padding:6px 8px; text-align:right; border-left:1px solid var(--border); font-weight:700; color:var(--green)">${val}g</td>`;
        }).join('');
        const totalRow = `
          <tr style="background:rgba(16,185,129,0.04); font-weight:700">
            <td style="padding:6px 8px; color:var(--green)">⚡ 總粉量（取粉）</td>
            ${totalCols}
          </tr>`;

        powderHtml = `
          <div class="powder-box" style="padding:14px; margin-bottom:12px; background:var(--card-bg); border:1px solid var(--border); border-radius:var(--radius-md); box-shadow:var(--shadow-sm)">
            <div class="powder-title" style="font-size:14px; font-weight:700; color:var(--text1); display:flex; align-items:center; gap:6px; margin-bottom:10px">
              <span>🧪 預調粉包比例與杯數換算（${esc(prod.staff_rx.code)}）</span>
            </div>
            
            <div style="overflow-x:auto">
              <table style="width:100%; border-collapse:collapse; font-size:14px; text-align:left; border:1px solid var(--border); border-radius:var(--radius-sm)">
                <thead>
                  <tr style="background:var(--bg); border-bottom:1px solid var(--border); color:var(--text2); font-weight:600">
                    <th style="padding:6px 8px">配方粉類</th>
                    ${tableHeaders}
                  </tr>
                </thead>
                <tbody>
                  ${tableRows}
                  ${totalRow}
                </tbody>
              </table>
            </div>

            <div style="margin-top:12px; font-size:14px; color:var(--text3); line-height:1.5">
              💡 <strong>今日出餐批次建議量：</strong><br>
              ${pw.batches.map(b => `• <strong>${b.label}</strong>：每批取總粉量 <strong>${b.per_batch}g</strong>`).join('<br>')}
            </div>
          </div>`;
      }
      let prepHtml = '';
      if (prod.staff_prep.length > 0) {
        prepHtml = `
          <div class="card">
            <div class="card-title">${esc(prod.staff_rx.code)} 鮮食備料（共 ${prod.total_staff_cups} ${unit}）
              <button class="prep-btag-toggle" onclick="App.togglePrepBatches()">
                ${showPrepBatches ? '收起分批量 ▴' : '看分批量 ▾'}
              </button>
            </div>
            ${prod.staff_prep.map(p => {
              // 秤料時看總量就夠，分批量是打的時候才看 —— 預設收起來，
              // 否則每一列都掛兩顆標籤，11 列就多出一倍高度
              const batchRow = (showPrepBatches && batches.length > 0)
                ? `<div class="prep-btag-row">${batches.map(b => {
                    const pb = Math.round(b.size * p.per_serving * 10) / 10;
                    return `<span class="prep-btag">${b.size}${unit}批 <strong>${pb}${p.unit}</strong></span>`;
                  }).join('')}</div>`
                : '';
              return `
              <div class="row">
                <span class="row-label">${esc(p.name)}${p.prep_note ? `<span class="prep-note">${esc(p.prep_note)}</span>` : ''}</span>
                <span class="row-value" style="font-weight:700">${p.total}${p.unit}
                  <span style="font-size:14px;color:var(--text3)">（${p.per_serving}${p.unit}/${unit}）</span>
                  ${batchRow}
                </span>
              </div>`;
            }).join('')}
          </div>`;
      }
      const sxc = prod.staff_rx_cases || [];
      const extraCups = prod.extra_cups || 0;
      let staffRxCaseAlert = '';
      if (sxc.length > 0) {
        const lines = sxc.map(c => {
          const mt = c.meal_time && c.meal_time.length === 4
            ? `${c.meal_time.slice(0,2)}:${c.meal_time.slice(2)}` : (c.meal_time || '');
          const who = c.patient_name ? `${esc(c.patient_name)}` : '（無姓名）';
          return `<span class="srx-item">${who} ${c.cups}${unit} 取餐 ${mt}</span>`;
        }).join('');
        staffRxCaseAlert = `
          <div class="srx-alert">
            <span class="srx-icon">📌</span>
            <span class="srx-label">個案使用員工配方</span>
            <div class="srx-list">${lines}</div>
          </div>`;
      }
      const cupsBreakdown = extraCups > 0
        ? `<span style="font-size:14px;color:var(--text2);font-weight:400">（員工 ${attendingCount} + 個案 ${extraCups}）</span>`
        : '';
      leftHtml = `
        <div class="batch-box">
          <div style="display:flex;gap:16px;align-items:flex-end;flex-wrap:wrap">
            <div><div class="num">${prod.total_staff_cups}</div><div class="label">共 ${prod.total_staff_cups} ${unit} ${cupsBreakdown}</div></div>
            <div style="font-size:28px;font-weight:800;opacity:.7">=</div>
            <div><div class="num" style="font-size:22px">${batchDesc || '—'}</div>
              <div class="label">員工批次（${esc(prod.staff_rx.code)}）</div>
            </div>
          </div>
          ${staffRxCaseAlert}
        </div>
        ${powderHtml}
        ${prepHtml}`;
    }

    // ── RIGHT：AW 個案配比總量（只計選了 AW 配方的出單）─────────────
    const awCases = prod.cases.filter(c => c.rx_name === 'AW');
    let rightHtml = '';
    if (awCases.length === 0) {
      rightHtml = `<div class="aw-empty">今日無全配方個案</div>`;
    } else {
      const awTotalCups = awCases.reduce((s, c) => s + c.cups, 0);
      const ingMap  = {};   // name → total
      const perMap  = {};   // name → per-cup
      const catOf   = {};
      const unitOf  = {};
      const catOrder = ['蔬菜','水果','粉類','保健品','油','水','其他'];

      awCases.forEach(c => {
        (c.prep || []).forEach(p => {
          if (!ingMap[p.name]) { ingMap[p.name] = 0; catOf[p.name] = p.category || '其他'; unitOf[p.name] = p.unit; }
          ingMap[p.name] = Math.round((ingMap[p.name] + p.total) * 10) / 10;
        });
        (c.powder?.items || []).forEach(p => {
          const pm = c.powder.powder_multiplier || 1;
          const t = Math.round(p.qty * c.cups * pm * 10) / 10;
          if (!ingMap[p.name]) { ingMap[p.name] = 0; catOf[p.name] = '粉類'; unitOf[p.name] = p.unit; }
          ingMap[p.name] = Math.round((ingMap[p.name] + t) * 10) / 10;
        });
        (c.supplements || []).forEach(s => {
          if (!ingMap[s.name]) { ingMap[s.name] = 0; catOf[s.name] = '保健品'; unitOf[s.name] = s.unit; }
          ingMap[s.name] = Math.round((ingMap[s.name] + s.total) * 10) / 10;
        });
      });

      // 每杯量 = 總量 ÷ 總杯數
      Object.keys(ingMap).forEach(name => {
        perMap[name] = Math.round(ingMap[name] / awTotalCups * 10) / 10;
      });

      const grouped = {};
      Object.keys(ingMap).forEach(name => {
        const cat = catOf[name] || '其他';
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push({ name, total: ingMap[name], per: perMap[name], unit: unitOf[name] || 'g' });
      });

      let rows = '';
      catOrder.forEach(cat => {
        const items = grouped[cat];
        if (!items || items.length === 0) return;
        rows += `<div class="aw-cat">${cat}</div>`;
        items.forEach(item => {
          rows += `<div class="row">
            <span class="row-label">${esc(item.name)}</span>
            <span class="row-value" style="font-weight:700">${item.total}<span style="font-size:14px;color:var(--text3)">${item.unit}</span>
              <span style="font-size:14px;color:var(--text3);font-weight:400;margin-left:4px">（${item.per}${item.unit}/杯）</span>
            </span></div>`;
        });
      });
      rightHtml = `
        <div class="aw-cups-badge">共 <strong>${awTotalCups}</strong> ${unit}</div>
        <div class="card" style="margin-top:8px;padding:4px 16px">${rows}</div>`;
    }

    // 備註欄：跟著日期走、全廚房共用。
    // 舊版存在 localStorage 且沒帶日期，昨天寫的備註今天還會留在畫面上
    const notesSection = `
      <div class="batch-notes-wrap">
        <div class="batch-notes-label">備註</div>
        <textarea class="batch-notes-area" rows="2"
          onchange="App.saveBatchNotes(${prod.id}, this.value)"
          placeholder="今日備料備註...">${esc(dayNotes[prod.id] || '')}</textarea>
      </div>`;

    // 今日個案出單改由「今日出餐順序」呈現，這裡不再重複列一次。
    // 個案資料仍要進 caseDataMap（禁忌確認、拿取等等會用到）
    prod.cases.forEach(c => { caseDataMap[c.id] = c; });

    // 預約出單（未來日期）按日期分組
    let futureHtml = '';
    if ((prod.future_cases || []).length === 0) {
      futureHtml = `<div class="empty" style="padding:12px 0"><div class="ei">📅</div>目前無預約出單</div>`;
    } else {
      const byDate = {};
      prod.future_cases.forEach(c => {
        if (!byDate[c.date]) byDate[c.date] = [];
        byDate[c.date].push(c);
      });
      Object.keys(byDate).sort().forEach(d => {
        const label = d.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1/$2/$3');
        futureHtml += `<div class="future-date-head">${label}</div>`;
        const dayTakeout = byDate[d].filter(c => c.powder_type !== '內用');
        const dayInuse   = byDate[d].filter(c => c.powder_type === '內用');
        if (dayTakeout.length > 0) {
          futureHtml += `<div class="case-group-head" style="margin-top:8px">🛍 外帶（${dayTakeout.length}）</div>`;
          futureHtml += dayTakeout.map(c => renderCaseCard(c, unit)).join('');
        }
        if (dayInuse.length > 0) {
          futureHtml += `<div class="case-group-head" style="margin-top:8px">🍽 內用（${dayInuse.length}）</div>`;
          futureHtml += dayInuse.map(c => renderCaseCard(c, unit)).join('');
        }
      });
    }

    return `
      <div class="product-section">
        <div class="product-header">
          <span class="product-tag">${esc(prod.name)}</span>
          <span class="product-hname">▌B 員工批次</span>
          <span class="product-unit-note">單位：${unit}</span>
        </div>
        <div class="batch-split">
          <div class="batch-col batch-col-left">
            <div class="batch-col-head">👩‍🍳 員工</div>
            ${leftHtml}
          </div>
          <div class="batch-col batch-col-right">
            <div class="batch-col-head">🫙 個案 AW</div>
            ${rightHtml}
          </div>
        </div>
        ${notesSection}

        <!-- 個案出單卡片已併入「今日出餐順序」：同一批資料不要兩種呈現。
             那條時間軸每一列都自帶 拿取／配方／菜單／編輯／刪除，
             而且精力湯和餐盒在同一條線上，出餐時本來就是一起端出去的 -->

        <div class="section-head" style="margin-top:24px">
          <span class="product-hname">▌D 預約出單</span>
          <button class="btn btn-ghost btn-sm" onclick="App.toggleFutureCases()">
            ${(prod.future_cases || []).length} 筆・${showFutureCases ? '收起 ▴' : '展開 ▾'}
          </button>
        </div>
        <!-- 未來 14 天的單不是今天要做的事，預設收起來 -->
        ${showFutureCases ? `<div class="future-cases-box">${futureHtml}</div>` : ''}
      </div>`;
  }

  // 個案配方的內容（蔬果分區、粉類、保健品）。出餐時間軸和預約出單都用這一份，
  // 不要各寫一次 —— 這正是這頁原本每個食材出現七次的原因
  function _caseRecipeBody(c, unit) {
    const pm = c.powder?.powder_multiplier || 1;
    const powderItems = c.powder?.items || [];
    const grid = (items, mapper) => `<div class="prep-grid">${items.map(mapper).join('')}</div>`;
    const prepGrid = items => grid(items, p => `
      <div class="prep-item">
        <div class="pi-name">${esc(p.name)}${p.prep_note ? `<span class="prep-note">${esc(p.prep_note)}</span>` : ''}</div>
        <div class="pi-val">${p.total}${p.unit}
          <span style="font-size:14px;color:var(--text3)">×${c.cups}${unit}</span></div>
      </div>`);
    const powderGrid = (items, mult) => grid(items, p => {
      const tot = Math.round(p.qty * c.cups * mult * 10) / 10;
      const note = mult > 1 ? ` <span style="font-size:10px;color:var(--orange)">×${mult}</span>` : '';
      return `<div class="prep-item">
        <div class="pi-name">${esc(p.name)}</div>
        <div class="pi-val">${tot}${p.unit}${note}
          <span style="font-size:14px;color:var(--text3)">×${c.cups}${unit}</span></div>
      </div>`;
    });

    let body = '';
    if (c.powder_type === '全配方') {
      const veg   = c.prep.filter(p => p.category === '蔬菜');
      const fruit = c.prep.filter(p => p.category === '水果');
      const oil   = c.prep.filter(p => p.category !== '蔬菜' && p.category !== '水果');
      if (veg.length)   body += `<div class="prep-storage-head">🥬 蔬菜 <span class="storage-badge cold">冷藏</span></div>${prepGrid(veg)}`;
      if (fruit.length) body += `<div class="prep-storage-head">🍎 水果 <span class="storage-badge freeze">冷凍</span></div>${prepGrid(fruit)}`;
      if (oil.length)   body += `<div class="prep-storage-head" style="margin-top:8px">🫒 油水</div>${prepGrid(oil)}`;
      if (powderItems.length) body += `<div class="prep-storage-head">🧪 粉類 <span class="storage-badge jar">罐裝 ×1.1</span></div>${powderGrid(powderItems, pm)}`;
    } else if (c.formula_type !== '粉配方' && c.prep.length > 0) {
      body = prepGrid(c.prep);
    } else if (c.formula_type === '粉配方' && powderItems.length > 0) {
      body = powderGrid(powderItems, pm);
    }
    if ((c.supplements || []).length > 0) {
      body += `<div class="supp-grid">${c.supplements.map(s => `
        <div class="supp-item">
          <div class="si-name">${esc(s.name)}</div>
          <div class="si-val">${s.total}${s.unit}</div>
        </div>`).join('')}</div>`;
    }
    return body;
  }

  function renderCaseCard(c, unit) {
    caseDataMap[c.id] = c;
    const warn = c.contraindications ? `<div class="warn-box">⚠ ${esc(c.contraindications)}</div>` : '';
    const mt = c.meal_time;
    const mStr = mt && mt.length === 4 ? `${mt.slice(0,2)}:${mt.slice(2)}` : (mt || '');
    const ptName = c.patient_name ? `<span class="case-patient">${esc(c.patient_name)}</span>` : '';
    const notesHtml = c.notes ? `<div class="case-notes">📝 ${esc(c.notes)}</div>` : '';

    // 出單方式 badge
    const typeIcons = { '袋裝': '🛍', '罐裝': '🫙', '全配方': '📦', '內用': '🍽' };
    const typeBadge = `<span class="case-dtype">${typeIcons[c.powder_type] || ''} ${esc(ptLabel(c.powder_type))}</span>`;

    let casePowderHtml = '';
    // 內用不顯示粉包行
    if (c.powder_type !== '內用' && c.powder && c.powder.per_serving > 0) {
      const ratioTip = c.powder.items.map(i => `${i.name} ${i.qty}${i.unit}`).join('、');
      const jarBadge = c.powder_type === '罐裝'
        ? ` <span class="cp-jar">🫙 罐裝 ×1.1</span>` : '';
      const perServDisp = c.powder_type === '罐裝'
        ? `${c.powder.per_serving_adj}g` : `${c.powder.per_serving}g`;
      casePowderHtml = `
        <div class="case-powder">
          <span class="cp-icon">🧪</span>
          <span class="cp-label">粉包</span>
          <span class="cp-val">${perServDisp}/${unit} × ${c.cups}${unit} = <strong>${c.powder.total}g</strong>${jarBadge}</span>
          <span class="cp-ratio">（${ratioTip}）</span>
        </div>`;
    }

    return `
      <div class="case-card ${c.formula_type === '粉配方' ? 'powder' : ''}">
        <div class="case-head">
          <div>
            <div class="case-name">${ptName}${esc(c.rx_name)}</div>
            <div class="case-meta">${esc(c.code)} ·
              <span class="badge ${c.formula_type==='全配方'?'badge-blue':'badge-purple'}">${esc(c.formula_type)}</span>
              · ${c.cups}${unit} · 取餐 ${mStr} · ${esc(c.timing)} · ${typeBadge}
            </div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-ghost btn-sm" title="用這位個案的處方熱量開啟套餐菜單"
              onclick="App.openCaseMenuFor(${c.prescription_id}, '${esc(c.powder_type || '袋裝')}')">🍱 菜單</button>
            <button class="btn btn-ghost btn-sm" onclick="App.openEditCase(${c.id})">編輯</button>
            <button class="btn btn-danger btn-sm" onclick="App.deleteCase(${c.id})">刪除</button>
          </div>
        </div>
        ${warn}
        ${notesHtml}
        ${casePowderHtml}
        ${(() => {
          // 用員工標準配方的個案：份量已經併進上方「員工批次」的備料總量，
          // 再攤開一次是重複，而且沒人會照個案卡片秤料
          if (c.is_staff_rx) return `<div class="case-inherit">份量已併入上方「員工批次」備料總量</div>`;
          const body = _caseRecipeBody(c, unit);
          if (!body) return '';
          const open = openCaseRecipes.has(c.id);
          return `
            <button class="case-recipe-toggle" onclick="App.toggleCaseRecipe(${c.id})">
              ${open ? '收起配方 ▴' : '配方明細 ▾'}
            </button>
            <div class="case-recipe${open ? ' open' : ''}">${body}</div>`;
        })()}
      </div>`;
  }

  // 展開／收合狀態只影響這台裝置的畫面，不進當日共用狀態。
  // 個案卡片與備料表都在 productSections 裡，要重繪的是這一塊
  // （renderTodaySection1 畫的是批次分組與出餐順序，不含這些）
  const openCaseRecipes = new Set();

  function _rerenderProducts() {
    const el = document.getElementById('productSections');
    if (!el || !lastTodayData) return;
    caseDataMap = {};
    el.innerHTML = lastTodayData.products
      .map(prod => renderProductSection(prod, lastTodayData.attending_count)).join('');
  }

  function toggleCaseRecipe(id) {
    if (openCaseRecipes.has(id)) openCaseRecipes.delete(id);
    else openCaseRecipes.add(id);
    _rerenderProducts();
    // 配方現在也可以從出餐時間軸展開，那一區要一起重畫
    if (lastTodayData) {
      const el = document.getElementById('todaySchedule');
      if (el) el.innerHTML = _renderSchedule(lastTodayData);
    }
  }
  function setSchFilter(v) {
    schFilter = v;
    if (lastTodayData) {
      const el = document.getElementById('todaySchedule');
      if (el) el.innerHTML = _renderSchedule(lastTodayData);
    }
  }
  function togglePrepBatches() { showPrepBatches = !showPrepBatches; _rerenderProducts(); }
  function toggleFutureCases() { showFutureCases = !showFutureCases; _rerenderProducts(); }

  async function toggleAttendance(userId, newVal) {
    await api(`/api/today/attendance/${userId}`, 'PUT', { attending: newVal });
    loadToday();
  }

  async function deleteCase(id) {
    if (!confirm('確定刪除此筆出單？')) return;
    await api(`/api/today/cases/${id}`, 'DELETE');
    loadToday();
  }

  let _caseRxList = [];

  // 選了哪一張，就把它的內容攤開來。
  // 只看代號和名字，看不出「這張到底裝了什麼」，也就無從發現選錯了
  async function _renderCaseRxPreview() {
    const box = document.getElementById('caseRxPreview');
    const sel = document.getElementById('caseRxSel');
    if (!box || !sel) return;
    const rx = _caseRxList.find(r => r.id == sel.value);
    if (!rx) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="rxp-load">載入配方…</div>';
    try {
      const n = await api('/api/nutrition/prescription/' + rx.id);
      const items = (n.breakdown || []).filter(b => (b.qty ?? b.qty_per_cup) > 0);
      const main = items.slice(0, 8)
        .map(b => `${esc(b.name)} ${b.qty ?? b.qty_per_cup}${esc(b.unit || 'g')}`).join('、');
      box.innerHTML = `<div class="rxp">
        <div class="rxp-head">${esc(rx.code)}　${esc(rx.name)}${
          rx.is_staff_rx ? '<span class="rxp-tag">員工配方</span>' : ''}${
          rx.produce_plan_group ? '<span class="rxp-tag plan">跟著蔬果方案輪替</span>' : ''}</div>
        <div class="rxp-sum">${items.length} 樣・${n.kcal} kcal・蛋白質 ${n.protein_g}g</div>
        <div class="rxp-items">${esc(main)}${items.length > 8 ? `…另 ${items.length - 8} 樣` : ''}</div>
        ${rx.contraindications ? `<div class="rxp-warn">⚠ ${esc(rx.contraindications)}</div>` : ''}
      </div>`;
    } catch (e) { box.innerHTML = ''; }
  }

  // 打了姓名就去比對有沒有他自己的處方。
  // 有自己的處方卻掛員工配方，做出來的東西是錯的，而且沒有人會發現
  function _matchCaseRxByName() {
    const name = (document.getElementById('casePatientName').value || '').trim();
    const hint = document.getElementById('caseRxMatch');
    const sel  = document.getElementById('caseRxSel');
    if (!hint || !sel) return;
    if (!name) { hint.innerHTML = ''; return; }
    const own = _caseRxList.find(r => String(r.name).trim() === name);
    if (!own) {
      hint.innerHTML = `<span class="rxm none">「${esc(name)}」沒有自己的處方</span>`;
      return;
    }
    if (sel.value == own.id) {
      hint.innerHTML = `<span class="rxm ok">✓ 用的是他自己的處方</span>`;
    } else {
      hint.innerHTML = `<span class="rxm warn">「${esc(name)}」有自己的處方 ${esc(own.code)}
        <button type="button" onclick="App.useOwnRx(${own.id})">改用</button></span>`;
    }
  }

  function useOwnRx(id) {
    const sel = document.getElementById('caseRxSel');
    sel.value = String(id);
    sel.dispatchEvent(new Event('change'));
    _matchCaseRxByName();
  }

  async function _buildCaseRxSel(productId, selectedRxId) {
    const rxs = await api('/api/prescriptions');
    _caseRxList = rxs;
    const sel = document.getElementById('caseRxSel');
    const byProduct = {};
    rxs.forEach(r => {
      const key = r.product_name || '未分類';
      if (!byProduct[key]) byProduct[key] = [];
      byProduct[key].push(r);
    });
    sel.innerHTML = Object.entries(byProduct).map(([pname, list]) => `
      <optgroup label="${esc(pname)}">
        ${list.map(r => {
          const staffTag = r.is_staff_rx ? ' ★員工' : '';
          const isSel = selectedRxId ? r.id == selectedRxId : r.product_id == productId && !r.is_staff_rx;
          return `<option value="${r.id}" ${isSel?'selected':''}>${esc(r.code)} — ${esc(r.name)}${staffTag} (${esc(r.formula_type)})</option>`;
        }).join('')}
      </optgroup>`).join('');
    const updateLabel = () => {
      const chosen = rxs.find(r => r.id == sel.value);
      document.getElementById('caseCupsLabel').textContent = chosen ? `份數（${chosen.product_unit||'份'}）` : '份數';
    };
    sel.onchange = () => { updateLabel(); _renderCaseRxPreview(); _matchCaseRxByName(); };
    updateLabel();
    _renderCaseRxPreview();
    const nameInput = document.getElementById('casePatientName');
    if (nameInput) nameInput.oninput = _matchCaseRxByName;
    _matchCaseRxByName();
    return rxs;
  }

  async function openAddCase(productId) {
    document.getElementById('caseEditId').value = '';
    document.getElementById('caseModalTitle').textContent = '新增個案出單';
    await _buildCaseRxSel(productId, null);
    document.getElementById('casePatientName').value = '';
    document.getElementById('caseNotes').value = '';
    document.getElementById('caseCups').value = '1';
    document.getElementById('caseMealTime').value = '1330';
    document.getElementById('caseDate').value = new Date().toISOString().slice(0, 10);
    const bagRadio = document.querySelector('input[name="casePowderType"][value="袋裝"]');
    if (bagRadio) bagRadio.checked = true;
    const del = document.getElementById('caseDeleteBtn');
    if (del) del.style.display = 'none';
    openModal('modalAddCase');
  }

  async function openEditCase(id) {
    const c = caseDataMap[id];
    if (!c) return;
    document.getElementById('caseEditId').value = id;
    document.getElementById('caseModalTitle').textContent = '編輯出單';
    await _buildCaseRxSel(null, c.prescription_id);
    document.getElementById('casePatientName').value = c.patient_name || '';
    document.getElementById('caseCups').value = c.cups;
    document.getElementById('caseMealTime').value = c.meal_time || '1330';
    document.getElementById('caseNotes').value = c.notes || '';
    document.getElementById('caseDate').value = c.date || new Date().toISOString().slice(0, 10);
    const radio = document.querySelector(`input[name="casePowderType"][value="${c.powder_type||'袋裝'}"]`);
    if (radio) radio.checked = true;
    // 刪除只在編輯既有出單時出現，新增時沒有東西可刪
    const del = document.getElementById('caseDeleteBtn');
    if (del) { del.style.display = ''; del.onclick = () => { closeModal('modalAddCase'); deleteCase(id); }; }
    openModal('modalAddCase');
  }

  async function addCase() {
    const editId = document.getElementById('caseEditId').value;
    const prescription_id = document.getElementById('caseRxSel').value;
    const cups = parseInt(document.getElementById('caseCups').value) || 1;
    const meal_time = document.getElementById('caseMealTime').value || '1330';
    const notes = document.getElementById('caseNotes').value;
    const powder_type = document.querySelector('input[name="casePowderType"]:checked')?.value || '袋裝';
    const patient_name = document.getElementById('casePatientName').value.trim();
    const date = document.getElementById('caseDate').value || new Date().toISOString().slice(0, 10);
    const payload = { prescription_id, cups, meal_time, powder_type, patient_name, notes, date };
    if (editId) {
      await api(`/api/today/cases/${editId}`, 'PUT', payload);
    } else {
      await api('/api/today/cases', 'POST', payload);
    }
    closeModal('modalAddCase');
    loadToday();
    // 儲存後重跑庫存檢查，更新警示 badge
    checkInvWarning();
  }

  // ── 處方管理 ────────────────────────────────────────────
  async function loadRx() {
    const [rxList, costData] = await Promise.all([api('/api/prescriptions'), api('/api/costs')]);
    allPrescriptions = rxList;
    const costMap = {};
    (costData.prescriptions || []).forEach(p => { costMap[p.id] = p; });

    const list = document.getElementById('rxList');

    // 按產品分組
    const byProduct = {};
    allPrescriptions.forEach(rx => {
      const key = rx.product_name || '未分類';
      if (!byProduct[key]) byProduct[key] = [];
      byProduct[key].push(rx);
    });

    if (allPrescriptions.length === 0) {
      list.innerHTML = '<div class="empty"><div class="ei">💊</div>尚無處方</div>';
      return;
    }

    list.innerHTML = Object.entries(byProduct).map(([pname, rxs]) => `
      <div class="rx-product-group">
        <div class="rx-product-label">📦 ${esc(pname)}</div>
        ${rxs.map(rx => {
          const cost = costMap[rx.id];
          const costHtml = cost
            ? `<div style="margin-top:6px;font-size:12px;color:var(--text2)">
                🧺 食材 <strong style="color:var(--blue)">NT$${cost.ingredient_cost}</strong>/份
                &nbsp;+&nbsp; 人工 <strong>NT$${cost.labor_cost}</strong>
                &nbsp;= <strong style="color:var(--text)">NT$${cost.total_cost}</strong>
                ${cost.ingredient_cost === 0 ? '<span style="color:var(--orange);font-size:11px">（尚無採購記錄）</span>' : ''}
               </div>`
            : '';
          return `
          <div class="rx-card">
            <div style="display:flex;justify-content:space-between;align-items:flex-start">
              <div>
                <div class="rx-code">${esc(rx.code)}
                  ${rx.is_staff_rx ? '<span class="badge badge-green" style="font-size:11px;margin-left:6px">員工標準</span>' : ''}
                </div>
                <div class="rx-name">${esc(rx.name)}</div>
                <div class="rx-meta">
                  <span class="badge ${rx.formula_type==='全配方'?'badge-blue':'badge-purple'}">${esc(rx.formula_type)}</span>
                  · ${esc(rx.timing)}
                  ${rx.contraindications ? `· <span style="color:var(--orange)">⚠ ${esc(rx.contraindications)}</span>` : ''}
                </div>
                ${costHtml}
              </div>
              <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
                <button class="btn btn-ghost btn-sm" onclick="App.openRxHistory(${rx.id},'${esc(rx.code)}','${esc(rx.name)}')">異動紀錄</button>
                <button class="btn btn-ghost btn-sm" onclick="App.duplicateRx(${rx.id},'${esc(rx.code)}','${esc(rx.name)}')">複製</button>
                <button class="btn btn-ghost btn-sm" onclick="App.openEditRx(${rx.id})">編輯資訊</button>
                <button class="btn btn-primary btn-sm" onclick="App.openEditRxIngredients(${rx.id},'${esc(rx.name)}')">編輯配方</button>
              </div>
            </div>
          </div>`;
        }).join('')}
      </div>`).join('');
  }

  async function _fillProductSel(selectedId) {
    const products = await api('/api/products');
    const sel = document.getElementById('rxProductId');
    sel.innerHTML = products.filter(p => p.active).map(p =>
      `<option value="${p.id}" ${p.id==selectedId?'selected':''}>${esc(p.name)}</option>`
    ).join('');
    return products;
  }

  async function openAddRx() {
    await _fillProductSel(1);
    document.getElementById('modalRxTitle').textContent = '新增處方';
    document.getElementById('rxEditId').value = '';
    document.getElementById('rxIsStaff').value = '0';
    document.getElementById('rxCode').value = '';
    document.getElementById('rxName').value = '';
    document.getElementById('rxType').value = '粉配方';
    document.getElementById('rxTiming').value = '餐前';
    document.getElementById('rxContra').value = '';
    document.getElementById('rxDailyCups').value  = 0;
    document.getElementById('rxBufferCups').value = 0;
    const delBtn = document.getElementById('rxDelBtn');
    if (delBtn) delBtn.style.display = 'none';
    openModal('modalRx');
  }

  // 很多個案的內用配方跟員工／AW 幾乎一樣，只差益生菌那幾樣。
  // 從頭建要填二十幾行，複製再微調快得多
  // 配方改了誰都看得到。這裡是具名個案的醫療配方 ——
  // 2026-06 那次「去皮」變「純皮」語意翻轉，是靠翻 git log 才查出來的
  async function openRxHistory(id, code, name) {
    document.getElementById('rxHistTitle').textContent = `${code}　${name}`;
    const el = document.getElementById('rxHistList');
    el.innerHTML = '<div class="hist-empty">載入中…</div>';
    openModal('modalRxHistory');
    try {
      const h = await api('/api/prescriptions/' + id + '/history');
      document.getElementById('rxHistCount').textContent = `共 ${h.total} 次異動`;
      el.innerHTML = h.rows.length ? h.rows.map(r => `
        <div class="hist-row">
          <div class="hist-head">
            <span class="hist-when">${esc((r.changed_at || '').slice(0, 16))}</span>
            <span class="hist-by">${esc(r.by)}</span>
            <span class="hist-kind">${esc(r.change_type)}</span>
          </div>
          <div class="hist-sum">${esc(r.summary)}</div>
        </div>`).join('')
        : `<div class="hist-empty">還沒有任何異動紀錄。<br>
             <small>從現在起，改配方都會留下「誰、什麼時候、從幾克改成幾克」。</small></div>`;
    } catch (e) {
      el.innerHTML = '<div class="hist-empty">載不到異動紀錄</div>';
    }
  }

  async function duplicateRx(id, srcCode, srcName) {
    const code = prompt(`複製「${srcName}」（${srcCode}）\n\n新處方的代號：`, '');
    if (!code || !code.trim()) return;
    const name = prompt('新處方的名稱（個案姓名）：', srcName + ' 複本');
    if (name === null) return;
    try {
      const r = await api(`/api/prescriptions/${id}/duplicate`, 'POST',
                          { code: code.trim(), name: (name || '').trim() });
      await loadRx();
      // 複製出來的是獨立的一份，之後改來源不會跟著變 —— 這點要講清楚，
      // 否則有人會以為改了員工配方，複製出去的那幾張也會跟著改
      alert(`已建立 ${r.code}「${r.name}」，複製了 ${r.copied_items} 項用料。\n` +
            (r.produce_plan_group ? '蔬果方案跟著沿用，會隨輪替自動換。\n' : '') +
            '這是獨立的一份：之後改 ' + r.from_code + ' 不會連帶改到它。');
      openEditRxIngredients(r.id, r.name);
    } catch (e) { alert(e.message); }
  }

  async function openEditRx(id) {
    const rx = allPrescriptions.find(r => r.id === id);
    if (!rx) return;
    await _fillProductSel(rx.product_id);
    document.getElementById('modalRxTitle').textContent = '編輯處方資訊';
    document.getElementById('rxEditId').value = id;
    document.getElementById('rxIsStaff').value = rx.is_staff_rx ? '1' : '0';
    document.getElementById('rxCode').value = rx.code;
    document.getElementById('rxName').value = rx.name;
    document.getElementById('rxType').value = rx.formula_type;
    document.getElementById('rxTiming').value = rx.timing;
    document.getElementById('rxContra').value = rx.contraindications || '';
    document.getElementById('rxDailyCups').value  = rx.daily_cups  || 0;
    document.getElementById('rxBufferCups').value = rx.buffer_cups || 0;
    const delBtn = document.getElementById('rxDelBtn');
    if (delBtn) delBtn.style.display = 'block';
    openModal('modalRx');
  }

  async function deleteRx() {
    const id = document.getElementById('rxEditId').value;
    if (!id) return;
    if (!confirm('確定要刪除此處方？')) return;
    try {
      await api(`/api/prescriptions/${id}`, 'DELETE');
      closeModal('modalRx');
      loadRx();
    } catch(e) {
      alert('刪除處方失敗');
    }
  }

  async function saveRx() {
    const id = document.getElementById('rxEditId').value;
    const data = {
      product_id:        parseInt(document.getElementById('rxProductId').value),
      is_staff_rx:       document.getElementById('rxIsStaff').value === '1' ? 1 : 0,
      code:              document.getElementById('rxCode').value.trim(),
      name:              document.getElementById('rxName').value.trim(),
      formula_type:      document.getElementById('rxType').value,
      timing:            document.getElementById('rxTiming').value,
      contraindications: document.getElementById('rxContra').value.trim(),
      daily_cups:        parseFloat(document.getElementById('rxDailyCups').value)  || 0,
      buffer_cups:       parseFloat(document.getElementById('rxBufferCups').value) || 0,
      active: 1
    };
    if (!data.code || !data.name) return alert('請填寫處方代號和名稱');
    try {
      if (id) {
        await api(`/api/prescriptions/${id}`, 'PUT', data);
      } else {
        await api('/api/prescriptions', 'POST', data);
      }
      closeModal('modalRx');
      loadRx();
    } catch(e) {
      alert('儲存失敗：' + e.message);
    }
  }

  // ── 產品管理 ────────────────────────────────────────────
  let allProducts = [];

  async function openAddProduct() {
    allProducts = await api('/api/products');
    // 用 alert-style 簡易列表 + modal 新增
    const existing = allProducts.map((p,i) =>
      `${i+1}. ${p.name}（${p.unit}，批次${p.batch_size}）<button onclick="App.openEditProduct(${p.id})" style="margin-left:8px;cursor:pointer;background:none;border:1px solid var(--blue);border-radius:6px;padding:2px 8px;color:var(--blue)">編輯</button>`
    ).join('<br>');
    document.getElementById('productListPreview').innerHTML = existing || '（尚無其他產品）';
    document.getElementById('modalProductTitle').textContent = '新增產品';
    document.getElementById('productEditId').value = '';
    document.getElementById('productName').value = '';
    document.getElementById('productUnit').value = '份';
    document.getElementById('productBatch').value = '1';
    document.getElementById('productDesc').value = '';
    openModal('modalProduct');
  }

  async function openEditProduct(id) {
    const p = allProducts.find(x => x.id === id);
    if (!p) return;
    document.getElementById('modalProductTitle').textContent = '編輯產品';
    document.getElementById('productEditId').value = id;
    document.getElementById('productName').value = p.name;
    document.getElementById('productUnit').value = p.unit;
    document.getElementById('productBatch').value = p.batch_size;
    document.getElementById('productDesc').value = p.description || '';
  }

  async function saveProduct() {
    const id = document.getElementById('productEditId').value;
    const data = {
      name:       document.getElementById('productName').value.trim(),
      unit:       document.getElementById('productUnit').value.trim() || '份',
      batch_size: parseInt(document.getElementById('productBatch').value) || 1,
      description: document.getElementById('productDesc').value.trim(),
      active: 1
    };
    if (!data.name) return alert('請填寫產品名稱');
    if (id) {
      await api(`/api/products/${id}`, 'PUT', data);
    } else {
      await api('/api/products', 'POST', data);
    }
    closeModal('modalProduct');
    loadRx();
    loadToday();
  }

  async function openEditRxIngredients(rxId, rxName) {
    document.getElementById('modalRxIngTitle').textContent = `編輯配方：${rxName}`;
    document.getElementById('rxIngEditId').value = rxId;
    const items = await api(`/api/prescriptions/${rxId}/ingredients`);
    allIngredients = items;

    const cats = ['蔬菜','水果','粉類','保健品','油','水','其他'];
    let html = '';
    cats.forEach(cat => {
      const catItems = items.filter(i => i.category === cat || (cat === '油' && i.category === '油水'))
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
      if (catItems.length === 0) return;
      html += `<div class="ie-cat">${cat}</div>`;
      catItems.forEach(i => {
        html += `
          <div class="ie-row">
            <span>${esc(i.name)}</span>
            <span style="font-size:12px;color:var(--text2)">${i.unit}/份</span>
            <input type="number" min="0" step="0.1" value="${i.qty_per_cup}"
              data-ing-id="${i.id}" id="ing_${i.id}">
            <input type="text" class="ie-prep" value="${esc(i.prep || '')}"
              data-prep-for="${i.id}" placeholder="處理方式"
              title="同一種食材的不同處理方式（帶皮／去皮／打泥…）寫在這裡，不要另外建一個食材">
          </div>`;
      });
      html += `
        <div class="ie-row ie-custom-row" data-cat="${cat}">
          <input type="text" class="ie-custom-name" placeholder="自填食材名稱" style="flex:1;border:1px solid var(--border);border-radius:6px;padding:3px 8px;font-size:13px;background:var(--bg2)">
          <span style="font-size:12px;color:var(--text2)">g/份</span>
          <input type="number" min="0" step="0.1" value="0" class="ie-custom-qty" style="width:64px;border:1px solid var(--border);border-radius:6px;padding:3px 6px;font-size:13px;text-align:right">
        </div>`;
    });
    document.getElementById('ingredientEditor').innerHTML = html;
    openModal('modalRxIngredients');
  }

  async function saveRxIngredients() {
    const rxId = document.getElementById('rxIngEditId').value;
    const inputs = document.querySelectorAll('#ingredientEditor input[data-ing-id]');
    const items = Array.from(inputs).map(inp => ({
      ingredient_id: parseInt(inp.dataset.ingId),
      qty_per_cup: parseFloat(inp.value) || 0,
      prep: (document.querySelector(`[data-prep-for="${inp.dataset.ingId}"]`) || {}).value || ''
    }));
    // 處理自填行：查找 allIngredients 中是否有同名食材
    const customRows = document.querySelectorAll('#ingredientEditor .ie-custom-row');
    customRows.forEach(row => {
      const name = row.querySelector('.ie-custom-name').value.trim();
      const qty = parseFloat(row.querySelector('.ie-custom-qty').value) || 0;
      if (name && qty > 0) {
        const match = (allIngredients || []).find(i => i.name === name);
        if (match) {
          const existing = items.find(it => it.ingredient_id === match.id);
          if (existing) existing.qty_per_cup = qty;
          else items.push({ ingredient_id: match.id, qty_per_cup: qty });
        }
      }
    });
    await api(`/api/prescriptions/${rxId}/ingredients`, 'PUT', items);
    closeModal('modalRxIngredients');
    loadRx();
    loadToday();
    alert('配方已儲存');
  }

  // ── 逐日庫存預測 ────────────────────────────────────────
  // 備料的人打開庫存頁要問三件事：這批要備多少、撐到哪一天、換方案前要先叫什麼。
  // 逐項現況是查證用的，放在後面
  let fcShowAll = false;
  let fcShowAllSwitch = false;   // 換組預警的完整清單

  function _fcDow(n) { return ['日','一','二','三','四','五','六'][n]; }
  function _fcMd(d)  { return d.slice(5).replace('-', '/'); }

  // 備料：一次把整段期間的量做成 N 份冷凍核心包。
  // 這一頁要回答兩件事：這批要秤多少、現在還剩幾份
  let _prepServings = null;

  async function openPrep() {
    document.getElementById('prepList').innerHTML = '<div class="pp-load">計算中…</div>';
    openModal('modalPrep');
    await _renderPrep();
  }

  async function _renderPrep(servings) {
    const box = document.getElementById('prepList');
    let ws;
    try {
      ws = await api('/api/prep/worksheet' + (servings > 0 ? '?servings=' + servings : ''));
    } catch (e) { box.innerHTML = '<div class="pp-load">' + esc(e.message) + '</div>'; return; }

    _prepServings = servings > 0 ? servings : ws.suggested_servings;
    document.getElementById('prepServings').value = _prepServings;
    document.getElementById('prepPlan').textContent = ws.plan ? ws.plan.name : '—';

    const st = ws.status || {};
    document.getElementById('prepStatus').innerHTML = st.made
      ? `目前備品：做了 <b>${st.made}</b> 份，已出 ${st.used} 份，<b>還剩 ${st.remaining} 份</b>`
      : '目前沒有備品（還沒備過料，或已全部用完）';

    if (!ws.items.length) {
      box.innerHTML = '<div class="pp-load">這個方案沒有標成「冷凍包」的用料。</div>';
      return;
    }
    box.innerHTML = `
      <table class="pp-table">
        <tr><th>食材</th><th>每份</th><th>要秤</th><th>現有</th></tr>
        ${ws.items.map(i => `
          <tr class="${i.short > 0 ? 'pp-short' : ''}">
            <td>${esc(i.name)}${i.prep ? `<div class="pp-prep">${esc(i.prep)}</div>` : ''}</td>
            <td class="num">${i.per_serving}${esc(i.unit)}</td>
            <td class="num pp-need">${i.need}${esc(i.unit)}</td>
            <td class="num">${i.have}${i.short > 0 ? `<span class="pp-gap">差 ${i.short}</span>` : ''}</td>
          </tr>`).join('')}
      </table>`;
  }

  function changePrepServings(v) {
    const n = Number(v);
    if (n > 0) _renderPrep(n);
  }

  async function savePrepBatch() {
    const n = Number(document.getElementById('prepServings').value);
    if (!(n > 0)) return alert('要做幾份？');
    if (!confirm(`記錄備料 ${n} 份？\n\n會把冷凍包那幾樣的原料扣掉 —— 它們已經變成備品了。\n記錯可以還原。`)) return;
    try {
      const r = await api('/api/prep/batch', 'POST', { servings: n });
      alert(`已記錄 ${r.servings} 份（${r.plan}）。` + (r.warning ? `\n\n⚠ ${r.warning}` : ''));
      closeModal('modalPrep');
      loadInventory();
    } catch (e) { alert(e.message); }
  }

  async function renderForecast() {
    const el = document.getElementById('invForecast');
    if (!el) return;
    let f;
    try { f = await api('/api/inventory/forecast?days=28'); }
    catch (e) { el.innerHTML = ''; return; }

    // 順序照「多急」排，不是照資料結構排：
    //   1 做不做得出來（今天／明天）　2 這批要買　3 換方案前要叫　4 兩週節奏
    // 原本把 14 天後的換方案警告放最上面，而最急的「明天做不出來」根本沒顯示
    const cards = [];

    // ── 1. 做不出來的日子 ──
    const fsd = f.first_short;
    if (fsd) {
      const when = _fcWhen(f.date, fsd.date);
      const top = fsd.short.slice(0, 6);
      cards.push(`
      <div class="fc-card fc-blocked">
        <h3>⚠ ${esc(when)}做不出來</h3>
        <div class="fc-sub">${esc(fsd.plan_name || '')} ${fsd.cups} 杯，${fsd.short.length} 樣不夠</div>
        <div class="fc-chips">
          ${top.map(x => `<span class="fc-chip short">${esc(x.name)} 缺 ${x.gap}${esc(x.unit)}</span>`).join('')}
          ${fsd.short.length > 6 ? `<span class="fc-chip">…另 ${fsd.short.length - 6} 樣</span>` : ''}
        </div>
      </div>`);
    } else {
      cards.push(`
      <div class="fc-card fc-ok">
        <h3>✓ 接下來的量都夠</h3>
        <div class="fc-sub">未來 ${f.horizon_days} 天排定的杯數，現有庫存都做得出來。</div>
      </div>`);
    }

    // ── 2. 這批要買 ──
    const buy = f.ingredients.filter(i => i.buy > 0);
    const shown = fcShowAll ? buy : buy.slice(0, 8);
    cards.push(`
      <div class="fc-card">
        <h3>這一批要備到 ${_fcMd(f.prep_window.to)}（${f.prep_window.days} 天）</h3>
        <div class="fc-sub">
          下一個盤點日是 ${_fcMd(f.prep_window.to)}，中間沒人盤點，要一次備足。
          緩衝抓 ${f.buffer.pct}% 或 ${f.buffer.cups} 杯份（突發外帶）的大者。
        </div>
        ${buy.length ? `
        <div class="fc-scroll"><table class="fc-table">
          <tr><th>食材</th><th>現有</th><th>這批要用</th><th>緩衝</th><th>要買</th><th>見底</th></tr>
          ${shown.map(i => `
          <tr>
            <td>${esc(i.name)}${i.below_safety ? ' <span class="fc-out">低於安全量</span>' : ''}</td>
            <td class="num">${i.stock}</td>
            <td class="num">${i.need_window}</td>
            <td class="num">${i.buffer}</td>
            <td class="num fc-buy">${i.buy}${esc(i.unit)}</td>
            <td class="num">${i.runs_out_on ? `<span class="fc-out">${_fcMd(i.runs_out_on)}</span>` : '—'}</td>
          </tr>`).join('')}
        </table></div>
        ${buy.length > 8 ? `<button class="fc-more" onclick="App.toggleForecastAll()">${
          fcShowAll ? '收起' : `還有 ${buy.length - 8} 樣・展開 ▾`}</button>` : ''}
        <a class="fc-go" href="/market.html">🛒 帶著這張去買</a>`
        : '<div class="fc-sub" style="margin-top:8px">這一批的量都夠，不用叫貨。</div>'}
      </div>`);

    // ── 3. 換方案前要先叫 ──
    const w = f.switch_warning;
    if (w && w.missing.length) {
      const list = fcShowAllSwitch ? w.missing : w.missing.slice(0, 6);
      cards.push(`
      <div class="fc-card fc-switch">
        <h3>${_fcMd(w.date)} 換${esc(w.to)}（還有 ${w.days_ahead} 天）</h3>
        <div class="fc-sub">
          這些在${esc(w.from)}期間完全用不到，所以平常不會有缺貨警告。
          數量是撐到 ${_fcMd(w.cover_to)} 為止的量。
        </div>
        <div class="fc-chips">
          ${list.map(m => `<span class="fc-chip short">${esc(m.name)} 缺 ${m.gap}${esc(m.unit || 'g')}</span>`).join('')}
        </div>
        ${w.missing.length > 6 ? `<button class="fc-more" onclick="App.toggleSwitchAll()">${
          fcShowAllSwitch ? '收起' : `還有 ${w.missing.length - 6} 樣・展開全部 ▾`}</button>` : ''}
      </div>`);
    }

    // ── 4. 兩週節奏 ──
    let plans = { plans: [], is_override: false };
    try { plans = await api('/api/rotation/plans'); } catch (e) {}
    const other = (plans.plans || []).find(p => !f.plan_today || p.code !== f.plan_today.code);
    const first = f.days[0] && f.days[0].plan_code;
    cards.push(`
      <div class="fc-card">
        <h3>接下來兩週</h3>
        ${f.packs && f.packs.made ? `<div class="fc-packs">冷凍核心包：還剩 <b>${f.packs.remaining}</b> 份（做了 ${f.packs.made}、已出 ${f.packs.used}）</div>` : ''}
        <div class="fc-sub">
          目前是 <b>${esc(f.plan_today ? f.plan_today.name : '—')}</b>
          <span class="fc-mode${plans.is_override ? ' manual' : ''}">${plans.is_override ? '手動指定' : '自動'}</span>
          　紅底＝做不出來　橘框＝員工餐日　底線＝盤點日
        </div>
        <div class="fc-plan-act">
          ${plans.is_override
            ? `<button class="fc-more" onclick="App.clearPlanOverride()">改回自動輪替</button>`
            : (other ? `<button class="fc-more" onclick="App.setPlanOverride(${other.id},'${esc(other.name)}')">這一期改用${esc(other.name)}</button>` : '')}
        </div>
        <div class="fc-days">
          ${f.days.slice(0, 14).map(d => `
            <div class="fc-day${d.is_staff_meal_day ? ' meal' : ''}${d.is_stocktake_day ? ' st' : ''}${
                 d.plan_code !== first ? ' swap' : ''}${d.cups > 0 && !d.feasible ? ' bad' : ''}"
                 title="${d.cups > 0 && !d.feasible ? '缺 ' + d.short.length + ' 樣' : ''}">
              <b>${_fcMd(d.date)}</b>週${_fcDow(d.dow)}
              <div>${d.cups ? d.cups + '杯' : '—'}</div>
            </div>`).join('')}
        </div>
      </div>`);

    el.innerHTML = '<div class="fc-wrap">' + cards.join('') + '</div>';
  }

  // 「今天」「明天」比日期好讀 —— 這一段是要讓人一眼知道有多急
  function _fcWhen(today, date) {
    const diff = Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
    if (diff <= 0) return '今天';
    if (diff === 1) return '明天';
    return _fcMd(date) + '（' + diff + ' 天後）';
  }

  async function setPlanOverride(planId, name) {
    if (!confirm(`把這一期改成「${name}」？\n\n影響備料量、採購清單與庫存預測。\n之後可以改回自動。`)) return;
    try {
      const r = await api('/api/rotation/plan/override', 'POST', { plan_id: planId });
      alert(`${r.date_from} 到 ${r.date_to} 改用${r.plan}。\n這段期間過後會自己回到輪替。` +
            (r.warning ? `\n\n⚠ ${r.warning}。` : ''));
      renderForecast(); loadInventory();
    } catch (e) { alert(e.message); }
  }

  async function clearPlanOverride() {
    if (!confirm('改回照日期自動輪替？')) return;
    try {
      const p = await api('/api/rotation/plans');
      for (const o of (p.overrides || [])) await api('/api/rotation/plan/override/' + o.id, 'DELETE');
      renderForecast(); loadInventory();
    } catch (e) { alert(e.message); }
  }

  function toggleForecastAll() { fcShowAll = !fcShowAll; renderForecast(); }
  function toggleSwitchAll()   { fcShowAllSwitch = !fcShowAllSwitch; renderForecast(); }

  // ── 庫存管理 ────────────────────────────────────────────
  async function loadInventory() {
    renderForecast();          // 不等它，庫存清單先出來
    const [items, checkRes] = await Promise.all([
      api('/api/inventory'),
      api('/api/inventory/check')
    ]);
    // Build shortage map by ingredient_id
    const shortageMap = {};
    (checkRes.check || []).forEach(c => { shortageMap[c.ingredient_id] = c; });

    // Update global warning badge
    updateInvWarningBadge(checkRes.insufficient_count || 0);

    const cats = ['蔬菜','水果','粉類','保健品','油','水','其他'];
    let html = '';
    cats.forEach(cat => {
      const catItems = items.filter(i => i.category === cat || (cat === '油' && i.category === '油水'))
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
      if (catItems.length === 0) return;
      html += `<div class="cat-header">${cat}</div>`;
      html += '<div class="card" style="padding:0 16px">';
      catItems.forEach(i => {
        const chk = shortageMap[i.id];
        let statusBadge = '';
        if (chk) {
          if (!chk.sufficient) {
            const short = Math.round((chk.needed - chk.stock) * 10) / 10;
            statusBadge = `<span class="badge badge-red inv-shortage-badge">🔴 缺 ${short}${i.unit}</span>`;
          } else {
            const pct = chk.needed > 0 ? chk.stock / chk.needed : null;
            if (pct !== null && pct < 1.3) statusBadge = '<span class="badge badge-orange">⚠ 偏低</span>';
            else if (chk.needed > 0) statusBadge = '<span class="badge badge-green">✅ 充足</span>';
          }
        }
        const needInfo = chk && chk.needed > 0
          ? `<div class="inv-need-row">7天需求 ${chk.needed}${i.unit}，剩餘 <strong style="color:${chk.sufficient?'var(--green)':'var(--red)'}">${chk.remaining}${i.unit}</strong></div>`
          : '';
        // 顆換算：有 count_unit 的食材（蘋果、帶皮檸檬）
        const hasCount = i.count_unit && i.count_ratio > 1;
        const countQty = hasCount ? Math.round(i.qty / i.count_ratio * 10) / 10 : null;
        const qtyDisplay = hasCount
          ? `${countQty}<span class="inv-unit"> ${i.count_unit}</span><span style="font-size:11px;color:var(--text3)">（${i.qty}${i.unit}）</span>`
          : `${i.qty}<span class="inv-unit"> ${i.unit}</span>`;
        const slDays = i.shelf_life_days || 0;
        const shelfBadge = slDays > 0
          ? `<span class="shelf-life-badge sl-ok">⏳ ${slDays}天效期</span>` : '';
        html += `
          <div class="inv-row${chk && !chk.sufficient ? ' inv-row-shortage' : ''}">
            <div style="flex:1">
              <div class="inv-name">${esc(i.name)} ${statusBadge}</div>
              ${i.safety_stock > 0
                ? (i.qty < i.safety_stock
                    ? `<div class="inv-unit inv-below-safety">⚠ 低於安全量（${i.qty}／${i.safety_stock}${i.unit}）</div>`
                    : `<div class="inv-unit">安全量 ${i.safety_stock}${i.unit}</div>`)
                : ''}
              ${hasCount ? `<div class="inv-unit">1${i.count_unit} = ${i.count_ratio}${i.unit}</div>` : ''}
              ${shelfBadge}
              ${needInfo}
              <button class="inv-hist-btn" onclick="App.togglePurchaseHistory(${i.id},this)">📋 採購記錄</button>
              <div id="ph_${i.id}" style="display:none"></div>
            </div>
            <div class="inv-qty">${qtyDisplay}</div>
            <div class="inv-edit" onclick="App.openEditInv(${i.id},'${esc(i.name)}',${i.qty},'${i.unit}','${i.count_unit||''}',${i.count_ratio||1},${slDays})">✏️</div>
          </div>`;
      });
      html += '</div>';
    });
    document.getElementById('invList').innerHTML = html || '<div class="empty">尚無食材資料</div>';
  }

  // 兩種警訊要分開講：
  //   缺貨   = 本週排定的量做不完
  //   低安全量 = 存量掉到安全水位以下（就算這週夠用，也該補了）
  function updateInvWarningBadge(count, belowSafety) {
    let badge = document.getElementById('invWarningBadge');
    if (!badge) return;
    const parts = [];
    if (count > 0)       parts.push(`🔴 ${count} 項缺貨`);
    if (belowSafety > 0) parts.push(`🟠 ${belowSafety} 項低於安全量`);
    if (parts.length) {
      badge.textContent = parts.join('　');
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }

  async function checkInvWarning() {
    try {
      const r = await api('/api/inventory/check');
      updateInvWarningBadge(r.insufficient_count || 0, r.below_safety_count || 0);
    } catch(e) {}
  }

  function openEditInv(id, name, qty, unit, countUnit, countRatio, shelfLifeDays) {
    document.getElementById('editInvTitle').textContent = `調整庫存：${name}`;
    document.getElementById('editInvId').value = id;
    document.getElementById('editInvCountUnit').value = countUnit || '';
    document.getElementById('editInvCountRatio').value = countRatio || 1;
    document.getElementById('editInvShelfLife').value = shelfLifeDays || 0;
    const hasCount = countUnit && countRatio > 1;
    if (hasCount) {
      const countQty = Math.round(qty / countRatio * 10) / 10;
      document.getElementById('editInvQty').value = countQty;
      document.getElementById('editInvQtyLabel').textContent = `庫存量（${countUnit}）`;
      const hint = document.getElementById('editInvQtyHint');
      hint.textContent = `輸入顆數，系統自動換算（1${countUnit} = ${countRatio}${unit}）`;
      hint.style.display = 'block';
    } else {
      document.getElementById('editInvQty').value = qty;
      document.getElementById('editInvQtyLabel').textContent = `庫存量（${unit}）`;
      document.getElementById('editInvQtyHint').style.display = 'none';
    }
    openModal('modalEditInv');
  }

  async function saveInventory() {
    const id = document.getElementById('editInvId').value;
    const inputQty = parseFloat(document.getElementById('editInvQty').value) || 0;
    const countUnit = document.getElementById('editInvCountUnit').value;
    const countRatio = parseFloat(document.getElementById('editInvCountRatio').value) || 1;
    const qty = countUnit && countRatio > 1 ? Math.round(inputQty * countRatio * 10) / 10 : inputQty;
    const shelf_life_days = parseInt(document.getElementById('editInvShelfLife').value) || 0;
    await Promise.all([
      api(`/api/inventory/${id}`, 'PUT', { qty }),
      api(`/api/ingredients/${id}`, 'PATCH', { shelf_life_days })
    ]);
    closeModal('modalEditInv');
    loadInventory();
  }

  async function openAddIngredient() {
    openModal('modalAddIngredient');
  }

  async function addIngredient() {
    const name = document.getElementById('ingName').value.trim();
    if (!name) return alert('請填寫食材名稱');
    await api('/api/ingredients', 'POST', {
      name,
      unit: document.getElementById('ingUnit').value,
      category: document.getElementById('ingCat').value,
      safety_stock: parseFloat(document.getElementById('ingSafety').value) || 0,
      storage_note: document.getElementById('ingStorage').value
    });
    closeModal('modalAddIngredient');
    loadInventory();
    document.getElementById('ingName').value = '';
    document.getElementById('ingStorage').value = '';
  }

  // 採購籃：在市場勾起來的東西。回診所只要補金額，不用一樣一樣重新選
  async function _renderPurchaseDraft() {
    const box = document.getElementById('purchaseDraft');
    if (!box) return;
    let d;
    try { d = await api('/api/purchase/draft'); }
    catch (e) { box.innerHTML = ''; return; }
    if (!d.rows.length) {
      box.innerHTML = `<div class="pd-empty">採購籃是空的。
        在 <a href="/market.html">採購單</a> 勾「買了」，回來這裡就能一次登記金額。<br>
        已經買回來、但沒走採購頁的話，直接帶入待買清單。</div>`
        + `<button class="btn btn-ghost" style="width:100%;margin-top:8px" onclick="App.fillPurchaseDraft()">↧ 帶入待買清單</button>`;
      return;
    }
    box.innerHTML = `
      <div class="pd-head">採購籃　<b>${d.rows.length} 樣</b>　<span>只要填金額</span></div>
      <div class="pd-list">
        ${d.rows.map(r => `
          <div class="pd-row" data-ing="${r.ingredient_id}">
            <span class="pd-name">${esc(r.name)}</span>
            <input class="pd-qty" type="number" step="any" min="0" value="${r.qty}"
                   title="買到多少${esc(r.unit)}">
            <span class="pd-unit">${esc(r.unit)}</span>
            <input class="pd-price" type="number" min="0" placeholder="金額" inputmode="numeric">
          </div>`).join('')}
      </div>
      <button class="btn btn-primary" style="width:100%;margin-top:10px"
              onclick="App.commitPurchaseDraft()">整批登記進貨</button>
      <button class="btn btn-ghost" style="width:100%;margin-top:8px" onclick="App.fillPurchaseDraft()">↧ 帶入待買清單</button>
      <div class="pd-note">金額沒填的會留在籃子裡，下次再登記 —— 有時候就是先記一部分，剩下的等發票。
        「帶入」不會覆蓋已經在籃子裡的量。</div>`;
  }

  // 東西已經買回來、但沒經過採購頁勾選時用這個。
  // 否則要一樣一樣開視窗，十幾樣就是十幾次，於是沒有人會做
  async function fillPurchaseDraft() {
    try {
      const r = await api('/api/purchase/draft/fill', 'POST', {});
      await _renderPurchaseDraft();
      if (!r.added && !r.kept) alert('目前沒有待買的東西。');
      else if (r.kept) alert(`帶入 ${r.added} 樣（${r.kept} 樣本來就在籃子裡，沒有覆蓋）。`);
    } catch (e) { alert(e.message); }
  }

  async function commitPurchaseDraft() {
    const rows = [...document.querySelectorAll('#purchaseDraft .pd-row')].map(el => ({
      ingredient_id: Number(el.dataset.ing),
      qty:         el.querySelector('.pd-qty').value,
      total_price: el.querySelector('.pd-price').value
    }));
    const willSave = rows.filter(r => r.total_price !== '' && Number(r.qty) > 0);
    if (!willSave.length) return alert('至少要填一樣的金額');
    try {
      const r = await api('/api/purchase/commit', 'POST', { lines: rows });
      await _renderPurchaseDraft();
      loadInventory();
      alert(`已登記 ${r.saved} 樣` + (r.skipped ? `，${r.skipped} 樣沒填金額，留在籃子裡。` : '。'));
    } catch (e) { alert(e.message); }
  }

  async function openPurchase() {
    _renderPurchaseDraft();
    const items = await api('/api/inventory');
    const sel = document.getElementById('purchaseIng');
    sel.innerHTML = items.map(i => `<option value="${i.id}">${esc(i.name)}（${i.qty}${i.unit}）</option>`).join('');
    const today = new Date().toISOString().slice(0,10);
    document.getElementById('purchaseDate').value = today;
    openModal('modalPurchase');
  }

  async function savePurchase() {
    const ingredient_id = document.getElementById('purchaseIng').value;
    const qty = parseFloat(document.getElementById('purchaseQty').value);
    const total_price = parseFloat(document.getElementById('purchasePrice').value);
    const purchased_at = document.getElementById('purchaseDate').value;
    const item_type = document.getElementById('purchaseItemType').value;
    const purpose = document.getElementById('purchasePurpose').value;
    if (!qty || !total_price) return alert('請填寫採購量和金額');
    await api('/api/inventory/purchase', 'POST', {
      ingredient_id, qty, total_price, purchased_at, item_type, purpose,
      user_id: currentUser?.id || null
    });
    closeModal('modalPurchase');
    loadInventory();
    alert(`進貨記錄已儲存！單價：NT$${(total_price/qty).toFixed(2)}`);
  }

  // ── 成本分析 ────────────────────────────────────────────
  function switchCostTab(tab) {
    currentCostTab = tab;
    document.querySelectorAll('.cost-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.ctab === tab));
    document.querySelectorAll('.cost-section').forEach(s =>
      s.classList.toggle('active', s.id === `costSection-${tab}`));
    if (tab === 'today')   loadCostToday();
    if (tab === 'monthly') { document.getElementById('costMonthLabel').textContent = costMonth; loadCostMonthly(); }
    if (tab === 'rx')      loadCostRx();
    if (tab === 'trial')   loadTrialRecipes();
  }

  async function loadCost() {
    switchCostTab(currentCostTab);
  }

  async function loadCostToday() {
    const data = await api('/api/costs');
    const t = data.today;
    const s = data.settings;

    if (!t.products.length) {
      document.getElementById('costToday').innerHTML =
        `<div class="empty"><div class="ei">💰</div>今日尚無出單記錄</div>`;
      return;
    }

    const ingTotal   = t.products.reduce((s, p) => s + p.ingredient_cost, 0);
    const laborTotal = t.products.reduce((s, p) => s + p.labor_cost, 0);

    let html = `
      <div class="cost-grand-card">
        <div class="cost-grand-label">今日廚房總支出</div>
        <div class="cost-grand-num">NT$${t.grand_total}</div>
        <div class="cost-grand-sub">
          <span>🧺 食材 NT$${Math.round(ingTotal*10)/10}</span>
          <span>👷 人工 NT$${Math.round(laborTotal*10)/10}</span>
        </div>
      </div>`;

    t.products.forEach(p => {
      html += `
        <div class="cost-card">
          <div class="cost-card-head">
            <div>
              <div class="cost-card-name">${esc(p.product_name)}</div>
              <div class="cost-card-cups">員工 ${p.staff_cups}${p.product_unit} ＋ 個案 ${p.case_cups}${p.product_unit} ＝ 共 ${p.total_cups}${p.product_unit}</div>
            </div>
            <div style="text-align:right">
              <div class="cost-card-total">NT$${p.total_cost}</div>
              <div class="cost-card-per">≈ NT$${p.cost_per_cup}/${p.product_unit}</div>
            </div>
          </div>
          <div class="cost-breakdown">
            <div class="cb-row">
              <span style="color:var(--text2)">🧺 食材成本</span>
              <span>NT$${p.ingredient_cost}</span>
            </div>
            <div class="cb-row">
              <span style="color:var(--text2)">👷 人工成本（${s.labor_min_per_cup||15}分/份）</span>
              <span>NT$${p.labor_cost}</span>
            </div>
          </div>
        </div>`;
    });

    document.getElementById('costToday').innerHTML = html;
  }

  async function loadCostMonthly() {
    document.getElementById('costMonthly').innerHTML =
      `<div style="text-align:center;padding:24px;color:var(--text2)">載入中…</div>`;
    const data = await api(`/api/costs/monthly?month=${costMonth}`);

    if (!data.days.length) {
      document.getElementById('costMonthly').innerHTML =
        `<div class="empty"><div class="ei">📅</div>${costMonth} 無紀錄</div>`;
      return;
    }

    // 收集所有產品名（for columns）
    const prodNames = [];
    data.by_product.forEach(p => { if (!prodNames.includes(p.product_name)) prodNames.push(p.product_name); });

    // 月合計卡片列
    let summaryHtml = `<div class="cost-month-summary">`;
    data.by_product.forEach(p => {
      summaryHtml += `
        <div class="cms-card">
          <div class="cms-name">${esc(p.product_name)}</div>
          <div class="cms-total">NT$${p.total_cost}</div>
          <div class="cms-detail">${p.total_cups}${p.product_unit}・均 NT$${p.cost_per_unit}/${p.product_unit}</div>
        </div>`;
    });
    // 總計卡
    summaryHtml += `
        <div class="cms-card" style="background:var(--text);color:#fff">
          <div class="cms-name" style="color:rgba(255,255,255,.6)">月總支出</div>
          <div class="cms-total" style="color:#fff">NT$${data.month_total}</div>
          <div class="cms-detail" style="color:rgba(255,255,255,.5)">${data.days.length} 個工作日</div>
        </div>
      </div>`;

    // 日報表
    const colHead = prodNames.map(n => `<th>${esc(n)}</th>`).join('');
    let tableHtml = `
      <div style="overflow-x:auto">
      <table class="cost-month-table">
        <thead><tr><th>日期</th>${colHead}<th>合計</th></tr></thead>
        <tbody>`;

    data.days.forEach(d => {
      const mmdd = d.date.slice(5).replace('-', '/');
      const cols = prodNames.map(name => {
        const p = d.products.find(p => p.product_name === name);
        return p
          ? `<td>$${p.total_cost}<br><span style="font-size:11px;color:var(--text3)">${p.total_cups}${p.product_unit}</span></td>`
          : `<td class="col-zero">—</td>`;
      }).join('');
      tableHtml += `<tr><td class="col-date">${mmdd}</td>${cols}<td class="col-total">$${d.grand_total}</td></tr>`;
    });

    // 月合計列
    const colTotals = prodNames.map(name => {
      const p = data.by_product.find(p => p.product_name === name);
      return p ? `<td style="font-weight:700">$${p.total_cost}</td>` : `<td class="col-zero">—</td>`;
    }).join('');
    tableHtml += `
        <tr class="row-total"><td>月合計</td>${colTotals}<td>$${data.month_total}</td></tr>
        </tbody></table></div>`;

    document.getElementById('costMonthly').innerHTML = summaryHtml + tableHtml;
  }

  function prevCostMonth() {
    const [y, m] = costMonth.split('-').map(Number);
    const d = new Date(y, m - 2, 1);
    costMonth = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    document.getElementById('costMonthLabel').textContent = costMonth;
    loadCostMonthly();
  }

  function nextCostMonth() {
    const [y, m] = costMonth.split('-').map(Number);
    const d = new Date(y, m, 1);
    costMonth = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    document.getElementById('costMonthLabel').textContent = costMonth;
    loadCostMonthly();
  }

  async function loadCostRx() {
    const data = await api('/api/costs');
    const s = data.settings;

    // 按產品分組
    const byProduct = {};
    data.prescriptions.forEach(rx => {
      const key = rx.product_name || '未分類';
      if (!byProduct[key]) byProduct[key] = [];
      byProduct[key].push(rx);
    });

    let html = `
      <div class="card" style="margin-bottom:12px">
        <div class="card-title">人工設定</div>
        <div class="row"><span class="row-label">費率</span><span class="row-value">NT$${s.labor_rate||250}/小時</span></div>
        <div class="row"><span class="row-label">製作時間</span><span class="row-value">${s.labor_min_per_cup||15} 分/份 → NT$${data.labor_cost_per_cup}/份</span></div>
      </div>`;

    Object.entries(byProduct).forEach(([pname, rxs]) => {
      html += `<div style="font-size:12px;font-weight:700;color:var(--text2);margin:14px 0 6px;text-transform:uppercase;letter-spacing:.5px">📦 ${esc(pname)}</div>`;
      rxs.forEach(rx => {
        const price = rx.formula_type === '全配方' ? (s.full_formula_price||350) : (s.powder_formula_price||280);
        const margin = price - rx.total_cost;
        html += `
          <div class="cost-card">
            <div style="display:flex;justify-content:space-between;align-items:flex-start">
              <div>
                <div style="font-size:11px;font-weight:700;color:var(--text2);letter-spacing:1px">${esc(rx.code)}</div>
                <div style="font-size:16px;font-weight:700">${esc(rx.name)}</div>
                <span class="badge ${rx.formula_type==='全配方'?'badge-blue':'badge-purple'}">${esc(rx.formula_type)}</span>
              </div>
              <div style="text-align:right">
                <div class="cost-total">NT$${rx.total_cost}</div>
                <div style="font-size:11px;color:var(--text2)">每${rx.product_unit||'份'}成本</div>
                <div style="font-size:12px;margin-top:3px;color:${margin>=0?'var(--green)':'var(--red)'}">毛利 NT$${margin.toFixed(1)}</div>
              </div>
            </div>
            <div class="cost-breakdown" style="margin-top:10px">
              ${rx.breakdown.filter(b => b.cost > 0).map(b => `
                <div class="cb-row">
                  <span style="color:var(--text2)">${esc(b.name)} ×${b.qty}${b.unit}</span>
                  <span>NT$${b.cost}</span>
                </div>`).join('')}
              <div class="cb-row" style="font-weight:700">
                <span>食材小計</span><span>NT$${rx.ingredient_cost}</span>
              </div>
              <div class="cb-row">
                <span style="color:var(--text2)">人工</span><span>NT$${rx.labor_cost}</span>
              </div>
            </div>
          </div>`;
      });
    });
    document.getElementById('costList').innerHTML = html;
  }

  // ── 採購歷史展開 ─────────────────────────────────────────
  async function togglePurchaseHistory(ingId, btn) {
    const box = document.getElementById(`ph_${ingId}`);
    if (!box) return;
    if (box.style.display !== 'none') { box.style.display = 'none'; btn.textContent = '📋 採購記錄'; return; }
    btn.textContent = '⏳ 載入中…';
    const rows = await api(`/api/inventory/${ingId}/purchases`);
    if (rows.length === 0) {
      box.innerHTML = '<div class="purchase-history"><div style="color:var(--text3);font-size:12px;padding:6px 0">尚無採購記錄</div></div>';
    } else {
      box.innerHTML = `<div class="purchase-history">${rows.map(r => {
        const uc = r.qty > 0 ? `NT$${(r.total_price/r.qty).toFixed(2)}/${r.qty > 999 ? 'g' : '份'}` : '';
        const purposeTag = r.purpose && r.purpose !== '精力湯'
          ? `<span class="ph-purpose">${esc(r.purpose)}</span>` : '';
        const typeTag = r.item_type === '用具' ? '<span class="ph-purpose" style="background:rgba(175,82,222,.1);color:var(--purple)">用具</span>' : '';
        return `<div class="ph-row">
          <span class="ph-date">${r.purchased_at}</span>
          <span class="ph-qty">${r.qty}${r.unit||''}</span>
          <span class="ph-price">NT$${r.total_price}</span>
          <span class="ph-uc">${uc}</span>
          ${purposeTag}${typeTag}
        </div>`;
      }).join('')}</div>`;
    }
    box.style.display = '';
    btn.textContent = '📋 收起';
  }

  // ── 人力記錄 ────────────────────────────────────────────
  let laborDate = new Date().toISOString().slice(0, 10);

  async function loadLaborSection(date) {
    const data = await api(`/api/labor?date=${date}`);
    const container = document.getElementById('laborSection');
    if (!container) return;
    if (data.records.length === 0) {
      container.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:8px 0">今日尚無工時記錄</div>';
      return;
    }
    container.innerHTML = data.records.map(r => {
      const cost = Math.round(r.minutes / 60 * 196 * 10) / 10;
      return `<div class="labor-row">
        <span class="labor-task">${esc(r.task_type)}</span>
        <span class="labor-purpose">${esc(r.purpose)}</span>
        ${r.user_name ? `<span style="font-size:11px;color:var(--text3)">${esc(r.user_name)}</span>` : ''}
        <span class="labor-min">${r.minutes}分</span>
        <span class="labor-cost">NT$${cost}</span>
        <button class="labor-del" onclick="App.deleteLabor(${r.id})">×</button>
      </div>`;
    }).join('') + `<div class="labor-total-row">
      <span>合計 ${data.total_minutes} 分鐘</span>
      <span style="color:var(--green)">NT$${data.total_cost}</span>
    </div>`;
  }

  async function openAddLabor() {
    const users = await api('/api/users');
    const sel = document.getElementById('laborUser');
    sel.innerHTML = `<option value="">（本人 — ${currentUser?.name || ''}）</option>` +
      users.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
    document.getElementById('laborMinutes').value = '';
    openModal('modalLabor');
  }

  async function saveLabor() {
    const minutes = parseInt(document.getElementById('laborMinutes').value) || 0;
    if (!minutes) return alert('請填寫工時');
    await api('/api/labor', 'POST', {
      date: laborDate,
      user_id: document.getElementById('laborUser').value || currentUser?.id || null,
      task_type: document.getElementById('laborTaskType').value,
      purpose: document.getElementById('laborPurpose').value,
      minutes
    });
    closeModal('modalLabor');
    loadLaborSection(laborDate);
  }

  async function deleteLabor(id) {
    if (!confirm('刪除此工時記錄？')) return;
    await api(`/api/labor/${id}`, 'DELETE');
    loadLaborSection(laborDate);
  }

  // ── 試菜記錄 ────────────────────────────────────────────
  async function loadTrialRecipes() {
    const recipes = await api('/api/trial_recipes');
    const el = document.getElementById('trialList');
    if (!el) return;
    if (recipes.length === 0) {
      el.innerHTML = '<div class="empty"><div class="ei">🍳</div>尚無試菜記錄</div>';
      return;
    }
    el.innerHTML = recipes.map(r => {
      const statusClass = `s${r.status}`;
      const sessions = (r.sessions || []).map(s => `
        <div class="trial-session-row">
          <span class="trial-session-no">第 ${s.session_no} 次</span>
          <span class="trial-session-date">${s.date}</span>
          <span class="trial-session-notes">${esc(s.notes || '—')}</span>
          ${s.labor_minutes > 0 ? `<span style="font-size:11px;color:var(--blue)">${s.labor_minutes}分</span>` : ''}
          <button class="labor-del" onclick="App.deleteTrialSession(${s.id},${r.id})">×</button>
        </div>`).join('');
      return `<div class="trial-card">
        <div class="trial-card-head">
          <div>
            <div class="trial-name">${esc(r.name)}</div>
            ${r.notes ? `<div style="font-size:12px;color:var(--text3);margin-top:2px">${esc(r.notes)}</div>` : ''}
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
            <span class="trial-status ${statusClass}">${esc(r.status)}</span>
            <div style="display:flex;gap:6px">
              <button class="btn btn-ghost btn-sm" onclick="App.openEditTrial(${r.id})">編輯</button>
              <button class="btn btn-danger btn-sm" onclick="App.deleteTrial(${r.id})">刪除</button>
            </div>
          </div>
        </div>
        ${sessions || '<div style="color:var(--text3);font-size:12px">尚無試菜記錄</div>'}
        <div class="trial-cost-row">
          <span style="color:var(--text3);font-size:12px">累計工時 ${r.total_labor_minutes} 分 → 人力 NT$${r.total_labor_cost}</span>
          <button class="btn btn-primary btn-sm" onclick="App.openAddTrialSession(${r.id})">＋ 新增記錄</button>
        </div>
      </div>`;
    }).join('');
  }

  async function openAddTrial() {
    document.getElementById('modalTrialTitle').textContent = '新增試菜專案';
    document.getElementById('trialEditId').value = '';
    document.getElementById('trialName').value = '';
    document.getElementById('trialStatus').value = '試驗中';
    document.getElementById('trialNotes').value = '';
    openModal('modalTrial');
  }

  async function openEditTrial(id) {
    const recipes = await api('/api/trial_recipes');
    const r = recipes.find(x => x.id === id);
    if (!r) return;
    document.getElementById('modalTrialTitle').textContent = '編輯試菜專案';
    document.getElementById('trialEditId').value = id;
    document.getElementById('trialName').value = r.name;
    document.getElementById('trialStatus').value = r.status;
    document.getElementById('trialNotes').value = r.notes || '';
    openModal('modalTrial');
  }

  async function saveTrial() {
    const id = document.getElementById('trialEditId').value;
    const name = document.getElementById('trialName').value.trim();
    const status = document.getElementById('trialStatus').value;
    const notes = document.getElementById('trialNotes').value.trim();
    if (!name) return alert('請填寫名稱');
    if (id) await api(`/api/trial_recipes/${id}`, 'PUT', { name, status, notes });
    else await api('/api/trial_recipes', 'POST', { name, notes });
    closeModal('modalTrial');
    loadTrialRecipes();
  }

  async function deleteTrial(id) {
    if (!confirm('確定刪除此試菜專案及所有記錄？')) return;
    await api(`/api/trial_recipes/${id}`, 'DELETE');
    loadTrialRecipes();
  }

  function openAddTrialSession(recipeId) {
    document.getElementById('trialSessionRecipeId').value = recipeId;
    document.getElementById('trialSessionDate').value = new Date().toISOString().slice(0,10);
    document.getElementById('trialSessionParticipants').value = '';
    document.getElementById('trialSessionMinutes').value = '';
    document.getElementById('trialSessionNotes').value = '';
    openModal('modalTrialSession');
  }

  async function saveTrialSession() {
    const rid = document.getElementById('trialSessionRecipeId').value;
    const date = document.getElementById('trialSessionDate').value;
    const participants = document.getElementById('trialSessionParticipants').value.trim();
    const labor_minutes = parseInt(document.getElementById('trialSessionMinutes').value) || 0;
    const notes = document.getElementById('trialSessionNotes').value.trim();
    await api(`/api/trial_recipes/${rid}/sessions`, 'POST', { date, participants, labor_minutes, notes });
    closeModal('modalTrialSession');
    loadTrialRecipes();
  }

  async function deleteTrialSession(sessionId, recipeId) {
    if (!confirm('刪除此次試菜記錄？')) return;
    await api(`/api/trial_sessions/${sessionId}`, 'DELETE');
    loadTrialRecipes();
  }

  // ── SOP / 品質確認 ───────────────────────────────────────
  function loadSOP() {
    const today = (lastTodayData && lastTodayData.date) || new Date().toISOString().slice(0,10);
    // 供應日與人數一律讀伺服器，SOP 文字才不會和系統實際行為講不一樣
    const dowTw     = ['日','一','二','三','四','五','六'];
    const mealDows  = (lastTodayData && lastTodayData.staff_meal_dows) || [2, 5];
    const roster    = (lastTodayData && lastTodayData.roster_count) || 0;
    const mealSlash = mealDows.map(d => '週' + dowTw[d]).join(' / ');
    const mealPlus  = mealDows.map(d => '週' + dowTw[d]).join('＋');
    const mealRun   = mealDows.map(d => '週' + dowTw[d]).join('、');

    function qcItem(id, text) {
      const checked = dayQc[id] || false;
      return `<div class="sop-qc-item${checked?' checked':''}" id="qci_${id}">
        <input type="checkbox" id="qcb_${id}" ${checked?'checked':''} onchange="App.toggleQC('${id}',this.checked)">
        <label for="qcb_${id}">${text}</label>
      </div>`;
    }

    const html = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <h2 style="font-size:18px;font-weight:800">📌 精力湯供應 SOP</h2>
        <span style="font-size:12px;color:var(--text3)">${today}</span>
      </div>
      <div style="font-size:12px;color:var(--text3);margin-bottom:16px">所有人員請熟讀此表，每週依此流程執行</div>

      <div class="sop-section-title">一、人員分工與職責</div>
      <div class="sop-card">
        <div class="sop-step">
          <span class="sop-step-no" style="min-width:96px;color:var(--text)">John（總負責人）</span>
          <div>統籌整體精力湯福利運作；每週末執行採買（新鮮蔬果＋粉類補充）；審核成本與月統計報告；處理供應異常狀況</div>
        </div>
        <div class="sop-step">
          <span class="sop-step-no" style="min-width:96px;color:var(--blue)">個管助理</span>
          <div>每日彙整出單（確認員工與個案當日杯數）；開立今日執行單並通知執行單位；監控執行時程（依「最晚開始」時間追蹤，超時立即通報）；製作完成品質確認；<strong>週五盤點庫存並確認週末採買清單</strong></div>
        </div>
        <div class="sop-step">
          <span class="sop-step-no" style="min-width:96px;color:var(--purple)">個管師<br><small style="font-weight:400">Bonnie / Winnie</small></span>
          <div>根據個案飲用後回饋，持續與醫師討論配方調整；記錄個案實際反應至知識庫（食材耐受度、療效觀察、禁忌更新）；填寫個案出單、確認配方類型與禁忌；維護處方箋版本並通知相關人員</div>
        </div>
        <div class="sop-step">
          <span class="sop-step-no" style="min-width:96px;color:var(--green)">執行單位</span>
          <div>負責週一備料 SOP（粉包分裝、葉菜冷藏、水果冷凍）；供應日依今日執行單製作各員工與個案的精力湯；製作完成填入「完成時間」；廢棄品填入備料單備註欄</div>
        </div>
      </div>

      <div class="sop-section-title">二、每週作業時間表</div>
      <div class="sop-card">
        <div class="sop-schedule-grid">
          <div class="sop-day-card">
            <div class="sop-day-name">週六 / 日　採買日</div>
            <div class="sop-day-tasks">John 採買新鮮蔬果＋補粉類庫存<br>採買後 2 小時內完成冷藏入庫</div>
          </div>
          <div class="sop-day-card">
            <div class="sop-day-name">週一上午　備料日</div>
            <div class="sop-day-tasks"><strong>執行單位負責：</strong><br>① 燕麥打粉<br>② 粉包分裝 27 份<br>③ 葉菜三道清洗→冷藏<br>④ 蘋果切塊冷凍</div>
          </div>
          <div class="sop-day-card">
            <div class="sop-day-name">${mealSlash}　供應日</div>
            <div class="sop-day-tasks">員工統一一批製作<br>個案依取餐時間個別製作<br>（見三、個案出單情境）</div>
          </div>
          <div class="sop-day-card">
            <div class="sop-day-name">週五下班前　盤點日</div>
            <div class="sop-day-tasks">個管助理盤點所有食材<br>填入庫存表藍色欄<br>確認橘色欄採買清單<br>交給 John</div>
          </div>
        </div>
        <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
          <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:8px">儲藏方式</div>
          <div class="sop-rule">乾放類（粉包、堅果、膠囊、油）→ 檯台上專用收納盒，分格放置，每格貼食材名稱</div>
          <div class="sop-rule">冷藏類（蔬菜）→ 冰箱專用盒，各食材分開存放，盒外貼效期標籤</div>
          <div class="sop-rule">冷凍類（水果、莓果）→ 冰箱冷凍專用盒，分袋密封，袋上貼品名與入庫日</div>
        </div>
      </div>

      <div class="sop-section-title">二ａ、破壁機攪打 SOP（現場喝｜執行者操作標準）</div>
      <div class="sop-card">
        <div style="font-size:12px;color:var(--text2);margin-bottom:10px">必備器具：破壁機（調理機）｜量杯｜電子秤｜湯匙｜計時器</div>
        <div class="sop-step">
          <span class="sop-step-no">Step 1</span>
          <div>
            <div style="font-weight:700">低速 2　攪打 10 秒</div>
            <div style="font-size:13px;margin-top:4px">放入順序（<strong style="color:var(--red)">不可顛倒</strong>）：</div>
            <div style="font-size:15px;font-weight:800;letter-spacing:1px;margin:6px 0;color:var(--blue)">【粉包】➜【水】➜【蔬菜】➜【冷凍水果】</div>
            <div style="font-size:12px;color:var(--text3)">蓋蓋，低速2攪打10秒，讓粉末先充分溶於水。</div>
            <div style="font-size:12px;color:var(--text3);margin-top:3px">原理：先讓蛋白粉與水融合，防止高速直打造成起泡，癌友喝下大量空氣易胃脹氣。</div>
          </div>
        </div>
        <div class="sop-step">
          <span class="sop-step-no">Step 2</span>
          <div>
            <div style="font-weight:700">高速 10　攪打 40 秒</div>
            <div style="font-size:12px;color:var(--text3);margin-top:4px">蓋緊蓋子，高速攪打至均勻細滑為止。</div>
          </div>
        </div>
        <div class="sop-step">
          <span class="sop-step-no">Step 3</span>
          <div>
            <div style="font-weight:700">停機開蓋　加油攪拌</div>
            <div style="font-size:13px;margin-top:4px">關機開蓋 → 加入指定油種（橄欖油或處方指定）</div>
            <div style="font-size:13px">湯匙攪拌均勻，或低速轉 2 秒即完成。</div>
            <div style="font-size:12px;color:var(--orange);margin-top:4px">⚠ 不可在高速下加油。原理：橄欖多酚高速乳化會被破壞，最後加油能包裹脂溶性維生素 A/D/E/K。</div>
          </div>
        </div>
        <div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border);font-size:12px;color:var(--text2)">
          ⏱ 全配方（含蔬果）：<strong>1 杯 ≈ 13 分</strong>　｜　<strong>4 杯 ≈ 60 分</strong>　｜　<strong>7 杯 ≈ 90 分</strong>
        </div>
      </div>

      <div class="sop-section-title">二ｂ、粉類製備 SOP（執行單位負責，個管助理驗收）</div>
      <div class="sop-card">
        <div style="font-size:13px;font-weight:700;color:var(--text2);margin-bottom:8px">① 燕麥打粉（進貨後執行）</div>
        <div class="sop-rule">確認燕麥為完整燕麥粒（非即食片）</div>
        <div class="sop-rule">以乾燥研磨機打成細粉（約 2 分鐘，確認無顆粒感）</div>
        <div class="sop-rule">裝入乾燥玻璃罐，密封，標示「燕麥粉｜打粉日期：＿＿＿｜效期 60 天（截止日：＿＿＿）」</div>
        <div class="sop-rule">室溫乾燥陰涼處保存，開罐後保持密封，避免受潮</div>
        <div style="font-size:13px;font-weight:700;color:var(--text2);margin:12px 0 8px">② 週一粉包分裝（每週執行）</div>
        <div class="sop-rule">備齊量：員工 ${roster} 人 × ${mealDows.length} 天（${mealPlus}）＝ <strong>${roster * mealDows.length} 份</strong></div>
        <div style="background:var(--bg);border-radius:8px;padding:10px;font-size:12px;margin:8px 0">
          <div style="font-weight:700;margin-bottom:6px">每份內容（員工標準配方）</div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px">
            ${[['蛋白粉','25g'],['燕麥粉','10g'],['薑黃粉','1g'],['肉桂粉','1g'],['藜麥粉','5g'],['黑胡椒','1粒']].map(([n,a])=>
              `<div style="padding:4px 6px;background:var(--surface,#f8f8f8);border-radius:4px"><span style="color:var(--text3)">${n}</span> <strong>${a}</strong></div>`
            ).join('')}
          </div>
        </div>
        <div class="sop-rule">逐份用電子秤秤重，裝入夾鏈密封袋</div>
        <div class="sop-rule">袋上標示「日期＿＿　份數＿＿　員工份」，整袋放置室溫乾燥處，7 天內用完</div>
        <div class="sop-rule" style="color:var(--blue)">個管助理驗收：確認份數正確、袋口密封、標示清楚</div>
        <div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border);font-size:12px;color:var(--text2)">
          ⏱ 粉包製作時間：<strong>1 天份 ≈ 12 分</strong>　｜　<strong>5 天份 ≈ 60 分</strong>　｜　<strong>9 天份 ≈ 110 分</strong><br>
          <span style="color:var(--orange)">⚠ 有大量出單時請提前告知執行單位預排時間。</span>
        </div>
      </div>

      <div class="sop-section-title">三、個案出單情境（個管師 &amp; 個管助理必讀）</div>
      <div class="sop-card">
        <div class="sop-step">
          <span class="sop-step-no" style="min-width:72px">A　預約跨日</span>
          <div>
            <div style="font-weight:700">今天出單，改天取餐</div>
            <div style="font-size:12px;color:var(--text3);margin-top:3px">例：供應日前一天看診出單 → 下一個供應日才取</div>
            <div style="font-size:13px;margin-top:4px">個管師填出單表（含取餐日期＋配方＋禁忌）；個管助理取餐日前一天確認庫存，預約時間前 30 分鐘製作</div>
          </div>
        </div>
        <div class="sop-step">
          <span class="sop-step-no" style="min-width:72px">B　當日午後</span>
          <div>
            <div style="font-weight:700">今天上午看診出單，今天下午取餐</div>
            <div style="font-size:12px;color:var(--text3);margin-top:3px">例：10:00 看診出單 → 14:00 取</div>
            <div style="font-size:13px;margin-top:4px">截單時間：<strong>11:30 前</strong>（超過則順延至次日）；個管助理中午確認後備料，14:00 完成交付</div>
          </div>
        </div>
        <div class="sop-step">
          <span class="sop-step-no" style="min-width:72px">套組天數<br><small>（3/6/9天）</small></span>
          <div>出單時在備註欄標記「套組X天已承諾」，庫存需預留對應份量，<strong style="color:var(--red)">不得超賣</strong></div>
        </div>
      </div>

      <div class="sop-section-title">四、配方說明</div>
      <div class="sop-card">
        <div class="sop-step">
          <span class="sop-step-no" style="min-width:72px">員工標準<br>配方</span>
          <span>完整蔬果＋粉類，週一統一備料，${mealRun} 各取一份製作</span>
        </div>
        <div class="sop-step">
          <span class="sop-step-no" style="min-width:72px">個案粉<br>配方</span>
          <span>僅蛋白粉＋補充品，不需備蔬果。成本較低，適合以補充營養素為主的個案</span>
        </div>
        <div class="sop-step">
          <span class="sop-step-no" style="min-width:72px">個案全<br>配方</span>
          <div>
            <div>依醫師處方完整製作（含蔬果）。<strong>製作前必確認禁忌欄。</strong>成本依處方客製計算。</div>
            <div style="font-size:12px;color:var(--text3);margin-top:3px">個管師需將個案回饋記錄至知識庫供後續配方調整參考</div>
          </div>
        </div>
      </div>

      <div class="sop-section-title">五、食安關鍵規則</div>
      <div class="sop-card">
        <div class="sop-rule">🌡 <strong>危險溫度帶</strong>　切好的蔬果不得在 7–60°C 停留超過 2 小時。製作完成立即交付，不得預先製作放置</div>
        <div class="sop-rule">🗑 <strong>廢棄記錄</strong>　超過 2 小時未飲用即廢棄，在備料單備註欄記錄品項與數量</div>
        <div class="sop-rule">🧤 <strong>製作衛生</strong>　製作前洗手並戴手套，器具使用前清潔消毒，蔬果分開刀具砧板</div>
        <div class="sop-rule">⚠ <strong>過敏／禁忌</strong>　個案出單表禁忌欄必填。執行者製作前必須核對。<br><span style="font-size:12px;color:var(--text3)">常見：堅果過敏、腎功能限鉀（限根莖類）、無麩質（限燕麥）</span></div>
      </div>

      <div class="sop-section-title">六、表單使用說明</div>
      <div class="sop-card">
        <div class="sop-step">
          <span class="sop-step-no" style="min-width:60px">📋 每日出單</span>
          <span style="font-size:13px">每個供應日填入各人杯數（員工預填1，Joana/丹預設0）。個案依出單填入取餐日、杯數、配方與禁忌</span>
        </div>
        <div class="sop-step">
          <span class="sop-step-no" style="min-width:60px">🍃 備料單</span>
          <span style="font-size:13px">自動抓今日星期幾顯示對應杯數與需備量。今日非供應日會顯示提示，個管助理按此備料</span>
        </div>
        <div class="sop-step">
          <span class="sop-step-no" style="min-width:60px">📦 庫存</span>
          <span style="font-size:13px">週五盤點後填入藍色欄。蘋果填顆數（1顆=220g）、檸檬填顆數（1顆=100g），其餘填克數。橘色欄自動顯示週末採買量</span>
        </div>
        <div class="sop-step">
          <span class="sop-step-no" style="min-width:60px">💰 成本</span>
          <span style="font-size:13px">每次採購填入一筆（日期/食材/量/金額），每杯成本自動以加權平均累積計算並更新頂部數字</span>
        </div>
        <div class="sop-step">
          <span class="sop-step-no" style="min-width:60px">📊 月統計</span>
          <span style="font-size:13px">C2填年份、E2填月份數字（如6），週次日期自動更新。員工欄預設3可調整，個案費用手動填入</span>
        </div>
      </div>

      <div class="sop-section-title">七、每日作業優先順序（依分工與 GHP 規範）
        <button class="sop-reset-btn" onclick="App.resetQC()">重設今日</button>
      </div>
      <div class="sop-card">
        <div style="font-size:12px;font-weight:700;color:var(--blue);margin-bottom:8px">08:00　執行單位</div>
        ${qcItem('e1', '戴口罩（GHP強制）、洗手，器具消毒完成')}
        ${qcItem('e2', '確認冷藏 ≤ 4°C、冷凍 ≤ -18°C，記錄於庫存表溫度記錄欄')}
        ${qcItem('e3', '確認週一備料品質：粉包密封完整？葉菜無異味？水果冷凍狀態正常？')}
        <div style="font-size:12px;font-weight:700;color:var(--blue);margin:12px 0 8px">08:30　個管助理</div>
        ${qcItem('a1', '開啟今日執行單，確認今日出單（員工＋個案）')}
        ${qcItem('a2', '確認各個案取餐時間，計算最晚開始時間')}
        ${qcItem('a3', '通知執行單位：今日共幾杯、哪些個案、幾點前完成')}
        <div style="font-size:12px;font-weight:700;color:var(--blue);margin:12px 0 8px">備料製作　執行單位（依取餐時間倒推）</div>
        ${qcItem('m1', '確認備料單克數')}
        ${qcItem('m2', '蔬菜三道清洗 SOP（見八）完成')}
        ${qcItem('m3', '取冷凍水果（不解凍直接用）')}
        ${qcItem('m4', '取粉包（週一分裝份）')}
        ${qcItem('m5', '攪打順序正確：粉包→水→蔬菜→冷凍水果，油最後停機後加')}
        ${qcItem('m6', '製作完成，質地均勻、口感顏色正常，立即交付，填寫完成時間')}
        <div style="font-size:12px;font-weight:700;color:var(--blue);margin:12px 0 8px">交付後　個管助理確認</div>
        ${qcItem('d1', '每批完成時間在取餐時間前')}
        ${qcItem('d2', '若有未取走超過 2 小時 → 廢棄並記錄於今日執行單廢棄記錄區')}
        ${qcItem('d3', '個案取走後確認禁忌無誤、叮囑飲用時間')}
        <div style="font-size:12px;font-weight:700;color:var(--blue);margin:12px 0 8px">週五下班前</div>
        ${qcItem('f1', '盤點庫存，填入庫存表藍色欄')}
        ${qcItem('f2', '確認溫度記錄本週每天都有記錄')}
        ${qcItem('f3', '確認週末採買清單交給 John')}
        ${qcItem('f4', '先進先出確認：日期標籤舊的移到前面')}
      </div>

      <div class="sop-section-title">八、蔬菜三道清洗 SOP（GHP 生鮮即食蔬果標準）</div>
      <div class="sop-card">
        <div class="sop-step"><span class="sop-step-no">第一道</span><div><strong>去除泥沙</strong>　流動清水沖洗，去除明顯泥沙、蟲卵及農藥附著物。<br><span style="font-size:12px;color:var(--orange)">重點：葉菜類分葉逐片沖洗，不得整把沖。</span></div></div>
        <div class="sop-step"><span class="sop-step-no">第二道</span><div><strong>浸泡清洗</strong>　清水浸泡 5 分鐘（可加入食品級蔬果清洗液，依產品說明稀釋）。<br><span style="font-size:12px;color:var(--text3)">個案為免疫功能低下族群，建議每次使用。浸泡後倒掉水，<strong>勿直接用浸泡水沖洗。</strong></span></div></div>
        <div class="sop-step"><span class="sop-step-no">第三道</span><div><strong>清水沖淨</strong>　大量流動清水沖洗 30 秒以上，確保無清洗液殘留。<br><span style="font-size:12px;color:var(--text3)">沖畢充分瀝乾（搖水籃或廚房紙巾吸水），水分是葉菜腐壞最快原因。</span></div></div>
        <div class="sop-step"><span class="sop-step-no">完成後</span><span>分份秤重 → 密封袋密封 → 標示「清洗日期＿＿」→ 冷藏 4°C 保存。<strong>葉菜類只備 2 日份。</strong></span></div>
        <div style="font-size:12px;color:var(--orange);margin-top:10px;padding-top:8px;border-top:1px solid var(--border)">
          ⚠ 個案為腫瘤患者，多數處於化療或術後免疫低下狀態，生食蔬果的微生物風險高於一般人。若個案有嚴重免疫低下（如移植後、ANC&lt;500），請個管師諮詢醫師是否仍適合飲用生食精力湯。
        </div>
      </div>

      <div class="sop-section-title">九、先進先出（FIFO）日期標籤管理</div>
      <div class="sop-card">
        <div class="sop-rule"><strong>標籤格式：</strong>【品名 ｜ 入庫日期 ｜ 最晚使用日】<br><span style="font-size:12px;color:var(--text3)">例：燕麥粉 ｜ 入庫 06/04 ｜ 最晚 08/03（60天）</span></div>
        <div class="sop-rule">取用時從最早入庫的開始取，同一品項舊的放前面、新的放後面</div>
        <div class="sop-rule">發現已超過最長保存天數者，立即廢棄，記錄於今日執行單廢棄記錄區</div>
        <div class="sop-rule" style="color:var(--orange)">⚠ 不得因「看起來沒壞」而繼續使用，尤其粉類受潮後微生物風險高但外觀無法判斷</div>
        <div style="margin-top:10px;display:grid;grid-template-columns:repeat(4,1fr);gap:6px;font-size:12px">
          ${[['葉菜（洗後冷藏）','5天'],['根莖（切開冷藏）','5天'],['水果（切塊冷凍）','30天'],['莓果（冷凍）','30天'],['燕麥粉','60天'],['蛋白粉（開罐）','60天'],['油（開瓶）','90天'],['膠囊','依包裝效期']].map(([n,d])=>
            `<div style="background:var(--bg);border-radius:8px;padding:6px 8px;text-align:center">
              <div style="color:var(--text2);font-size:11px">${n}</div>
              <div style="font-weight:700;color:var(--blue)">${d}</div>
            </div>`).join('')}
        </div>
      </div>

      <div class="sop-section-title">十、GHP 合規強制要求（食安法第 8 條）</div>
      <div class="sop-card">
        <div class="sop-rule">😷 <strong>口罩規定（強制）</strong>　所有在作業場所工作的人員（備料、製作、盤點）作業時均需戴口罩。2025年新版GHP明確規定，查核時會現場確認。</div>
        <div class="sop-rule">📚 <strong>教育訓練記錄（強制）</strong>　新進人員：開始作業前至少 3 小時食安訓練，保存訓練紀錄；現有人員：每年至少 3 小時，包含臨時人員。訓練內容：危險溫度帶、清洗SOP、廢棄處理、個人衛生。</div>
        <div class="sop-rule">🌡 <strong>溫度記錄（強制）</strong>　冷藏／冷凍設備每日記錄溫度，記錄需保存至少 3 年。異常時記錄原因及處理方式。見庫存管理表右側溫度記錄欄。</div>
        <div class="sop-rule">📋 <strong>文件保存（強制）</strong>　所有紀錄文件保存至少 3 年。包含：溫度記錄、廢棄記錄、採購記錄、教育訓練紀錄。建議每月將當月所有表單存檔至雲端備份。</div>
        <div class="sop-rule">🚫 <strong>健康管理</strong>　從業人員有下列情形不得從事與食品接觸作業：手部皮膚病、出疹、膿瘡、外傷、患傳染病或有其他可能污染食品的疾病。（2025年新版已刪除結核病強制檢查）</div>
        <div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border);font-size:12px;color:var(--text3)">
          燕麥粉效期依據：燕麥打粉後接觸空氣面積大增，油脂氧化速度加快，60天為業界研磨穀物粉通用保守標準。裝入乾燥玻璃罐密封，標示日期，每次取用後確實蓋緊。
        </div>
      </div>
    `;

    document.getElementById('sopContent').innerHTML = html;
  }

  function saveBatchNotes(productId, text) {
    dayNotes[productId] = text;
    if (lastTodayData) _saveDayState(lastTodayData.date);
  }

  function toggleQC(itemId, checked) {
    dayQc[itemId] = checked;
    if (lastTodayData) _saveDayState(lastTodayData.date);
    const row = document.getElementById(`qci_${itemId}`);
    if (row) row.classList.toggle('checked', checked);
  }

  function resetQC() {
    if (!confirm('重設今日品質確認清單？（全廚房共用，其他人的畫面也會一起清空）')) return;
    dayQc = {};
    if (lastTodayData) _saveDayState(lastTodayData.date);
    loadSOP();
  }

  // ── 設定 ────────────────────────────────────────────────
  let _settBatchSize = 3;

  function _renderLaborPreview() {
    const el = document.getElementById('settLaborPreview');
    if (!el) return;
    const rate = parseFloat(document.getElementById('settLaborRate').value) || 0;
    const pb   = parseFloat(document.getElementById('settLaborBatch').value) || 0;
    const ps   = parseFloat(document.getElementById('settLaborServing').value) || 0;
    const size = _settBatchSize || 3;
    const perCup = (pb / size + ps) * rate / 60;
    el.innerHTML =
      `一批 ${size} 杯：${pb} 分固定 ＋ ${size} × ${ps} 分 = <strong>${pb + size * ps} 分鐘</strong><br>` +
      `攤到每杯的工資 = <strong>$${Math.round(perCup * 10) / 10}</strong>`;
  }

  async function openSettings() {
    const data = await api('/api/costs');
    const s = data.settings;
    const lm = data.labor_model || {};
    _settBatchSize = lm.batch_size || 3;
    document.getElementById('settLaborRate').value    = s.labor_rate ?? 250;
    document.getElementById('settLaborBatch').value   = s.labor_min_per_batch ?? 15;
    document.getElementById('settLaborServing').value = s.labor_min_per_serving ?? 3;
    document.getElementById('settLookback').value     = s.cost_lookback_days ?? 90;
    document.getElementById('settFullPrice').value    = s.full_formula_price || 350;
    document.getElementById('settPowderPrice').value  = s.powder_formula_price || 280;
    ['settLaborRate', 'settLaborBatch', 'settLaborServing'].forEach(id => {
      document.getElementById(id).oninput = _renderLaborPreview;
    });
    _renderLaborPreview();
    _renderBackups();
    _renderLogs();
    openModal('modalSettings');
  }

  // 操作紀錄。原本的設計要前端主動呼叫 /api/log，結果沒人呼叫過、線上 0 筆；
  // 現在是伺服器每次改資料就自己記一筆，這裡只負責顯示
  let _logTimer = null;
  async function _renderLogs(q) {
    const el = document.getElementById('logList');
    if (!el) return;
    try {
      const r = await api('/api/logs?limit=100' + (q ? '&q=' + encodeURIComponent(q) : ''));
      document.getElementById('logTotal').textContent = `共 ${r.total} 筆`;
      el.innerHTML = r.rows.length ? r.rows.map(x => `
        <div class="log-row">
          <span class="log-when">${esc((x.ts || '').slice(5, 16))}</span>
          <span class="log-who">${esc(x.user_name || '—')}</span>
          <span class="log-what">${esc(x.action)}</span>
          <span class="log-detail" title="${esc(x.detail || '')}">${esc(x.detail || '')}</span>
        </div>`).join('')
        : '<div class="log-empty">沒有符合的紀錄</div>';
    } catch (e) {
      el.innerHTML = '<div class="log-empty">載不到操作紀錄</div>';
    }
  }

  function searchLogs() {
    clearTimeout(_logTimer);
    const q = document.getElementById('logSearch').value.trim();
    _logTimer = setTimeout(() => _renderLogs(q), 250);
  }

  async function _renderBackups() {
    const el = document.getElementById('backupList');
    if (!el) return;
    try {
      const d = await api('/api/backups');
      el.innerHTML = d.backups.length
        ? d.backups.map(b => `
            <div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px dashed var(--border)">
              <a href="#" onclick="App.downloadBackup('${esc(b.name)}');return false"
                 style="color:var(--primary);font-weight:600">${esc(b.name)}</a>
              <span style="margin-left:auto;color:var(--text3)">${Math.round(b.size / 1024)} KB</span>
            </div>`).join('')
        : '<div style="color:var(--text3)">尚無備份</div>';
    } catch (e) { el.innerHTML = '<div style="color:var(--red)">讀取備份清單失敗</div>'; }
  }

  // 下載要帶認證標頭，所以不能直接用連結，得先取回再存成檔案
  async function downloadBackup(name) {
    try {
      const headers = { 'X-Kitchen-User-Id': String(currentUser.id) };
      if (kitchenPassword) headers['X-Kitchen-Password'] = kitchenPassword;
      const r = await fetch('/api/backups/' + encodeURIComponent(name), { headers });
      if (!r.ok) throw new Error('下載失敗（' + r.status + '）');
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { alert(e.message); }
  }

  async function runBackupNow() {
    try {
      const r = await api('/api/backups/run', 'POST');
      await _renderBackups();
      alert(`備份完成：${r.file}（${Math.round(r.size / 1024)} KB）`);
    } catch (e) { alert(e.message); }
  }

  async function saveSettings() {
    await api('/api/settings', 'PUT', {
      labor_rate:            parseFloat(document.getElementById('settLaborRate').value),
      labor_min_per_batch:   parseFloat(document.getElementById('settLaborBatch').value),
      labor_min_per_serving: parseFloat(document.getElementById('settLaborServing').value),
      cost_lookback_days:    parseFloat(document.getElementById('settLookback').value),
      full_formula_price:    parseFloat(document.getElementById('settFullPrice').value),
      powder_formula_price:  parseFloat(document.getElementById('settPowderPrice').value)
    });
    closeModal('modalSettings');
    loadCost();
  }

  // ── 使用者 Modal ─────────────────────────────────────────
  function openAddUser() {
    document.getElementById('newUserName').value = '';
    openModal('modalAddUser');
  }

  async function addUser() {
    const name = document.getElementById('newUserName').value.trim();
    if (!name) return alert('請輸入姓名');
    await api('/api/users', 'POST', { name });
    closeModal('modalAddUser');
    showUserSelect();
  }

  // ── Modal 控制 ───────────────────────────────────────────
  function openModal(id) {
    document.getElementById(id).classList.add('open');
  }
  function closeModal(id) {
    document.getElementById(id).classList.remove('open');
  }
  // 點背景關閉
  document.querySelectorAll('.modal-backdrop').forEach(bd => {
    bd.addEventListener('click', e => { if (e.target === bd) bd.classList.remove('open'); });
  });

  // ── API 工具 ─────────────────────────────────────────────
  async function publicApi(url) {
    const r = await fetch(url);
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: r.statusText }));
      throw new Error(err.error || r.statusText);
    }
    return r.json();
  }

  function ensureKitchenPassword(force = false, userName = '') {
    if (!force && kitchenPassword) return kitchenPassword;
    const label = userName ? `（${userName}）` : '';
    const value = prompt(`請輸入廚房系統密碼${label}`);
    if (!value) throw new Error('需要密碼才能使用廚房系統');
    kitchenPassword = value;
    sessionStorage.setItem('kitchen_password', value);
    return value;
  }

  async function api(url, method = 'GET', body = null) {
    if (!currentUser || !currentUser.id) {
      throw new Error('請先選擇廚房人員');
    }
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Kitchen-User-Id': String(currentUser.id)
      }
    };
    if (kitchenPassword) opts.headers['X-Kitchen-Password'] = kitchenPassword;
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    if (r.status === 401) {
      sessionStorage.removeItem('kitchen_password');
      kitchenPassword = '';
      if (currentUser.requires_password || !kitchenPassword) {
        opts.headers['X-Kitchen-Password'] = ensureKitchenPassword(true, currentUser.name);
        const retry = await fetch(url, opts);
        if (retry.ok) return retry.json();
      }
    }
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: r.statusText }));
      throw new Error(err.error || r.statusText);
    }
    return r.json();
  }

  // ══════════════════════════════════════════════════════
  // 盤點：把帳面庫存拉回現實
  // 帳面只在有人按「拿取」時才扣，忘了按就永遠不扣。定期盤點是唯一
  // 能讓數字回到現實的手段，差異本身就是損耗資訊。
  // ══════════════════════════════════════════════════════
  let stocktakeItems = [];

  async function openStocktake() {
    const d = await api('/api/stocktake/draft');
    stocktakeItems = d.items;
    document.getElementById('stocktakeNote').value = '';
    document.getElementById('stocktakeLast').textContent = d.last_stocktake
      ? `上次盤點：${d.last_stocktake.date}（${d.last_stocktake.user_name || '—'}）`
      : '這是第一次盤點';

    let cat = '';
    document.getElementById('stocktakeList').innerHTML = d.items.map(i => {
      const head = i.category !== cat
        ? `<div style="font-size:11px;font-weight:700;color:var(--text3);margin:10px 0 4px">${esc(i.category)}</div>`
        : '';
      cat = i.category;
      const hint = (i.count_unit && i.count_ratio > 1)
        ? `<span style="font-size:11px;color:var(--text3)">（1${esc(i.count_unit)}=${i.count_ratio}${esc(i.unit)}）</span>` : '';
      return head + `
        <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px dashed var(--border)">
          <span style="flex:1;font-size:13px">${esc(i.name)} ${hint}</span>
          <span style="font-size:12px;color:var(--text3);white-space:nowrap">帳面 ${Math.round(i.book_qty * 10) / 10}${esc(i.unit)}</span>
          <input type="number" step="any" data-st-id="${i.ingredient_id}"
                 placeholder="實際"
                 style="width:96px;padding:6px 8px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:13px">
        </div>`;
    }).join('');
    openModal('modalStocktake');
  }

  async function saveStocktake() {
    const items = [...document.querySelectorAll('[data-st-id]')]
      .filter(el => el.value !== '')
      .map(el => ({ ingredient_id: Number(el.dataset.stId), counted_qty: Number(el.value) }));
    if (!items.length) return alert('至少要填一項實際數量');

    // 先讓人看到差異再決定要不要送出 —— 覆寫庫存是不可逆的
    const diffs = items.map(it => {
      const src = stocktakeItems.find(s => s.ingredient_id === it.ingredient_id);
      return { name: src.name, unit: src.unit, book: src.book_qty,
               counted: it.counted_qty, v: Math.round((it.counted_qty - src.book_qty) * 10) / 10 };
    }).filter(d => Math.abs(d.v) > 0.05);

    const msg = diffs.length
      ? `共 ${items.length} 項，其中 ${diffs.length} 項與帳面不符：\n\n` +
        diffs.slice(0, 12).map(d => `${d.name}　帳面 ${Math.round(d.book*10)/10} → 實際 ${d.counted}${d.unit}　(${d.v > 0 ? '+' : ''}${d.v})`).join('\n') +
        (diffs.length > 12 ? `\n…另有 ${diffs.length - 12} 項` : '') +
        '\n\n送出後庫存會以實際數量為準，確定嗎？'
      : `共 ${items.length} 項，與帳面一致。確定送出？`;
    if (!confirm(msg)) return;

    try {
      const r = await api('/api/stocktake', 'POST', {
        note: document.getElementById('stocktakeNote').value.trim(), items
      });
      closeModal('modalStocktake');
      alert(`盤點完成：${r.counted} 項已更新，其中 ${r.shortage} 項短少。`);
      loadInventory();
      checkInvWarning();
    } catch (e) { alert(e.message); }
  }

  // ══════════════════════════════════════════════════════
  // 套餐模組：外購餐盒 + 精力湯
  // ══════════════════════════════════════════════════════
  let mealMenu   = null;   // { series:[{items:[]}], vendors:[] }
  let mealDay    = null;   // 今日出單與採購清單
  let mealCards  = null;
  let currentMealTab  = 'today';
  let currentMealView = 'buy';   // buy = 採購清單（上午）｜serve = 出餐核對（中午）

  const PTAG_ICON = { '豬': '🥩', '雞': '🍗', '魚': '🐟' };
  // 一筆餐盒出單的生命週期。點狀態晶片往前推一格，點錯了在編輯視窗改回來
  const STATUS_FLOW = ['待採購', '已採購', '已擺盤', '已出餐'];

  function hhmm(t) {
    return (t && t.length === 4) ? t.slice(0, 2) + ':' + t.slice(2) : (t || '');
  }
  function nowHHMM() {
    const d = new Date();
    return String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
  }

  function statusChip(o) {
    const i    = STATUS_FLOW.indexOf(o.status);
    const next = (i >= 0 && i < STATUS_FLOW.length - 1) ? STATUS_FLOW[i + 1] : null;
    const hint = next ? `<span class="st-next">→ ${esc(next)}</span>` : '';
    const title = next ? `點一下改為「${next}」` : '已完成';
    return `<span class="status-chip st-${esc(o.status)}" title="${title}"
              onclick="App.advanceMealStatus(${o.id})">${esc(o.status)}${hint}</span>`;
  }
  function ptag(p) {
    return `<span class="ptag ptag-${esc(p)}">${PTAG_ICON[p] || ''} ${esc(p)}</span>`;
  }

  function switchMealTab(tab) {
    currentMealTab = tab;
    document.querySelectorAll('[data-mtab]').forEach(t => t.classList.toggle('active', t.dataset.mtab === tab));
    document.querySelectorAll('.meal-section').forEach(s =>
      s.classList.toggle('active', s.id === 'mealSection-' + tab));
    if (tab === 'today') renderMealToday();
    if (tab === 'menu')  renderMealMenuAdmin();
    if (tab === 'cards') renderMealCards();
  }

  async function loadMeals() {
    const [menu, day] = await Promise.all([
      api('/api/meals/menu'),
      api('/api/meals/today')
    ]);
    mealMenu = menu;
    mealDay  = day;
    switchMealTab(currentMealTab);
  }

  // ── 今日採購單 ────────────────────────────────────────
  function switchMealView(v) {
    currentMealView = v;
    ['buy', 'serve'].forEach(k => {
      document.getElementById('mealViewBtn-' + k)?.classList.toggle('active', k === v);
      document.getElementById('mealPane-' + k)?.classList.toggle('active', k === v);
    });
  }

  function renderMealToday() {
    const el = document.getElementById('mealToday');
    if (!el || !mealDay) return;

    if (!mealDay.orders.length) {
      el.innerHTML = `<div class="empty-note">今天還沒有餐盒出單。按右上角「＋ 新增餐盒」建立，或等預約系統帶入。</div>`;
      return;
    }

    // 採購檢視：一間店一張單，一次結帳
    const lists = mealDay.purchase_lists.map(g => {
      const allDone = g.lines.every(l => l.all_purchased);
      return `
      <div class="vendor-card">
        <div class="vendor-head">
          <span class="vendor-name">${esc(g.vendor)}</span>
          <span class="vendor-meta">${esc(g.branch)}${g.walk_minutes ? ' ・步行 ' + g.walk_minutes + ' 分' : ''}${g.phone ? ' ・' + esc(g.phone) : ''}</span>
          <span class="vendor-total">$${g.total}</span>
        </div>
        ${g.lines.map(l => `
          <div class="pline ${l.all_purchased ? 'done' : ''}">
            <span class="pline-name">${esc(l.item)}</span>
            <span class="mode-tag">${esc(l.mode)}</span>
            <span class="pline-qty">×${l.qty}</span>
            <span class="pline-money">@$${l.unit_price} = $${l.subtotal}</span>
          </div>`).join('')}
        <div style="margin-top:12px">
          ${allDone
            ? '<span class="badge badge-green" style="font-size:13px;padding:6px 14px">這間買齊了</span>'
            : `<button class="btn btn-primary" onclick="App.openVendorPurchase(${g.vendor_id})">
                 這間買齊了・填總金額
               </button>`}
        </div>
      </div>`;
    }).join('');

    // 出餐檢視：依個案核對，狀態一路推到出餐
    const orders = mealDay.orders.map(o => `
      <div class="meal-order-row">
        <span class="who">${esc(o.patient_name || '員工')}</span>
        <span class="mode-tag">${hhmm(o.meal_time)}</span>
        ${ptag(guessProtein(o.meal_item_id))}
        <span class="dish">${esc(o.display_name)}${o.qty > 1 ? ' ×' + o.qty : ''}</span>
        <span class="spacer">
          <span class="kcal-badge">${o.kcal} kcal</span>
          ${statusChip(o)}
          <button class="btn btn-ghost btn-sm" onclick="App.openEditMealOrder(${o.id})">編輯</button>
          <button class="btn btn-ghost btn-sm" onclick="App.deleteMealOrder(${o.id})">刪除</button>
        </span>
      </div>`).join('');

    const doneCount = mealDay.orders.filter(o => o.status === '已出餐').length;

    el.innerHTML = `
      <div class="card" style="padding:14px 18px;margin-bottom:16px;display:flex;gap:20px;flex-wrap:wrap;align-items:center">
        <div><div style="font-size:12px;color:var(--text3);font-weight:600">今日份數</div>
             <div style="font-size:20px;font-weight:800">${mealDay.orders.reduce((s, o) => s + o.qty, 0)} 份</div></div>
        <div><div style="font-size:12px;color:var(--text3);font-weight:600">預計採購</div>
             <div style="font-size:20px;font-weight:800">$${mealDay.planned_total}</div></div>
        <div><div style="font-size:12px;color:var(--text3);font-weight:600">已回填實付</div>
             <div style="font-size:20px;font-weight:800;color:var(--primary)">$${mealDay.spent_total}</div></div>
        <div><div style="font-size:12px;color:var(--text3);font-weight:600">已出餐</div>
             <div style="font-size:20px;font-weight:800">${doneCount} / ${mealDay.orders.length}</div></div>
      </div>

      <div id="mealPane-buy" class="view-pane ${currentMealView === 'buy' ? 'active' : ''}">
        ${lists}
      </div>
      <div id="mealPane-serve" class="view-pane ${currentMealView === 'serve' ? 'active' : ''}">
        <div class="today-group-label" style="margin-bottom:8px">
          點狀態可以往下一步推進：待採購 → 已採購 → 已擺盤 → 已出餐
        </div>
        ${orders}
      </div>`;

    switchMealView(currentMealView);
  }

  // 餐盒的操作現在可能發生在今日頁的時間軸上，也可能在套餐頁 ——
  // 改完之後要重新整理「使用者正在看的那一頁」
  async function _refreshAfterMealChange() {
    const onToday = document.getElementById('page-today')?.classList.contains('active');
    if (onToday) await loadToday(); else await loadMeals();
  }

  async function advanceMealStatus(id) {
    const o = mealDay?.orders.find(x => x.id === id);
    if (!o) return;
    const i = STATUS_FLOW.indexOf(o.status);
    if (i < 0 || i === STATUS_FLOW.length - 1) return;   // 已出餐是終點
    await api('/api/meals/orders/' + id, 'PUT', { status: STATUS_FLOW[i + 1] });
    await _refreshAfterMealChange();
  }

  function guessProtein(itemId) {
    if (!mealMenu) return '';
    for (const s of mealMenu.series) {
      const it = s.items.find(i => i.id === itemId);
      if (it) return it.protein;
    }
    return '';
  }

  // ── 自動補扣通知 ──────────────────────────────────────
  // 系統在沒人確認的情況下動了庫存，就一定要講出來，而且要能改回去
  // 這是「過去幾天的帳務更正」，不是今天要做的事，所以只給一行。
  // 明細要看再展開；看過按「知道了」就收掉 —— 否則它會永遠佔著版面頂端。
  let _autoSettleOpen = false;

  // 讀不到預約時要講出來。「今天沒有預約」和「連不上預約系統」看起來一樣，
  // 但意思完全不同 —— 實際發生過：權限被改成 401 之後什麼都沒帶進來，
  // 大家以為是自己忘了 key，默默改成全部手動建單
  // 今天的料齊不齊。這個判斷本來只出現在庫存頁，
  // 但廚務同事早上打開的是今日頁 —— 講在他們看不到的地方等於沒講
  // 這份缺料清單的指紋。內容變了才再跳，同一件事不重複吵
  function _shortSig(day) {
    return day.short.map(x => x.name + ':' + x.gap).sort().join('|');
  }
  function _shortSeen(date, sig) {
    try { return localStorage.getItem('short_ack_' + date) === sig; } catch (e) { return false; }
  }
  function _markShortSeen(date, sig) {
    try { localStorage.setItem('short_ack_' + date, sig); } catch (e) {}
  }

  // 缺料清單就是採購清單 —— 東西買回來了要能就地登記，
  // 不必記著品項再去翻另一頁。看到缺料的人跟去買的人是同一個
  let _shortDay = null;
  let _shortQuiet = 0;      // 剛登記完的這一小段時間不要再跳

  function _showShortagePopup(day, force) {
    const sig = _shortSig(day);
    if (!force && (Date.now() < _shortQuiet || _shortSeen(day.date, sig))) return;
    const box = document.getElementById('modalShortage');
    if (!box) return;
    document.getElementById('shortHead').textContent =
      `${day.plan_name || ''} ${day.cups} 杯，${day.short.length} 樣不夠`;
    _shortDay = day;
    const dt = document.getElementById('shortDate');
    if (dt && !dt.value) dt.value = day.date;
    // 「缺 150g」但冷凍庫裡有 3000g —— 那不是缺料，是備料還沒做。
    // 兩件事寫成同一句話，人就會跑去買已經有的東西
    const toBuy  = day.short.filter(x => !x.from_pack);
    const toPrep = day.short.filter(x => x.from_pack);
    const buyRow = x => `<div class="sp-row">
        <div class="sp-top">
          <span class="sp-name">${esc(x.name)}</span>
          <span class="sp-gap">缺 ${x.gap}${esc(x.unit)}</span>
          <span class="sp-have">需要 ${x.need}${esc(x.unit)}・剩 ${x.have}${esc(x.unit)}</span>
        </div>
        <div class="sp-buy">
          <span class="sp-lb">買到</span>
          <input class="sp-in sp-qty" data-id="${x.id}" type="number" min="0" step="0.1"
                 inputmode="decimal" placeholder="${x.gap}">
          <span class="sp-u">${esc(x.unit)}</span>
          <span class="sp-lb">花了</span>
          <input class="sp-in sp-price" data-id="${x.id}" type="number" min="0" step="1"
                 inputmode="numeric" placeholder="選填">
          <span class="sp-u">元</span>
        </div>
      </div>`;
    const prepRow = x => `<div class="sp-row sp-prep">
        <span class="sp-name">${esc(x.name)}</span>
        <span class="sp-gap2">還差 ${x.gap}${esc(x.unit)} 的份</span>
      </div>`;
    document.getElementById('shortList').innerHTML =
      (toBuy.length
        ? `<div class="sp-sec">要買的（${toBuy.length} 樣）</div>` + toBuy.map(buyRow).join('')
        : '') +
      (toPrep.length
        ? `<div class="sp-sec sp-sec2">料已經有了，是冷凍包還沒做（${toPrep.length} 樣）</div>`
          + toPrep.map(prepRow).join('')
          + `<div class="sp-prephint">這幾樣生料在冰箱裡，不用再買。去「備料」把這一批做出來就好。</div>
             <button class="btn btn-ghost sp-prepbtn"
                     onclick="App.closeModal('modalShortage');App.openPrep()">🧊 去備料</button>`
        : '');
    document.getElementById('shortAck').onclick = () => {
      _markShortSeen(day.date, sig);
      closeModal('modalShortage');
    };
    openModal('modalShortage');
  }

  // 從今日頁的缺料橫幅手動叫出來 —— 已經按過「知道了」也要叫得出來
  async function openShortage() {
    let f;
    try { f = await api('/api/inventory/forecast?days=7'); }
    catch (e) { return alert('讀不到庫存預測：' + e.message); }
    const day = (f.days || []).find(x => x.short && x.short.length);
    if (!day) return alert('目前沒有缺料。');
    _showShortagePopup(day, true);
  }

  // 就地登記進貨。數量填了、發票還沒拿到的那幾樣丟進採購籃留著，
  // 不要默默消失 —— 消失掉的那一樣就永遠不會被登記
  async function saveShortagePurchase() {
    if (!_shortDay) return;
    const dtEl = document.getElementById('shortDate');
    const date = (dtEl && dtEl.value) || _shortDay.date;
    const priceOf = id => {
      const el = document.querySelector('#shortList .sp-price[data-id="' + id + '"]');
      return el ? el.value.trim() : '';
    };
    const lines = [...document.querySelectorAll('#shortList .sp-qty')].map(el => ({
      ingredient_id: Number(el.dataset.id),
      qty: Number(el.value),
      total_price: priceOf(el.dataset.id)
    })).filter(l => l.qty > 0);

    if (!lines.length) {
      // 今天全部都是冷凍包沒做的話，這裡一個輸入框都沒有 ——
      // 還叫人「填數量」只會讓人更看不懂
      return alert(document.querySelector('#shortList .sp-qty')
        ? '還沒填任何數量。'
        : '今天沒有要買的東西 —— 缺的那幾樣料都在，只是冷凍包還沒做。');
    }

    const withPrice = lines.filter(l => l.total_price !== '');
    const noPrice   = lines.filter(l => l.total_price === '');

    try {
      let saved = 0;
      if (withPrice.length) {
        const r = await api('/api/purchase/commit', 'POST', { date, lines: withPrice });
        saved = r.saved;
      }
      for (const l of noPrice) {
        await api('/api/purchase/draft', 'PUT', { ingredient_id: l.ingredient_id, qty: l.qty });
      }
      alert(`登記 ${saved} 樣進貨。` +
            (noPrice.length ? `\n另外 ${noPrice.length} 樣只填了數量，放進採購籃，等發票再補金額。` : ''));
      _shortQuiet = Date.now() + 60000;
      closeModal('modalShortage');
      loadToday();
      loadInventory();
    } catch (e) { alert('登記失敗：' + e.message); }
  }

  async function renderTodayShortage(d) {
    const el = document.getElementById('todayShortage');
    if (!el) return;
    let f;
    try { f = await api('/api/inventory/forecast?days=7'); }
    catch (e) { el.innerHTML = ''; return; }

    const day = (f.days || []).find(x => x.date === d.date);
    if (!day || day.cups === 0 || day.feasible) { el.innerHTML = ''; return; }

    // 「缺 150g」但冷凍庫裡有 3000g —— 那不是缺料，是備料還沒做
    const buyN  = day.short.filter(x => !x.from_pack).length;
    const prepN = day.short.length - buyN;
    const top = day.short.filter(x => !x.from_pack).slice(0, 5);
    el.innerHTML = `<div class="today-short">
      <div class="ts-head">⚠ 今天的料不齊　<b>${
        [buyN ? `要買 ${buyN} 樣` : '', prepN ? `備料 ${prepN} 樣` : ''].filter(Boolean).join('、')
      }</b></div>
      <div class="ts-sub">${esc(day.plan_name || '')} ${day.cups} 杯做不完整。${
        buyN ? '要買：' : '生料都在，是冷凍包還沒做。'}</div>
      <div class="ts-chips">
        ${top.map(x => `<span class="ts-chip">${esc(x.name)} 缺 ${x.gap}${esc(x.unit)}</span>`).join('')}
        ${buyN > 5 ? `<span class="ts-chip more">…另 ${buyN - 5} 樣</span>` : ''}
      </div>
      <div class="ts-acts">
        <button class="ts-go ts-buy" onclick="App.openShortage()">✓ 登記已買的</button>
        <a class="ts-go" href="/market.html">🛒 去採購</a>
      </div>
    </div>`;
    _showShortagePopup(day);
  }

  function renderApptSyncWarning(d) {
    const el = document.getElementById('apptSyncWarn');
    if (!el) return;
    const s = d && d.appt_sync;
    if (!s || s.ok !== false) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="sync-down">
      <b>⚠ 讀不到預約系統</b>
      <div>預約上的精力湯不會自動帶進來，今天的單要自己建。
           這不是「今天沒有預約」，是連不上。</div>
      <div class="sync-when">最後嘗試 ${esc(s.at || '')}　${esc(s.error || '')}</div>
    </div>`;
  }

  async function renderAutoSettle() {
    const el = document.getElementById('autoSettleAlert');
    if (!el) return;
    let rows = [];
    try { rows = await api('/api/consumption/auto?days=14&pending=1'); } catch (e) { return; }
    if (!rows.length) { el.innerHTML = ''; return; }

    const byDate = {};
    rows.forEach(r => { (byDate[r.date] = byDate[r.date] || []).push(r); });
    const dates = Object.keys(byDate).sort().reverse();
    const totalCups = Math.round(rows.reduce((s, r) => s + r.cups, 0) * 10) / 10;

    const detail = !_autoSettleOpen ? '' : `
      <div class="as-detail">
        <div class="as-hint">這幾天沒有人按「拿取」，系統依當天的出席與出單補扣了食材。數字不對可以整天還原。</div>
        ${dates.map(d => {
          const list = byDate[d];
          const cups = Math.round(list.reduce((s, r) => s + r.cups, 0) * 10) / 10;
          return `<div class="as-row">
            <span class="as-date">${esc(d)}</span>
            <span>${cups} 杯（${list.map(r => esc(r.rx_name || r.rx_code || '')).join('、')}）</span>
            <button onclick="App.reverseAutoSettle('${esc(d)}')">還原這天</button>
          </div>`;
        }).join('')}
      </div>`;

    el.innerHTML = `
      <div class="auto-settle${_autoSettleOpen ? ' open' : ''}">
        <div class="as-line">
          <span class="as-ico">🧾</span>
          <span class="as-sum">系統補扣了 <strong>${dates.length}</strong> 天的庫存，共 <strong>${totalCups}</strong> 杯</span>
          <button class="as-toggle" onclick="App.toggleAutoSettle()">${_autoSettleOpen ? '收起' : '查看'}</button>
          <button class="as-ack" onclick="App.ackAutoSettle()">知道了</button>
        </div>
        ${detail}
      </div>`;
  }

  function toggleAutoSettle() {
    _autoSettleOpen = !_autoSettleOpen;
    renderAutoSettle();
  }

  async function ackAutoSettle() {
    try {
      await api('/api/consumption/ack', 'POST', {});
      _autoSettleOpen = false;
      await renderAutoSettle();
    } catch (e) { alert(e.message); }
  }

  async function reverseAutoSettle(date) {
    if (!confirm(`還原 ${date} 的自動補扣？食材會加回庫存。`)) return;
    try {
      const rows = await api('/api/consumption/auto?days=30');
      for (const r of rows.filter(x => x.date === date)) {
        await api('/api/consumption/' + r.id + '/reverse', 'POST');
      }
      await renderAutoSettle();
      checkInvWarning();
    } catch (e) { alert(e.message); }
  }

  // ── 今日頁頂部行動列 ──────────────────────────────────
  // 買便當有時間壓力，所以它出現在畫面最上方，而不是捲三分之二頁之後
  function renderMealAlert(meals) {
    const el = document.getElementById('todayMealAlert');
    if (!el) return;

    const pending = meals ? meals.orders.filter(o => o.status === '待採購') : [];
    if (!meals || !pending.length) { el.innerHTML = ''; return; }

    const shops   = new Set(pending.map(o => o.vendor_name).filter(Boolean)).size;
    const t       = meals.timing;
    const overdue = t && nowHHMM() > t.depart_by;

    // 金額只算還沒買的，否則會出現「要買 2 間」卻標示 3 間總額
    const remaining = (meals.purchase_lists || []).reduce((s, g) =>
      s + g.lines.filter(l => !l.all_purchased).reduce((n, l) => n + l.subtotal, 0), 0);

    const timeBlock = t ? `
      <div>
        <div class="ma-time">${hhmm(t.depart_by)}</div>
        <div class="ma-time-label">${overdue ? '已超過出發時間' : '前要出發'}</div>
      </div>` : '';

    const detail = t
      ? `最早 ${hhmm(t.earliest_meal)} 用餐・來回步行與取餐 ${t.travel_minutes} 分・擺盤預留 ${t.plating_buffer} 分`
      : '尚未設定用餐時間';

    el.innerHTML = `
      <div class="meal-alert ${overdue ? 'urgent' : ''}">
        ${timeBlock}
        <div>
          <div class="ma-lead">今天要出門買 ${shops} 間・$${Math.round(remaining)}</div>
          <div class="ma-sub">${detail}</div>
        </div>
        <div class="ma-go">
          <button onclick="App.goBuyMeals()">帶著出門 →</button>
        </div>
      </div>`;
  }

  // 出門買便當是走路中、單手、要打電話的情境，
  // 不該叫人在今日頁裡自己捲找店家。給一頁只有這件事的畫面
  function goBuyMeals() {
    location.href = '/shopping.html';
  }

  // 餐盒已經併進「今日出餐順序」，不再另外列一段。
  // 但當日資料仍要交給 mealDay，時間軸上的狀態推進與編輯才有資料可用
  function renderTodayMeals(meals) {
    renderMealAlert(meals);
    const block = document.getElementById('todayMealBlock');
    if (block) block.style.display = 'none';
    if (meals) mealDay = meals;
  }

  // ── 出單 CRUD ─────────────────────────────────────────
  // 這是後台建單用的，顯示店家沒問題 —— 個案端走 /api/meals/menu/case，那條路徑沒有店家欄位。
  // 分組標題帶出「要去哪家、走多久」，光看選單就知道這一趟要花多少時間
  function mealItemOptions(selectedId) {
    if (!mealMenu) return '';
    return mealMenu.series.map(s => {
      const shop = s.vendor_name
        ? s.vendor_name + (s.walk_minutes ? `・步行 ${s.walk_minutes} 分` : '')
        : '未指定店家';
      return `
      <optgroup label="${esc(s.name)}　→　${esc(shop)}">
        ${s.items.map(i => `<option value="${i.id}" ${i.id === selectedId ? 'selected' : ''}>${PTAG_ICON[i.protein] || ''} ${esc(i.display_name)}（${i.kcal} kcal / $${i.price_box}）</option>`).join('')}
      </optgroup>`;
    }).join('');
  }

  function _mealSeriesOf(itemId) {
    if (!mealMenu) return null;
    return mealMenu.series.find(s => s.items.some(i => i.id === Number(itemId))) || null;
  }

  // 選定品項後，把該去哪家、走多久、電話、店家品名直接放在選單下面，
  // 要出門買的時候不必再翻採購單
  function renderMealOrderVendor() {
    const el  = document.getElementById('mealOrderVendor');
    const sel = document.getElementById('mealOrderItem');
    if (!el || !sel) return;
    const s = _mealSeriesOf(sel.value);
    if (!s || !s.vendor_name) { el.innerHTML = ''; return; }
    const item = s.items.find(i => i.id === Number(sel.value));
    el.innerHTML = `
      <div class="mo-vendor">
        <div class="mo-shop">🏪 ${esc(s.vendor_name)}${s.vendor_branch ? '　' + esc(s.vendor_branch) : ''}</div>
        <div class="mo-meta">
          ${s.walk_minutes ? `<span>🚶 步行 ${s.walk_minutes} 分（來回含取餐約 ${s.walk_minutes * 2 + 5} 分）</span>` : ''}
          ${s.vendor_phone ? `<span>📞 ${esc(s.vendor_phone)}</span>` : ''}
          ${item ? `<span>採購名：<strong>${esc(item.vendor_item_name || item.display_name)}</strong></span>` : ''}
        </div>
      </div>`;
  }

  function caseOrderOptions(selectedId) {
    const cases = [];
    (lastTodayData?.products || []).forEach(p => (p.cases || []).forEach(c => cases.push(c)));
    return '<option value="">不綁定</option>' + cases.map(c =>
      `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${esc(c.patient_name || c.rx_name)}｜${esc(ptLabel(c.powder_type))}</option>`
    ).join('');
  }

  // 要買幾盒。和伺服器的 boxesForOrder() 是同一條規則，改一邊要改兩邊 ——
  // 這裡只負責讓人在按下確定之前就看到結果，真正的數字以伺服器為準
  function _boxesFor(people, sp, sb) {
    if (people <= 0) return 0;
    if (sp <= 1 && sb <= 1) return people;
    return Math.ceil(people * sb / sp);
  }

  function updateBoxHint() {
    const el = document.getElementById('mealOrderBoxHint');
    if (!el) return;
    const people = Number(document.getElementById('mealOrderQty').value) || 0;
    const [sp, sb] = (document.getElementById('mealOrderShare').value || '1:1').split(':').map(Number);
    const boxes = _boxesFor(people, sp, sb);
    if (people <= 0) { el.textContent = ''; el.className = 'box-hint'; return; }
    // 分不盡的份量要講出來，不要讓人自己算
    const capacity = Math.floor(boxes * sp / sb);
    const leftover = capacity - people;
    el.textContent = `${people} 人份 → 要買 ${boxes} 盒` +
      (leftover > 0 ? `（多出 ${leftover} 份）` : '');
    el.className = 'box-hint' + (leftover > 0 ? ' leftover' : '');
  }

  function openAddMealOrder() {
    if (!mealMenu) return alert('菜單還在載入，請稍候');
    document.getElementById('mealOrderTitle').textContent = '新增餐盒';
    document.getElementById('mealOrderId').value    = '';
    document.getElementById('mealOrderItem').innerHTML = mealItemOptions(null);
    renderMealOrderVendor();
    document.getElementById('mealOrderItem').disabled = false;   // 編輯模式會鎖住，這裡要解開
    document.getElementById('mealOrderMode').value  = '餐盒';
    document.getElementById('mealOrderQty').value   = 1;
    document.getElementById('mealOrderShare').value = '1:1';
    document.getElementById('mealOrderTime').value  = '1330';
    document.getElementById('mealOrderName').value  = '';
    document.getElementById('mealOrderNotes').value = '';
    document.getElementById('mealOrderCase').innerHTML = caseOrderOptions(null);
    document.getElementById('mealOrderStatusGroup').style.display = 'none';
    const mdel = document.getElementById('mealDeleteBtn');
    if (mdel) mdel.style.display = 'none';
    updateBoxHint();
    openModal('modalMealOrder');
  }

  async function openEditMealOrder(id) {
    // 從今日頁點進來時，套餐頁可能還沒開過，菜單尚未載入
    if (!mealMenu) { try { mealMenu = await api('/api/meals/menu'); } catch (e) { return alert(e.message); } }
    const o = (mealDay?.orders || []).find(x => x.id === id);
    if (!o) return;
    document.getElementById('mealOrderTitle').textContent = '編輯餐盒出單';
    document.getElementById('mealOrderId').value    = o.id;
    document.getElementById('mealOrderItem').innerHTML = mealItemOptions(o.meal_item_id);
    renderMealOrderVendor();
    document.getElementById('mealOrderItem').disabled = true;
    document.getElementById('mealOrderMode').value  = o.purchase_mode;
    document.getElementById('mealOrderQty').value   = o.qty;
    document.getElementById('mealOrderShare').value =
      `${o.share_people || 1}:${o.share_boxes || 1}`;
    document.getElementById('mealOrderTime').value  = o.meal_time;
    document.getElementById('mealOrderName').value  = o.patient_name || '';
    document.getElementById('mealOrderNotes').value = o.notes || '';
    document.getElementById('mealOrderCase').innerHTML = caseOrderOptions(o.case_order_id);
    document.getElementById('mealOrderStatusGroup').style.display = 'block';
    document.getElementById('mealOrderStatus').value = o.status;
    const mdel = document.getElementById('mealDeleteBtn');
    if (mdel) { mdel.style.display = ''; mdel.onclick = () => { closeModal('modalMealOrder'); deleteMealOrder(id); }; }
    updateBoxHint();
    openModal('modalMealOrder');
  }

  async function saveMealOrder() {
    const id   = document.getElementById('mealOrderId').value;
    const body = {
      meal_item_id:  Number(document.getElementById('mealOrderItem').value),
      purchase_mode: document.getElementById('mealOrderMode').value,
      qty:           Number(document.getElementById('mealOrderQty').value) || 1,
      share_people:  Number((document.getElementById('mealOrderShare').value || '1:1').split(':')[0]) || 1,
      share_boxes:   Number((document.getElementById('mealOrderShare').value || '1:1').split(':')[1]) || 1,
      meal_time:     document.getElementById('mealOrderTime').value || '1330',
      patient_name:  document.getElementById('mealOrderName').value.trim(),
      case_order_id: Number(document.getElementById('mealOrderCase').value) || null,
      notes:         document.getElementById('mealOrderNotes').value.trim()
    };
    if (id) body.status = document.getElementById('mealOrderStatus').value;
    try {
      if (id) await api('/api/meals/orders/' + id, 'PUT', body);
      else    await api('/api/meals/orders', 'POST', body);
      document.getElementById('mealOrderItem').disabled = false;
      closeModal('modalMealOrder');
      await loadMeals();
    } catch (e) { alert(e.message); }
  }

  async function deleteMealOrder(id) {
    if (!confirm('刪除這筆餐盒出單？')) return;
    await api('/api/meals/orders/' + id, 'DELETE');
    await _refreshAfterMealChange();
  }

  // ── 採購回填 ──────────────────────────────────────────
  // 一趟採購 = 一間店 = 一張收據 = 一個總金額，所以回填是以店家為單位。
  // 後端會按預計金額比例把總額拆回各品項，每品項成本仍然可以分析。
  function openVendorPurchase(vendorId) {
    const g = mealDay?.purchase_lists.find(x => x.vendor_id === vendorId);
    if (!g) return;
    const open = g.lines.filter(l => !l.all_purchased);
    if (!open.length) return;

    document.getElementById('mealPurchTitle').textContent  = '回填採購金額';
    document.getElementById('mealPurchNameLabel').textContent = '店家';
    document.getElementById('mealPurchName').value = g.vendor + (g.branch ? '（' + g.branch + '）' : '');
    document.getElementById('mealPurchLines').value = JSON.stringify(
      open.map(l => ({
        meal_item_id:  Number(l.key.split('|')[0]),
        purchase_mode: l.mode,
        qty:           l.qty,
        planned:       l.subtotal
      })));
    document.getElementById('mealPurchOrderIds').value =
      JSON.stringify(open.flatMap(l => l.order_ids));

    const bd = document.getElementById('mealPurchBreakdown');
    bd.style.display = 'block';
    bd.innerHTML = open.map(l =>
      `${esc(l.item)}〔${esc(l.mode)}〕×${l.qty}　預計 $${l.subtotal}`).join('<br>');

    document.getElementById('mealPurchQty').value   = open.reduce((s, l) => s + l.qty, 0);
    document.getElementById('mealPurchPriceLabel').textContent = '這間實付總金額';
    document.getElementById('mealPurchPrice').value = open.reduce((s, l) => s + l.subtotal, 0);
    document.getElementById('mealPurchNote').value  = g.vendor;
    openModal('modalMealPurchase');
  }

  async function saveMealPurchase() {
    try {
      const linesRaw = document.getElementById('mealPurchLines').value;
      await api('/api/meals/purchase', 'POST', {
        lines:       linesRaw ? JSON.parse(linesRaw) : null,
        total_price: Number(document.getElementById('mealPurchPrice').value) || 0,
        order_ids:   JSON.parse(document.getElementById('mealPurchOrderIds').value || '[]'),
        note:        document.getElementById('mealPurchNote').value.trim()
      });
      document.getElementById('mealPurchLines').value = '';
      closeModal('modalMealPurchase');
      await loadMeals();
    } catch (e) { alert(e.message); }
  }

  // ── 菜單維護 ──────────────────────────────────────────
  function renderMealMenuAdmin() {
    const el = document.getElementById('mealMenuAdmin');
    if (!el || !mealMenu) return;
    el.innerHTML = mealMenu.series.map(s => `
      <div style="margin-bottom:22px">
        <div class="section-head" style="margin-bottom:8px">
          <h2 style="font-size:15px">${esc(s.name)}</h2>
          <span class="vendor-meta">後台對接：${esc(s.vendor_name || '未指定')}${s.vendor_branch ? '（' + esc(s.vendor_branch) + '）' : ''}${s.walk_minutes ? '・步行 ' + s.walk_minutes + ' 分' : ''}${s.vendor_phone ? '・' + esc(s.vendor_phone) : ''}</span>
        </div>
        <div style="font-size:12px;color:var(--text3);margin-bottom:10px">${esc(s.tagline)}</div>
        <div class="menu-grid">
          ${s.items.map(i => `
            <div class="menu-item">
              ${ptag(i.protein)}
              ${i.kcal_source === '內部估算' ? '<span class="est-flag" style="margin-left:6px">熱量估算值</span>' : ''}
              <h4>${esc(i.display_name)}</h4>
              <div class="vendor-of">店家品名：${esc(i.vendor_item_name || '—')}</div>
              <div class="nums">整盒 ${i.kcal} kcal・$${i.price_box}　｜　單點 ${i.kcal_single} kcal・$${i.price_single}</div>
              <div class="nums" style="color:var(--text3);margin-top:2px">蛋白質 ${i.protein_g || '—'} g・數據 ${esc(i.nutrition_as_of || '—')}</div>
              <button class="btn btn-ghost btn-sm" style="margin-top:10px" onclick="App.openEditMealItem(${i.id})">編輯</button>
            </div>`).join('')}
        </div>
      </div>`).join('');
  }

  function findMealItem(id) {
    for (const s of mealMenu.series) { const it = s.items.find(i => i.id === id); if (it) return it; }
    return null;
  }

  function openEditMealItem(id) {
    const i = findMealItem(id);
    if (!i) return;
    document.getElementById('mealItemId').value            = i.id;
    document.getElementById('mealItemDisplay').value       = i.display_name;
    document.getElementById('mealItemVendorName').value    = i.vendor_item_name || '';
    document.getElementById('mealItemKcal').value          = i.kcal;
    document.getElementById('mealItemProtein').value       = i.protein_g;
    document.getElementById('mealItemKcalSingle').value    = i.kcal_single;
    document.getElementById('mealItemProteinSingle').value = i.protein_g_single;
    document.getElementById('mealItemPriceBox').value      = i.price_box;
    document.getElementById('mealItemPriceSingle').value   = i.price_single;
    document.getElementById('mealItemSource').value        = i.kcal_source;
    document.getElementById('mealItemAsOf').value          = i.nutrition_as_of || '';
    document.getElementById('mealItemActive').checked      = !!i.active;
    openModal('modalMealItem');
  }

  async function saveMealItem() {
    const id = document.getElementById('mealItemId').value;
    try {
      await api('/api/meals/items/' + id, 'PUT', {
        display_name:     document.getElementById('mealItemDisplay').value.trim(),
        vendor_item_name: document.getElementById('mealItemVendorName').value.trim(),
        kcal:             Number(document.getElementById('mealItemKcal').value) || 0,
        protein_g:        Number(document.getElementById('mealItemProtein').value) || 0,
        kcal_single:      Number(document.getElementById('mealItemKcalSingle').value) || 0,
        protein_g_single: Number(document.getElementById('mealItemProteinSingle').value) || 0,
        price_box:        Number(document.getElementById('mealItemPriceBox').value) || 0,
        price_single:     Number(document.getElementById('mealItemPriceSingle').value) || 0,
        kcal_source:      document.getElementById('mealItemSource').value,
        nutrition_as_of:  document.getElementById('mealItemAsOf').value.trim(),
        active:           document.getElementById('mealItemActive').checked
      });
      closeModal('modalMealItem');
      await loadMeals();
    } catch (e) { alert(e.message); }
  }

  // ── 衛教小卡 ──────────────────────────────────────────
  async function renderMealCards() {
    const el = document.getElementById('mealCards');
    if (!el) return;
    const d = await api('/api/meals/cards');
    mealCards = d.cards;

    const pending = mealCards.filter(c => !c.reviewed_at).length;
    const warn = pending ? `
      <div class="review-warn">
        還有 ${pending} 張小卡未覆核，這些小卡不會被列印。<br>
        小卡是要交到個案手上的衛教文宣，內容請由醫師或法遵確認過再按「標記已覆核」。
      </div>` : '';

    el.innerHTML = warn + mealCards.map(c => `
      <div class="nc-card ${c.reviewed_at ? 'reviewed' : 'unreviewed'}">
        <div class="nc-head">
          <span class="nc-subject">${esc(c.series_name || '核心標配')}｜${esc(c.subject_name || '')}</span>
          ${c.reviewed_at
            ? `<span class="badge badge-green">已覆核 ${esc(c.reviewed_by)} ${esc(c.reviewed_at)}</span>`
            : '<span class="badge badge-orange">待覆核</span>'}
        </div>
        <div class="nc-headline">${esc(c.headline)}</div>
        <div class="nc-ratio">${esc(c.ratio_line)}</div>
        <div class="nc-story">${esc(c.story)}</div>
        <div class="nc-actions">
          <button class="btn btn-ghost btn-sm" onclick="App.openEditNutritionCard(${c.id})">編輯文案</button>
          ${c.reviewed_at
            ? `<button class="btn btn-ghost btn-sm" onclick="App.reviewCard(${c.id},false)">取消覆核</button>`
            : `<button class="btn btn-primary btn-sm" onclick="App.reviewCard(${c.id},true)">標記已覆核</button>`}
        </div>
      </div>`).join('');
  }

  function openEditNutritionCard(id) {
    const c = mealCards.find(x => x.id === id);
    if (!c) return;
    document.getElementById('ncId').value       = c.id;
    document.getElementById('ncHeadline').value = c.headline;
    document.getElementById('ncRatio').value    = c.ratio_line;
    document.getElementById('ncStory').value    = c.story;
    openModal('modalNutritionCard');
  }

  async function saveNutritionCard() {
    const id = document.getElementById('ncId').value;
    try {
      await api('/api/meals/cards/' + id, 'PUT', {
        headline:   document.getElementById('ncHeadline').value.trim(),
        ratio_line: document.getElementById('ncRatio').value.trim(),
        story:      document.getElementById('ncStory').value.trim()
      });
      closeModal('modalNutritionCard');
      await renderMealCards();
    } catch (e) { alert(e.message); }
  }

  async function reviewCard(id, on) {
    if (on && !confirm('確認這張小卡的文案已經過醫師或法遵覆核？覆核後才能列印給個案。')) return;
    await api('/api/meals/cards/' + id, 'PUT', { review: !!on });
    await renderMealCards();
  }

  function openPrintCards() {
    window.open('cards.html?date=' + (mealDay ? mealDay.date : ''), '_blank');
  }

  // ── 個案菜單 ──────────────────────────────────────────
  async function openCaseMenu() {
    // 處方清單可能還沒被「處方」頁載入過，這裡自己補一次
    if (!allPrescriptions.length) {
      try { allPrescriptions = await api('/api/prescriptions'); } catch (e) {}
    }
    const sel = document.getElementById('caseMenuRx');
    sel.innerHTML = allPrescriptions
      .filter(p => p.active)
      .map(p => `<option value="${p.id}">${esc(p.name)}（${esc(p.code)}）</option>`).join('');
    openModal('modalCaseMenu');
  }

  function showCaseMenu() {
    const rx = document.getElementById('caseMenuRx').value;
    const pt = document.getElementById('caseMenuPowder').value;
    closeModal('modalCaseMenu');
    openCaseMenuFor(rx, pt);
  }

  // 今日頁的個案列直接開菜單，省掉「選處方 → 選包裝」那兩步
  function openCaseMenuFor(prescriptionId, powderType) {
    if (!prescriptionId) return alert('這筆出單沒有對應的處方');
    window.open(
      `menu.html?prescription_id=${prescriptionId}&powder_type=${encodeURIComponent(powderType || '袋裝')}`,
      '_blank');
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  // ── 啟動 ────────────────────────────────────────────────
  init();

  return {
    selectUser, logout, switchTab,
    toggleAttendance, handleStaffChipClick, toggleCasePickup, retrySync, toggleSchMore,
    batchDragStart, batchDragEnd, batchDrop, batchDropDelete, editBatchTime, addBatch, removeBatch,
    schDragStart, schDragOver, schDragLeave, schDrop,
    deleteCase, openAddCase, openEditCase, addCase,
    loadRx, openAddRx, openEditRx, saveRx, deleteRx, duplicateRx, openRxHistory, useOwnRx,
    openEditRxIngredients, saveRxIngredients,
    loadInventory, openEditInv, saveInventory, togglePurchaseHistory,
    openAddIngredient, addIngredient, openPurchase, savePurchase, commitPurchaseDraft,
    fillPurchaseDraft,
    openShortage, saveShortagePurchase,
    loadCost, switchCostTab, prevCostMonth, nextCostMonth,
    openSettings, saveSettings,
    openAddUser, addUser,
    openAddProduct, openEditProduct, saveProduct,
    openModal, closeModal,
    openAddLabor, saveLabor, deleteLabor,
    loadTrialRecipes, openAddTrial, openEditTrial, saveTrial, deleteTrial,
    openAddTrialSession, saveTrialSession, deleteTrialSession,
    loadSOP, toggleQC, resetQC, saveBatchNotes,
    toggleCaseRecipe, togglePrepBatches, toggleFutureCases, setSchFilter,
    openStocktake, saveStocktake, reverseAutoSettle, toggleAutoSettle, ackAutoSettle,
    renderMealOrderVendor,
    downloadBackup, runBackupNow,
    toggleLeaveRestore,
    loadMeals, switchMealTab, switchMealView, advanceMealStatus, goBuyMeals,
    openAddMealOrder, openEditMealOrder, saveMealOrder, deleteMealOrder, updateBoxHint,
    toggleForecastAll, toggleSwitchAll, setPlanOverride, clearPlanOverride, searchLogs,
    openPrep, changePrepServings, savePrepBatch,
    openVendorPurchase, saveMealPurchase,
    openEditMealItem, saveMealItem,
    openEditNutritionCard, saveNutritionCard, reviewCard, openPrintCards,
    openCaseMenu, showCaseMenu, openCaseMenuFor
  };
})();
