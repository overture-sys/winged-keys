// Agent key, per-agent routing (/p/<agent>/) and keys, New chat and "continue the conversation".
const http = require('http'), crypto = require('crypto'), { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
let ok = true; const check = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) ok = false; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fake Hermes home on disk: main .env + profiles/<agent>/.env
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wka-'));
const hh = path.join(home, 'hermes');
fs.mkdirSync(path.join(hh, 'profiles', 'morpheus'), { recursive: true });
fs.mkdirSync(path.join(hh, 'profiles', 'the_chef'), { recursive: true });
fs.writeFileSync(path.join(hh, '.env'), 'API_SERVER_ENABLED=true\nAPI_SERVER_KEY=MAINKEY-0123456789\n');
fs.writeFileSync(path.join(hh, 'profiles', 'morpheus', '.env'), 'OTHER=1\nAPI_SERVER_KEY=MORPHKEY-0123456789\n');
fs.writeFileSync(path.join(hh, 'profiles', 'the_chef', '.env'), 'NOTHING=here\n');

// fake Hermes API: default uses MAINKEY, /p/morpheus/ uses MORPHKEY, the_chef has no key (401 always)
const KEYS = { '': 'MAINKEY-0123456789', morpheus: 'MORPHKEY-0123456789' };
const hits = []; const runs = {}; let n = 0;
const hermes = http.createServer((q, r) => { let b = ''; q.on('data', (d) => (b += d)); q.on('end', () => {
  const j = (c, o) => { r.writeHead(c, { 'content-type': 'application/json' }); r.end(JSON.stringify(o)); };
  let agent = '', p = q.url;
  const m = p.match(/^\/p\/([^/]+)(\/.*)$/); if (m) { agent = m[1]; p = m[2]; }
  hits.push({ agent, path: p, method: q.method, auth: q.headers.authorization || '', body: b });
  if (p === '/health') return j(200, { status: 'ok' });
  if (agent && !(agent in KEYS) && agent !== 'the_chef') return j(404, { error: 'Unknown or unconfigured profile' });
  if (q.headers.authorization !== 'Bearer ' + KEYS[agent]) return j(401, {});
  if (p === '/v1/models') return j(200, { data: [] });
  if (p === '/v1/runs' && q.method === 'POST') { const id = 'run_' + (++n); const body = JSON.parse(b); runs[id] = { agent, session: body.session_id || 'S' + n }; return j(200, { run_id: id }); }
  const rm = p.match(/^\/v1\/runs\/([^/]+)(\/stop)?$/);
  if (rm && runs[rm[1]]) { if (rm[2]) return j(200, { status: 'stopping' }); return j(200, { status: 'completed', output: 'ok', session_id: runs[rm[1]].session }); }
  j(404, {});
}); });
const dash = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ gateway_running: true, profiles: ['default', 'morpheus', 'the_chef'], gateway_platforms: {} })); });

let sock; const msgs = []; const stored = {};
const sd = http.createServer();
const frame = (s) => { const p = Buffer.from(s); const h = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]); return Buffer.concat([h, p]); };
sd.on('upgrade', (req, s) => {
  const k = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + k + '\r\n\r\n'); sock = s; let buf = Buffer.alloc(0);
  s.on('data', (d) => { buf = Buffer.concat([buf, d]); for (;;) { if (buf.length < 2) return; let len = buf[1] & 127, off = 2; if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; } if (buf.length < off + 4 + len) return; const op = buf[0] & 15; const mk = buf.slice(off, off + 4); const pl = Buffer.from(buf.slice(off + 4, off + 4 + len).map((v, i) => v ^ mk[i % 4])); buf = buf.slice(off + 4 + len); if (op === 1) { const mm = JSON.parse(pl.toString()); msgs.push(mm); if (mm.event === 'getSettings' && stored[mm.context]) setTimeout(() => send({ event: 'didReceiveSettings', context: mm.context, payload: { settings: stored[mm.context] } }), 10); if (mm.event === 'setGlobalSettings') { global = mm.payload; setTimeout(() => send({ event: 'didReceiveGlobalSettings', payload: { settings: global } }), 10); } } } });
});
let global = {};
const send = (o) => sock.write(frame(JSON.stringify(o)));
const last = (c, ev) => msgs.filter((m) => m.context === c && m.event === ev).pop();
const lbl = (c) => { const im = last(c, 'setImage'); const m = im && decodeURIComponent(im.payload.image).match(/data-label="([^"]*)"/); return m ? m[1] : ''; };
const P = 'com.wingedkeys.hermes.';
const appear = (k, ctxId, settings) => { stored[ctxId] = settings; send({ event: 'willAppear', action: P + k, context: ctxId, payload: { settings } }); };
const press = (k, ctxId) => send({ event: 'keyDown', action: P + k, context: ctxId, payload: {} });

(async () => {
  for (const s of [hermes, dash, sd]) await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const plugin = (process.env.PLUGIN || 'streamdock/com.wingedkeys.hermes.sdPlugin') + '/plugin/index.js';
  const child = spawn('node', [plugin, '-port', sd.address().port, '-pluginUUID', 'UU', '-registerEvent', 'registerPlugin', '-info', '{}'], { env: { ...process.env, HOME: home, USERPROFILE: home, WINGEDKEYS_TEST_CLIPBOARD: '' } });
  await sleep(400);
  global = { baseUrl: 'http://127.0.0.1:' + hermes.address().port, dashboardUrl: 'http://127.0.0.1:' + dash.address().port, envPath: path.join(hh, '.env'), replyDir: path.join(home, 'r') };
  send({ event: 'didReceiveGlobalSettings', payload: { settings: global } });
  await sleep(200);

  // read keys: main + morpheus found, the_chef missing
  send({ event: 'sendToPlugin', action: P + 'status', context: 'X', payload: { cmd: 'readKey' } }); await sleep(600);
  const rk = last('X', 'sendToPropertyInspector');
  check('read keys: main key and morpheus found', rk && rk.payload.ok && /morpheus/.test(rk.payload.text.split('Agent keys found for:')[1] || ''));
  check('read keys: the_chef reported missing', /No key yet for: the_chef/.test(rk.payload.text));
  check('read keys: values never sent to the settings panel', !/KEY-0123456789/.test(rk.payload.text));
  check('read keys: only API_SERVER_KEY lines saved', global.agentKeys && global.agentKeys.morpheus === 'MORPHKEY-0123456789' && !('the_chef' in global.agentKeys) && !JSON.stringify(global).includes('OTHER'));

  appear('agent', 'AG', {}); appear('status', 'ST', {}); appear('ask', 'AS', { prompt: 'hi', label: 'Ask', timeoutSec: 30, continueChat: true }); appear('session', 'NC', { openChat: true }); appear('stop', 'SP', {});
  await sleep(700);
  check('agent key starts on default', /^default/.test(lbl('AG')));
  check('status OK on default', /OK/.test(lbl('ST')));

  // switch to morpheus
  press('agent', 'AG'); await sleep(700);
  check('agent key shows morpheus', /^morpheus/.test(lbl('AG')));
  check('status follows the agent (morpheus OK with its own key)', /^morpheus\nOK/.test(lbl('ST')));
  check('ask key names the agent', /morpheus/.test(lbl('AS')));

  // ask on morpheus, twice: second run continues the session
  hits.length = 0;
  press('ask', 'AS'); await sleep(3200);
  const run1 = hits.find((h) => h.path === '/v1/runs' && h.method === 'POST');
  check('ask goes to /p/morpheus/ with morpheus key', run1 && run1.agent === 'morpheus' && run1.auth === 'Bearer MORPHKEY-0123456789');
  check('first ask starts a new session', run1 && !JSON.parse(run1.body).session_id);
  check('polling stays on morpheus', hits.filter((h) => h.path.startsWith('/v1/runs/')).every((h) => h.agent === 'morpheus'));
  await sleep(4200);
  hits.length = 0;
  press('ask', 'AS'); await sleep(3200);
  const run2 = hits.find((h) => h.path === '/v1/runs' && h.method === 'POST');
  check('second ask continues the conversation', run2 && JSON.parse(run2.body).session_id === 'S1');
  await sleep(4200);

  // New chat forgets it, and opens the WebUI when set
  msgs.length = 0;
  press('session', 'NC'); await sleep(300);
  check('new chat flashes', /^new chat/.test(lbl('NC')) && !!last('NC', 'showOk'));
  check('new chat opens the WebUI when asked', msgs.some((m) => m.event === 'openUrl' && m.payload.url === 'http://127.0.0.1:8787'));
  hits.length = 0;
  press('ask', 'AS'); await sleep(3200);
  const run3 = hits.find((h) => h.path === '/v1/runs' && h.method === 'POST');
  check('after New chat, ask starts fresh', run3 && !JSON.parse(run3.body).session_id);
  await sleep(4200);

  // the_chef: no key of its own, Hermes refuses the main key
  press('agent', 'AG'); await sleep(700);
  check('agent key shows the_chef', /^the_chef/.test(lbl('AG')));
  check('status says the agent needs its own key', /^the_chef\nneeds key/.test(lbl('ST')));
  send({ event: 'sendToPlugin', action: P + 'status', context: 'X', payload: { cmd: 'test' } }); await sleep(800);
  check('test connection explains the per-agent key', /needs its own API_SERVER_KEY/.test(last('X', 'sendToPropertyInspector').payload.text));

  // wraps back to default
  press('agent', 'AG'); await sleep(700);
  check('agent key wraps back to default', /^default/.test(lbl('AG')) && !global.activeAgent);

  // invalid agent names are never used in a URL
  send({ event: 'didReceiveGlobalSettings', payload: { settings: { ...global, activeAgent: '../evil' } } }); await sleep(200);
  hits.length = 0; press('status', 'ST'); await sleep(500);
  check('invalid agent name ignored', hits.every((h) => !h.agent));

  child.kill(); for (const s of [hermes, dash, sd]) s.close();
  console.log(ok ? 'ALL PASS' : 'FAILURES'); process.exit(ok ? 0 : 1);
})();
