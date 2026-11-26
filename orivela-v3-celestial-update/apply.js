'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),manifest=require('./manifest.json');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const get=f=>fs.existsSync(f)?fs.readFileSync(f):null;
const hash=b=>b===null?null:digest(b);
const atomic=(f,b)=>{fs.mkdirSync(path.dirname(f),{recursive:true});const tmp=f+'.orivela-update.tmp';fs.writeFileSync(tmp,b);fs.renameSync(tmp,f);};
try{
 if(!fs.existsSync(path.join(root,'index.js'))||!fs.existsSync(path.join(root,'package.json')))throw Error('Folder update harus diextract di folder utama bot (/home/container).');
 const pending=[];
 for(const m of manifest){const dest=path.join(root,m.path),current=get(dest),src=fs.readFileSync(path.join(__dirname,'files',m.path));if(hash(src)!==m.new)throw Error('File patch rusak: '+m.path);if(hash(current)===m.new)continue;if(!m.old.includes(hash(current)))throw Error('File berbeda dari V3 yang dikenal: '+m.path+'. Tidak ada file yang diubah. Hubungi pembuat patch.');pending.push({m,dest,current,src});}
 if(!pending.length){console.log('ORIVELA Celestial Update: sudah terpasang.');process.exit(0);}
 const backup=path.join(__dirname,'backup-'+Date.now());for(const p of pending){if(p.current!==null){const f=path.join(backup,p.m.path);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,p.current);}}
 const done=[];try{for(const p of pending){atomic(p.dest,p.src);done.push(p);}}catch(e){for(const p of done.reverse()){if(p.current===null)fs.rmSync(p.dest,{force:true});else atomic(p.dest,p.current);}throw e;}
 console.log('ORIVELA Celestial Update OK — '+pending.length+' file diperbarui. Backup kode: '+backup);console.log('Setelah online jalankan /setup di Discord.');
}catch(e){console.error('ORIVELA update gagal:',e.message);process.exitCode=1;}
