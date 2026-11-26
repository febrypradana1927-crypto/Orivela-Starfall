'use strict';
const crypto=require('node:crypto');
const B=require('../shared');
const {load,save}=require('./storage');
const {isGroupJid}=require('./logic');
const {amountValue}=require('./qris-invoice');
const money=n=>'Rp'+Number(n).toLocaleString('id-ID');
const clean=s=>String(s||'').trim();
const durationLabel=ms=>{const m=ms/60000;return m%1440===0?`${m/1440} hari`:m%60===0?`${m/60} jam`:`${m} menit`;};
function parseDuration(s){const m=clean(s).match(/^(\d+)\s*(m|h|d|menit|jam|hari)$/i);if(!m)throw Error('Durasi tidak valid. Contoh 30m, 2h, 1d.');const unit=m[2].toLowerCase(),ms=Number(m[1])*({m:60000,menit:60000,h:3600000,jam:3600000,d:86400000,hari:86400000}[unit]);if(!Number.isSafeInteger(ms)||ms<60000||ms>30*86400000)throw Error('Durasi harus 1 menit sampai 30 hari.');return ms;}
function parseSlots(s){if(!/^\d+$/.test(clean(s))||!Number.isSafeInteger(+s)||+s<1||+s>10000)throw Error('Slot harus angka 1–10000.');return +s;}
function parsePrices(s,rows){const lines=clean(s).split(/\r?\n/).filter(x=>x.trim());if(!lines.length||lines.length>30)throw Error('Masukkan 1–30 kode, satu paket per baris.');const seen=new Set();return lines.map(line=>{const m=line.trim().match(/^(P\d{3})\s+(\d+)$/i);if(!m)throw Error('Format: P008 20000 (satu paket per baris, tanpa titik).');const sku=m[1].toUpperCase(),r=rows.find(x=>x.sku===sku);if(!r||r.amount==null||seen.has(sku))throw Error(`Kode ${sku} tidak valid/duplikat.`);seen.add(sku);const price=amountValue(m[2]),original=amountValue(r.amount);if(price>=original)throw Error(`Harga promo ${sku} harus di bawah ${money(original)}.`);return {sku,price,original,product:r.product,variant:r.variant,duration:r.duration};});}
class PromoManager {
 constructor({file,orders,catalogRows,sendText,verifyAdmin,quoteId,downloadPhoto,now=Date.now}){Object.assign(this,{file,orders,catalogRows,sendText,verifyAdmin,quoteId,downloadPhoto,now});this.data=load(file,{version:1,promos:[]});if(this.data.version!==1||!Array.isArray(this.data.promos))throw Error('Database promo tidak valid, pulihkan backup.');this.drafts=new Map();this.publishing=false;this.notifying=new Set();this.notifyRetry=new Map();}
 save(){save(this.file,this.data);}
 used(p){return this.orders.data.orders.filter(o=>o.promoId===p.id&&o.packageConfirmedAt&&!o.cancelledAt).length+B.dcTickets().filter(t=>t.promoId===p.id&&!['cancelled','expired'].includes(t.status)).length;}
 remaining(p){return Math.max(0,p.slots-this.used(p));}
 refresh(){let changed=false;const now=this.now();for(const p of this.data.promos){
  if(p.reason==='Diakhiri admin')continue;
  if(now>=p.endsAt){if(p.reason!=='Waktu habis'){p.closedAt=now;p.reason='Waktu habis';changed=true;}continue;}
  if(this.remaining(p)===0){if(!p.closedAt){p.closedAt=now;p.reason='Slot habis';changed=true;}continue;}
  if(p.reason==='Slot habis'){
   const conflict=this.data.promos.some(q=>q!==p&&q.groupId===p.groupId&&q.endsAt>now&&q.reason!=='Diakhiri admin'&&q.startAt>p.startAt&&q.prices.some(x=>p.prices.some(y=>y.sku===x.sku)));
   if(!conflict){delete p.closedAt;delete p.reason;delete p.endNotifiedAt;changed=true;}
  }
 }if(changed)this.save();}
 publicPages(group){this.refresh();const posts=require('../discord/lib/text-posts');const ids=new Set(this.data.promos.filter(p=>!p.closedAt&&(p.groupId===group||p.groupId===null)).map(p=>p.id));return posts.promoPages(B.flatPromos().filter(p=>ids.has(p.id)),B.allReservations(),this.catalogRows(),{platform:'wa',now:this.now()}).map(p=>p.title+'\n\n'+p.description);}
 active(sku,group){this.refresh();return this.data.promos.find(p=>!p.closedAt&&(p.groupId===group||p.groupId===null)&&p.prices.some(x=>x.sku===sku))||null;}
 offer(sku,group){const p=this.active(sku,group);if(!p)return null;const price=p.prices.find(x=>x.sku===sku);return {id:p.id,price:price.price,original:price.original};}
 async tick(sock,cfg){this.refresh();if(!isGroupJid(cfg?.groupId)||!sock?.user?.id)return;for(const p of this.data.promos){if(!p.closedAt||p.endNotifiedAt||(p.groupId!==cfg.groupId&&p.groupId!==null)||this.notifying.has(p.id)||(this.notifyRetry.get(p.id)||0)>this.now())continue;this.notifying.add(p.id);const closedAt=p.closedAt;try{await this.sendText(sock,cfg.groupId,`☾ PROMO ENDED ☾\n${p.prices.map(x=>x.sku+' · '+x.product).join('\n')}\n${p.reason}. Harga kembali normal untuk order baru.\nThank you, lovelies! ♡`);if(p.closedAt===closedAt){p.endNotifiedAt=this.now();this.save();this.notifyRetry.delete(p.id);}}catch(e){this.notifyRetry.set(p.id,this.now()+60000);console.error('Notif promo tertunda (retry 60 detik):',e.message);}finally{this.notifying.delete(p.id);}}}
 async handle(sock,chat,msg,raw,cfg){if(chat!==cfg.adminGroupId||!cfg.groupId||cfg.groupId===chat)return false;const command=raw.match(/^\.(promo|listpromo|cancelpromo|endpromo)(?:\s+(.*))?$/i);const quoted=this.quoteId(msg.message);const candidate=quoted&&[...this.drafts.values()].find(d=>d.chat===chat&&d.prompt===quoted);if(!command&&!candidate)return false;const admin=await this.verifyAdmin(sock,chat,msg);if(!admin)return true;const name=command?.[1].toLowerCase();const reply=t=>this.sendText(sock,chat,t,msg);const key=chat+'|'+admin.key;const old=this.drafts.get(key);
 if(name==='listpromo'){this.refresh();const rows=this.data.promos.filter(p=>!p.closedAt&&(p.groupId===cfg.groupId||p.groupId===null));await reply(rows.length?rows.map(p=>`${p.id} · ${p.prices.map(x=>x.sku+' '+money(x.price)).join(', ')}\n⌛ ${new Date(p.endsAt).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})} WIB\n🎟️ Available: ${this.remaining(p)}/${p.slots}`).join('\n\n'):'Tidak ada promo aktif.');return true;}
 if(name==='endpromo'){const id=clean(command[2]).toUpperCase();this.refresh();const p=this.data.promos.find(x=>x.id===id&&(x.groupId===cfg.groupId||x.groupId===null)&&x.endsAt>this.now()&&x.reason!=='Diakhiri admin');if(!p){await reply('Promo aktif tidak ditemukan. Cek .listpromo.');return true;}p.closedAt=this.now();p.reason='Diakhiri admin';delete p.endNotifiedAt;this.save();await reply(`Promo ${id} selesai.`);await this.tick(sock,cfg);return true;}
 if(name==='cancelpromo'){if(old?.busy){await reply('Setup sedang diproses.');return true;}this.drafts.delete(key);await reply('Setup promo dibatalkan.');return true;}
 const prompt=async(d,text)=>{const sent=await reply(text);if(!sent?.key?.id)throw Error('ID pesan prompt tidak tersedia. Ulangi .promo.');d.prompt=sent.key.id;d.last=this.now();};
 if(name==='promo'){if(old?.busy){await reply('Setup sedang diproses.');return true;}const d={chat,owner:admin.key,step:'duration',busy:true,last:this.now(),prompt:null};this.drafts.set(key,d);try{await prompt(d,'☾ ORIVELA PROMO SETUP ☾\n\nBerapa lama promo akan berlangsung?\n➵ Reply pesan ini dengan durasi: 30m, 2h, 1d.');}finally{d.busy=false;}return true;}
 const d=old;if(!d||d!==candidate)return true;if(d.busy)return true;if(this.now()-d.last>15*60000){this.drafts.delete(key);await reply('Setup kedaluwarsa. Ketik .promo lagi.');return true;}d.busy=true;
 try{
 if(d.step==='duration'){const duration=parseDuration(raw);await prompt(d,'✦ AVAILABLE SLOTS\n\nBerapa slot promo yang tersedia?\n➵ Reply jumlah slot, contoh: 10.');d.duration=duration;d.step='slots';}
 else if(d.step==='slots'){const slots=parseSlots(raw);await prompt(d,'✦ PROMO PRICE\n\nReply kode paket dan harga promo. Contoh: P008 20000.\nUntuk beberapa paket, tulis satu kode dan harga per baris. Slot digunakan bersama.\nCek .listkode untuk kode paket.');d.slots=slots;d.step='prices';}
 else if(d.step==='prices'){const prices=parsePrices(raw,this.catalogRows());await prompt(d,`✦ PROMO CONTENT\n\n${prices.map(x=>`${x.sku} ${x.product}: ${money(x.original)} → ${money(x.price)}`).join('\n')}\n⌛ Durasi: ${durationLabel(d.duration)}\n🎟️ Available: ${d.slots} slot\n\nReply pesan ini dengan caption tambahan (teks saja). Harga, durasi dan slot dibuat otomatis. Ketik - jika tidak perlu caption. ♡`);d.prices=prices;d.step='content';}
 else if(d.step==='content'){if(this.publishing)throw Error('Promo lain sedang dipublikasikan. Coba reply lagi.');this.publishing=true;try{
 const content=msg.message.ephemeralMessage?.message||msg.message;const image=content.imageMessage;const caption=image?String(image.caption||''):String(content.conversation||content.extendedTextMessage?.text||'');if(!caption.trim())throw Error('Kirim foto dengan caption atau teks promo.');const footer=`\n\n⌛ Durasi : ${durationLabel(d.duration)}\n🎟️ Available : ${d.slots} slot`;if((caption+footer).length>(image?1024:3500))throw Error('Caption terlalu panjang. Ringkas lalu reply prompt ini lagi.');
 for(const price of d.prices){const r=this.catalogRows().find(x=>x.sku===price.sku);if(!r||r.amount!==price.original)throw Error('Harga katalog berubah; mulai ulang .promo.');if(this.data.promos.some(p=>(p.groupId===cfg.groupId||p.groupId===null)&&p.endsAt>this.now()&&p.reason!=='Diakhiri admin'&&p.prices.some(x=>x.sku===price.sku)))throw Error(`${price.sku} sudah punya promo aktif. Akhiri dulu dengan .endpromo ID.`);}
 const p=B.createPromo(d.prices,d.duration,d.slots,caption.trim()==='-'?'':caption,admin.key);this.drafts.delete(key);await reply(`☾ PROMO PUBLISHED ♡\nID: ${p.id}\nPromo aktif. Posting teks WA & Discord masuk antrean.\n⌛ ${durationLabel(d.duration)} · 🎟️ ${d.slots} slot`);
 }finally{this.publishing=false;}}
 }catch(e){await reply(`✦ ${e.message}\nReply pesan setup sebelumnya untuk mencoba lagi. .cancelpromo untuk batal.`);}finally{d.busy=false;}
 return true;
 }
}
module.exports={PromoManager,parseDuration,parseSlots,parsePrices,durationLabel};
