// Dependency-free "build": bundles src/ into one plugin/index.js for both builds.
const fs=require('fs'),path=require('path');
const src=(f)=>fs.readFileSync(path.join(__dirname,'src',f),'utf8');
const mod=(name,code)=>"const "+name+"=(()=>{const module={exports:{}};\n"+code+"\nreturn module.exports;})();\n";
const glyphs="const __GLYPHS__="+src('cinzel-glyphs.json').trim()+";\n";
const face=src('face.js').replace("require('./cinzel-glyphs.json')","__GLYPHS__");
const idx=src('index.js').replace("require('./wsclient')","__WS__").replace("require('./face')","__FACE__");
const out=glyphs+mod('__WS__',src('wsclient.js'))+mod('__FACE__',face)+idx;
for (const b of ['streamdock','elgato']) {
  const dir=path.join(__dirname,b,'com.wingedkeys.hermes.sdPlugin');
  fs.mkdirSync(path.join(dir,'plugin'),{recursive:true});
  fs.writeFileSync(path.join(dir,'plugin','index.js'),out);
  fs.copyFileSync(path.join(__dirname,'src','Cinzel-OFL.txt'),path.join(dir,'Cinzel-OFL.txt'));
}
