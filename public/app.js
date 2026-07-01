const app = document.querySelector('#app');

if (location.protocol === 'file:') {
  app.innerHTML = `
    <section class="login-wrap">
      <div class="login-card">
        <h1>需要通过服务访问</h1>
        <p>请不要直接打开 index.html 文件。请先在服务器运行 npm start，然后访问 http://服务器IP:3388。</p>
      </div>
    </section>`;
  throw new Error('This panel must be opened through the Node.js server.');
}

const state = {
  user: null,
  view: 'customers',
  db: null,
  drawer: null,
  search: '',
  toast: ''
};

const statusText = {
  active: '正常',
  warning: '将到期',
  expired: '已过期',
  disabled: '已停用',
  success: '成功',
  failed: '失败'
};

const navItems = [
  ['customers', '用户管理', 'U'],
  ['servers', '3x-ui 节点', 'N'],
  ['socks', 'SOCKS 出站', 'S'],
  ['logs', '同步日志', 'L']
];

function h(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
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
  }, 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.detail || data.message || '请求失败');
  return data;
}

async function bootstrap() {
  try {
    const result = await api('/api/bootstrap');
    state.user = result.user;
    state.db = result.data;
    render();
  } catch {
    renderLogin();
  }
}

async function refresh() {
  const result = await api('/api/bootstrap');
  state.db = result.data;
  render();
}

function renderLogin() {
  app.innerHTML = `
    <section class="login-wrap">
      <form class="login-card" id="loginForm">
        <h1>十夜管理系统</h1>
        <p>用于统一管理 3x-ui 用户、续费、到期、节点绑定和 SOCKS 中转。公网部署建议修改默认密码。</p>
        <div class="field"><label>账号</label><input name="username" autocomplete="username"></div>
        <div class="field"><label>密码</label><input name="password" type="password" autocomplete="current-password"></div>
        <button class="btn primary login-submit" type="submit">登录</button>
      </form>
    </section>`;

  document.querySelector('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api('/api/login', { method: 'POST', body: Object.fromEntries(form) });
      await bootstrap();
    } catch (error) {
      toast(error.message);
    }
  });
}

function stats() {
  const customers = state.db.customers;
  return {
    total: customers.length,
    active: customers.filter((c) => c.computedStatus === 'active').length,
    warning: customers.filter((c) => c.computedStatus === 'warning').length,
    expired: customers.filter((c) => c.computedStatus === 'expired').length,
    disabled: customers.filter((c) => c.computedStatus === 'disabled').length
  };
}

function render() {
  if (!state.db) return renderLogin();
  const s = stats();
  app.innerHTML = `
    <section class="app-shell">
      <aside class="sidebar">
        <div class="brand"><span class="brand-mark">十夜</span><span>管理系统</span></div>
        <nav class="nav">
          ${navItems.map(([view, label, icon]) => navButton(view, label, icon)).join('')}
        </nav>
        <div class="sidebar-footer">登录用户：${h(state.user)}<br>版本：0.2.0<br>数据存储：data/db.json</div>
      </aside>
      <section class="content">
        <div class="topbar">
          <div>
            <div class="eyebrow">3X-UI CUSTOMER OPS</div>
            <h1>${pageTitle()}</h1>
            <div class="sub">统一处理用户续费、到期停用、节点绑定、SOCKS 中转和同步日志。</div>
          </div>
          <div class="actions">
            <button class="btn" data-action="disable-expired">到期停用</button>
            <button class="btn" data-action="refresh">刷新</button>
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
        ${state.db.settings?.defaultPasswordWarning ? `<div class="security-warning"><strong>当前仍在使用默认管理员密码。</strong><span>建议到账号安全里修改，公网部署时尤其重要。</span><button class="btn small" data-action="security">账号安全</button></div>` : ''}
        ${renderView()}
      </section>
    </section>
    ${state.drawer ? renderDrawer() : ''}
    ${state.toast ? `<div class="toast">${h(state.toast)}</div>` : ''}`;
  bindEvents();
}

function navButton(view, label, icon) {
  return `<button class="${state.view === view ? 'active' : ''}" data-view="${view}" data-icon="${icon}">${label}</button>`;
}

function pageTitle() {
  return { customers: '用户管理', servers: '3x-ui 节点', socks: 'SOCKS 出站', logs: '同步日志' }[state.view];
}

function renderView() {
  if (state.view === 'servers') return renderServers();
  if (state.view === 'socks') return renderSocks();
  if (state.view === 'logs') return renderLogs();
  return renderCustomers();
}

function renderCustomers() {
  const term = state.search.toLowerCase();
  const rows = state.db.customers.filter((customer) => [
    customer.name,
    customer.contact,
    customer.clientEmail,
    customer.packageName,
    customer.remark
  ].join(' ').toLowerCase().includes(term));

  return `
    <div class="toolbar">
      <div class="toolbar-left">
        <input class="search" placeholder="搜索用户、联系方式、套餐、client email" value="${h(state.search)}" data-search>
      </div>
      <div class="toolbar-right">
        <button class="btn primary" data-action="new-customer">+ 新建用户</button>
      </div>
    </div>
    <section class="panel">
      <div class="panel-head">
        <div><h2>用户列表</h2><p>续费、停用、同步 3x-ui 都可以在这里完成。</p></div>
      </div>
      <table>
        <thead><tr>
          <th style="width:170px">用户</th>
          <th style="width:126px">联系方式</th>
          <th style="width:110px">套餐</th>
          <th style="width:158px">到期时间</th>
          <th style="width:88px">流量</th>
          <th style="width:168px">3x-ui 节点</th>
          <th style="width:142px">SOCKS</th>
          <th style="width:88px">状态</th>
          <th style="width:336px">操作</th>
        </tr></thead>
        <tbody>${rows.length ? rows.map(customerRow).join('') : `<tr><td colspan="9" class="empty">还没有用户，点击右上角新建用户开始管理。</td></tr>`}</tbody>
      </table>
    </section>`;
}

function customerRow(customer) {
  const server = state.db.xuiServers.find((item) => item.id === customer.xuiServerId);
  const socks = state.db.socksNodes.find((item) => item.id === customer.socksNodeId);
  return `<tr>
    <td class="main-cell"><strong>${h(customer.name)}</strong><div class="line mono">${h(customer.clientEmail || '-')}</div></td>
    <td>${h(customer.contact || '-')}</td>
    <td>${h(customer.packageName || '-')}<div class="muted">${h(customer.amount || 0)} CNY</div></td>
    <td>${fmtDate(customer.expireAt)}</td>
    <td>${h(customer.trafficLimitGb)} GB</td>
    <td>${h(server?.name || '-')}<div class="mono muted">inbound: ${h(customer.inboundId || '-')}</div></td>
    <td>${customer.useSocks ? `${h(socks?.name || '未选择')}<div class="mono muted">${h(socks?.tag || '-')}</div>` : '<span class="muted">未启用</span>'}</td>
    <td><span class="status ${customer.computedStatus}">${statusText[customer.computedStatus] || customer.computedStatus}</span></td>
    <td><div class="row-actions">
      <button class="btn small primary" data-action="renew" data-id="${customer.id}">续费</button>
      <button class="btn small" data-action="sync" data-id="${customer.id}">同步</button>
      <button class="btn small" data-action="edit-customer" data-id="${customer.id}">编辑</button>
      <button class="btn small" data-action="toggle" data-id="${customer.id}">${customer.status === 'disabled' ? '启用' : '停用'}</button>
      <button class="btn small danger" data-action="delete-customer" data-id="${customer.id}">删除</button>
    </div></td>
  </tr>`;
}

function renderServers() {
  return `
    <div class="toolbar"><div class="toolbar-left"></div><div class="toolbar-right"><button class="btn primary" data-action="new-server">+ 添加 3x-ui 节点</button></div></div>
    <section class="panel">
      <div class="panel-head"><div><h2>3x-ui 节点</h2><p>保存中心面板或远程节点的连接信息，用户同步时会使用这里的配置。</p></div></div>
      <table><thead><tr><th style="width:190px">名称</th><th>地址</th><th style="width:110px">基础路径</th><th style="width:160px">账号 / API</th><th style="width:90px">状态</th><th style="width:320px">操作</th></tr></thead>
      <tbody>${state.db.xuiServers.length ? state.db.xuiServers.map(serverRow).join('') : `<tr><td colspan="6" class="empty">还没有 3x-ui 节点。先添加你的中心面板或远程节点。</td></tr>`}</tbody></table>
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
      <div class="panel-head"><div><h2>SOCKS 出站</h2><p>统一维护可复用的 SOCKS 中转，用户创建时直接选择对应出站。</p></div></div>
      <table><thead><tr><th style="width:190px">名称</th><th>地址</th><th style="width:130px">认证</th><th style="width:150px">Tag</th><th style="width:100px">绑定用户</th><th style="width:90px">状态</th><th style="width:210px">操作</th></tr></thead>
      <tbody>${state.db.socksNodes.length ? state.db.socksNodes.map(socksRow).join('') : `<tr><td colspan="7" class="empty">还没有 SOCKS 出站。添加后可在用户资料里启用中转。</td></tr>`}</tbody></table>
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
    <div class="panel-head"><div><h2>同步日志</h2><p>记录用户创建、续费、停用和同步到 3x-ui 的结果。</p></div></div>
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

function renderDrawer() {
  const { type, item } = state.drawer;
  const currentItem = item || {};
  const title = {
    customer: item ? '编辑用户' : '新建用户',
    server: item ? '编辑 3x-ui 节点' : '添加 3x-ui 节点',
    socks: item ? '编辑 SOCKS 出站' : '添加 SOCKS 出站',
    renew: '用户续费',
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

function renderSection(title, body) {
  return `<div class="form-section"><div class="section-title">${title}</div>${body}</div>`;
}

function drawerFields(type, item = {}) {
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
      `)}`;
  }

  if (type === 'socks') {
    return `
      ${renderSection('出站信息', `
        <div class="grid-2"><div class="field"><label>名称</label><input name="name" value="${h(item.name)}" required></div><div class="field"><label>Tag</label><input name="tag" value="${h(item.tag)}" placeholder="socks_hk_01"></div></div>
        <div class="grid-2"><div class="field"><label>地址</label><input name="address" value="${h(item.address)}" required></div><div class="field"><label>端口</label><input name="port" type="number" value="${h(item.port || 1080)}"></div></div>
      `)}
      ${renderSection('认证和状态', `
        <div class="grid-2"><div class="field"><label>用户名</label><input name="username" value="${h(item.username)}"></div><div class="field"><label>密码</label><input name="password" type="password" value="${h(item.password)}"></div></div>
        <div class="grid-2"><div class="field"><label>状态</label><select name="status"><option value="enabled" ${item.status !== 'disabled' ? 'selected' : ''}>启用</option><option value="disabled" ${item.status === 'disabled' ? 'selected' : ''}>停用</option></select></div><div class="field"><label>备注</label><input name="remark" value="${h(item.remark)}"></div></div>
      `)}`;
  }

  if (type === 'renew') {
    return `
      <div class="form-note">用户：${h(item.name)}，当前到期：${fmtDate(item.expireAt)}</div>
      ${renderSection('续费信息', `
        <div class="grid-2"><div class="field"><label>续费月数</label><input name="months" type="number" min="1" value="1"></div><div class="field"><label>收款金额</label><input name="amount" type="number" min="0" step="0.01" value="${h(item.amount || 0)}"></div></div>
      `)}`;
  }

  if (type === 'security') {
    return `
      <div class="form-note">修改管理员账号或密码后，当前会话会自动退出，需要使用新账号密码重新登录。</div>
      ${renderSection('管理员账号', `
        <div class="field"><label>管理员账号</label><input name="username" value="${h(state.db.settings?.adminUsername || state.user || 'admin')}" autocomplete="username" required></div>
      `)}
      ${renderSection('修改密码', `
        <div class="field"><label>当前密码</label><input name="currentPassword" type="password" autocomplete="current-password" required></div>
        <div class="field"><label>新密码</label><input name="newPassword" type="password" minlength="8" autocomplete="new-password" required></div>
        <div class="field"><label>确认新密码</label><input name="confirmPassword" type="password" minlength="8" autocomplete="new-password" required></div>
      `)}`;
  }

  return `
    ${renderSection('用户资料', `
      <div class="grid-2"><div class="field"><label>用户名称</label><input name="name" value="${h(item.name)}" required></div><div class="field"><label>联系方式</label><input name="contact" value="${h(item.contact)}"></div></div>
      <div class="grid-3"><div class="field"><label>套餐</label><input name="packageName" value="${h(item.packageName || '月付套餐')}"></div><div class="field"><label>金额</label><input name="amount" type="number" step="0.01" value="${h(item.amount || 0)}"></div><div class="field"><label>流量 GB</label><input name="trafficLimitGb" type="number" value="${h(item.trafficLimitGb || 100)}"></div></div>
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
    state.view = button.dataset.view;
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
  const drawerForm = document.querySelector('#drawerForm');
  drawerForm?.addEventListener('click', (event) => event.stopPropagation());
  drawerForm?.addEventListener('submit', handleDrawerSubmit);
}

async function handleAction(event) {
  const action = event.currentTarget.dataset.action;
  const id = event.currentTarget.dataset.id;
  try {
    if (action === 'refresh') return refresh();
    if (action === 'logout') {
      await api('/api/logout', { method: 'POST' });
      state.db = null;
      return renderLogin();
    }
    if (action === 'close-drawer') {
      state.drawer = null;
      return render();
    }
    if (action === 'security') {
      state.drawer = { type: 'security', item: null };
      return render();
    }
    if (action === 'new-customer') {
      state.drawer = { type: 'customer', item: null };
      return render();
    }
    if (action === 'edit-customer') {
      state.drawer = { type: 'customer', item: state.db.customers.find((customer) => customer.id === id) };
      return render();
    }
    if (action === 'new-server') {
      state.drawer = { type: 'server', item: null };
      return render();
    }
    if (action === 'edit-server') {
      state.drawer = { type: 'server', item: state.db.xuiServers.find((server) => server.id === id) };
      return render();
    }
    if (action === 'new-socks') {
      state.drawer = { type: 'socks', item: null };
      return render();
    }
    if (action === 'edit-socks') {
      state.drawer = { type: 'socks', item: state.db.socksNodes.find((socks) => socks.id === id) };
      return render();
    }
    if (action === 'renew') {
      state.drawer = { type: 'renew', item: state.db.customers.find((customer) => customer.id === id) };
      return render();
    }
    if (action === 'sync') {
      const result = await api(`/api/customers/${id}/sync`, { method: 'POST' });
      state.db = result.data;
      const syncAction = result.detail?.clientResult?.action === 'update' ? '已更新' : '已新增';
      const createdInbound = result.detail?.clientResult?.createdInbound;
      const suffix = createdInbound ? `，新入站端口 ${createdInbound.port}` : '';
      const socksSuffix = result.detail?.socksResult?.applied ? `，SOCKS ${result.detail.socksResult.outboundTag}` : '';
      toast(`同步完成：3x-ui 用户${syncAction}${suffix}${socksSuffix}`);
      return render();
    }
    if (action === 'toggle') {
      const result = await api(`/api/customers/${id}/toggle`, { method: 'POST' });
      state.db = result.data;
      return render();
    }
    if (action === 'delete-customer' && confirm('确定删除这个用户？会同步删除 3-xui 里的 client，并清理这个用户对应的 SOCKS 路由。')) {
      const result = await api(`/api/customers/${id}`, { method: 'DELETE' });
      state.db = result.data;
      const removedRules = result.detail?.socksResult?.removedRules || 0;
      const removedOutbounds = result.detail?.socksResult?.removedOutbounds || 0;
      const clientText = result.detail?.clientResult?.fallback?.deleted ? '，已用兼容接口删除 3-xui 客户端' : result.detail?.clientResult?.deleted || result.detail?.clientResult?.detached ? '，3-xui 客户端已处理' : '';
      const inboundText = result.detail?.inboundResult?.deleted ? '，空入站已删除' : '';
      const warningText = result.warning ? `，远程警告：${result.warning}` : '';
      toast(`用户已删除，SOCKS 清理：规则 ${removedRules}，出站 ${removedOutbounds}${clientText}${inboundText}${warningText}`);
      return render();
    }
    if (action === 'delete-server' && confirm('确定删除这个 3x-ui 节点？')) {
      const result = await api(`/api/xui-servers/${id}`, { method: 'DELETE' });
      state.db = result.data;
      return render();
    }
    if (action === 'delete-socks' && confirm('确定删除这个 SOCKS 出站？')) {
      const result = await api(`/api/socks-nodes/${id}`, { method: 'DELETE' });
      state.db = result.data;
      return render();
    }
    if (action === 'disable-expired') {
      const result = await api('/api/maintenance/disable-expired', { method: 'POST' });
      state.db = result.data;
      toast(`已停用 ${result.count} 个过期用户`);
      return render();
    }
    if (action === 'test-server') {
      const server = state.db.xuiServers.find((item) => item.id === id);
      const result = await api('/api/test-xui', { method: 'POST', body: server });
      return toast(result.message || '3x-ui 节点连接成功');
    }
    if (action === 'import-server-customers' && confirm('确定从这个 3-xui 节点同步用户到本地用户列表？相同 Client Email 会更新，不会重复新增。')) {
      const result = await api(`/api/xui-servers/${id}/import-customers`, { method: 'POST' });
      state.db = result.data;
      toast(`同步完成：用户新增 ${result.detail.created}，更新 ${result.detail.updated}，SOCKS 新增 ${result.detail.socksCreated}，更新 ${result.detail.socksUpdated}，绑定 ${result.detail.socksBound}`);
      return render();
    }
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
  if (type === 'security' && body.newPassword !== body.confirmPassword) {
    return toast('两次输入的新密码不一致');
  }
  try {
    let result;
    if (type === 'customer') result = await api(id ? `/api/customers/${id}` : '/api/customers', { method: id ? 'PUT' : 'POST', body });
    if (type === 'server') result = await api(id ? `/api/xui-servers/${id}` : '/api/xui-servers', { method: id ? 'PUT' : 'POST', body });
    if (type === 'socks') result = await api(id ? `/api/socks-nodes/${id}` : '/api/socks-nodes', { method: id ? 'PUT' : 'POST', body });
    if (type === 'renew') result = await api(`/api/customers/${id}/renew`, { method: 'POST', body });
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
    toast('保存成功');
  } catch (error) {
    toast(error.message);
  }
}

bootstrap();
