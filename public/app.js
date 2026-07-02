const app = document.querySelector('#app');
const entryMode = document.body.dataset.entry || 'user';

if (location.protocol === 'file:') {
  app.innerHTML = `
    <section class="login-wrap">
      <div class="login-card">
        <h1>需要通过服务访问</h1>
        <p>请先在服务器运行 npm start，然后访问 http://服务器IP:3388。</p>
      </div>
    </section>`;
  throw new Error('This panel must be opened through the Node.js server.');
}

const state = {
  user: null,
  role: '',
  view: 'customers',
  userView: 'user-home',
  db: null,
  setupRequired: false,
  setupForm: {
    host: '127.0.0.1',
    port: '3306',
    database: 'shiye_management',
    user: 'shiye',
    password: ''
  },
  drawer: null,
  modal: null,
  search: '',
  toast: ''
};

let modalResolver = null;

const statusText = {
  active: '正常',
  warning: '将到期',
  expired: '已过期',
  disabled: '已停用',
  success: '成功',
  failed: '失败',
  unused: '未使用',
  used: '已使用',
  enabled: '启用'
};

const adminNavItems = [
  ['customers', '用户管理', 'U'],
  ['cards', '卡密管理', 'C'],
  ['finance', '财务流水', 'F'],
  ['servers', '3x-ui 节点', 'N'],
  ['socks', 'SOCKS 出站', 'S'],
  ['logs', '同步日志', 'L']
];

const userNavItems = [
  ['user-home', '充值续费', 'B'],
  ['user-nodes', '节点管理', 'N']
];

function h(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

function money(value) {
  return Number(value || 0).toFixed(2);
}

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false }).replaceAll('/', '-');
}

function dateInputValue(value) {
  if (!value) return '';
  const date = new Date(value);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toIsoLocal(value) {
  return value ? new Date(value).toISOString() : '';
}

function toast(message) {
  state.toast = message;
  render();
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    state.toast = '';
    render();
  }, 3600);
}

function openModal(options) {
  state.modal = {
    title: options.title || '请确认',
    message: options.message || '',
    tone: options.tone || 'default',
    input: options.input || null,
    confirmText: options.confirmText || '确定',
    cancelText: options.cancelText || '取消'
  };
  render();
  return new Promise((resolve) => {
    modalResolver = resolve;
    requestAnimationFrame(() => document.querySelector('[data-modal-input]')?.focus());
  });
}

function closeModal(value) {
  state.modal = null;
  const resolve = modalResolver;
  modalResolver = null;
  render();
  if (resolve) resolve(value);
}

function confirmDialog(title, message, options = {}) {
  return openModal({ title, message, tone: options.tone, confirmText: options.confirmText, cancelText: options.cancelText });
}

function promptDialog(title, message, value = '') {
  return openModal({ title, message, input: { value }, confirmText: '保存' });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Entry-Mode': entryMode, ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.detail || data.message || '请求失败');
  return data;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

async function bootstrap() {
  try {
    const setup = await api('/api/setup/status');
    if (!setup.installed) {
      state.setupRequired = true;
      state.user = null;
      state.role = '';
      state.db = null;
      renderSetup();
      return;
    }
    state.setupRequired = false;
    const result = await api(`/api/bootstrap?entry=${encodeURIComponent(entryMode)}`);
    state.user = result.user;
    state.role = result.role || 'admin';
    state.db = result.data;
    if (state.role === 'user') state.userView ||= 'user-home';
    render();
  } catch {
    state.user = null;
    state.role = '';
    state.db = null;
    renderLogin();
  }
}

function renderSetup() {
  const setup = state.setupForm;
  app.innerHTML = `
    <section class="login-wrap setup-wrap">
      <form class="login-card setup-card" id="setupForm">
        <h1>首次安装</h1>
        <p>填写 MySQL 数据库信息，系统会测试连接并自动创建所需数据表。1Panel、宝塔面板部署时推荐使用这个向导完成绑定。</p>
        <div class="setup-grid">
          <div class="field"><label>数据库地址</label><input name="host" value="${h(setup.host)}" required></div>
          <div class="field"><label>端口</label><input name="port" type="number" value="${h(setup.port)}" min="1" required></div>
          <div class="field"><label>数据库名称</label><input name="database" value="${h(setup.database)}" required></div>
          <div class="field"><label>数据库账号</label><input name="user" value="${h(setup.user)}" autocomplete="username" required></div>
          <div class="field full"><label>数据库密码</label><input name="password" type="password" value="${h(setup.password)}" autocomplete="current-password"></div>
        </div>
        <button class="btn primary login-submit" type="submit">连接并安装</button>
      </form>
      ${state.toast ? `<div class="toast">${h(state.toast)}</div>` : ''}
    </section>`;

  const setupForm = document.querySelector('#setupForm');
  setupForm.addEventListener('input', (event) => {
    if (!event.target.name) return;
    state.setupForm[event.target.name] = event.target.value;
  });
  setupForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    state.setupForm = { ...state.setupForm, ...Object.fromEntries(form) };
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = '正在安装...';
    try {
      await api('/api/setup/install', { method: 'POST', body: Object.fromEntries(form) });
      toast('安装完成，请使用管理员账号登录');
      await bootstrap();
    } catch (error) {
      toast(error.message);
      button.disabled = false;
      button.textContent = '连接并安装';
    }
  });
}

async function refresh() {
  const result = await api(`/api/bootstrap?entry=${encodeURIComponent(entryMode)}`);
  state.user = result.user;
  state.role = result.role || state.role;
  state.db = result.data;
  render();
}

function renderLogin() {
  app.innerHTML = `
    <section class="login-wrap">
      <form class="login-card" id="loginForm">
        <h1>${entryMode === 'admin' ? '十夜管理系统' : '十夜用户中心'}</h1>
        <p>${entryMode === 'admin' ? '管理员后台入口。普通用户请从用户中心登录。' : '用户使用管理员创建的账号登录。用户端不开放注册。'}</p>
        <div class="field"><label>账号</label><input name="username" autocomplete="username" required></div>
        <div class="field"><label>密码</label><input name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn primary login-submit" type="submit">登录</button>
      </form>
      ${state.toast ? `<div class="toast">${h(state.toast)}</div>` : ''}
    </section>`;

  document.querySelector('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api('/api/login', { method: 'POST', body: { ...Object.fromEntries(form), entry: entryMode } });
      await bootstrap();
    } catch (error) {
      toast(error.message);
    }
  });
}

function render() {
  if (state.setupRequired) return renderSetup();
  if (!state.db) return renderLogin();
  if (state.role === 'user') return renderUserApp();
  return renderAdminApp();
}

function navButton(view, label, icon, activeView) {
  return `<button class="${activeView === view ? 'active' : ''}" data-view="${view}" data-icon="${icon}">${label}</button>`;
}

function pageTitle() {
  return {
    customers: '用户管理',
    cards: '卡密管理',
    finance: '财务流水',
    servers: '3x-ui 节点',
    socks: 'SOCKS 出站',
    logs: '同步日志'
  }[state.view] || '用户管理';
}

function stats() {
  const customers = state.db.customers || [];
  return {
    total: customers.length,
    active: customers.filter((c) => c.computedStatus === 'active').length,
    warning: customers.filter((c) => c.computedStatus === 'warning').length,
    expired: customers.filter((c) => c.computedStatus === 'expired').length,
    disabled: customers.filter((c) => c.computedStatus === 'disabled').length
  };
}

function renderAdminApp() {
  const s = stats();
  app.innerHTML = `
    <section class="app-shell">
      <aside class="sidebar">
        <div class="brand"><span class="brand-mark">十夜</span><span>管理系统</span></div>
        <nav class="nav">${adminNavItems.map(([view, label, icon]) => navButton(view, label, icon, state.view)).join('')}</nav>
        <div class="sidebar-footer">登录用户：${h(state.user)}<br>版本：0.3.0<br>数据存储：服务器数据库</div>
      </aside>
      <section class="content">
        <div class="topbar">
          <div>
            <div class="eyebrow">3X-UI CUSTOMER OPS</div>
            <h1>${pageTitle()}</h1>
            <div class="sub">管理员后台管理用户、卡密、3x-ui 节点和 SOCKS 中转。</div>
          </div>
          <div class="actions">
            <button class="btn" data-action="disable-expired">停用过期用户</button>
            <button class="btn" data-action="refresh">刷新</button>
            <button class="btn" data-action="settings">系统设置</button>
            <button class="btn" data-action="security">账号安全</button>
            <button class="btn danger" data-action="logout">退出</button>
          </div>
        </div>
        <div class="stats">
          <div class="stat total"><span>用户总数</span><strong>${s.total}</strong><small>当前系统记录</small></div>
          <div class="stat"><span>正常</span><strong>${s.active}</strong><small>可正常使用</small></div>
          <div class="stat"><span>将到期</span><strong>${s.warning}</strong><small>3 天内到期</small></div>
          <div class="stat"><span>已过期</span><strong>${s.expired}</strong><small>等待续费或停用</small></div>
          <div class="stat"><span>已停用</span><strong>${s.disabled}</strong><small>已关闭服务</small></div>
        </div>
        ${state.db.settings?.defaultPasswordWarning ? `<div class="security-warning"><strong>当前仍在使用默认管理员密码。</strong><span>公网部署建议修改管理员密码。</span><button class="btn small" data-action="security">账号安全</button></div>` : ''}
        ${renderAdminView()}
      </section>
    </section>
    ${state.drawer ? renderDrawer() : ''}
    ${state.modal ? renderModal() : ''}
    ${state.toast ? `<div class="toast">${h(state.toast)}</div>` : ''}`;
  bindEvents();
}

function renderAdminView() {
  if (state.view === 'cards') return renderCards();
  if (state.view === 'finance') return renderFinance();
  if (state.view === 'servers') return renderServers();
  if (state.view === 'socks') return renderSocks();
  if (state.view === 'logs') return renderLogs();
  return renderCustomers();
}

function renderCustomers() {
  const term = state.search.toLowerCase();
  const rows = (state.db.customers || []).filter((customer) => [
    customer.name,
    customer.contact,
    customer.loginUsername,
    customer.clientEmail,
    customer.remark
  ].join(' ').toLowerCase().includes(term));

  return `
    <div class="toolbar">
      <div class="toolbar-left"><input class="search" placeholder="搜索用户、登录账号、联系方式、client email" value="${h(state.search)}" data-search></div>
      <div class="toolbar-right"><button class="btn primary" data-action="new-customer">+ 新建用户</button></div>
    </div>
    <section class="panel">
      <div class="panel-head"><div><h2>用户列表</h2><p>管理员创建用户登录账号，用户端不能自行注册。</p></div></div>
      <table><thead><tr>
        <th style="width:170px">用户</th><th style="width:126px">登录账号</th><th style="width:110px">余额</th><th style="width:120px">节点价格</th><th style="width:158px">到期时间</th><th style="width:88px">流量</th><th style="width:160px">3x-ui</th><th style="width:132px">SOCKS</th><th style="width:88px">状态</th><th style="width:336px">操作</th>
      </tr></thead><tbody>${rows.length ? rows.map(customerRow).join('') : `<tr><td colspan="10" class="empty">还没有用户，点击右上角新建用户。</td></tr>`}</tbody></table>
    </section>`;
}

function customerRow(customer) {
  const server = state.db.xuiServers.find((item) => item.id === customer.xuiServerId);
  const socks = state.db.socksNodes.find((item) => item.id === customer.socksNodeId);
  return `<tr>
    <td class="main-cell"><strong>${h(customer.name)}</strong><div class="line mono">${h(customer.clientEmail || '-')}</div></td>
    <td>${h(customer.loginUsername || '-')}<div class="muted">${h(customer.contact || '')}</div></td>
    <td>${money(customer.balance)} ${h(state.db.settings.currency)}</td>
    <td>${money(customer.amount)} ${h(state.db.settings.currency)}<div class="muted">每月续费</div></td>
    <td>${fmtDate(customer.expireAt)}</td>
    <td>${h(customer.trafficLimitGb)} GB</td>
    <td>${h(server?.name || '-')}<div class="mono muted">inbound: ${h(customer.inboundId || '-')}</div></td>
    <td>${customer.useSocks ? `${h(socks?.name || '未选择')}<div class="mono muted">${h(socks?.tag || '-')}</div>` : '<span class="muted">未启用</span>'}</td>
    <td><span class="status ${customer.computedStatus}">${statusText[customer.computedStatus] || customer.computedStatus}</span></td>
    <td><div class="row-actions">
      <button class="btn small primary" data-action="renew" data-id="${customer.id}">续费</button>
      <button class="btn small" data-action="adjust-balance" data-id="${customer.id}">调余额</button>
      <button class="btn small" data-action="sync" data-id="${customer.id}">同步</button>
      <button class="btn small" data-action="edit-customer" data-id="${customer.id}">编辑</button>
      <button class="btn small" data-action="toggle" data-id="${customer.id}">${customer.status === 'disabled' ? '启用' : '停用'}</button>
      <button class="btn small danger" data-action="delete-customer" data-id="${customer.id}">删除</button>
    </div></td>
  </tr>`;
}

function balanceTypeText(type) {
  return {
    card_redeem: '卡密充值',
    user_renew: '用户续费',
    admin_add: '管理员增加',
    admin_subtract: '管理员扣减',
    admin_set: '管理员设置'
  }[type] || type || '-';
}

function renewalSourceText(source) {
  return { user: '用户自助', admin: '管理员' }[source] || source || '-';
}

function renderFinance() {
  const balanceLogs = state.db.balanceLogs || [];
  const renewalLogs = state.db.renewalLogs || [];
  return `
    <section class="panel">
      <div class="panel-head"><div><h2>余额流水</h2><p>记录卡密充值、用户续费扣款和管理员手动调整余额。</p></div></div>
      <table><thead><tr><th style="width:160px">时间</th><th style="width:150px">用户</th><th style="width:110px">类型</th><th style="width:110px">变动</th><th style="width:190px">余额变化</th><th style="width:120px">操作人</th><th>备注</th></tr></thead>
      <tbody>${balanceLogs.length ? balanceLogs.map((log) => `<tr><td>${fmtDate(log.createdAt)}</td><td>${h(log.customerName || log.customerId || '-')}</td><td>${h(balanceTypeText(log.type))}</td><td class="mono ${Number(log.amount || 0) < 0 ? 'danger-text' : 'success-text'}">${Number(log.amount || 0) > 0 ? '+' : ''}${money(log.amount)}</td><td class="mono">${money(log.beforeBalance)} → ${money(log.afterBalance)}</td><td>${h(log.operator || '-')}</td><td>${h(log.remark || '-')}</td></tr>`).join('') : `<tr><td colspan="7" class="empty">还没有余额流水。</td></tr>`}</tbody></table>
    </section>
    <section class="panel">
      <div class="panel-head"><div><h2>续费记录</h2><p>记录用户自助续费和管理员后台续费，便于对账。</p></div></div>
      <table><thead><tr><th style="width:160px">时间</th><th style="width:150px">用户</th><th style="width:90px">来源</th><th style="width:80px">月数</th><th style="width:110px">金额</th><th style="width:250px">到期变化</th><th style="width:90px">状态</th><th>说明</th></tr></thead>
      <tbody>${renewalLogs.length ? renewalLogs.map((log) => `<tr><td>${fmtDate(log.createdAt)}</td><td>${h(log.customerName || log.customerId || '-')}</td><td>${h(renewalSourceText(log.source))}</td><td>${h(log.months || 1)}</td><td>${money(log.price)} ${h(state.db.settings.currency)}</td><td>${fmtDate(log.beforeExpireAt)} → ${fmtDate(log.afterExpireAt)}</td><td><span class="status ${log.status === 'warning' ? 'warning' : log.status === 'success' ? 'success' : 'active'}">${statusText[log.status] || log.status || '-'}</span></td><td>${h(log.message || '-')}</td></tr>`).join('') : `<tr><td colspan="8" class="empty">还没有续费记录。</td></tr>`}</tbody></table>
    </section>`;
}

function cardType(card) {
  const fallback = `${money(card.amount)} ${state.db.settings.currency || 'CNY'}`;
  return String(card.batchName || card.type || card.remark || fallback).trim() || fallback;
}

function cardGroups() {
  const groups = new Map();
  for (const card of state.db.cards || []) {
    const type = cardType(card);
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(card);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, 'zh-CN'));
}

function renderCardGroups() {
  const entries = cardGroups();
  if (!entries.length) return '';
  return `<section class="card-groups">${entries.map(([type, cards], index) => {
    const unused = cards.filter((card) => card.status === 'unused');
    const usedCount = cards.filter((card) => card.status === 'used').length;
    const disabledCount = cards.filter((card) => card.status === 'disabled').length;
    const codes = unused.map((card) => card.code).join('\n');
    return `<div class="card-group">
      <div class="card-group-head"><div><h2>${h(type)}</h2><p>未使用 ${unused.length} 张，已使用 ${usedCount} 张，已禁用 ${disabledCount} 张</p></div><div class="card-group-actions"><button class="btn small" data-action="copy-card-group" data-index="${index}">一键复制</button><button class="btn small" data-action="generate-card-group" data-index="${index}">继续生成</button><button class="btn small" data-action="rename-card-group" data-index="${index}">改名称</button><button class="btn small danger" data-action="delete-card-group" data-index="${index}">删除未使用</button></div></div>
      <textarea class="copy-area mono" data-card-group="${index}" readonly>${h(codes)}</textarea>
    </div>`;
  }).join('')}</section>`;
}

function getCardGroup(index) {
  const entry = cardGroups()[Number(index)];
  if (!entry) return null;
  const [type, cards] = entry;
  const batchId = cards[0]?.batchId && cards.every((card) => card.batchId === cards[0].batchId) ? cards[0].batchId : '';
  return { type, cards, batchId };
}

function renderCards() {
  const unused = state.db.cards.filter((card) => card.status === 'unused').length;
  const used = state.db.cards.filter((card) => card.status === 'used').length;
  return `
    <div class="toolbar">
      <div class="toolbar-left"><span class="muted">未使用 ${unused} 张，已使用 ${used} 张</span></div>
      <div class="toolbar-right"><button class="btn" data-action="card-link-settings">购买链接</button><button class="btn primary" data-action="generate-cards">+ 生成卡密</button></div>
    </div>
    ${renderCardGroups()}
    <section class="panel">
      <div class="panel-head"><div><h2>卡密管理</h2><p>用户只能通过兑换卡密充值余额。购买卡密按钮会跳转到这里设置的外部发卡网站。</p></div></div>
      <table><thead><tr><th style="width:230px">卡密</th><th style="width:100px">金额</th><th style="width:120px">分类</th><th style="width:90px">状态</th><th style="width:150px">使用用户</th><th style="width:170px">使用时间</th><th>备注</th><th style="width:180px">操作</th></tr></thead>
      <tbody>${state.db.cards.length ? state.db.cards.map(cardRow).join('') : `<tr><td colspan="8" class="empty">还没有卡密，点击右上角生成。</td></tr>`}</tbody></table>
    </section>`;
}

function cardRow(card) {
  return `<tr>
    <td class="mono">${h(card.code)}</td>
    <td>${money(card.amount)} ${h(state.db.settings.currency)}</td>
    <td>${h(cardType(card))}</td>
    <td><span class="status ${card.status === 'used' ? 'success' : card.status === 'disabled' ? 'disabled' : 'active'}">${statusText[card.status] || card.status}</span></td>
    <td>${h(card.usedByName || '-')}</td>
    <td>${fmtDate(card.usedAt)}</td>
    <td>${h(card.remark || '-')}</td>
    <td><div class="row-actions">
      ${card.status !== 'used' ? `<button class="btn small" data-action="toggle-card" data-id="${card.id}">${card.status === 'disabled' ? '启用' : '禁用'}</button><button class="btn small danger" data-action="delete-card" data-id="${card.id}">删除</button>` : '<span class="muted">已使用</span>'}
    </div></td>
  </tr>`;
}

function renderServers() {
  return `
    <div class="toolbar"><div class="toolbar-left"></div><div class="toolbar-right"><button class="btn primary" data-action="new-server">+ 添加 3x-ui 节点</button></div></div>
    <section class="panel">
      <div class="panel-head"><div><h2>3x-ui 节点</h2><p>保存中心面板或远程节点连接信息，用于用户同步。</p></div></div>
      <table><thead><tr><th style="width:190px">名称</th><th>地址</th><th style="width:110px">基础路径</th><th style="width:160px">账号 / API</th><th style="width:90px">状态</th><th style="width:320px">操作</th></tr></thead>
      <tbody>${state.db.xuiServers.length ? state.db.xuiServers.map(serverRow).join('') : `<tr><td colspan="6" class="empty">还没有 3x-ui 节点。</td></tr>`}</tbody></table>
    </section>`;
}

function serverRow(server) {
  return `<tr>
    <td class="main-cell"><strong>${h(server.name)}</strong><div class="muted">${h(server.remark || '无备注')}</div></td>
    <td class="mono">${h(server.protocol)}://${h(server.host)}:${h(server.port)}</td>
    <td class="mono">${h(server.basePath)}</td>
    <td>${h(server.username || '-')}<div class="muted">${server.apiToken ? 'Token 已保存' : '无 Token'}</div></td>
    <td><span class="status ${server.status === 'enabled' ? 'active' : 'disabled'}">${server.status === 'enabled' ? '启用' : '停用'}</span></td>
    <td><div class="row-actions"><button class="btn small" data-action="test-server" data-id="${server.id}">测试</button><button class="btn small primary" data-action="import-server-customers" data-id="${server.id}">同步用户</button><button class="btn small" data-action="edit-server" data-id="${server.id}">编辑</button><button class="btn small danger" data-action="delete-server" data-id="${server.id}">删除</button></div></td>
  </tr>`;
}

function renderSocks() {
  return `
    <div class="toolbar"><div class="toolbar-left"></div><div class="toolbar-right"><button class="btn primary" data-action="new-socks">+ 添加 SOCKS 出站</button></div></div>
    <section class="panel">
      <div class="panel-head"><div><h2>SOCKS 出站</h2><p>维护可复用的 SOCKS 中转，用户资料里可以绑定。</p></div></div>
      <table><thead><tr><th style="width:190px">名称</th><th>地址</th><th style="width:130px">认证</th><th style="width:150px">Tag</th><th style="width:100px">绑定用户</th><th style="width:90px">状态</th><th style="width:210px">操作</th></tr></thead>
      <tbody>${state.db.socksNodes.length ? state.db.socksNodes.map(socksRow).join('') : `<tr><td colspan="7" class="empty">还没有 SOCKS 出站。</td></tr>`}</tbody></table>
    </section>`;
}

function socksRow(socks) {
  const count = state.db.customers.filter((customer) => customer.socksNodeId === socks.id).length;
  return `<tr>
    <td class="main-cell"><strong>${h(socks.name)}</strong><div class="muted">${h(socks.remark || '无备注')}</div></td>
    <td class="mono">${h(socks.address)}:${h(socks.port)}</td>
    <td>${h(socks.username || '-')}</td>
    <td class="mono">${h(socks.tag)}</td>
    <td>${count}</td>
    <td><span class="status ${socks.status === 'enabled' ? 'active' : 'disabled'}">${socks.status === 'enabled' ? '启用' : '停用'}</span></td>
    <td><div class="row-actions"><button class="btn small" data-action="edit-socks" data-id="${socks.id}">编辑</button><button class="btn small danger" data-action="delete-socks" data-id="${socks.id}">删除</button></div></td>
  </tr>`;
}

function renderLogs() {
  return `<section class="panel">
    <div class="panel-head"><div><h2>同步日志</h2><p>记录用户创建、续费、购买、停用和同步到 3x-ui 的结果。</p></div></div>
    <table><thead><tr><th style="width:178px">时间</th><th style="width:140px">用户</th><th style="width:110px">类型</th><th style="width:90px">状态</th><th>消息</th></tr></thead>
    <tbody>${state.db.syncLogs.length ? state.db.syncLogs.map(logRow).join('') : `<tr><td colspan="5" class="empty">暂无日志。</td></tr>`}</tbody></table>
  </section>`;
}

function logRow(log) {
  const customer = state.db.customers.find((item) => item.id === log.customerId);
  return `<tr>
    <td>${fmtDate(log.createdAt)}</td>
    <td>${h(customer?.name || log.customerId)}</td>
    <td>${h(log.type)}</td>
    <td><span class="status ${log.status}">${statusText[log.status] || log.status}</span></td>
    <td>${h(log.message)}<div class="log-detail">${h(JSON.stringify(log.detail || {}))}</div></td>
  </tr>`;
}

function renderUserApp() {
  const customer = state.db.customer;
  app.innerHTML = `
    <section class="app-shell">
      <aside class="sidebar">
        <div class="brand"><span class="brand-mark">十夜</span><span>用户中心</span></div>
        <nav class="nav">${userNavItems.map(([view, label, icon]) => navButton(view, label, icon, state.userView)).join('')}</nav>
        <div class="sidebar-footer">登录用户：${h(state.user)}<br>节点价格：${money(customer.amount)} ${h(state.db.settings.currency)}/月<br>余额：${money(customer.balance)} ${h(state.db.settings.currency)}</div>
      </aside>
      <section class="content">
        <div class="topbar">
          <div><div class="eyebrow">USER PORTAL</div><h1>${userPageTitle()}</h1><div class="sub">购买卡密、兑换余额、续费当前节点和查看节点状态。</div></div>
          <div class="actions"><button class="btn primary" data-action="buy-card-link">购买卡密</button><button class="btn" data-action="refresh">刷新</button><button class="btn danger" data-action="logout">退出</button></div>
        </div>
        ${renderUserSummary()}
        ${renderUserView()}
      </section>
    </section>
    ${state.modal ? renderModal() : ''}
    ${state.toast ? `<div class="toast">${h(state.toast)}</div>` : ''}`;
  bindEvents();
}

function userPageTitle() {
  return { 'user-home': '充值续费', 'user-nodes': '节点管理' }[state.userView] || '用户中心';
}

function renderUserSummary() {
  const customer = state.db.customer;
  return `<div class="stats user-stats">
    <div class="stat total"><span>账户余额</span><strong>${money(customer.balance)}</strong><small>${h(state.db.settings.currency)}</small></div>
    <div class="stat"><span>节点价格</span><strong>${money(customer.amount)}</strong><small>${h(state.db.settings.currency)} / 月</small></div>
    <div class="stat"><span>到期时间</span><strong class="small-strong">${fmtDate(customer.expireAt)}</strong><small>续费后自动顺延</small></div>
    <div class="stat"><span>可用流量</span><strong>${h(customer.trafficLimitGb || 0)} GB</strong><small>节点流量</small></div>
    <div class="stat"><span>状态</span><strong>${statusText[customer.computedStatus] || customer.computedStatus}</strong><small>账户状态</small></div>
  </div>`;
}

function renderUserView() {
  if (state.userView === 'user-nodes') return renderUserNodes();
  return renderUserHome();
}

function renderUserHome() {
  const customer = state.db.customer;
  const canRenew = state.db.node && Number(customer.amount || 0) > 0;
  return `<section class="panel compact-panel">
    <div class="panel-head"><div><h2>余额充值</h2><p>点击购买卡密会跳转到管理员设置的发卡网站，兑换后余额自动增加。</p></div></div>
    <div class="panel-body">
      <div class="grid-2">
        <button class="btn primary large-btn" data-action="buy-card-link">购买卡密</button>
        <form id="redeemForm" class="redeem-form">
          <div class="field"><label>兑换卡密</label><input name="code" placeholder="输入卡密" required></div>
          <button class="btn primary" type="submit">兑换充值</button>
        </form>
      </div>
    </div>
  </section>
  <section class="panel compact-panel renew-panel">
    <div class="panel-head"><div><h2>续费当前节点</h2><p>续费会使用余额扣款，并自动顺延当前节点到期时间。</p></div></div>
    <div class="panel-body">
      <div class="renew-summary">
        <div><span>节点价格</span><strong>${money(customer.amount)} ${h(state.db.settings.currency)} / 月</strong></div>
        <div><span>账户余额</span><strong>${money(customer.balance)} ${h(state.db.settings.currency)}</strong></div>
        <div><span>到期时间</span><strong>${fmtDate(customer.expireAt)}</strong></div>
      </div>
      <form id="userRenewForm" class="redeem-form">
        <div class="field"><label>续费月数</label><input name="months" type="number" min="1" value="1" ${canRenew ? '' : 'disabled'}></div>
        <button class="btn primary" type="submit" ${canRenew ? '' : 'disabled'}>余额续费</button>
      </form>
      ${canRenew ? '' : '<div class="form-note">当前账号还没有可续费节点，或管理员还没有设置节点价格。</div>'}
    </div>
  </section>
  ${renderUserFinanceLogs()}`;
}

function renderUserFinanceLogs() {
  const balanceLogs = state.db.balanceLogs || [];
  const renewalLogs = state.db.renewalLogs || [];
  return `<section class="panel compact-panel">
    <div class="panel-head"><div><h2>账户记录</h2><p>这里只显示当前账号自己的充值和续费记录。</p></div></div>
    <div class="grid-2 finance-mini-grid">
      <div><h3>余额流水</h3><table><thead><tr><th>时间</th><th>类型</th><th>变动</th><th>余额</th></tr></thead><tbody>${balanceLogs.length ? balanceLogs.map((log) => `<tr><td>${fmtDate(log.createdAt)}</td><td>${h(balanceTypeText(log.type))}</td><td class="mono ${Number(log.amount || 0) < 0 ? 'danger-text' : 'success-text'}">${Number(log.amount || 0) > 0 ? '+' : ''}${money(log.amount)}</td><td>${money(log.afterBalance)}</td></tr>`).join('') : `<tr><td colspan="4" class="empty">暂无余额流水。</td></tr>`}</tbody></table></div>
      <div><h3>续费记录</h3><table><thead><tr><th>时间</th><th>月数</th><th>金额</th><th>到期</th></tr></thead><tbody>${renewalLogs.length ? renewalLogs.map((log) => `<tr><td>${fmtDate(log.createdAt)}</td><td>${h(log.months || 1)}</td><td>${money(log.price)} ${h(state.db.settings.currency)}</td><td>${fmtDate(log.afterExpireAt)}</td></tr>`).join('') : `<tr><td colspan="4" class="empty">暂无续费记录。</td></tr>`}</tbody></table></div>
    </div>
  </section>`;
}

function renderUserNodes() {
  const node = state.db.node;
  if (!node) return `<section class="panel"><div class="panel-head"><div><h2>节点管理</h2><p>管理员尚未给当前账号绑定 3x-ui 节点。</p></div></div><div class="empty">请联系管理员配置节点。</div></section>`;
  return `<section class="panel">
    <div class="panel-head"><div><h2>节点管理</h2><p>这里只展示当前账号已绑定的节点信息，节点新增和路由配置由管理员维护。</p></div></div>
    <table><thead><tr><th>3x-ui 节点</th><th>续费价格</th><th>到期时间</th><th>Inbound</th><th>Client Email</th><th>UUID</th><th>协议</th><th>SOCKS</th><th>状态</th></tr></thead>
    <tbody><tr><td>${h(node.xuiServerName || '-')}</td><td>${money(node.renewPrice)} ${h(state.db.settings.currency)} / 月</td><td>${fmtDate(node.expireAt)}</td><td>${h(node.inboundId || '-')}<div class="muted">${h(node.inboundRemark || '')}</div></td><td class="mono">${h(node.clientEmail || '-')}</td><td class="mono">${h(node.clientUuid || '-')}</td><td>${h(node.protocol || '-')}</td><td>${node.useSocks ? h(node.socksName || '已启用') : '未启用'}</td><td><span class="status ${node.status}">${statusText[node.status] || node.status}</span></td></tr></tbody></table>
  </section>`;
}

function renderDrawer() {
  const { type, item } = state.drawer;
  const currentItem = item || {};
  const title = {
    customer: item ? '编辑用户' : '新建用户',
    server: item ? '编辑 3x-ui 节点' : '添加 3x-ui 节点',
    socks: item ? '编辑 SOCKS 出站' : '添加 SOCKS 出站',
    cards: '生成卡密',
    cardLink: '购买链接',
    settings: '系统设置',
    renew: '用户续费',
    balance: '调整余额',
    security: '账号安全'
  }[type];
  return `<div class="drawer-backdrop" data-drawer-backdrop>
    <form class="drawer" id="drawerForm" data-drawer-type="${type}" data-id="${currentItem.id || ''}">
      <header><h2>${title}</h2><button class="btn icon" type="button" data-action="close-drawer">×</button></header>
      <div class="drawer-body">${drawerFields(type, currentItem)}</div>
      <footer><button class="btn" type="button" data-action="close-drawer">取消</button><button class="btn primary" type="submit">保存</button></footer>
    </form>
  </div>`;
}

function renderModal() {
  const modal = state.modal || {};
  const hasInput = Boolean(modal.input);
  const confirmClass = modal.tone === 'danger' ? 'btn danger solid' : 'btn primary';
  return `<div class="modal-backdrop" data-modal-backdrop>
    <form class="modal-card" id="modalForm">
      <div class="modal-icon ${h(modal.tone || 'default')}">${modal.tone === 'danger' ? '!' : '?'}</div>
      <div class="modal-content">
        <h2>${h(modal.title)}</h2>
        ${modal.message ? `<p>${h(modal.message)}</p>` : ''}
        ${hasInput ? `<div class="field modal-field"><label>名称</label><input data-modal-input value="${h(modal.input.value || '')}" required></div>` : ''}
      </div>
      <footer><button class="btn" type="button" data-action="cancel-modal">${h(modal.cancelText || '取消')}</button><button class="${confirmClass}" type="submit">${h(modal.confirmText || '确定')}</button></footer>
    </form>
  </div>`;
}

function renderSection(title, body) {
  return `<div class="form-section"><div class="section-title">${title}</div>${body}</div>`;
}

function drawerFields(type, item = {}) {
  if (type === 'settings') {
    return `${renderSection('系统入口', `
      <div class="field"><label>管理员入口路径</label><input name="adminPath" value="${h(state.db.settings.adminPath || '/admin')}" placeholder="/admin"></div>
      <div class="form-note">保存后新的管理员入口立即生效，例如 /admin 或 /myadmin2026。当前页面刷新后请使用新路径进入后台。</div>
    `)}${renderSection('基础设置', `
      <div class="grid-2"><div class="field"><label>货币单位</label><input name="currency" value="${h(state.db.settings.currency || 'CNY')}"></div><div class="field"><label>到期提醒天数</label><input name="expiryWarningDays" type="number" min="1" value="${h(state.db.settings.expiryWarningDays || 3)}"></div></div>
    `)}`;
  }
  if (type === 'cardLink') {
    return `${renderSection('用户端购买链接', `
      <div class="field"><label>购买卡密链接</label><input name="purchaseCardUrl" value="${h(state.db.settings.purchaseCardUrl)}" placeholder="https://你的发卡网站.example.com"></div>
      <div class="form-note">用户点击“购买卡密”按钮时，会直接跳转到这个链接。</div>
    `)}`;
  }
  if (type === 'cards') {
    return `${renderSection('生成卡密', `
      <input type="hidden" name="batchId" value="${h(item.batchId || '')}">
      <div class="grid-3"><div class="field"><label>金额</label><input name="amount" type="number" min="0.01" step="0.01" value="${h(item.amount || 10)}" required></div><div class="field"><label>数量</label><input name="count" type="number" min="1" max="500" value="1" required></div><div class="field"><label>前缀</label><input name="prefix" placeholder="可选"></div></div>
      <div class="field"><label>分类</label><input name="type" value="${h(item.type || '')}" placeholder="例如：50元卡密 / 月卡 / 活动卡"></div>
      <div class="field"><label>备注</label><input name="remark" value="${h(item.remark || '')}" placeholder="例如：7 月活动"></div>
    `)}`;
  }
  if (type === 'server') {
    return `
      <div class="form-note">节点信息对应 3x-ui 的面板访问地址。密码或 Token 保持星号会保留旧值，清空后保存会删除旧值。</div>
      ${renderSection('基础信息', `
        <div class="grid-2"><div class="field"><label>名称</label><input name="name" value="${h(item.name)}" required></div><div class="field"><label>备注</label><input name="remark" value="${h(item.remark)}"></div></div>
        <div class="grid-3"><div class="field"><label>协议</label><select name="protocol"><option ${item.protocol === 'https' ? 'selected' : ''}>https</option><option ${item.protocol === 'http' ? 'selected' : ''}>http</option></select></div><div class="field"><label>地址</label><input name="host" value="${h(item.host)}" placeholder="panel.example.com" required></div><div class="field"><label>端口</label><input name="port" type="number" value="${h(item.port || 2053)}"></div></div>
        <div class="grid-2"><div class="field"><label>基础路径</label><input name="basePath" value="${h(item.basePath || '/')}"></div><div class="field"><label>状态</label><select name="status"><option value="enabled" ${item.status !== 'disabled' ? 'selected' : ''}>启用</option><option value="disabled" ${item.status === 'disabled' ? 'selected' : ''}>停用</option></select></div></div>
      `)}
      ${renderSection('认证信息', `
        <div class="grid-2"><div class="field"><label>账号</label><input name="username" value="${h(item.username)}"></div><div class="field"><label>密码</label><input name="password" type="password" value="${h(item.password)}"></div></div>
        <div class="field"><label>API Token</label><input name="apiToken" type="password" value="${h(item.apiToken)}"></div>
        <div class="grid-2"><div class="field"><label>默认 TLS 证书路径</label><input name="defaultInboundCertFile" value="${h(item.defaultInboundCertFile)}" placeholder="/root/cert/fullchain.pem"></div><div class="field"><label>默认 TLS 私钥路径</label><input name="defaultInboundKeyFile" value="${h(item.defaultInboundKeyFile)}" placeholder="/root/cert/privkey.pem"></div></div>
        <div class="form-note">没有现有入站、自动创建 VLESS TLS 入站时，会优先使用这里填写的默认证书路径。</div>
      `)}`;
  }
  if (type === 'socks') {
    return `${renderSection('出站信息', `
      <div class="grid-2"><div class="field"><label>名称</label><input name="name" value="${h(item.name)}" required></div><div class="field"><label>Tag</label><input name="tag" value="${h(item.tag)}" placeholder="socks_hk_01"></div></div>
      <div class="grid-2"><div class="field"><label>地址</label><input name="address" value="${h(item.address)}" required></div><div class="field"><label>端口</label><input name="port" type="number" value="${h(item.port || 1080)}"></div></div>
      <div class="grid-2"><div class="field"><label>用户名</label><input name="username" value="${h(item.username)}"></div><div class="field"><label>密码</label><input name="password" type="password" value="${h(item.password)}"></div></div>
      <div class="grid-2"><div class="field"><label>状态</label><select name="status"><option value="enabled" ${item.status !== 'disabled' ? 'selected' : ''}>启用</option><option value="disabled" ${item.status === 'disabled' ? 'selected' : ''}>停用</option></select></div><div class="field"><label>备注</label><input name="remark" value="${h(item.remark)}"></div></div>
    `)}`;
  }
  if (type === 'renew') {
    return `<div class="form-note">用户：${h(item.name)}，当前到期：${fmtDate(item.expireAt)}</div>${renderSection('续费信息', `
      <div class="grid-2"><div class="field"><label>续费月数</label><input name="months" type="number" min="1" value="1"></div><div class="field"><label>收款金额</label><input name="amount" type="number" min="0" step="0.01" value="${h(item.amount || 0)}"></div></div>
    `)}`;
  }
  if (type === 'balance') {
    return `<div class="form-note">用户：${h(item.name)}，当前余额：${money(item.balance)} ${h(state.db.settings.currency)}</div>${renderSection('余额调整', `
      <div class="grid-2"><div class="field"><label>调整方式</label><select name="mode"><option value="add">增加余额</option><option value="subtract">扣减余额</option><option value="set">设置为固定余额</option></select></div><div class="field"><label>金额</label><input name="amount" type="number" min="0" step="0.01" value="0" required></div></div>
      <div class="field"><label>备注</label><input name="remark" placeholder="例如：线下补款 / 退款 / 纠错"></div>
    `)}`;
  }
  if (type === 'security') {
    return `<div class="form-note">修改管理员账号或密码后，当前会话会自动退出。</div>${renderSection('管理员账号', `
      <div class="field"><label>管理员账号</label><input name="username" value="${h(state.db.settings?.adminUsername || state.user || 'admin')}" autocomplete="username" required></div>
    `)}${renderSection('修改密码', `
      <div class="field"><label>当前密码</label><input name="currentPassword" type="password" autocomplete="current-password" required></div>
      <div class="field"><label>新密码</label><input name="newPassword" type="password" minlength="8" autocomplete="new-password" required></div>
      <div class="field"><label>确认新密码</label><input name="confirmPassword" type="password" minlength="8" autocomplete="new-password" required></div>
    `)}`;
  }
  return `
    ${renderSection('用户登录', `
      <div class="grid-3"><div class="field"><label>用户名称</label><input name="name" value="${h(item.name)}" required></div><div class="field"><label>登录账号</label><input name="loginUsername" value="${h(item.loginUsername)}" autocomplete="off" placeholder="留空则不能登录用户端"></div><div class="field"><label>登录密码</label><input name="loginPassword" type="password" autocomplete="new-password" placeholder="编辑时留空表示不修改"></div></div>
      <div class="grid-2"><div class="field"><label>联系方式</label><input name="contact" value="${h(item.contact)}"></div><div class="field"><label>余额</label><input name="balance" type="number" min="0" step="0.01" value="${h(item.balance || 0)}"></div></div>
    `)}
    ${renderSection('节点计费', `
      <div class="grid-3"><div class="field"><label>节点名称</label><input name="packageName" value="${h(item.packageName || '当前节点')}"></div><div class="field"><label>每月续费价格</label><input name="amount" type="number" min="0" step="0.01" value="${h(item.amount || 0)}"></div><div class="field"><label>流量 GB</label><input name="trafficLimitGb" type="number" value="${h(item.trafficLimitGb || 100)}"></div></div>
      <div class="grid-2"><div class="field"><label>到期时间</label><input name="expireAt" type="datetime-local" value="${h(dateInputValue(item.expireAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()))}"></div><div class="field"><label>状态</label><select name="status"><option value="active" ${item.status !== 'disabled' ? 'selected' : ''}>正常</option><option value="disabled" ${item.status === 'disabled' ? 'selected' : ''}>停用</option></select></div></div>
    `)}
    ${renderSection('3x-ui 绑定', `
      <div class="grid-2"><div class="field"><label>3x-ui 节点</label><select name="xuiServerId"><option value="">未绑定</option>${state.db.xuiServers.map((server) => `<option value="${server.id}" ${item.xuiServerId === server.id ? 'selected' : ''}>${h(server.name)}</option>`).join('')}</select></div><div class="field"><label>Inbound ID</label><input name="inboundId" type="number" min="1" step="1" value="${h(item.inboundId)}" placeholder="3x-ui 入站数字 ID，例如 1"></div></div>
      <div class="grid-3"><div class="field"><label>自动创建入站</label><div class="check-row"><input name="autoCreateInbound" type="checkbox" ${item.autoCreateInbound ? 'checked' : ''}> Inbound ID 为空时自动创建</div></div><div class="field"><label>新入站端口</label><input name="inboundPort" type="number" min="1" max="65535" step="1" value="${h(item.inboundPort)}" placeholder="留空自动选择"></div><div class="field"><label>新入站备注</label><input name="inboundRemark" value="${h(item.inboundRemark)}" placeholder="默认使用用户名称"></div></div>
      <div class="grid-3"><div class="field"><label>入站模板</label><select name="inboundTemplate"><option value="vless-tcp" ${(item.inboundTemplate || 'vless-tcp') === 'vless-tcp' ? 'selected' : ''}>VLESS TCP</option><option value="vless-reality" ${item.inboundTemplate === 'vless-reality' ? 'selected' : ''}>VLESS Reality</option><option value="vless-tls" ${item.inboundTemplate === 'vless-tls' ? 'selected' : ''}>VLESS TLS</option><option value="vless-ws" ${item.inboundTemplate === 'vless-ws' ? 'selected' : ''}>VLESS WebSocket</option><option value="vless-grpc" ${item.inboundTemplate === 'vless-grpc' ? 'selected' : ''}>VLESS gRPC</option></select></div><div class="field"><label>SNI / 域名</label><input name="inboundSni" value="${h(item.inboundSni)}" placeholder="Reality/TLS 使用"></div><div class="field"><label>目标站点 / Host</label><input name="inboundHost" value="${h(item.inboundHost)}" placeholder="Reality dest 或 WS Host"></div></div>
      <div class="grid-2"><div class="field"><label>WS 路径</label><input name="inboundPath" value="${h(item.inboundPath)}" placeholder="例如 /shiye"></div><div class="field"><label>gRPC ServiceName</label><input name="inboundGrpcServiceName" value="${h(item.inboundGrpcServiceName)}" placeholder="例如 shiye"></div></div>
      <div class="grid-2"><div class="field"><label>TLS 证书路径</label><input name="inboundCertFile" value="${h(item.inboundCertFile)}" placeholder="例如 /root/cert/fullchain.pem"></div><div class="field"><label>TLS 私钥路径</label><input name="inboundKeyFile" value="${h(item.inboundKeyFile)}" placeholder="例如 /root/cert/privkey.pem"></div></div>
      <div class="grid-3"><div class="field"><label>Client ID</label><input name="clientId" value="${h(item.clientId)}" placeholder="可留空，默认等于 Email"></div><div class="field"><label>Client Email</label><input name="clientEmail" value="${h(item.clientEmail)}" placeholder="可留空自动生成"></div><div class="field"><label>UUID</label><input name="clientUuid" value="${h(item.clientUuid)}" placeholder="可留空自动生成"></div></div>
    `)}
    ${renderSection('SOCKS 中转', `
      <div class="grid-2"><div class="field"><label>中转开关</label><div class="check-row"><input name="useSocks" type="checkbox" ${item.useSocks ? 'checked' : ''}> 启用 SOCKS 中转</div></div><div class="field"><label>SOCKS 节点</label><select name="socksNodeId"><option value="">未选择</option>${state.db.socksNodes.map((socks) => `<option value="${socks.id}" ${item.socksNodeId === socks.id ? 'selected' : ''}>${h(socks.name)}</option>`).join('')}</select></div></div>
    `)}
    <div class="field"><label>备注</label><textarea name="remark">${h(item.remark)}</textarea></div>`;
}

function bindEvents() {
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
    if (state.role === 'user') state.userView = button.dataset.view;
    else state.view = button.dataset.view;
    state.drawer = null;
    render();
  }));
  document.querySelector('[data-search]')?.addEventListener('input', (event) => {
    state.search = event.target.value;
    render();
  });
  document.querySelectorAll('[data-action]').forEach((el) => el.addEventListener('click', handleAction));
  document.querySelector('[data-drawer-backdrop]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      state.drawer = null;
      render();
    }
  });
  document.querySelector('[data-modal-backdrop]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeModal(null);
  });
  document.querySelector('#modalForm')?.addEventListener('click', (event) => event.stopPropagation());
  document.querySelector('#modalForm')?.addEventListener('submit', handleModalSubmit);
  const drawerForm = document.querySelector('#drawerForm');
  drawerForm?.addEventListener('click', (event) => event.stopPropagation());
  drawerForm?.addEventListener('submit', handleDrawerSubmit);
  document.querySelector('#redeemForm')?.addEventListener('submit', handleRedeemSubmit);
  document.querySelector('#userRenewForm')?.addEventListener('submit', handleUserRenewSubmit);
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (state.modal) return closeModal(null);
  if (state.drawer) {
    state.drawer = null;
    render();
  }
});

function handleModalSubmit(event) {
  event.preventDefault();
  const input = event.currentTarget.querySelector('[data-modal-input]');
  closeModal(input ? input.value : true);
}

async function handleAction(event) {
  const action = event.currentTarget.dataset.action;
  const id = event.currentTarget.dataset.id;
  try {
    if (action === 'refresh') return refresh();
    if (action === 'cancel-modal') return closeModal(null);
    if (action === 'logout') {
      await api('/api/logout', { method: 'POST', body: { entry: entryMode } });
      state.user = null;
      state.role = '';
      state.db = null;
      return renderLogin();
    }
    if (action === 'buy-card-link') {
      const url = state.db.settings?.purchaseCardUrl;
      if (!url) return toast('管理员还没有设置购买卡密链接');
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (action === 'copy-card-group') {
      const area = document.querySelector(`[data-card-group="${event.currentTarget.dataset.index}"]`);
      const text = area?.value || '';
      if (!text.trim()) return toast('这个分类没有可复制的未使用卡密');
      await copyText(text);
      return toast('已复制这一类未使用卡密');
    }
    if (action === 'generate-card-group') {
      const group = getCardGroup(event.currentTarget.dataset.index);
      if (!group) return toast('这个分类不存在，请刷新后再试');
      const sample = group.cards.find((card) => card.status === 'unused') || group.cards[0] || {};
      state.drawer = { type: 'cards', item: { batchId: group.batchId, type: group.type, amount: sample.amount || 10, remark: sample.remark || '' } };
      return render();
    }
    if (action === 'rename-card-group') {
      const group = getCardGroup(event.currentTarget.dataset.index);
      if (!group) return toast('这个分类不存在，请刷新后再试');
      const nextType = await promptDialog('修改卡密分类名称', '输入新的分类名称，保存后会同步到这个分类下的卡密。', group.type);
      if (nextType === null) return;
      if (!nextType.trim()) return toast('分类名称不能为空');
      const result = group.batchId
        ? await api(`/api/card-batches/${group.batchId}`, { method: 'PUT', body: { name: nextType.trim() } })
        : await api('/api/cards/bulk-update', { method: 'POST', body: { ids: group.cards.map((card) => card.id), type: nextType.trim() } });
      state.db = result.data;
      toast(group.batchId ? '卡密批次名称已修改' : `已修改 ${result.updated || 0} 张卡密的分类名称`);
      return render();
    }
    if (action === 'delete-card-group') {
      const group = getCardGroup(event.currentTarget.dataset.index);
      if (!group) return toast('这个分类不存在，请刷新后再试');
      const ids = group.cards.filter((card) => ['unused', 'disabled'].includes(card.status)).map((card) => card.id);
      if (!ids.length) return toast('这个分类没有可删除的未使用或已禁用卡密');
      if (!await confirmDialog('删除未使用卡密', `确定删除“${group.type}”分类下 ${ids.length} 张未使用或已禁用卡密？已使用卡密会保留。`, { tone: 'danger', confirmText: '删除' })) return;
      const result = group.batchId
        ? await api(`/api/card-batches/${group.batchId}`, { method: 'DELETE' })
        : await api('/api/cards/bulk-delete', { method: 'POST', body: { ids } });
      state.db = result.data;
      toast(`已删除 ${result.deleted || 0} 张卡密${result.keptUsed ? `，保留已使用 ${result.keptUsed} 张` : ''}`);
      return render();
    }
    if (action === 'close-drawer') {
      state.drawer = null;
      return render();
    }
    if (action === 'security') state.drawer = { type: 'security', item: null };
    if (action === 'settings') state.drawer = { type: 'settings', item: null };
    if (action === 'card-link-settings') state.drawer = { type: 'cardLink', item: null };
    if (action === 'new-customer') state.drawer = { type: 'customer', item: null };
    if (action === 'edit-customer') state.drawer = { type: 'customer', item: state.db.customers.find((customer) => customer.id === id) };
    if (action === 'generate-cards') state.drawer = { type: 'cards', item: null };
    if (action === 'new-server') state.drawer = { type: 'server', item: null };
    if (action === 'edit-server') state.drawer = { type: 'server', item: state.db.xuiServers.find((server) => server.id === id) };
    if (action === 'new-socks') state.drawer = { type: 'socks', item: null };
    if (action === 'edit-socks') state.drawer = { type: 'socks', item: state.db.socksNodes.find((socks) => socks.id === id) };
    if (action === 'renew') state.drawer = { type: 'renew', item: state.db.customers.find((customer) => customer.id === id) };
    if (action === 'adjust-balance') state.drawer = { type: 'balance', item: state.db.customers.find((customer) => customer.id === id) };
    if (state.drawer) return render();

    if (action === 'sync') {
      const result = await api(`/api/customers/${id}/sync`, { method: 'POST' });
      state.db = result.data;
      const createdInbound = result.detail?.clientResult?.createdInbound;
      const suffix = createdInbound ? `，新入站端口 ${createdInbound.port}` : '';
      const socksSuffix = result.detail?.socksResult?.applied ? `，SOCKS ${result.detail.socksResult.outboundTag}` : '';
      toast(`同步完成${suffix}${socksSuffix}`);
      return render();
    }
    if (action === 'toggle') {
      const result = await api(`/api/customers/${id}/toggle`, { method: 'POST' });
      state.db = result.data;
      if (result.warning) toast(result.warning);
      return render();
    }
    if (action === 'delete-customer') {
      if (!await confirmDialog('删除用户', '确定删除这个用户？会同步删除 3-xui 里的 client，并清理这个用户对应的 SOCKS 路由。', { tone: 'danger', confirmText: '删除用户' })) return;
      const result = await api(`/api/customers/${id}`, { method: 'DELETE' });
      state.db = result.data;
      toast(result.warning ? `用户已删除，远程警告：${result.warning}` : '用户已删除，并已同步清理远程资源');
      return render();
    }
    if (action === 'toggle-card') {
      const card = state.db.cards.find((item) => item.id === id);
      const result = await api(`/api/cards/${id}`, { method: 'PUT', body: { status: card.status === 'disabled' ? 'unused' : 'disabled' } });
      state.db = result.data;
      return render();
    }
    if (action === 'delete-card') {
      if (!await confirmDialog('删除卡密', '确定删除这张未使用卡密？', { tone: 'danger', confirmText: '删除' })) return;
      const result = await api(`/api/cards/${id}`, { method: 'DELETE' });
      state.db = result.data;
      return render();
    }
    if (action === 'delete-server') {
      if (!await confirmDialog('删除 3x-ui 节点', '确定删除这个 3x-ui 节点？', { tone: 'danger', confirmText: '删除' })) return;
      const result = await api(`/api/xui-servers/${id}`, { method: 'DELETE' });
      state.db = result.data;
      return render();
    }
    if (action === 'delete-socks') {
      if (!await confirmDialog('删除 SOCKS 出站', '确定删除这个 SOCKS 出站？', { tone: 'danger', confirmText: '删除' })) return;
      const result = await api(`/api/socks-nodes/${id}`, { method: 'DELETE' });
      state.db = result.data;
      return render();
    }
    if (action === 'disable-expired') {
      if (!await confirmDialog('停用过期用户', '系统会把已经过期的用户改为停用，并尝试同步到 3-xui 禁用对应客户端。确定继续吗？', { confirmText: '开始停用' })) return;
      const result = await api('/api/maintenance/disable-expired', { method: 'POST' });
      state.db = result.data;
      toast(result.warning || `已停用 ${result.count} 个过期用户`);
      return render();
    }
    if (action === 'test-server') {
      const server = state.db.xuiServers.find((item) => item.id === id);
      const result = await api('/api/test-xui', { method: 'POST', body: server });
      return toast(result.message || '3x-ui 节点连接成功');
    }
    if (action === 'import-server-customers') {
      if (!await confirmDialog('同步 3-xui 用户', '确定从这个 3-xui 节点同步用户到本地用户列表？相同 Client Email 会更新，不会重复新增。', { confirmText: '开始同步' })) return;
      const result = await api(`/api/xui-servers/${id}/import-customers`, { method: 'POST' });
      state.db = result.data;
      toast(`同步完成：用户新增 ${result.detail.created}，更新 ${result.detail.updated}，SOCKS 新增 ${result.detail.socksCreated}，更新 ${result.detail.socksUpdated}，绑定 ${result.detail.socksBound}`);
      return render();
    }
  } catch (error) {
    toast(error.message);
  }
}

async function handleRedeemSubmit(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const result = await api('/api/user/cards/redeem', { method: 'POST', body: Object.fromEntries(form) });
    state.db = result.data;
    toast(result.message || '充值成功');
    render();
  } catch (error) {
    toast(error.message);
  }
}

async function handleUserRenewSubmit(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const months = Math.max(1, Number(form.get('months') || 1));
  const price = Number(state.db.customer?.amount || 0) * months;
  if (!await confirmDialog('确认续费', `续费 ${months} 个月将扣除 ${money(price)} ${state.db.settings.currency}。`, { confirmText: '确认续费' })) return;
  try {
    const result = await api('/api/user/renew', { method: 'POST', body: { months } });
    state.db = result.data;
    toast(result.warning || '续费成功');
    render();
  } catch (error) {
    toast(error.message);
  }
}

async function handleDrawerSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const type = form.dataset.drawerType;
  const id = form.dataset.id;
  const body = Object.fromEntries(new FormData(form));
  if (body.expireAt) body.expireAt = toIsoLocal(body.expireAt);
  body.useSocks = Boolean(form.querySelector('[name="useSocks"]')?.checked);
  body.autoCreateInbound = Boolean(form.querySelector('[name="autoCreateInbound"]')?.checked);
  if (type === 'security' && body.newPassword !== body.confirmPassword) return toast('两次输入的新密码不一致');
  try {
    let result;
    if (type === 'customer') result = await api(id ? `/api/customers/${id}` : '/api/customers', { method: id ? 'PUT' : 'POST', body });
    if (type === 'cards') result = await api('/api/cards/generate', { method: 'POST', body });
    if (type === 'settings' || type === 'cardLink') result = await api('/api/settings', { method: 'PUT', body });
    if (type === 'server') result = await api(id ? `/api/xui-servers/${id}` : '/api/xui-servers', { method: id ? 'PUT' : 'POST', body });
    if (type === 'socks') result = await api(id ? `/api/socks-nodes/${id}` : '/api/socks-nodes', { method: id ? 'PUT' : 'POST', body });
    if (type === 'renew') result = await api(`/api/customers/${id}/renew`, { method: 'POST', body });
    if (type === 'balance') result = await api(`/api/customers/${id}/balance-adjust`, { method: 'POST', body });
    if (type === 'security') {
      await api('/api/change-password', { method: 'POST', body });
      state.db = null;
      state.drawer = null;
      renderLogin();
      return toast('密码已修改，请重新登录');
    }
    state.db = result.data;
    state.drawer = null;
    render();
    const message = type === 'cards'
      ? `已生成 ${result.generated?.length || 0} 张卡密`
      : type === 'settings'
        ? `系统设置已保存，管理员入口：${result.data?.settings?.adminPath || body.adminPath || '/admin'}`
        : type === 'cardLink'
          ? '购买链接已保存'
          : '保存成功';
    toast(result.warning || message);
  } catch (error) {
    toast(error.message);
  }
}

bootstrap();
