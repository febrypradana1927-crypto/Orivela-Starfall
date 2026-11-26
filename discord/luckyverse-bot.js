'use strict';
const fs=require('node:fs'),path=require('node:path');
const L=require('./luckyverse-commands');
const {Client,GatewayIntentBits,Partials,Events,ActivityType}=require('discord.js');
const guildId=process.env.GUILD_ID;
function start(B){
 const token=process.env.LUCKYVERSE_TOKEN;
 if(!token||token.startsWith('ISI_')||token===process.env.DISCORD_TOKEN)throw Error('Isi LUCKYVERSE_TOKEN dengan token BOT BARU, bukan token Store.');
 if(!/^\d{17,22}$/.test(guildId||''))throw Error('GUILD_ID belum valid.');
 const game=B.wa.game,client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent,GatewayIntentBits.DirectMessages],partials:[Partials.Channel],allowedMentions:{parse:[],repliedUser:false},rest:{timeout:30000,retries:3}});
 const gameZone=()=>{try{return JSON.parse(fs.readFileSync(path.join(__dirname,'data/runtime/store.json'),'utf8')).channels.games;}catch{return null;}};
 const embed=(desc)=>({color:0xcc9ede,description:String(desc).slice(0,4096),footer:{text:'✦ ORIVELA LUCKYVERSE · your digital space ☾'}});
 const send=(m,text)=>m.reply({embeds:[embed(text)],allowedMentions:{parse:[],repliedUser:false}});
 const privateActions=new Set(['link','linkstatus','voucher','vouchers']);
 const busy=new Set(),seen=new Map();
 async function handle(m){
  if(m.author.bot||m.webhookId)return;const p=L.parse(m.content);if(!p)return;
  if(m.guildId&&m.guildId!==guildId)return;
  const id=m.author.id,zone=gameZone();if(m.guildId&&m.channelId!==zone){if(p.action==='help')return send(m,zone?`Gunakan <#${zone}> untuk bermain.`:'Minta admin Store menjalankan /setup.');return;}
  if(!m.guildId){const g=client.guilds.cache.get(guildId)||await client.guilds.fetch(guildId);try{await g.members.fetch(id);}catch{return send(m,'Command hanya untuk member server ORIVELA Starfall.');}}
  if(seen.has(m.id)||busy.has(id))return;seen.set(m.id,Date.now());busy.add(id);
  try{
   let uid=B.gameId(id);const name=m.member?.displayName||m.author.globalName||m.author.username;
   if(p.action==='help')return await send(m,L.help);
   if(privateActions.has(p.action)&&m.guildId){return await send(m,'Untuk keamanan, buka DM bot Luckyverse dan ketik `os!'+p.action+'`'+(p.action==='voucher'?' (pilih nominal di DM)':'')+'. Kode tidak diposting ke channel.');}
   if(p.action==='link'){if(B.linked(id))return await send(m,'Akun sudah terhubung. Saldo dan inventory digunakan bersama.');let code;try{code=B.newCode(id);}catch(e){return await send(m,e.message);}return await send(m,'Link opsional ♡\nKirim **DM pribadi** ke nomor bot WhatsApp: `.link '+code+'`\nKode berlaku 10 menit dan hanya sekali pakai. Jangan bagikan. Jika kedua akun sudah punya profil, hubungi owner untuk migrasi.');}
   if(p.action==='linkstatus')return await send(m,B.linked(id)?'✅ Akun WhatsApp terhubung.':'Belum terhubung. Kamu tetap bisa bermain normal.');
   if(p.action==='vouchers'){const rows=L.voucherRows(game,uid);return await send(m,rows.length?rows.map(v=>`**${v.serial}** · Rp${v.discount.toLocaleString('id-ID')} · ${v.status}\nBerlaku sampai <t:${Math.floor(Date.parse(v.expiresAt)/1000)}:F>`).join('\n\n'):'Belum ada voucher.');}
   if(p.action==='voucher'){
    if(!p.args.length)return await send(m,'🎟️ **STARFALL VOUCHER**\n5.000.000 koin → Rp5.000\n9.500.000 koin → Rp10.000\n14.000.000 koin → Rp15.000\n\n`os!voucher 5000` (atau 10000 / 15000). Berlaku 5 hari, tidak dapat diuangkan.');
    if(p.args.length!==1||!['5000','10000','15000'].includes(p.args[0]))return await send(m,'Nominal voucher tidak valid.');
    const r=game.redeemVoucher(uid,name,Number(p.args[0]),'dc-msg:'+m.id,'Discord');if(r.error)return await send(m,L.format(r.error));
    // Persistent list means the code can be recovered even if the reply fails.
    await send(m,`🎟️ **${r.voucher.serial}** · Rp${r.voucher.discount.toLocaleString('id-ID')}\nBerlaku sampai <t:${Math.floor(Date.parse(r.voucher.expiresAt)/1000)}:F>. Gunakan di order milikmu. Cek ulang dengan os!vouchers.`);game.markVoucherDmSent(r.voucher.serial);return;
   }
   if(!m.guildId)return await send(m,zone?`Gunakan <#${zone}> untuk bermain. Ketik os!help untuk panduan.`:'Minta admin melakukan /setup.');
   if(!L.actions.has(p.action))return await send(m,'Command tidak dikenal. Ketik `os!help`.');
   if(p.action==='jawab')return await send(m,L.format(game.handleText(uid,name,p.args.join(' '))||'Tidak ada ronde aktif. Ketik os!susunkata.'));
   let args=p.args;
   if(p.action==='give'){
    const mention=args[0]?.match(/^<@!?(\d{17,22})>$/);if(!mention||args.length!==2||!/^\d+$/.test(args[1]))return await send(m,'Format: `os!give @member 100`.');
    const member=await m.guild.members.fetch(mention[1]).catch(()=>null);if(!member||member.user.bot)return await send(m,'Penerima harus member manusia di server ini.');uid=B.gameId(id);args=[B.gameId(member.id),args[1]];
   }
   return await send(m,L.format(game.handleCommand(uid,name,p.action,args,{platform:'dc',linkedIds:Object.values(B.links()),chatId:m.channelId,mentionJid:id})));
  }finally{busy.delete(id);}
 }
 client.on(Events.MessageCreate,m=>handle(m).catch(async e=>{console.error('Luckyverse command:',e.message);try{await send(m,'Command gagal. Coba lagi atau hubungi admin.');}catch{}}));
 let running=false;const retry=new Map();
 async function mining(){if(running)return;running=true;try{const zone=gameZone();if(!zone)return;for(const p of Object.values(game.data.players)){const job=p.miningJob;if(!job||job.chatId!==zone||!/^\d{17,22}$/.test(String(job.mentionJid||'')))continue;if((retry.get(p.id)||0)>Date.now())continue;try{game.completeMining(p.id);if(p.miningJob?.status!=='ready')continue;const ch=await client.channels.fetch(zone);if(ch?.guildId!==guildId||!ch.isTextBased())throw Error('Game zone tidak valid');await ch.send({content:`<@${job.mentionJid}>`,embeds:[embed(L.format(job.resultText))],allowedMentions:{users:[job.mentionJid]}});game.markMiningNotified(p.id);retry.delete(p.id);}catch(e){retry.set(p.id,Date.now()+60000);console.error('Luckyverse mining:',e.message);}}}finally{running=false;}}
 client.once(Events.ClientReady,c=>{console.log('ORIVELA Luckyverse online: '+c.user.tag+' | os!help');c.user.setActivity('os!help · Luckyverse ☾',{type:ActivityType.Playing});setInterval(()=>{for(const [id,t] of seen)if(Date.now()-t>600000)seen.delete(id);mining().catch(console.error);},3000);});
 client.on(Events.Error,e=>console.error('Luckyverse Discord:',e.message));
 const login=()=>client.login(token).catch(e=>{console.error('Login Luckyverse gagal:',e.message);if(!['TokenInvalid',4004,4014].includes(e.code))setTimeout(login,30000);});login();return client;
}
module.exports={start};
