/* 診所廚房管理系統 v2 */

const App = (() => {
  let currentUser = null;
  let allIngredients = [];
  let allPrescriptions = [];
  let caseDataMap = {};
  let costMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
  let currentCostTab = 'today';
  let lastTodayData = null;
  let staffPickedUp = new Set();
  let casePickedUp  = new Set();

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
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + tab));
    if (tab === 'today') loadToday();
    if (tab === 'rx')    loadRx();
    if (tab === 'inv')   loadInventory();
    if (tab === 'cost')  loadCost();
  }

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // ── 今日工作單 ─────────────────────────────────────────
  async function loadToday() {
    const d = await api('/api/today');
    lastTodayData = d;

    document.getElementById('staffCount').textContent = `${d.attending_count}人`;
    renderTodaySection1(d);

    // 2+3. 每個產品的批次 + 個案
    caseDataMap = {};
    document.getElementById('productSections').innerHTML = d.products.map(prod => renderProductSection(prod, d.attending_count)).join('');
  }

  function renderTodaySection1(d) {
    // 員工 chips
    const staffHtml = d.staff.map(s => {
      const picked = staffPickedUp.has(s.user_id);
      const cls = picked ? 'picked' : (s.attending ? 'on' : 'off');
      return `<div class="staff-chip ${cls}" onclick="App.handleStaffChipClick(${s.user_id},${s.attending})">
        <div class="dot"></div>
        <div class="sname">${esc(s.name)}</div>
        ${picked ? '<div class="chip-sub">✓ 已拿取</div>' : ''}
      </div>`;
    }).join('');
    document.getElementById('staffGrid').innerHTML = staffHtml;

    // 個案 chips
    const allCases = d.products.flatMap(p => p.cases);
    const freshCases  = allCases.filter(c => c.formula_type === '全配方');
    const powderCases = allCases.filter(c => c.formula_type === '粉配方');

    function caseChip(c, type) {
      const picked = casePickedUp.has(c.id);
      const name = c.patient_name || c.rx_name || c.code;
      const mt = c.meal_time && c.meal_time.length === 4
        ? `${c.meal_time.slice(0,2)}:${c.meal_time.slice(2)}` : (c.meal_time || '');
      const sub = type === 'fresh'
        ? `${esc(c.rx_name)}${mt ? ' · ' + mt : ''}`
        : `${c.cups}天 ${esc(c.powder_type || '袋裝')}`;
      return `<div class="case-chip ${picked ? 'picked' : ''}" data-type="${type}"
                   onclick="App.toggleCasePickup(${c.id})">
        <div class="sname">${esc(name)}</div>
        <div class="chip-sub">${sub}</div>
      </div>`;
    }

    let groupsHtml = '';
    if (freshCases.length > 0) {
      groupsHtml += `<div class="today-group">
        <div class="today-group-label">現打精力湯</div>
        <div class="chips-row">${freshCases.map(c => caseChip(c, 'fresh')).join('')}</div>
      </div>`;
    }
    if (powderCases.length > 0) {
      groupsHtml += `<div class="today-group">
        <div class="today-group-label">粉配方</div>
        <div class="chips-row">${powderCases.map(c => caseChip(c, 'powder')).join('')}</div>
      </div>`;
    }
    document.getElementById('caseChips').innerHTML = groupsHtml;
  }

  function handleStaffChipClick(userId, isAttending) {
    if (!isAttending) {
      // 未出席 → 切換為出席
      toggleAttendance(userId, 1);
      return;
    }
    // 出席中 → 切換已拿取狀態
    if (staffPickedUp.has(userId)) staffPickedUp.delete(userId);
    else staffPickedUp.add(userId);
    if (lastTodayData) renderTodaySection1(lastTodayData);
  }

  function toggleCasePickup(caseId) {
    if (casePickedUp.has(caseId)) casePickedUp.delete(caseId);
    else casePickedUp.add(caseId);
    if (lastTodayData) renderTodaySection1(lastTodayData);
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
        const ratioTip = pw.items.map(i => `${i.name} ${i.qty}${i.unit}`).join('、');
        powderHtml = `
          <div class="powder-box">
            <div class="powder-title">🧪 預調粉包（${esc(prod.staff_rx.code)}）</div>
            <div class="powder-ratio">配比／${unit}：${ratioTip}</div>
            <div class="powder-per-cup">每${unit}取粉 <strong>${pw.per_serving}g</strong></div>
            <div class="powder-batch-row">
              ${pw.batches.map(b => `
                <div class="powder-batch-item">
                  <div class="pb-label">${b.label}</div>
                  <div class="pb-val">${b.per_batch}<span class="pb-unit">g</span></div>
                </div>`).join('')}
            </div>
          </div>`;
      }
      let prepHtml = '';
      if (prod.staff_prep.length > 0) {
        prepHtml = `
          <div class="card">
            <div class="card-title">${esc(prod.staff_rx.code)} 鮮食備料（共 ${prod.total_staff_cups} ${unit}）</div>
            ${prod.staff_prep.map(p => `
              <div class="row">
                <span class="row-label">${esc(p.name)}</span>
                <span class="row-value" style="font-weight:700">${p.total}${p.unit}
                  <span style="font-size:12px;color:var(--text3)">（${p.per_serving}${p.unit}/${unit}）</span>
                </span>
              </div>`).join('')}
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

    // ── RIGHT：AW 個案配比總量 ─────────────────────────────
    const awCases = prod.cases.filter(c => !c.is_staff_rx);
    let rightHtml = '';
    if (awCases.length === 0) {
      rightHtml = `<div class="aw-empty">今日無個案配料需求</div>`;
    } else {
      const awTotalCups = awCases.reduce((s, c) => s + c.cups, 0);
      const ingMap = {};
      const catOf = {};
      const catOrder = ['蔬菜','水果','粉類','保健品','油','水','其他'];
      awCases.forEach(c => {
        (c.prep || []).forEach(p => {
          if (!ingMap[p.name]) { ingMap[p.name] = 0; catOf[p.name] = p.category || '其他'; }
          ingMap[p.name] = Math.round((ingMap[p.name] + p.total) * 10) / 10;
        });
        (c.powder?.items || []).forEach(p => {
          const t = Math.round(p.qty * c.cups * 10) / 10;
          if (!ingMap[p.name]) { ingMap[p.name] = 0; catOf[p.name] = '粉類'; }
          ingMap[p.name] = Math.round((ingMap[p.name] + t) * 10) / 10;
        });
        (c.supplements || []).forEach(s => {
          if (!ingMap[s.name]) { ingMap[s.name] = 0; catOf[s.name] = '保健品'; }
          ingMap[s.name] = Math.round((ingMap[s.name] + s.total) * 10) / 10;
        });
      });
      // get unit per ingredient from cases data
      const unitOf = {};
      awCases.forEach(c => {
        [...(c.prep||[]), ...(c.supplements||[])].forEach(p => { unitOf[p.name] = p.unit; });
        (c.powder?.items||[]).forEach(p => { unitOf[p.name] = p.unit; });
      });

      const grouped = {};
      Object.keys(ingMap).forEach(name => {
        const cat = catOf[name] || '其他';
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push({ name, total: ingMap[name], unit: unitOf[name] || 'g' });
      });

      let rows = '';
      catOrder.forEach(cat => {
        const items = grouped[cat];
        if (!items || items.length === 0) return;
        rows += `<div class="aw-cat">${cat}</div>`;
        items.forEach(item => {
          rows += `<div class="row"><span class="row-label">${esc(item.name)}</span>
            <span class="row-value" style="font-weight:700">${item.total}<span style="font-size:12px;color:var(--text3)">${item.unit}</span></span></div>`;
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

    // 個案出單
    const casesHtml = prod.cases.length === 0
      ? `<div class="empty"><div class="ei">📋</div>今日尚無個案出單</div>`
      : prod.cases.map(c => renderCaseCard(c, unit)).join('');

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
    const typeIcons = { '袋裝': '🛍', '罐裝': '🫙', '內用': '🍽' };
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
        ${c.formula_type !== '粉配方' && c.prep.length > 0 ? `
        <div class="prep-grid">
          ${c.prep.map(p => `
            <div class="prep-item">
              <div class="pi-name">${esc(p.name)}</div>
              <div class="pi-val">${p.total}${p.unit}
                <span style="font-size:11px;color:var(--text3)">×${c.cups}${unit}</span>
              </div>
            </div>`).join('')}
        </div>` : ''}
        ${c.formula_type === '粉配方' && (c.powder?.items || []).length > 0 ? `
        <div class="prep-grid" style="margin-top:8px">
          ${(c.powder.items || []).map(p => `
            <div class="prep-item">
              <div class="pi-name">${esc(p.name)}</div>
              <div class="pi-val">${Math.round(p.qty * c.cups * 10)/10}${p.unit}
                <span style="font-size:11px;color:var(--text3)">×${c.cups}${unit}</span>
              </div>
            </div>`).join('')}
        </div>` : ''}
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
    const payload = { prescription_id, cups, meal_time, powder_type, patient_name, notes };
    if (editId) {
      await api(`/api/today/cases/${editId}`, 'PUT', payload);
    } else {
      await api('/api/today/cases', 'POST', payload);
    }
    closeModal('modalAddCase');
    loadToday();
  }

  // ── 處方管理 ────────────────────────────────────────────
  async function loadRx() {
    allPrescriptions = await api('/api/prescriptions');
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
        ${rxs.map(rx => `
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
              </div>
              <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
                <button class="btn btn-ghost btn-sm" onclick="App.openEditRx(${rx.id})">編輯資訊</button>
                <button class="btn btn-primary btn-sm" onclick="App.openEditRxIngredients(${rx.id},'${esc(rx.name)}')">編輯配方</button>
              </div>
            </div>
          </div>`).join('')}
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
    openModal('modalRx');
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
    const items = await api('/api/inventory');
    const cats = ['蔬菜','水果','粉類','保健品','油','水','其他'];
    let html = '';
    cats.forEach(cat => {
      const catItems = items.filter(i => i.category === cat || (cat === '油' && i.category === '油水'))
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
      if (catItems.length === 0) return;
      html += `<div class="cat-header">${cat}</div>`;
      html += '<div class="card" style="padding:0 16px">';
      catItems.forEach(i => {
        const pct = i.safety_stock > 0 ? i.qty / i.safety_stock : null;
        let statusBadge = '';
        if (pct !== null) {
          if (pct >= 1) statusBadge = '<span class="badge badge-green">✅ 充足</span>';
          else if (pct >= 0.5) statusBadge = '<span class="badge badge-orange">⚠ 偏低</span>';
          else statusBadge = '<span class="badge badge-red">🚨 不足</span>';
        }
        // 顆換算：有 count_unit 的食材（蘋果、帶皮檸檬）
        const hasCount = i.count_unit && i.count_ratio > 1;
        const countQty = hasCount ? Math.round(i.qty / i.count_ratio * 10) / 10 : null;
        const qtyDisplay = hasCount
          ? `${countQty}<span class="inv-unit"> ${i.count_unit}</span><span style="font-size:11px;color:var(--text3)">（${i.qty}${i.unit}）</span>`
          : `${i.qty}<span class="inv-unit"> ${i.unit}</span>`;
        html += `
          <div class="inv-row">
            <div style="flex:1">
              <div class="inv-name">${esc(i.name)} ${statusBadge}</div>
              ${i.safety_stock > 0 ? `<div class="inv-unit">安全量 ${i.safety_stock}${i.unit}</div>` : ''}
              ${hasCount ? `<div class="inv-unit">1${i.count_unit} = ${i.count_ratio}${i.unit}</div>` : ''}
            </div>
            <div class="inv-qty">${qtyDisplay}</div>
            <div class="inv-edit" onclick="App.openEditInv(${i.id},'${esc(i.name)}',${i.qty},'${i.unit}','${i.count_unit||''}',${i.count_ratio||1})">✏️</div>
          </div>`;
      });
      html += '</div>';
    });
    document.getElementById('invList').innerHTML = html || '<div class="empty">尚無食材資料</div>';
  }

  function openEditInv(id, name, qty, unit, countUnit, countRatio) {
    document.getElementById('editInvTitle').textContent = `調整庫存：${name}`;
    document.getElementById('editInvId').value = id;
    document.getElementById('editInvCountUnit').value = countUnit || '';
    document.getElementById('editInvCountRatio').value = countRatio || 1;
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
    await api(`/api/inventory/${id}`, 'PUT', { qty });
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
    if (!qty || !total_price) return alert('請填寫採購量和金額');
    await api('/api/inventory/purchase', 'POST', {
      ingredient_id, qty, total_price, purchased_at,
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
  async function api(url, method = 'GET', body = null) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
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
    deleteCase, openAddCase, openEditCase, addCase,
    loadRx, openAddRx, openEditRx, saveRx,
    openEditRxIngredients, saveRxIngredients,
    loadInventory, openEditInv, saveInventory,
    openAddIngredient, addIngredient, openPurchase, savePurchase,
    loadCost, switchCostTab, prevCostMonth, nextCostMonth,
    openSettings, saveSettings,
    openAddUser, addUser,
    openAddProduct, openEditProduct, saveProduct,
    openModal, closeModal
  };
})();
