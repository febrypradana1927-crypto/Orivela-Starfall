'use strict';
require('dotenv').config();
// Prefer IPv4 on hosting with broken IPv6 routing; disable with ORIVELA_IPV4_FIRST=false.
if(process.env.ORIVELA_IPV4_FIRST!=='false'){require('node:dns').setDefaultResultOrder('ipv4first');require('node:net').setDefaultAutoSelectFamily?.(true);}
const M=require('../media-bridge'),posts=require('./lib/text-posts'),content=require('./lib/content'),W=require('./lib/welcome-queue'),B=require('../shared');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Client,GatewayIntentBits,PermissionFlagsBits:P,ChannelType,ActivityType,EmbedBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle,StringSelectMenuBuilder,ModalBuilder,TextInputBuilder,TextInputStyle,SlashCommandBuilder,AttachmentBuilder,MessageFlags,Events}=require('discord.js');
const C=require('./lib/core'),qr=require('./lib/qris-invoice'),{LuckyverseGame}=require('./lib/luckyverse-game');
const config=require('./config.json'),catalog=require('./data/catalog.json'),texts=require('./data/texts.json');
const {DISCORD_TOKEN:token,GUILD_ID:guildId,QRIS_ENABLED}=process.env;
if(!token||token.startsWith('ISI_')||!/^\d{17,22}$/.test(guildId||'')){throw Error('Isi DISCORD_TOKEN dan GUILD_ID di file .env dahulu.');}
const runtime=path.join(__dirname,'data','runtime'),dbfile=path.join(runtime,'store.json');
const db=C.load(dbfile,{version:1,guildId,schedule:{mode:'auto',open:config.open,close:config.close},channels:{},roles:{},panels:{},tickets:{},promos:[],counter:0});
if(db.version!==1||db.guildId!==guildId||!db.tickets)throw Error('Database salah server atau rusak. Jangan ditimpa; pulihkan backup.');
db.welcomeQueue ||= {};
const save=()=>C.atomic(dbfile,db);save();
const game=B.wa.game;
const tickets=()=>Object.values(db.tickets);
// A voucher is reserved in the same atomic store transaction as an order; no cross-file mutation needed.
B.dcTickets=tickets;
const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent],allowedMentions:{parse:[],repliedUser:false},rest:{timeout:30000,retries:3}});
const color=0xB7A0E3,ep={flags:MessageFlags.Ephemeral},asset=n=>path.join(__dirname,'assets',n+'.jpg');
const e=(title,desc)=>new EmbedBuilder().setColor(color).setTitle(title).setDescription(desc||'♡').setFooter({text:'ORIVELA Starfall · your digital space ☾'});
function media(title,desc,name){const em=e(title,desc);return fs.existsSync(asset(name))?{embeds:[em.setImage('attachment://'+name+'.jpg')],files:[new AttachmentBuilder(asset(name),{name:name+'.jpg'})]}:{embeds:[em]};}
const btn=(id,label,style=ButtonStyle.Secondary,disabled=false)=>new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
const row=(...b)=>new ActionRowBuilder().addComponents(b);
const isStaff=(i,t)=>i.memberPermissions?.has(P.Administrator)||i.member?.roles?.cache?.has(db.roles.admin)||i.member?.roles?.cache?.has(db.roles[t.type]);
const manager=i=>i.memberPermissions?.has(P.Administrator)||i.member?.roles?.cache?.has(db.roles.admin);
const requireManager=i=>{if(!manager(i))throw Error('Khusus Administrator/Store Admin.');};
const contentStaff=i=>manager(i)||['content','purchase'].some(k=>db.roles[k]&&i.member?.roles?.cache?.has(db.roles[k]));
const requireContent=i=>{if(!contentStaff(i)||i.channelId!==db.channels.studio)throw Error('Gunakan ruang Content Studio dengan role Store Admin, Sales Staff atau Content Staff.');};
const getTicket=i=>{const t=tickets().find(t=>t.channel===i.channelId&&!t.closedAt);if(!t)throw Error('Gunakan di channel ticket aktif.');return t;};
const requireStaff=(i,t)=>{if(!isStaff(i,t))throw Error('Khusus staff ticket ini.');};
const own=(i,t)=>{if(i.user.id!==t.owner)throw Error('Khusus pemilik ticket.');};
const opened=()=>B.isOpen();
const channel=async(g,key)=>db.channels[key]?(g.channels.cache.get(db.channels[key])||await g.channels.fetch(db.channels[key])):null;
async function notify(g,key,payload){const ch=await channel(g,key);if(ch?.isTextBased())return ch.send(payload);}
const activePromo=sku=>B.offer(sku);
const validVoucher=(serial,user)=>{if(!serial)return null;const r=game.getVoucher(serial);if(r.error||r.voucher.status!=='active'||r.voucher.ownerId!==B.gameId(user))throw Error('Voucher tidak aktif, sudah terpakai, atau bukan milikmu.');return r.voucher;};
const locks=new Set();async function lock(key,fn){if(locks.has(key))throw Error('Sedang diproses. Coba lagi sebentar.');locks.add(key);try{return await fn();}finally{locks.delete(key);}}
const commands=[];
function cmd(name,description,build){const c=new SlashCommandBuilder().setName(name).setDescription(description);if(build)build(c);commands.push(c.toJSON());}
const str=(o,n,d,req=true)=>o.setName(n).setDescription(d).setRequired(req);
const int=(o,n,d,min,max)=>o.setName(n).setDescription(d).setRequired(true).setMinValue(min).setMaxValue(max);
cmd('setup','Buat channel, role dan panel toko (admin)',c=>c.setDefaultMemberPermissions(P.Administrator));
cmd('store','Kontrol jam dan status toko',c=>c.addSubcommand(s=>s.setName('status').setDescription('Lihat status toko')).addSubcommand(s=>s.setName('mode').setDescription('Ganti mode toko').addStringOption(o=>str(o,'mode','Mode').addChoices(...['auto','open','close','maintenance'].map(x=>({name:x,value:x}))))).addSubcommand(s=>s.setName('schedule').setDescription('Atur jam WIB').addStringOption(o=>str(o,'buka','HH:MM')).addStringOption(o=>str(o,'tutup','HH:MM'))));
cmd('pricelist','Lihat gambar katalog terbaru');cmd('harga','Lihat paket produk',c=>c.addStringOption(o=>str(o,'produk','Nama produk',false)));
cmd('order','Lihat pesanan milikmu',c=>c.addStringOption(o=>str(o,'id','Order ID',false)));
cmd('promo','Lihat atau kelola promo',c=>c.addSubcommand(s=>s.setName('list').setDescription('Promo aktif')).addSubcommand(s=>s.setName('add').setDescription('Buat promo SKU').addStringOption(o=>str(o,'sku','Kode paket')).addIntegerOption(o=>int(o,'harga','Harga promo rupiah',1,10000000)).addIntegerOption(o=>int(o,'menit','Durasi promo dalam menit',1,43200)).addIntegerOption(o=>int(o,'slot','Jumlah slot',1,10000))).addSubcommand(s=>s.setName('end').setDescription('Akhiri promo').addStringOption(o=>str(o,'id','ID promo'))));
cmd('welcome','Pemulihan sambutan/member (admin)',c=>c.addSubcommand(s=>s.setName('repair').setDescription('Pulihkan role dan welcome member tertentu').addUserOption(o=>o.setName('member').setDescription('Member yang terlewat').setRequired(true))).addSubcommand(s=>s.setName('role').setDescription('Pulihkan role saja').addUserOption(o=>o.setName('member').setDescription('Member').setRequired(true))));
cmd('content','Buat announcement atau promo di Content Studio',c=>c.addSubcommand(s=>s.setName('wa').setDescription('Announcement WhatsApp saja')).addSubcommand(s=>s.setName('dc').setDescription('Announcement Discord saja')).addSubcommand(s=>s.setName('both').setDescription('Announcement WhatsApp dan Discord')).addSubcommand(s=>s.setName('information').setDescription('Announcement kedua platform (alias lama)')).addSubcommand(s=>s.setName('promo').setDescription('Form promo')));
cmd('announcementmedia','Upload media untuk draft announcement',c=>c.addAttachmentOption(o=>o.setName('file').setDescription('Satu foto JPG/PNG atau video MP4 maksimal 8 MiB').setRequired(true)));
cmd('sales','Rekap transaksi selesai (admin)');cmd('backup','Unduh database privat (admin)');cmd('announce','Kirim pengumuman (admin)',c=>c.addStringOption(o=>str(o,'pesan','Isi pengumuman').setMaxLength(900)));
cmd('ticket','Kelola ticket di channel privat',c=>c.addSubcommand(s=>s.setName('panel').setDescription('Tampilkan ulang kontrol ticket')).addSubcommand(s=>s.setName('close').setDescription('Tutup dan simpan transcript')).addSubcommand(s=>s.setName('reopen').setDescription('Buka kembali ticket yang telah ditutup')));
cmd('invoice','Kirim ulang QRIS order aktif (staff)');
const {publicSpecs,staffSpecs,categories,legacyPublic,legacyStaff,legacyCategories,ticketName,shouldRename}=require('./lib/layout');
const roleNames={admin:'Store Admin',purchase:'Sales Staff',warranty:'Warranty Staff',support:'Support Staff',customer:'Customer',member:'Member',content:'Content Staff'};
async function setup(g){
 const roles=await g.roles.fetch();const chans=await g.channels.fetch();
 for(const [k,name] of Object.entries(roleNames)){let r=roles.get(db.roles[k]);if(!r)r=await g.roles.create({name,reason:'ORIVELA setup'});db.roles[k]=r.id;save();}
 const me=g.members.me.id, allow=[P.ViewChannel,P.SendMessages,P.ReadMessageHistory,P.AttachFiles,P.EmbedLinks], deny={id:g.id,deny:[P.ViewChannel]}, bot={id:me,allow:[...allow,P.ManageChannels,P.ManageMessages]};
 for(const [k,name] of Object.entries(categories)){let c=chans.get(db.channels['cat_'+k]);if(!c){let permissionOverwrites; if(['purchase','warranty','support','archive','staff','waorders'].includes(k)){const ids=k==='staff'?['admin','purchase','warranty','support','content']:k==='archive'?['admin']:k==='waorders'?['admin','purchase']:['admin',k];permissionOverwrites=[deny,bot,...ids.map(x=>({id:db.roles[x],allow}))];}c=await g.channels.create({name,type:ChannelType.GuildCategory,permissionOverwrites});}else if(shouldRename(c.name,legacyCategories[k],name)){await c.setName(name,'ORIVELA V2.1 aesthetic layout');}db.channels['cat_'+k]=c.id;save();}
 for(const [k,[cat,name]] of Object.entries(publicSpecs)){let c=chans.get(db.channels[k]);if(!c){const writable=k==='games';c=await g.channels.create({name,type:ChannelType.GuildText,parent:db.channels['cat_'+cat],permissionOverwrites:[{id:g.id,allow:[P.ViewChannel,P.ReadMessageHistory],deny:writable?[]:[P.SendMessages,P.CreatePublicThreads,P.CreatePrivateThreads]},bot,{id:db.roles.admin,allow}]});}else if(shouldRename(c.name,legacyPublic[k][1],name)){await c.setName(name,'ORIVELA V2.1 aesthetic layout');}db.channels[k]=c.id;save();}
 for(const [k,name] of Object.entries(staffSpecs)){let c=chans.get(db.channels[k]);if(!c){const types=k==='orders'?['purchase']:k==='complaints'?['warranty']:k==='supportlog'?['support']:k==='studio'?['purchase','content']:[];c=await g.channels.create({name,type:ChannelType.GuildText,parent:db.channels.cat_staff,permissionOverwrites:[deny,bot,...['admin',...types].map(x=>({id:db.roles[x],allow}))]});}else if(shouldRename(c.name,legacyStaff[k],name)){await c.setName(name,'ORIVELA V2.1 aesthetic layout');}db.channels[k]=c.id;save();}
 // Preserve the old information channel privately; no irreversible deletion.
 const oldInfoId=db.channels.information;
 if(oldInfoId&&oldInfoId!==db.channels.announcement){const old=chans.get(oldInfoId);if(old){await old.permissionOverwrites.set([deny,bot,{id:db.roles.admin,allow}],'ORIVELA: informasi dipindah ke announcement');await old.setParent(db.channels.cat_archive,{lockPermissions:false});await old.setName('📦・archived-information','ORIVELA: simpan riwayat informasi');}}
 if(oldInfoId){delete db.channels.information;delete db.panels.information;save();}
 await refreshPanels(g,true);
}
async function panel(g,key,payload){const c=await channel(g,key);if(!c)throw Error('Channel panel '+key+' belum tersedia.');const m=db.panels[key]?await c.messages.fetch(db.panels[key]).catch(err=>{if(err.code===10008)return null;throw err;}):null;if(m){await m.edit({...payload,attachments:[]});}else{const sent=await c.send(payload);db.panels[key]=sent.id;save();}}
function scheduleText(){return `${B.schedule().open}–${B.schedule().close} WIB · Mode ${B.schedule().mode}`;}
async function refreshPanels(g,all=false){
 const on=opened(), fixed=B.schedule().open==='10:00'&&B.schedule().close==='00:00'&&B.schedule().mode==='auto';
 let statusText=on?'Purchase ticket tersedia.':'Ticket pembelian baru ditutup. Garansi dan support tetap tersedia.';
 if(B.schedule().mode==='maintenance')statusText='Toko sedang maintenance. Garansi dan support tetap tersedia.';
 await panel(g,'status',media(on?'✦ STORE OPEN':'☾ STORE CLOSED',`${statusText}\n${scheduleText()}`,fixed?(on?'open':'closed'):'none'));
 await panel(g,'purchase',{...media('✦ Purchase Center',`${on?'Pilih tombol untuk membuat ticket pembelian privat.':'Toko tutup. Silakan kembali pada jam operasional.'}\n${scheduleText()}`,'purchase'),components:[row(btn('open:purchase','Open Purchase Ticket',ButtonStyle.Success,!on))]});
 if(!all)return;
 await panel(g,'warranty',{...media('✦ Warranty Center','Siapkan Order ID atau bukti transaksi, nama produk, tanggal pembelian, dan screenshot kendala.','warranty'),components:[row(btn('open:warranty','Open Warranty Ticket',ButtonStyle.Primary))]});
 await panel(g,'support',{...media('✦ Help Center','Untuk pertanyaan produk, pembayaran, saran, dan bantuan umum.','support'),components:[row(btn('open:support','Open Support Ticket',ButtonStyle.Primary))]});
 await panel(g,'prices',media('✦ Pricelist','Harga paket interaktif: `/harga`. Pemesanan: <#'+db.channels.purchase+'>.','pricelist'));
 await panel(g,'rules',photo('rules','Aturan toko'));
 await panel(g,'terms',photo('terms','Ketentuan garansi'));
 await panel(g,'gameinfo',{content:null,components:[],embeds:[e('✦ ORIVELA LUCKYVERSE ☾','Main dengan bot Luckyverse di <#'+db.channels.games+'>.\n\n`os!help` — daftar command\n`os!bal` — saldo\n`os!daily` — hadiah harian\n`os!mine` — menambang\n\nTidak perlu akun WhatsApp. Linking opsional: `os!link` melalui DM bot Luckyverse.')]});
 await refreshPromo(g,true);
 await panel(g,'studio',{content:null,embeds:[{title:'✦ STARFALL CONTENT STUDIO ✦',description:'Welcome, Starfall Staff! ♡\n\nPilih tujuan announcement atau buat promo bersama. Announcement akan menandai semua member pada platform tujuan. Promo menggunakan slot bersama; cek kode paket dengan /harga.',color:posts.ANN_COLOR}],components:[row(btn('studio:wa','📱 Announcement WA',ButtonStyle.Success),btn('studio:dc','💬 Announcement Discord',ButtonStyle.Primary),btn('studio:both','📢 Announcement Keduanya',ButtonStyle.Secondary),btn('studio:promo','🎀 Promo',ButtonStyle.Primary))]});
}
function photo(name,description){return {content:null,embeds:[],components:[],files:[new AttachmentBuilder(asset(name),{name:name+'.jpg',description})]};}
function photoBuffers(buffers,name,description){return {content:null,embeds:[],components:[],files:buffers.map((b,j)=>new AttachmentBuilder(b,{name:`${name}-${j+1}.png`,description:description.slice(0,1024)}))};}
let promoSignature=null;
const promoPages=()=>posts.dcPromoPages(B.flatPromos(),B.allReservations(),catalog);
async function refreshPromo(g,force=false){if(!db.channels.promo)return;return lock('promo-panel',async()=>{const pages=promoPages(),sig=JSON.stringify(pages);if(!force&&sig===promoSignature)return;const payload={content:null,embeds:[pages[0]],components:[]};if(pages.length>1)payload.components=[row(btn('promopage:0','Lihat Semua Promo',ButtonStyle.Primary))];await panel(g,'promo',payload);promoSignature=sig;});}
async function showPromo(i,page=0){const pages=promoPages();page=Math.max(0,Math.min(page,pages.length-1));const payload={content:null,embeds:[pages[page]],components:[]};if(pages.length>1)payload.components=[row(btn('promopage:'+Math.max(0,page-1),'Sebelumnya',ButtonStyle.Secondary,page===0),btn('promopage:'+Math.min(pages.length-1,page+1),`Berikutnya (${page+1}/${pages.length})`,ButtonStyle.Primary,page===pages.length-1))];return reply(i,payload);}
function studioForm(kind){if(kind==='promo')return modal('studio:promo','Buat promo Starfall',field('duration','Durasi (30m, 2h, 1d)'),field('slots','Jumlah slot bersama'),field('prices','Kode dan harga (P008 20000)',null,TextInputStyle.Paragraph,true,600),field('caption','Caption tambahan (opsional)',null,TextInputStyle.Paragraph,false,300));const dest=posts.targets(kind);return modal('studio:'+kind,'Announcement '+(dest.length===2?'WA & Discord':dest[0]==='wa'?'WhatsApp':'Discord'),field('body','Isi pengumuman',null,TextInputStyle.Paragraph,true,900));}
const announcementDrafts=new Map();
const draftTTL=15*60000;
async function publishInfo(i,body,kind='both'){
 const dest=posts.targets(kind);body=String(body).trim();if(!body||body.length>900)throw Error('Isi announcement 1–900 karakter.');
 const id=crypto.randomBytes(8).toString('hex');announcementDrafts.set(i.user.id,{id,body,dest,channel:i.channelId,until:Date.now()+draftTTL,stage:'choice'});
 return reply(i,{content:'✦ Ada media foto/video yang ingin dimasukkan? ♡',components:[row(btn('annmedia:yes:'+id,'YES',ButtonStyle.Success),btn('annmedia:no:'+id,'NO',ButtonStyle.Secondary),btn('annmedia:cancel:'+id,'Batal',ButtonStyle.Danger))]});
}
function getDraft(i,id){const d=announcementDrafts.get(i.user.id);if(!d||d.until<Date.now()||d.channel!==i.channelId||(id&&d.id!==id))throw Error('Draft kedaluwarsa atau bukan milikmu. Buat announcement lagi.');if(!contentStaff(i)||!(i.channelId===db.channels.studio||manager(i)))throw Error('Khusus staff.');return d;}
async function chooseMedia(i,action,id){const d=getDraft(i,id);if(d.stage!=='choice')throw Error('Pilihan sudah diproses.');if(action==='cancel'){announcementDrafts.delete(i.user.id);return i.update({content:'Draft dibatalkan.',components:[]});}if(action==='yes'){d.stage='media';d.until=Date.now()+draftTTL;return i.update({content:'Upload media menggunakan `/announcementmedia file` di channel ini. Maks. 8 MiB, JPG/PNG/MP4. Draft berlaku 15 menit.',components:[]});}if(action!=='no')throw Error('Pilihan tidak valid.');B.queueInfo(d.body,'discord',d.dest);announcementDrafts.delete(i.user.id);return i.update({content:'✅ Announcement teks masuk antrean pengiriman.',components:[]});}
async function submitMedia(i){const d=getDraft(i);if(d.stage!=='media')throw Error('Pilih YES terlebih dahulu.');d.stage='busy';try{const media=await M.fetchAttachment(i.options.getAttachment('file'));if(announcementDrafts.get(i.user.id)!==d)throw Error('Draft sudah diganti.');B.queueInfo(d.body,'discord',d.dest,media);announcementDrafts.delete(i.user.id);return reply(i,'✅ Announcement + media masuk antrean pengiriman.');}catch(err){d.stage='media';throw err;}}

async function publishPromo(i,entries,minutes,slots,caption){const p=B.createPromo(entries,minutes*C.MIN,slots,caption,i.user.id);return reply(i,'Promo aktif '+p.id+' · '+slots+' slot bersama WA & Discord. Posting teks masuk antrean.');}
function field(id,label,value,style=TextInputStyle.Short,required=true,max=100){const f=new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max);if(value)f.setValue(value);return row(f);}
function modal(id,title,...fields){return new ModalBuilder().setCustomId(id).setTitle(title).addComponents(...fields);}
function ticketForm(type){return type==='warranty'?modal('create:warranty','Klaim Garansi',field('order','Order ID / bukti transaksi'),field('product','Nama produk'),field('date','Tanggal pembelian'),field('details','Detail kendala',null,TextInputStyle.Paragraph,true,1000)):modal('create:support','Customer Support',field('details','Apa yang bisa kami bantu?',null,TextInputStyle.Paragraph,true,1000));}
async function createTicket(i,type,details={}){return lock('new:'+i.user.id+':'+type,async()=>{
 if(type==='purchase'&&!opened())throw Error('Toko sedang tutup.');if(!db.channels['cat_'+type])throw Error('Admin belum menjalankan /setup.');
 const old=tickets().find(t=>t.owner===i.user.id&&t.type===type&&!t.closedAt);if(old){if(await i.guild.channels.fetch(old.channel).catch(e=>{if(e.code===10003)return null;throw e;}))throw Error('Ticket aktif sudah ada: <#'+old.channel+'>.');old.closedAt=Date.now();old.status=['completed','resolved','rejected'].includes(old.status)?old.status:'cancelled';save();}
 const id='ORV-'+String(++db.counter).padStart(5,'0');save();const channel=await i.guild.channels.create({name:ticketName(type,id),type:ChannelType.GuildText,parent:db.channels['cat_'+type],topic:`ORIVELA ${id} | ${type}`,permissionOverwrites:[{id:i.guild.id,deny:[P.ViewChannel]},{id:i.user.id,allow:[P.ViewChannel,P.SendMessages,P.ReadMessageHistory,P.AttachFiles]},{id:i.guild.members.me.id,allow:[P.ViewChannel,P.SendMessages,P.ReadMessageHistory,P.ManageChannels,P.AttachFiles,P.EmbedLinks]},...['admin',type].map(k=>({id:db.roles[k],allow:[P.ViewChannel,P.SendMessages,P.ReadMessageHistory,P.AttachFiles]}))]});
 const t={id,type,owner:i.user.id,channel:channel.id,status:type==='purchase'?'selecting':'new',createdAt:Date.now(),details};db.tickets[id]=t;save();
 await channel.send({content:`<@${t.owner}>`,allowedMentions:{users:[t.owner]},...media('✦ '+id,type==='purchase'?'Pilih produk dan paket di bawah. Jangan kirim password atau OTP.':`${opened()?'Staff akan menanggapi ticket kamu.':'Ticket diterima di luar jam operasional; staff merespons pada jam layanan.'}\nJangan kirim password/OTP. Screenshot kendala dapat diunggah di sini.`,type)});
 if(type==='purchase')await channel.send(productMenu());else{await channel.send({embeds:[e('Detail ticket',Object.entries(details).map(([k,v])=>`**${k}:** ${v}`).join('\n'))]});}
 await sendControls(channel,t);if(type!=='purchase')await notify(i.guild,type==='warranty'?'complaints':'supportlog',{content:`<@&${db.roles[type]}>`,allowedMentions:{roles:[db.roles[type]]},embeds:[e('Ticket baru · '+id,`<@${t.owner}> · <#${t.channel}>`)]}).catch(console.error);
 return t;
 });}
function productMenu(){const products=[...new Set(catalog.map(r=>r.product))];return {components:[row(new StringSelectMenuBuilder().setCustomId('select:product').setPlaceholder('Pilih produk').addOptions(products.map(p=>({label:p,value:p}))))]};}
function packageMenu(product){return {components:[row(new StringSelectMenuBuilder().setCustomId('select:package').setPlaceholder('Pilih paket').addOptions(catalog.filter(r=>r.product===product).map(r=>({label:`${r.variant} · ${r.duration}`.slice(0,100),description:`${r.sku} | ${C.money(activePromo(r.sku)?.price??r.amount)}`,value:r.sku}))))]};}
function controls(t){const b=[];const s=t.status;
 if(t.type==='purchase'){
 if(s==='selecting')b.push(btn('act:choose','Pilih produk'),btn('act:cancel','Batalkan',ButtonStyle.Danger));
 if(s==='new')b.push(btn('act:claim','Claim Order',ButtonStyle.Primary),btn('act:cancel','Batalkan',ButtonStyle.Danger));
 if(s==='claimed')b.push(btn('act:issue','Buat Invoice QRIS',ButtonStyle.Primary),btn('act:cancel','Batalkan',ButtonStyle.Danger));
 if(s==='waiting')b.push(btn('act:paid','Konfirmasi Dana Masuk',ButtonStyle.Success),btn('act:cancel','Batalkan',ButtonStyle.Danger));
 if(s==='expired')b.push(btn('act:reconcile','Verifikasi Pembayaran Terlambat',ButtonStyle.Primary),btn('act:cancel','Batalkan',ButtonStyle.Danger));
 if(s==='processing')b.push(btn('act:complete','Selesaikan Pesanan',ButtonStyle.Success));
 if(s==='completed'&&!t.rating)b.push(btn('act:review','Beri Ulasan',ButtonStyle.Primary));
 }else{if(s==='new')b.push(btn('act:claim','Claim Ticket',ButtonStyle.Primary));if(s==='claimed')b.push(btn('act:reviewing','Mulai Review',ButtonStyle.Primary));if(s==='reviewing')b.push(btn('act:approve',t.type==='warranty'?'Setujui Garansi':'Mulai Penanganan',ButtonStyle.Success),btn('act:reject','Tolak / Tidak Memenuhi',ButtonStyle.Danger));if(s==='approved')b.push(btn('act:resolve','Tandai Selesai',ButtonStyle.Success));}
 b.push(btn('act:close','Tutup Ticket',ButtonStyle.Secondary));return [row(...b)];}
function summary(t){let desc=`**Status:** ${t.status}\n**Customer:** <@${t.owner}>\n**Staff:** ${t.staff?`<@${t.staff}>`:'Belum diambil'}`;if(t.sku)desc+=`\n**Paket:** ${t.sku} · ${t.product} · ${t.variant} · ${t.duration}\n**Harga:** ${C.money(t.price)}\n**Potongan:** ${C.money(t.discount)}\n**Total:** ${C.money(t.total)}`;if(t.device)desc+='\n**Device/lokasi:** '+t.device;if(t.notes)desc+='\n**Catatan:** '+t.notes;if(t.expiresAt)desc+=`\n**Batas invoice:** <t:${Math.floor(t.expiresAt/1000)}:F> (<t:${Math.floor(t.expiresAt/1000)}:R>)`;if(t.reason)desc+='\n**Alasan:** '+t.reason;return desc;}
async function sendControls(ch,t){const payload={embeds:[e('✦ '+t.id,summary(t))],components:controls(t)};const old=t.control?await ch.messages.fetch(t.control).catch(()=>null):null;if(old)await old.edit(payload);else{const m=await ch.send(payload);t.control=m.id;save();}}
async function sendInvoice(ch,t){if(QRIS_ENABLED!=='true')throw Error('QRIS belum diaktifkan di .env. Owner harus memverifikasi merchant dan izin penerbit.');if(t.status!=='waiting'||Date.now()>=t.expiresAt){if(C.expire(t)){save();await invalidateInvoice(ch,t);await sendControls(ch,t);}throw Error('Invoice tidak aktif atau sudah kedaluwarsa.');}const buffer=await qr.render({payload:t.payload});const payload={embeds:[e('✦ QRIS Payment',`${summary(t)}\nCek nama merchant dan nominal sebelum membayar. Kirim bukti di ticket. Jangan bayar setelah batas waktu; admin memverifikasi dana masuk secara manual.`).setImage('attachment://qris.png')],files:[new AttachmentBuilder(buffer,{name:'qris.png'})]};const old=t.invoiceMessage?await ch.messages.fetch(t.invoiceMessage).catch(()=>null):null;if(old)await old.edit({...payload,attachments:[]});else{const m=await ch.send(payload);t.invoiceMessage=m.id;save();}}
async function invalidateInvoice(ch,t){if(t.invoiceMessage){const m=await ch.messages.fetch(t.invoiceMessage).catch(()=>null);if(m)await m.edit({embeds:[e('Invoice tidak aktif','Jangan bayar QRIS lama. Jika sudah membayar, hubungi staff untuk verifikasi.')],attachments:[],components:[]});t.invoiceInvalidated=true;save();}}
function terminal(t){return ['completed','cancelled','resolved','rejected','expired'].includes(t.status);}
async function closeTicket(i,t){requireStaff(i,t);if(!terminal(t)){if(t.type==='purchase')throw Error('Selesaikan atau batalkan order terlebih dahulu.');throw Error('Selesaikan atau tolak komplain terlebih dahulu.');}
 const lines=[];let before;for(let page=0;page<10;page++){const batch=await i.channel.messages.fetch({limit:100,...(before?{before}:{})});if(!batch.size)break;for(const m of batch.values())lines.push({time:m.createdAt.toISOString(),user:m.author.id,content:m.content.slice(0,4000),embeds:m.embeds.map(x=>({title:x.title,description:x.description})),attachments:m.attachments.map(a=>a.name)});before=batch.last().id;if(batch.size<100)break;}
 const transcript=Buffer.from(JSON.stringify({ticket:t.id,status:t.status,owner:t.owner,limit:1000,messages:lines.reverse()},null,2));
 if(!await notify(i.guild,'transcripts',{content:`Transcript ${t.id} · ${t.type}`,files:[new AttachmentBuilder(transcript,{name:t.id+'.json'})]}))throw Error('Channel transcript belum tersedia. Jalankan /setup.');
 await i.channel.permissionOverwrites.edit(t.owner,{ViewChannel:false,SendMessages:false});t.closedAt=Date.now();save();await i.channel.setParent(db.channels.cat_archive,{lockPermissions:false});await i.channel.setName(ticketName(t.type,t.id,true));await i.channel.send({embeds:[e('Ticket closed','Transcript tersimpan. Staff dapat membuka kembali dengan `/ticket reopen`.')],components:[]});if(t.control){const m=await i.channel.messages.fetch(t.control).catch(()=>null);if(m)await m.edit({components:[]}).catch(console.error);}}
function getCatalog(sku){const r=catalog.find(x=>x.sku===sku.toUpperCase());if(!r)throw Error('SKU tidak ditemukan. Gunakan /harga.');return r;}
async function reply(i,data){const payload=typeof data==='string'?{content:data.slice(0,2000)}:data;if(i.deferred||i.replied)return i.editReply(payload);return i.reply({...payload,...ep});}
async function handleAction(i,t,action){
 if(action==='choose'){own(i,t);if(t.status!=='selecting')throw Error('Paket sudah dipilih.');return reply(i,productMenu());}
 if(action==='review'){own(i,t);if(t.status!=='completed'||t.rating)throw Error('Ulasan tidak tersedia.');return i.showModal(modal('review:'+t.id,'Ulasan pembelian',field('rating','Rating 1–5'),field('text','Ulasan',null,TextInputStyle.Paragraph,true,800)));}
 if(action==='reject'){requireStaff(i,t);if(t.status!=='reviewing')throw Error('Status tidak sesuai.');return i.showModal(modal('reject:'+t.id,'Alasan penolakan',field('reason','Alasan',null,TextInputStyle.Paragraph,true,500)));}
 if(action==='cancel'&&t.status==='selecting')own(i,t);else requireStaff(i,t);
 await i.deferReply(ep);return lock(t.id,async()=>{
 const status=t.status;if(t.closedAt)throw Error('Ticket sudah ditutup.');
 if(action==='close'){await closeTicket(i,t);return reply(i,'Ticket ditutup dan diarsipkan.');}
 if(t.staff&&t.staff!==i.user.id&&!manager(i))throw Error('Ticket sedang ditangani staff lain.');
 if(action==='claim'&&status==='new'){t.staff=i.user.id;t.status='claimed';}
 else if(action==='issue'&&status==='claimed'&&t.type==='purchase'){
  if(QRIS_ENABLED!=='true')throw Error('QRIS belum aktif. Verifikasi payload merchant dan ubah QRIS_ENABLED di .env dahulu.');
  const raw=fs.readFileSync(path.join(__dirname,'data','qris-payload.txt'),'utf8');t.payload=qr.makeAmountPayload(raw,t.total);t.issuedAt=Date.now();t.expiresAt=t.issuedAt+config.invoiceMinutes*C.MIN;t.status='waiting';save();await sendControls(i.channel,t);await sendInvoice(i.channel,t);
 }else if(action==='paid'&&status==='waiting'&&t.type==='purchase'){
  if(C.expire(t)){save();await invalidateInvoice(i.channel,t);await sendControls(i.channel,t);throw Error('Invoice kedaluwarsa. Gunakan verifikasi pembayaran terlambat.');}
  t.status='processing';t.paidAt=Date.now();t.paidBy=i.user.id;save();await invalidateInvoice(i.channel,t);await i.channel.send(media('✦ Order Processing','Dana masuk dikonfirmasi staff. Pesanan sedang diproses.','processing'));
 }else if(action==='reconcile'&&status==='expired'&&t.type==='purchase'){
  if(!manager(i))throw Error('Verifikasi terlambat khusus Store Admin.');
  if(t.voucher&&game.orderReservation(t.voucher))throw Error('Voucher sudah digunakan order lain; selesaikan secara manual, jangan konfirmasi ulang.');
  if(t.promoId){const p=B.flatPromos().find(x=>x.id===t.promoId);if(!p||B.allReservations().filter(x=>x!==t&&x.promoId===p.id&&!['cancelled','expired'].includes(x.status)).length>=p.slots)throw Error('Slot promo telah dialokasikan. Hubungi owner untuk rekonsiliasi manual.');}
  t.status='processing';t.paidAt=Date.now();t.paidBy=i.user.id;save();await invalidateInvoice(i.channel,t);await i.channel.send(media('✦ Order Processing','Pembayaran terlambat telah diverifikasi admin.','processing'));
 }else if(action==='complete'&&status==='processing'&&t.type==='purchase'){
  t.status='completed';t.doneAt=Date.now();t.doneBy=i.user.id;save();const m=await i.guild.members.fetch(t.owner).catch(()=>null);if(m&&db.roles.customer)await m.roles.add(db.roles.customer).catch(console.error);await i.channel.send(media('✦ Order Completed',`Order ${t.id} selesai. Simpan ID ini untuk garansi. Terima kasih, lovelies!`,'completed'));await notify(i.guild,'transactions',{embeds:[e('Transaksi selesai · '+t.id,summary(t))]}).catch(console.error);
 }else if(action==='cancel'&&['selecting','new','claimed','waiting','expired'].includes(status)&&t.type==='purchase'){t.status='cancelled';t.cancelledAt=Date.now();save();await invalidateInvoice(i.channel,t);}
 else if(action==='reviewing'&&status==='claimed'&&t.type!=='purchase')t.status='reviewing';
 else if(action==='approve'&&status==='reviewing'&&t.type!=='purchase')t.status='approved';
 else if(action==='resolve'&&status==='approved'&&t.type!=='purchase'){t.status='resolved';t.doneAt=Date.now();}
 else throw Error('Aksi tidak sesuai status ticket saat ini.');
 save();await sendControls(i.channel,t);await reply(i,'Status diperbarui: '+t.status);
 });}
const waControl=require('./lib/wa-control').setup({B,db,save,P,ChannelType,ButtonStyle,row,btn,e,modal,field,TextInputStyle,ep,reply,lock,guildId});
async function interaction(i){if(i.guildId!==guildId)return;
 if(i.customId?.startsWith('waorder:')||i.customId?.startsWith('waform:'))return waControl.handle(i);
 if(i.isButton()&&i.customId.startsWith('annmedia:')){const [,a,id]=i.customId.split(':');return chooseMedia(i,a,id);}
 if(i.isButton()){
  const [kind,val]=i.customId.split(':');if(kind==='studio'){requireContent(i);return i.showModal(studioForm(val));}if(kind==='promopage'){if(i.message.flags.has(MessageFlags.Ephemeral))await i.deferUpdate();else await i.deferReply(ep);return showPromo(i,Number(val)||0);}if(kind==='open'){if(!['purchase','warranty','support'].includes(val))return;if(i.channelId!==db.channels[val])throw Error('Buka panel ticket resmi.');if(val!=='purchase')return i.showModal(ticketForm(val));await i.deferReply(ep);const t=await createTicket(i,val);return reply(i,`Ticket dibuat: <#${t.channel}>`);}
  if(kind==='act')return handleAction(i,getTicket(i),val);
 }
 if(i.isStringSelectMenu()){
  const t=getTicket(i);own(i,t);if(t.status!=='selecting')throw Error('Paket sudah dikonfirmasi.');
  if(i.customId==='select:product')return reply(i,packageMenu(i.values[0]));
  if(i.customId==='select:package'){const r=getCatalog(i.values[0]);return i.showModal(modal('order:'+r.sku,'Konfirmasi pesanan',field('device','Device / lokasi (opsional)',null,TextInputStyle.Short,false),field('voucher','Kode voucher (opsional)',null,TextInputStyle.Short,false),field('notes','Catatan (jangan isi password/OTP)',null,TextInputStyle.Paragraph,false,500)));}
 }
 if(i.isModalSubmit()){
  const [kind,val]=i.customId.split(':');const value=k=>i.fields.getTextInputValue(k).trim();
  if(kind==='studio'){requireContent(i);await i.deferReply(ep);if(['wa','dc','both','information'].includes(val))return publishInfo(i,value('body'),val);if(val==='promo')return publishPromo(i,content.prices(value('prices'),catalog),content.duration(value('duration')),content.slots(value('slots')),value('caption'));throw Error('Form tidak dikenal.');}
  if(kind==='create'&&['warranty','support'].includes(val)){await i.deferReply(ep);const details=val==='warranty'?{'Order ID':value('order'),'Produk':value('product'),'Tanggal':value('date'),'Kendala':value('details')}:{'Kendala':value('details')};const t=await createTicket(i,val,details);return reply(i,`Ticket dibuat: <#${t.channel}>`);}
  const t=getTicket(i);
  if(kind==='order'){
   own(i,t);await i.deferReply(ep);return lock(t.id,async()=>{if(t.status!=='selecting')throw Error('Paket sudah dikonfirmasi.');const r=getCatalog(val),voucher=validVoucher(value('voucher').toUpperCase(),i.user.id),promo=activePromo(r.sku),quote=C.priceFor(r,promo,voucher);Object.assign(t,{...r,...quote,voucher:voucher?.serial||null,promoId:promo?.id||null,device:value('device'),notes:value('notes'),status:'new',orderedAt:Date.now()});save();await sendControls(i.channel,t);await notify(i.guild,'orders',{content:`<@&${db.roles.purchase}>`,allowedMentions:{roles:[db.roles.purchase]},embeds:[e('Order baru · '+t.id,summary(t)+`\n<#${t.channel}>`)]}).catch(console.error);return reply(i,'Order diterima. Staff akan mengambil pesanan.');});
  }
  if(val!==t.id)throw Error('Ticket tidak sesuai.');
  if(kind==='review'){own(i,t);await i.deferReply(ep);return lock(t.id,async()=>{if(t.status!=='completed'||t.rating)throw Error('Ulasan sudah ada atau order belum selesai.');const n=Number(value('rating'));if(!Number.isInteger(n)||n<1||n>5)throw Error('Rating harus 1–5.');t.rating=n;t.review=value('text');save();await notify(i.guild,'testimonials',{embeds:[e('✦ Customer Review','⭐'.repeat(n)+`\n**Produk:** ${t.product}\n${t.review}\n— Customer terverifikasi`)]});await sendControls(i.channel,t);return reply(i,'Terima kasih atas ulasannya!');});}
  if(kind==='reject'){requireStaff(i,t);await i.deferReply(ep);return lock(t.id,async()=>{if(t.status!=='reviewing'||(t.staff!==i.user.id&&!manager(i)))throw Error('Ticket tidak sesuai atau ditangani staff lain.');t.reason=value('reason');t.status='rejected';save();await sendControls(i.channel,t);return reply(i,'Klaim ditolak dengan alasan tercatat.');});}
 }
 if(!i.isChatInputCommand())return;
 const o=i.options,n=i.commandName,g=i.guild,s=()=>o.getSubcommand();
 if(n==='content'){requireContent(i);return i.showModal(studioForm(s()));}
 await i.deferReply(ep);
 if(n==='announcementmedia')return submitMedia(i);
 if(n==='welcome'){requireManager(i);const member=await g.members.fetch(o.getUser('member').id);if(member.user.bot)throw Error('Pilih member manusia.');W.enqueue(db.welcomeQueue,member.id,member.joinedTimestamp,s()==='repair');const job=db.welcomeQueue[member.id];if(s()==='repair'&&!job.welcomeDone)job.sendWelcome=true;job.nextAt=0;save();processWelcome(g).catch(err=>console.error('Welcome queue:',err.message));return reply(i,'Pemulihan masuk antrean. Cek channel welcome dan role member; bot mencoba ulang otomatis jika koneksi gagal.');}
 if(n==='setup'){if(!i.memberPermissions.has(P.Administrator))throw Error('Khusus Administrator Discord.');await lock('setup',()=>setup(g));return reply(i,'Setup selesai! Cek channel dan role yang dibuat. Beri role staff melalui Server Settings.');}
 if(n==='store'){
  if(s()==='status')return reply(i,`${opened()?'🟢 OPEN':'🔴 CLOSED'} · ${scheduleText()}`);requireManager(i);
  if(s()==='mode')B.setSchedule({...B.schedule(),mode:o.getString('mode')});else{const a=o.getString('buka'),b=o.getString('tutup');B.setSchedule({mode:'auto',open:a,close:b});}await lock('panels',()=>refreshPanels(g,true));lastStatus=opened();return reply(i,`Status diperbarui: ${scheduleText()}`);
 }
 if(n==='pricelist')return reply(i,media('✦ Pricelist','Lihat /harga untuk kode paket.','pricelist'));
 if(n==='harga'){const q=o.getString('produk');if(!q)return reply(i,[...new Set(catalog.map(r=>r.product))].join(' · '));const rs=catalog.filter(r=>r.product.toLowerCase().includes(q.toLowerCase()));if(!rs.length)throw Error('Produk tidak ditemukan.');const lines=rs.map(r=>`${r.sku} · ${r.product} · ${r.variant} · ${r.duration} · ${C.money(activePromo(r.sku)?.price??r.amount)}`);const text=lines.join('\n');return reply(i,text.length<=1900?text:{files:[new AttachmentBuilder(Buffer.from(text),{name:'harga.txt'})]});}
 if(n==='order'){const id=o.getString('id')?.toUpperCase(),jid=B.linked(i.user.id);const list=tickets().filter(t=>t.owner===i.user.id&&t.type==='purchase'&&(!id||t.id===id)).map(t=>`[DC] ${t.id} · ${t.product||'Belum pilih produk'} · ${t.status}${t.total?' · '+C.money(t.total):''}`);if(jid)for(const t of B.wa.orders.data.orders.filter(t=>(t.buyerAccountId||t.buyerJid)===jid&&(!id||t.id===id)))list.push(`[WA] ${t.id} · ${t.product} · ${t.status}${t.total?' · '+C.money(t.total):''}`);return reply(i,list.length?list.slice(-10).join('\n'):'Tidak ada order.');}
 if(n==='promo'){
  if(s()==='list')return showPromo(i);requireManager(i);
  if(s()==='add')return publishPromo(i,content.prices(o.getString('sku')+' '+o.getInteger('harga'),catalog),o.getInteger('menit'),o.getInteger('slot'),'');
  B.endPromo(o.getString('id').toUpperCase());await refreshPromo(g,true).catch(err=>console.error('Promo panel:',err.message));return reply(i,'Promo dihentikan. Panel akan diperbarui.');
 }
 if(n==='sales'){requireManager(i);const completed=tickets().filter(t=>t.status==='completed'&&t.type==='purchase'),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',dateStyle:'short'}),today=completed.filter(t=>day.format(t.doneAt)===day.format(Date.now()));const a=B.sales('today'),b=B.sales('all');return reply(i,`Gabungan WA + Discord (order selesai)\nHari ini: ${a.count} · ${C.money(a.total)}\nTotal: ${b.count} · ${C.money(b.total)}\nPendapatan kotor, bukan laba.`);}
 if(n==='backup'){if(!i.memberPermissions?.has(P.Administrator))throw Error('Backup lintas platform khusus Administrator.');const snapshot=require('../backup').snapshot();return reply(i,{content:'Backup data WA & Discord. Simpan privat. Jangan bagikan data pelanggan. Session WA dan token tidak termasuk.',files:[new AttachmentBuilder(Buffer.from(JSON.stringify(snapshot,null,2)),{name:'orivela-data-backup.json'})]});}
 if(n==='announce'){requireManager(i);return publishInfo(i,o.getString('pesan'),'announcement');}
 if(n==='invoice'){const t=getTicket(i);requireStaff(i,t);return lock(t.id,async()=>{await sendInvoice(i.channel,t);return reply(i,'Invoice aktif dikirim ulang. Batas waktu tidak berubah.');});}
 if(n==='ticket'){
  if(s()==='reopen'){const t=tickets().find(t=>t.channel===i.channelId&&t.closedAt);if(!t)throw Error('Bukan arsip ticket.');requireStaff(i,t);return lock(t.id,async()=>{if(tickets().some(x=>x.owner===t.owner&&x.type===t.type&&!x.closedAt))throw Error('Pelanggan sudah mempunyai ticket aktif.');await i.channel.setParent(db.channels['cat_'+t.type],{lockPermissions:false});await i.channel.permissionOverwrites.edit(t.owner,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true,AttachFiles:true});delete t.closedAt;if(t.type!=='purchase'&&['resolved','rejected'].includes(t.status)){t.status='reviewing';t.staff=i.user.id;delete t.reason;}save();await i.channel.setName(ticketName(t.type,t.id));await sendControls(i.channel,t);return reply(i,'Ticket dibuka kembali (status transaksi tidak berubah).');});}
  const t=getTicket(i);requireStaff(i,t);return lock(t.id,async()=>{if(s()==='close')await closeTicket(i,t);else await sendControls(i.channel,t);return reply(i,'Berhasil.');});
 }
 if(['game','voucher','link'].includes(n))return reply(i,'Luckyverse pindah ke bot game: gunakan `os!help` di game-zone.');
}
client.on(Events.InteractionCreate,i=>interaction(i).catch(async err=>{console.error('Interaction:',err.message);const safe=err.code?'Terjadi kesalahan Discord. Cek izin bot dan console hosting.':err.message;try{await reply(i,safe||'Terjadi kesalahan.');}catch(e){console.error(e.message);}}));
let welcomeRunning=false;
async function processWelcome(g){if(welcomeRunning||!db.channels.welcome||!db.roles.member)return;welcomeRunning=true;try{for(const job of Object.values(db.welcomeQueue).filter(j=>j.nextAt<=Date.now()).slice(0,10)){let m;try{m=g.members.cache.get(job.id)||await g.members.fetch(job.id);}catch(err){if(err.code===10007){delete db.welcomeQueue[job.id];save();}else{job.attempts++;job.nextAt=Date.now()+W.delay(job.attempts);save();console.error('Welcome member fetch:',err.message);}continue;}if(m.joinedTimestamp!==job.joinedAt){delete db.welcomeQueue[job.id];save();continue;}const done=await W.run(job,{save,role:async()=>{if(!m.roles.cache.has(db.roles.member))await m.roles.add(db.roles.member);},welcome:async()=>{const ch=await channel(g,'welcome');if(!ch)throw Error('Channel welcome belum tersedia');await ch.send({nonce:W.nonce(job),enforceNonce:true,content:`Hii, <@${m.id}>! ♡`,allowedMentions:{users:[m.id]},...media('✦ Welcome to ORIVELA Starfall',`Selamat datang! Kamu member ke-${m.guild.memberCount}.\nBaca <#${db.channels.rules}> dan <#${db.channels.prices}>.\nPesan: <#${db.channels.purchase}>. Garansi: <#${db.channels.warranty}>.`,'welcome')});},log:(stage,err)=>console.error('Welcome retry '+stage+':',err.message)});if(done){delete db.welcomeQueue[job.id];save();console.log('Welcome/role selesai:',job.id);}}}finally{welcomeRunning=false;}}
client.on(Events.GuildMemberAdd,m=>{if(m.guild.id!==guildId||m.user.bot)return;W.enqueue(db.welcomeQueue,m.id,m.joinedTimestamp,true);save();processWelcome(m.guild).catch(err=>console.error('Welcome queue:',err.message));});
let lastStatus=null,ticking=false;
async function tick(g){if(ticking)return;ticking=true;try{
 const on=opened();if(db.channels.status&&on!==lastStatus&&!locks.has('setup')&&!locks.has('panels')){await lock('panels',()=>refreshPanels(g));if(lastStatus!==null)await notify(g,'announcement',{embeds:[e(on?'✦ Store Open':'☾ Store Closed',`${scheduleText()}\n${on?'Ticket pembelian dibuka.':'Garansi dan support tetap tersedia.'}`)]}).catch(console.error);lastStatus=on;}
 for(const t of tickets()){if(locks.has(t.id))continue;if(t.status!=='waiting'&&t.invoiceMessage&&!t.invoiceInvalidated){await lock(t.id,async()=>{const ch=await g.channels.fetch(t.channel).catch(()=>null);if(ch)await invalidateInvoice(ch,t);}).catch(console.error);}if(t.closedAt)continue;if(t.status==='waiting'&&Date.now()>=t.expiresAt){await lock(t.id,async()=>{if(!C.expire(t))return;save();const ch=await g.channels.fetch(t.channel).catch(()=>null);if(ch){await invalidateInvoice(ch,t);await sendControls(ch,t);await ch.send({embeds:[e('☾ Payment Expired','Tagihan berakhir. Jangan bayar QRIS lama. Jika sudah membayar, hubungi admin.')]});}}).catch(console.error);}}
 const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',dateStyle:'short'}).format(new Date());if(db.backupDay!==day){if(db.backupDay&&db.channels.sales){const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',dateStyle:'short'});const done=tickets().filter(t=>t.type==='purchase'&&t.status==='completed'&&fmt.format(t.doneAt)===db.backupDay);await notify(g,'sales',{embeds:[e('✦ Rekap penjualan · '+db.backupDay,`${done.length} pesanan selesai · ${C.money(done.reduce((sum,t)=>sum+t.total,0))} pendapatan kotor`)]}).catch(console.error);}const dest=path.join(runtime,'backups');fs.mkdirSync(dest,{recursive:true});for(const file of [dbfile,game.filePath])fs.copyFileSync(file,path.join(dest,day.replace(/[^0-9]/g,'-')+'-'+path.basename(file)));db.backupDay=day;save();const files=fs.readdirSync(dest).sort();if(files.length>28)for(const file of files.slice(0,files.length-28))fs.unlinkSync(path.join(dest,file));}
 }finally{ticking=false;}}
client.once(Events.ClientReady,async c=>{console.log(`ORIVELA V3 Discord online: ${c.user.tag}`);let g=c.guilds.cache.get(guildId),ready=false,booting=false;const boot=async()=>{if(ready||booting)return;booting=true;try{g ||= await c.guilds.fetch(guildId);await g.commands.set(commands);ready=true;console.log('Slash commands V3 terdaftar. Jalankan /setup sebagai admin.');}catch(err){console.error('Registrasi command tertunda:',err.message);}finally{booting=false;}};const update=()=>{c.user.setActivity(opened()?'Store OPEN · /pricelist':'Store CLOSED · /store status',{type:ActivityType.Watching});};const cycle=()=>{update();if(!ready)boot().catch(console.error);if(!g)return;B.dcSender=async ev=>{if(ev.kind==='promo'){await refreshPromo(g,true);return;}const ch=await channel(g,'announcement');if(!ch)throw Error('Jalankan /setup dulu');await ch.send(M.dcContent(posts.dcAnnouncement(ev),ev.media));};B.waOrderReply=(o,ev)=>waControl.forward(g,o,ev);waControl.tick(g).catch(err=>console.error('WA Control:',err.message));for(const [id,d] of announcementDrafts)if(d.until<Date.now())announcementDrafts.delete(id);tick(g).catch(err=>console.error('Scheduler:',err.message));processWelcome(g).catch(err=>console.error('Welcome queue:',err.message));if(!locks.has('setup')&&!locks.has('promo-panel'))refreshPromo(g).catch(err=>console.error('Promo panel:',err.message));};cycle();setInterval(cycle,15000);});
client.on(Events.Error,err=>console.error('Discord error:',err.message));process.on('unhandledRejection',err=>console.error('Unhandled:',err?.message||err));const login=()=>client.login(token).catch(err=>{console.error('Login Discord gagal:',err.message);if(err.code==='TokenInvalid'||err.code===4004)return;setTimeout(login,30000);});login();
