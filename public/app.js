/* 診所廚房管理系統 v2 */

const App = (() => {
  let currentUser = null;
  let allIngredients = [];
  let allPrescriptions = [];

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

    // A. 員工出席
    const staffGrid = document.getElementById('staffGrid');
    staffGrid.innerHTML = d.staff.map(s => `
      <div class="staff-chip ${s.attending ? 'on' : 'off'}"
           onclick="App.toggleAttendance(${s.user_id}, ${s.attending ? 0 : 1})">
        <div class="dot"></div>
        <div class="sname">${esc(s.name)}</div>
      </div>`).join('');
    document.getElementById('staffCount').textContent = `${d.attending_count}人`;

    // B. 批次計算
    const { three, two } = d.staff_batches;
    const bDiv = document.getElementById('staffBatches');
    if (d.attending_count === 0) {
      bDiv.innerHTML = '<div class="empty"><div class="ei">😴</div>今日無員工出席</div>';
    } else {
      const batchDesc = [
        three > 0 ? `${three} 批 × 3 杯` : '',
        two   > 0 ? `${two} 批 × 2 杯`  : ''
      ].filter(Boolean).join('　+　');
      bDiv.innerHTML = `
        <div class="batch-box">
          <div style="display:flex;gap:16px;align-items:flex-end">
            <div><div class="num">${d.attending_count}</div><div class="label">出席人數</div></div>
            <div style="font-size:28px;font-weight:800;opacity:.7">=</div>
            <div><div class="num" style="font-size:24px">${batchDesc || '—'}</div><div class="label">員工批次（EMP-00）</div></div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">EMP-00 員工備料明細（共 ${d.attending_count} 杯）</div>
          ${d.staff_prep.length === 0 ? '<div style="color:var(--text2);font-size:14px">請先建立 EMP-00 處方</div>' :
            d.staff_prep.map(p => `
              <div class="row">
                <span class="row-label">${esc(p.name)}</span>
                <span class="row-value" style="font-weight:700">${p.total}${p.unit}
                  <span style="font-size:12px;color:var(--text3)">（${p.per_cup}${p.unit}/杯）</span>
                </span>
              </div>`).join('')}
        </div>`;
    }

    // C. 個案出單
    const caseList = document.getElementById('caseList');
    if (d.cases.length === 0) {
      caseList.innerHTML = `<div class="empty"><div class="ei">📋</div>今日尚無個案出單<br><small>點右上角「＋新增」新增</small></div>`;
    } else {
      caseList.innerHTML = d.cases.map(c => {
        const warn = c.contraindications ? `<div class="warn-box">⚠ ${esc(c.contraindications)}</div>` : '';
        const mt = c.meal_time;
        const mStr = mt.length === 4 ? `${mt.slice(0,2)}:${mt.slice(2)}` : mt;
        return `
        <div class="case-card ${c.formula_type === '粉配方' ? 'powder' : ''}">
          <div class="case-head">
            <div>
              <div class="case-name">${esc(c.rx_name)}</div>
              <div class="case-meta">${esc(c.code)} ·
                <span class="badge ${c.formula_type==='全配方'?'badge-blue':'badge-purple'}">${esc(c.formula_type)}</span>
                · ${c.cups}杯 · 取餐 ${mStr} · ${esc(c.timing)}
              </div>
            </div>
            <button class="btn btn-danger btn-sm" onclick="App.deleteCase(${c.id})">刪除</button>
          </div>
          ${warn}
          ${c.prep.length > 0 ? `
          <div class="prep-grid">
            ${c.prep.map(p => `
              <div class="prep-item">
                <div class="pi-name">${esc(p.name)}</div>
                <div class="pi-val">${p.total}${p.unit}
                  <span style="font-size:11px;color:var(--text3)">×${c.cups}杯</span>
                </div>
              </div>`).join('')}
          </div>` : '<div style="color:var(--text2);font-size:13px;margin-top:8px">（此處方無食材資料，請編輯處方）</div>'}
        </div>`;
      }).join('');
    }
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

  async function openAddCase() {
    const rxs = await api('/api/prescriptions');
    const sel = document.getElementById('caseRxSel');
    sel.innerHTML = rxs.filter(r => r.code !== 'EMP-00').map(r =>
      `<option value="${r.id}">${esc(r.code)} — ${esc(r.name)} (${esc(r.formula_type)})</option>`
    ).join('');
    openModal('modalAddCase');
  }

  async function addCase() {
    const prescription_id = document.getElementById('caseRxSel').value;
    const cups = parseInt(document.getElementById('caseCups').value) || 1;
    const meal_time = document.getElementById('caseMealTime').value || '1330';
    const notes = document.getElementById('caseNotes').value;
    await api('/api/today/cases', 'POST', { prescription_id, cups, meal_time, notes });
    closeModal('modalAddCase');
    loadToday();
  }

  // ── 處方管理 ────────────────────────────────────────────
  async function loadRx() {
    allPrescriptions = await api('/api/prescriptions');
    const list = document.getElementById('rxList');
    list.innerHTML = allPrescriptions.map(rx => `
      <div class="rx-card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <div class="rx-code">${esc(rx.code)}</div>
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
      </div>`).join('') || '<div class="empty"><div class="ei">💊</div>尚無處方</div>';
  }

  function openAddRx() {
    document.getElementById('modalRxTitle').textContent = '新增處方';
    document.getElementById('rxEditId').value = '';
    document.getElementById('rxCode').value = '';
    document.getElementById('rxName').value = '';
    document.getElementById('rxType').value = '粉配方';
    document.getElementById('rxTiming').value = '餐前';
    document.getElementById('rxContra').value = '';
    openModal('modalRx');
  }

  function openEditRx(id) {
    const rx = allPrescriptions.find(r => r.id === id);
    if (!rx) return;
    document.getElementById('modalRxTitle').textContent = '編輯處方資訊';
    document.getElementById('rxEditId').value = id;
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
      code: document.getElementById('rxCode').value.trim(),
      name: document.getElementById('rxName').value.trim(),
      formula_type: document.getElementById('rxType').value,
      timing: document.getElementById('rxTiming').value,
      contraindications: document.getElementById('rxContra').value.trim(),
      active: 1
    };
    if (!data.code || !data.name) return alert('請填寫處方代號和姓名');
    if (id) {
      await api(`/api/prescriptions/${id}`, 'PUT', data);
    } else {
      await api('/api/prescriptions', 'POST', data);
    }
    closeModal('modalRx');
    loadRx();
  }

  async function openEditRxIngredients(rxId, rxName) {
    document.getElementById('modalRxIngTitle').textContent = `編輯配方：${rxName}`;
    document.getElementById('rxIngEditId').value = rxId;
    const items = await api(`/api/prescriptions/${rxId}/ingredients`);
    allIngredients = items;

    const cats = ['蔬菜','水果','粉類','膠囊','油水','其他'];
    let html = '';
    cats.forEach(cat => {
      const catItems = items.filter(i => i.category === cat);
      if (catItems.length === 0) return;
      html += `<div class="ie-cat">${cat}</div>`;
      catItems.forEach(i => {
        html += `
          <div class="ie-row">
            <span>${esc(i.name)}</span>
            <span style="font-size:12px;color:var(--text2)">${i.unit}/杯</span>
            <input type="number" min="0" step="0.1" value="${i.qty_per_cup}"
              data-ing-id="${i.id}" id="ing_${i.id}">
          </div>`;
      });
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
    await api(`/api/prescriptions/${rxId}/ingredients`, 'PUT', items);
    closeModal('modalRxIngredients');
    loadRx();
    alert('配方已儲存');
  }

  // ── 庫存管理 ────────────────────────────────────────────
  async function loadInventory() {
    const items = await api('/api/inventory');
    const cats = ['蔬菜','水果','粉類','膠囊','油水','其他'];
    let html = '';
    cats.forEach(cat => {
      const catItems = items.filter(i => i.category === cat);
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
        html += `
          <div class="inv-row">
            <div style="flex:1">
              <div class="inv-name">${esc(i.name)} ${statusBadge}</div>
              ${i.safety_stock > 0 ? `<div class="inv-unit">安全量 ${i.safety_stock}${i.unit}</div>` : ''}
            </div>
            <div class="inv-qty">${i.qty}<span class="inv-unit"> ${i.unit}</span></div>
            <div class="inv-edit" onclick="App.openEditInv(${i.id},'${esc(i.name)}',${i.qty},'${i.unit}')">✏️</div>
          </div>`;
      });
      html += '</div>';
    });
    document.getElementById('invList').innerHTML = html || '<div class="empty">尚無食材資料</div>';
  }

  function openEditInv(id, name, qty, unit) {
    document.getElementById('editInvTitle').textContent = `調整庫存：${name}`;
    document.getElementById('editInvId').value = id;
    document.getElementById('editInvQty').value = qty;
    document.getElementById('editInvQty').placeholder = `單位：${unit}`;
    openModal('modalEditInv');
  }

  async function saveInventory() {
    const id = document.getElementById('editInvId').value;
    const qty = parseFloat(document.getElementById('editInvQty').value) || 0;
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
  async function loadCost() {
    const data = await api('/api/costs');
    const s = data.settings;
    let html = `
      <div class="card" style="margin-bottom:16px">
        <div class="card-title">成本設定</div>
        <div class="row"><span class="row-label">人工費率</span><span class="row-value">NT$${s.labor_rate || 250}/小時</span></div>
        <div class="row"><span class="row-label">製作時間</span><span class="row-value">${s.labor_min_per_cup || 15} 分鐘/杯 → 人工成本 NT$${data.labor_cost_per_cup.toFixed(1)}/杯</span></div>
        <div class="row"><span class="row-label">全配方定價</span><span class="row-value">NT$${s.full_formula_price || 350}</span></div>
        <div class="row"><span class="row-label">粉配方定價</span><span class="row-value">NT$${s.powder_formula_price || 280}</span></div>
      </div>`;

    data.prescriptions.forEach(rx => {
      const price = rx.formula_type === '全配方' ? (s.full_formula_price||350) : (s.powder_formula_price||280);
      const margin = price - rx.total_cost;
      html += `
        <div class="cost-card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start">
            <div>
              <div style="font-size:12px;font-weight:700;color:var(--text2);letter-spacing:1px">${esc(rx.code)}</div>
              <div style="font-size:17px;font-weight:700">${esc(rx.name)}</div>
              <div style="font-size:13px;color:var(--text2)">
                <span class="badge ${rx.formula_type==='全配方'?'badge-blue':'badge-purple'}">${esc(rx.formula_type)}</span>
              </div>
            </div>
            <div style="text-align:right">
              <div class="cost-total">NT$${rx.total_cost}</div>
              <div style="font-size:12px;color:var(--text2)">每杯總成本</div>
              <div style="font-size:13px;margin-top:4px;color:${margin>=0?'var(--green)':'var(--red)'}">
                毛利 NT$${margin.toFixed(1)}
              </div>
            </div>
          </div>
          <div class="cost-breakdown" style="margin-top:14px">
            <div class="cb-row" style="font-weight:700;color:var(--text2)">
              <span>食材</span><span>NT$${rx.ingredient_cost}</span>
            </div>
            ${rx.breakdown.filter(b => b.cost > 0).map(b => `
              <div class="cb-row ${b.cost===0?'cb-zero':''}">
                <span>${esc(b.name)} ${b.qty}${b.unit}/杯</span>
                <span>NT$${b.cost.toFixed(1)}</span>
              </div>`).join('')}
            <div class="cb-row" style="font-weight:700;color:var(--text2)">
              <span>人工（${s.labor_min_per_cup||15}分鐘）</span>
              <span>NT$${rx.labor_cost}</span>
            </div>
          </div>
        </div>`;
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
    toggleAttendance, deleteCase, openAddCase, addCase,
    loadRx, openAddRx, openEditRx, saveRx,
    openEditRxIngredients, saveRxIngredients,
    loadInventory, openEditInv, saveInventory,
    openAddIngredient, addIngredient, openPurchase, savePurchase,
    loadCost, openSettings, saveSettings,
    openAddUser, addUser,
    openModal, closeModal
  };
})();
