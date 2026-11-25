'use strict';
const fs=require('node:fs'),path=require('node:path');
const MIN=60000;
function minutes(s){if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(s))throw Error('Gunakan format HH:MM (contoh 10:00).');return +s.slice(0,2)*60 + +s.slice(3);}
function isOpen(schedule,now=new Date()){
 if(schedule.mode==='open')return true;if(['close','maintenance'].includes(schedule.mode))return false;
 const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Jakarta',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
 const n=+parts.find(p=>p.type==='hour').value*60 + +parts.find(p=>p.type==='minute').value,a=minutes(schedule.open),b=minutes(schedule.close);
 return a===b?true:a<b?n>=a&&n<b:n>=a||n<b;
}
function atomic(file,obj){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(obj,null,2)+'\n',{mode:0o600});fs.renameSync(file+'.tmp',file);}
function load(file,fallback){return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):fallback;}
function expire(t,now=Date.now()){if(t.status==='waiting'&&now>=t.expiresAt){t.status='expired';return true;}return false;}
function promoAvailable(p,tickets,now=Date.now()){return !p.ended&&p.endsAt>now&&tickets.filter(t=>t.promoId===p.id&&!['cancelled','expired'].includes(t.status)).length<p.slots;}
function priceFor(row,promo,voucher){if(promo&&voucher)throw Error('Promo tidak dapat digabung dengan voucher.');const price=promo?promo.price:row.amount;const discount=voucher?voucher.discount:0;if(discount>=price)throw Error('Harga harus lebih besar dari nilai voucher.');return {price,discount,total:price-discount};}
const money=n=>'Rp'+Number(n).toLocaleString('id-ID');
module.exports={minutes,isOpen,atomic,load,expire,promoAvailable,priceFor,money,MIN};
