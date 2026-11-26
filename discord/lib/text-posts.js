'use strict';
const C=require('./core');
const ANN_COLOR=0xcc9ede, PROMO_COLOR=0xffd700;
const FOOTER='ORIVELA Starfall · your digital space ☾';
const choices={wa:['wa'],dc:['dc'],both:['wa','dc'],information:['wa','dc'],announcement:['dc']};
function targets(kind){if(!Object.hasOwn(choices,kind))throw Error('Tujuan announcement tidak dikenal.');return [...choices[kind]];}
function announcementBody(body,platform,tagAll=true){const text=String(body).trim();if(!text||text.length>900)throw Error('Isi announcement 1–900 karakter.');return `Hii, lovelies! We have a little update for you! ♡\n\n${text}\n\nHappy shopping, lovelies! ♡\n${FOOTER}${tagAll?'\nTAGS : '+(platform==='dc'?'@everyone':'@all'):''}`;}
function dcAnnouncement(event){return {content:event.tagAll===true?'@everyone':null,allowedMentions:{parse:event.tagAll===true?['everyone']:[]},embeds:[{title:'📢 Announcement ☾',description:announcementBody(event.body,'dc',event.tagAll===true),color:ANN_COLOR}],...(event.id?{nonce:String(event.id).replace(/[^a-zA-Z0-9]/g,'').slice(0,24),enforceNonce:true}:{})};}
function waAnnouncement(body,mentions,tagAll=true){return {text:'📢 Announcement ☾\n'+announcementBody(body,'wa',tagAll),mentions:tagAll?mentions:[]};}
function remainingTime(end,now){const m=Math.max(0,Math.ceil((end-now)/60000));return [Math.floor(m/1440)?Math.floor(m/1440)+' hari':'',Math.floor(m%1440/60)?Math.floor(m%1440/60)+' jam':'',m%60?m%60+' menit':''].filter(Boolean).join(' ')||'0 menit';}
function promoPages(promos,tickets,catalog,{platform='dc',now=Date.now(),onlyId}={}){
 const groups=new Map();for(const p of promos){if((onlyId&&p.id!==onlyId)||!C.promoAvailable(p,tickets,now))continue;if(!groups.has(p.id))groups.set(p.id,[]);groups.get(p.id).push(p);}
 const out=[];const dc=platform==='dc';const strike=dc?'~~':'~',bold=dc?'**':'*';
 for(const [id,items] of [...groups].reverse()){
  const p=items[0],slots=Math.max(0,p.slots-tickets.filter(t=>t.promoId===id&&!['cancelled','expired'].includes(t.status)).length);
  const chunks=dc?5:30;
  for(let j=0;j<items.length;j+=chunks){const lines=items.slice(j,j+chunks).map(x=>{const r=catalog.find(r=>r.sku===x.sku);return `${bold}${[r?.product||x.sku,r?.variant,r?.duration].filter(Boolean).join(' · ')}${bold} (${x.sku})\nNormal price : ${strike}${C.money(x.original??r?.amount??x.price)}${strike}\nSpecial price : ${bold}${C.money(x.price)}${bold}`;});
   const caption=String(p.caption||'').trim().slice(0,900);
   const duration=dc?`<t:${Math.floor(p.endsAt/1000)}:R>`:remainingTime(p.endsAt,now);
   const body=[...lines,...(caption?[caption]:[]),'Yuk order sebelum kehabisan, lovelies! ✧\n'+FOOTER,`⌛ Durasi : ${duration}\n🎟️ Available : ${slots} slot`].join('\n\n');
   out.push({id,title:'☾ STARFALL FLASH SALE! ♡',description:body,color:PROMO_COLOR});
  }
 }
 return out;
}
function dcPromoPages(promos,tickets,catalog,options){const p=promoPages(promos,tickets,catalog,{...options,platform:'dc'});return p.length?p.map(({id,...e})=>({...e,footer:{text:id}})):[{title:'☾ STARFALL FLASH SALE! ♡',description:'Belum ada promo aktif, lovelies! ♡\n\n'+FOOTER,color:PROMO_COLOR}];}
module.exports={ANN_COLOR,PROMO_COLOR,targets,dcAnnouncement,waAnnouncement,promoPages,dcPromoPages};
