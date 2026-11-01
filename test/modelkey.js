// Model key: steps through Hermes's default and the listed models; Ask runs carry the chosen model.
const http = require('http'), crypto = require('crypto'), { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
let ok = true; const check = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) ok = false; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fake Hermes API: records run bodies; finished runs report the provider/model that "answered"
const runBodies = []; let n = 0; const runs = {};
const hermes = http.createServer((q, r) => { let b = ''; q.on('data', (d) => (b += d)); q.on('end', () => {
  const j = (c, o) => { r.writeHead(c, { 'content-type': 'application/json' }); r.end(JSON.stringify(o)); };
  if (q.url === '/health') return j(200, { status: 'ok' });
  if (q.headers.authorization !== 'Bearer K') return j(401, {});
  if (q.url === '/v1/models') return j(200, { data: [] });
  if (q.url === '/v1/runs' && q.method === 'POST') { const body = JSON.parse(b); runBodies.push(body); const id = 'run_' + (++n); runs[id] = body; return j(200, { run_id: id }); }
  const rm = q.url.match(/^\/v1\/runs\/([^/]+)$/);
  if (rm && runs[rm[1]]) { const rb = runs[rm[1]]; return j(200, { status: 'completed', output: 'ok', runtime: { provider: rb.provider || 'nous', model: rb.model || 'hermes-default', route_source: rb.model ? 'raw_request' : 'global' } }); }
  j(404, {});
}); });
const dash = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ gateway_running: true, gateway_platforms: {} })); });

let sock; const msgs = []; const stored = {}; let global = {};
const sd = http.createServer();
const frame = (s) => { const p = Buffer.from(s); const h = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]); return Buffer.concat([h, p]); };
sd.on('upgrade', (req, s) => {
  const k = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + k + '\r\n\r\n'); sock = s; let buf = Buffer.alloc(0);
  s.on('data', (d) => { buf = Buffer.concat([buf, d]); for (;;) { if (buf.length < 2) return; let len = buf[1] & 127, off = 2; if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; } if (buf.length < off + 4 + len) return; const op = buf[0] & 15; const mk = buf.slice(off, off + 4); const pl = Buffer.from(buf.slice(off + 4, off + 4 + len).map((v, i) => v ^ mk[i % 4])); buf = buf.slice(off + 4 + len); if (op === 1) { const mm = JSON.parse(pl.toString()); msgs.push(mm); if (mm.event === 'getSettings' && stored[mm.context]) setTimeout(() => send({ event: 'didReceiveSettings', context: mm.context, payload: { settings: stored[mm.context] } }), 10); if (mm.event === 'setGlobalSettings') { global = mm.payload; setTimeout(() => send({ event: 'didReceiveGlobalSettings', payload: { settings: global } }), 10); } } } });
});
const send = (o) => sock.write(frame(JSON.stringify(o)));
const last = (c, ev) => msgs.filter((m) => m.context === c && m.event === ev).pop();
const lbl = (c) => { const im = last(c, 'setImage'); const m = im && decodeURIComponent(im.payload.image).match(/data-label="([^"]*)"/); return m ? m[1] : ''; };
const P = 'com.wingedkeys.hermes.';
const appear = (k, ctxId, settings, controller) => { stored[ctxId] = settings; send({ event: 'willAppear', action: P + k, context: ctxId, payload: { settings, controller } }); };
const press = (k, ctxId) => send({ event: 'keyDown', action: P + k, context: ctxId, payload: {} });
const turn = (k, ctxId, ticks) => send({ event: 'dialRotate', action: P + k, context: ctxId, payload: { ticks } });
const setGlobals = async (patch) => { global = { ...global, ...patch }; send({ event: 'didReceiveGlobalSettings', payload: { settings: global } }); await sleep(250); };
const latestReply = (dir) => { const f = fs.readdirSync(dir).sort().pop(); return f ? fs.readFileSync(path.join(dir, f), 'utf8') : ''; };

(async () => {
  for (const s of [hermes, dash, sd]) await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wkmk-'));
  const replies = path.join(home, 'r');
  const plugin = (process.env.PLUGIN || 'streamdock/com.wingedkeys.hermes.sdPlugin') + '/plugin/index.js';
  const child = spawn('node', [plugin, '-port', sd.address().port, '-pluginUUID', 'UU', '-registerEvent', 'registerPlugin', '-info', '{}'], { env: { ...process.env, HOME: home, USERPROFILE: home, WINGEDKEYS_TEST_CLIPBOARD: '' } });
  await sleep(400);
  await setGlobals({ baseUrl: 'http://127.0.0.1:' + hermes.address().port, apiKey: 'K', dashboardUrl: 'http://127.0.0.1:' + dash.address().port, replyDir: replies });

  appear('model', 'MD', {}); appear('ask', 'AS', { prompt: 'hi', label: 'Ask', timeoutSec: 30 }); appear('model', 'DIAL', {}, 'Encoder');
  await sleep(500);
  check('model key starts on Hermes default', /^default\nmodel/.test(lbl('MD')));
  check('model dial uses the dial display', !!last('DIAL', 'setFeedback') && !last('DIAL', 'setImage'));

  // no models listed: pressing warns and changes nothing
  msgs.length = 0;
  press('model', 'MD'); await sleep(300);
  check('no models listed: key says so and alerts', /^no models/.test(lbl('MD')) && !!last('MD', 'showAlert'));
  check('no models listed: nothing saved', !msgs.some((m) => m.event === 'setGlobalSettings'));
  await sleep(2600);

  // default: Ask sends no model at all
  press('ask', 'AS'); await sleep(3200);
  check('default: ask sends no model or provider', runBodies.length === 1 && !('model' in runBodies[0]) && !('provider' in runBodies[0]));
  check('reply file names the model that answered', /\*\*Model:\*\* nous \/ hermes-default/.test(latestReply(replies)));
  await sleep(4200);

  // list: invalid lines dropped, duplicates removed
  await setGlobals({ models: 'openrouter:anthropic/claude-sonnet-4.6\r\nclaude-sonnet-4\nbad model name\n"><script>\nclaude-sonnet-4\n' });
  press('model', 'MD'); await sleep(400);
  check('press 1: picks openrouter:anthropic/claude-sonnet-4.6', global.activeModel === 'openrouter:anthropic/claude-sonnet-4.6' && !!last('MD', 'showOk'));
  check('key shows the short model name', /^claude-sonnet-4\.6\nmodel/.test(lbl('MD')));
  check('every Model key follows (dial too)', /claude-sonnet-4\.6/.test(JSON.stringify(last('DIAL', 'setFeedback').payload)));
  press('ask', 'AS'); await sleep(3200);
  const b1 = runBodies[runBodies.length - 1];
  check('ask sends provider and model separately', b1.provider === 'openrouter' && b1.model === 'anthropic/claude-sonnet-4.6' && b1.input === 'hi');
  check('reply file names the answering model', /\*\*Model:\*\* openrouter \/ anthropic\/claude-sonnet-4\.6/.test(latestReply(replies)));
  await sleep(4200);

  press('model', 'MD'); await sleep(400);
  check('press 2: bare model name', global.activeModel === 'claude-sonnet-4' && /^claude-sonnet-4\nmodel/.test(lbl('MD')));
  press('ask', 'AS'); await sleep(3200);
  const b2 = runBodies[runBodies.length - 1];
  check('bare model: model only, no provider', b2.model === 'claude-sonnet-4' && !('provider' in b2));
  await sleep(4200);

  press('model', 'MD'); await sleep(400);
  check('press 3: invalid and duplicate lines skipped, wraps to default', global.activeModel === '' && /^default/.test(lbl('MD')));

  // dial: turning steps both ways
  turn('model', 'DIAL', -1); await sleep(400);
  check('dial left from default goes to the last model', global.activeModel === 'claude-sonnet-4');
  turn('model', 'DIAL', 2); await sleep(400);
  check('dial right wraps past default', global.activeModel === 'openrouter:anthropic/claude-sonnet-4.6');

  // test connection names the model
  send({ event: 'sendToPlugin', action: P + 'model', context: 'X', payload: { cmd: 'test' } }); await sleep(600);
  check('test connection names the chosen model', /model "openrouter:anthropic\/claude-sonnet-4\.6"/.test(last('X', 'sendToPropertyInspector').payload.text));

  // a model removed from the list is no longer sent
  await setGlobals({ models: 'claude-sonnet-4' });
  check('removed model falls back to default on the key', /^default/.test(lbl('MD')));
  press('ask', 'AS'); await sleep(3200);
  check('removed model is not sent', !('model' in runBodies[runBodies.length - 1]));
  await sleep(4200);

  // a hand-edited bad value is never sent
  await setGlobals({ models: 'claude-sonnet-4', activeModel: 'x y' });
  press('ask', 'AS'); await sleep(3200);
  check('invalid active model ignored', !('model' in runBodies[runBodies.length - 1]));

  // manifests
  const sdm = JSON.parse(fs.readFileSync('streamdock/com.wingedkeys.hermes.sdPlugin/manifest.json'));
  const elm = JSON.parse(fs.readFileSync('elgato/com.overturesys.wingedkeys.sdPlugin/manifest.json'));
  const sa = sdm.Actions.find((a) => a.UUID === P + 'model'), ea = elm.Actions.find((a) => a.UUID === elm.UUID + '.model');
  check('Stream Dock manifest has the Model action and its icon', !!sa && fs.existsSync('streamdock/com.wingedkeys.hermes.sdPlugin/' + sa.Icon));
  check('Elgato manifest has the Model action with dial push and rotate', !!ea && ea.Encoder && ea.Encoder.TriggerDescription.Push && ea.Encoder.TriggerDescription.Rotate);

  child.kill(); for (const s of [hermes, dash, sd]) s.close();
  console.log(ok ? 'ALL PASS' : 'FAILURES'); process.exit(ok ? 0 : 1);
})();
