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
  let staffPickedUp = new Set();
  let casePickedUp  = new Set();
  let staffBatchGroups = null; // [{size, members:[{id,name,type,userId?,caseId?}]}]
  let batchInitDate    = null; // prevent re-init within same day
  let schCustomOrder   = null; // [key,...] null=auto time-sort
  let schDragKey       = null;
  let batchDragSrc     = null;
  let _allMembersMap   = {}; // id → member, populated by _initBatchGroups
  let empRxId          = null; // employee formula prescription id
  let deductedBatches  = new Set(); // batch indices already inventory-deducted today
  let deductedCases    = new Set(); // case ids already inventory-deducted today

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
    const users = await api('/api/users');
    const grid = document.getElementById('userGrid');
    grid.innerHTML = users.map(u => `
      <div class="user-card" onclick="App.selectUser(${u.id},'${esc(u.name)}')">
        <div class="avatar">${u.name[0]}</div>
        <div class="uname">${esc(u.name)}</div>
      </div>
    `).join('') + `
      <div class="btn-add-user" onclick="App.openAddUser()">
        <div class="avatar" style="background:var(--bg);color:var(--blue)">＋</div>
        新增人員
      </div>`;
  }

  function selectUser(id, name) {
    currentUser = { id, name };
    localStorage.setItem('kitchen_user', JSON.stringify(currentUser));
    showMain();
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
    if (tab === 'sop')   loadSOP();
  }

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // ── 今日工作單 ─────────────────────────────────────────
  function _saveDayState(date) {
    localStorage.setItem(`clinic_day_${date}`, JSON.stringify({
      staff: [...staffPickedUp],
      cases: [...casePickedUp],
      batchGroups: staffBatchGroups ? staffBatchGroups.map(b => ({
        manualTime: b.manualTime || null,
        memberIds: b.members.map(m => m.id)
      })) : null,
      schOrder: schCustomOrder || null,
      deductedBatches: [...deductedBatches],
      deductedCases: [...deductedCases]
    }));
  }
  function _loadDayState(date) {
    try {
      const raw = localStorage.getItem(`clinic_day_${date}`);
      if (!raw) return;
      const { staff = [], cases = [], batchGroups, schOrder, deductedBatches: db2 = [], deductedCases: dc2 = [] } = JSON.parse(raw);
      staffPickedUp   = new Set(staff);
      casePickedUp    = new Set(cases);
      deductedBatches = new Set(db2);
      deductedCases   = new Set(dc2);
      if (batchGroups) {
        const groups = batchGroups.map(b => ({
          manualTime: b.manualTime || null,
          members: (b.memberIds || []).map(id => _allMembersMap[id]).filter(Boolean)
        }));
        if (groups.some(g => g.members.length > 0)) staffBatchGroups = groups;
      }
      if (schOrder) schCustomOrder = schOrder;
    } catch (e) { /* ignore */ }
  }

  async function loadToday() {
    const d = await api('/api/today');
    lastTodayData = d;
    empRxId = d.products?.[0]?.staff_rx?.id || null;
    checkInvWarning();

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
    const leavesAlert = document.getElementById('todayLeavesAlert');
    if (leavesAlert) {
      if (d.leaves && d.leaves.length > 0) {
        leavesAlert.innerHTML = `🌴 今日休假人員：<strong>${d.leaves.join('、')}</strong>（已自動排除本機預設出單）`;
        leavesAlert.style.display = 'block';
      } else {
        leavesAlert.style.display = 'none';
      }
    }

    document.getElementById('staffCount').textContent = `${d.attending_count}人`;
    renderTodaySection1(d);

    // 2+3. 每個產品的批次 + 個案
    caseDataMap = {};
    document.getElementById('productSections').innerHTML = d.products.map(prod => renderProductSection(prod, d.attending_count)).join('');

    laborDate = d.date;
    loadLaborSection(d.date);
  }

  // ── 批次初始化（每日首次或資料重載時執行）────────────────────────
  function _initBatchGroups(d) {
    const prod = d.products && d.products[0];
    if (!prod || d.attending_count === 0) { staffBatchGroups = []; return; }
    const members = [];
    (d.staff || []).filter(s => s.attending).forEach(s =>
      members.push({ id: `s_${s.user_id}`, name: s.name, type: 'staff', userId: s.user_id })
    );
    (prod.staff_rx_cases || []).forEach(c =>
      members.push({ id: `c_${c.id}`, name: c.patient_name || '個案', type: 'case', caseId: c.id, mealTime: c.meal_time || null, cups: c.cups || 1, prescriptionId: c.prescription_id || null })
    );
    _allMembersMap = {};
    members.forEach(m => { _allMembersMap[m.id] = m; });
    const batches = prod.batches || [];
    staffBatchGroups = [];
    let mi = 0;
    batches.forEach(b => {
      for (let i = 0; i < b.count; i++) {
        const bm = [];
        for (let j = 0; j < b.size && mi < members.length; j++, mi++) bm.push(members[mi]);
        staffBatchGroups.push({ size: b.size, members: bm });
      }
    });
    if (mi < members.length) staffBatchGroups.push({ size: members.length - mi, members: members.slice(mi) });
  }

  // ── 批次實際杯數（員工1杯，個案用自己的cups）────────────────────
  function _batchCups(batch) {
    return batch.members.reduce((sum, m) => sum + (m.type === 'case' ? (m.cups || 1) : 1), 0);
  }

  // ── 批次時間計算（可被手動覆蓋）────────────────────────────────
  function _getBatchTime(batch) {
    if (batch.manualTime) {
      const t = batch.manualTime;
      return { sk: `${t}_0`, label: `${t.slice(0,2)}:${t.slice(2)}` };
    }
    const staffInBatch = batch.members.filter(m => m.type === 'staff');
    const caseTimes = batch.members.filter(m => m.type === 'case' && m.mealTime).map(m => m.mealTime).sort();
    if (staffInBatch.length > 0 || caseTimes.length === 0) return { sk: '1130_0', label: '11:30' };
    const t = caseTimes[0];
    return { sk: `${t}_0`, label: t.length === 4 ? `${t.slice(0,2)}:${t.slice(2)}` : t };
  }

  // ── 渲染左側批次分組 ──────────────────────────────────────────
  function _renderBatchGroups() {
    if (!staffBatchGroups || staffBatchGroups.length === 0) return '';
    let html = '<div class="batch-groups-wrap">';
    staffBatchGroups.forEach((batch, bi) => {
      const allDone = batch.members.length > 0 && batch.members.every(m =>
        m.type === 'staff' ? staffPickedUp.has(m.userId) : casePickedUp.has(m.caseId)
      );
      const { label: timeLabel } = _getBatchTime(batch);
      html += `<div class="batch-grp${allDone ? ' batch-grp-done' : ''}"
                    ondragover="event.preventDefault()" ondrop="App.batchDrop(event,${bi})">
        <div class="batch-grp-head">
          <span class="batch-grp-label">批次 ${bi + 1}</span>
          <span class="batch-grp-sz">${_batchCups(batch)}杯</span>
          <span class="batch-grp-time" title="點擊修改時間" onclick="App.editBatchTime(${bi},this)">⏰ ${timeLabel}</span>
          ${allDone ? '<span class="batch-grp-done-tag">✓ 完成</span>' : ''}
          <button class="batch-grp-del" onclick="App.removeBatch(${bi})">×</button>
        </div>
        <div class="batch-grp-members">
          ${batch.members.map(m => {
            const picked = m.type === 'staff' ? staffPickedUp.has(m.userId) : casePickedUp.has(m.caseId);
            const onclick = m.type === 'staff'
              ? `App.handleStaffChipClick(${m.userId},1)`
              : `App.toggleCasePickup(${m.caseId})`;
            return `<div class="bmember-chip${picked ? ' picked' : ''}${m.type === 'case' ? ' bmember-case' : ''}"
                         draggable="true"
                         ondragstart="App.batchDragStart(event,${bi},'${m.id}')"
                         ondragend="App.batchDragEnd()"
                         onclick="${onclick}">
              ${esc(m.name)}${picked ? ' ✓' : ''}
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
        const allDone = batch.members.length > 0 && batch.members.every(m =>
          m.type === 'staff' ? staffPickedUp.has(m.userId) : casePickedUp.has(m.caseId)
        );
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
      if (c.formula_type === '粉配方')  { icon = '🧪'; detail = `粉配方 ${c.cups}天 ${c.powder_type||'袋裝'}`; }
      else if (c.powder_type === '全配方') { icon = '📦'; detail = `全配方外帶 ${c.cups}天`; }
      else                                 { icon = '🥤'; detail = `${c.rx_name} ${c.cups}杯`; }
      const noteText = [c.contraindications, c.notes].filter(Boolean).join(' · ');
      items.push({ key: `case_${c.id}`, sk: `${mt}_1`, timeLabel: tFmt, type: 'case',
        name: `${icon} ${who}`, detail, noteText, done: casePickedUp.has(c.id) });
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
          <div class="sch-detail">${esc(it.detail)}</div>
          ${it.noteText ? `<div class="sch-note">📝 ${esc(it.noteText)}</div>` : ''}
        </div>
        ${it.done ? '<div class="sch-done-mark">✓</div>' : ''}
      </div>`).join('');
    return `<div class="schedule-title">📋 今日出餐順序</div><div id="schList">${rows}</div>`;
  }

  function renderTodaySection1(d) {
    const prod = d.products && d.products[0];

    // 初始化批次（日期改變才重設）
    if (staffBatchGroups === null || batchInitDate !== d.date) {
      batchInitDate = d.date;
      schCustomOrder = null;
      _initBatchGroups(d);
      _loadDayState(d.date);
    }

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
      const picked = casePickedUp.has(c.id);
      const isInuse = c.powder_type === '內用';
      const name = c.patient_name || c.rx_name || c.code;
      const mt = c.meal_time && c.meal_time.length === 4
        ? `${c.meal_time.slice(0,2)}:${c.meal_time.slice(2)}` : (c.meal_time || '');
      const sub = type === 'fresh'
        ? `${esc(c.rx_name)}${mt ? ' · ' + mt : ''}`
        : `${c.cups}天 ${esc(c.powder_type || '袋裝')}${mt ? ' · ' + mt : ''}`;
      return `<div class="case-chip ${picked ? 'picked' : ''}" data-type="${type}" data-inuse="${isInuse?1:0}"
                   onclick="App.toggleCasePickup(${c.id})">
        <div class="sname">${esc(name)}</div>
        <div class="chip-sub">${isInuse ? '🍽 內用' : ''}${sub}</div>
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

  function _checkBatchDeductions() {
    if (!staffBatchGroups) return;
    staffBatchGroups.forEach((batch, bi) => {
      if (deductedBatches.has(bi)) return;
      const allDone = batch.members.length > 0 && batch.members.every(m =>
        m.type === 'staff' ? staffPickedUp.has(m.userId) : casePickedUp.has(m.caseId)
      );
      if (!allDone) return;
      deductedBatches.add(bi);
      // 員工人數 → 員工配方
      const staffCount = batch.members.filter(m => m.type === 'staff').length;
      if (staffCount > 0 && empRxId) {
        api('/api/inventory/consume', 'POST', { prescription_id: empRxId, cups: staffCount }).catch(() => {});
      }
      // 個案（is_staff_rx）→ 各自配方
      batch.members.filter(m => m.type === 'case' && m.prescriptionId).forEach(m => {
        api('/api/inventory/consume', 'POST', { prescription_id: m.prescriptionId, cups: m.cups }).catch(() => {});
      });
    });
  }

  function handleStaffChipClick(userId, isAttending) {
    if (!isAttending) {
      toggleAttendance(userId, 1);
      return;
    }
    if (staffPickedUp.has(userId)) staffPickedUp.delete(userId);
    else staffPickedUp.add(userId);
    _checkBatchDeductions();
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

  function toggleCasePickup(caseId) {
    const wasPickedUp = casePickedUp.has(caseId);
    // Un-pickup: always allowed without confirmation
    if (wasPickedUp) {
      casePickedUp.delete(caseId);
      _checkBatchDeductions();
      if (lastTodayData) { _saveDayState(lastTodayData.date); renderTodaySection1(lastTodayData); }
      return;
    }
    // Pickup: check contraindications first
    const allCases = lastTodayData?.products?.flatMap(p => p.cases) || [];
    const c = allCases.find(x => x.id === caseId);
    const doPickup = () => {
      casePickedUp.add(caseId);
      if (!deductedCases.has(caseId) && c && !c.is_staff_rx) {
        deductedCases.add(caseId);
        api('/api/inventory/consume', 'POST', {
          prescription_id: c.prescription_id, cups: c.cups, powder_type: c.powder_type
        }).catch(() => {});
      }
      _checkBatchDeductions();
      if (lastTodayData) { _saveDayState(lastTodayData.date); renderTodaySection1(lastTodayData); }
    };
    if (c && c.contraindications) {
      _showContraConfirm(c.patient_name || c.rx_name, c.contraindications, doPickup);
    } else {
      doPickup();
    }
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
  function editBatchTime(bi, el) {
    const batch = staffBatchGroups && staffBatchGroups[bi];
    if (!batch) return;
    const cur = batch.manualTime || '1130';
    const input = document.createElement('input');
    input.type = 'time';
    input.value = `${cur.slice(0,2)}:${cur.slice(2)}`;
    input.className = 'batch-time-input';
    el.replaceWith(input);
    input.focus();
    const save = () => {
      const v = input.value.replace(':', '');
      if (v && /^\d{4}$/.test(v)) batch.manualTime = v;
      if (lastTodayData) { _saveDayState(lastTodayData.date); renderTodaySection1(lastTodayData); }
    };
    input.addEventListener('change', save);
    input.addEventListener('blur', save);
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
              <table style="width:100%; border-collapse:collapse; font-size:13px; text-align:left; border:1px solid var(--border); border-radius:var(--radius-sm)">
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

            <div style="margin-top:12px; font-size:12px; color:var(--text3); line-height:1.5">
              💡 <strong>今日出餐批次建議量：</strong><br>
              ${pw.batches.map(b => `• <strong>${b.label}</strong>：每批取總粉量 <strong>${b.per_batch}g</strong>`).join('<br>')}
            </div>
          </div>`;
      }
      let prepHtml = '';
      if (prod.staff_prep.length > 0) {
        prepHtml = `
          <div class="card">
            <div class="card-title">${esc(prod.staff_rx.code)} 鮮食備料（共 ${prod.total_staff_cups} ${unit}）</div>
            ${prod.staff_prep.map(p => {
              const batchRow = batches.length > 0
                ? `<div class="prep-btag-row">${batches.map(b => {
                    const pb = Math.round(b.size * p.per_serving * 10) / 10;
                    return `<span class="prep-btag">${b.size}${unit}批 <strong>${pb}${p.unit}</strong></span>`;
                  }).join('')}</div>`
                : '';
              return `
              <div class="row">
                <span class="row-label">${esc(p.name)}</span>
                <span class="row-value" style="font-weight:700">${p.total}${p.unit}
                  <span style="font-size:12px;color:var(--text3)">（${p.per_serving}${p.unit}/${unit}）</span>
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
            <span class="row-value" style="font-weight:700">${item.total}<span style="font-size:12px;color:var(--text3)">${item.unit}</span>
              <span style="font-size:11px;color:var(--text3);font-weight:400;margin-left:4px">（${item.per}${item.unit}/杯）</span>
            </span></div>`;
        });
      });
      rightHtml = `
        <div class="aw-cups-badge">共 <strong>${awTotalCups}</strong> ${unit}</div>
        <div class="card" style="margin-top:8px;padding:4px 16px">${rows}</div>`;
    }

    // 備註欄
    const notesKey = `batchNotes_${prod.id}`;
    const savedNotes = localStorage.getItem(notesKey) || '';
    const notesSection = `
      <div class="batch-notes-wrap">
        <div class="batch-notes-label">備註</div>
        <textarea class="batch-notes-area" rows="2"
          onchange="localStorage.setItem('${notesKey}',this.value)"
          placeholder="今日備料備註...">${esc(savedNotes)}</textarea>
      </div>`;

    // 個案出單 — 外帶 / 內用 分組
    let casesHtml = '';
    if (prod.cases.length === 0) {
      casesHtml = `<div class="empty"><div class="ei">📋</div>今日尚無個案出單</div>`;
    } else {
      const takeout = prod.cases.filter(c => c.powder_type !== '內用');
      const inuse   = prod.cases.filter(c => c.powder_type === '內用');
      if (takeout.length > 0) {
        casesHtml += `<div class="case-group-head">🛍 外帶（${takeout.length}）</div>`;
        casesHtml += takeout.map(c => renderCaseCard(c, unit)).join('');
      }
      if (inuse.length > 0) {
        casesHtml += `<div class="case-group-head">🍽 內用（${inuse.length}）</div>`;
        casesHtml += inuse.map(c => renderCaseCard(c, unit)).join('');
      }
    }

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

        <div class="section-head" style="margin-top:20px">
          <span class="product-hname">▌C 個案出單</span>
          <button class="btn btn-primary btn-sm" onclick="App.openAddCase(${prod.id})">＋ 新增</button>
        </div>
        ${casesHtml}

        <div class="section-head" style="margin-top:24px">
          <span class="product-hname">▌D 預約出單</span>
        </div>
        <div class="future-cases-box">${futureHtml}</div>
      </div>`;
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
    const typeBadge = `<span class="case-dtype">${typeIcons[c.powder_type] || ''} ${esc(c.powder_type||'袋裝')}</span>`;

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
            <button class="btn btn-ghost btn-sm" onclick="App.openEditCase(${c.id})">編輯</button>
            <button class="btn btn-danger btn-sm" onclick="App.deleteCase(${c.id})">刪除</button>
          </div>
        </div>
        ${warn}
        ${notesHtml}
        ${casePowderHtml}
        ${(() => {
          const pm = c.powder?.powder_multiplier || 1;
          const powderItems = c.powder?.items || [];
          function prepGrid(items) {
            return `<div class="prep-grid">${items.map(p => `
              <div class="prep-item">
                <div class="pi-name">${esc(p.name)}</div>
                <div class="pi-val">${p.total}${p.unit}
                  <span style="font-size:11px;color:var(--text3)">×${c.cups}${unit}</span>
                </div>
              </div>`).join('')}</div>`;
          }
          function powderGrid(items, mult) {
            return `<div class="prep-grid">${items.map(p => {
              const tot = Math.round(p.qty * c.cups * mult * 10) / 10;
              const note = mult > 1 ? ` <span style="font-size:10px;color:var(--orange)">×${mult}</span>` : '';
              return `<div class="prep-item">
                <div class="pi-name">${esc(p.name)}</div>
                <div class="pi-val">${tot}${p.unit}${note}
                  <span style="font-size:11px;color:var(--text3)">×${c.cups}${unit}</span>
                </div>
              </div>`;
            }).join('')}</div>`;
          }

          if (c.powder_type === '全配方') {
            // 全配方：蔬菜(冷藏) + 水果(冷凍) + 油水 + 粉×1.1
            const veg   = c.prep.filter(p => p.category === '蔬菜');
            const fruit = c.prep.filter(p => p.category === '水果');
            const oil   = c.prep.filter(p => p.category !== '蔬菜' && p.category !== '水果');
            let html = '';
            if (veg.length)   html += `<div class="prep-storage-head">🥬 蔬菜 <span class="storage-badge cold">冷藏</span></div>${prepGrid(veg)}`;
            if (fruit.length) html += `<div class="prep-storage-head">🍎 水果 <span class="storage-badge freeze">冷凍</span></div>${prepGrid(fruit)}`;
            if (oil.length)   html += `<div class="prep-storage-head" style="margin-top:8px">🫒 油水</div>${prepGrid(oil)}`;
            if (powderItems.length) html += `<div class="prep-storage-head">🧪 粉類 <span class="storage-badge jar">罐裝 ×1.1</span></div>${powderGrid(powderItems, pm)}`;
            return html;
          } else if (c.formula_type !== '粉配方' && c.prep.length > 0) {
            return prepGrid(c.prep);
          } else if (c.formula_type === '粉配方' && powderItems.length > 0) {
            return powderGrid(powderItems, pm);
          }
          return '';
        })()}
        ${(c.supplements || []).length > 0 ? `
        <div class="supp-grid">
          ${(c.supplements || []).map(s => `
            <div class="supp-item">
              <div class="si-name">${esc(s.name)}</div>
              <div class="si-val">${s.total}${s.unit}</div>
            </div>`).join('')}
        </div>` : ''}
      </div>`;
  }

  async function toggleAttendance(userId, newVal) {
    await api(`/api/today/attendance/${userId}`, 'PUT', { attending: newVal });
    loadToday();
  }

  async function deleteCase(id) {
    if (!confirm('確定刪除此筆出單？')) return;
    await api(`/api/today/cases/${id}`, 'DELETE');
    loadToday();
  }

  async function _buildCaseRxSel(productId, selectedRxId) {
    const rxs = await api('/api/prescriptions');
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
    sel.onchange = updateLabel;
    updateLabel();
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
    const delBtn = document.getElementById('rxDelBtn');
    if (delBtn) delBtn.style.display = 'none';
    openModal('modalRx');
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
      qty_per_cup: parseFloat(inp.value) || 0
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

  // ── 庫存管理 ────────────────────────────────────────────
  async function loadInventory() {
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
              ${i.safety_stock > 0 ? `<div class="inv-unit">安全量 ${i.safety_stock}${i.unit}</div>` : ''}
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

  function updateInvWarningBadge(count) {
    let badge = document.getElementById('invWarningBadge');
    if (!badge) return;
    if (count > 0) {
      badge.textContent = `🔴 ${count} 項缺貨`;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }

  async function checkInvWarning() {
    try {
      const r = await api('/api/inventory/check');
      updateInvWarningBadge(r.insufficient_count || 0);
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

  async function openPurchase() {
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
    const today = new Date().toISOString().slice(0,10);
    const qcKey = `sop_qc_${today}`;
    const savedQc = JSON.parse(localStorage.getItem(qcKey) || '{}');

    function qcItem(id, text) {
      const checked = savedQc[id] || false;
      return `<div class="sop-qc-item${checked?' checked':''}" id="qci_${id}">
        <input type="checkbox" id="qcb_${id}" ${checked?'checked':''} onchange="App.toggleQC('${qcKey}','${id}',this.checked)">
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
            <div class="sop-day-name">週二 / 四 / 五　供應日</div>
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
        <div class="sop-rule">備齊量：員工 9 人 × 3 天（週二＋週四＋週五）＝ <strong>27 份</strong></div>
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
            <div style="font-size:12px;color:var(--text3);margin-top:3px">例：週四看診出單 → 下週一取；週二看診 → 週四才取</div>
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
          <span>完整蔬果＋粉類，週一統一備料，週二四五各取一份製作</span>
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
        <button class="sop-reset-btn" onclick="App.resetQC('${qcKey}')">重設今日</button>
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

  function toggleQC(qcKey, itemId, checked) {
    const saved = JSON.parse(localStorage.getItem(qcKey) || '{}');
    saved[itemId] = checked;
    localStorage.setItem(qcKey, JSON.stringify(saved));
    const row = document.getElementById(`qci_${itemId}`);
    if (row) row.classList.toggle('checked', checked);
  }

  function resetQC(qcKey) {
    if (!confirm('重設今日品質確認清單？')) return;
    localStorage.removeItem(qcKey);
    loadSOP();
  }

  // ── 設定 ────────────────────────────────────────────────
  async function openSettings() {
    const data = await api('/api/costs');
    const s = data.settings;
    document.getElementById('settLaborRate').value = s.labor_rate || 250;
    document.getElementById('settLaborMin').value = s.labor_min_per_cup || 15;
    document.getElementById('settFullPrice').value = s.full_formula_price || 350;
    document.getElementById('settPowderPrice').value = s.powder_formula_price || 280;
    openModal('modalSettings');
  }

  async function saveSettings() {
    await api('/api/settings', 'PUT', {
      labor_rate:           parseFloat(document.getElementById('settLaborRate').value),
      labor_min_per_cup:    parseFloat(document.getElementById('settLaborMin').value),
      full_formula_price:   parseFloat(document.getElementById('settFullPrice').value),
      powder_formula_price: parseFloat(document.getElementById('settPowderPrice').value)
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
  function ensureKitchenPassword(force = false) {
    if (!force && kitchenPassword) return kitchenPassword;
    const value = prompt('請輸入廚房系統密碼');
    if (!value) throw new Error('需要密碼才能使用廚房系統');
    kitchenPassword = value;
    sessionStorage.setItem('kitchen_password', value);
    return value;
  }

  async function api(url, method = 'GET', body = null) {
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Kitchen-Password': ensureKitchenPassword()
      }
    };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    if (r.status === 401) {
      sessionStorage.removeItem('kitchen_password');
      kitchenPassword = '';
      opts.headers['X-Kitchen-Password'] = ensureKitchenPassword(true);
      const retry = await fetch(url, opts);
      if (retry.ok) return retry.json();
    }
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: r.statusText }));
      throw new Error(err.error || r.statusText);
    }
    return r.json();
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  // ── 啟動 ────────────────────────────────────────────────
  init();

  return {
    selectUser, logout, switchTab,
    toggleAttendance, handleStaffChipClick, toggleCasePickup,
    batchDragStart, batchDragEnd, batchDrop, batchDropDelete, editBatchTime, addBatch, removeBatch,
    schDragStart, schDragOver, schDragLeave, schDrop,
    deleteCase, openAddCase, openEditCase, addCase,
    loadRx, openAddRx, openEditRx, saveRx, deleteRx,
    openEditRxIngredients, saveRxIngredients,
    loadInventory, openEditInv, saveInventory, togglePurchaseHistory,
    openAddIngredient, addIngredient, openPurchase, savePurchase,
    loadCost, switchCostTab, prevCostMonth, nextCostMonth,
    openSettings, saveSettings,
    openAddUser, addUser,
    openAddProduct, openEditProduct, saveProduct,
    openModal, closeModal,
    openAddLabor, saveLabor, deleteLabor,
    loadTrialRecipes, openAddTrial, openEditTrial, saveTrial, deleteTrial,
    openAddTrialSession, saveTrialSession, deleteTrialSession,
    loadSOP, toggleQC, resetQC
  };
})();
