'use strict';
const fs=require('node:fs'),path=require('node:path'),C=require('./discord/lib/core');
const root=__dirname,dir=path.join(root,'backups');
const files=['shared-data/state.json','discord/data/runtime/store.json','wa/data/orders.json','wa/data/order-admin-locks.json','wa/data/promotions.json','wa/data/qris-invoices.json','wa/data/store-schedule-state.json','wa/data/luckyverse.json'];
function snapshot(){const data={version:1,createdAt:new Date().toISOString(),files:{}};for(const f of files){const p=path.join(root,f);if(fs.existsSync(p)){data.files[f]=JSON.parse(fs.readFileSync(p,'utf8'));if(f==='shared-data/state.json')data.files[f].codes={};}}return data;}
function backup(){try{const day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Jakarta',dateStyle:'short'}).format(new Date());const dest=path.join(dir,day+'.json');if(!fs.existsSync(dest)){C.atomic(dest,snapshot());const old=fs.readdirSync(dir).filter(x=>/^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort();for(const f of old.slice(0,-7))fs.unlinkSync(path.join(dir,f));}}catch(e){console.error('Backup harian:',e.message);}}
module.exports=backup;module.exports.snapshot=snapshot;
