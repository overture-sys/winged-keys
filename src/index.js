// Winged Keys - Stream Dock plugin. Not made by or affiliated with Nous Research.
// Talks only to the Hermes API server and the Hermes dashboard. The API key comes from the app's global settings and is never logged.
const WebSocket = require('./wsclient');
const FACE = require('./face');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

// ---- registration arguments from Stream Dock: -port -pluginUUID -registerEvent -info
const args = {};
for (let i = 2; i + 1 < process.argv.length; i += 2) args[process.argv[i].replace(/^-+/, '')] = process.argv[i + 1];

const DEFAULTS = { webuiUrl: 'http://127.0.0.1:8787', baseUrl: 'http://127.0.0.1:8642', apiKey: '', allowRemote: false, replyDir: '', dashboardUrl: 'http://127.0.0.1:9119', hermesExe: '', allowStartDashboard: false, allowReadKey: false, allowClipboard: false };
// Opt-in features (off until the user ticks them in the settings panel): starting the Hermes dashboard,
// reading the key from the Hermes .env files, and adding the clipboard to Ask prompts. See SECURITY.md.
// allowStartDashboard replaces the old autoStartDashboard setting (on by default), which is ignored.
const optedIn = (name) => global[name] === true || global[name] === 'true';
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
      FACE.setTextSize(global.textSize);
      for (const [c] of ctx) initKey(c);
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
// Greek-gold palette. grey = idle (drawn in gold), blue = busy.
const COLORS = { green: '#7fd19b', amber: '#e0b25a', red: '#d9705c', grey: FACE.PAL.gold, blue: '#8fb3e8', text: FACE.PAL.text };
function isEncoder(context) { const c = ctx.get(context); return !!c && c.controller === 'Encoder'; }
// Elgato dials have their own display (layout $A1: title + value); keys and Stream Dock knobs use image + title.
function feedback(context, title, value, color) {
  send({ event: 'setFeedback', context, payload: { title: String(title).replace(/\n/g, ' '), value: { value: String(value), color } } });
}
function show(context, color, title) {
  if (isEncoder(context)) { const parts = String(title).split('\n'); return feedback(context, parts.length > 1 ? parts[0] : label(context), parts[parts.length - 1], color); }
  const c = ctx.get(context);
  const image = c && c.action === 'status' ? FACE.statusFace(color, title) : FACE.iconFace(c ? c.action : 'open', color, title);
  send({ event: 'setImage', context, payload: { target: 0, image } });
  send({ event: 'setTitle', context, payload: { target: 0, title: '' } }); // the text is drawn on the key
}
function label(context) {
  const c = ctx.get(context); if (!c) return '';
  return c.settings.label || ({ status: 'Hermes', ask: 'Ask', stop: 'Stop', open: 'Open', platforms: 'Platforms', session: 'New chat', approve: 'Approve' })[c.action] || '';
}
function initKey(context) {
  const c = ctx.get(context); if (!c) return;
  if (c.action === 'status') refreshStatus(context);
  else if (c.action === 'usage') refreshUsage(context);
  else if (c.action === 'platforms') refreshPlatforms(context);
  else if (c.action === 'open') show(context, COLORS.grey, label(context));
  else if (c.action === 'ask') show(context, runs.has(context) ? COLORS.blue : COLORS.grey, runs.has(context) ? 'working' : label(context) + agentLine());
  else if (c.action === 'agent') show(context, COLORS.grey, agentName() + '\nagent');
  else if (c.action === 'session') show(context, COLORS.grey, label(context) + agentLine());
  else if (c.action === 'approve') showApprove(context);
  else if (c.action === 'model') show(context, COLORS.grey, modelShort() + '\nmodel');
  else show(context, COLORS.red, label(context));
}

// ---- Agents (Hermes profiles). Hermes serves each agent at /p/<agent>/ on the same port, and each
// named agent checks its OWN API_SERVER_KEY (from profiles/<agent>/.env); "default" uses the main key.
const AGENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
function activeAgent() { const a = global.activeAgent; return a && a !== 'default' && AGENT_RE.test(String(a)) ? String(a) : ''; }
function agentName(a = activeAgent()) { return a || 'default'; }
// Second line naming the agent, shown only when one is chosen.
function agentLine() { return activeAgent() ? '\n' + activeAgent() : ''; }
function agentKey(a) {
  const ks = global.agentKeys && typeof global.agentKeys === 'object' ? global.agentKeys : {};
  return (a && typeof ks[a] === 'string' && ks[a]) || global.apiKey || '';
}

// ---- Models. Hermes has no endpoint that changes its default model; instead POST /v1/runs takes
// a per-run "model" (and optional "provider") that Hermes always honors, unless the session already
// has its own /model override. So the Model key picks which model Ask keys put in each run.
// Entries are "model" or "provider:model", e.g. openrouter:anthropic/claude-sonnet-4.6.
const MODEL_RE = /^[A-Za-z0-9._:\/@+-]{1,200}$/;
const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
function modelList() {
  const raw = Array.isArray(global.models) ? global.models.join('\n') : String(global.models || '');
  return [...new Set(raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => MODEL_RE.test(l)))].slice(0, 20);
}
// The chosen model, only while it is still in the list; '' = Hermes's own default.
function activeModel() { const m = String(global.activeModel || ''); return m && modelList().includes(m) ? m : ''; }
function modelRequest(m) {
  const i = m.indexOf(':');
  return i > 0 && i < m.length - 1 && PROVIDER_RE.test(m.slice(0, i)) ? { provider: m.slice(0, i), model: m.slice(i + 1) } : { model: m };
}
// Key text: the part after the last "/" (anthropic/claude-sonnet-4.6 -> claude-sonnet-4.6).
function modelShort(m = activeModel()) { return m ? modelRequest(m).model.split('/').pop() : 'default'; }

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
async function api(pathname, { method = 'GET', body, auth = true, timeoutMs = 8000, agent = activeAgent() } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  const key = agentKey(agent);
  if (auth && key) headers.Authorization = 'Bearer ' + key;
  const prefix = agent && pathname.startsWith('/v1/') ? '/p/' + encodeURIComponent(agent) : '';
  const r = await safeFetch(baseUrl() + prefix + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined, timeoutMs });
  return { status: r.status, ok: r.ok, json: parseJson(r.text) };
}

// ---- Status
async function refreshStatus(context) {
  try {
    const h = await api('/health', { auth: false });
    const who = activeAgent() || 'Hermes';
    if (!h.ok) return show(context, COLORS.red, who + '\nerror ' + h.status);
    if (!agentKey(activeAgent())) return show(context, COLORS.amber, who + '\nno key');
    const m = await api('/v1/models');
    if (m.status === 404 && activeAgent()) return show(context, COLORS.amber, who + '\nunknown');
    if (m.status === 401 || m.status === 403) {
      const own = activeAgent() && global.agentKeys && typeof global.agentKeys === 'object' && global.agentKeys[activeAgent()];
      return show(context, COLORS.amber, who + (activeAgent() && !own ? '\nneeds key' : '\nbad key'));
    }
    return show(context, COLORS.green, who + '\nOK');
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
function showValue(context, value, color, title) {
  if (isEncoder(context)) return feedback(context, title, value, color);
  if (color === '#ffffff') color = COLORS.text;
  send({ event: 'setImage', context, payload: { target: 0, image: FACE.valueFace(value, color, title) } });
  send({ event: 'setTitle', context, payload: { target: 0, title: '' } }); // the text is drawn on the key
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
      return showValue(context, am.get(totals), c.settings.metric === 'cache' ? FACE.PAL.gold : '#ffffff', am.label + '\n' + (agent ? agent.slice(0, 10) + ' ' : '') + PERIOD[days]);
    } catch (e) {
      return showValue(context, e.code === 'REMOTE' ? 'local' : e.code === 'AUTH' ? 'auth' : 'off', COLORS.red, e.code === 'REMOTE' ? 'local only' : offHint());
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
    showValue(context, e.code === 'REMOTE' ? 'local' : 'off', COLORS.red, e.code === 'REMOTE' ? 'local only' : offHint());
  }
}
// What an off Usage or Platforms key suggests: pressing only helps when starting the dashboard is turned on.
function offHint() { return optedIn('allowStartDashboard') ? 'press to start' : 'dashboard off'; }
async function dashUp() { try { const r = await dashGet('/api/status', false); return r.ok; } catch { return false; } }
async function usagePress(context, refresh = refreshUsage) {
  if (await dashUp()) return refresh(context);
  if (!optedIn('allowStartDashboard')) return refresh(context);
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
    showValue(context, e.code === 'REMOTE' ? 'local' : 'off', COLORS.red, e.code === 'REMOTE' ? 'local only' : offHint());
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
// Clipboard: fixed OS commands only, and only after the user turned on "Ask with clipboard".
// Neither the Stream Dock nor the Stream Deck plugin API has a clipboard read, so Windows uses PowerShell's Get-Clipboard.
// WINGEDKEYS_TEST_CLIPBOARD is used by the automated tests.
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
// Ask keys with "continue the conversation" share one Hermes session per agent until New chat is pressed.
const conversations = new Map();
async function ask(context) {
  // Claim this key before any await, so a second press can't start a second, unstoppable run.
  if (runs.has(context)) return send({ event: 'showAlert', context });
  const rec = { runId: null, stopped: false };
  runs.set(context, rec);
  const release = () => { if (runs.get(context) === rec) { runs.delete(context); refreshApproveKeys(); } };
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
    if (!optedIn('allowClipboard')) { release(); show(context, COLORS.amber, 'clipboard\noff'); send({ event: 'showAlert', context }); return setTimeout(() => initKey(context), 2500); }
    const clip = (await readClipboard()).trim();
    if (!clip) { release(); show(context, COLORS.amber, 'clipboard\nempty'); send({ event: 'showAlert', context }); return setTimeout(() => initKey(context), 2500); }
    input = prompt + '\n\n---\n' + clip.slice(0, CLIP_MAX);
  }
  if (rec.stopped) { release(); show(context, COLORS.grey, 'stopped'); return setTimeout(() => initKey(context), 3000); }
  try {
    const agent = activeAgent();
    rec.agent = agent;
    const body = { input };
    if (activeModel()) Object.assign(body, modelRequest(activeModel()));
    const cont = c.settings.continueChat === true || c.settings.continueChat === 'true';
    if (c.settings.sessionId) body.session_id = c.settings.sessionId;
    else if (cont && conversations.get(agentName(agent))) body.session_id = conversations.get(agentName(agent));
    const start = await api('/v1/runs', { method: 'POST', body, agent });
    if (!start.ok || !start.json || !start.json.run_id) throw new Error('start ' + start.status);
    const runId = start.json.run_id;
    rec.runId = runId;
    // Stop was pressed while the run was being created: stop it now.
    if (rec.stopped) api('/v1/runs/' + encodeURIComponent(runId) + '/stop', { method: 'POST', agent }).catch(() => {});
    show(context, COLORS.blue, 'working');
    const t0 = Date.now();
    let final = null;
    while (Date.now() - t0 < timeoutMs) {
      await sleep(POLL_MS);
      if (rec.stopped) break;
      const r = await api('/v1/runs/' + encodeURIComponent(runId), { agent });
      const st = r.json && r.json.status;
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(st)) { final = r.json; break; }
      // Waiting on the user (approval or clarification): show it. Approving is done in the WebUI/app,
      // or from an Approve key that shows the request first; never automatically.
      const approval = readApproval(r.json);
      if ((approval && approval.id) !== (rec.approval && rec.approval.id)) { rec.approval = approval; refreshApproveKeys(); }
      const pc = r.json && r.json.pending_controls;
      const waiting = st === 'waiting_for_approval' || (Array.isArray(pc) ? pc.length > 0 : !!(pc && Object.keys(pc).length));
      if (waiting !== rec.waiting) { rec.waiting = waiting; show(context, waiting ? COLORS.amber : COLORS.blue, waiting ? 'needs OK' : 'working'); }
    }
    rec.approval = null;
    release();
    if (rec.stopped) { show(context, COLORS.grey, 'stopped'); return setTimeout(() => initKey(context), 3000); }
    if (!final) { api('/v1/runs/' + encodeURIComponent(runId) + '/stop', { method: 'POST', agent }).catch(() => {}); throw new Error('timeout'); }
    if (final.status !== 'completed') throw new Error(final.status);
    const dir = replyDir();
    fs.mkdirSync(dir, { recursive: true });
    // runtime = the provider/model that actually answered (Hermes reports it on finished runs).
    const rt = final.runtime && typeof final.runtime === 'object' ? final.runtime : {};
    const served = [rt.provider, rt.model].filter((v) => typeof v === 'string' && v).join(' / ').replace(/[\r\n]/g, ' ').slice(0, 200);
    const content = `# ${label(context)}\n\n**Prompt:** ${prompt}${input !== prompt ? ' (with clipboard text)' : ''}\n${served ? `\n**Model:** ${served}\n` : ''}\n${final.output || ''}\n`;
    const base = `ask-${stamp()}`;
    let file = '';
    for (let n = 0; n < 100 && !file; n++) {
      const candidate = path.join(dir, base + (n ? '-' + n : '') + '.md');
      try { fs.writeFileSync(candidate, content, { flag: 'wx' }); file = candidate; } catch (err) { if (err.code !== 'EEXIST') throw err; }
    }
    if (!file) throw new Error('could not save reply');
    lastReply = file;
    if (cont && typeof final.session_id === 'string' && final.session_id) conversations.set(agentName(agent), final.session_id.slice(0, 200));
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
    try { const r = await api('/v1/runs/' + encodeURIComponent(rec.runId) + '/stop', { method: 'POST', agent: rec.agent || '' }); stoppedOk = r.ok; } catch {}
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
  else if (kind === 'agent') nextAgent(context);
  else if (kind === 'session') newChat(context);
  else if (kind === 'approve') approvePress(context);
  else if (kind === 'model') nextModel(context, 1);
}

// ---- Approve key: shows the approval request an Ask run is waiting on, and answers it only when pressed.
// Only runs started from these keys are watched. The answer is always "once" (or "deny" when the key is
// set to deny), never "session" or "always", and only for the exact request the key has been showing
// for at least ARM_MS, so a request that appears just as the key is pressed is never approved unseen.
const ARM_MS = 1500;
const shown = new Map(); // approve key context -> { id, at }: the request on screen and since when
function cleanText(s, max) { return String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
// The pending approval in a GET /v1/runs/<id> body: canonical Hermes lists it in pending_controls
// (answered with request_id + execution_generation); older gateways put it in "approval" (request_id).
// Hermes redacts secrets from the command before sending it. Clarify questions are not approvals.
function readApproval(j) {
  if (!j || j.status !== 'waiting_for_approval') return null;
  const pc = Array.isArray(j.pending_controls) ? j.pending_controls.find((p) => p && p.kind === 'approval') : null;
  const a = pc || (j.approval && typeof j.approval === 'object' ? j.approval : null);
  if (!a) return null;
  const id = pc ? pc.prompt_id : a.request_id;
  if (typeof id !== 'string' || !id || id.length > 256) return null;
  if (pc && !Number.isInteger(pc.execution_generation)) return null;
  return { id, generation: pc ? pc.execution_generation : null, canonical: !!pc,
    command: cleanText(a.command, 300), description: cleanText(a.description, 300),
    choices: Array.isArray(a.choices) ? a.choices.filter((x) => typeof x === 'string') : null };
}
function pendingApprovals() { return [...runs.values()].filter((rec) => rec.runId && rec.approval); }
function refreshApproveKeys() { for (const [c, v] of ctx) if (v.action === 'approve') showApprove(c); }
function denyMode(c) { return c.settings.denyMode === true || c.settings.denyMode === 'true'; }
function showApprove(context) {
  const c = ctx.get(context); if (!c || c.busy) return;
  const list = pendingApprovals();
  const name = c.settings.label || (denyMode(c) ? 'Deny' : 'Approve');
  if (!list.length) { shown.delete(context); return show(context, COLORS.grey, name + '\nnothing'); }
  const rec = list[0], a = rec.approval;
  const prev = shown.get(context);
  if (!prev || prev.id !== a.id) shown.set(context, { id: a.id, at: Date.now() });
  const head = denyMode(c) ? 'Deny?' : 'Approve?';
  const what = a.command || a.description || 'request';
  const foot = list.length > 1 ? '1 of ' + list.length : (rec.agent || '');
  if (isEncoder(context)) return feedback(context, head, what.slice(0, 40), COLORS.amber);
  send({ event: 'setImage', context, payload: { target: 0, image: FACE.previewFace(denyMode(c) ? COLORS.red : COLORS.amber, head, what, foot) } });
  send({ event: 'setTitle', context, payload: { target: 0, title: '' } });
}
async function approvePress(context) {
  const c = ctx.get(context); if (!c || c.busy) return;
  const rec = pendingApprovals()[0];
  const a = rec && rec.approval, seen = shown.get(context);
  // Nothing waiting, or the request on the key changed (or only just appeared): show it, don't answer it.
  if (!a || !seen || seen.id !== a.id || Date.now() - seen.at < ARM_MS) { showApprove(context); return send({ event: 'showAlert', context }); }
  const choice = denyMode(c) ? 'deny' : 'once';
  if (a.choices && !a.choices.includes(choice)) return send({ event: 'showAlert', context });
  c.busy = true;
  const agent = rec.agent || '', base = '/v1/runs/' + encodeURIComponent(rec.runId);
  try {
    // Ask Hermes again: answer only if this exact request is still the one waiting.
    const now = await api(base, { agent });
    const cur = readApproval(now.json);
    if (!cur || cur.id !== a.id || cur.generation !== a.generation) { rec.approval = cur; throw Object.assign(new Error('changed'), { code: 'CHANGED' }); }
    const body = a.canonical ? { request_id: a.id, execution_generation: a.generation, choice } : { request_id: a.id, choice };
    const r = await api(base + '/approval', { method: 'POST', body, agent });
    if (!r.ok) throw Object.assign(new Error('http ' + r.status), { code: r.status === 409 ? 'GONE' : 'HTTP' });
    if (rec.approval && rec.approval.id === a.id) rec.approval = null;
    shown.delete(context);
    dlog('approval answered: ' + choice);
    send({ event: 'showOk', context });
    show(context, choice === 'deny' ? COLORS.red : COLORS.green, choice === 'deny' ? 'denied' : 'approved');
  } catch (e) {
    send({ event: 'showAlert', context });
    show(context, e.code === 'HTTP' ? COLORS.red : COLORS.amber, e.code === 'REMOTE' ? 'local only' : e.code === 'CHANGED' ? 'changed' : e.code === 'GONE' ? 'gone' : 'failed');
  }
  setTimeout(() => { c.busy = false; refreshApproveKeys(); }, 2000);
}

// ---- Agent key: cycles through your Hermes agents; Ask, Stop, Status and New chat follow it.
function hermesHome() { return path.dirname(global.envPath ? String(global.envPath) : defaultEnvPath()); }
function agentsOnDisk() {
  try {
    return fs.readdirSync(path.join(hermesHome(), 'profiles'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && AGENT_RE.test(d.name)).map((d) => d.name).slice(0, 32);
  } catch { return []; }
}
async function allAgents() {
  const set = new Set(['default']);
  try { for (const p of await listProfiles()) set.add(p); } catch {}
  for (const p of agentsOnDisk()) set.add(p);
  return [...set];
}
async function nextAgent(context) {
  const list = await allAgents();
  const i = list.indexOf(agentName());
  const next = list[(i + 1) % list.length];
  setGlobal({ activeAgent: next === 'default' ? '' : next });
  dlog('agent switched');
  for (const [c] of ctx) initKey(c);
  if (context) send({ event: 'showOk', context });
}

// ---- Model key: steps through Hermes's default and the models listed in the settings panel.
function nextModel(context, step) {
  const list = ['', ...modelList()];
  if (list.length === 1) {
    if (context) { send({ event: 'showAlert', context }); show(context, COLORS.amber, 'no models\nmodel'); setTimeout(() => initKey(context), 2500); }
    return;
  }
  const n = list.length, i = Math.max(0, list.indexOf(activeModel()));
  setGlobal({ activeModel: list[(((i + step) % n) + n) % n] });
  dlog('model switched');
  for (const [c] of ctx) initKey(c);
  if (context) send({ event: 'showOk', context });
}

// ---- New chat key: forgets the current conversation for the active agent.
function newChat(context) {
  const c = ctx.get(context); if (!c) return;
  conversations.delete(agentName());
  show(context, COLORS.green, 'new chat\n' + agentName());
  if (c.settings.openChat === true || c.settings.openChat === 'true') {
    const url = String(global.webuiUrl || DEFAULTS.webuiUrl);
    if (/^https?:\/\//i.test(url)) send({ event: 'openUrl', payload: { url } });
  }
  send({ event: 'showOk', context });
  setTimeout(() => initKey(context), 2500);
}

// ---- Dials: turning a Usage dial steps through the metrics, a Model dial through the models; other actions ignore turning.
const METRIC_ORDER = ['cache', 'alltokens', 'sessions', 'calls', 'tokens', 'requests', 'latency', 'active'];
function onRotate(context, kind, ticks) {
  const c = ctx.get(context);
  if (c && kind === 'model' && ticks) return nextModel(context, Math.max(-20, Math.min(20, ticks)));
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
const HELP_URL = 'https://gitlab.com/overture-group1/Overture-project#readme';
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
      if (!global.apiKey) lines.push('NO  No API key set. Paste it or make one.');
      else {
        const m = await api('/v1/models', { agent: '' });
        lines.push(m.status === 401 || m.status === 403 ? 'NO  The API key does not match API_SERVER_KEY in your Hermes .env.' : m.ok ? 'OK  API key accepted.' : 'NO  Key check failed (error ' + m.status + ').');
        const a = activeAgent();
        if (a) {
          const am = await api('/v1/models');
          lines.push(am.ok ? 'OK  Agent "' + a + '" accepted its key.'
            : am.status === 404 ? 'NO  Hermes does not serve an agent named "' + a + '".'
            : am.status === 401 || am.status === 403 ? 'NO  Agent "' + a + '" needs its own API_SERVER_KEY in profiles\\' + a + '\\.env (Hermes does not reuse the main key for named agents). Then turn on Read key from Hermes under Optional features and use it.'
            : 'NO  Agent "' + a + '" check failed (error ' + am.status + ').');
        }
        if (activeModel()) lines.push('--  Ask keys ask Hermes for model "' + activeModel() + '". Each reply file names the model that answered.');
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
function readEnvKey(file) {
  let text = '';
  try { if (fs.statSync(file).size > 1024 * 1024) return ''; text = fs.readFileSync(file, 'utf8'); } catch { return ''; }
  let key = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0 && line.slice(0, i).trim() === 'API_SERVER_KEY') key = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return key.length >= 16 ? key : '';
}
async function readKeyFromHermes() {
  if (!optedIn('allowReadKey')) return { ok: false, text: 'Read key from Hermes is off. Turn it on under Optional features first.' };
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
  // Each agent's own key, from <hermes home>/profiles/<agent>/.env (only that one line is read).
  const agentKeys = {}, missing = [];
  for (const a of agentsOnDisk()) {
    const k = readEnvKey(path.join(path.dirname(envPath), 'profiles', a, '.env'));
    if (k) agentKeys[a] = k; else missing.push(a);
  }
  setGlobal({ apiKey: key, agentKeys });
  dlog('api keys read from Hermes .env files');
  const found = Object.keys(agentKeys);
  return { ok: true, text: 'Key read from ' + envPath + ' and saved.' + (enabled ? '' : ' Note: API_SERVER_ENABLED is not true there, so the API server may be off.')
    + (found.length ? '\nAgent keys found for: ' + found.join(', ') + '.' : '')
    + (missing.length ? '\nNo key yet for: ' + missing.join(', ') + '. To use them from the keys, add an API_SERVER_KEY line to each agent\'s .env (profiles\\<agent>\\.env), restart Hermes, and read the keys again.' : '') };
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
    else if (cmd === 'help') { send({ event: 'openUrl', payload: { url: HELP_URL } }); return; }
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
