const __WS__=(()=>{const module={exports:{}};
// Minimal zero-dependency WebSocket client (RFC 6455), enough for Stream Dock's local JSON messages.
// Text frames only, client frames masked, handles ping/pong, close and fragmented messages.
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

class WS extends EventEmitter {
  constructor(url) {
    super();
    this.OPEN = 1;
    this.readyState = 0;
    const u = new URL(url);
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.upgraded = false;
    const key = crypto.randomBytes(16).toString('base64');
    this.expectAccept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    this.sock = net.connect(Number(u.port) || 80, u.hostname, () => {
      this.sock.write(`GET ${u.pathname || '/'}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    this.sock.on('data', (d) => this._data(d));
    this.sock.on('close', () => { this.readyState = 3; this.emit('close'); });
    this.sock.on('error', () => { try { this.sock.destroy(); } catch {} });
  }
  _data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > WS.MAX_FRAME + 16) { this.sock.destroy(); return; }
    if (!this.upgraded) {
      const end = this.buf.indexOf('\r\n\r\n');
      if (end < 0) { if (this.buf.length > 16384) this.sock.destroy(); return; }
      const head = this.buf.slice(0, end).toString();
      const accept = (head.match(/^sec-websocket-accept:\s*(\S+)/im) || [])[1];
      if (!/^HTTP\/1\.1 101/.test(head) || accept !== this.expectAccept) { this.sock.destroy(); return; }
      this.upgraded = true;
      this.readyState = 1;
      this.buf = this.buf.slice(end + 4);
      this.emit('open');
    }
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      const masked = (b[1] & 0x80) !== 0;
      if (len > WS.MAX_FRAME) { this.sock.destroy(); return; }
      if (masked) off += 4;
      if (b.length < off + len) return;
      let payload = b.slice(off, off + len);
      if (masked) { const m = b.slice(off - 4, off); payload = Buffer.from(payload.map((v, i) => v ^ m[i % 4])); }
      this.buf = b.slice(off + len);
      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { this._frame(0xA, payload); continue; }
      if (op === 0xA) continue;
      this.frag.push(payload);
      this.fragSize = (this.fragSize || 0) + payload.length;
      if (this.fragSize > WS.MAX_FRAME) { this.sock.destroy(); return; }
      if (fin) {
        const msg = Buffer.concat(this.frag); this.frag = []; this.fragSize = 0;
        try { this.emit('message', msg); } catch (e) { process.emitWarning('message handler failed: ' + (e && e.message)); }
      }
    }
  }
  _frame(op, payload) {
    const mask = crypto.randomBytes(4);
    let head;
    if (payload.length < 126) head = Buffer.from([0x80 | op, 0x80 | payload.length]);
    else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
    const body = Buffer.from(payload.map((v, i) => v ^ mask[i % 4]));
    this.sock.write(Buffer.concat([head, mask, body]));
  }
  send(text) { if (this.readyState === 1) this._frame(0x1, Buffer.from(text)); }
  close() { if (this.readyState === 1) { try { this._frame(0x8, Buffer.alloc(0)); } catch {} } this.readyState = 2; this.sock.end(); }
  on(ev, fn) { return super.on(ev, fn); }
}
WS.OPEN = 1;
WS.MAX_FRAME = 16 * 1024 * 1024;
module.exports = WS;

return module.exports;})();
// Winged Keys - Stream Dock plugin. Not made by or affiliated with Nous Research.
// Talks only to the Hermes API server and the Hermes dashboard. The API key comes from the app's global settings and is never logged.
const WebSocket = __WS__;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

// ---- registration arguments from Stream Dock: -port -pluginUUID -registerEvent -info
const args = {};
for (let i = 2; i + 1 < process.argv.length; i += 2) args[process.argv[i].replace(/^-+/, '')] = process.argv[i + 1];

const DEFAULTS = { webuiUrl: 'http://127.0.0.1:8787', baseUrl: 'http://127.0.0.1:8642', apiKey: '', allowRemote: false, replyDir: '', dashboardUrl: 'http://127.0.0.1:9119', hermesExe: '', autoStartDashboard: true };
let global = { ...DEFAULTS };
const ctx = new Map();      // context -> { action, settings }
const runs = new Map();     // context -> { runId }
const POLL_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATUS_MS = 30000;

function dlog(t) {
  try {
    const d = path.join(os.homedir(), 'WingedKeys'); fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, 'plugin.log');
    try { if (fs.statSync(f).size > 1024 * 1024) fs.renameSync(f, f + '.1'); } catch {}
    fs.appendFileSync(f, new Date().toISOString() + ' ' + String(t).slice(0, 500) + '\n');
  } catch {}
}
const pending = new Map(); // context -> resolve, waiting for fresh settings
const ws = new WebSocket('ws://127.0.0.1:' + args.port);
const send = (o) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
ws.on('open', () => {
  send({ uuid: args.pluginUUID, event: args.registerEvent });
  send({ event: 'getGlobalSettings', context: args.pluginUUID });
});
ws.on('close', () => process.exit(0));
ws.on('message', (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  const kind = (m.action || '').split('.').pop();
  dlog('event ' + m.event + ' ' + kind + ' settingsKeys=' + Object.keys((m.payload && m.payload.settings) || {}).join(','));
  switch (m.event) {
    case 'didReceiveGlobalSettings':
      global = { ...DEFAULTS, ...(m.payload && m.payload.settings) };
      refreshAllStatus();
      refreshAllUsage();
      break;
    case 'willAppear':
      // controller: "Keypad" (keys), "Knob"/"Information" (Stream Dock dials and strip), "Encoder" (Elgato Stream Deck+ dials)
      ctx.set(m.context, { action: kind, settings: (m.payload && m.payload.settings) || {}, controller: (m.payload && m.payload.controller) || 'Keypad' });
      initKey(m.context);
      break;
    case 'willDisappear':
      ctx.delete(m.context);
      break;
    case 'didReceiveSettings':
      if (ctx.has(m.context)) ctx.get(m.context).settings = (m.payload && m.payload.settings) || {};
      if (pending.has(m.context)) { pending.get(m.context)(); pending.delete(m.context); }
      initKey(m.context);
      break;
    case 'keyDown':
    case 'dialDown':   // pressing a knob does what pressing a key does
    case 'touchTap':   // Elgato Stream Deck+ touch strip
      onKey(m.context, kind);
      break;
    case 'dialRotate':
      onRotate(m.context, kind, Number(m.payload && m.payload.ticks) || 0);
      break;
    case 'sendToPlugin':
      onSetupCommand(m).catch(() => {});
      break;
  }
});

// ---- key display
const COLORS = { green: '#2ecc71', amber: '#f5a623', red: '#e74c3c', grey: '#7f8c8d', blue: '#3498db' };
function dot(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" rx="16" fill="#1c1c1e"/><circle cx="72" cy="60" r="34" fill="${color}"/></svg>`;
  return 'data:image/svg+xml;charset=utf8,' + encodeURIComponent(svg);
}
function isEncoder(context) { const c = ctx.get(context); return !!c && c.controller === 'Encoder'; }
// Elgato dials have their own display (layout $A1: title + value); keys and Stream Dock knobs use image + title.
function feedback(context, title, value, color) {
  send({ event: 'setFeedback', context, payload: { title: String(title).replace(/\n/g, ' '), value: { value: String(value), color } } });
}
function show(context, color, title) {
  if (isEncoder(context)) { const parts = String(title).split('\n'); return feedback(context, parts.length > 1 ? parts[0] : label(context), parts[parts.length - 1], color); }
  send({ event: 'setImage', context, payload: { target: 0, image: dot(color) } });
  send({ event: 'setTitle', context, payload: { target: 0, title } });
}
function label(context) {
  const c = ctx.get(context); if (!c) return '';
  return c.settings.label || ({ status: 'Hermes', ask: 'Ask', stop: 'Stop', open: 'Open', platforms: 'Platforms' })[c.action] || '';
}
function initKey(context) {
  const c = ctx.get(context); if (!c) return;
  if (c.action === 'status') refreshStatus(context);
  else if (c.action === 'usage') refreshUsage(context);
  else if (c.action === 'platforms') refreshPlatforms(context);
  else if (c.action === 'open') show(context, COLORS.grey, label(context));
  else if (c.action === 'ask') show(context, runs.has(context) ? COLORS.blue : COLORS.grey, runs.has(context) ? 'working' : label(context));
  else show(context, COLORS.red, label(context));
}

// ---- Hermes API
function baseUrl() { return String(global.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, ''); }
function isLocal(u) { try { const h = new URL(u).hostname; return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'; } catch { return false; } }
// Every request goes through safeFetch: local hosts only (or https when the user allows remote),
// redirects are refused (so a local service can't bounce requests elsewhere), and the timeout and a
// size cap cover the whole response body.
const MAX_BODY = 2 * 1024 * 1024;
function checkTarget(u) {
  if (isLocal(u)) return;
  let proto = '';
  try { proto = new URL(u).protocol; } catch {}
  if (!global.allowRemote || proto !== 'https:') throw Object.assign(new Error('remote blocked'), { code: 'REMOTE' });
}
async function safeFetch(url, { method = 'GET', headers = {}, body, timeoutMs = 8000 } = {}) {
  checkTarget(url);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: ac.signal, redirect: 'error' });
    let size = 0; const chunks = [];
    if (res.body) for await (const chunk of res.body) { size += chunk.length; if (size > MAX_BODY) { ac.abort(); throw new Error('response too large'); } chunks.push(Buffer.from(chunk)); }
    return { status: res.status, ok: res.ok, text: Buffer.concat(chunks).toString('utf8') };
  } finally { clearTimeout(t); }
}
function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }
async function api(pathname, { method = 'GET', body, auth = true, timeoutMs = 8000 } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (auth && global.apiKey) headers.Authorization = 'Bearer ' + global.apiKey;
  const r = await safeFetch(baseUrl() + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined, timeoutMs });
  return { status: r.status, ok: r.ok, json: parseJson(r.text) };
}

// ---- Status
async function refreshStatus(context) {
  try {
    const h = await api('/health', { auth: false });
    if (!h.ok) return show(context, COLORS.red, 'Hermes\nerror ' + h.status);
    if (!global.apiKey) return show(context, COLORS.amber, 'Hermes\nno key');
    const m = await api('/v1/models');
    if (m.status === 401 || m.status === 403) return show(context, COLORS.amber, 'Hermes\nbad key');
    return show(context, COLORS.green, 'Hermes\nOK');
  } catch (e) {
    if (e.code === 'REMOTE') return show(context, COLORS.amber, 'Hermes\nlocal only');
    show(context, COLORS.red, 'Hermes\n' + (await whyApiDown()));
  }
}
// Uses the dashboard (if running) to say why the API is unreachable.
async function whyApiDown() {
  try {
    const st = await dashStatus();
    if (!st.gateway_running) return 'gateway off';
    const a = st.gateway_platforms && st.gateway_platforms.api_server;
    if (!a) return 'API off';
    if (a.state !== 'connected') return 'API ' + String(a.state || 'down').slice(0, 8);
    return 'off';
  } catch { return 'off'; }
}
function refreshAllStatus() { for (const [c, v] of ctx) if (v.action === 'status') refreshStatus(c); }
setInterval(refreshAllStatus, STATUS_MS);

// ---- Usage (reads the Hermes dashboard's /api/status; never sends the Hermes API key there)
function fmtNum(n) { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)); }
function bigText(value, color) {
  value = String(value).slice(0, 8);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" rx="16" fill="#1c1c1e"/><text x="72" y="82" font-family="Arial" font-weight="bold" font-size="${value.length > 5 ? 38 : 48}" fill="${color}" text-anchor="middle">${value.replace(/[<>&]/g, '')}</text></svg>`;
  return 'data:image/svg+xml;charset=utf8,' + encodeURIComponent(svg);
}
function showValue(context, value, color, title) {
  if (isEncoder(context)) return feedback(context, title, value, color);
  send({ event: 'setImage', context, payload: { target: 0, image: bigText(value, color) } });
  send({ event: 'setTitle', context, payload: { target: 0, title } });
}
async function dashStatus() {
  const r = await safeFetch(dashBase() + '/api/status');
  if (!r.ok) throw Object.assign(new Error('http ' + r.status), { code: 'HTTP' });
  const j = parseJson(r.text);
  if (!j || typeof j !== 'object') throw Object.assign(new Error('bad json'), { code: 'HTTP' });
  return j;
}
// Dashboard session token: the dashboard page embeds __HERMES_SESSION_TOKEN__ for its own browser.
// We read it the same way, keep it in memory only, never log or display it, and refetch on 401.
let dashToken = '';
function dashBase() { return String(global.dashboardUrl || DEFAULTS.dashboardUrl).replace(/\/+$/, ''); }
async function dashGet(pathname, withToken) {
  const headers = withToken && dashToken ? { Authorization: 'Bearer ' + dashToken } : {};
  return safeFetch(dashBase() + pathname, { headers });
}
async function refreshDashToken() {
  const res = await dashGet('/', false);
  const html = res.text;
  const m = html.match(/__HERMES_SESSION_TOKEN__\W+([A-Za-z0-9_\-.]+)/);
  dashToken = m ? m[1] : '';
}
// Each Hermes agent (profile) keeps its own usage records; the dashboard answers per profile.
const PROFILE_RE = /^[A-Za-z0-9_-]{1,64}$/;
async function listProfiles() {
  try {
    const st = await dashStatus();
    const list = Array.isArray(st.profiles) ? st.profiles.filter((p) => typeof p === 'string' && PROFILE_RE.test(p)) : [];
    return list.length ? list.slice(0, 32) : ['default'];
  } catch { return ['default']; }
}
async function analytics(days, profile) {
  const q = '/api/analytics/usage?days=' + days + (profile ? '&profile=' + encodeURIComponent(profile) : '');
  if (!dashToken) await refreshDashToken();
  let res = await dashGet(q, true);
  if (res.status === 401 || res.status === 403) { await refreshDashToken(); res = await dashGet(q, true); }
  if (!res.ok) throw Object.assign(new Error('http ' + res.status), { code: res.status === 401 || res.status === 403 ? 'AUTH' : 'HTTP' });
  const j = parseJson(res.text);
  if (!j || typeof j !== 'object') throw Object.assign(new Error('bad json'), { code: 'HTTP' });
  return j;
}
// Totals for one agent, or summed over every agent when agent is "all" / blank.
const TOTAL_KEYS = ['total_input', 'total_output', 'total_cache_read', 'total_reasoning', 'total_sessions', 'total_api_calls'];
async function usageTotals(days, agent) {
  const profiles = agent && agent !== 'all' && PROFILE_RE.test(agent) ? [agent] : await listProfiles();
  const sum = Object.fromEntries(TOTAL_KEYS.map((k) => [k, 0]));
  for (const p of profiles) {
    const t = (await analytics(days, p)).totals || {};
    for (const k of TOTAL_KEYS) sum[k] += Number(t[k]) || 0;
  }
  return sum;
}
// Cache hit % = cache reads / (uncached input + cache reads). Hermes reports cache reads separately from input.
function cachePct(tot) { const r = Number(tot.total_cache_read) || 0, i = Number(tot.total_input) || 0; return r + i > 0 ? Math.round((100 * r) / (r + i)) + '%' : '-'; }
// Start the dashboard: hermes.exe (standard path, or a full path the user set) with fixed arguments only, never through a shell.
let dashStarting = 0;
function hermesExe() {
  if (global.hermesExe) return path.isAbsolute(global.hermesExe) && !/^[\\/]{2}/.test(global.hermesExe) ? global.hermesExe : '';
  const guess = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'hermes', 'bin', 'hermes.exe') : '';
  if (guess && fs.existsSync(guess)) return guess;
  // On Windows, never fall back to a bare name (PATH / current-folder lookup); ask the user for the path.
  return process.platform === 'win32' ? '' : 'hermes';
}
function startDashboard() {
  if (Date.now() - dashStarting < 30000) return 'starting';
  if (!isLocal(dashBase())) return 'remote';
  let port = '9119';
  try { port = new URL(dashBase()).port || '9119'; } catch {}
  const exe = hermesExe();
  if (!exe) { dlog('dashboard start: hermes.exe not found; set its location in settings'); return 'failed'; }
  try {
    const child = spawn(exe, ['dashboard', '--no-open', '--port', port], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => { dashStarting = 0; dlog('dashboard start failed (hermes not found?)'); });
    child.unref();
    dashStarting = Date.now();
    dlog('dashboard start requested');
    return 'starting';
  } catch { return 'failed'; }
}
const PERIOD = { 1: 'today', 7: '7 days', 30: '30 days' };
const AMETRICS = {
  cache:     { label: 'Cache hit', get: (tot) => cachePct(tot) },
  alltokens: { label: 'Tokens', get: (tot) => fmtNum((Number(tot.total_input) || 0) + (Number(tot.total_output) || 0) + (Number(tot.total_cache_read) || 0)) },
  sessions:  { label: 'Sessions', get: (tot) => String(Number(tot.total_sessions) || 0) },
  calls:     { label: 'Model calls', get: (tot) => String(Number(tot.total_api_calls) || 0) },
};
const METRICS = {
  tokens:   { label: 'API tokens', get: (st, m) => fmtNum(m.tokens) },
  requests: { label: 'Requests',   get: (st, m) => String(Number(m.requests) || 0) },
  latency:  { label: 'p95 speed',  get: (st, m) => (m.latency_p95_ms ? (m.latency_p95_ms / 1000).toFixed(1) + 's' : '-') },
  active:   { label: 'Running',    get: (st) => String(Number(st.active_agents) || 0) },
};
async function refreshUsage(context) {
  const c = ctx.get(context); if (!c) return;
  if (AMETRICS[c.settings.metric]) {
    const days = PERIOD[c.settings.days] ? Number(c.settings.days) : 1;
    const am = AMETRICS[c.settings.metric];
    try {
      const agent = c.settings.agent && c.settings.agent !== 'all' && PROFILE_RE.test(c.settings.agent) ? c.settings.agent : '';
      const totals = await usageTotals(days, agent);
      return showValue(context, am.get(totals), '#ffffff', am.label + '\n' + (agent ? agent.slice(0, 10) + ' ' : '') + PERIOD[days]);
    } catch (e) {
      return showValue(context, e.code === 'REMOTE' ? 'local' : e.code === 'AUTH' ? 'auth' : 'off', COLORS.red, e.code === 'REMOTE' ? 'local only' : 'press:start');
    }
  }
  const metric = METRICS[c.settings.metric] ? c.settings.metric : 'tokens';
  try {
    const st = await dashStatus();
    const api = (st.gateway_platforms && st.gateway_platforms.api_server) || {};
    const m = (api.metrics && api.metrics.metrics_today) || {};
    const v = METRICS[metric].get(st, m);
    showValue(context, v, metric === 'active' && Number(st.active_agents) > 0 ? COLORS.blue : '#ffffff', METRICS[metric].label);
  } catch (e) {
    showValue(context, e.code === 'REMOTE' ? 'local' : 'off', COLORS.red, e.code === 'REMOTE' ? 'local only' : 'press:start');
  }
}
async function dashUp() { try { const r = await dashGet('/api/status', false); return r.ok; } catch { return false; } }
async function usagePress(context, refresh = refreshUsage) {
  if (await dashUp()) return refresh(context);
  if (global.autoStartDashboard === false) return refresh(context);
  const r = startDashboard();
  if (r !== 'starting') { showValue(context, r === 'remote' ? 'local' : 'fail', COLORS.red, 'dashboard'); return; }
  showValue(context, '...', COLORS.amber, 'starting');
  for (let i = 0; i < 15; i++) { await sleep(2000); if (await dashUp()) { dashToken = ''; refreshAllUsage(); return; } }
  showValue(context, 'fail', COLORS.red, 'dashboard');
}
// ---- Platforms: which Hermes connections are up (from the dashboard's /api/status)
async function refreshPlatforms(context) {
  try {
    const st = await dashStatus();
    const plats = Object.entries(st.gateway_platforms || {});
    if (!plats.length) return showValue(context, '-', COLORS.grey, 'Platforms');
    const bad = plats.filter(([, v]) => !v || v.state !== 'connected');
    const txt = (plats.length - bad.length) + '/' + plats.length;
    if (!bad.length) return showValue(context, txt, COLORS.green, 'Platforms');
    const name = bad[0][0].split(':').pop().replace('api_server', 'api').slice(0, 10);
    showValue(context, txt, COLORS.red, name + ' ' + String(bad[0][1] && bad[0][1].state || 'down').slice(0, 10));
  } catch (e) {
    showValue(context, e.code === 'REMOTE' ? 'local' : 'off', COLORS.red, e.code === 'REMOTE' ? 'local only' : 'press:start');
  }
}
function refreshAllPlatforms() { for (const [c, v] of ctx) if (v.action === 'platforms') refreshPlatforms(c); }


// ---- Open: WebUI, dashboard, latest reply, or a web address the user sets
function latestReply() {
  if (lastReply && fs.existsSync(lastReply)) return lastReply;
  try {
    const dir = replyDir();
    const files = fs.readdirSync(dir).filter((n) => /^ask-\d{8}-\d{6}(-\d{1,2})?\.md$/.test(n))
      .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => a.t - b.t);
    const f = files.length ? files[files.length - 1].n : '';
    return f ? path.join(dir, f) : '';
  } catch { return ''; }
}
function openFile(file) {
  const cmd = process.platform === 'win32' ? ['explorer.exe', [file]] : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
  try { const ch = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }); ch.on('error', () => {}); ch.unref(); return true; } catch { return false; }
}
function openPress(context) {
  const c = ctx.get(context); if (!c) return;
  const target = c.settings.target || 'webui';
  if (target === 'reply') {
    const f = latestReply();
    if (!f || !openFile(f)) return send({ event: 'showAlert', context });
    return send({ event: 'showOk', context });
  }
  const url = target === 'dashboard' ? dashBase() : target === 'url' ? String(c.settings.url || '') : String(global.webuiUrl || DEFAULTS.webuiUrl);
  if (!/^https?:\/\//i.test(url)) return send({ event: 'showAlert', context });
  send({ event: 'openUrl', payload: { url } });
  send({ event: 'showOk', context });
}

function refreshAllUsage() { for (const [c, v] of ctx) if (v.action === 'usage') refreshUsage(c); refreshAllPlatforms(); }
setInterval(refreshAllUsage, 60000);

// ---- Ask / Stop
function replyDir() { return global.replyDir || path.join(os.homedir(), 'WingedKeys', 'replies'); }
function stamp() { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }

function freshSettings(context) {
  return new Promise((resolve) => {
    pending.set(context, resolve);
    send({ event: 'getSettings', context });
    setTimeout(() => { if (pending.delete(context)) resolve(); }, 1500);
  });
}
// Clipboard: fixed OS commands only. WINGEDKEYS_TEST_CLIPBOARD is used by the automated tests.
const CLIP_MAX = 20000;
function readClipboard() {
  if (process.env.WINGEDKEYS_TEST_CLIPBOARD !== undefined) return Promise.resolve(process.env.WINGEDKEYS_TEST_CLIPBOARD);
  const cmd = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw']]
    : process.platform === 'darwin' ? ['pbpaste', []] : null;
  if (!cmd) return Promise.resolve('');
  return new Promise((resolve) => execFile(cmd[0], cmd[1], { timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? '' : String(out || '').replace(/\r?\n$/, ''))));
}
let lastReply = '';
async function ask(context) {
  // Claim this key before any await, so a second press can't start a second, unstoppable run.
  if (runs.has(context)) return send({ event: 'showAlert', context });
  const rec = { runId: null, stopped: false };
  runs.set(context, rec);
  const release = () => { if (runs.get(context) === rec) runs.delete(context); };
  try { await askClaimed(context, rec, release); }
  catch (e) { release(); send({ event: 'showAlert', context }); show(context, COLORS.red, 'failed'); setTimeout(() => initKey(context), 4000); }
}
async function askClaimed(context, rec, release) {
  await freshSettings(context);
  const c = ctx.get(context);
  if (!c) return release();
  const prompt = (c.settings.prompt || '').trim();
  if (!prompt) { release(); show(context, COLORS.amber, 'no prompt'); send({ event: 'showAlert', context }); return setTimeout(() => initKey(context), 2500); }
  const timeoutMs = Math.min(3600, Math.max(10, Number(c.settings.timeoutSec) || 300)) * 1000;
  let input = prompt;
  if (c.settings.useClipboard === true || c.settings.useClipboard === 'true') {
    const clip = (await readClipboard()).trim();
    if (!clip) { release(); show(context, COLORS.amber, 'clipboard\nempty'); send({ event: 'showAlert', context }); return setTimeout(() => initKey(context), 2500); }
    input = prompt + '\n\n---\n' + clip.slice(0, CLIP_MAX);
  }
  if (rec.stopped) { release(); show(context, COLORS.grey, 'stopped'); return setTimeout(() => initKey(context), 3000); }
  try {
    const body = { input };
    if (c.settings.sessionId) body.session_id = c.settings.sessionId;
    const start = await api('/v1/runs', { method: 'POST', body });
    if (!start.ok || !start.json || !start.json.run_id) throw new Error('start ' + start.status);
    const runId = start.json.run_id;
    rec.runId = runId;
    // Stop was pressed while the run was being created: stop it now.
    if (rec.stopped) api('/v1/runs/' + encodeURIComponent(runId) + '/stop', { method: 'POST' }).catch(() => {});
    show(context, COLORS.blue, 'working');
    const t0 = Date.now();
    let final = null;
    while (Date.now() - t0 < timeoutMs) {
      await sleep(POLL_MS);
      if (rec.stopped) break;
      const r = await api('/v1/runs/' + encodeURIComponent(runId));
      const st = r.json && r.json.status;
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(st)) { final = r.json; break; }
      // Waiting on the user (approval or clarification): show it; approving is done in the WebUI/app, never blind from a key.
      const pc = r.json && r.json.pending_controls;
      const waiting = st === 'waiting_for_approval' || (Array.isArray(pc) ? pc.length > 0 : !!(pc && Object.keys(pc).length));
      if (waiting !== rec.waiting) { rec.waiting = waiting; show(context, waiting ? COLORS.amber : COLORS.blue, waiting ? 'needs OK' : 'working'); }
    }
    release();
    if (rec.stopped) { show(context, COLORS.grey, 'stopped'); return setTimeout(() => initKey(context), 3000); }
    if (!final) { api('/v1/runs/' + encodeURIComponent(runId) + '/stop', { method: 'POST' }).catch(() => {}); throw new Error('timeout'); }
    if (final.status !== 'completed') throw new Error(final.status);
    const dir = replyDir();
    fs.mkdirSync(dir, { recursive: true });
    const content = `# ${label(context)}\n\n**Prompt:** ${prompt}${input !== prompt ? ' (with clipboard text)' : ''}\n\n${final.output || ''}\n`;
    const base = `ask-${stamp()}`;
    let file = '';
    for (let n = 0; n < 100 && !file; n++) {
      const candidate = path.join(dir, base + (n ? '-' + n : '') + '.md');
      try { fs.writeFileSync(candidate, content, { flag: 'wx' }); file = candidate; } catch (err) { if (err.code !== 'EEXIST') throw err; }
    }
    if (!file) throw new Error('could not save reply');
    lastReply = file;
    send({ event: 'showOk', context });
    show(context, COLORS.green, 'done');
  } catch (e) {
    release();
    send({ event: 'showAlert', context });
    show(context, COLORS.red, e.code === 'REMOTE' ? 'local only' : e.message === 'timeout' ? 'timed out' : 'failed');
  }
  setTimeout(() => initKey(context), 4000);
}
async function stopAll(context) {
  const active = [...runs.entries()];
  if (!active.length) { send({ event: 'showAlert', context }); return; }
  let ok = 0;
  for (const [ctxId, rec] of active) {
    if (!rec.runId) { rec.stopped = true; ok++; continue; } // not created yet: ask() stops it as soon as it exists
    let stoppedOk = false;
    try { const r = await api('/v1/runs/' + encodeURIComponent(rec.runId) + '/stop', { method: 'POST' }); stoppedOk = r.ok; } catch {}
    // Only show "stopped" if Hermes accepted the stop; otherwise the Ask key keeps tracking the run.
    if (stoppedOk) { rec.stopped = true; ok++; if (runs.get(ctxId) === rec) runs.delete(ctxId); }
  }
  send({ event: ok ? 'showOk' : 'showAlert', context });
  for (const [c] of ctx) initKey(c);
}
function onKey(context, kind) {
  if (kind === 'status') refreshStatus(context);
  else if (kind === 'usage') usagePress(context);
  else if (kind === 'platforms') usagePress(context, refreshPlatforms);
  else if (kind === 'open') openPress(context);
  else if (kind === 'ask') ask(context);
  else if (kind === 'stop') stopAll(context);
}

// ---- Dials: turning a Usage dial steps through the metrics; other actions ignore turning.
const METRIC_ORDER = ['cache', 'alltokens', 'sessions', 'calls', 'tokens', 'requests', 'latency', 'active'];
function onRotate(context, kind, ticks) {
  const c = ctx.get(context);
  if (!c || kind !== 'usage' || !ticks) return;
  const i = Math.max(0, METRIC_ORDER.indexOf(c.settings.metric || 'tokens'));
  const n = METRIC_ORDER.length;
  c.settings = { ...c.settings, metric: METRIC_ORDER[(((i + Math.max(-n, Math.min(n, ticks))) % n) + n) % n] };
  send({ event: 'setSettings', context, payload: c.settings });
  refreshUsage(context);
}

// ---- Setup helpers (called from the settings panel)
function setGlobal(patch) {
  global = { ...global, ...patch };
  const toSave = { ...global };
  send({ event: 'setGlobalSettings', context: args.pluginUUID, payload: toSave });
}
function reply(m, payload) { send({ event: 'sendToPropertyInspector', action: m.action, context: m.context, payload }); }

// 1. Auto-detect: ask the dashboard where the Hermes API server listens.
async function detect() {
  const st = await dashStatus();
  const a = st.gateway_platforms && st.gateway_platforms.api_server;
  const base = a && a.listener_base;
  if (!a) return { ok: false, text: 'Hermes is running, but its API server is off. Use the setup steps below.' };
  if (!base || !isLocal(base)) return { ok: false, text: 'Found Hermes, but its API address is not local, so it was not used.' };
  // Check that something answering like Hermes is really there before pointing the API key at it.
  let health = null;
  try { const r = await safeFetch(String(base).replace(/\/+$/, '') + '/health', { timeoutMs: 4000 }); health = r.ok ? parseJson(r.text) : null; } catch {}
  if (!health || health.status !== 'ok') return { ok: false, text: 'The dashboard pointed to ' + base + ', but nothing there answered like the Hermes API. Not saved.' };
  detectedCandidate = String(base).replace(/\/+$/, '');
  if (detectedCandidate === baseUrl()) return { ok: true, text: 'Hermes API is at ' + detectedCandidate + ', which is already your setting.' };
  return { ok: true, text: 'Found the Hermes API at ' + detectedCandidate + '. Click "Use this address" to save it.', found: detectedCandidate };
}
// Saves the address Find Hermes proposed, only after the user clicks to confirm it.
let detectedCandidate = '';
const SUPPORT_URL = 'https://ko-fi.com/overturesys';
async function useDetected(address) {
  if (!detectedCandidate || address !== detectedCandidate || !isLocal(address)) return { ok: false, text: 'Click Find Hermes again first.' };
  setGlobal({ baseUrl: detectedCandidate });
  detectedCandidate = '';
  return { ok: true, text: 'Saved. Click Test connection to check it.' };
}

// 2. Test connection: plain-language checks.
async function testConnection() {
  const lines = [];
  let dash = null;
  try { dash = await dashStatus(); lines.push('OK  Dashboard is running.'); }
  catch (e) { lines.push(e.code === 'REMOTE' ? 'NO  Dashboard address is not local.' : '--  Dashboard is off (only needed for Usage and Platforms keys).'); }
  try {
    const h = await api('/health', { auth: false });
    if (!h.ok) lines.push('NO  Hermes API answered with error ' + h.status + '.');
    else {
      lines.push('OK  Hermes API is running at ' + baseUrl() + '.');
      if (!global.apiKey) lines.push('NO  No API key set. Paste it, make one, or read it from Hermes.');
      else {
        const m = await api('/v1/models');
        lines.push(m.status === 401 || m.status === 403 ? 'NO  The API key does not match API_SERVER_KEY in your Hermes .env.' : m.ok ? 'OK  API key accepted.' : 'NO  Key check failed (error ' + m.status + ').');
      }
    }
  } catch (e) {
    if (e.code === 'REMOTE') lines.push('NO  Hermes address is not local. Tick "Allow a non-local address" only if you mean it.');
    else {
      const why = dash ? await whyApiDown() : 'off';
      lines.push(why === 'API off' ? 'NO  Hermes is running but its API server is off. Use the setup steps below.'
        : why === 'gateway off' ? 'NO  The Hermes gateway is not running. Start Hermes.'
        : 'NO  Cannot reach Hermes at ' + baseUrl() + '. Is Hermes running, and is the API server on?');
    }
  }
  return { ok: !lines.some((l) => l.startsWith('NO')), text: lines.join('\n') };
}

// 3. Read key from Hermes: reads ONLY the API_SERVER_KEY line from the user's own Hermes .env,
//    only when the user clicks the button and confirms. The key is saved like a typed key and never logged.
function defaultEnvPath() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'hermes', '.env');
  return path.join(os.homedir(), '.hermes', '.env');
}
async function readKeyFromHermes() {
  // The file location comes only from the user's own setting or the standard Hermes location,
  // never from the dashboard (a fake dashboard could otherwise choose which file is read).
  let envPath = global.envPath ? String(global.envPath) : defaultEnvPath();
  if (!path.isAbsolute(envPath) || /^[\\/]{2}/.test(envPath) || path.basename(envPath) !== '.env')
    return { ok: false, text: 'The .env location must be a full local path ending in .env (network paths are not allowed).' };
  let text;
  try { text = fs.readFileSync(envPath, 'utf8'); } catch { return { ok: false, text: 'Could not open your Hermes .env at ' + envPath + '.' }; }
  let key = '', enabled = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (k === 'API_SERVER_KEY') key = v;
    if (k === 'API_SERVER_ENABLED') enabled = /^(true|1|yes|on)$/i.test(v);
  }
  if (!key) return { ok: false, text: 'No API_SERVER_KEY in ' + envPath + '. Use "Make a key" and the setup steps.' };
  setGlobal({ apiKey: key });
  dlog('api key read from Hermes .env');
  return { ok: true, text: 'Key read from ' + envPath + ' and saved.' + (enabled ? '' : ' Note: API_SERVER_ENABLED is not true there, so the API server may be off.') };
}

async function onSetupCommand(m) {
  const cmd = m.payload && m.payload.cmd;
  let r;
  try {
    if (cmd === 'detect') r = await detect();
    else if (cmd === 'test') r = await testConnection();
    else if (cmd === 'readKey') r = await readKeyFromHermes();
    else if (cmd === 'profiles') { reply(m, { cmd, profiles: await listProfiles() }); return; }
    else if (cmd === 'support') { send({ event: 'openUrl', payload: { url: SUPPORT_URL } }); return; }
    else if (cmd === 'useAddress') r = await useDetected(String((m.payload && m.payload.address) || ''));
    else return;
  } catch (e) {
    r = { ok: false, text: e.code === 'REMOTE' ? 'The dashboard address is not local.' : 'Could not reach the Hermes dashboard. Start it, then try again.' };
  }
  reply(m, { cmd, ...r });
  refreshAllStatus();
}

process.on('uncaughtException', (e) => dlog('error: ' + (e && e.name) + ' ' + String(e && e.message).slice(0, 200)));
process.on('unhandledRejection', (e) => dlog('rejection: ' + (e && e.name) + ' ' + String(e && e.message).slice(0, 200)));
