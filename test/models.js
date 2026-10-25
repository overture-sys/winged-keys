// Simulated device tests: each "model" is a set of controller types the app reports.
// This checks the plugin's behavior per controller; it does not emulate real hardware rendering.
const http=require('http'),crypto=require('crypto'),{spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
let ok=true;const check=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n);if(!c)ok=false;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const analytics={totals:{total_input:100,total_output:50,total_cache_read:300,total_sessions:2,total_api_calls:4}};
const statusBody={gateway_running:true,active_agents:0,gateway_platforms:{api_server:{state:'connected',metrics:{metrics_today:{tokens:5000,requests:2,latency_p95_ms:1500}}}}};
const dash=http.createServer((q,r)=>{if(q.url==='/'){r.end('<script>window.__HERMES_SESSION_TOKEN__="T";</script>');return;}
 if(q.url.startsWith('/api/analytics/usage')){r.writeHead(q.headers.authorization==='Bearer T'?200:401,{'content-type':'application/json'});r.end(JSON.stringify(analytics));return;}
 if(q.url==='/api/status'){r.writeHead(200,{'content-type':'application/json'});r.end(JSON.stringify(statusBody));return;}r.writeHead(404);r.end();});
let runs=0;
const hermes=http.createServer((q,r)=>{let b='';q.on('data',d=>b+=d);q.on('end',()=>{const j=(c,o)=>{r.writeHead(c,{'content-type':'application/json'});r.end(JSON.stringify(o));};
 if(q.url==='/health')return j(200,{status:'ok'});if(q.url==='/v1/models')return j(200,{data:[]});
 if(q.url==='/v1/runs'&&q.method==='POST'){runs++;return j(200,{run_id:'r'+runs});}
 if(q.url.startsWith('/v1/runs/'))return j(200,{status:'completed',output:'ok'});j(404,{});});});
let sock;const msgs=[];
const sd=http.createServer();
const frame=s=>{const p=Buffer.from(s);const h=p.length<126?Buffer.from([0x81,p.length]):Buffer.from([0x81,126,p.length>>8,p.length&255]);return Buffer.concat([h,p]);};
sd.on('upgrade',(req,s)=>{const k=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
 s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+k+'\r\n\r\n');sock=s;let buf=Buffer.alloc(0);
 s.on('data',d=>{buf=Buffer.concat([buf,d]);for(;;){if(buf.length<2)return;let len=buf[1]&127,off=2;if(len===126){if(buf.length<4)return;len=buf.readUInt16BE(2);off=4;}if(buf.length<off+4+len)return;const m=buf.slice(off,off+4);const pl=Buffer.from(buf.slice(off+4,off+4+len).map((v,i)=>v^m[i%4]));if((buf[0]&15)===1){const mm=JSON.parse(pl.toString());msgs.push(mm);if(mm.event==='getSettings'&&stored[mm.context])setTimeout(()=>send({event:'didReceiveSettings',context:mm.context,payload:{settings:stored[mm.context]}}),10);}buf=buf.slice(off+4+len);}});});
const stored={};
const send=o=>sock.write(frame(JSON.stringify(o)));
const of=(c,ev)=>msgs.filter(m=>m.context===c&&(!ev||m.event===ev));
const last=(c,ev)=>of(c,ev).pop();
const P='com.wingedkeys.hermes.';
const MODELS=[
 {name:'Stream Dock M18 (keys)',ctrl:'Keypad'},
 {name:'Stream Dock 293V3 / 293S (keys)',ctrl:'Keypad'},
 {name:'Stream Dock N3 (knobs)',ctrl:'Knob'},
 {name:'Stream Dock N4 / N4 Pro (touch strip)',ctrl:'Information'},
 {name:'Stream Dock N4 / N4 Pro (knobs)',ctrl:'Knob'},
 {name:'Elgato Stream Deck / Mini / XL (keys)',ctrl:'Keypad'},
 {name:'Elgato Stream Deck+ (dials)',ctrl:'Encoder'},
];
(async()=>{
 await new Promise(r=>dash.listen(0,'127.0.0.1',r));await new Promise(r=>hermes.listen(0,'127.0.0.1',r));await new Promise(r=>sd.listen(0,'127.0.0.1',r));
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'wkm-'));
 const plugin=(process.env.PLUGIN||'streamdock/com.wingedkeys.hermes.sdPlugin')+'/plugin/index.js';
 const child=spawn('node',[plugin,'-port',sd.address().port,'-pluginUUID','UU','-registerEvent','registerPlugin','-info','{}'],{env:{...process.env,HOME:home,USERPROFILE:home,WINGEDKEYS_TEST_CLIPBOARD:''}});
 await sleep(400);
 send({event:'didReceiveGlobalSettings',payload:{settings:{baseUrl:'http://127.0.0.1:'+hermes.address().port,apiKey:'K',dashboardUrl:'http://127.0.0.1:'+dash.address().port,replyDir:path.join(home,'r')}}});
 await sleep(300);
 let i=0;
 for(const md of MODELS){
  const enc=md.ctrl==='Encoder';const tag='['+md.name+'] ';i++;
  const C=k=>md.ctrl+i+k;
  const appear=(k,settings)=>{stored[C(k)]=settings;send({event:'willAppear',action:P+k,context:C(k),payload:{settings,controller:md.ctrl,coordinates:{column:0,row:0}}});};
  appear('status',{});appear('usage',{metric:'cache'});appear('platforms',{});appear('ask',{prompt:'hi',label:'Hi'});
  await sleep(900);
  // display
  if(enc){
   check(tag+'status uses dial display',!!last(C('status'),'setFeedback')&&/OK/.test(JSON.stringify(last(C('status'),'setFeedback').payload))&&!last(C('status'),'setImage'));
   check(tag+'usage dial shows cache 75%',JSON.stringify(last(C('usage'),'setFeedback').payload).includes('75%'));
  } else {
   check(tag+'status key green OK',/OK/.test(last(C('status'),'setTitle').payload.title));
   check(tag+'usage shows cache 75%',decodeURIComponent(last(C('usage'),'setImage').payload.image).includes('>75%<'));
   check(tag+'platforms 1/1',decodeURIComponent(last(C('platforms'),'setImage').payload.image).includes('>1/1<'));
  }
  // press: key or knob press
  const pressEv=md.ctrl==='Keypad'||md.ctrl==='Information'?'keyDown':'dialDown';
  const before=runs;
  send({event:pressEv,action:P+'ask',context:C('ask'),payload:{controller:md.ctrl}});
  await sleep(3200);
  check(tag+pressEv+' on Ask starts a run',runs===before+1&&!!last(C('ask'),'showOk'));
  if(md.ctrl==='Knob'||enc){
   send({event:'dialRotate',action:P+'usage',context:C('usage'),payload:{ticks:1,pressed:false,controller:md.ctrl}});await sleep(600);
   const ss=last(C('usage'),'setSettings');
   check(tag+'turning the Usage dial changes metric (cache -> tokens)',ss&&ss.payload.metric==='alltokens');
   send({event:'dialRotate',action:P+'usage',context:C('usage'),payload:{ticks:-2,controller:md.ctrl}});await sleep(600);
   check(tag+'turning back wraps around',last(C('usage'),'setSettings').payload.metric==='active');
   send({event:'dialRotate',action:P+'ask',context:C('ask'),payload:{ticks:3}});await sleep(200);
   check(tag+'turning an Ask dial does nothing',!last(C('ask'),'setSettings'));
  }
  if(enc){
   const b2=runs;send({event:'touchTap',action:P+'ask',context:C('ask'),payload:{}});await sleep(3200);
   check(tag+'touch strip tap works like a press',runs===b2+1);
  }
 }
 // manifests
 const sdm=JSON.parse(fs.readFileSync('streamdock/com.wingedkeys.hermes.sdPlugin/manifest.json'));
 const elm=JSON.parse(fs.readFileSync('elgato/com.wingedkeys.hermes.sdPlugin/manifest.json'));
 check('Stream Dock manifest declares Keypad, Information, Knob on every action',sdm.Actions.every(a=>['Keypad','Information','Knob'].every(c=>a.Controllers.includes(c))));
 check('Elgato manifest declares Keypad and Encoder with a layout on every action',elm.Actions.every(a=>a.Controllers.includes('Encoder')&&a.Encoder&&a.Encoder.layout==='$A1'));
 check('Elgato action UUIDs are prefixed with the plugin UUID',elm.Actions.every(a=>a.UUID.startsWith(elm.UUID+'.')));
 check('Elgato image files exist (1x and @2x)',[elm.Icon,elm.CategoryIcon,...elm.Actions.flatMap(a=>[a.Icon,a.States[0].Image])].every(p=>fs.existsSync('elgato/com.wingedkeys.hermes.sdPlugin/'+p+'.png')&&fs.existsSync('elgato/com.wingedkeys.hermes.sdPlugin/'+p+'@2x.png')));
 child.kill();dash.close();hermes.close();sd.close();
 console.log(ok?'ALL PASS':'FAILURES');process.exit(ok?0:1);
})();
