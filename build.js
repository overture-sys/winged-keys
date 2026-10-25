// Dependency-free "build": concatenates the two modules into plugin/index.js
const fs=require('fs'),path=require('path');
const ws=fs.readFileSync(path.join(__dirname,'src/wsclient.js'),'utf8');
const idx=fs.readFileSync(path.join(__dirname,'src/index.js'),'utf8').replace("require('./wsclient')","__WS__");
fs.writeFileSync(path.join(__dirname,'streamdock/com.wingedkeys.hermes.sdPlugin/plugin/index.js'),
 "const __WS__=(()=>{const module={exports:{}};\n"+ws+"\nreturn module.exports;})();\n"+idx);
fs.mkdirSync(path.join(__dirname,'elgato/com.wingedkeys.hermes.sdPlugin/plugin'),{recursive:true});
fs.copyFileSync(path.join(__dirname,'streamdock/com.wingedkeys.hermes.sdPlugin/plugin/index.js'),path.join(__dirname,'elgato/com.wingedkeys.hermes.sdPlugin/plugin/index.js'));
