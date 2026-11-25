'use strict';
const fs=require('node:fs'),path=require('node:path');
function load(file,initial){if(!fs.existsSync(file))return initial;return JSON.parse(fs.readFileSync(file,'utf8'));}
function save(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(data,null,2)+'\n',{mode:0o600});fs.renameSync(file+'.tmp',file);}
module.exports={load,save};
