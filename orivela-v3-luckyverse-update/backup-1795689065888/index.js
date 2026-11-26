'use strict';
require('dotenv').config();
process.env.TZ='Asia/Jakarta';
require('node:dns').setDefaultResultOrder('ipv4first');
const B=require('./shared');
// Both adapters intentionally run in one process: never run another instance using these files.
const wa=require('./wa/orivela-main-fixed');
if(process.env.DISCORD_ENABLED!=='false'){try{require('./discord/index');}catch(e){console.error('Discord gagal start:',e.message);if(process.env.WA_ENABLED!=='true')process.exit(1);}}
if(process.env.WA_ENABLED==='true'){
 const connect=()=>wa.connect().catch(e=>{console.error('WA startup gagal:',e.message);setTimeout(connect,30000);});connect();
}else console.log('WA dinonaktifkan (.env WA_ENABLED=false); Discord dapat diuji dahulu.');
setInterval(()=>B.flush().catch(e=>console.error('Outbox:',e.message)),15000);
const backup=require('./backup');backup();setInterval(backup,60*60000);
console.log('ORIVELA V3 · Unified trial · Satu proses, jangan jalankan instance kedua.');
