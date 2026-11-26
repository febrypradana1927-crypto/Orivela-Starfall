'use strict';

const B=require('../shared');
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
    if(!cmd&&!candidate)return false;
    const admin=await this.verifyAdmin(sock,chat,msg);
    if(!admin)return true;
    const reply=t=>this.sendText(sock,chat,t,msg);
    const key=chat+'|'+admin.key;
    const old=this.drafts.get(key);
    const msgKey=chat+'|'+msg.key.id;
    if(this.sent.has(msgKey))return true;
    if(cmd){
      if(old?.busy){await reply('Announcement sedang diproses.');return true;}
      if(cmd[1].toLowerCase()==='cancelnotif'){this.drafts.delete(key);await reply('Setup announcement dibatalkan.');return true;}
      // Reserve before await to stop duplicate concurrent prompts.
      const d={chat,store:cfg.groupId,prompt:null,last:this.now(),busy:true};
      this.drafts.set(key,d);
      try{
        const sent=await reply('✦ ANNOUNCEMENT SETUP ✦\n\nApa isi pengumuman yang ingin disampaikan?\n\n➵ Reply pesan ini dengan isi announcement. Kirim isi teks; jika berupa foto hanya caption yang dipakai.\n\nKetik .cancelnotif untuk membatalkan. ♡');
        if(!sent?.key?.id)throw Error('ID prompt tidak tersedia.');
        d.prompt=sent.key.id;d.last=this.now();
      }catch(e){this.drafts.delete(key);throw e;}finally{d.busy=false;}
      return true;
    }
    if(old!==candidate){await reply('Hanya admin yang memulai .notif yang bisa mengisi announcement ini.');return true;}
    if(old.busy)return true;
    if(this.now()-old.last>=TTL||old.store!==cfg.groupId){this.drafts.delete(key);await reply('Setup kedaluwarsa atau grup Store berubah. Ketik .notif lagi.');return true;}
    old.busy=true;
    try{
      const m=msg.message.ephemeralMessage?.message||msg.message;
      const image=m.imageMessage;
      const body=String(image?image.caption||'':m.conversation||m.extendedTextMessage?.text||'').trim();
      if(!body)throw Error('Isi announcement tidak boleh kosong.');
      const caption=`${HEADER}\n\n${body}\n\n${FOOTER}`;
      if(caption.length>(image?1024:3500))throw Error('Announcement terlalu panjang. Ringkas lalu reply prompt lagi.');
      B.queueInfo(body,'wa');
      this.sent.set(msgKey,this.now());
      for(const [k,t] of this.sent)if(this.now()-t>24*60*60_000||this.sent.size>2000)this.sent.delete(k);
      this.drafts.delete(key);
      // An acknowledgement failure must not re-open the already sent announcement.
      try{await reply(`✅ Announcement masuk antrean posting teks WA dan Discord.`);}catch(e){console.error('Konfirmasi announcement gagal:',e.message);}
    }catch(e){await reply(`✦ ${e.message}\nAnnouncement belum terkonfirmasi terkirim. Periksa Store sebelum mencoba lagi. .cancelnotif untuk batal.`);}
    finally{old.busy=false;}
    return true;
  }
}
module.exports={AnnouncementManager,memberJids};
