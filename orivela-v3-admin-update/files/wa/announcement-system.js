'use strict';

const B=require('../shared'),M=require('../media-bridge');
const TTL = 15 * 60_000;
const HEADER = '📢 Announcement ☾\nHii, lovelies! We have a little update for you! ♡';
const FOOTER = 'Happy shopping, lovelies! ♡\nORIVELA Starfall · your digital space ☾\nTAGS : @all';
function memberJids(meta) {
  if (!Array.isArray(meta?.participants)) throw Error('Daftar member Store tidak tersedia.');
  const ids = [...new Set(meta.participants.map(p => [p.id,p.jid,p.lid,p.phoneNumber].find(x => typeof x === 'string' && /^\d+(?::\d+)?@(?:s\.whatsapp\.net|lid)$/.test(x))).filter(Boolean).map(x => x.replace(/:\d+@/, '@')))];
  if (!ids.length || meta.participants.some(p => ![p.id,p.jid,p.lid,p.phoneNumber].some(x => typeof x === 'string' && /^\d+(?::\d+)?@(?:s\.whatsapp\.net|lid)$/.test(x)))) throw Error('Tidak semua identitas member Store bisa dibaca.');
  return ids;
}
class AnnouncementManager {
  constructor({sendText, verifyAdmin, quoteId, downloadPhoto, now=Date.now}) {
    Object.assign(this,{sendText,verifyAdmin,quoteId,downloadPhoto,now});
    this.drafts=new Map();
    this.sent=new Map();
  }
  async handle(sock,chat,msg,raw,cfg) {
    if (!chat || chat!==cfg.adminGroupId || !/^\d+(?:-\d+)?@g\.us$/.test(cfg.groupId||'') || cfg.groupId===chat) return false;
    const cmd=/^\.(notif|cancelnotif)$/i.exec(raw);
    const quote=this.quoteId(msg.message);
    const candidate=quote && [...this.drafts.values()].find(d=>d.chat===chat&&d.prompt===quote);
    const incoming=msg.message.ephemeralMessage?.message||msg.message;
    const follow=/^(yes|no)$/i.test(raw.trim())||incoming.imageMessage||incoming.videoMessage;
    if(!cmd&&!candidate&&!follow)return false;
    const admin=await this.verifyAdmin(sock,chat,msg);
    if(!admin)return true;
    const reply=t=>this.sendText(sock,chat,t,msg);
    const key=chat+'|'+admin.key;
    const old=this.drafts.get(key);
    if(!cmd&&!candidate&&(!old||old.stage==='body'))return false;
    const msgKey=chat+'|'+msg.key.id;
    if(this.sent.has(msgKey))return true;
    if(cmd){
      if(old?.busy){await reply('Announcement sedang diproses.');return true;}
      if(cmd[1].toLowerCase()==='cancelnotif'){this.drafts.delete(key);await reply('Setup announcement dibatalkan.');return true;}
      // Reserve before await to stop duplicate concurrent prompts.
      const d={chat,store:cfg.groupId,prompt:null,stage:'body',last:this.now(),busy:true};
      this.drafts.set(key,d);
      try{
        const sent=await reply('✦ ANNOUNCEMENT SETUP ✦\n\nApa isi pengumuman yang ingin disampaikan?\n\n➵ Reply pesan ini dengan isi announcement. Kirim isi teks dulu.\n\nKetik .cancelnotif untuk membatalkan. ♡');
        if(!sent?.key?.id)throw Error('ID prompt tidak tersedia.');
        d.prompt=sent.key.id;d.last=this.now();
      }catch(e){this.drafts.delete(key);throw e;}finally{d.busy=false;}
      return true;
    }
    if(candidate&&old!==candidate){await reply('Hanya admin yang memulai .notif yang bisa mengisi announcement ini.');return true;}
    if(old.busy)return true;
    if(this.now()-old.last>=TTL||old.store!==cfg.groupId){this.drafts.delete(key);await reply('Setup kedaluwarsa atau grup Store berubah. Ketik .notif lagi.');return true;}
    old.busy=true;
    try{
      const m=incoming;
      if(old.stage==='body'){
        const body=String(m.conversation||m.extendedTextMessage?.text||'').trim();
        if(!body||body.length>900)throw Error('Isi announcement harus 1–900 karakter teks.');
        const sent=await reply('✦ Ada media foto/video yang ingin dimasukkan? Ketik YES atau NO. ♡');
        old.body=body;old.stage='choice';old.prompt=sent?.key?.id;old.last=this.now();return true;
      }
      let media=null;
      if(old.stage==='choice'){
        if(/^yes$/i.test(raw.trim())){const sent=await reply('Kirim satu foto JPG/PNG atau video MP4 (maks. 8 MiB). Reply prompt ini atau upload langsung.');old.stage='media';old.prompt=sent?.key?.id;old.last=this.now();return true;}
        if(!/^no$/i.test(raw.trim()))throw Error('Ketik YES atau NO.');
      }else if(old.stage==='media'){
        const item=m.imageMessage||m.videoMessage;
        if(!item)throw Error('Upload satu foto atau video.');
        if(Number(item.fileLength)>M.MAX)throw Error('Media maksimal 8 MiB.');
        media=M.validate(await this.downloadPhoto(sock,msg));
      }else throw Error('Draft tidak valid.');
      B.queueInfo(old.body,'wa',undefined,media);
      this.sent.set(msgKey,this.now());
      for(const [k,t] of this.sent)if(this.now()-t>24*60*60_000||this.sent.size>2000)this.sent.delete(k);
      this.drafts.delete(key);
      // An acknowledgement failure must not re-open the already sent announcement.
      try{await reply(`✅ Announcement masuk antrean posting WA dan Discord (sesuai platform aktif).`);}catch(e){console.error('Konfirmasi announcement gagal:',e.message);}
    }catch(e){await reply(`✦ ${e.message}\nAnnouncement belum terkonfirmasi terkirim. Periksa Store sebelum mencoba lagi. .cancelnotif untuk batal.`);}
    finally{old.busy=false;}
    return true;
  }
}
module.exports={AnnouncementManager,memberJids};
