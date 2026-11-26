'use strict';
const aliases={bal:'balance',saldo:'balance',profil:'profile',me:'profile',inv:'inventory',bag:'inventory',area:'minearea',rank:'leaderboard',lb:'leaderboard',wordmix:'susunkata',games:'help',game:'help',menu:'help',tool:'pickaxe',mineinfo:'mining'};
const actions=new Set(['balance','profile','daily','mine','mining','minearea','inventory','sell','upgrade','repair','shop','pickaxe','leaderboard','susunkata','jawab','give']);
const help=[
'**✦ ORIVELA LUCKYVERSE ☾**','Hii, little stars! ♡ Main langsung tanpa link WhatsApp.','',
'**🪙 Account & Rewards**','`os!bal` / `os!balance` — saldo','`os!profile` — level, XP, energi','`os!daily` — hadiah harian','`os!give @member 100` — transfer koin','`os!lb` — leaderboard','',
'**⛏️ Mining Adventure**','`os!mine` — mulai mining (30 detik)','`os!mining` — status tambang','`os!area` / `os!area deep` / `os!area crystal` — area','`os!inv` — inventory','`os!sell all` / `os!sell iron 5` — jual mineral','`os!pickaxe` — status alat','`os!upgrade` / `os!repair` / `os!shop` — peralatan','',
'**🧩 Mini Game**','`os!susunkata` — mulai ronde','`os!jawab KATA` — jawab ronde','`os!susunkata stop` — batalkan ronde','',
'**🎟️ Voucher & Link (DM bot)**','`os!voucher` — daftar reward','`os!voucher 5000` (atau 10000 / 15000) — tukar koin','`os!vouchers` — kode voucher milikmu','`os!link` — link WA opsional','`os!linkstatus` — cek status link','',
'ORIVELA Starfall · your digital space ☾'].join('\n');
function parse(text){const m=String(text||'').trim().match(/^os!\s*([a-z]+)(?:\s+([\s\S]*))?$/i);if(!m)return null;const name=m[1].toLowerCase();return {action:aliases[name]||name,args:(m[2]||'').trim().split(/\s+/).filter(Boolean)};}
function format(text){return String(text||'Tidak ada hasil.').replace(/\.(?=(?:games|game|help|balance|profile|daily|minearea|mining|mine|inventory|sell|upgrade|repair|shop|pickaxe|leaderboard|susunkata|voucher|give)\b)/gi,'os!').replace(/Ketik jawaban langsung di chat\. Tidak perlu titik di depan jawaban!/g,'Jawab dengan os!jawab KATA.').replace(/Hasil akan dikirim otomatis ke grup ini/g,'Hasil akan dikirim otomatis ke channel ini');}
function voucherRows(game,uid){return Object.values(game.data.vouchers).filter(v=>v.ownerId===uid).map(v=>game.getVoucher(v.serial).voucher).filter(Boolean).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)).slice(0,15);}
module.exports={parse,format,actions,help,voucherRows};
