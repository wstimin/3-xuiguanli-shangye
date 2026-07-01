import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'data', 'db.json');
const SECRET_FILE = path.join(__dirname, 'data', '.secret');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3388);
const DEFAULT_ADMIN_USER = process.env.ADMIN_USER || 'admin';
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const INBOUND_TEMPLATES = new Set(['vless-tcp', 'vless-reality', 'vless-tls', 'vless-ws', 'vless-grpc']);
const DEFAULT_ALPN = Object.freeze(['h3', 'h2', 'http/1.1']);
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;

const sessions = new Map();
const loginAttempts = new Map();

async function ensureSecret() {
  await fs.mkdir(path.dirname(SECRET_FILE), { recursive: true });
  try {
    const secret = (await fs.readFile(SECRET_FILE, 'utf8')).trim();
    if (secret) return secret;
  } catch {
    // Create below.
  }
  const secret = crypto.randomBytes(32).toString('hex');
  await fs.writeFile(SECRET_FILE, secret, 'utf8');
  return secret;
}

const SECRET = await ensureSecret();
const ENC_KEY = crypto.createHash('sha256').update(SECRET).digest();

function encrypt(value) {
  if (!value) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}

function decrypt(value) {
  if (!value) return '';
  try {
    const [ivText, tagText, encryptedText] = value.split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(ivText, 'base64'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedText, 'base64')),
      decipher.final()
    ]).toString('utf8');
  } catch {
    return '';
  }
}

function maskSecret(value) {
  return value ? '********' : '';
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const key = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${key}`;
}

function verifyPassword(password, hash) {
  if (!hash) return false;
  const [method, salt, key] = String(hash).split(':');
  if (method !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'hex');
  const actual = Buffer.from(hashPassword(password, salt).split(':')[2], 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function adminUsername(db) {
  return db.settings?.admin?.username || DEFAULT_ADMIN_USER;
}

function usingDefaultAdmin(db) {
  return !db.settings?.admin?.passwordHash && adminUsername(db) === DEFAULT_ADMIN_USER && DEFAULT_ADMIN_PASSWORD === 'admin123';
}

function verifyAdmin(db, username, password) {
  const configuredUser = adminUsername(db);
  if (username !== configuredUser) return false;
  const storedHash = db.settings?.admin?.passwordHash;
  return storedHash ? verifyPassword(password, storedHash) : password === DEFAULT_ADMIN_PASSWORD;
}

function nowIso() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function addMonths(dateText, months) {
  const base = dateText && new Date(dateText) > new Date() ? new Date(dateText) : new Date();
  const result = new Date(base);
  result.setMonth(result.getMonth() + Number(months || 1));
  return result.toISOString();
}

function expiryMs(iso) {
  if (!iso) return 0;
  return new Date(iso).getTime();
}

function gbToBytes(gb) {
  return Math.max(0, Number(gb || 0)) * 1024 * 1024 * 1024;
}

function customerStatus(customer) {
  if (customer.status === 'disabled') return 'disabled';
  if (!customer.expireAt) return customer.status || 'active';
  const ms = new Date(customer.expireAt).getTime() - Date.now();
  if (ms < 0) return 'expired';
  if (ms <= 3 * 24 * 60 * 60 * 1000) return 'warning';
  return 'active';
}

async function readDb() {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  let db;
  try {
    const text = await fs.readFile(DATA_FILE, 'utf8');
    db = JSON.parse(text);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    db = {};
  }
  db.customers ||= [];
  db.xuiServers ||= [];
  db.socksNodes ||= [];
  db.syncLogs ||= [];
  db.settings ||= { currency: 'CNY', expiryWarningDays: 3 };
  db.settings.currency ||= 'CNY';
  db.settings.expiryWarningDays = Number(db.settings.expiryWarningDays ?? 3);
  return db;
}

async function writeDb(db) {
  const tmp = `${DATA_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
  await fs.rename(tmp, DATA_FILE);
}

function publicDb(db) {
  return {
    settings: {
      currency: db.settings?.currency || 'CNY',
      expiryWarningDays: Number(db.settings?.expiryWarningDays ?? 3),
      adminUsername: adminUsername(db),
      passwordManaged: Boolean(db.settings?.admin?.passwordHash),
      defaultPasswordWarning: usingDefaultAdmin(db)
    },
    customers: db.customers.map((customer) => ({ ...customer, computedStatus: customerStatus(customer) })),
    xuiServers: db.xuiServers.map(({ passwordEnc, apiTokenEnc, ...server }) => ({
      ...server,
      username: server.username || '',
      password: maskSecret(passwordEnc),
      apiToken: maskSecret(apiTokenEnc)
    })),
    socksNodes: db.socksNodes.map(({ passwordEnc, ...node }) => ({
      ...node,
      password: maskSecret(passwordEnc)
    })),
    syncLogs: db.syncLogs.slice(-250).reverse()
  };
}

async function parseJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BODY_BYTES) {
      const error = new Error('请求体过大');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('请求体不是有效 JSON');
    error.statusCode = 400;
    throw error;
  }
}

function securityHeaders(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    ...extra
  };
}

function send(res, status, data) {
  res.writeHead(status, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
  res.end(JSON.stringify(data));
}

function sendError(res, status, message, detail) {
  send(res, status, { ok: false, message, detail });
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || '';
  const match = cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}

function requireAuth(req, res) {
  const token = getCookie(req, 'xcp_session');
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    sendError(res, 401, '请先登录');
    return null;
  }
  session.expiresAt = Date.now() + 12 * 60 * 60 * 1000;
  return session;
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function tooManyLoginAttempts(req) {
  const key = clientIp(req);
  const now = Date.now();
  const entry = loginAttempts.get(key) || { count: 0, firstAt: now };
  if (now - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 0, firstAt: now });
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function recordLoginAttempt(req, success) {
  const key = clientIp(req);
  if (success) {
    loginAttempts.delete(key);
    return;
  }
  const now = Date.now();
  const entry = loginAttempts.get(key) || { count: 0, firstAt: now };
  if (now - entry.firstAt > LOGIN_WINDOW_MS) loginAttempts.set(key, { count: 1, firstAt: now });
  else loginAttempts.set(key, { count: entry.count + 1, firstAt: entry.firstAt });
}

function isHttpsRequest(req) {
  return req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function sessionCookie(req, token, options = {}) {
  const parts = [`xcp_session=${encodeURIComponent(token)}`, 'HttpOnly', 'Path=/', 'SameSite=Lax'];
  if (isHttpsRequest(req)) parts.push('Secure');
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  return parts.join('; ');
}

function hasField(input, field) {
  return Object.prototype.hasOwnProperty.call(input, field);
}

function textValue(input, existing, field, fallback = '') {
  return String(hasField(input, field) ? input[field] : existing[field] ?? fallback).trim();
}

function numberValue(input, existing, field, fallback = 0) {
  const value = hasField(input, field) ? input[field] : existing[field] ?? fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : Number(fallback);
}

function normalizeBasePath(value) {
  const text = String(value || '/').trim();
  if (!text || text === '/') return '/';
  return `/${text.replace(/^\/+|\/+$/g, '')}`;
}

function normalizeEndpoint(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.startsWith('/') ? text : `/${text}`;
}

function normalizeServer(input, existing = {}) {
  const passwordText = hasField(input, 'password') ? String(input.password || '') : '********';
  const apiTokenText = hasField(input, 'apiToken') ? String(input.apiToken || '') : '********';
  const passwordEnc = passwordText === ''
    ? ''
    : passwordText !== '********'
      ? encrypt(passwordText)
      : existing.passwordEnc || '';
  const apiTokenEnc = apiTokenText === ''
    ? ''
    : apiTokenText !== '********'
      ? encrypt(apiTokenText)
      : existing.apiTokenEnc || '';
  return {
    ...existing,
    id: existing.id || id('xui'),
    name: textValue(input, existing, 'name'),
    protocol: ['http', 'https'].includes(textValue(input, existing, 'protocol', 'https')) ? textValue(input, existing, 'protocol', 'https') : 'https',
    host: textValue(input, existing, 'host'),
    port: numberValue(input, existing, 'port', 2053),
    basePath: normalizeBasePath(textValue(input, existing, 'basePath', '/')),
    apiPrefix: normalizeEndpoint(textValue(input, existing, 'apiPrefix')),
    loginEndpoint: normalizeEndpoint(textValue(input, existing, 'loginEndpoint')),
    addClientEndpoint: normalizeEndpoint(textValue(input, existing, 'addClientEndpoint')),
    updateClientEndpoint: normalizeEndpoint(textValue(input, existing, 'updateClientEndpoint')),
    listInboundsEndpoint: normalizeEndpoint(textValue(input, existing, 'listInboundsEndpoint')),
    username: textValue(input, existing, 'username'),
    passwordEnc,
    apiTokenEnc,
    tlsVerify: input.tlsVerify !== false,
    status: textValue(input, existing, 'status', 'enabled') === 'disabled' ? 'disabled' : 'enabled',
    remark: textValue(input, existing, 'remark'),
    updatedAt: nowIso(),
    createdAt: existing.createdAt || nowIso()
  };
}

function withApiPrefix(server, endpoint) {
  const prefix = String(server.apiPrefix || '').trim().replace(/\/$/, '');
  if (!prefix) return endpoint;
  return `${prefix}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
}

function uniqueRoutes(routes) {
  const seen = new Set();
  return routes.filter((route) => {
    const key = `${route.method || 'GET'}:${route.endpoint}:${JSON.stringify(route.body ?? {})}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeSocks(input, existing = {}) {
  const passwordText = hasField(input, 'password') ? String(input.password || '') : '********';
  const passwordEnc = passwordText === ''
    ? ''
    : passwordText !== '********'
      ? encrypt(passwordText)
      : existing.passwordEnc || '';
  const rawTag = textValue(input, existing, 'tag') || `socks_${textValue(input, existing, 'name', 'node').toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
  const tag = rawTag.replace(/^_+|_+$/g, '') || `socks_${crypto.randomBytes(3).toString('hex')}`;
  return {
    ...existing,
    id: existing.id || id('socks'),
    name: textValue(input, existing, 'name'),
    address: textValue(input, existing, 'address'),
    port: numberValue(input, existing, 'port', 1080),
    username: textValue(input, existing, 'username'),
    passwordEnc,
    tag,
    status: textValue(input, existing, 'status', 'enabled') === 'disabled' ? 'disabled' : 'enabled',
    remark: textValue(input, existing, 'remark'),
    updatedAt: nowIso(),
    createdAt: existing.createdAt || nowIso()
  };
}

function normalizeCustomer(input, existing = {}) {
  const name = textValue(input, existing, 'name');
  const email = String(hasField(input, 'clientEmail') ? input.clientEmail : existing.clientEmail || '').trim()
    || `cust_${crypto.randomBytes(4).toString('hex')}`;
  const clientUuid = String(hasField(input, 'clientUuid') ? input.clientUuid : existing.clientUuid || '').trim()
    || crypto.randomUUID();
  return {
    ...existing,
    id: existing.id || id('cus'),
    name,
    contact: textValue(input, existing, 'contact'),
    packageName: textValue(input, existing, 'packageName', '月付套餐') || '月付套餐',
    amount: numberValue(input, existing, 'amount', 0),
    expireAt: textValue(input, existing, 'expireAt') || addMonths(null, 1),
    trafficLimitGb: numberValue(input, existing, 'trafficLimitGb', 100),
    status: textValue(input, existing, 'status', 'active') === 'disabled' ? 'disabled' : 'active',
    xuiServerId: textValue(input, existing, 'xuiServerId'),
    inboundId: textValue(input, existing, 'inboundId'),
    autoCreateInbound: Boolean(hasField(input, 'autoCreateInbound') ? input.autoCreateInbound : existing.autoCreateInbound ?? false),
    inboundPort: textValue(input, existing, 'inboundPort'),
    inboundRemark: textValue(input, existing, 'inboundRemark'),
    inboundTemplate: INBOUND_TEMPLATES.has(textValue(input, existing, 'inboundTemplate', 'vless-tcp')) ? textValue(input, existing, 'inboundTemplate', 'vless-tcp') : 'vless-tcp',
    inboundSni: textValue(input, existing, 'inboundSni'),
    inboundHost: textValue(input, existing, 'inboundHost'),
    inboundPath: textValue(input, existing, 'inboundPath'),
    inboundGrpcServiceName: textValue(input, existing, 'inboundGrpcServiceName'),
    inboundCertFile: textValue(input, existing, 'inboundCertFile'),
    inboundKeyFile: textValue(input, existing, 'inboundKeyFile'),
    clientId: textValue(input, existing, 'clientId'),
    clientEmail: email,
    clientUuid,
    protocol: textValue(input, existing, 'protocol', 'vless') || 'vless',
    useSocks: Boolean(hasField(input, 'useSocks') ? input.useSocks : existing.useSocks ?? false),
    socksNodeId: textValue(input, existing, 'socksNodeId'),
    remark: textValue(input, existing, 'remark'),
    updatedAt: nowIso(),
    createdAt: existing.createdAt || nowIso()
  };
}

function validateCustomerBinding(customer) {
  if (!customer.xuiServerId) throw new Error('请先选择 3x-ui 节点');
  if (!customer.inboundId && !customer.autoCreateInbound) throw new Error('请填写 3x-ui Inbound ID，或启用自动创建入站');
  if (!Number.isInteger(Number(customer.inboundId)) || Number(customer.inboundId) <= 0) {
    if (customer.inboundId) throw new Error('Inbound ID 必须是 3x-ui 入站列表里的数字 ID，例如 1');
  }
  if (customer.inboundPort) {
    const port = Number(customer.inboundPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('新入站端口必须是 1-65535 之间的数字');
  }
  if (customer.autoCreateInbound && customer.inboundTemplate === 'vless-tls' && (!customer.inboundCertFile || !customer.inboundKeyFile)) {
    throw new Error('TLS 模板需要填写证书文件路径和私钥文件路径');
  }
  if (!customer.clientEmail) throw new Error('Client Email 不能为空');
}

function ensureCustomerIdentity(customer) {
  if (!customer.clientEmail) customer.clientEmail = `cust_${crypto.randomBytes(4).toString('hex')}`;
  if (!customer.clientUuid) customer.clientUuid = crypto.randomUUID();
  if (!customer.clientId) customer.clientId = customer.clientEmail;
  return customer;
}

function inboundIdOf(item) {
  return Number(item?.id ?? item?.inboundId ?? item?.inbound_id ?? item?.value);
}

function inboundLabel(item) {
  const idValue = item?.id ?? item?.inboundId ?? item?.inbound_id ?? item?.value ?? '-';
  const name = item?.remark || item?.tag || item?.label || item?.name || '';
  return name ? `${idValue}(${name})` : String(idValue);
}

function inboundTagOf(item) {
  const explicit = String(item?.tag || item?.inboundTag || item?.inbound_tag || '').trim();
  if (explicit) return explicit;
  const port = inboundPortOf(item);
  const settings = parseMaybeJson(item?.streamSettings) || item?.streamSettings || {};
  const network = String(settings?.network || item?.network || 'tcp').trim() || 'tcp';
  return port ? `in-${port}-${network}` : '';
}

function inboundPortOf(item) {
  const value = item?.port ?? item?.listenPort ?? item?.listen_port;
  const port = Number(value);
  return Number.isInteger(port) ? port : 0;
}

function usedInboundPorts(items) {
  return new Set(items.map(inboundPortOf).filter((port) => port > 0));
}

function pickInboundPort(items, preferredPort) {
  const used = usedInboundPorts(items);
  const preferred = Number(preferredPort || 0);
  if (preferred) {
    if (used.has(preferred)) throw new Error(`端口 ${preferred} 已被 3x-ui 现有入站占用，请换一个端口`);
    return preferred;
  }
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const port = 20000 + crypto.randomInt(40000);
    if (!used.has(port)) return port;
  }
  for (let port = 20000; port <= 59999; port += 1) {
    if (!used.has(port)) return port;
  }
  throw new Error('没有找到可用入站端口，请手动填写一个未占用端口');
}

function safePath(value, fallback) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text.startsWith('/') ? text : `/${text}`;
}

function randomShortId() {
  return crypto.randomBytes(8).toString('hex');
}

function defaultAlpn() {
  return [...DEFAULT_ALPN];
}

async function getRealityKeyPair(server) {
  const result = await xuiRequest(server, withApiPrefix(server, '/panel/api/server/getNewX25519Cert'), { method: 'GET' });
  const object = xuiObject(result.data);
  const privateKey = object.privateKey || object.private_key || object.obj?.privateKey || object.data?.privateKey || '';
  const publicKey = object.publicKey || object.public_key || object.obj?.publicKey || object.data?.publicKey || '';
  if (!privateKey) throw new Error('Reality 模板生成 X25519 密钥失败，请检查 3-xui API Token 权限');
  return { privateKey, publicKey };
}

function buildDefaultInbound(customer, port, options = {}) {
  const remark = String(customer.inboundRemark || customer.name || customer.clientEmail || `十夜-${port}`).trim();
  const template = customer.inboundTemplate || 'vless-tcp';
  const sni = String(customer.inboundSni || customer.inboundHost || 'www.cloudflare.com').trim();
  const host = String(customer.inboundHost || sni).trim();
  const alpn = defaultAlpn();
  const base = {
    enable: true,
    remark,
    listen: '',
    port,
    protocol: 'vless',
    settings: {
      clients: [],
      decryption: 'none',
      fallbacks: []
    },
    sniffing: {
      enabled: true,
      destOverride: ['http', 'tls', 'quic'],
      metadataOnly: false,
      routeOnly: false
    },
    expiryTime: 0,
    total: 0
  };

  const tcpSettings = {
    network: 'tcp',
    security: 'none',
    tcpSettings: {
      acceptProxyProtocol: false,
      header: { type: 'none' }
    }
  };

  if (template === 'vless-reality') {
    const keys = options.realityKeys || {};
    return {
      ...base,
      streamSettings: {
        network: 'tcp',
        security: 'reality',
        tcpSettings: tcpSettings.tcpSettings,
        realitySettings: {
          show: false,
          dest: host.includes(':') ? host : `${host}:443`,
          xver: 0,
          serverNames: [sni],
          alpn,
          privateKey: keys.privateKey,
          publicKey: keys.publicKey || '',
          shortIds: [randomShortId()],
          settings: { publicKey: keys.publicKey || '', fingerprint: 'chrome', serverName: sni, spiderX: '/', alpn }
        }
      }
    };
  }

  if (template === 'vless-tls') {
    return {
      ...base,
      streamSettings: {
        network: 'tcp',
        security: 'tls',
        tcpSettings: tcpSettings.tcpSettings,
        tlsSettings: {
          serverName: sni,
          alpn,
          minVersion: '1.2',
          maxVersion: '1.3',
          cipherSuites: '',
          rejectUnknownSni: false,
          certificates: [{ certificateFile: customer.inboundCertFile, keyFile: customer.inboundKeyFile }],
          certFile: customer.inboundCertFile,
          keyFile: customer.inboundKeyFile
        }
      }
    };
  }

  if (template === 'vless-ws') {
    return {
      ...base,
      streamSettings: {
        network: 'ws',
        security: 'none',
        wsSettings: {
          acceptProxyProtocol: false,
          path: safePath(customer.inboundPath, '/shiye'),
          host,
          headers: host ? { Host: host } : {}
        }
      }
    };
  }

  if (template === 'vless-grpc') {
    return {
      ...base,
      streamSettings: {
        network: 'grpc',
        security: 'none',
        grpcSettings: {
          serviceName: String(customer.inboundGrpcServiceName || 'shiye').trim(),
          multiMode: false
        }
      }
    };
  }

  return {
    ...base,
    streamSettings: tcpSettings
  };
}

function baseUrl(server) {
  const basePath = server.basePath === '/' ? '' : server.basePath.replace(/\/$/, '');
  return `${server.protocol}://${server.host}:${server.port}${basePath}`;
}

function requestUrl(server, endpoint) {
  const base = baseUrl(server);
  const basePath = server.basePath === '/' ? '' : server.basePath.replace(/\/$/, '');
  const pathText = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  if (basePath && pathText === basePath) {
    return `${server.protocol}://${server.host}:${server.port}${pathText}`;
  }
  if (basePath && pathText.startsWith(`${basePath}/`)) {
    return `${server.protocol}://${server.host}:${server.port}${pathText}`;
  }
  return `${base}${pathText}`;
}

function cookieHeader(setCookie) {
  return String(setCookie || '')
    .split(/,(?=\s*[^;]+=)/)
    .map((part) => part.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function xuiLoginContext(server) {
  const urls = uniqueRoutes([
    { endpoint: '/' },
    { endpoint: withApiPrefix(server, '/') }
  ]);
  for (const item of urls) {
    try {
      const response = await fetch(requestUrl(server, item.endpoint), {
        method: 'GET',
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
      });
      const text = await response.text();
      const csrf = text.match(/<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i)?.[1] || '';
      const cookie = cookieHeader(response.headers.get('set-cookie'));
      if (csrf || cookie) return { csrf, cookie };
    } catch {
      // Try the next common login page path.
    }
  }
  return { csrf: '', cookie: '' };
}

async function xuiFetch(server, endpoint, options = {}) {
  const url = requestUrl(server, endpoint);
  const headers = { ...(options.headers || {}) };
  const apiToken = decrypt(server.apiTokenEnc);
  if (apiToken && !headers.Cookie && !headers.Authorization) headers.Authorization = `Bearer ${apiToken}`;
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, {
    ...options,
    headers,
    body: typeof options.body === 'string' ? options.body : options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) {
    const error = new Error(`${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
    error.url = url;
    throw error;
  }
  if (data && data.success === false) {
    const message = data.msg || data.message || data.error || JSON.stringify(data).slice(0, 300);
    const error = new Error(`3x-ui API failed: ${message}`);
    error.url = url;
    error.data = data;
    throw error;
  }
  return { data, headers: response.headers, url };
}

async function xuiLogin(server) {
  const username = server.username;
  const password = decrypt(server.passwordEnc);
  if (!username || !password) return '';
  const context = await xuiLoginContext(server);
  const body = { username, password };
  const tries = uniqueRoutes([
    server.loginEndpoint ? { endpoint: server.loginEndpoint, body } : null,
    { endpoint: withApiPrefix(server, '/login'), body },
    { endpoint: withApiPrefix(server, '/panel/login'), body },
    { endpoint: withApiPrefix(server, '/panel/api/login'), body },
    { endpoint: withApiPrefix(server, '/api/login'), body },
    { endpoint: '/login', body },
    { endpoint: '/panel/login', body },
    { endpoint: '/panel/api/login', body },
    { endpoint: '/api/login', body }
  ].filter(Boolean));
  for (const item of tries) {
    const url = requestUrl(server, item.endpoint);
    const baseHeaders = {
      'X-Requested-With': 'XMLHttpRequest',
      ...(context.csrf ? { 'X-CSRF-Token': context.csrf } : {}),
      ...(context.cookie ? { Cookie: context.cookie } : {})
    };
    const attempts = [
      { headers: { ...baseHeaders, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body: new URLSearchParams(item.body).toString() },
      { headers: { ...baseHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(item.body) }
    ];
    for (const attempt of attempts) {
      try {
        const response = await fetch(url, { method: 'POST', ...attempt });
        const cookie = response.headers.get('set-cookie') || '';
        if (response.ok && cookie) {
          return [context.cookie, cookieHeader(cookie)].filter(Boolean).join('; ');
        }
      } catch {
        // Try the next common login path.
      }
    }
  }
  return '';
}

async function xuiRequest(server, endpoint, options = {}) {
  const headers = { ...(options.headers || {}) };
  const apiToken = decrypt(server.apiTokenEnc);
  const cookie = apiToken ? '' : await xuiLogin(server);
  if (!cookie && !apiToken && server.username && decrypt(server.passwordEnc)) {
    const error = new Error('3x-ui 登录失败，请检查账号密码、基础路径/API 前缀，建议优先填写 API Token。');
    error.url = requestUrl(server, endpoint);
    throw error;
  }
  if (cookie) headers.Cookie = cookie;
  if (apiToken && !headers.Authorization) headers.Authorization = `Bearer ${apiToken}`;
  return xuiFetch(server, endpoint, { ...options, headers });
}

function xuiArray(data) {
  const root = xuiObject(data);
  const obj = parseMaybeJson(data?.obj);
  const body = parseMaybeJson(data?.data);
  const result = parseMaybeJson(data?.result);
  if (Array.isArray(data)) return data;
  if (Array.isArray(root)) return root;
  if (Array.isArray(root?.items)) return root.items;
  if (Array.isArray(root?.inbounds)) return root.inbounds;
  if (Array.isArray(root?.clients)) return root.clients;
  if (Array.isArray(obj)) return obj;
  if (Array.isArray(body)) return body;
  if (Array.isArray(result)) return result;
  if (Array.isArray(data?.obj)) return data.obj;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.result)) return data.result;
  if (Array.isArray(data?.inbounds)) return data.inbounds;
  if (Array.isArray(data?.clients)) return data.clients;
  if (Array.isArray(data?.obj?.inbounds)) return data.obj.inbounds;
  if (Array.isArray(data?.obj?.clients)) return data.obj.clients;
  if (Array.isArray(data?.data?.inbounds)) return data.data.inbounds;
  if (Array.isArray(data?.data?.clients)) return data.data.clients;
  if (Array.isArray(data?.obj?.items)) return data.obj.items;
  if (Array.isArray(data?.data?.items)) return data.data.items;
  return [];
}

function xuiObject(data) {
  const obj = parseMaybeJson(data?.obj);
  if (obj && !Array.isArray(obj)) return obj;
  const body = parseMaybeJson(data?.data);
  if (body && !Array.isArray(body)) return body;
  const result = parseMaybeJson(data?.result);
  if (result && !Array.isArray(result)) return result;
  if (data?.obj && !Array.isArray(data.obj)) return data.obj;
  if (data?.data && !Array.isArray(data.data)) return data.data;
  if (data?.result && !Array.isArray(data.result)) return data.result;
  return data || {};
}

async function listXuiInbounds(server) {
  const endpoints = uniqueRoutes([
    server.listInboundsEndpoint ? { endpoint: server.listInboundsEndpoint } : null,
    { endpoint: withApiPrefix(server, '/panel/api/inbounds/options') },
    { endpoint: withApiPrefix(server, '/panel/api/inbounds/list/slim') },
    { endpoint: withApiPrefix(server, '/panel/api/inbounds/list') }
  ].filter(Boolean));
  const errors = [];
  let firstSuccess = null;
  for (const route of endpoints) {
    try {
      const result = await xuiRequest(server, route.endpoint, { method: 'GET' });
      const items = xuiArray(result.data);
      const value = { endpoint: route.endpoint, items, raw: result.data };
      if (!firstSuccess) firstSuccess = value;
      if (items.length) return value;
    } catch (error) {
      errors.push(`${route.endpoint}: ${error.message}`);
    }
  }
  if (firstSuccess) return firstSuccess;
  throw new Error(`无法读取 3x-ui 入站列表，已尝试：${errors.join(' | ') || '无详细错误'}`);
}

async function xuiClientExists(server, email) {
  const detail = await getXuiClientDetail(server, email);
  return Boolean(detail.exists);
}

async function getXuiClientDetail(server, email) {
  try {
    const result = await xuiRequest(server, withApiPrefix(server, `/panel/api/clients/get/${encodeURIComponent(email)}`), { method: 'GET' });
    const explicitObj = parseMaybeJson(result.data?.obj) ?? result.data?.obj;
    if (Object.prototype.hasOwnProperty.call(result.data || {}, 'obj') && !explicitObj) return { exists: false, client: null, inboundIds: [], raw: result.data };
    const object = explicitObj && typeof explicitObj === 'object' ? explicitObj : xuiObject(result.data);
    const client = object.client || object;
    const inboundIds = inboundIdsOfClient(object).length ? inboundIdsOfClient(object) : inboundIdsOfClient(client);
    if (object && Object.keys(object).length && clientEmailOf(client)) return { exists: true, client, inboundIds, raw: result.data };
    return { exists: false, client: null, inboundIds: [], raw: result.data };
  } catch (error) {
    if (/record not found|not found|404/i.test(error.message)) return { exists: false, client: null, inboundIds: [] };
    throw error;
  }
}

function clientEmailOf(client) {
  return String(client?.email || client?.clientEmail || client?.name || '').trim();
}

function clientRemarkOf(client) {
  return String(client?.remark || client?.comment || client?.desc || client?.description || client?.groupName || client?.group_name || '').trim();
}

function clientNameOf(client, email) {
  const value = clientRemarkOf(client) || String(client?.name || client?.username || '').trim();
  return value && value !== email ? value : email;
}

function clientUuidOf(client) {
  const values = [client?.uuid, client?.password, client?.id];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text || /^\d+$/.test(text)) continue;
    return text;
  }
  return '';
}

function clientSubIdOf(client) {
  return String(client?.subId || client?.sub_id || client?.sid || '').trim();
}

function clientIdentifierValues(client, extra = []) {
  const values = [
    clientUuidOf(client),
    client?.uuid,
    client?.password,
    client?.id,
    clientEmailOf(client),
    client?.clientEmail,
    clientSubIdOf(client),
    client?.name,
    client?.username,
    ...extra
  ];
  const seen = new Set();
  return values
    .map((value) => String(value || '').trim())
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function clientMatchesTarget(client, target = {}) {
  const expected = clientIdentifierValues({}, [
    target.email,
    target.clientEmail,
    target.clientId,
    target.clientUuid,
    target.uuid,
    target.subId,
    clientUuidOf(target.detailClient || {}),
    clientEmailOf(target.detailClient || {}),
    clientSubIdOf(target.detailClient || {})
  ]).map((value) => value.toLowerCase());
  if (!expected.length) return false;
  const actual = clientIdentifierValues(client).map((value) => value.toLowerCase());
  return actual.some((value) => expected.includes(value));
}

function inboundIdsOfClient(client, fallbackInboundId = '') {
  const raw = client?.inboundIds || client?.inbound_ids || client?.inbounds || client?.inboundId || client?.inbound_id || fallbackInboundId;
  const parsed = parseMaybeJson(raw);
  const values = Array.isArray(parsed) ? parsed : Array.isArray(raw) ? raw : String(raw || '').split(',');
  return values
    .map((value) => Number(value?.id ?? value?.inboundId ?? value?.inbound_id ?? value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function expiryIsoFromClient(client) {
  const value = Number(client?.expiryTime || client?.expiry_time || client?.expire || 0);
  if (!Number.isFinite(value) || value <= 0) return '';
  const ms = value > 10_000_000_000 ? value : value * 1000;
  return new Date(ms).toISOString();
}

function trafficGbFromClient(client) {
  const bytes = Number(client?.totalGB || client?.total || client?.totalBytes || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round((bytes / 1024 / 1024 / 1024) * 100) / 100;
}

function inboundSettingsOf(inbound) {
  const parsed = parseMaybeJson(inbound?.settings);
  return parsed && typeof parsed === 'object' ? parsed : inbound?.settings && typeof inbound.settings === 'object' ? inbound.settings : {};
}

function clientsFromInbound(inbound) {
  const settings = inboundSettingsOf(inbound);
  const clients = Array.isArray(settings.clients) ? settings.clients : Array.isArray(inbound?.clients) ? inbound.clients : [];
  const inboundId = inboundIdOf(inbound);
  return clients.map((client) => ({
    client: { ...client, protocol: inbound?.protocol || client.protocol },
    inboundIds: inboundId ? [inboundId] : [],
    inbound
  }));
}

function importAssociationKey(email, inboundId) {
  return `${String(email || '').trim()}::${String(inboundId || '').trim() || 'unbound'}`;
}

function firstInboundIdOfImportItem(item) {
  const inboundIds = inboundIdsOfClient(item, item?.inboundId || item?.inbound_id);
  return inboundIds[0] ? String(inboundIds[0]) : '';
}

function clientIndexesFromInbounds(inbounds) {
  const byEmail = new Map();
  const byEmailInbound = new Map();
  const items = [];
  for (const item of (inbounds || []).flatMap(clientsFromInbound)) {
    const email = clientEmailOf(item.client);
    const inboundId = firstInboundIdOfImportItem(item);
    if (!email) continue;
    items.push(item);
    if (!byEmail.has(email)) byEmail.set(email, item);
    if (inboundId) byEmailInbound.set(importAssociationKey(email, inboundId), item);
  }
  return { byEmail, byEmailInbound, items };
}

function mergeClientObjects(base = {}, overlay = {}) {
  const merged = { ...base, ...overlay };
  const baseId = String(base.id || '').trim();
  const overlayId = String(overlay.id || '').trim();
  if (baseId && overlayId && /^\\d+$/.test(overlayId) && !/^\\d+$/.test(baseId)) merged.id = base.id;
  return merged;
}

function mergeClientImportItem(item, indexed) {
  if (!indexed) return item;
  const client = mergeClientObjects(indexed.client || {}, item.client || item || {});
  const inboundIds = inboundIdsOfClient(item).length ? inboundIdsOfClient(item) : inboundIdsOfClient(indexed);
  return {
    ...indexed,
    ...item,
    client,
    inboundIds,
    inbound: item.inbound || indexed.inbound
  };
}

function expandClientImportItems(items) {
  return items.flatMap((item) => {
    const inboundIds = inboundIdsOfClient(item, item?.inboundId || item?.inbound_id);
    if (inboundIds.length <= 1) return [item];
    return inboundIds.map((inboundId) => ({
      ...item,
      inboundId,
      inboundIds: [inboundId]
    }));
  });
}

function indexedClientForImportItem(item, indexes) {
  const email = clientEmailOf(item.client || item);
  const inboundId = firstInboundIdOfImportItem(item);
  return indexes.byEmailInbound.get(importAssociationKey(email, inboundId)) || indexes.byEmail.get(email);
}

function stringList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  if (value === undefined || value === null || value === '') return [];
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function firstSocksServer(outbound) {
  const settings = parseMaybeJson(outbound?.settings) || outbound?.settings || {};
  const servers = settings?.servers;
  return Array.isArray(servers) && servers.length ? servers[0] : null;
}

function socksUserOf(server) {
  const users = server?.users;
  return Array.isArray(users) && users.length ? users[0] : {};
}

function socksInputFromOutbound(outbound) {
  const server = firstSocksServer(outbound);
  if (!server?.address || !server?.port || !outbound?.tag) return null;
  const user = socksUserOf(server);
  return {
    name: outbound.tag,
    tag: outbound.tag,
    address: server.address,
    port: server.port,
    username: user.user || user.username || '',
    password: user.pass || user.password || '',
    status: 'enabled',
    remark: '从 3-xui Xray 出站同步导入'
  };
}

function upsertSocksNodesFromXray(db, config) {
  const outbounds = Array.isArray(config?.outbounds) ? config.outbounds : [];
  let created = 0;
  let updated = 0;
  const tagToSocksId = new Map();
  for (const outbound of outbounds) {
    if (String(outbound?.protocol || '').toLowerCase() !== 'socks') continue;
    const input = socksInputFromOutbound(outbound);
    if (!input) continue;
    const index = db.socksNodes.findIndex((node) => node.tag === input.tag);
    if (index >= 0) {
      db.socksNodes[index] = normalizeSocks(input, db.socksNodes[index]);
      tagToSocksId.set(input.tag, db.socksNodes[index].id);
      updated += 1;
    } else {
      const node = normalizeSocks(input);
      db.socksNodes.push(node);
      tagToSocksId.set(input.tag, node.id);
      created += 1;
    }
  }
  return { created, updated, tagToSocksId };
}

function inboundContext(inbounds) {
  const byId = new Map();
  const tagToId = new Map();
  for (const inbound of inbounds || []) {
    const inboundId = inboundIdOf(inbound);
    const tag = inboundTagOf(inbound);
    if (inboundId) byId.set(inboundId, inbound);
    if (tag && inboundId) tagToId.set(tag, inboundId);
  }
  return { byId, tagToId };
}

function resolveSocksNodeIdForClient(item, client, context) {
  const email = clientEmailOf(client);
  const inboundIds = inboundIdsOfClient(item, item.inboundId || item.inbound_id);
  const inboundTags = new Set(inboundIds.map((inboundId) => inboundTagOf(context.inboundsById?.get(inboundId))).filter(Boolean));
  const rules = Array.isArray(context.xrayConfig?.routing?.rules) ? context.xrayConfig.routing.rules : [];
  for (const rule of rules) {
    if (!rule || rule.enabled === false || !context.tagToSocksId.has(rule.outboundTag)) continue;
    const users = stringList(rule.user);
    if (users.includes(email)) return context.tagToSocksId.get(rule.outboundTag);
  }
  for (const rule of rules) {
    if (!rule || rule.enabled === false || !context.tagToSocksId.has(rule.outboundTag)) continue;
    const ruleInboundTags = stringList(rule.inboundTag);
    if (ruleInboundTags.some((tag) => inboundTags.has(tag))) return context.tagToSocksId.get(rule.outboundTag);
  }
  return '';
}

async function listXuiInboundsFull(server) {
  const endpoints = uniqueRoutes([
    server.listInboundsEndpoint ? { endpoint: server.listInboundsEndpoint } : null,
    { endpoint: withApiPrefix(server, '/panel/api/inbounds/list') },
    { endpoint: withApiPrefix(server, '/panel/api/inbounds/list/slim') },
    { endpoint: withApiPrefix(server, '/panel/api/inbounds/options') }
  ].filter(Boolean));
  const errors = [];
  for (const route of endpoints) {
    try {
      const result = await xuiRequest(server, route.endpoint, { method: 'GET' });
      const items = xuiArray(result.data);
      return { endpoint: route.endpoint, items, raw: result.data };
    } catch (error) {
      errors.push(`${route.endpoint}: ${error.message}`);
    }
  }
  throw new Error(`无法读取 3x-ui 入站列表，已尝试：${errors.join(' | ') || '无详细错误'}`);
}

async function listXuiClients(server) {
  const endpoints = uniqueRoutes([
    { endpoint: withApiPrefix(server, '/panel/api/clients/list') }
  ]);
  const errors = [];
  for (const route of endpoints) {
    try {
      const result = await xuiRequest(server, route.endpoint, { method: 'GET' });
      const rows = xuiArray(result.data);
      if (rows.length) {
        return {
          endpoint: route.endpoint,
          items: rows.map((row) => ({ client: row.client || row, inboundIds: inboundIdsOfClient(row), raw: row })),
          raw: result.data
        };
      }
    } catch (error) {
      errors.push(`${route.endpoint}: ${error.message}`);
    }
  }
  const inbounds = await listXuiInboundsFull(server);
  return { endpoint: inbounds.endpoint, items: inbounds.items.flatMap(clientsFromInbound), raw: inbounds.raw, warnings: errors };
}

function customerFromXuiClient(server, item, context = {}) {
  const client = item.client || item;
  const email = clientEmailOf(client);
  const inboundIds = inboundIdsOfClient(item, item.inboundId || item.inbound_id);
  const inbound = context.inboundsById?.get(inboundIds[0]) || item.inbound || {};
  const socksNodeId = resolveSocksNodeIdForClient(item, client, context);
  const remark = clientRemarkOf(client);
  return {
    id: id('cus'),
    name: clientNameOf(client, email),
    contact: '',
    packageName: String(client.groupName || client.group_name || client.packageName || '3-xui 导入').trim() || '3-xui 导入',
    amount: 0,
    expireAt: expiryIsoFromClient(client),
    trafficLimitGb: trafficGbFromClient(client),
    status: client.enable === false ? 'disabled' : 'active',
    xuiServerId: server.id,
    inboundId: inboundIds[0] ? String(inboundIds[0]) : '',
    autoCreateInbound: false,
    inboundPort: inboundPortOf(inbound) ? String(inboundPortOf(inbound)) : '',
    inboundRemark: inbound?.remark || '',
    inboundTemplate: 'vless-tcp',
    inboundSni: '',
    inboundHost: '',
    inboundPath: '',
    inboundGrpcServiceName: '',
    inboundCertFile: '',
    inboundKeyFile: '',
    clientId: String(client.subId || client.sub_id || email).trim(),
    clientEmail: email,
    clientUuid: clientUuidOf(client) || crypto.randomUUID(),
    protocol: String(client.protocol || inbound?.protocol || 'vless').trim() || 'vless',
    useSocks: Boolean(socksNodeId),
    socksNodeId,
    remark: remark || '从 3-xui 同步导入',
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}

async function importCustomersFromXui(db, serverId) {
  const server = db.xuiServers.find((item) => item.id === serverId);
  if (!server) throw new Error('3x-ui 节点不存在');
  const inbounds = await listXuiInboundsFull(server);
  let xrayConfig = { outbounds: [], routing: { rules: [] } };
  let xrayEndpoint = '';
  let socksImport = { created: 0, updated: 0, tagToSocksId: new Map() };
  try {
    const template = await readXrayTemplate(server);
    xrayConfig = template.config;
    xrayEndpoint = withApiPrefix(server, '/panel/api/xray/');
    socksImport = upsertSocksNodesFromXray(db, xrayConfig);
  } catch (error) {
    xrayConfig = { outbounds: [], routing: { rules: [] } };
    xrayEndpoint = `读取失败：${error.message}`;
  }
  const inboundInfo = inboundContext(inbounds.items);
  const context = {
    xrayConfig,
    tagToSocksId: socksImport.tagToSocksId,
    inboundsById: inboundInfo.byId,
    inboundTagToId: inboundInfo.tagToId
  };
  const remote = await listXuiClients(server);
  const indexedClients = clientIndexesFromInbounds(inbounds.items);
  const remoteItems = expandClientImportItems(remote.items);
  const remoteKeys = new Set(remoteItems.map((item) => {
    const email = clientEmailOf(item.client || item);
    return importAssociationKey(email, firstInboundIdOfImportItem(item));
  }).filter((key) => !key.startsWith('::')));
  for (const item of indexedClients.items) {
    const email = clientEmailOf(item.client || item);
    const key = importAssociationKey(email, firstInboundIdOfImportItem(item));
    if (email && !remoteKeys.has(key)) remoteItems.push(item);
  }
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let socksBound = 0;
  const seen = new Set();
  for (const rawItem of remoteItems) {
    const rawClient = rawItem.client || rawItem;
    const item = mergeClientImportItem(rawItem, indexedClientForImportItem(rawItem, indexedClients));
    const incoming = customerFromXuiClient(server, item, context);
    const associationKey = importAssociationKey(incoming.clientEmail, incoming.inboundId);
    if (!incoming.clientEmail || seen.has(associationKey)) {
      skipped += 1;
      continue;
    }
    seen.add(associationKey);
    if (incoming.useSocks && incoming.socksNodeId) socksBound += 1;
    let index = db.customers.findIndex((customer) => customer.xuiServerId === server.id && customer.clientEmail === incoming.clientEmail && String(customer.inboundId || '') === String(incoming.inboundId || ''));
    if (index < 0) {
      index = db.customers.findIndex((customer) => customer.xuiServerId === server.id && customer.clientEmail === incoming.clientEmail && !customer.inboundId);
    }
    if (index >= 0) {
      db.customers[index] = {
        ...db.customers[index],
        name: incoming.name || db.customers[index].name,
        contact: incoming.contact || db.customers[index].contact,
        packageName: incoming.packageName || db.customers[index].packageName,
        expireAt: incoming.expireAt || db.customers[index].expireAt,
        trafficLimitGb: incoming.trafficLimitGb || db.customers[index].trafficLimitGb,
        status: incoming.status,
        xuiServerId: incoming.xuiServerId || db.customers[index].xuiServerId,
        inboundId: incoming.inboundId || db.customers[index].inboundId,
        inboundPort: incoming.inboundPort || db.customers[index].inboundPort,
        inboundRemark: incoming.inboundRemark || db.customers[index].inboundRemark,
        inboundTemplate: incoming.inboundTemplate || db.customers[index].inboundTemplate,
        clientId: incoming.clientId || db.customers[index].clientId,
        clientEmail: incoming.clientEmail || db.customers[index].clientEmail,
        clientUuid: incoming.clientUuid || db.customers[index].clientUuid,
        protocol: incoming.protocol || db.customers[index].protocol,
        useSocks: incoming.useSocks,
        socksNodeId: incoming.useSocks ? incoming.socksNodeId : '',
        remark: incoming.remark || db.customers[index].remark,
        updatedAt: nowIso()
      };
      updated += 1;
    } else {
      db.customers.push(incoming);
      created += 1;
    }
  }
  addLog(db, server.id, 'import', 'success', `已从 3-xui 同步用户：新增 ${created}，更新 ${updated}，跳过 ${skipped}，绑定 SOCKS ${socksBound}`, { endpoint: remote.endpoint, xrayEndpoint, socksCreated: socksImport.created, socksUpdated: socksImport.updated });
  return { endpoint: remote.endpoint, xrayEndpoint, total: remoteItems.length, created, updated, skipped, socksBound, socksCreated: socksImport.created, socksUpdated: socksImport.updated };
}

async function createXuiInbound(server, customer, currentInbounds) {
  const port = pickInboundPort(currentInbounds.items, customer.inboundPort);
  const realityKeys = customer.inboundTemplate === 'vless-reality' ? await getRealityKeyPair(server) : null;
  const payload = buildDefaultInbound(customer, port, { realityKeys });
  const endpoint = withApiPrefix(server, '/panel/api/inbounds/add');
  const result = await xuiRequest(server, endpoint, { method: 'POST', body: payload });
  const refreshed = await listXuiInbounds(server);
  const created = refreshed.items.find((item) => inboundPortOf(item) === port);
  const inboundId = inboundIdOf(created);
  if (!Number.isInteger(inboundId) || inboundId <= 0) {
    throw new Error(`已创建端口 ${port} 的入站，但没有读取到新 Inbound ID，请在 3x-ui 后台确认后手动填写`);
  }
  customer.inboundId = String(inboundId);
  customer.inboundPort = String(port);
  customer.inboundRemark = payload.remark;
  return { endpoint, inboundId, port, remark: payload.remark, template: customer.inboundTemplate || 'vless-tcp', result: result.data };
}

async function syncClientToXui(db, customer, action = 'upsert') {
  ensureCustomerIdentity(customer);
  validateCustomerBinding(customer);
  const server = db.xuiServers.find((item) => item.id === customer.xuiServerId);
  if (!server) throw new Error('用户绑定的 3x-ui 节点不存在，请重新选择节点');

  const inbounds = await listXuiInbounds(server);
  let createdInbound = null;
  if (!customer.inboundId && customer.autoCreateInbound) {
    createdInbound = await createXuiInbound(server, customer, inbounds);
  } else if (!inbounds.items.length) {
    throw new Error(`3x-ui 节点连接成功，但没有读取到入站。请先在 3x-ui 创建入站，或检查 API Token 权限。接口：${inbounds.endpoint}`);
  }

  const inboundId = Number(customer.inboundId);
  const checkedInbounds = createdInbound ? await listXuiInbounds(server) : inbounds;
  const inboundExists = checkedInbounds.items.some((item) => inboundIdOf(item) === inboundId);
  if (!inboundExists) {
    const knownIds = checkedInbounds.items.map(inboundLabel).join(', ') || '无';
    throw new Error(`这个 3x-ui 节点没有 Inbound ID ${inboundId}。可用 ID：${knownIds}`);
  }

  const client = {
    id: customer.clientUuid,
    uuid: customer.clientUuid,
    email: customer.clientEmail,
    enable: customer.status !== 'disabled' && action !== 'disable',
    expiryTime: expiryMs(customer.expireAt),
    totalGB: gbToBytes(customer.trafficLimitGb),
    limitIp: 0,
    flow: '',
    tgId: 0,
    subId: customer.clientId || customer.clientEmail,
    reset: 0
  };

  const clientDetail = await getXuiClientDetail(server, customer.clientEmail);
  const inboundIds = [...new Set([...clientDetail.inboundIds, inboundId])];
  const slimClient = {
    email: client.email,
    enable: client.enable,
    expiryTime: client.expiryTime,
    totalGB: client.totalGB,
    limitIp: client.limitIp,
    flow: client.flow,
    tgId: client.tgId,
    subId: client.subId,
    reset: client.reset
  };
  const payload = { client, inboundIds };
  const slimPayload = { client: slimClient, inboundIds };
  const updatePayload = { ...client, inboundIds };
  const email = encodeURIComponent(customer.clientEmail);
  const exists = Boolean(clientDetail.exists);

  const updateRoutes = [
    server.updateClientEndpoint ? { endpoint: server.updateClientEndpoint.replace('{clientId}', email).replace('{email}', email), body: updatePayload } : null,
    { endpoint: withApiPrefix(server, `/panel/api/clients/update/${email}`), body: updatePayload },
    { endpoint: withApiPrefix(server, `/panel/api/clients/update/${email}`), body: client }
  ];
  const addRoutes = [
    server.addClientEndpoint ? { endpoint: server.addClientEndpoint, body: payload } : null,
    { endpoint: withApiPrefix(server, '/panel/api/clients/add'), body: payload },
    server.addClientEndpoint ? { endpoint: server.addClientEndpoint, body: slimPayload } : null,
    { endpoint: withApiPrefix(server, '/panel/api/clients/add'), body: slimPayload }
  ];
  const paths = uniqueRoutes((exists ? updateRoutes : addRoutes).filter(Boolean));

  let lastError;
  const errors = [];
  for (const route of paths) {
    try {
      const result = await xuiRequest(server, route.endpoint, { method: 'POST', body: route.body });
      return { action: exists ? 'update' : 'add', endpoint: route.endpoint, inboundIds, clientEmail: customer.clientEmail, createdInbound, result: result.data };
    } catch (error) {
      lastError = error;
      errors.push(`${route.endpoint}: ${error.message}`);
    }
  }
  throw new Error(`同步用户到 3x-ui 失败，已尝试：${errors.join(' | ') || lastError?.message || '无详细错误'}`);
}

async function syncSocksToXui(db, customer) {
  const server = db.xuiServers.find((item) => item.id === customer.xuiServerId);
  if (!server) throw new Error('用户绑定的 3x-ui 节点不存在，请重新选择节点');
  const socks = db.socksNodes.find((item) => item.id === customer.socksNodeId);
  if (customer.useSocks && customer.socksNodeId && !socks) throw new Error('用户绑定的 SOCKS 节点不存在，请重新选择 SOCKS 出站');
  if (socks && socks.status === 'disabled') throw new Error('绑定的 SOCKS 节点已停用，请启用 SOCKS 节点或取消用户中转');

  const template = await readXrayTemplate(server);
  const config = template.config;
  config.outbounds = Array.isArray(config.outbounds) ? config.outbounds : [];
  config.routing = config.routing && typeof config.routing === 'object' ? config.routing : {};
  config.routing.rules = Array.isArray(config.routing.rules) ? config.routing.rules : [];

  const managedTags = new Set(db.socksNodes.map((item) => item.tag).filter(Boolean));
  const inbounds = await listXuiInbounds(server);
  const boundInbound = inbounds.items.find((item) => inboundIdOf(item) === Number(customer.inboundId));
  const inboundTag = inboundTagOf(boundInbound);
  const oldRuleCount = config.routing.rules.length;
  config.routing.rules = config.routing.rules.filter((rule) => !isManagedSocksRule(rule, customer.clientEmail, inboundTag, managedTags, {
    allowInboundTagFallback: Boolean(customer.useSocks || customer.socksNodeId)
  }));
  const removedRules = oldRuleCount - config.routing.rules.length;

  if (!customer.useSocks || !customer.socksNodeId || customer.status === 'disabled') {
    const saveResult = removedRules ? await saveXrayTemplate(server, config, template.outboundTestUrl) : { skipped: true };
    const restartResult = removedRules ? await restartXray(server) : { skipped: true };
    return { skipped: true, reason: customer.status === 'disabled' ? '用户已停用，已移除 SOCKS 路由' : '未启用 SOCKS 中转', removedRules, saveResult, restartResult };
  }

  const outbound = buildSocksOutbound(socks);
  const index = config.outbounds.findIndex((item) => item?.tag === socks.tag);
  if (index >= 0) config.outbounds[index] = outbound;
  else config.outbounds.push(outbound);

  const rule = {
    type: 'field',
    enabled: true,
    outboundTag: socks.tag,
    user: [customer.clientEmail]
  };
  if (inboundTag) rule.inboundTag = [inboundTag];
  config.routing.rules.unshift(rule);

  const saveResult = await saveXrayTemplate(server, config, template.outboundTestUrl);
  const restartResult = await restartXray(server);
  return { applied: true, outboundTag: socks.tag, inboundTag, rule, removedRules, saveResult, restartResult };
}

async function deleteXuiClient(server, email) {
  if (!email) return { skipped: true, reason: '没有 Client Email' };
  const encoded = encodeURIComponent(email);
  const routes = uniqueRoutes([
    { endpoint: withApiPrefix(server, `/panel/api/clients/del/${encoded}`), method: 'DELETE' },
    { endpoint: withApiPrefix(server, `/panel/api/clients/del/${encoded}`), method: 'POST' }
  ]);
  const errors = [];
  let missing = null;
  for (const route of routes) {
    try {
      const result = await xuiRequest(server, route.endpoint, { method: route.method });
      return { deleted: true, endpoint: route.endpoint, method: route.method, result: result.data };
    } catch (error) {
      if (/record not found|not found|404/i.test(error.message)) {
        missing = { deleted: false, missing: true, endpoint: route.endpoint, method: route.method };
        continue;
      }
      errors.push(`${route.method} ${route.endpoint}: ${error.message}`);
    }
  }
  if (missing && !errors.length) return missing;
  throw new Error(`删除 3-xui client 失败，已尝试：${errors.join(' | ') || '无详细错误'}`);
}

function clientStillInInbound(inbound, target) {
  return clientsFromInbound(inbound).some((item) => clientMatchesTarget(item.client, target));
}

function shouldTryInboundClientDelete(inbound, target) {
  const clients = clientsFromInbound(inbound || {});
  if (!clients.length) return false;
  return clients.some((item) => clientMatchesTarget(item.client, target)) || clients.length === 1;
}

function clientPreview(client) {
  if (!client || !Object.keys(client).length) return null;
  return {
    email: clientEmailOf(client),
    uuid: clientUuidOf(client),
    subId: clientSubIdOf(client)
  };
}

async function getXuiInboundById(server, inboundId) {
  const idValue = Number(inboundId);
  if (!Number.isInteger(idValue) || idValue <= 0) return null;
  try {
    const result = await xuiRequest(server, withApiPrefix(server, `/panel/api/inbounds/get/${idValue}`), { method: 'GET' });
    const object = xuiObject(result.data);
    return object && Object.keys(object).length ? object : null;
  } catch (error) {
    if (/record not found|not found|404/i.test(error.message)) return null;
    throw error;
  }
}

async function deleteInboundClientLegacy(server, target, inboundId) {
  const idValue = Number(inboundId);
  const email = String(target?.email || target?.clientEmail || '').trim();
  if (!email || !Number.isInteger(idValue) || idValue <= 0) return { skipped: true, reason: '缺少 Email 或 Inbound ID' };
  let inbound = await getXuiInboundById(server, idValue);
  if (!inbound) {
    const inbounds = await listXuiInboundsFull(server);
    inbound = inbounds.items.find((item) => inboundIdOf(item) === idValue);
  }
  const inboundClients = clientsFromInbound(inbound || {});
  let matchedBy = '字段匹配';
  let clientItem = inboundClients.find((item) => clientMatchesTarget(item.client, target));
  if (!clientItem && inboundClients.length === 1) {
    clientItem = inboundClients[0];
    matchedBy = '入站唯一客户端兜底';
  }
  const client = clientItem?.client || {};
  const actualTarget = clientItem ? { ...target, detailClient: client, email: clientEmailOf(client) || email } : target;
  const identifiers = clientIdentifierValues(client, [
    target.clientUuid,
    target.clientId,
    target.subId,
    email
  ]).filter((value) => !/^\d+$/.test(value) || String(client?.id || '').trim() === value);
  const routes = uniqueRoutes(identifiers.flatMap((identifier) => {
    const encoded = encodeURIComponent(identifier);
    return [
      { endpoint: withApiPrefix(server, `/panel/api/inbounds/${idValue}/delClient/${encoded}`), method: 'POST' },
      { endpoint: withApiPrefix(server, `/panel/api/inbounds/delClient/${idValue}/${encoded}`), method: 'POST' },
      { endpoint: withApiPrefix(server, `/panel/api/inbounds/${idValue}/client/${encoded}`), method: 'DELETE' },
      { endpoint: withApiPrefix(server, `/panel/api/clients/del/${encoded}`), method: 'POST' },
      { endpoint: withApiPrefix(server, `/panel/api/clients/del/${encoded}`), method: 'DELETE' }
    ];
  }));
  if (!routes.length) return { skipped: true, reason: '没有可用于删除的客户端标识', matchedBy, resolvedClient: clientPreview(client) };
  const errors = [];
  let missing = null;
  for (const route of routes) {
    try {
      const result = await xuiRequest(server, route.endpoint, { method: route.method });
      const refreshed = await getXuiInboundById(server, idValue);
      if (!refreshed || !clientStillInInbound(refreshed, actualTarget)) {
        return { deleted: true, legacy: true, endpoint: route.endpoint, method: route.method, identifier: route.endpoint.split('/').pop(), matchedBy, resolvedClient: clientPreview(client), result: result.data };
      }
      errors.push(`${route.method} ${route.endpoint}: 接口返回成功，但客户端仍在入站中`);
    } catch (error) {
      if (/record not found|not found|404/i.test(error.message)) {
        missing = { deleted: false, missing: true, endpoint: route.endpoint, method: route.method };
        continue;
      }
      errors.push(`${route.method} ${route.endpoint}: ${error.message}`);
    }
  }
  if (missing && !errors.length) return { ...missing, matchedBy, resolvedClient: clientPreview(client) };
  throw new Error(`旧版入站客户端删除失败，已尝试：${errors.join(' | ') || '无详细错误'}`);
}

async function detachXuiClient(server, customer) {
  const email = String(customer?.clientEmail || customer?.email || '').trim();
  if (!email) return { skipped: true, reason: '没有 Client Email' };
  const inboundIds = [Number(customer?.inboundId)].filter((value) => Number.isInteger(value) && value > 0);
  if (!inboundIds.length) return deleteXuiClient(server, email);
  const detail = await getXuiClientDetail(server, email);
  const target = {
    email,
    clientEmail: email,
    clientId: customer?.clientId,
    clientUuid: customer?.clientUuid,
    detailClient: detail.client
  };
  const attachedInboundIds = detail.inboundIds.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0);
  if (!detail.exists || !attachedInboundIds.length || attachedInboundIds.every((value) => inboundIds.includes(value))) {
    const clientResult = await deleteXuiClient(server, email);
    const inbound = await getXuiInboundById(server, inboundIds[0]);
    if (!inbound || !shouldTryInboundClientDelete(inbound, target)) return clientResult;
    const legacyResult = await deleteInboundClientLegacy(server, target, inboundIds[0]);
    return { ...clientResult, verified: false, fallback: legacyResult };
  }
  const encoded = encodeURIComponent(email);
  const routes = uniqueRoutes([
    { endpoint: withApiPrefix(server, `/panel/api/clients/${encoded}/detach`), body: { inboundIds } },
    { endpoint: withApiPrefix(server, `/panel/api/clients/${encoded}/detach`), body: { inbound_ids: inboundIds } }
  ]);
  const errors = [];
  let missing = null;
  for (const route of routes) {
    try {
      const result = await xuiRequest(server, route.endpoint, { method: 'POST', body: route.body });
      const inbound = await getXuiInboundById(server, inboundIds[0]);
      if (!inbound || !shouldTryInboundClientDelete(inbound, target)) return { detached: true, endpoint: route.endpoint, inboundIds, result: result.data };
      const legacyResult = await deleteInboundClientLegacy(server, target, inboundIds[0]);
      return { detached: true, verified: false, endpoint: route.endpoint, inboundIds, result: result.data, fallback: legacyResult };
    } catch (error) {
      if (/record not found|not found|404/i.test(error.message)) {
        missing = { detached: false, missing: true, endpoint: route.endpoint, inboundIds };
        continue;
      }
      errors.push(`${route.endpoint}: ${error.message}`);
    }
  }
  if (missing && !errors.length) {
    const inbound = await getXuiInboundById(server, inboundIds[0]);
    if (inbound && shouldTryInboundClientDelete(inbound, target)) {
      const legacyResult = await deleteInboundClientLegacy(server, target, inboundIds[0]);
      return { ...missing, verified: false, fallback: legacyResult };
    }
    return missing;
  }
  throw new Error(`解绑 3-xui client 入站失败，已尝试：${errors.join(' | ') || '无详细错误'}`);
}

async function deleteXuiInbound(server, inboundId) {
  const idValue = Number(inboundId);
  if (!Number.isInteger(idValue) || idValue <= 0) return { skipped: true, reason: '没有有效 Inbound ID' };
  const routes = uniqueRoutes([
    { endpoint: withApiPrefix(server, `/panel/api/inbounds/del/${idValue}`), method: 'POST' },
    { endpoint: withApiPrefix(server, `/panel/api/inbounds/del/${idValue}`), method: 'DELETE' }
  ]);
  const errors = [];
  let missing = null;
  for (const route of routes) {
    try {
      const result = await xuiRequest(server, route.endpoint, { method: route.method });
      return { deleted: true, endpoint: route.endpoint, method: route.method, result: result.data };
    } catch (error) {
      if (/record not found|not found|404/i.test(error.message)) {
        missing = { deleted: false, missing: true, endpoint: route.endpoint, method: route.method };
        continue;
      }
      errors.push(`${route.method} ${route.endpoint}: ${error.message}`);
    }
  }
  if (missing && !errors.length) return missing;
  throw new Error(`删除 3-xui 入站失败，已尝试：${errors.join(' | ') || '无详细错误'}`);
}

async function deleteInboundIfEmpty(server, inboundId) {
  const idValue = Number(inboundId);
  if (!Number.isInteger(idValue) || idValue <= 0) return { skipped: true, reason: '没有有效 Inbound ID' };
  const inbounds = await listXuiInboundsFull(server);
  const inbound = inbounds.items.find((item) => inboundIdOf(item) === idValue);
  if (!inbound) return { skipped: true, missing: true, reason: '入站已经不存在' };
  const clients = clientsFromInbound(inbound);
  if (clients.length) return { skipped: true, reason: `入站仍有 ${clients.length} 个客户端，未删除入站` };
  return deleteXuiInbound(server, idValue);
}

function outboundTagStillUsed(db, customer, config, socks) {
  if (!socks?.tag) return true;
  const usedByRules = Array.isArray(config.routing?.rules) && config.routing.rules.some((rule) => rule?.outboundTag === socks.tag);
  if (usedByRules) return true;
  return db.customers.some((item) => item.id !== customer.id && item.useSocks && item.socksNodeId === socks.id && item.status !== 'disabled');
}

async function cleanupCustomerSocksFromXui(db, customer, server) {
  if (!customer.useSocks && !customer.socksNodeId) return { skipped: true, reason: '用户没有启用 SOCKS 中转' };
  const socks = db.socksNodes.find((item) => item.id === customer.socksNodeId);
  const managedTags = new Set(db.socksNodes.map((item) => item.tag).filter(Boolean));
  if (!managedTags.size) return { skipped: true, reason: '没有可管理的 SOCKS 出站' };

  const template = await readXrayTemplate(server);
  const config = template.config;
  config.outbounds = Array.isArray(config.outbounds) ? config.outbounds : [];
  config.routing = config.routing && typeof config.routing === 'object' ? config.routing : {};
  config.routing.rules = Array.isArray(config.routing.rules) ? config.routing.rules : [];

  let inboundTag = '';
  try {
    const inbounds = await listXuiInbounds(server);
    const boundInbound = inbounds.items.find((item) => inboundIdOf(item) === Number(customer.inboundId));
    inboundTag = inboundTagOf(boundInbound);
  } catch {
    inboundTag = '';
  }

  const oldRuleCount = config.routing.rules.length;
  config.routing.rules = config.routing.rules.filter((rule) => !isManagedSocksRule(rule, customer.clientEmail, inboundTag, managedTags, {
    allowInboundTagFallback: Boolean(customer.useSocks || customer.socksNodeId)
  }));
  const removedRules = oldRuleCount - config.routing.rules.length;
  let removedOutbounds = 0;
  if (socks?.tag && !outboundTagStillUsed(db, customer, config, socks)) {
    const oldOutboundCount = config.outbounds.length;
    config.outbounds = config.outbounds.filter((outbound) => outbound?.tag !== socks.tag);
    removedOutbounds = oldOutboundCount - config.outbounds.length;
  }

  if (!removedRules && !removedOutbounds) return { skipped: true, removedRules, removedOutbounds };
  const saveResult = await saveXrayTemplate(server, config, template.outboundTestUrl);
  const restartResult = await restartXray(server);
  return { removedRules, removedOutbounds, inboundTag, outboundTag: socks?.tag || '', saveResult, restartResult };
}

async function cleanupCustomerRemoteResources(db, customer) {
  if (!customer?.xuiServerId) return { skipped: true, reason: '用户没有绑定 3x-ui 节点', warnings: [] };
  const server = db.xuiServers.find((item) => item.id === customer.xuiServerId);
  if (!server) return { skipped: true, reason: '用户绑定的 3x-ui 节点不存在，已跳过远程清理', warnings: ['用户绑定的 3x-ui 节点不存在'] };

  const warnings = [];
  let socksResult = { skipped: true };
  let clientResult = { skipped: true };
  let inboundResult = { skipped: true };

  try {
    socksResult = await cleanupCustomerSocksFromXui(db, customer, server);
  } catch (error) {
    socksResult = { failed: true, error: error.message };
    warnings.push(`SOCKS 路由清理失败：${error.message}`);
  }

  try {
    clientResult = await detachXuiClient(server, customer);
  } catch (error) {
    clientResult = { failed: true, error: error.message };
    warnings.push(`3-xui 客户端删除/解绑失败：${error.message}`);
  }

  try {
    inboundResult = await deleteInboundIfEmpty(server, customer.inboundId);
  } catch (error) {
    inboundResult = { failed: true, error: error.message };
    warnings.push(`3-xui 空入站删除失败：${error.message}`);
  }

  return { clientResult, socksResult, inboundResult, warnings };
}

function buildSocksOutbound(socks) {
  return {
    tag: socks.tag,
    protocol: 'socks',
    settings: {
      servers: [
        {
          address: socks.address,
          port: Number(socks.port),
          users: socks.username ? [{ user: socks.username, pass: decrypt(socks.passwordEnc) }] : []
        }
      ]
    }
  };
}

function isManagedSocksRule(rule, email, inboundTag, managedTags, options = {}) {
  if (!rule || !managedTags.has(rule.outboundTag)) return false;
  const users = Array.isArray(rule.user) ? rule.user : [];
  const inboundTags = Array.isArray(rule.inboundTag) ? rule.inboundTag : [];
  return users.includes(email) || Boolean(options.allowInboundTagFallback && inboundTag && inboundTags.includes(inboundTag));
}

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

function extractXrayConfig(data) {
  const root = xuiObject(data);
  const obj = parseMaybeJson(data?.obj) || data?.obj;
  const body = parseMaybeJson(data?.data) || data?.data;
  const result = parseMaybeJson(data?.result) || data?.result;
  const values = [
    root,
    root.xrayConfig,
    root.xrayTemplateConfig,
    root.xrayTemplate,
    root.jsonConfig,
    root.config,
    root.template,
    root.xraySetting,
    root.xraySetting?.xrayConfig,
    root.xraySetting?.xrayTemplateConfig,
    root.xraySetting?.xrayTemplate,
    root.xraySetting?.jsonConfig,
    root.xraySetting?.config,
    root.setting,
    root.setting?.xrayConfig,
    root.setting?.xrayTemplateConfig,
    root.setting?.xrayTemplate,
    root.setting?.jsonConfig,
    root.setting?.config,
    obj?.xraySetting,
    obj?.setting,
    obj?.xrayConfig,
    obj?.xrayTemplateConfig,
    obj?.xrayTemplate,
    obj?.jsonConfig,
    obj?.config,
    obj?.template,
    obj?.xraySetting?.xrayConfig,
    obj?.xraySetting?.xrayTemplateConfig,
    obj?.xraySetting?.xrayTemplate,
    obj?.xraySetting?.jsonConfig,
    obj?.xraySetting?.config,
    body?.xraySetting,
    body?.setting,
    body?.xrayConfig,
    body?.xrayTemplateConfig,
    body?.config,
    result?.xraySetting,
    result?.setting,
    result?.xrayConfig,
    result?.xrayTemplateConfig,
    result?.config
  ];
  for (const value of values) {
    const parsed = parseMaybeJson(value);
    if (parsed && typeof parsed === 'object' && (Array.isArray(parsed.outbounds) || parsed.routing || parsed.inbounds)) return parsed;
  }
  throw new Error('没有从 3-xui 读取到 Xray 配置模板，无法写入 SOCKS 路由');
}

function extractOutboundTestUrl(data) {
  const root = xuiObject(data);
  const obj = parseMaybeJson(data?.obj) || data?.obj;
  return root.outboundTestUrl || root.xrayTestUrl || root.xraySetting?.outboundTestUrl || root.xraySetting?.xrayTestUrl || root.setting?.outboundTestUrl || root.setting?.xrayTestUrl || obj?.outboundTestUrl || obj?.xrayTestUrl || obj?.xraySetting?.outboundTestUrl || obj?.xraySetting?.xrayTestUrl || '';
}

async function readXrayTemplate(server) {
  const result = await xuiRequest(server, withApiPrefix(server, '/panel/api/xray/'), { method: 'POST' });
  return { config: extractXrayConfig(result.data), outboundTestUrl: extractOutboundTestUrl(result.data), raw: result.data };
}

async function xuiFormRequest(server, endpoint, fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) body.set(key, String(value));
  }
  return xuiRequest(server, endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: body.toString()
  });
}

async function saveXrayTemplate(server, config, outboundTestUrl = '') {
  const endpoint = withApiPrefix(server, '/panel/api/xray/update');
  const text = JSON.stringify(config, null, 2);
  const urlFields = outboundTestUrl ? [{ xrayTestUrl: outboundTestUrl }, { outboundTestUrl }] : [{}];
  const configFields = ['xrayTemplateConfig', 'xraySetting', 'xrayConfig', 'jsonConfig', 'config'];
  const attempts = [
    ...urlFields.flatMap((urlField) => configFields.map((field) => ({ [field]: text, ...urlField })))
  ];
  const errors = [];
  for (const fields of attempts) {
    try {
      const result = await xuiFormRequest(server, endpoint, fields);
      return { endpoint, field: Object.keys(fields)[0], result: result.data };
    } catch (error) {
      errors.push(`${Object.keys(fields)[0]}: ${error.message}`);
    }
  }
  throw new Error(`保存 Xray 配置模板失败，已尝试：${errors.join(' | ')}`);
}

async function restartXray(server) {
  try {
    const result = await xuiRequest(server, withApiPrefix(server, '/panel/api/server/restartXrayService'), { method: 'POST' });
    return { endpoint: withApiPrefix(server, '/panel/api/server/restartXrayService'), result: result.data };
  } catch (error) {
    return { warning: `Xray 配置已保存，但重载失败：${error.message}` };
  }
}

function objectKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
}

function xrayTemplateDebug(data) {
  let recognized = false;
  let message = '';
  try {
    const config = extractXrayConfig(data);
    recognized = true;
    message = `已识别，outbounds: ${Array.isArray(config.outbounds) ? config.outbounds.length : 0}`;
  } catch (error) {
    message = error.message;
  }
  const root = xuiObject(data);
  const obj = parseMaybeJson(data?.obj) || data?.obj;
  return {
    recognized,
    message,
    topKeys: objectKeys(data),
    rootKeys: objectKeys(root),
    objKeys: objectKeys(obj),
    xraySettingKeys: objectKeys(root.xraySetting || obj?.xraySetting),
    settingKeys: objectKeys(root.setting || obj?.setting)
  };
}

function addLog(db, customerId, type, status, message, detail = {}) {
  db.syncLogs.push({
    id: id('log'),
    customerId,
    type,
    status,
    message,
    detail,
    createdAt: nowIso()
  });
  if (db.syncLogs.length > 1000) db.syncLogs = db.syncLogs.slice(-1000);
}

async function routeApi(req, res, url) {
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const db = await readDb();
    if (tooManyLoginAttempts(req)) {
      return sendError(res, 429, '登录失败次数过多，请 10 分钟后再试');
    }
    const body = await parseJson(req);
    if (!verifyAdmin(db, body.username, body.password)) {
      recordLoginAttempt(req, false);
      return sendError(res, 401, 'Invalid username or password');
    }
    recordLoginAttempt(req, true);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { username: adminUsername(db), expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
    res.writeHead(200, securityHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': sessionCookie(req, token)
    }));
    return res.end(JSON.stringify({ ok: true, username: adminUsername(db) }));
  }

  if (url.pathname === '/api/logout' && req.method === 'POST') {
    const token = getCookie(req, 'xcp_session');
    if (token) sessions.delete(token);
    res.writeHead(200, securityHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': sessionCookie(req, '', { maxAge: 0 })
    }));
    return res.end(JSON.stringify({ ok: true }));
  }

  const session = requireAuth(req, res);
  if (!session) return;

  const db = await readDb();

  if (url.pathname === '/api/bootstrap' && req.method === 'GET') {
    return send(res, 200, { ok: true, data: publicDb(db), user: session.username });
  }

  if (url.pathname === '/api/change-password' && req.method === 'POST') {
    const body = await parseJson(req);
    const username = String(body.username || session.username || '').trim();
    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '');
    if (!verifyAdmin(db, session.username, currentPassword)) {
      return sendError(res, 400, '当前密码不正确');
    }
    if (!username) return sendError(res, 400, '请填写管理员账号');
    if (newPassword.length < 8) return sendError(res, 400, '新密码至少需要 8 位');
    db.settings ||= { currency: 'CNY', expiryWarningDays: 3 };
    db.settings.admin = {
      username,
      passwordHash: hashPassword(newPassword),
      updatedAt: nowIso()
    };
    await writeDb(db);
    sessions.delete(getCookie(req, 'xcp_session'));
    res.writeHead(200, securityHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': sessionCookie(req, '', { maxAge: 0 })
    }));
    return res.end(JSON.stringify({ ok: true, message: '密码已修改，请重新登录' }));
  }

  if (url.pathname === '/api/xui-servers' && req.method === 'POST') {
    const body = await parseJson(req);
    const server = normalizeServer(body);
    if (!server.name || !server.host) return sendError(res, 400, '请填写节点名称和地址');
    db.xuiServers.push(server);
    await writeDb(db);
    return send(res, 200, { ok: true, data: publicDb(db) });
  }

  const serverMatch = url.pathname.match(/^\/api\/xui-servers\/([^/]+)$/);
  if (serverMatch && req.method === 'PUT') {
    const body = await parseJson(req);
    const index = db.xuiServers.findIndex((item) => item.id === serverMatch[1]);
    if (index < 0) return sendError(res, 404, '3x-ui 节点不存在');
    db.xuiServers[index] = normalizeServer(body, db.xuiServers[index]);
    await writeDb(db);
    return send(res, 200, { ok: true, data: publicDb(db) });
  }
  if (serverMatch && req.method === 'DELETE') {
    db.xuiServers = db.xuiServers.filter((item) => item.id !== serverMatch[1]);
    await writeDb(db);
    return send(res, 200, { ok: true, data: publicDb(db) });
  }

  const importServerMatch = url.pathname.match(/^\/api\/xui-servers\/([^/]+)\/import-customers$/);
  if (importServerMatch && req.method === 'POST') {
    try {
      const detail = await importCustomersFromXui(db, importServerMatch[1]);
      await writeDb(db);
      return send(res, 200, { ok: true, data: publicDb(db), detail });
    } catch (error) {
      addLog(db, importServerMatch[1], 'import', 'failed', error.message);
      await writeDb(db);
      return sendError(res, error.statusCode || 500, '同步 3-xui 用户失败', error.message);
    }
  }

  if (url.pathname === '/api/socks-nodes' && req.method === 'POST') {
    const body = await parseJson(req);
    const node = normalizeSocks(body);
    if (!node.name || !node.address) return sendError(res, 400, '请填写 SOCKS 名称和地址');
    db.socksNodes.push(node);
    await writeDb(db);
    return send(res, 200, { ok: true, data: publicDb(db) });
  }

  const socksMatch = url.pathname.match(/^\/api\/socks-nodes\/([^/]+)$/);
  if (socksMatch && req.method === 'PUT') {
    const body = await parseJson(req);
    const index = db.socksNodes.findIndex((item) => item.id === socksMatch[1]);
    if (index < 0) return sendError(res, 404, 'SOCKS 节点不存在');
    db.socksNodes[index] = normalizeSocks(body, db.socksNodes[index]);
    await writeDb(db);
    return send(res, 200, { ok: true, data: publicDb(db) });
  }
  if (socksMatch && req.method === 'DELETE') {
    db.socksNodes = db.socksNodes.filter((item) => item.id !== socksMatch[1]);
    await writeDb(db);
    return send(res, 200, { ok: true, data: publicDb(db) });
  }

  if (url.pathname === '/api/customers' && req.method === 'POST') {
    const body = await parseJson(req);
    const customer = normalizeCustomer(body);
    if (!customer.name) return sendError(res, 400, '请填写用户名称');
    db.customers.push(customer);
    addLog(db, customer.id, 'customer', 'success', '用户已创建');
    await writeDb(db);
    return send(res, 200, { ok: true, data: publicDb(db) });
  }

  const customerMatch = url.pathname.match(/^\/api\/customers\/([^/]+)$/);
  if (customerMatch && req.method === 'PUT') {
    const body = await parseJson(req);
    const index = db.customers.findIndex((item) => item.id === customerMatch[1]);
    if (index < 0) return sendError(res, 404, '用户不存在');
    db.customers[index] = normalizeCustomer(body, db.customers[index]);
    addLog(db, db.customers[index].id, 'customer', 'success', '用户已更新');
    await writeDb(db);
    return send(res, 200, { ok: true, data: publicDb(db) });
  }
  if (customerMatch && req.method === 'DELETE') {
    const customer = db.customers.find((item) => item.id === customerMatch[1]);
    if (!customer) return sendError(res, 404, '用户不存在');
    const cleanup = await cleanupCustomerRemoteResources(db, customer);
    db.customers = db.customers.filter((item) => item.id !== customerMatch[1]);
    const hasWarnings = Array.isArray(cleanup.warnings) && cleanup.warnings.length > 0;
    addLog(db, customer.id, 'delete', hasWarnings ? 'warning' : 'success', hasWarnings ? '本地用户已删除，远程清理存在警告' : '用户已删除，并已同步清理 3-xui 资源', cleanup);
    await writeDb(db);
    return send(res, 200, { ok: true, data: publicDb(db), detail: cleanup, warning: hasWarnings ? cleanup.warnings.join('；') : '' });
  }

  const renewMatch = url.pathname.match(/^\/api\/customers\/([^/]+)\/renew$/);
  if (renewMatch && req.method === 'POST') {
    const body = await parseJson(req);
    const customer = db.customers.find((item) => item.id === renewMatch[1]);
    if (!customer) return sendError(res, 404, '用户不存在');
    const oldExpireAt = customer.expireAt;
    customer.expireAt = addMonths(customer.expireAt, Number(body.months || 1));
    customer.status = 'active';
    customer.amount = Number(body.amount ?? customer.amount ?? 0);
    customer.updatedAt = nowIso();
    addLog(db, customer.id, 'renew', 'success', `已续费 ${Number(body.months || 1)} 个月`, { oldExpireAt, newExpireAt: customer.expireAt, amount: customer.amount });
    await writeDb(db);
    return send(res, 200, { ok: true, data: publicDb(db) });
  }

  const toggleMatch = url.pathname.match(/^\/api\/customers\/([^/]+)\/toggle$/);
  if (toggleMatch && req.method === 'POST') {
    const customer = db.customers.find((item) => item.id === toggleMatch[1]);
    if (!customer) return sendError(res, 404, '用户不存在');
    customer.status = customer.status === 'disabled' ? 'active' : 'disabled';
    customer.updatedAt = nowIso();
    addLog(db, customer.id, 'status', 'success', customer.status === 'disabled' ? '用户已停用' : '用户已启用');
    await writeDb(db);
    return send(res, 200, { ok: true, data: publicDb(db) });
  }

  const syncMatch = url.pathname.match(/^\/api\/customers\/([^/]+)\/sync$/);
  if (syncMatch && req.method === 'POST') {
    const customer = db.customers.find((item) => item.id === syncMatch[1]);
    if (!customer) return sendError(res, 404, '用户不存在');
    try {
      const clientResult = await syncClientToXui(db, customer, customer.status === 'disabled' ? 'disable' : 'upsert');
      const socksResult = await syncSocksToXui(db, customer);
      addLog(db, customer.id, 'sync', 'success', '已同步到 3x-ui', { clientResult, socksResult });
      await writeDb(db);
      return send(res, 200, { ok: true, data: publicDb(db), detail: { clientResult, socksResult } });
    } catch (error) {
      addLog(db, customer.id, 'sync', 'failed', error.message);
      await writeDb(db);
      return sendError(res, error.statusCode || 500, '同步失败', error.message);
    }
  }

  if (url.pathname === '/api/maintenance/disable-expired' && req.method === 'POST') {
    let count = 0;
    for (const customer of db.customers) {
      if (customer.status !== 'disabled' && customer.expireAt && new Date(customer.expireAt) < new Date()) {
        customer.status = 'disabled';
        customer.updatedAt = nowIso();
        addLog(db, customer.id, 'status', 'success', '过期用户已自动停用');
        count += 1;
      }
    }
    await writeDb(db);
    return send(res, 200, { ok: true, count, data: publicDb(db) });
  }

  if (url.pathname === '/api/test-xui' && req.method === 'POST') {
    const body = await parseJson(req);
    const existing = body.id ? db.xuiServers.find((item) => item.id === body.id) : {};
    const server = normalizeServer(body, existing || {});
    try {
      const inbounds = await listXuiInbounds(server);
      const ids = inbounds.items.map(inboundLabel).join(', ');
      const message = ids
        ? `3x-ui 节点连接成功，可用 Inbound ID：${ids}`
        : `3x-ui 节点连接成功，但没有读取到入站。请先在 3x-ui 创建入站。接口：${inbounds.endpoint}`;
      return send(res, 200, { ok: true, message, endpoint: inbounds.endpoint, inbounds: inbounds.items, detail: inbounds.raw });
    } catch (error) {
      return sendError(res, error.statusCode || 500, '连接失败', error.message);
    }
  }

  const debugXrayMatch = url.pathname.match(/^\/api\/debug-xray-template\/([^/]+)$/);
  if (debugXrayMatch && req.method === 'GET') {
    const server = db.xuiServers.find((item) => item.id === debugXrayMatch[1]);
    if (!server) return sendError(res, 404, '3x-ui 节点不存在');
    try {
      const result = await xuiRequest(server, withApiPrefix(server, '/panel/api/xray/'), { method: 'POST' });
      return send(res, 200, { ok: true, data: xrayTemplateDebug(result.data) });
    } catch (error) {
      return sendError(res, error.statusCode || 500, '读取 Xray 模板失败', error.message);
    }
  }

  sendError(res, 404, 'API 不存在');
}

async function serveStatic(req, res, url) {
  let requestPath;
  try {
    requestPath = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
    return res.end('Bad request');
  }
  const filePath = requestPath === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, requestPath);
  const normalized = path.resolve(filePath);
  const relative = path.relative(PUBLIC_DIR, normalized);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
    return res.end('Forbidden');
  }
  try {
    const data = await fs.readFile(normalized);
    const ext = path.extname(normalized).toLowerCase();
    const type = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png'
    }[ext] || 'application/octet-stream';
    res.writeHead(200, securityHeaders({ 'Content-Type': type, 'Cache-Control': 'no-store' }));
    res.end(data);
  } catch {
    res.writeHead(404, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await routeApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    return sendError(res, error.statusCode || 500, '服务器错误', error.message);
  }
});

server.listen(PORT, () => {
  console.log(`十夜管理系统 listening on http://127.0.0.1:${PORT}`);
  console.log('默认账号 admin / admin123，公网部署建议在账号安全里修改密码。');
});
