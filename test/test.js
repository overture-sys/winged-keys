const http=require('http'),crypto=require('crypto'),{spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const out=[];let ok=true;const check=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n);if(!c)ok=false;};
// fake Hermes
let runState={n:0,stopped:false},auth=[];
let dashTok='TOK1';const sample={daily:[],totals:{total_input:14277,total_output:155,total_cache_read:14282,total_reasoning:0,total_sessions:1,total_api_calls:2},period_days:1};const daysSeen=[];
const dash=http.createServer((q,r)=>{if(q.url==='/'){r.writeHead(200,{'content-type':'text/html'});return r.end('<script>window.__HERMES_SESSION_TOKEN__="'+dashTok+'";</script>');}
 if(q.url.startsWith('/api/analytics/usage')){daysSeen.push(q.url.split('days=')[1]);if(q.headers.authorization!=='Bearer '+dashTok){r.writeHead(401);return r.end('{"detail":"Unauthorized"}');}r.writeHead(200,{'content-type':'application/json'});return r.end(JSON.stringify(sample));}
 if(q.url==='/api/status'){dashHits.push(q.headers.authorization||'none');r.writeHead(200,{'content-type':'application/json'});r.end(JSON.stringify(dashBody));}else{r.writeHead(401);r.end('{"detail":"Unauthorized"}');}});
const dashHits=[];let dashBody={active_agents:2,gateway_platforms:{api_server:{metrics:{metrics_today:{day:'2026-10-23',requests:3,messages:3,tokens:28714,latency_p95_ms:22802.64}}}}};
const hermes=http.createServer((req,res)=>{let b='';req.on('data',d=>b+=d);req.on('end',()=>{
 auth.push(req.url+':'+(req.headers.authorization||''));
 const j=(c,o)=>{res.writeHead(c,{'content-type':'application/json'});res.end(JSON.stringify(o));};
 if(req.url==='/health')return j(200,{status:'ok'});
 if(req.url==='/v1/models')return req.headers.authorization==='Bearer KEY'?j(200,{data:[]}):j(401,{});
 if(req.url==='/v1/runs'&&req.method==='POST'){runState.body=JSON.parse(b);return j(200,{run_id:'run_1',status:'started'});}
 if(req.url==='/v1/runs/run_1/stop'){runState.stopped=true;return j(200,{status:'stopping'});}
 if(req.url==='/v1/runs/run_1'){runState.n++;if(runState.approval&&runState.n<3)return j(200,{status:'waiting_for_approval',pending_controls:[{prompt_id:'p1',execution_generation:1}]});return j(200,{status:runState.stopped?'cancelled':runState.n<2?'running':'completed',output:'hello reply'});}
 j(404,{});});});
// fake Stream Dock
let sock;const msgs=[];const stored={A:{prompt:'say hi',label:'Hi',timeoutSec:30}};
const sd=http.createServer();
function frame(s){const p=Buffer.from(s);const h=p.length<126?Buffer.from([0x81,p.length]):Buffer.from([0x81,126,p.length>>8,p.length&255]);return Buffer.concat([h,p]);}
sd.on('upgrade',(req,s)=>{const k=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
 s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+k+'\r\n\r\n');sock=s;
 s.on('data',d=>{let o=0;while(o<d.length){let len=d[o+1]&127,off=o+2;if(len===126){len=d.readUInt16BE(o+2);off=o+4;}const m=d.slice(off,off+4);const pl=Buffer.from(d.slice(off+4,off+4+len).map((v,i)=>v^m[i%4]));if((d[o]&15)===1){const mm=JSON.parse(pl.toString());msgs.push(mm);if(mm.event==='getSettings'&&stored[mm.context])setTimeout(()=>send({event:'didReceiveSettings',context:mm.context,payload:{settings:stored[mm.context]}}),20);}o=off+4+len;}});});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const send=o=>sock.write(frame(JSON.stringify(o)));
const last=(ev,c)=>msgs.filter(m=>m.event===ev&&(!c||m.context===c)).pop();
(async()=>{
 await new Promise(r=>hermes.listen(0,'127.0.0.1',r));await new Promise(r=>dash.listen(0,'127.0.0.1',r));const dp=dash.address().port;await new Promise(r=>sd.listen(0,'127.0.0.1',r));
 const hp=hermes.address().port,sp=sd.address().port;
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'hk-'));
 const child=spawn('node',[(process.env.PLUGIN||'streamdock/com.wingedkeys.hermes.sdPlugin')+'/plugin/index.js','-port',sp,'-pluginUUID','UU','-registerEvent','registerPlugin','-info','{}'],{env:{...process.env,USERPROFILE:home,HOME:home,WINGEDKEYS_TEST_CLIPBOARD:'VENDOR EMAIL TEXT'}});
 child.stderr.on('data',d=>console.log('ERR',d+''));
 await sleep(500);
 check('registers',msgs.some(m=>m.event==='registerPlugin'&&m.uuid==='UU'));
 check('asks for global settings',msgs.some(m=>m.event==='getGlobalSettings'));
 send({event:'didReceiveGlobalSettings',payload:{settings:{baseUrl:'http://127.0.0.1:'+hp,apiKey:'KEY',replyDir:path.join(home,'r')}}});
 send({event:'willAppear',action:'com.wingedkeys.hermes.status',context:'S',payload:{settings:{}}});
 send({event:'willAppear',action:'com.wingedkeys.hermes.ask',context:'A',payload:{settings:{}}});
 send({event:'willAppear',action:'com.wingedkeys.hermes.stop',context:'X',payload:{settings:{}}});
 await sleep(800);
 check('status green OK',/OK/.test(last('setTitle','S').payload.title)&&decodeURIComponent(last('setImage','S').payload.image).includes('#2ecc71'));
 check('ask shows default label before settings',last('setTitle','A').payload.title==='Ask');
 // bad key
 send({event:'didReceiveGlobalSettings',payload:{settings:{baseUrl:'http://127.0.0.1:'+hp,apiKey:'WRONG'}}});await sleep(500);
 check('bad key amber',/bad key/.test(last('setTitle','S').payload.title));
 send({event:'didReceiveGlobalSettings',payload:{settings:{baseUrl:'http://127.0.0.1:'+hp,apiKey:''}}});await sleep(500);
 check('no key amber',/no key/.test(last('setTitle','S').payload.title));
 send({event:'didReceiveGlobalSettings',payload:{settings:{baseUrl:'http://127.0.0.1:1',apiKey:'KEY'}}});await sleep(800);
 check('off red',/off/.test(last('setTitle','S').payload.title)&&decodeURIComponent(last('setImage','S').payload.image).includes('#e74c3c'));
 send({event:'didReceiveGlobalSettings',payload:{settings:{baseUrl:'http://example.com:8642',apiKey:'KEY'}}});await sleep(500);
 check('remote refused',/local only/.test(last('setTitle','S').payload.title));
 const good={baseUrl:'http://127.0.0.1:'+hp,apiKey:'KEY',replyDir:path.join(home,'r')};
 send({event:'didReceiveGlobalSettings',payload:{settings:good}});await sleep(400);
 // ask success
 send({event:'keyDown',action:'com.wingedkeys.hermes.ask',context:'A',payload:{}});await sleep(5500);
 check('run started with prompt',runState.body&&runState.body.input==='say hi');
 check('auth header sent',auth.some(a=>a==='/v1/runs:Bearer KEY'));
 check('showOk sent',!!last('showOk','A'));
 const files=fs.existsSync(path.join(home,'r'))?fs.readdirSync(path.join(home,'r')):[];
 check('reply file written',files.length===1&&fs.readFileSync(path.join(home,'r',files[0]),'utf8').includes('hello reply'));
 // stop with nothing running
 msgs.length=0;send({event:'keyDown',action:'com.wingedkeys.hermes.stop',context:'X',payload:{}});await sleep(300);
 check('stop with nothing -> alert',!!last('showAlert','X'));
 // ask then stop
 runState.n=-10;
 await sleep(4500);
 send({event:'keyDown',action:'com.wingedkeys.hermes.ask',context:'A',payload:{}});await sleep(800);
 send({event:'keyDown',action:'com.wingedkeys.hermes.stop',context:'X',payload:{}});await sleep(2800);
 check('stop called',runState.stopped);
 check('stop ok',!!last('showOk','X'));
 check('ask shows stopped',msgs.filter(m=>m.event==='setTitle'&&m.context==='A').some(m=>m.payload.title==='stopped'));
 check('key never in a sent message',!JSON.stringify(msgs).includes('"KEY"')&&!JSON.stringify(msgs).includes('Bearer'));
 // usage keys
 msgs.length=0;
 const g2={...good,dashboardUrl:'http://127.0.0.1:'+dp};
 send({event:'didReceiveGlobalSettings',payload:{settings:g2}});
 send({event:'willAppear',action:'com.wingedkeys.hermes.usage',context:'U1',payload:{settings:{metric:'tokens'}}});
 send({event:'willAppear',action:'com.wingedkeys.hermes.usage',context:'U2',payload:{settings:{metric:'latency'}}});
 send({event:'willAppear',action:'com.wingedkeys.hermes.usage',context:'U3',payload:{settings:{metric:'active'}}});
 send({event:'willAppear',action:'com.wingedkeys.hermes.usage',context:'U4',payload:{settings:{}}});
 await sleep(900);
 check('usage tokens 28.7k',last('setTitle','U1').payload.title==='API tokens'&&decodeURIComponent(last('setImage','U1').payload.image).includes('>28.7k<'));
 check('usage latency 22.8s',decodeURIComponent(last('setImage','U2').payload.image).includes('>22.8s<'));
 check('usage active 2 blue',decodeURIComponent(last('setImage','U3').payload.image).includes('>2<')&&decodeURIComponent(last('setImage','U3').payload.image).includes('#3498db'));
 check('usage default metric tokens',last('setTitle','U4').payload.title==='API tokens');
 check('API key never sent to dashboard',dashHits.every(h=>h==='none'));
 send({event:'didReceiveGlobalSettings',payload:{settings:{...good,dashboardUrl:'http://127.0.0.1:1'}}});await sleep(700);
 check('dashboard off shows red',last('setTitle','U1').payload.title==='press:start'&&decodeURIComponent(last('setImage','U1').payload.image).includes('#e74c3c'));
 dashBody={gateway_platforms:{}};send({event:'didReceiveGlobalSettings',payload:{settings:g2}});await sleep(700);
 check('missing metrics shows 0',decodeURIComponent(last('setImage','U1').payload.image).includes('>0<'));
 send({event:'didReceiveGlobalSettings',payload:{settings:{...good,dashboardUrl:'http://example.com:9119'}}});await sleep(600);
 check('remote dashboard refused',last('setTitle','U1').payload.title==='local only');
 dashBody={gateway_platforms:{}};
 send({event:'didReceiveGlobalSettings',payload:{settings:g2}});
 send({event:'willAppear',action:'com.wingedkeys.hermes.usage',context:'C1',payload:{settings:{metric:'cache'}}});
 send({event:'willAppear',action:'com.wingedkeys.hermes.usage',context:'C2',payload:{settings:{metric:'alltokens',days:'7'}}});
 send({event:'willAppear',action:'com.wingedkeys.hermes.usage',context:'C3',payload:{settings:{metric:'sessions'}}});
 await sleep(900);
 check('cache hit 50%',decodeURIComponent(last('setImage','C1').payload.image).includes('>50%<')&&last('setTitle','C1').payload.title==='Cache hit\ntoday');
 check('all tokens 28.7k over 7 days',decodeURIComponent(last('setImage','C2').payload.image).includes('>28.7k<')&&last('setTitle','C2').payload.title==='Tokens\n7 days'&&daysSeen.includes('7'));
 check('sessions 1',decodeURIComponent(last('setImage','C3').payload.image).includes('>1<'));
 dashTok='TOK2';send({event:'keyDown',action:'com.wingedkeys.hermes.usage',context:'C1',payload:{}});await sleep(700);
 check('token refreshed after restart',decodeURIComponent(last('setImage','C1').payload.image).includes('>50%<'));
 check('dashboard token never shown or sent to Stream Dock',!JSON.stringify(msgs).includes('TOK1')&&!JSON.stringify(msgs).includes('TOK2'));
 check('Hermes API key never sent to dashboard (analytics)',!dashHits.includes('Bearer KEY'));
 // auto-start: dashboard down; fake hermes "exe" starts it on the requested port
 const fake=path.join(home,'fakehermes.js');
 fs.writeFileSync(fake,"const http=require('http');const a=process.argv;const port=a[a.indexOf('--port')+1];require('fs').writeFileSync(process.argv[1]+'.args',a.slice(2).join(' '));http.createServer((q,r)=>{r.writeHead(200,{'content-type':'application/json'});r.end(JSON.stringify({gateway_platforms:{api_server:{metrics:{metrics_today:{tokens:1234}}}}}));}).listen(port,'127.0.0.1');setTimeout(()=>process.exit(0),8000);");
 const wrapper=path.join(home,'fakehermes.sh');fs.writeFileSync(wrapper,'#!/bin/sh\nexec node '+fake+' "$@"\n');fs.chmodSync(wrapper,0o755);
 const freePort=await new Promise(r=>{const sv=http.createServer().listen(0,'127.0.0.1',()=>{const p=sv.address().port;sv.close(()=>r(p));});});
 send({event:'didReceiveGlobalSettings',payload:{settings:{...good,dashboardUrl:'http://127.0.0.1:'+freePort,hermesExe:wrapper}}});
 send({event:'willAppear',action:'com.wingedkeys.hermes.usage',context:'D1',payload:{settings:{metric:'tokens'}}});
 await sleep(600);
 check('off key says press to start',last('setTitle','D1').payload.title==='press:start');
 send({event:'keyDown',action:'com.wingedkeys.hermes.usage',context:'D1',payload:{}});
 await sleep(5000);
 check('dashboard started with fixed args',fs.existsSync(fake+'.args')&&fs.readFileSync(fake+'.args','utf8')==='dashboard --no-open --port '+freePort);
 check('key shows value after start',decodeURIComponent(last('setImage','D1').payload.image).includes('>1.2k<'));
 // auto-start off
 send({event:'didReceiveGlobalSettings',payload:{settings:{...good,dashboardUrl:'http://127.0.0.1:1',hermesExe:wrapper,autoStartDashboard:false}}});await sleep(400);
 msgs.length=0;send({event:'keyDown',action:'com.wingedkeys.hermes.usage',context:'D1',payload:{}});await sleep(800);

 check('auto-start off does not start',!msgs.some(m=>m.event==='setTitle'&&m.payload.title==='starting'));
 // platforms
 dashBody={gateway_platforms:{api_server:{state:'connected'},'morpheus:discord':{state:'connected'},'morpheus:telegram':{state:'connected'},'the_chef:telegram':{state:'connected'}}};
 send({event:'didReceiveGlobalSettings',payload:{settings:g2}});
 send({event:'willAppear',action:'com.wingedkeys.hermes.platforms',context:'P1',payload:{settings:{}}});await sleep(700);
 check('platforms 4/4 green',decodeURIComponent(last('setImage','P1').payload.image).includes('>4/4<')&&decodeURIComponent(last('setImage','P1').payload.image).includes('#2ecc71'));
 dashBody.gateway_platforms['morpheus:discord'].state='reconnecting';
 send({event:'keyDown',action:'com.wingedkeys.hermes.platforms',context:'P1',payload:{}});await sleep(700);
 check('platforms 3/4 red names discord',decodeURIComponent(last('setImage','P1').payload.image).includes('>3/4<')&&/discord/.test(last('setTitle','P1').payload.title));
 // clipboard ask
 runState={n:0,stopped:false};stored.A={prompt:'Summarize this',label:'Clip',timeoutSec:30,useClipboard:true};
 send({event:'keyDown',action:'com.wingedkeys.hermes.ask',context:'A',payload:{}});await sleep(5500);
 check('clipboard appended to prompt',runState.body&&runState.body.input==='Summarize this\n\n---\nVENDOR EMAIL TEXT');
 // approval waiting
 runState={n:0,stopped:false,approval:true};stored.A={prompt:'do thing',label:'Do',timeoutSec:30};msgs.length=0;
 send({event:'keyDown',action:'com.wingedkeys.hermes.ask',context:'A',payload:{}});await sleep(4500);
 check('ask shows needs OK while waiting',msgs.some(m=>m.event==='setTitle'&&m.context==='A'&&m.payload.title==='needs OK'));
 check('no approval sent automatically',!auth.some(a=>a.includes('/approval')));
 await sleep(4000);
 check('ask finishes after approval elsewhere',!!last('showOk','A'));
 // open keys
 msgs.length=0;
 send({event:'willAppear',action:'com.wingedkeys.hermes.open',context:'O1',payload:{settings:{target:'webui'}}});
 send({event:'willAppear',action:'com.wingedkeys.hermes.open',context:'O2',payload:{settings:{target:'url',url:'javascript:alert(1)'}}});
 send({event:'willAppear',action:'com.wingedkeys.hermes.open',context:'O3',payload:{settings:{target:'reply'}}});
 send({event:'willAppear',action:'com.wingedkeys.hermes.open',context:'O4',payload:{settings:{target:'dashboard'}}});
 await sleep(300);
 for (const c of ['O1','O2','O3','O4']) send({event:'keyDown',action:'com.wingedkeys.hermes.open',context:c,payload:{}});
 await sleep(600);
 const opens=msgs.filter(m=>m.event==='openUrl').map(m=>m.payload.url);
 check('open webui default url',opens.includes('http://127.0.0.1:8787'));
 check('open dashboard url',opens.includes('http://127.0.0.1:'+dp));
 check('open refuses non-web address',!!last('showAlert','O2')&&!opens.some(u=>u.startsWith('javascript')));
 check('open latest reply finds file',!!last('showOk','O3'));
 // setup helpers
 const envFile=path.join(home,'.env');
 fs.writeFileSync(envFile,'# hermes\nOTHER_SECRET=nope\nAPI_SERVER_ENABLED=true\nAPI_SERVER_KEY="KEY"\n');
 dashBody={gateway_running:true,env_path:'\\\\evil\\share\\.env',gateway_platforms:{api_server:{state:'connected',listener_base:'http://127.0.0.1:'+hp}}};
 send({event:'didReceiveGlobalSettings',payload:{settings:{dashboardUrl:'http://127.0.0.1:'+dp,envPath:envFile}}});await sleep(300);
 msgs.length=0;
 send({event:'sendToPlugin',action:'com.wingedkeys.hermes.status',context:'S',payload:{cmd:'detect'}});await sleep(500);
 const det=last('sendToPropertyInspector');
 check('detect finds API address',det&&det.payload.ok&&det.payload.text.includes('127.0.0.1:'+hp)&&det.context==='S');
 check('detect only proposes (nothing saved yet)',!msgs.some(m=>m.event==='setGlobalSettings')&&det.payload.found==='http://127.0.0.1:'+hp);
 send({event:'sendToPlugin',action:'com.wingedkeys.hermes.status',context:'S',payload:{cmd:'useAddress',address:'http://127.0.0.1:9'}});await sleep(300);
 check('a different address than proposed is refused',!msgs.some(m=>m.event==='setGlobalSettings'));
 send({event:'sendToPlugin',action:'com.wingedkeys.hermes.status',context:'S',payload:{cmd:'useAddress',address:'http://127.0.0.1:'+hp}});await sleep(300);
 check('confirmed address is saved',msgs.some(m=>m.event==='setGlobalSettings'&&m.payload.baseUrl==='http://127.0.0.1:'+hp));
 msgs.length=0;
 send({event:'sendToPlugin',action:'com.wingedkeys.hermes.status',context:'S',payload:{cmd:'test'}});await sleep(800);
 const t1=last('sendToPropertyInspector');
 check('test says no key',t1&&!t1.payload.ok&&/No API key/.test(t1.payload.text));
 msgs.length=0;
 send({event:'sendToPlugin',action:'com.wingedkeys.hermes.status',context:'S',payload:{cmd:'readKey'}});await sleep(500);
 const rk=last('sendToPropertyInspector');
 check('read key ok',rk&&rk.payload.ok&&rk.payload.text.includes(envFile));
 check('read key saves only the API key',msgs.some(m=>m.event==='setGlobalSettings'&&m.payload.apiKey==='KEY')&&!JSON.stringify(msgs).includes('nope'));
 check('read key never sent to settings panel text',!/KEY/.test(rk.payload.text.replace(/API_SERVER_KEY/g,'')));
 msgs.length=0;
 send({event:'sendToPlugin',action:'com.wingedkeys.hermes.status',context:'S',payload:{cmd:'test'}});await sleep(800);
 const t2=last('sendToPropertyInspector');
 check('test all OK after read',t2&&t2.payload.ok&&/API key accepted/.test(t2.payload.text));
 // API off explanation
 dashBody={gateway_running:true,gateway_platforms:{}};
 send({event:'didReceiveGlobalSettings',payload:{settings:{dashboardUrl:'http://127.0.0.1:'+dp,baseUrl:'http://127.0.0.1:1',apiKey:'KEY',envPath:envFile}}});await sleep(900);
 check('status explains API off',/API off/.test(last('setTitle','S').payload.title));
 fs.writeFileSync(envFile,'API_SERVER_ENABLED=false\n');
 send({event:'sendToPlugin',action:'com.wingedkeys.hermes.status',context:'S',payload:{cmd:'readKey'}});await sleep(500);
 check('read key missing explained',/No API_SERVER_KEY/.test(last('sendToPropertyInspector').payload.text));
 // ---- security review regressions
 // network .env path refused
 send({event:'didReceiveGlobalSettings',payload:{settings:{...good,envPath:'\\\\evil\\share\\.env'}}});await sleep(200);
 send({event:'sendToPlugin',action:'com.wingedkeys.hermes.status',context:'S',payload:{cmd:'readKey'}});await sleep(400);
 check('network .env path refused',/network paths are not allowed/.test(last('sendToPropertyInspector').payload.text));
 // Find Hermes refuses a listener that isn't Hermes
 const bogus=http.createServer((q,r)=>{r.writeHead(200);r.end('hello');});await new Promise(r=>bogus.listen(0,'127.0.0.1',r));
 dashBody={gateway_running:true,gateway_platforms:{api_server:{state:'connected',listener_base:'http://127.0.0.1:'+bogus.address().port}}};
 send({event:'didReceiveGlobalSettings',payload:{settings:{...good,dashboardUrl:'http://127.0.0.1:'+dp}}});await sleep(200);msgs.length=0;
 send({event:'sendToPlugin',action:'com.wingedkeys.hermes.status',context:'S',payload:{cmd:'detect'}});await sleep(600);
 check('Find Hermes refuses a fake API address',/Not saved/.test(last('sendToPropertyInspector').payload.text)&&!msgs.some(m=>m.event==='setGlobalSettings'));
 // redirects refused
 let leaked=false;const sink=http.createServer((q,r)=>{leaked=true;r.end('{}');});await new Promise(r=>sink.listen(0,'127.0.0.1',r));
 const redir=http.createServer((q,r)=>{r.writeHead(307,{location:'http://127.0.0.1:'+sink.address().port+q.url});r.end();});await new Promise(r=>redir.listen(0,'127.0.0.1',r));
 stored.A={prompt:'secret prompt',label:'R',timeoutSec:30};
 send({event:'didReceiveGlobalSettings',payload:{settings:{...good,baseUrl:'http://127.0.0.1:'+redir.address().port}}});await sleep(200);
 send({event:'keyDown',action:'com.wingedkeys.hermes.ask',context:'A',payload:{}});await sleep(2500);
 check('redirects are not followed (nothing reaches the other server)',!leaked);
 // remote over plain http refused even when remote is allowed
 send({event:'didReceiveGlobalSettings',payload:{settings:{...good,baseUrl:'http://example.com:8642',allowRemote:true}}});await sleep(200);
 send({event:'keyDown',action:'com.wingedkeys.hermes.status',context:'S',payload:{}});await sleep(600);
 check('remote http refused (https required)',/local only/.test(last('setTitle','S').payload.title));
 // double press: only one run, and Stop stops it
 runState={n:-100,stopped:false};stored.A={prompt:'long job',label:'L',timeoutSec:30};let posts=0;
 const countPosts=(req)=>{if(req.method==='POST'&&req.url==='/v1/runs')posts++;};hermes.on('request',countPosts);
 send({event:'didReceiveGlobalSettings',payload:{settings:good}});await sleep(200);
 send({event:'keyDown',action:'com.wingedkeys.hermes.ask',context:'A',payload:{}});
 send({event:'keyDown',action:'com.wingedkeys.hermes.ask',context:'A',payload:{}});
 await sleep(1500);
 check('two fast presses start only one run',posts===1);
 send({event:'keyDown',action:'com.wingedkeys.hermes.stop',context:'X',payload:{}});await sleep(2800);
 check('Stop stops that run',runState.stopped);
 // stop request fails -> Ask key doesn't claim "stopped"
 runState={n:-100,stopped:false};msgs.length=0;
 const failStop=(req,res)=>{};
 send({event:'keyDown',action:'com.wingedkeys.hermes.ask',context:'A',payload:{}});await sleep(2600);
 const origStop=runState;hermes.removeAllListeners('request');
 hermes.on('request',(req,res)=>{let b='';req.on('data',d=>b+=d);req.on('end',()=>{if(req.url.endsWith('/stop')){res.writeHead(500);return res.end('{}');}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(req.url==='/health'?{status:'ok'}:{status:'running'}));});});
 send({event:'keyDown',action:'com.wingedkeys.hermes.stop',context:'X',payload:{}});await sleep(2500);
 check('failed stop: Stop alerts and Ask does not say stopped',!!last('showAlert','X')&&!msgs.some(m=>m.event==='setTitle'&&m.context==='A'&&m.payload.title==='stopped'));
 hermes.off('request',countPosts);bogus.close();sink.close();redir.close();
 msgs.length=0;send({event:'sendToPlugin',action:'com.wingedkeys.hermes.status',context:'S',payload:{cmd:'support'}});await sleep(300);
 check('support link opens Ko-fi only',msgs.some(m=>m.event==='openUrl'&&m.payload.url==='https://ko-fi.com/overturesys'));
 child.kill();hermes.close();dash.close();sd.close();
 console.log(ok?'ALL PASS':'FAILURES');process.exit(ok?0:1);
})();
