/* 診所廚房管理系統 - 前端邏輯 (vanilla JS, no framework) */

// ── 全域狀態 ────────────────────────────────────────────
const state = {
  today:       null,   // /api/today 回傳
  sop:         [],     // SOP 步驟
  curVariant:  1,      // 目前製作版本 (1=個案 2=員工)
  recipe:      null,   // 目前配方
  sopStep:     1,      // 目前 SOP 步驟 index
  batchId:     null,   // 進行中批次 ID
  timerOn:     false,
  timerVal:    0,
  timerTid:    null,
  checksOk:    0,
  checksTotal: 0,
  seasons:     [],
  inventory:   [],
  costs:       [],
};

// ── 工具 ────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const api = {
  get:  url       => fetch(url).then(r => r.json()),
  post: (url, d)  => fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(d) }).then(r => r.json()),
  put:  (url, d)  => fetch(url, { method:'PUT',  headers:{'Content-Type':'application/json'}, body:JSON.stringify(d) }).then(r => r.json()),
};

function fmt(n, unit) { return `${n}${unit}`; }

function statusBadge(s) {
  if (s === 'ok')     return '<span class="badge b-ok">正常</span>';
  if (s === 'warning')return '<span class="badge b-warn">偏低</span>';
  if (s === 'danger') return '<span class="badge b-danger">危險</span>';
  if (s === 'empty')  return '<span class="badge b-danger">無庫存</span>';
  return '';
}

// ── Tab 切換 ────────────────────────────────────────────
function gotoTab(name, title) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('on'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
  $(`s-${name}`).classList.add('on');
  $(`t-${name}`).classList.add('on');
  $('nav-title').textContent = title;
  window.scrollTo(0, 0);

  if (name === 'inv')  loadInventory();
  if (name === 'cost') loadCosts();
  if (name === 'make') loadRecipe();
}

// ── 今日頁 ──────────────────────────────────────────────
async function loadToday() {
  const data = await api.get('/api/today');
  state.today = data;

  // 日期顯示
  const d = new Date();
  const days = ['日','一','二','三','四','五','六'];
  $('nav-sub').textContent = `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日　星期${days[d.getDay()]}`;

  // 季節 badge
  if (data.season) {
    const icons = { '春':'🌸', '夏':'🌞', '秋':'🍂', '冬':'❄️' };
    $('season-badge').textContent = `${icons[data.season.name] || ''}　${data.season.name}季配方`;
  }

  // 統計數字
  const totalCups = data.orders.reduce((s, o) => s + o.cups, 0);
  const staffOrder = data.orders.find(o => o.variant_name === '員工版');
  const caseOrder  = data.orders.find(o => o.variant_name === '個案版');
  const totalBatches = data.batches
    ? data.batches.three + data.batches.two
    : (caseOrder ? 1 : 0);
  const deadline = data.orders[0]?.deadline_time || '13:30';

  $('stat-cups').textContent    = totalCups || '-';
  $('stat-batches').textContent = totalBatches || '-';
  $('stat-time').textContent    = deadline;

  // 變體卡片
  let varHTML = '';
  if (caseOrder) {
    varHTML += `
      <div class="vh gc" onclick="goMake(1)">
        <div class="vh-inner">
          <div class="vh-emoji">🏥</div>
          <div class="vh-body">
            <div class="vh-name">個案版</div>
            <div class="vh-desc">低糖・高蔬菜比例</div>
          </div>
          <div class="vh-right">
            <div class="vh-num">${caseOrder.cups}</div>
            <div class="vh-unit">杯・批次 1</div>
          </div>
        </div>
      </div>`;
  }
  if (staffOrder && data.batches) {
    const { three, two } = data.batches;
    const batchDesc = [
      three > 0 ? `${three}批×3杯` : '',
      two   > 0 ? `${two}批×2杯`   : '',
    ].filter(Boolean).join(' + ');
    varHTML += `
      <div class="vh gs" onclick="goMake(2)">
        <div class="vh-inner">
          <div class="vh-emoji">👥</div>
          <div class="vh-body">
            <div class="vh-name">員工版</div>
            <div class="vh-desc">${batchDesc}</div>
          </div>
          <div class="vh-right">
            <div class="vh-num">${staffOrder.cups}</div>
            <div class="vh-unit">杯・${data.batches.total}批次</div>
          </div>
        </div>
      </div>`;
  }
  if (!caseOrder && !staffOrder) {
    varHTML = `<div class="callout"><span>📋</span><p>今日尚未設定訂單，請點「修改今日訂單」填入杯數。</p></div>`;
  }
  $('today-variants').innerHTML = varHTML;

  // 季節說明
  if (data.season) {
    const nextSeason = { '春':'夏', '夏':'秋', '秋':'冬', '冬':'春' };
    $('today-callout').innerHTML = `
      <div class="callout">
        <span>💡</span>
        <p><b>當季配方</b>：${data.season.name}季水果已生效，固定食材全年不變。</p>
      </div>`;
  }

  // 狀態列
  let statusHTML = '';
  if (data.warnings.length === 0) {
    statusHTML += `
      <div class="row">
        <div class="row-icon" style="background:#e8f8ed">✅</div>
        <div class="row-body"><div class="row-name">食材庫存</div><div class="row-sub">所有食材充足</div></div>
        <span class="badge b-ok">正常</span>
      </div>`;
  } else {
    data.warnings.forEach(w => {
      statusHTML += `
        <div class="row">
          <div class="row-icon" style="background:#fff4e0">⚠️</div>
          <div class="row-body">
            <div class="row-name">${w.name}</div>
            <div class="row-sub">庫存 ${w.stock}${w.unit}，低於安全量 ${w.min_stock}${w.unit}</div>
          </div>
          <span class="badge b-danger">不足</span>
        </div>`;
    });
  }
  const assigned = data.orders[0]?.assigned_staff;
  statusHTML += `
    <div class="row">
      <div class="row-icon" style="background:#eeeeff">👤</div>
      <div class="row-body">
        <div class="row-name">執行人員</div>
        <div class="row-sub">${assigned || '尚未指派'}</div>
      </div>
      ${assigned ? '<span class="badge b-ok">已指派</span>' : '<span style="font-size:13px;color:var(--blue);cursor:pointer" onclick="openOrderModal()">指派 ›</span>'}
    </div>`;
  $('today-status').innerHTML = statusHTML;
}

// ── 製作頁 ──────────────────────────────────────────────
function goMake(variantId = 1) {
  gotoTab('make', '製作模式');
  switchVariant(variantId);
}

function switchVariant(vid) {
  state.curVariant = vid;
  $('sb-case').classList.toggle('on',  vid === 1);
  $('sb-staff').classList.toggle('on', vid === 2);
  loadRecipe();
}

async function loadRecipe() {
  const [recipe, sop] = await Promise.all([
    api.get(`/api/recipe/${state.curVariant}`),
    api.get('/api/sop/1'),
  ]);
  state.recipe = recipe;
  state.sop    = sop;

  // 配方顯示
  const today  = state.today;
  const order  = today?.orders.find(o => o.variant_id === state.curVariant);
  const cups   = order?.cups || 0;

  let html = '';
  if (cups > 0) {
    html += `<div class="sec">今日配方（× ${cups} 杯）</div>`;
  } else {
    html += '<div class="sec">配方明細</div>';
  }
  html += '<div class="card">';

  recipe.base.forEach(item => {
    const total = cups > 0 ? `　＝ ${item.qty_per_cup * cups}${item.unit}` : '';
    html += `
      <div class="recipe-row">
        <div class="recipe-ei">${ingredientEmoji(item.name)}</div>
        <div class="recipe-name">${item.name}</div>
        <div class="recipe-val">${item.qty_per_cup}${item.unit}/杯${total}</div>
      </div>`;
  });
  recipe.seasonal.forEach(item => {
    const total = cups > 0 ? `　＝ ${item.qty_per_cup * cups}${item.unit}` : '';
    html += `
      <div class="recipe-row sea">
        <div class="recipe-ei">${ingredientEmoji(item.name)}</div>
        <div class="recipe-name">${item.name} <span class="badge b-sea">${recipe.season?.name || ''}季</span></div>
        <div class="recipe-val">${item.qty_per_cup}${item.unit}/杯${total}</div>
      </div>`;
  });
  html += '</div>';
  $('recipe-area').innerHTML = html;

  // 重設 SOP
  state.sopStep = 1;
  state.batchId = null;
  renderSopStep();
}

function renderSopStep() {
  const steps = state.sop;
  const n     = state.sopStep;
  if (!steps.length) return;

  // 步驟指示點
  let dotsHTML = '';
  steps.forEach((s, i) => {
    const num = i + 1;
    if (i > 0) dotsHTML += `<div class="sline${num <= n ? ' done' : ''}"></div>`;
    let cls = num < n ? 's-done' : num === n ? 's-active' : 's-lock';
    let txt = num < n ? '✓' : num;
    dotsHTML += `<div class="sdot ${cls}">${txt}</div>`;
  });
  $('step-dots').innerHTML = dotsHTML;

  // 步驟卡片
  const step = steps[n - 1];
  if (!step) return;
  $('step-num').textContent   = `步驟 ${n} / ${steps.length}`;
  $('step-title').textContent = step.title;
  $('step-desc').textContent  = step.description;

  // 計時器
  const tw = $('timer-wrap');
  const cw = $('chk-wrap');
  const btn = $('sop-btn');
  btn.onclick = sopAction;

  if (state.timerTid) { clearInterval(state.timerTid); state.timerTid = null; }
  state.timerOn = false;

  if (step.timer_seconds > 0) {
    state.timerVal = step.timer_seconds;
    tw.style.display = 'block';
    cw.style.display = 'none';
    $('timer-num').textContent = step.timer_seconds;
    $('timer-circ').style.stroke = 'var(--blue)';
    $('timer-circ').style.strokeDashoffset = 0;
    btn.textContent = `▶ 啟動計時器（${step.timer_seconds} 秒）`;
    btn.className   = 'btn';
  } else if (step.checklist?.length) {
    tw.style.display = 'none';
    cw.style.display = 'block';
    state.checksOk    = 0;
    state.checksTotal = step.checklist.length;
    cw.innerHTML = step.checklist.map(c => `
      <div class="chk-item" onclick="toggleChk(this)">
        <div class="chk-box"></div>
        <div class="chk-label">${c.item}</div>
      </div>`).join('');
    btn.textContent = step.n === steps.length ? '✅ 完成' : '確認並繼續';
    btn.className   = 'btn off';
  } else {
    tw.style.display = 'none';
    cw.style.display = 'none';
    btn.textContent = n === steps.length ? '✅ 確認完成此批次' : '完成，繼續下一步 →';
    btn.className   = 'btn';
  }
}

function sopAction() {
  const step  = state.sop[state.sopStep - 1];
  const isLast = state.sopStep === state.sop.length;

  // 開始計時
  if (step.timer_seconds > 0 && !state.timerOn) {
    state.timerOn  = true;
    const total    = step.timer_seconds;
    const circ     = 251.33;
    const btn      = $('sop-btn');
    btn.textContent = '計時中…';
    btn.className   = 'btn off';

    state.timerTid = setInterval(() => {
      state.timerVal--;
      $('timer-num').textContent = state.timerVal;
      $('timer-circ').style.strokeDashoffset = circ * (1 - state.timerVal / total);

      if (state.timerVal <= 0) {
        clearInterval(state.timerTid);
        state.timerOn  = false;
        $('timer-circ').style.stroke = 'var(--green)';
        $('timer-num').textContent   = '✓';
        btn.textContent = '計時完成，繼續 →';
        btn.className   = 'btn green';
        btn.onclick     = advanceStep;
      }
    }, 1000);
    return;
  }

  if (isLast) {
    // 完成批次
    completeBatch();
    return;
  }

  advanceStep();
}

function advanceStep() {
  const btn = $('sop-btn');
  btn.onclick = sopAction;
  state.sopStep++;
  if (state.sopStep > state.sop.length) state.sopStep = state.sop.length;
  renderSopStep();
}

function toggleChk(el) {
  const box = el.querySelector('.chk-box');
  const on  = box.classList.contains('on');
  box.classList.toggle('on', !on);
  box.textContent = on ? '' : '✓';
  state.checksOk += on ? -1 : 1;

  const btn = $('sop-btn');
  if (state.checksOk >= state.checksTotal) {
    btn.className = state.sopStep === state.sop.length ? 'btn green' : 'btn';
    btn.onclick   = advanceStep;
  } else {
    btn.className = 'btn off';
  }
}

async function completeBatch() {
  if (!state.batchId) {
    // 建立批次紀錄
    const order = state.today?.orders.find(o => o.variant_id === state.curVariant);
    if (order) {
      const res = await api.post('/api/batch/start', {
        daily_order_id: order.id,
        batch_number:   1,
        batch_size:     order.cups,
        operator:       order.assigned_staff || '',
      });
      state.batchId = res.id;
    }
  }

  if (state.batchId) {
    await api.post(`/api/batch/${state.batchId}/complete`, {});
  }

  // 完成畫面
  $('step-card').style.background = '#e8f8ed';
  $('step-title').textContent = '✅ 批次完成！';
  $('step-desc').textContent  = '庫存已自動扣除，完成記錄已儲存。';
  $('timer-wrap').style.display = 'none';
  $('chk-wrap').style.display   = 'none';
  const btn = $('sop-btn');
  btn.textContent = '返回今日總覽';
  btn.className   = 'btn';
  btn.onclick     = () => { $('step-card').style.background = ''; loadToday(); gotoTab('today','今日廚房'); };
}

// ── 庫存頁 ──────────────────────────────────────────────
async function loadInventory() {
  const items = await api.get('/api/inventory');
  state.inventory = items;

  let html = '';
  items.forEach(item => {
    const pct = item.min_stock > 0
      ? Math.min(100, (item.current_stock / (item.min_stock * 2)) * 100)
      : 100;
    const barColor = item.status === 'ok' ? 'var(--green)'
                   : item.status === 'warning' ? 'var(--orange)'
                   : 'var(--red)';
    html += `
      <div class="row" style="cursor:pointer" onclick="openCostEditModal(${item.id},'${item.name}',${item.cost_per_unit},'${item.unit}')">
        <div class="row-icon" style="background:#f5f5f5;font-size:18px">${ingredientEmoji(item.name)}</div>
        <div class="row-body">
          <div class="row-name">${item.name}</div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:4px">
            <div style="flex:1;height:3px;background:var(--sep);border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${pct}%;background:${barColor};border-radius:3px"></div>
            </div>
            <span style="font-size:11px;color:var(--t3);white-space:nowrap">${item.current_stock}${item.unit}</span>
          </div>
        </div>
        ${statusBadge(item.status)}
      </div>`;
  });
  $('inv-list').innerHTML = html || '<div class="row"><div class="row-body"><div class="row-name" style="color:var(--t3)">無資料</div></div></div>';
}

// ── 成本頁 ──────────────────────────────────────────────
async function loadCosts() {
  const data = await api.get('/api/costs');
  state.costs = data;

  let html = '';
  data.forEach(v => {
    const hasPrice = v.items.some(i => i.cost_per_unit > 0);
    html += `
      <div class="sec">${v.variant.name}</div>
      <div class="cost-total">$${v.total_per_cup.toFixed(1)}</div>
      <div class="cost-unit">每杯食材成本${hasPrice ? '' : '（請先填入食材單價）'}</div>
      <div class="card">`;
    v.items.forEach(item => {
      html += `
        <div class="row" style="cursor:pointer" onclick="openCostEditModal(null,'${item.name}',${item.cost_per_unit},'${item.unit}')">
          <div class="row-icon" style="background:#f5f5f5;font-size:16px">${ingredientEmoji(item.name)}</div>
          <div class="row-body">
            <div class="row-name">${item.name}</div>
            <div class="row-sub">${item.qty_per_cup}${item.unit}/杯</div>
          </div>
          <span class="row-val">$${(item.item_cost || 0).toFixed(2)}</span>
        </div>`;
    });
    html += '</div>';
  });
  $('cost-area').innerHTML = html;
}

// ── 彈窗 ────────────────────────────────────────────────
function openModal(name)  { $(`modal-${name}`).classList.add('on'); }
function closeModal(name) { $(`modal-${name}`).classList.remove('on'); }

function openOrderModal() {
  const o = state.today?.orders;
  const c = o?.find(x => x.variant_name === '個案版');
  const s = o?.find(x => x.variant_name === '員工版');
  $('inp-case').value       = c?.cups || 0;
  $('inp-staff').value      = s?.cups || 0;
  $('inp-deadline').value   = o?.[0]?.deadline_time || '13:30';
  $('inp-staff-name').value = o?.[0]?.assigned_staff || '';
  openModal('order');
}

async function saveOrder() {
  await api.post('/api/today/orders', {
    case_cups:      parseInt($('inp-case').value)   || 0,
    staff_cups:     parseInt($('inp-staff').value)  || 0,
    deadline:       $('inp-deadline').value,
    assigned_staff: $('inp-staff-name').value,
  });
  closeModal('order');
  loadToday();
}

async function openPurchaseModal() {
  // 填充食材下拉
  if (!state.inventory.length) state.inventory = await api.get('/api/inventory');
  $('inp-ing').innerHTML = state.inventory.map(i =>
    `<option value="${i.id}">${i.name}（目前：${i.current_stock}${i.unit}）</option>`
  ).join('');
  $('inp-qty').value  = '';
  $('inp-note').value = '';
  openModal('purchase');
}

async function savePurchase() {
  const ingredient_id = parseInt($('inp-ing').value);
  const qty           = parseFloat($('inp-qty').value);
  if (!qty || qty <= 0) { alert('請輸入有效數量'); return; }
  await api.post('/api/inventory/purchase', { ingredient_id, qty, note: $('inp-note').value });
  closeModal('purchase');
  loadInventory();
}

// 成本編輯（點擊食材行）
let _costIngId = null;
function openCostEditModal(ingId, name, currentCost, unit) {
  _costIngId = ingId;
  const cost = prompt(`${name}（${unit}）的單位成本（元/${unit}）：`, currentCost || 0);
  if (cost === null) return;
  const val = parseFloat(cost);
  if (isNaN(val)) return;
  // 找食材 id
  const item = state.inventory.find(i => i.name === name);
  const id   = ingId || item?.id;
  if (!id) return;
  api.put(`/api/ingredients/${id}/cost`, { cost_per_unit: val })
     .then(() => { loadInventory(); loadCosts(); });
}

// 季節彈窗
async function openSeasonModal() {
  const seasons = await api.get('/api/seasons');
  state.seasons = seasons;
  const icons = { '春':'🌸', '夏':'🌞', '秋':'🍂', '冬':'❄️' };
  $('season-list').innerHTML = seasons.map(s => `
    <div class="row" style="cursor:pointer" onclick="setSeason(${s.id})">
      <div class="row-icon" style="background:#f5f5f5;font-size:20px">${icons[s.name] || ''}</div>
      <div class="row-body"><div class="row-name">${s.name}季（${s.start_month}–${s.end_month}月）</div></div>
      ${s.is_current ? '<span class="badge b-ok">目前</span>' : ''}
    </div>`).join('');
  openModal('season');
}

async function setSeason(id) {
  await api.put(`/api/seasons/current/${id}`, {});
  closeModal('season');
  loadToday();
  if ($('s-make').classList.contains('on')) loadRecipe();
}

// ── emoji 對應 ───────────────────────────────────────────
function ingredientEmoji(name) {
  const map = {
    '蛋白粉':'🫙','燕麥粉':'🌾','薑黃':'🟡','羽衣甘藍':'🥬',
    '奶油萵苣':'🥗','冷壓油':'🫧','水':'💧',
    '芒果':'🥭','奇異果':'🥝','鳳梨':'🍍','草莓':'🍓',
    '藍莓':'🫐','香蕉':'🍌','蘋果':'🍎','葡萄':'🍇',
    '柳橙':'🍊','梨子':'🍐','柑橘':'🍊',
  };
  return map[name] || '🌿';
}

// ── 初始化 ───────────────────────────────────────────────
loadToday();
