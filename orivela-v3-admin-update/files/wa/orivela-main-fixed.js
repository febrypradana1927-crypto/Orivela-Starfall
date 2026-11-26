'use strict';

// ORIVELA Starfall V5.0 | Full hosting package | Baileys
// Gabungan V4.1–V4.7: Store, Admin, Luckyverse, QRIS, promo, announcement, jadwal WIB.
const fs = require('node:fs');
const path = require('node:path');
const pino = require('pino');
// Baileys versi server ANJAS ini mendukung impor ESM dinamis.
// Jangan gunakan require('@whiskeysockets/baileys') di startup lama.
let makeWASocket;
let useMultiFileAuthState;
let DisconnectReason;
const { texts, publicReply, isGroupJid, normalizeCommand, digits } = require('./logic');
const { OrderStore, parseOrderForm, parseAmount, rupiah, normalizeId } = require('./order-system');
const { LuckyverseGame, ITEMS, PICKAXES, levelInfo } = require('./luckyverse-game');

const B = require('../shared'), M=require('../media-bridge');
const ROOT = __dirname;
const CFG = path.join(ROOT, 'config.json');
const AUTH = path.join(ROOT, 'auth_info_baileys');
const qrisInvoice = require('./qris-invoice');
const { PromoManager } = require('./promo-system');
const { AnnouncementManager, memberJids } = require('./announcement-system');
const posts=require('../discord/lib/text-posts'), postCatalog=require('../discord/data/catalog.json');
const invoiceStore = new qrisInvoice.InvoiceStore(path.join(ROOT, 'data', 'qris-invoices.json'));
const PAYMENT_TTL = 30 * 60000;
const QRIS_PRICES = path.join(ROOT, '..', 'discord', 'data', 'catalog.json');
function qrisEnabled(cfg) { return process.env.QRIS_ENABLED === 'true' && cfg.qrisInvoiceEnabled === true; }
function issueInvoice(order, amount, cfg) {
  if (!qrisEnabled(cfg)) throw new Error('QRIS nominal belum diaktifkan di config.json.');
  const raw = fs.readFileSync(path.join(ROOT, '..', 'discord', 'data', 'qris-payload.txt'), 'utf8');
  return invoiceStore.issue(order, amount, raw);
}
async function sendInvoice(sock, order, invoice, cfg, quoted) {
  if (order.groupId !== cfg.groupId || !isGroupJid(order.groupId)) throw new Error('Grup Store asal tidak cocok.');
  if (order.paidAt || order.doneAt || order.cancelledAt) throw new Error('Order sudah dibayar atau selesai.');
  const image = await qrisInvoice.render(invoice);
  const latest = orders.byId(order.id);
  if (!latest || latest.paidAt || latest.doneAt || latest.cancelledAt || paymentDue(latest)) throw new Error('Order sudah berubah status atau kedaluwarsa.');
  const mention = buyerMention(order);
  return sock.sendMessage(order.groupId, { image, mimetype:'image/png', mentions: mention.jids,
    caption: texts.invoicePayment.replaceAll('{order_id}', '#'+order.id).replaceAll('Rp{total}', order.promoId ? `~${rupiah(order.originalPrice)}~ *${rupiah(invoice.amount)}*` : rupiah(invoice.amount)).replaceAll('{total}', Number(invoice.amount).toLocaleString('id-ID')).replaceAll('{buyer}', mention.text) }, quoted ? {quoted} : {});
}
const LOG = pino({ level: 'silent' });
const orders = new OrderStore(path.join(ROOT, 'data', 'orders.json'));
const luckyverse = new LuckyverseGame(path.join(ROOT, 'data', 'luckyverse.json'));
const miningNotifying = new Set();
const gameHandledMessages = new Set();
let miningInterval = null;
let lastVoucherFlushAt = 0;
const STORE_SCHEDULE_STATE = path.join(ROOT, "data", "store-schedule-state.json");
let storeScheduleInterval = null;
let storeScheduleChecking = false;
let storeScheduleState = null;
const closedReminderCooldown = new Map();

// Penyimpanan pemilik order dan ID notifikasi terpisah dari data/orders.json.
// Ini menjaga struktur database V2 dan histori order tetap kompatibel.
class AdminLocks {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) {
      this.data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (this.data.version !== 1 || !this.data.claims || !this.data.messages ||
          typeof this.data.claims !== 'object' || Array.isArray(this.data.claims) ||
          typeof this.data.messages !== 'object' || Array.isArray(this.data.messages)) {
        throw new Error('data/order-admin-locks.json tidak valid. Pulihkan backup; jangan dihapus!');
      }
    } else {
      this.data = { version: 1, claims: {}, messages: {} };
      this.save();
    }
  }
  save() {
    const temp = this.filePath + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
  }
  rememberNotification(group, messageId, orderId) {
    if (!isGroupJid(group) || !messageId || !orders.byId(orderId)) return;
    this.data.messages[`${group}|${messageId}`] = orderId;
    this.save();
  }
  orderFromQuote(group, messageId) {
    const id = this.data.messages[`${group}|${messageId}`];
    return id && orders.byId(id) ? id : null;
  }
  sameOwner(locked, admin) {
    return !!(locked && (locked.key === admin.key ||
      locked.ids.some(id => admin.ids.includes(id))));
  }
  claim(id, admin) {
    const lock = this.data.claims[id];
    if (lock) {
      if (!this.sameOwner(lock, admin)) {
        return { error: `Order #${id} sudah diambil admin ${lock.name}. Admin lain tidak dapat memprosesnya.` };
      }
      return { lock, created: false };
    }
    const created = { key: admin.key, ids: admin.ids, name: admin.name, at: new Date().toISOString() };
    this.data.claims[id] = created;
    this.save();
    return { lock: created, created: true };
  }
  release(id, admin) {
    const lock = this.data.claims[id];
    if (!lock) return { error: 'Order ini belum diambil admin.' };
    if (!this.sameOwner(lock, admin)) return { error: `Hanya ${lock.name} yang boleh melepas order ini.` };
    delete this.data.claims[id];
    this.save();
    return { released: true };
  }
}
const adminLocks = new AdminLocks(path.join(ROOT, 'data', 'order-admin-locks.json'));
const promos = new PromoManager({file:path.join(ROOT,'data','promotions.json'),orders,catalogRows,sendText,verifyAdmin:verifiedOrderAdmin,quoteId:quoteMessageId,
  downloadPhoto:async(sock,msg)=>{
    const baileys=await import('@whiskeysockets/baileys');
    const download=baileys.downloadMediaMessage||baileys.default?.downloadMediaMessage;
    if(typeof download!=='function')throw Error('Baileys tidak menyediakan download media.');
    return download(msg,'buffer',{}, {logger:LOG,reuploadRequest:sock.updateMediaMessage?.bind(sock)});
  }
});

const announcements = new AnnouncementManager({sendText,verifyAdmin:verifiedOrderAdmin,quoteId:quoteMessageId,downloadPhoto:promos.downloadPhoto});

function quoteMessageId(message) {
  if (!message) return null;
  const content = message.ephemeralMessage?.message || message.viewOnceMessage?.message || message;
  const context = content.extendedTextMessage?.contextInfo || content.imageMessage?.contextInfo ||
    content.videoMessage?.contextInfo || content.documentMessage?.contextInfo;
  return context?.stanzaId || null;
}

// Identitas admin diambil dari metadata grup, termasuk alias LID/nomor bila ada.
// Jangan percaya pushName saja untuk menentukan kepemilikan order.
async function verifiedOrderAdmin(sock, groupId, msg) {
  try {
    const meta = await sock.groupMetadata(groupId);
    const senderIds = new Set([
      localId(msgSender(msg)), localId(msg.key.participantAlt), localId(msg.key.participantPhone)
    ].filter(Boolean));
    const member = meta.participants.find(p => IDsForParticipant(p).some(id => senderIds.has(id)));
    if (!member || !['admin', 'superadmin'].includes(member.admin)) return null;
    const ids = [...new Set(IDsForParticipant(member))];
    const key = String(member.id || member.jid || member.lid || member.phoneNumber || '');
    if (!key || !ids.length) return null;
    const name = String(msg.pushName || 'Admin').replace(/[\r\n\t]/g, ' ').trim().slice(0, 50) || 'Admin';
    return { key, ids, name };
  } catch (error) {
    console.error('Tidak dapat memverifikasi admin untuk order:', error.message);
    return null;
  }
}

function resolveOrderReference(chat, msg, args) {
  const first = args[0] || '';
  const explicit = normalizeId(first);
  if (explicit) return { id: explicit, remainder: args.slice(1), origin: 'ID' };
  if (first.startsWith('#') || /^ORV-/i.test(first)) return { error: 'Format ID order tidak valid.' };
  const quotedId = quoteMessageId(msg.message);
  const mapped = quotedId && adminLocks.orderFromQuote(chat, quotedId);
  if (!mapped) return { error: 'Reply pesan NEW ORDER dari bot, atau gunakan perintah dengan #ID. Notifikasi lama (sebelum upgrade) wajib pakai #ID.' };
  return { id: mapped, remainder: args, origin: 'reply' };
}

const inProgress = new Set();
let activeSocket = null;
let retryHandle = null;

function loadConfig() {
  const config = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('config.json tidak valid');
  }
  // Kompatibilitas: versi lama memakai gameGroupId, versi voucher memakai luckyverseGroupId.
  if (!config.luckyverseGroupId && config.gameGroupId) config.luckyverseGroupId = config.gameGroupId;
  if (config.luckyverseGroupId) config.gameGroupId = config.luckyverseGroupId;
  const roles = ['groupId', 'adminGroupId', 'luckyverseGroupId'];
  const ids = roles.map(role => config[role]).filter(Boolean);
  if (ids.some(id => !isGroupJid(id))) throw new Error('ID grup pada config.json tidak valid.');
  if (new Set(ids).size !== ids.length) throw new Error('Store, Admin, dan Luckyverse harus menggunakan tiga ID grup berbeda. Perbaiki config.json.');
  // Hanya satu grup admin untuk order dan voucher. Abaikan target voucher lama.
  config.luckyverseAdminGroupId = config.adminGroupId || '';
  return config;
}
function saveConfig(cfg) {
  const temp = CFG + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(cfg, null, 2) + '\n');
  fs.renameSync(temp, CFG);
}
function getText(message) {
  if (!message) return '';
  const content = message.ephemeralMessage?.message || message.viewOnceMessage?.message || message;
  return content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.videoMessage?.caption || '';
}
function localId(id) { return String(id || '').split(':')[0].split('@')[0]; }
function IDsForParticipant(participant) {
  return [participant.id, participant.phoneNumber, participant.lid, participant.jid]
    .filter(Boolean).map(localId);
}
function msgSender(msg) {
  return String(msg.key.participant || msg.key.participantAlt || msg.key.remoteJid || '');
}

// Tetap memeriksa status admin grup berdasarkan metadata WhatsApp.
async function senderIsGroupAdmin(sock, groupId, msg) {
  try {
    const meta = await sock.groupMetadata(groupId);
    const sender = new Set([
      localId(msgSender(msg)), localId(msg.key.participantAlt), localId(msg.key.participantPhone)
    ].filter(Boolean));
    const found = meta.participants.find(member => IDsForParticipant(member).some(v => sender.has(v)));
    return !!(found && (found.admin === 'admin' || found.admin === 'superadmin'));
  } catch (error) {
    console.error('Gagal memverifikasi admin grup:', error.message);
    return false;
  }
}
function messageContextInfo(msg) {
  let content = msg?.message;
  for (let i = 0; i < 4; i++) {
    if (content?.ephemeralMessage?.message) content = content.ephemeralMessage.message;
    else if (content?.viewOnceMessage?.message) content = content.viewOnceMessage.message;
    else if (content?.viewOnceMessageV2?.message) content = content.viewOnceMessageV2.message;
    else break;
  }
  return content?.extendedTextMessage?.contextInfo || content?.imageMessage?.contextInfo ||
    content?.videoMessage?.contextInfo || content?.documentMessage?.contextInfo || null;
}
function normalizedLocalId(id) {
  return localId(String(id || '').replace(/^@/, ''));
}
const pendingGameResets = new Map();
const GAME_ADMIN_COMMANDS = new Set([
  'gameadmin', 'addbalance', 'removebalance', 'setbalance', 'addxp',
  'giveitem', 'adminplayer', 'resetplayer', 'confirmreset'
]);

async function resolveGameAdminTarget(sock, chat, msg, args) {
  const context = messageContextInfo(msg);
  const mentions = Array.isArray(context?.mentionedJid) ? context.mentionedJid.filter(Boolean) : [];
  let candidates = [];
  let remainingArgs = [...args];

  if (mentions.length) {
    candidates = mentions;
    let mentionIndex = remainingArgs.findIndex(arg => String(arg).startsWith('@'));
    if (mentionIndex < 0 && remainingArgs.length) mentionIndex = 0;
    if (mentionIndex >= 0) remainingArgs.splice(mentionIndex, 1);
  } else if (context?.stanzaId && context?.participant) {
    // Reply ke pesan pemain juga dapat dipakai sebagai target.
    candidates = [context.participant];
  } else if (remainingArgs[0]) {
    candidates = [String(remainingArgs[0]).replace(/^@/, '')];
    remainingArgs = remainingArgs.slice(1);
  } else {
    return { error: 'Tag pemain dengan @mention atau reply pesan pemain, lalu ulangi command.' };
  }

  const targetLocals = new Set(candidates.map(normalizedLocalId).filter(Boolean));
  const targetDigits = candidates.map(value => String(value).replace(/\D/g, '')).filter(Boolean);
  let meta;
  try {
    meta = await sock.groupMetadata(chat);
  } catch (error) {
    console.error('Gagal membaca anggota grup untuk admin game:', error.message);
    return { error: 'Bot gagal membaca anggota grup. Coba lagi sebentar.' };
  }

  const member = (meta.participants || []).find(participant => {
    const aliases = IDsForParticipant(participant);
    if (aliases.some(alias => targetLocals.has(alias))) return true;
    const phone = String(participant.phoneNumber || '').replace(/\D/g, '');
    return !!phone && targetDigits.includes(phone);
  });

  const playerEntries = Object.entries(luckyverse.data.players);
  if (!member) {
    const existing = playerEntries.find(([key]) => targetLocals.has(normalizedLocalId(key)));
    if (!existing) return { error: 'Pemain tidak ditemukan di grup ini. Pastikan bot bisa melihat anggota grup dan tag pemain yang benar.' };
    return {
      userId: existing[0], displayName: existing[1].name || 'Pemain',
      remainingArgs, playerExists: true
    };
  }

  const aliases = new Set(IDsForParticipant(member));
  const existing = playerEntries.find(([key]) => aliases.has(normalizedLocalId(key)));
  const userId = existing ? existing[0] : ([member.phoneNumber,member.jid,member.id,member.lid,...candidates].map(usablePrivateJid).filter(Boolean).find(x=>!x.endsWith('@lid')) || [member.id,member.lid,...candidates].map(usablePrivateJid).find(Boolean));
  if(!userId)return {error:'Identitas pemain tidak tersedia.'};
  const displayName = String(member.name || member.notify || member.pushName || existing?.[1]?.name || 'Pemain').slice(0, 40);
  return { userId, displayName, remainingArgs, playerExists: !!existing };
}

function parseAdminInteger(raw, label, min = 1, max = 1000000000) {
  const value = String(raw ?? '').trim();
  if (!/^\d+$/.test(value)) return { error: `${label} harus berupa bilangan bulat.` };
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    return { error: `${label} harus antara ${min.toLocaleString('id-ID')} dan ${max.toLocaleString('id-ID')}.` };
  }
  return { value: number };
}

async function handleGameAdminCommand(sock, msg, chat, command, args) {
  if (!(await senderIsGroupAdmin(sock, chat, msg))) {
    return sendText(sock, chat, '⛔ Command ini hanya bisa digunakan admin grup Orivela Luckyverse.', msg);
  }
  const cfg=loadConfig();
  const verifiedPhone=await findBuyerPhone(sock,chat,msg,'');
  if(verifiedPhone.source!=='WhatsApp'||!cfg.ownerPhones?.map(digits).includes(digits(verifiedPhone.phone)))return sendText(sock,chat,'⛔ Admin game ekonomi hanya untuk owner yang terdaftar di config.json.',msg);
  if (command === 'gameadmin') {
    return sendText(sock, chat, [
      '🛡️ *ORIVELA LUCKYVERSE · ADMIN TOOLS*',
      '.addbalance @pemain 1000 - Tambah koin',
      '.removebalance @pemain 500 - Kurangi koin',
      '.setbalance @pemain 2000 - Atur saldo',
      '.addxp @pemain 100 - Tambah XP',
      '.giveitem @pemain diamond 5 - Beri mineral',
      '.adminplayer @pemain - Lihat statistik',
      '.resetplayer @pemain - Minta reset progres',
      '.confirmreset @pemain - Konfirmasi reset dalam 60 detik',
      '',
      'Semua command hanya berlaku di grup game dan harus dijalankan admin grup.'
    ].join('\n'), msg);
  }

  const target = await resolveGameAdminTarget(sock, chat, msg, args);
  if (target.error) return sendText(sock, chat, `⚠️ ${target.error}`, msg);
  const playerId = target.userId;
  const rest = target.remainingArgs;
  const resetKey = `${String(msgSender(msg)).split(':')[0]}|${playerId}`;

  if (command === 'resetplayer') {
    if (!target.playerExists) return sendText(sock, chat, `Pemain ${target.displayName} belum punya progres yang bisa di-reset.`, msg);
    pendingGameResets.set(resetKey, Date.now() + 60000);
    return sendText(sock, chat, `⚠️ *KONFIRMASI RESET PEMAIN*\nTarget: ${target.displayName}\nSemua saldo, XP, item, alat, dan progres akan direset ke awal.\n\nJika yakin, kirim .confirmreset @pemain dalam 60 detik.`, msg);
  }

  if (command === 'confirmreset') {
    const expiresAt = pendingGameResets.get(resetKey);
    if (!expiresAt || Date.now() > expiresAt) {
      pendingGameResets.delete(resetKey);
      return sendText(sock, chat, 'Konfirmasi reset tidak ditemukan atau sudah kedaluwarsa. Jalankan .resetplayer @pemain terlebih dahulu.', msg);
    }
    pendingGameResets.delete(resetKey);
    delete luckyverse.data.players[playerId];
    luckyverse.sessions.delete(playerId);
    luckyverse.save();
    return sendText(sock, chat, `✅ Progres ${target.displayName} berhasil di-reset. Saat bermain lagi, pemain mendapat profil awal.`, msg);
  }

  if (command === 'adminplayer') {
    if (!target.playerExists) return sendText(sock, chat, `Pemain ${target.displayName} belum pernah bermain di Luckyverse.`, msg);
    const player = luckyverse.getPlayer(playerId, target.displayName);
    const lv = levelInfo(player.xp);
    const tool = PICKAXES[player.pickaxe];
    const items = Object.entries(player.items || {}).filter(([, qty]) => Number(qty) > 0)
      .map(([key, qty]) => `${ITEMS[key]?.emoji || '📦'} ${ITEMS[key]?.name || key}: ${qty}`);
    return sendText(sock, chat, [
      '🔎 *ADMIN PLAYER INSPECTOR*',
      `👤 Pemain: ${player.name}`,
      `🪙 Saldo: ${player.balance.toLocaleString('id-ID')}`,
      `⭐ Level: ${lv.level} · XP: ${player.xp.toLocaleString('id-ID')}`,
      `⛏️ Pickaxe: ${tool?.name || player.pickaxe}`,
      `⚡ Energy: ${player.energy}`,
      `🎮 Game dimainkan: ${player.gamesPlayed}`,
      `🏆 Menang: ${player.gamesWon}`,
      `🪨 Total menambang: ${player.totalMined}`,
      `🎒 Item: ${items.join(', ') || 'Belum ada item'}`
    ].join('\n'), msg);
  }

  if (command === 'addbalance' || command === 'removebalance' || command === 'setbalance' || command === 'addxp') {
    const parsed = parseAdminInteger(rest[0], command === 'addxp' ? 'XP' : 'Jumlah', command === 'setbalance' ? 0 : 1,
      command === 'addxp' ? 1000000 : 1000000000);
    if (parsed.error) return sendText(sock, chat, `⚠️ ${parsed.error}\nContoh: .${command} @pemain ${command === 'addxp' ? '100' : '1000'}`, msg);
    const player = luckyverse.getPlayer(playerId, target.displayName);
    const amount = parsed.value;
    if (command === 'addbalance') {
      if (player.balance + amount > 1000000000) return sendText(sock, chat, 'Saldo maksimal adalah 1.000.000.000 koin.', msg);
      player.balance += amount;
    } else if (command === 'removebalance') {
      if (amount > player.balance) return sendText(sock, chat, `Saldo pemain hanya ${player.balance.toLocaleString('id-ID')} koin.`, msg);
      player.balance -= amount;
    } else if (command === 'setbalance') {
      player.balance = amount;
    } else {
      const xpMessage = luckyverse.addXp(player, amount);
      luckyverse.save();
      return sendText(sock, chat, `✅ XP ${player.name} diperbarui: +${amount.toLocaleString('id-ID')} XP.\n${xpMessage}\nSaldo: ${player.balance.toLocaleString('id-ID')} koin.`, msg);
    }
    luckyverse.save();
    return sendText(sock, chat, `✅ *SALDO DIPERBARUI*\nPemain: ${player.name}\nPerubahan: ${command === 'addbalance' ? '+' : command === 'removebalance' ? '-' : '='}${amount.toLocaleString('id-ID')} koin\nSaldo sekarang: *${player.balance.toLocaleString('id-ID')} koin*.`, msg);
  }

  if (command === 'giveitem') {
    if (rest.length < 2) return sendText(sock, chat, 'Contoh: .giveitem @pemain diamond 5', msg);
    const itemKey = String(rest[0]).toLowerCase();
    if (!Object.hasOwn(ITEMS,itemKey)) return sendText(sock, chat, `Item tidak dikenal. Pilihan: ${Object.keys(ITEMS).join(', ')}.`, msg);
    const parsed = parseAdminInteger(rest[1], 'Jumlah item', 1, 100000);
    if (parsed.error) return sendText(sock, chat, `⚠️ ${parsed.error}`, msg);
    const player = luckyverse.getPlayer(playerId, target.displayName);
    player.items[itemKey] = (player.items[itemKey] || 0) + parsed.value;
    luckyverse.save();
    return sendText(sock, chat, `✅ Berhasil memberi ${ITEMS[itemKey].emoji} ${ITEMS[itemKey].name} ×${parsed.value.toLocaleString('id-ID')} kepada ${player.name}. Total sekarang: ${player.items[itemKey]}.`, msg);
  }
  return sendText(sock, chat, 'Command admin tidak dikenal. Ketik .gameadmin untuk melihat panduan.', msg);
}

async function sendText(sock, jid, text, quoted) {
  return sock.sendMessage(jid, { text }, quoted ? { quoted } : {});
}
// ============================================================
// ORIVELA STARFALL | AUTO OPEN-CLOSE (WIB)
// Pengumuman dikirim ke grup pelanggan (config.groupId) dan
// grup admin (config.adminGroupId). Riwayat disimpan di data/.
// ============================================================
const STORE_OPEN_MESSAGE = `☾ ORIVELA Starfall is now OPEN! ♡

Hii, lovelies! We're officially open and ready to serve you again! Welcome back to our little space. Thank you for stopping by! ✧

✦ STORE INFORMATION
🔓 𝐒𝐭𝐚𝐭𝐮𝐬 : OPEN
⏰ 𝐂𝐥𝐨𝐬𝐞 : 00.00 WIB
📩 𝐑𝐞𝐬𝐩𝐨𝐧𝐬𝐞 : Saat jam operasional

✦ GET STARTED
➵ Ketik .menu untuk melihat katalog, pricelist, dan layanan toko.
➵ Ketik .order untuk memulai pemesanan.

✦ TRANSACTION REMINDER
➵ Semua transaksi WAJIB dilakukan di grup ini.
➵ Pengiriman akun dan bukti login dilakukan melalui RC bersama admin.

𖤐 Happy shopping and enjoy your day! ♡

ORIVELA Starfall · your digital space ☾`;

const STORE_CLOSED_MESSAGE = `☾ ORIVELA Starfall is now CLOSED! ♡

Hii, lovelies! Our store has officially closed for today. Thank you for spending your time with us and being part of our little space! ✧

✦ STORE INFORMATION
🔒 𝐒𝐭𝐚𝐭𝐮𝐬 : CLOSED
⏰ 𝐎𝐩𝐞𝐧 𝐀𝐠𝐚𝐢𝐧 : 10.00 WIB
📩 𝐑𝐞𝐬𝐩𝐨𝐧𝐬𝐞 : Saat jam operasional

✦ CUSTOMER NOTICE
➵ Pesan yang masuk di luar jam operasional akan kami respons ketika toko kembali buka.
➵ All orders will be processed during our operational hours.

𖤐 Have a lovely night and get some good rest! ♡

See you tomorrow, lovelies! ✧

ORIVELA Starfall · your digital space ☾`;

const STORE_CLOSED_REMINDER = `☾ Sorry, lovelies! Our store is CLOSED. We'll be back tomorrow at 10.00 WIB. See you! ♡ ✧`;
const STORE_CLOSED_REPLY_COOLDOWN_MS = 30 * 60 * 1000;

function jakartaClock() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());

  const value = {};
  for (const part of parts) {
    if (part.type !== 'literal') value[part.type] = part.value;
  }

  return {
    dateKey: `${value.year}-${value.month}-${value.day}`,
    minuteOfDay: Number(value.hour) * 60 + Number(value.minute)
  };
}

function storeIsOpen() {
  return B.isOpen();
}

function loadStoreScheduleState() {
  try {
    if (!fs.existsSync(STORE_SCHEDULE_STATE)) {
      return { version: 1, sent: {} };
    }

    const saved = JSON.parse(fs.readFileSync(STORE_SCHEDULE_STATE, 'utf8'));
    if (saved?.version !== 1 || !saved.sent || typeof saved.sent !== 'object' ||
        Array.isArray(saved.sent)) {
      throw new Error('Format state jadwal tidak valid.');
    }
    return saved;
  } catch (error) {
    console.error('[STORE SCHEDULE] State tidak dapat dibaca; memakai state baru:', error.message);
    return { version: 1, sent: {} };
  }
}

function saveStoreScheduleState() {
  fs.mkdirSync(path.dirname(STORE_SCHEDULE_STATE), { recursive: true });
  const temp = STORE_SCHEDULE_STATE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(storeScheduleState, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, STORE_SCHEDULE_STATE);
}

async function checkStoreSchedule(sock) {
  if (activeSocket !== sock || storeScheduleChecking) return;
  storeScheduleChecking = true;

  try {
    if (!storeScheduleState) storeScheduleState = loadStoreScheduleState();

    const config = loadConfig();
    const { dateKey, minuteOfDay } = jakartaClock();
    const event = B.isOpen() ? 'open' : 'closed';
    const message = (event === 'open' ? STORE_OPEN_MESSAGE : STORE_CLOSED_MESSAGE).replace('00.00 WIB',B.schedule().close.replace(':','.')+' WIB').replace('10.00 WIB',B.schedule().open.replace(':','.')+' WIB');

    const targets = [
      { name: 'grup pelanggan', jid: config.groupId },
      { name: 'grup admin', jid: config.adminGroupId }
    ].filter(target => isGroupJid(target.jid));

    if (!targets.length) {
      console.warn('[STORE SCHEDULE] Grup belum diatur. Gunakan .aktifkan di grup pelanggan dan .setnotif di grup admin.');
      return;
    }

    if (!storeScheduleState.sent[dateKey]) {
      storeScheduleState.sent[dateKey] = { open: {}, closed: {} };
    }
    if (!storeScheduleState.sent[dateKey][event]) {
      storeScheduleState.sent[dateKey][event] = {};
    }

    // Batasi ukuran file riwayat, simpan 45 hari terakhir.
    const dates = Object.keys(storeScheduleState.sent).sort();
    while (dates.length > 45) {
      delete storeScheduleState.sent[dates.shift()];
    }

    const alreadyHandled = new Set();
    for (const target of targets) {
      if (alreadyHandled.has(target.jid)) continue;
      alreadyHandled.add(target.jid);

      if (storeScheduleState.sent[dateKey][event][target.jid]) continue;

      try {
        await sendText(sock, target.jid, message);
        storeScheduleState.sent[dateKey][event][target.jid] = true;
        saveStoreScheduleState();
        console.log(`[STORE SCHEDULE] ${event.toUpperCase()} terkirim ke ${target.name}.`);
      } catch (error) {
        console.error(`[STORE SCHEDULE] Gagal mengirim ${event.toUpperCase()} ke ${target.name}:`, error.message);
      }
    }
  } catch (error) {
    console.error('[STORE SCHEDULE] Pemeriksaan jadwal gagal:', error.stack || error);
  } finally {
    storeScheduleChecking = false;
  }
}

function startStoreSchedule(sock) {
  if (storeScheduleInterval) clearInterval(storeScheduleInterval);

  if (!storeScheduleState) {
    const stateFileAlreadyExists = fs.existsSync(STORE_SCHEDULE_STATE);
    storeScheduleState = loadStoreScheduleState();

    // Saat instalasi pertama sebelum pukul 10.00, jangan kirim CLOSED susulan
    // karena jadwal 00.00 hari ini sudah lewat. Pengumuman berikutnya tetap OPEN 10.00.
    if (!stateFileAlreadyExists) {
      const clock = jakartaClock();
      if (clock.minuteOfDay < 600) {
        const config = loadConfig();
        const initialTargets = [config.groupId, config.adminGroupId].filter(isGroupJid);
        if (initialTargets.length) {
          if (!storeScheduleState.sent[clock.dateKey]) {
            storeScheduleState.sent[clock.dateKey] = { open: {}, closed: {} };
          }
          for (const jid of initialTargets) {
            storeScheduleState.sent[clock.dateKey].closed[jid] = true;
          }
          saveStoreScheduleState();
          console.log('[STORE SCHEDULE] Instalasi pertama sebelum 10.00 WIB; CLOSED hari ini dilewati. Pengumuman berikutnya OPEN pukul 10.00 WIB.');
        }
      }
    }
  }

  // Pemeriksaan langsung saat WhatsApp tersambung, lalu setiap 15 detik.
  // Jika bot reconnect setelah jadwal terlewat, status saat ini dikirim satu kali.
  checkStoreSchedule(sock).catch(error =>
    console.error('[STORE SCHEDULE] Pemeriksaan awal gagal:', error.message)
  );

  storeScheduleInterval = setInterval(() => {
    checkStoreSchedule(sock).catch(error =>
      console.error('[STORE SCHEDULE] Pemeriksaan berkala gagal:', error.message)
    );
  }, 15000);

  if (typeof storeScheduleInterval.unref === 'function') {
    storeScheduleInterval.unref();
  }
  console.log('[STORE SCHEDULE] Auto OPEN-CLOSED aktif (Asia/Jakarta).');
}

function stopStoreSchedule() {
  if (storeScheduleInterval) {
    clearInterval(storeScheduleInterval);
    storeScheduleInterval = null;
  }
}

async function sendStoreClosedReminder(sock, chat, msg) {
  const sender = msgSender(msg);
  const cooldownKey = `${chat}|${localId(sender) || 'unknown'}`;
  const now = Date.now();
  const lastReply = closedReminderCooldown.get(cooldownKey) || 0;

  // Satu pengingat per pengirim setiap 30 menit agar grup tidak spam.
  if (now - lastReply < STORE_CLOSED_REPLY_COOLDOWN_MS) return false;

  closedReminderCooldown.set(cooldownKey, now);
  if (closedReminderCooldown.size > 5000) {
    for (const [key, at] of closedReminderCooldown) {
      if (now - at >= STORE_CLOSED_REPLY_COOLDOWN_MS) closedReminderCooldown.delete(key);
    }
    while (closedReminderCooldown.size > 5000) closedReminderCooldown.delete(closedReminderCooldown.keys().next().value);
  }
  try {
    await sendText(sock, chat, `☾ Sorry, lovelies! Store CLOSED. Jam toko ${B.schedule().open}–${B.schedule().close} WIB. ♡`, msg);
    return true;
  } catch (error) {
    closedReminderCooldown.delete(cooldownKey);
    throw error;
  }
}

async function handleStoreClosedReminder(sock, msg) {
  if (!msg?.key || !msg.message || msg.key.fromMe) return;

  const chat = msg.key.remoteJid || '';
  const config = loadConfig();

  // Reminder hanya untuk grup pelanggan utama, bukan grup admin/Luckyverse.
  if (!config.groupId || chat !== config.groupId || storeIsOpen()) return;

  const raw = getText(msg.message).trim();

  // Semua command publik (mis. .menu, .katalog, .catalog, cek harga)
  // tetap berjalan tanpa menerima reminder CLOSED tambahan.
  // Command .order ditolak khusus di handleCommand, sedangkan formulir order
  // ditolak khusus di handleOrderForm.
  if (raw.startsWith('.')) return;
  if (parseOrderForm(raw)) return;

  return sendStoreClosedReminder(sock, chat, msg);
}

function phoneFromJid(jid) {
  const match = String(jid || '').match(/^(\d{9,15})(?::\d+)?@(?:s\.whatsapp\.net|c\.us)$/);
  return match ? match[1] : null;
}
async function findBuyerPhone(sock, groupId, msg, fromForm) {
  for (const jid of [msg.key.participantPhone, msg.key.participantAlt, msg.key.participant]) {
    const phone = phoneFromJid(jid);
    if (phone) return { phone: `+${phone}`, source: 'WhatsApp' };
  }
  try {
    const meta = await sock.groupMetadata(groupId);
    const senderIds = new Set([
      localId(msgSender(msg)), localId(msg.key.participantAlt), localId(msg.key.participantPhone)
    ].filter(Boolean));
    const member = meta.participants.find(p => IDsForParticipant(p).some(id => senderIds.has(id)));
    if (member) {
      for (const jid of [member.phoneNumber, member.jid, member.id]) {
        const phone = phoneFromJid(jid) || (jid === member.phoneNumber && /^\d{9,15}$/.test(String(jid)) ? String(jid) : null);
        if (phone) return { phone: `+${phone}`, source: 'WhatsApp' };
      }
    }
  } catch (error) {
    console.warn('Nomor buyer tidak tersedia lewat metadata grup:', error.message);
  }
  const typed = digits(fromForm || '');
  if (/^\d{9,15}$/.test(typed)) {
    return { phone: typed.startsWith('0') ? typed : `+${typed}`, source: 'diisi buyer, belum diverifikasi' };
  }
  return { phone: null, source: null };
}


function formatVoucherExpiry(value) {
  return `${new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Jakarta'
  }).format(new Date(value))} WIB`;
}
function formatDiscount(value) {
  return `Rp${Number(value || 0).toLocaleString('id-ID')}`;
}
function voucherPrivateMessage(voucher) {
  return [
    '✨ ORIVELA STARFALL ✨',
    `VOUCHER POTONGAN ${formatDiscount(voucher.discount)}`,
    `🎟️ Kode: ${voucher.serial}`,
    '',
    'Syarat & Ketentuan:',
    '• 1 voucher hanya berlaku untuk 1 item pembelian.',
    '• Voucher hanya dapat digunakan satu kali.',
    '• Voucher tidak dapat diuangkan.',
    '• Tidak dapat digabungkan dengan voucher lainnya.',
    '',
    `Expired: ${formatVoucherExpiry(voucher.expiresAt)} (berlaku 5 hari setelah penukaran)`
  ].join('\n');
}
function voucherAdminMessage(voucher) {
  return [
    `🎟️ *Voucher Potongan ${formatDiscount(voucher.discount)}*`,
    `• Kode: ${voucher.serial}`,
    `• Expired: ${formatVoucherExpiry(voucher.expiresAt)}`,
    `• Call Number: ${voucher.callNumber || 'Tidak tersedia'}`,
    `• Pemilik: ${voucher.ownerName || 'Pemain Luckyverse'}`
  ].join('\n');
}
function voucherAdminGroup(config) {
  return config.adminGroupId || '';
}
function usablePrivateJid(value) {
  const raw = String(value || '').trim();
  if (/^\d{9,15}(?::\d+)?@(?:s\.whatsapp\.net|c\.us)$/i.test(raw)) return raw.replace(/:\d+@/, '@');
  if (/^[^@]+@lid$/i.test(raw)) return raw;
  if (!raw.includes('@')) {
    const numeric = digits(raw);
    if (/^\d{9,15}$/.test(numeric)) return `${numeric}@s.whatsapp.net`;
  }
  return null;
}
function privateJidFromPhone(value) {
  const number = digits(value || '');
  return /^\d{9,15}$/.test(number) ? `${number}@s.whatsapp.net` : null;
}
function maskPrivateJid(value) {
  const raw = String(value || '');
  const [local = '', server = 'unknown'] = raw.split('@');
  const id = local.split(':')[0];
  const masked = id.length > 4 ? `${'*'.repeat(id.length - 4)}${id.slice(-4)}` : '****';
  return `${masked}@${server}`;
}
function markGameMessageOnce(chat, msg) {
  const id = msg?.key?.id;
  if (!id) return true;
  const key = `${chat}|${id}`;
  if (gameHandledMessages.has(key)) return false;
  gameHandledMessages.add(key);
  if (gameHandledMessages.size > 5000) {
    const oldest = gameHandledMessages.values().next().value;
    gameHandledMessages.delete(oldest);
  }
  return true;
}
async function resolvePrivateJid(sock, groupId, msg) {
  const candidates = [msg.key.participantAlt, msg.key.participantPhone, msg.key.participant];
  for (const candidate of candidates) {
    const jid = usablePrivateJid(candidate);
    if (jid && !jid.endsWith('@lid')) return jid;
  }
  let lidFallback = candidates.map(usablePrivateJid).find(jid => jid && jid.endsWith('@lid')) || null;
  try {
    const meta = await sock.groupMetadata(groupId);
    const senderIds = new Set([
      localId(msgSender(msg)), localId(msg.key.participantAlt), localId(msg.key.participantPhone)
    ].filter(Boolean));
    const member = meta.participants.find(p => IDsForParticipant(p).some(id => senderIds.has(id)));
    if (member) {
      for (const candidate of [member.phoneNumber, member.jid, member.id, member.lid]) {
        const jid = usablePrivateJid(candidate);
        if (jid && !jid.endsWith('@lid')) return jid;
        if (jid && jid.endsWith('@lid')) lidFallback = jid;
      }
    }
  } catch (error) {
    console.warn('Gagal mencari private JID untuk voucher:', error.message);
  }
  return lidFallback;
}
function getMentionedJids(msg) {
  const message = msg?.message?.ephemeralMessage?.message || msg?.message?.viewOnceMessage?.message || msg?.message || {};
  const context = message.extendedTextMessage?.contextInfo || message.imageMessage?.contextInfo || {};
  return Array.isArray(context.mentionedJid) ? context.mentionedJid : [];
}
async function notifyVoucherAdmin(sock, config, voucher) {
  const target = voucherAdminGroup(config);
  if (!isGroupJid(target) || target === config.luckyverseGroupId || target === config.groupId) return false;
  await sendText(sock, target, voucherAdminMessage(voucher));
  luckyverse.markVoucherAdminNotified(voucher.serial);
  return true;
}
async function flushPendingVoucherNotifications(sock) {
  const config = loadConfig();
  const target = voucherAdminGroup(config);
  if (!isGroupJid(target) || target === config.luckyverseGroupId || target === config.groupId) return;
  for (const voucher of luckyverse.pendingVoucherNotifications()) {
    if (activeSocket !== sock) break;
    try {
      await notifyVoucherAdmin(sock, config, voucher);
    } catch (error) {
      console.error(`Notifikasi voucher ${voucher.serial} gagal, akan dicoba lagi:`, error.message);
      break;
    }
  }
}
async function handleVoucherAdminCommand(sock, msg, chat, parts, command) {
  if (!(await senderIsGroupAdmin(sock, chat, msg))) {
    return sendText(sock, chat, 'Perintah voucher hanya dapat digunakan admin grup.', msg);
  }
  const serial = String(parts[1] || '').trim().toUpperCase();
  if (!serial) {
    return sendText(sock, chat, `Cara pakai: .${command} ORV-KODEVOUCHER\nContoh: .${command} ORV-AB12CD34EF56GH78`, msg);
  }
  if (command === 'cekvoucher') {
    const result = luckyverse.getVoucher(serial);
    if (result.error) return sendText(sock, chat, `🎟️ ${result.error}`, msg);
    const voucher = result.voucher;
    return sendText(sock, chat, [
      `🎟️ VOUCHER ${formatDiscount(voucher.discount)}`,
      `Kode: ${voucher.serial}`,
      `Pemilik: ${voucher.ownerName}`,
      `Call Number: ${voucher.callNumber}`,
      `Expired: ${formatVoucherExpiry(voucher.expiresAt)}`,
      `Status: ${String(voucher.status).toUpperCase()}`
    ].join('\n'), msg);
  }
  if (command === 'kirimulang') {
    const result = luckyverse.getVoucher(serial);
    if (result.error) return sendText(sock, chat, `🎟️ ${result.error}`, msg);
    const voucher = result.voucher;
    if (voucher.status !== 'active') {
      return sendText(sock, chat, `Voucher ${serial} tidak dapat dikirim ulang. Status: ${String(voucher.status).toUpperCase()}.`, msg);
    }
    const target = privateJidFromPhone(voucher.callNumber) || usablePrivateJid(voucher.ownerId);
    if (!target) {
      return sendText(sock, chat, 'Nomor/JID pemilik tidak tersedia. Jangan membuat voucher baru atau memotong koin lagi. Periksa data voucher di data/luckyverse.json.', msg);
    }
    try {
      const sent = await sock.sendMessage(target, { text: voucherPrivateMessage(voucher) });
      const acceptedJid = sent?.key?.remoteJid;
      if (!acceptedJid || isGroupJid(acceptedJid)) {
        throw new Error('Baileys tidak mengembalikan tujuan chat pribadi yang valid.');
      }
      luckyverse.markVoucherDmSent(voucher.serial);
      console.info(`[VOUCHER DM RESEND] ${voucher.serial} target=${maskPrivateJid(target)} accepted=${maskPrivateJid(acceptedJid)}`);
      return sendText(sock, chat, `✅ Voucher ${voucher.serial} dikirim ulang ke ${maskPrivateJid(acceptedJid)}. Tidak ada koin yang dipotong. Minta pemilik memeriksa chat pribadi bot.`, msg);
    } catch (error) {
      console.error(`Pengiriman ulang voucher ${voucher.serial} gagal ke ${maskPrivateJid(target)}:`, error.message);
      return sendText(sock, chat, `❌ Pengiriman ulang voucher gagal. Voucher tetap aktif dan saldo tidak berubah. Detail: ${error.message}`, msg);
    }
  }
  const result = luckyverse.markVoucherRedeemed(serial, msg.pushName || msgSender(msg));
  if (result.error) return sendText(sock, chat, `🎟️ ${result.error}`, msg);
  return sendText(sock, chat, [
    '✅ VOUCHER BERHASIL DITANDAI DIGUNAKAN',
    `Kode: ${result.voucher.serial}`,
    `Pemilik: ${result.voucher.ownerName}`,
    `Call Number: ${result.voucher.callNumber}`,
    `Status: USED`,
    'Kode ini tidak dapat digunakan kembali.'
  ].join('\n'), msg);
}
async function handleLuckyverseCommand(sock, msg, chat, parts, command, config) {
  const userId = (await resolvePrivateJid(sock, chat, msg)) || msgSender(msg);
  const displayName = msg.pushName || 'Pemain';
  const args = parts.slice(1);
  const voucherCommands = ['voucher', 'tukervoucher', 'redeemvoucher'];

  if (voucherCommands.includes(command)) {
    if (!args[0]) {
      return sendText(sock, chat, luckyverse.handleCommand(userId, displayName, command, []), msg);
    }
    const discount = Number(String(args[0]).replace(/[^0-9]/g, ''));
    if (![5000, 10000, 15000].includes(discount)) {
      return sendText(sock, chat, 'Pilihan voucher: .voucher 5000, .voucher 10000, atau .voucher 15000.', msg);
    }
    const adminTarget = voucherAdminGroup(config);
    if (!isGroupJid(adminTarget) || adminTarget === chat || adminTarget === config.groupId) {
      return sendText(sock, chat, 'Sistem voucher belum terhubung ke grup admin. Admin Store perlu mengatur .setnotif ID_GRUP. Koin belum dipotong.', msg);
    }
    try {
      await sock.groupMetadata(adminTarget);
    } catch (error) {
      return sendText(sock, chat, 'Bot belum dapat mengakses grup admin voucher. Pastikan bot sudah menjadi anggota grup admin. Koin belum dipotong.', msg);
    }
    const phone = await findBuyerPhone(sock, chat, msg, '');
    const phoneJid = phone.source === 'WhatsApp' ? privateJidFromPhone(phone.phone) : null;
    const privateJid = phoneJid || await resolvePrivateJid(sock, chat, msg);
    if (!privateJid) {
      return sendText(sock, chat, 'Bot tidak dapat menemukan chat pribadi akunmu. Koin belum dipotong. Coba lagi atau hubungi admin.', msg);
    }
    const rawPhone = digits(msg.key.participantPhone || '');
    const callNumber = phone.phone || (phoneFromJid(msg.key.participantAlt) ? `+${phoneFromJid(msg.key.participantAlt)}` : (/^\d{9,15}$/.test(rawPhone) ? `+${rawPhone}` : 'Tidak tersedia (WhatsApp tidak menampilkan nomor)'));
    const requestId = msg.key.id ? `${chat}|${msg.key.id}|${userId}` : '';
    const result = luckyverse.redeemVoucher(userId, displayName, discount, requestId, callNumber);
    if (result.error) return sendText(sock, chat, `🎟️ ${result.error}`, msg);
    if (result.duplicate) {
      return sendText(sock, chat, 'Permintaan voucher ini sudah diproses sebelumnya. Cek chat pribadi untuk kode voucher yang sudah dikirim.', msg);
    }

    try {
      const sent = await sock.sendMessage(privateJid, { text: voucherPrivateMessage(result.voucher) });
      const acceptedJid = sent?.key?.remoteJid;
      if (!acceptedJid || isGroupJid(acceptedJid)) {
        throw new Error('Baileys tidak mengembalikan tujuan chat pribadi yang valid.');
      }
      console.info(`[VOUCHER DM] ${result.voucher.serial} target=${maskPrivateJid(privateJid)} accepted=${maskPrivateJid(acceptedJid)}`);
    } catch (error) {
      console.error(`Gagal mengirim voucher ${result.voucher.serial} ke chat pribadi:`, error.message);
      try { luckyverse.cancelVoucherAndRefund(result.voucher.serial); } catch (refundError) {
        console.error('Refund voucher gagal:', refundError.message);
      }
      return sendText(sock, chat, 'Pengiriman voucher ke chat pribadi gagal. Voucher dibatalkan dan koin dikembalikan jika transaksi refund berhasil. Pastikan chat bot dapat menerima pesan.', msg);
    }

    try {
      luckyverse.markVoucherDmSent(result.voucher.serial);
    } catch (error) {
      console.error('Gagal menyimpan status DM voucher:', error.message);
    }
    try {
      await notifyVoucherAdmin(sock, config, result.voucher);
    } catch (error) {
      console.error(`Notifikasi admin voucher ${result.voucher.serial} tertunda:`, error.message);
    }
    return sendText(sock, chat, [
      '✨ *PENUKARAN VOUCHER BERHASIL*',
      `Voucher ${formatDiscount(result.voucher.discount)} sudah dikirim ke chat pribadi kamu.`,
      `Koin digunakan: ${Number(result.voucher.cost).toLocaleString('id-ID')}`,
      `Saldo tersisa: ${Number(result.balance).toLocaleString('id-ID')} koin`,
      'Cek chat bot untuk melihat kode rahasia. Voucher berlaku 5 hari dan hanya dapat digunakan satu kali.'
    ].join('\n'), msg);
  }

  let commandArgs = args;
  if (command === 'give') {
    const mentions = getMentionedJids(msg);
    if (mentions.length && commandArgs.length >= 2) commandArgs = [mentions[0], ...commandArgs.slice(1)];
  }
  const response = luckyverse.handleCommand(userId, displayName, command, commandArgs, {
    chatId: chat,
    mentionJid: msg.key.participantAlt || msg.key.participantPhone || msg.key.participant
  });
  if (response) return sendText(sock, chat, response, msg);
}
function startMiningWatcher(sock) {
  if (miningInterval) clearInterval(miningInterval);
  miningInterval = setInterval(async () => {
    if (activeSocket !== sock) return;
    const ids = Object.keys(luckyverse.data.players || {});
    for (const userId of ids) {
      try {
        const player = luckyverse.data.players[userId];
        if (!player || !player.miningJob) continue;
        if (player.miningJob.status === 'pending' && Date.now() >= Number(player.miningJob.finishAt)) {
          luckyverse.completeMining(userId);
        }
        const job = luckyverse.data.players[userId]?.miningJob;
        if (!job || job.status !== 'ready' || miningNotifying.has(userId)) continue;
        const target = job.chatId || loadConfig().luckyverseGroupId;
        if (!isGroupJid(target) || target !== loadConfig().luckyverseGroupId) continue;
        miningNotifying.add(userId);
        try {
          const prefix = job.mentionJid ? `@${localId(job.mentionJid)}\n` : '';
          const mentions = job.mentionJid ? [job.mentionJid] : [];
          await sock.sendMessage(target, { text: `${prefix}${job.resultText}`, mentions });
          luckyverse.markMiningNotified(userId);
        } finally {
          miningNotifying.delete(userId);
        }
      } catch (error) {
        console.error(`Pemrosesan mining pemain ${userId} gagal:`, error.message);
        miningNotifying.delete(userId);
      }
    }
    sweepPayments(sock).catch(error=>console.error('Payment watcher:',error.message));
    promos.tick(sock,loadConfig()).catch(error=>console.error('Promo watcher:',error.message));
    if (Date.now() - lastVoucherFlushAt > 30000) {
      lastVoucherFlushAt = Date.now();
      flushPendingVoucherNotifications(sock).catch(error => console.error('Retry notifikasi voucher gagal:', error.message));
      flushPendingNotifications(sock).catch(error => console.error('Retry notifikasi order gagal:', error.message));
      flushProcessingNotifications(sock).catch(error => console.error('Retry notifikasi proses gagal:', error.message));
    }
  }, 1000);
  if (typeof miningInterval.unref === 'function') miningInterval.unref();
}

function catalogRows() { return JSON.parse(fs.readFileSync(QRIS_PRICES, 'utf8')); }
function selectPackage(input) {
  const value = String(input || '').trim().replace(/^"(.*)"$/, '$1').trim();
  const rows = catalogRows();
  const exact = rows.filter(r => String(r.sku).toUpperCase() === value.toUpperCase());
  if (exact.length === 1) return exact[0];
  const fields = value.split('|').map(x=>x.trim());
  if (fields.length !== 3 || fields.some(x=>!x)) return null;
  return qrisInvoice.lookupCatalog(QRIS_PRICES, {product:fields[0],variant:fields[1],duration:fields[2]});
}
function catalogMessage(query) {
  const rows=catalogRows();
  query=String(query||'').toLowerCase().trim();
  if(!query) return '✦ Produk: '+[...new Set(rows.map(r=>r.product))].join(', ')+'\nContoh .harga Netflix atau .harga P008';
  const matches=rows.filter(r=>r.product.toLowerCase().includes(query)||r.sku.toLowerCase()===query);
  if(!matches.length) return 'Produk tidak ditemukan. Ketik .harga.';
  return '✦ DAFTAR PAKET ✦\n'+matches.map(r=>`${r.sku} | ${r.product} | ${r.variant} | ${r.duration} | ${r.amount===null?'Harga belum aktif':rupiah(r.amount)}${r.note&&r.amount!==null?' · '+r.note:''}`).join('\n')+'\nAdmin: reply NEW ORDER dengan .ambil KODE. Pastikan paket sesuai permintaan buyer.';
}
// Admin-only list. Read live catalog so codes and prices never drift from .ambil.
function catalogCodePages(query) {
  const rows=catalogRows();
  const q=String(query||'').trim().toLowerCase();
  const matches=rows.filter(r=>!q||r.product.toLowerCase().includes(q)||String(r.sku).toLowerCase()===q);
  if(!matches.length)return ['Kode/produk tidak ditemukan. Ketik .listkode untuk semua paket.'];
  const groups=new Map();
  for(const r of matches){
    if(!groups.has(r.product))groups.set(r.product,[]);
    groups.get(r.product).push(`${r.sku} | ${r.variant} | ${r.duration} | ${r.amount===null?'Harga belum aktif':rupiah(r.amount)}`);
  }
  const pages=[];let page='';
  for(const [product,items] of groups){
    for(const line of [`\n✦ ${product.toUpperCase()}`, ...items]){
      if(page && page.length+line.length+1>3000){pages.push(page.trim());page=`✦ ${product.toUpperCase()} (lanjutan)\n`;}
      page+=line+'\n';
    }
  }
  if(page.trim())pages.push(page.trim());
  return pages.map((body,i)=>`✦ ORIVELA — LIST KODE ADMIN ✦\n${matches.length} paket · ${i+1}/${pages.length}\n\n${body}\n\nReply NEW ORDER: .ambil KODE (contoh .ambil P008). Cek varian dan durasi buyer dahulu.`);
}
function adminOrderMessage(order) {
  const invoice = invoiceStore.get(order.id);
  const request = order.requestedPackage || order;
  const suggested = qrisInvoice.lookupCatalog(QRIS_PRICES, request);
  return [
    '✦ NEW ORDER | ORIVELA STARFALL ✦',
    `ID: #${order.id}`,
    `Nama / Username: ${order.name}`,
    `Nomor WA buyer: ${order.buyerPhone || 'Tidak tersedia'}`,
    `Produk (isian buyer): ${request.product}`,
    `Varian / Tipe: ${request.variant}`,
    `Durasi: ${request.duration}`,
    `Device/Lokasi: ${order.device}`,
    `Voucher: ${order.voucher || '-'}`,
    `Diskon voucher: ${rupiah(order.discount || 0)}`,
    ...(invoice ? [`Paket terkunci: ${order.sku || '-'} | ${order.product} | ${order.variant} | ${order.duration}`, `Total tagihan: ${rupiah(invoice.amount)}`, `Kirim ulang: .qris #${order.id}`, `Verifikasi setelah dana masuk: .paid #${order.id} ${invoice.amount}`] : [
      'Status: Waiting for admin — QRIS belum dibuat.',
      ...(suggested ? [`Saran katalog (cek ulang): ${suggested.sku} | ${suggested.product} | ${suggested.variant} | ${suggested.duration} | ${rupiah(suggested.amount)}`] : []),
      'Cek kode dengan .listkode atau .listkode NamaProduk.',
      'Reply pesan ini: .ambil KODE (contoh .ambil P008).',
      'Atau .ambil Produk | Varian | Durasi. Pastikan sesuai buyer.' ]),
    `Setelah pesanan selesai: .d #${order.id}`
  ].join('\n');
}
const invoiceInFlight = new Set();
async function deliverOrderInvoice(sock,order,invoice,cfg) {
  if(invoiceInFlight.has(order.id)) throw Error('QRIS sedang dikirim. Tunggu hasilnya.');
  invoiceInFlight.add(order.id);
  try {
    if (!order.paymentExpiresAt) {
      order.paymentExpiresAt = new Date((Date.parse(order.invoiceSentAt || invoice.createdAt) || Date.now()) + PAYMENT_TTL).toISOString();
      orders.save();
    }
    if (paymentDue(order)) throw Error('Tagihan sudah kedaluwarsa.');
    const sent=await sendInvoice(sock,order,invoice,cfg,order.quote);
    if(sent?.key?.id){order.waReplyIds=[...new Set([...(order.waReplyIds||[]),sent.key.id])].slice(-30);orders.save();}
    order.invoiceSentAt ||= new Date().toISOString(); orders.save();
  } finally {invoiceInFlight.delete(order.id);}
}
// Deadline disimpan di orders.json, tidak direset oleh kirim ulang QRIS.
function buyerMention(order) {
  const jid = String(order.buyerJid || order.quote?.key?.participant || '');
  return /^\d+(?::\d+)?@(?:s\.whatsapp\.net|lid|c\.us)$/.test(jid)
    ? {text:'@'+localId(jid),jids:[jid]} : {text:order.name || 'buyer',jids:[]};
}
function paymentDue(order, now=Date.now()) {
  if(order.paidAt || order.doneAt || order.cancelledAt) return false;
  // Untuk tagihan versi lama, gunakan waktu QRIS pertama yang tercatat.
  const deadline=order.paymentExpiresAt ? Date.parse(order.paymentExpiresAt) : (order.invoiceSentAt ? Date.parse(order.invoiceSentAt)+PAYMENT_TTL : NaN);
  return Number.isFinite(deadline)&&now>=deadline;
}
function cancelPayment(order,reason) {
  if(order.paidAt||order.doneAt||order.cancelledAt||invoiceInFlight.has(order.id)) return false;
  order.cancelReason=reason;
  order.cancelNoticeRequestedAt=new Date().toISOString();
  const result=orders.cancel(order.id);
  if(result.error)return false;
  promos.refresh(); // remaining() menghitung order non-cancelled; tidak ada increment ganda
  return true;
}
const cancellationInFlight = new Set();
async function notifyCancellation(sock,order,cfg) {
  if(!order.cancelNoticeRequestedAt||!order.cancelledAt||cancellationInFlight.has(order.id))return;
  cancellationInFlight.add(order.id);
  try {
    if(!order.cancelStoreNotifiedAt&&order.groupId===cfg.groupId){
      const mention=buyerMention(order);
      await sock.sendMessage(order.groupId,{text:texts.paymentExpired.replaceAll('{buyer}',mention.text).replaceAll('{order_id}','#'+order.id),mentions:mention.jids},order.quote?{quoted:order.quote}:{});
      order.cancelStoreNotifiedAt=new Date().toISOString();orders.save();
    }
    if(!order.cancelAdminNotifiedAt&&isGroupJid(cfg.adminGroupId)){
      const sent=await sendText(sock,cfg.adminGroupId,`✦ PAYMENT EXPIRED / CANCELLED ✦\nID: #${order.id}\nAlasan: ${order.cancelReason}\nOrder dibatalkan; slot promo kembali jika masih berlaku. Cek GoPay Merchant jika buyer sudah membayar; jangan verifikasi order lain dengan transaksi yang sama.`);
      adminLocks.rememberNotification(cfg.adminGroupId,sent?.key?.id,order.id);
      order.cancelAdminNotifiedAt=new Date().toISOString();orders.save();
    }
  } finally {cancellationInFlight.delete(order.id);}
}
async function sweepPayments(sock,cfg=loadConfig(),now=Date.now()) {
  for(const order of orders.data.orders){if(order.groupId!==cfg.groupId)continue;if(paymentDue(order,now))cancelPayment(order,'Waktu pembayaran 30 menit habis');}
  for(const order of orders.data.orders){if(order.groupId!==cfg.groupId||!order.cancelNoticeRequestedAt||(order.cancelStoreNotifiedAt&&order.cancelAdminNotifiedAt))continue;try{await notifyCancellation(sock,order,cfg);}catch(e){console.error('Notif pembatalan tertunda:',e.message);}}
}
const orderNotificationsInFlight = new Map();
async function notifyAdmin(sock, adminGroupId, order) {
  if (orderNotificationsInFlight.has(order.id)) return orderNotificationsInFlight.get(order.id);
  const delivery = (async () => {
    if (!orders.pendingNotifications().some(pending => pending.id === order.id)) return;
    const sent = await sendText(sock, adminGroupId, adminOrderMessage(order));
    adminLocks.rememberNotification(adminGroupId, sent?.key?.id, order.id);
    orders.setAdminNotified(order.id);
  })();
  orderNotificationsInFlight.set(order.id, delivery);
  try { await delivery; } finally { orderNotificationsInFlight.delete(order.id); }
}
async function flushPendingNotifications(sock) {
  const cfg = loadConfig();
  if (!isGroupJid(cfg.adminGroupId) || cfg.adminGroupId === cfg.groupId) return;
  for (const order of orders.pendingNotifications()) {
    if (activeSocket !== sock) break;
    try {
      await notifyAdmin(sock, cfg.adminGroupId, order);
    } catch (err) {
      console.error(`Notif order #${order.id} gagal, akan dicoba lagi:`, err.message);
      break;
    }
  }
}

// Kirim status PROCESSING ke Store, hanya setelah PAID tersimpan.
const processingInFlight = new Map();
async function notifyProcessing(sock, order) {
  if (processingInFlight.has(order.id)) return processingInFlight.get(order.id);
  if (!order.paidAt || !order.processingRequestedAt || order.doneAt || order.cancelledAt || order.processingNotifiedAt) return;
  const cfg = loadConfig();
  if (!isGroupJid(order.groupId) || order.groupId !== cfg.groupId) throw new Error('Store asal tidak cocok dengan config.');
  const delivery = (async () => {
    await sendText(sock, order.groupId, texts.proses.replaceAll('{id}', order.id), order.quote);
    order.processingNotifiedAt = new Date().toISOString();
    orders.save();
  })();
  processingInFlight.set(order.id, delivery);
  try { await delivery; } finally { processingInFlight.delete(order.id); }
}
async function flushProcessingNotifications(sock) {
  for (const order of orders.data.orders) {
    if (activeSocket !== sock) break;
    if (!order.processingRequestedAt || !order.paidAt || order.processingNotifiedAt || order.doneAt || order.cancelledAt) continue;
    try { await notifyProcessing(sock, order); }
    catch (error) { console.error(`Notif PROCESSING #${order.id} gagal:`, error.message); }
  }
}

async function handleOrderForm(sock, chat, msg, raw, cfg) {
  const parsed = parseOrderForm(raw);
  if (!parsed) return false;
  if (!storeIsOpen()) {
    await sendStoreClosedReminder(sock, chat, msg);
    return true;
  }
  if (parsed.missing.length) {
    await sendText(sock, chat,
      `✦ Form order belum lengkap. Isi: ${parsed.missing.join(', ')}.\nKirim ulang form lengkap yaa ♡`, msg);
    return true;
  }
  if (process.env.DISCORD_ENABLED==='false' && (!isGroupJid(cfg.adminGroupId) || cfg.adminGroupId === chat || cfg.adminGroupId === cfg.luckyverseGroupId)) {
    await sendText(sock, chat, '✦ Sistem order sedang disiapkan admin. Hubungi admin untuk mencatat order sementara.', msg);
    return true;
  }
  const sourceKey = [chat, msg.key.id, msgSender(msg)].join('|');
  if (!msg.key.id || inProgress.has(sourceKey)) return true;
  inProgress.add(sourceKey);
  try {
    const phone = await findBuyerPhone(sock, chat, msg, parsed.fields.buyerPhoneInput);
    const buyerPrivate = await resolvePrivateJid(sock, chat, msg);
    if (orders.bySource(sourceKey)) return true;
    let discount=0, voucher=null;
    const code=String(parsed.fields.voucher||'').trim().toUpperCase();
    if (code && !['-','TIDAK ADA','NONE'].includes(code)) {
      const checked=luckyverse.getVoucher(code);
      if (checked.error || checked.voucher.status!=='active') {
        await sendText(sock, chat, '✦ Voucher tidak ditemukan, sudah dipakai, terkunci, atau kedaluwarsa. Perbaiki kode atau isi - untuk tanpa voucher. Belum ada tagihan.', msg);
        return true;
      }
      const v=checked.voucher;
      const clean=x=>String(x||'').replace(/:\d+@/,'@');
      const candidates=[buyerPrivate,msg.key.participant,msg.key.participantAlt,msg.key.participantPhone,phone.source==='WhatsApp'?privateJidFromPhone(phone.phone):null].filter(Boolean).map(clean);
      if (!candidates.includes(clean(v.ownerId))) {
        await sendText(sock, chat, '✦ Voucher bukan milik akun WhatsApp pengirim atau identitas tidak cocok. Hubungi admin. Belum ada tagihan.', msg);return true;
      }
      discount=v.discount;
      if (![5000,10000,15000].includes(discount)) {
        await sendText(sock,chat,'✦ Nominal voucher tidak valid. Hubungi admin. Belum ada tagihan.',msg);return true;
      }
      voucher=v.serial;
    }
    // No await between voucher check and durable order reservation. One process only.
    if(!qrisEnabled(cfg) || cfg.qrisAutoPrice!==true){await sendText(sock,chat,'✦ Pembayaran otomatis belum diaktifkan admin. Belum ada order.',msg);return true;}
    const requestedPackage={product:parsed.fields.product,variant:parsed.fields.variant,duration:parsed.fields.duration};
    const result = orders.add({
      sourceKey, groupId: chat, buyerJid: msgSender(msg), buyerAccountId:buyerPrivate||msgSender(msg),
      buyerPhone: phone.phone, buyerPhoneSource: phone.source,
      name: parsed.fields.name, ...requestedPackage, device: parsed.fields.device,
      requestedPackage, adminSelectRequired:true, sku:null, originalPrice:null, discount, total:null, voucher,
      quote: { key: {remoteJid:chat,id:msg.key.id,participant:msg.key.participant,fromMe:false}, message:{conversation:raw} }
    });
    if (!result.created) return true;
    const order = result.order;
    try { const sent=await sendText(sock,chat,texts.orderReceived.replaceAll('{order_id}', '#'+order.id)+'\n\nBalas pesan ini atau QRIS untuk menghubungi staff. Alternatif: .pesan #'+order.id+' isi pesan. Kirim bukti bayar dengan reply QRIS; jangan kirim password/OTP di grup.',msg); if(sent?.key?.id){order.waReplyIds=[sent.key.id];orders.save();} }
    catch(error){console.error(`Konfirmasi order #${order.id} gagal:`,error.message);}
    try { if(isGroupJid(cfg.adminGroupId)&&cfg.adminGroupId!==chat)await notifyAdmin(sock,cfg.adminGroupId,order); }
    catch(error){ console.error(`Notif order #${order.id} tertunda:`,error.message); }
    return true;
  } finally {
    inProgress.delete(sourceKey);
  }
}

async function handleAdminOrderCommand(sock, msg, chat, parts, command, context=null) {
  const admin = context?.admin || await verifiedOrderAdmin(sock, chat, msg);
  const respond = context?.respond || ((text)=>sendText(sock,chat,text,msg));
  if (!admin) return; // hanya admin resmi grup notifikasi

  if (command === 'rekap') {
    if (parts[1] && parts[1].toLowerCase() !== 'all') {
      return respond('Contoh: .rekap (hari ini) atau .rekap all (semua waktu)');
    }
    const r = orders.recap(parts[1] ? 'all' : 'today'); const combined=B.sales(parts[1]?'all':'today');
    return respond([
      '✦ REKAP ORIVELA STARFALL ✦',
      r.scope === 'all' ? 'Periode: Semua waktu' : `Tanggal: ${r.today} (WIB)`,
      `Order masuk: ${r.createdCount}`,
      `Pembayaran diverifikasi: ${r.paidCount}`,
      `Pesanan selesai: ${r.doneCount}`,
      `Semua order belum dibayar: ${r.waitingCount}`,
      `Total pembayaran tercatat: ${rupiah(r.total)}`,
      `Pembayaran tanpa nominal: ${r.missingAmountCount}`,
      `Gabungan WA + Discord (order selesai): ${combined.count} · ${rupiah(combined.total)}`,
      'Catatan: total hanya menghitung pembayaran terverifikasi dengan nominal tercatat.'
    ].join('\n'));
  }

  const ref = resolveOrderReference(chat, msg, parts.slice(1));
  if (ref.error) return respond(`✦ ${ref.error}\nContoh: reply NEW ORDER lalu .paid 30000 atau .d.`);
  const order = orders.byId(ref.id);
  if (!order) return respond('✦ ID pesanan tidak ditemukan.');
  if(paymentDue(order) && cancelPayment(order,'Waktu pembayaran 30 menit habis')) {
    try{await notifyCancellation(sock,order,loadConfig());}catch(e){console.error('Notif pembatalan tertunda:',e.message);}
    return respond('Tagihan kedaluwarsa. Jika dana sudah masuk, lakukan rekonsiliasi manual dengan owner.');
  }

  if (command === 'tagih' || command === 'qris') {
    const cfg=loadConfig();
    if (!qrisEnabled(cfg) || order.paidAt || order.doneAt || order.cancelledAt || order.groupId!==cfg.groupId) return respond('QRIS tidak tersedia untuk order ini.');
    const invoice=invoiceStore.get(order.id);
    if(!invoice || (order.adminSelectRequired && !order.packageConfirmedAt)) return respond('QRIS belum dibuat. Gunakan .ambil KODE PAKET terlebih dahulu.');
    const lock=adminLocks.data.claims[order.id];
    if(!adminLocks.sameOwner(lock,admin)) return respond('Hanya admin yang mengambil order boleh mengirim ulang QRIS. Gunakan .ambil KODE jika belum ada penanggung jawab.');
    try {
      if(command==='tagih' && qrisInvoice.amountValue(ref.remainder.join(' '))!==invoice.amount) throw Error('Nominal sudah dikunci: '+rupiah(invoice.amount));
      await deliverOrderInvoice(sock,order,invoice,cfg);
      return respond(`QRIS #${order.id} ${rupiah(invoice.amount)} dikirim ulang ke Store.`);
    } catch(error){return respond(`QRIS gagal: ${error.message}`);}
  }

  if (command === 'cancel') {
    if(invoiceInFlight.has(order.id))return respond('QRIS sedang dikirim; tunggu hasilnya sebelum membatalkan.');
    if(order.cancelledAt || order.paidAt || order.doneAt)return respond('Order tidak dapat dibatalkan.');
    if(ref.remainder.length && ref.remainder.join(' ').toUpperCase()!=='BELUM BAYAR')return respond('Reply NEW ORDER dengan .cancel setelah memastikan tidak ada dana masuk.');
    const taken=adminLocks.claim(order.id,admin);if(taken.error)return respond(taken.error);
    if(!cancelPayment(order,'Dibatalkan admin'))return respond('Order tidak dapat dibatalkan.');
    try{await notifyCancellation(sock,order,loadConfig());}catch(e){console.error('Notif pembatalan tertunda:',e.message);}
    return respond(`Order #${order.id} dibatalkan. Slot promo/voucher dilepas. Periksa GoPay Merchant jika ada pembayaran terlambat.`);
  }
  if (order.cancelledAt)return respond('Order sudah dibatalkan.');
  // Semua perubahan status diperiksa terhadap admin penanggung jawab.
  // Setelah admin baru mengunci, admin kedua selalu ditolak.
  if (command === 'ambil') {
    const cfg=loadConfig();
    if (order.paidAt || order.doneAt || order.cancelledAt || order.groupId!==cfg.groupId) return respond('Order sudah dibayar/selesai/dibatalkan atau bukan Store aktif.');
    if(invoiceInFlight.has(order.id))return respond('QRIS sedang dikirim. Tunggu hasilnya.');
    try {
      const input=ref.remainder.join(' ');
      const normal=/^P\d{3}\s+normal$/i.test(input);
      const row=selectPackage(normal?input.split(/\s+/)[0]:input);
      if(!row || row.amount==null)return respond('Paket tidak ditemukan atau belum aktif. Gunakan .listkode NamaProduk, lalu reply NEW ORDER: .ambil P008 atau .ambil Produk | Varian | Durasi. QRIS belum diterbitkan oleh perintah ini.');
      const previous=invoiceStore.get(order.id);
      const existingLock=adminLocks.data.claims[order.id];
      if(existingLock && !adminLocks.sameOwner(existingLock,admin))return respond(`Order sudah diambil admin ${existingLock.name}.`);
      if((previous || order.packageConfirmedAt) && order.sku!==row.sku)return respond('Paket/tagihan sudah dikunci. Jangan mengubah nominal QRIS yang mungkin sudah diterima buyer. Batalkan setelah memastikan belum bayar, lalu buat order baru.');
      if(!qrisEnabled(cfg)||cfg.qrisAutoPrice!==true)throw Error('QRIS otomatis belum diaktifkan.');
      const locked=!!(previous||order.packageConfirmedAt);
      const originalPrice=locked ? qrisInvoice.amountValue(order.originalPrice) : qrisInvoice.amountValue(row.amount);
      const discount=Number(order.discount||0);
      const offer=locked ? null : promos.offer(row.sku,order.groupId);
      if(normal && !locked && !order.voucher)throw Error('Opsi normal hanya untuk order dengan voucher Luckyverse.');
      if(normal && locked && order.promoId)throw Error('Harga promo sudah terkunci.');
      if(offer && offer.original!==originalPrice)throw Error('Harga katalog berubah sejak promo dibuat. Hubungi owner untuk mengakhiri promo.');
      if(offer && order.voucher && !normal)throw Error('Promo tidak digabung voucher. Konfirmasi buyer: gunakan .ambil '+row.sku+' normal untuk harga normal dikurangi voucher, atau batalkan dan buat order baru tanpa voucher untuk promo.');
      if(![0,5000,10000,15000].includes(discount) || discount>=originalPrice)throw Error('Harga harus lebih besar dari diskon voucher. Jangan buat QRIS; hubungi buyer atau batalkan order.');
      if(order.voucher && !locked){
        const v=luckyverse.getVoucher(order.voucher).voucher;
        if(!v||v.status!=='reserved'||v.orderId!==order.id||v.discount!==discount||Date.now()>=Date.parse(v.expiresAt))throw Error('Voucher tidak valid atau sudah kedaluwarsa. Batalkan order dan minta buyer buat order baru.');
      }
      const promo=offer&&!normal?offer:null;
      const total=locked?qrisInvoice.amountValue(order.total):promo?promo.price:originalPrice-discount;
      if(previous && previous.amount!==total)throw Error('Nominal tagihan lama tidak cocok; hubungi owner.');
      qrisInvoice.makeAmountPayload(fs.readFileSync(path.join(ROOT,'..','discord','data','qris-payload.txt'),'utf8'),total);
      const taken=adminLocks.claim(order.id,admin);
      if(taken.error)return respond(taken.error);
      if(!locked){
        Object.assign(order,{product:row.product,variant:row.variant,duration:row.duration,sku:row.sku,originalPrice,total,packageConfirmedAt:new Date().toISOString(),...(promo?{promoId:promo.id,promoDiscount:originalPrice-total}:{})});
        orders.save();
        // No await before durable slot reservation and closing sold-out promos.
        promos.refresh();
      }
      const invoice=issueInvoice(order,total,cfg);
      if(order.invoiceSentAt)return respond(`Order #${order.id} sudah diambil dan QRIS sudah dikirim. Gunakan .qris #${order.id} jika perlu kirim ulang.`);
      await deliverOrderInvoice(sock,order,invoice,cfg);
      const sent=await respond(`✦ ORDER DIAMBIL ♡\nID: #${order.id}\nAdmin: ${taken.lock.name}\nPaket: ${order.sku} | ${order.product} | ${order.variant} | ${order.duration}\nHarga: ${rupiah(originalPrice)}\nVoucher: ${rupiah(discount)}\n${order.promoId?`Promo ${order.promoId}: -${rupiah(order.promoDiscount)}\n`:""}Total: ${rupiah(total)}\nQRIS terkirim ke Store.\nSetelah cek dana masuk: .paid #${order.id} ${total}`);
      if(!context)adminLocks.rememberNotification(chat,sent?.key?.id,order.id);
      if(order.promoId) await promos.tick(sock,cfg);
      return;
    }catch(error){return respond(`✦ .ambil belum selesai: ${error.message}\nJika QRIS gagal terkirim, ulangi .ambil dengan kode yang sama atau .qris jika tagihan sudah dibuat.`);}
  }
  if (command === 'lepas') {
    if(invoiceInFlight.has(order.id))return respond('QRIS sedang dikirim; tunggu hasilnya.');
    if (order.paidAt) return respond('✦ Order sudah PAID; tidak bisa dilepas otomatis. Hubungi pengelola bot untuk pengalihan yang aman.');
    const r = adminLocks.release(order.id, admin);
    return respond(`✦ ${r.error || `Order #${order.id} dilepas dan bisa diambil admin lain.`}`);
  }
  if (command === 'paid' || command === 'nominal') {
    let amount;
    try {
      amount = parseAmount(ref.remainder.join(' '));
    } catch (error) {
      return respond(`✦ ${error.message}`);
    }
    const invoice = invoiceStore.get(order.id);
    if (!order.paidAt && (!invoice || (order.adminSelectRequired && (!order.packageConfirmedAt || !order.invoiceSentAt)))) return respond('Belum ada QRIS yang dikonfirmasi terkirim. Gunakan .ambil KODE, atau .qris untuk mengirim ulang tagihan.');
    if (invoiceInFlight.has(order.id)) return respond('QRIS sedang dikirim. Tunggu hasilnya.');
    if (amount === null || amount !== order.total || (invoice && amount !== invoice.amount)) {
      return respond(`Nominal tagihan #${order.id}: ${rupiah(order.total)}. Setelah benar-benar cek dana masuk, gunakan .${command} #${order.id} ${order.total}. Jika ada selisih, hubungi pengelola dan jangan tandai PAID.`);
    }
    if (command === 'nominal' && amount === null) {
      return respond('✦ Contoh: reply notifikasi lalu .nominal 30000, atau .nominal #ID 30000');
    }
    if (command === 'paid' && order.paidAt) {
      const taken = adminLocks.claim(order.id, admin);
      if (taken.error) return respond(`✦ ${taken.error}`);
      if (order.processingRequestedAt && !order.processingNotifiedAt && !order.doneAt) {
        try { await notifyProcessing(sock, order); }
        catch (error) { return respond(`✦ Order #${order.id} tetap PAID. Notifikasi proses belum terkirim; bot akan mencoba lagi.`); }
        return respond(`✦ Order #${order.id} sudah PAID. Notifikasi proses dikirim ke Store.`);
      }
      return respond(`✦ Order #${order.id} sudah PAID. Tidak ada pembayaran baru atau notifikasi ganda.`);
    }
    if (command === 'nominal' && !order.paidAt) return respond(`✦ Order #${order.id} belum PAID. Verifikasi pembayaran dulu.`);

    const taken = adminLocks.claim(order.id, admin);
    if (taken.error) return respond(`✦ ${taken.error}`);
    const result = command === 'paid' ? orders.markPaid(order.id, amount) : orders.setAmount(order.id, amount);
    if (result.error) return respond(`✦ ${result.error}`);
    const current = result.order;
    let processingStatus = '';
    if (command === 'paid') {
      try { await notifyProcessing(sock, current); processingStatus = 'Notifikasi proses: terkirim ke Store'; }
      catch (error) { console.error(`Notif PROCESSING #${current.id} gagal:`, error.message); processingStatus = 'Notifikasi proses: belum terkirim; bot akan mencoba lagi. Ulangi .paid jika perlu (tidak mencatat ulang pembayaran).'; }
    }
    return respond([
      command === 'paid' ? '✦ PAYMENT VERIFIED ♡' : '✦ NOMINAL DIPERBARUI ♡',
      `ID: #${current.id}`, `Admin: ${taken.lock.name}`, `Buyer: ${current.name}`,
      `Nominal: ${rupiah(current.amount)}`, `Status: ${current.status}`, ...(current.voucher ? ['Voucher: USED'] : []),
      ...(processingStatus ? [processingStatus] : []),
      ...(current.amount === null ? ['Catatan: gunakan reply .nominal 30000 agar rupiah masuk rekap.'] : [])
    ].join('\n'));
  }
  if (command === 'd') {
    if (!order.paidAt) return respond(`✦ Order #${order.id} belum PAID. Verifikasi pembayaran terlebih dahulu.`);
    if (order.doneAt) {
      const lock=adminLocks.claim(order.id,admin);if(lock.error)return respond(lock.error);
      if(!order.doneNotifiedAt){await sendText(sock,order.groupId,texts.completed.replace('{id}',order.id),order.quote);order.doneNotifiedAt=new Date().toISOString();orders.save();return respond('Notifikasi DONE dikirim ulang.');}
      return respond(`✦ Order #${order.id} sudah DONE. Tidak ada perubahan.`);
    }
    const taken = adminLocks.claim(order.id, admin);
    if (taken.error) return respond(`✦ ${taken.error}`);
    // Jangan kirim PROCESSING setelah DONE apabila pengiriman sedang berjalan.
    if (processingInFlight.has(order.id)) {
      try { await processingInFlight.get(order.id); } catch (error) { console.error('Notif proses gagal sebelum DONE:', error.message); }
    }
    const result = orders.markDone(order.id);
    if (result.error) return respond(`✦ ${result.error}`);
    const current = result.order;
    await respond(`✦ ORDER COMPLETED ♡\nID: #${current.id}\nAdmin: ${taken.lock.name}\nBuyer: ${current.name}\nPayment: PAID\nStatus: DONE ✅`);
    try {
      await sendText(sock, current.groupId,
        texts.completed.replace('{id}',current.id), current.quote);
      current.doneNotifiedAt=new Date().toISOString();orders.save();
    } catch (error) {
      console.error(`Gagal kirim konfirmasi DONE #${current.id}:`, error.message);
    }
  }
}

const dcActions=new Set();
function dcAdmin(actor){if(!/^\d{17,22}$/.test(actor?.id||''))throw Error('Staff Discord tidak valid.');return {key:'dc:'+actor.id,ids:['dc:'+actor.id],name:String(actor.name||'Staff Discord').replace(/[\r\n\t]/g,' ').slice(0,50)};}
function requireWAOrder(id){const o=orders.byId(id);if(!o||o.groupId!==loadConfig().groupId||!isGroupJid(o.groupId))throw Error('Order WA tidak ditemukan di Store aktif.');return o;}
function actualBuyer(o){for(const value of [o.buyerAccountId,o.buyerJid,o.quote?.key?.participant]){if(typeof value==='string'&&/^\d+(?::\d+)?@(?:s\.whatsapp\.net|lid)$/.test(value))return value.replace(/:\d+@/,'@');}throw Error('Identitas WA pengirim asli tidak tersedia. Jangan kirim akun ke nomor dari form.');}
async function discordOrderAction(id,actor,action,value=''){if(!activeSocket||!B.waSender)throw Error('WhatsApp belum online.');return performDiscordOrderAction(activeSocket,id,actor,action,value);}
async function performDiscordOrderAction(sock,id,actor,action,value=''){
  const o=requireWAOrder(id), admin=dcAdmin(actor);if(dcActions.has(id))throw Error('Order sedang diproses.');dcActions.add(id);
  try{
    if(action==='send'||action==='reply'){
      if(o.cancelledAt||o.doneAt)throw Error('Order sudah selesai/dibatalkan.');
      if(action==='send'&&(!o.paidAt||o.deliverySentAt))throw Error('Pengiriman akun hanya setelah PAID dan belum pernah dikirim.');
      const claim=adminLocks.claim(id,admin);if(claim.error)throw Error(claim.error);
      const text=String(value).trim();if(!text||text.length>1500)throw Error('Isi pesan 1–1500 karakter.');
      if(action==='send'){
        // No account payload is saved or posted into the Discord channel or WA group.
        if(o.deliveryAttemptAt)throw Error('Pengiriman sebelumnya belum pasti. Owner harus cek chat WA sebelum mencoba ulang secara manual.');
        const jid=actualBuyer(o);o.deliveryAttemptAt=new Date().toISOString();orders.save();
        try{await sendText(sock,jid,'✦ ORIVELA Starfall · #'+id+' ♡\n\n'+text+'\n\nJaga informasi akun ini secara privat.');}catch{throw Error('Pengiriman belum terkonfirmasi. Cek chat WA buyer; jangan kirim ulang otomatis.');}
        o.deliverySentAt=new Date().toISOString();orders.save();return 'Data pesanan terkirim ke chat pribadi buyer WA. Klik Selesaikan setelah diperiksa.';
      }
      const sent=await sendText(sock,o.groupId,'✦ ORIVELA Staff · #'+id+'\n'+text,o.quote);
      if(sent?.key?.id){o.waReplyIds=[...new Set([...(o.waReplyIds||[]),sent.key.id])].slice(-30);orders.save();}return 'Balasan terkirim ke grup Store WA.';
    }
    if(!['ambil','qris','paid','d','cancel','lepas'].includes(action))throw Error('Aksi tidak dikenal.');
    if(action==='cancel'&&value!=='BELUM BAYAR')throw Error('Konfirmasi BELUM BAYAR setelah cek merchant.');
    if(action==='d'&&!o.deliverySentAt&&!o.doneAt)throw Error('Kirim data akun lewat tombol Kirim Akun dahulu.');
    let result='';await handleAdminOrderCommand(sock,{message:{}},null,['.'+action,id,...String(value).trim().split(/\s+/).filter(Boolean)],action,{admin,respond:async t=>{result+=(result?'\n':'')+t;}});return result||'Aksi selesai. Cek status order.';
  }finally{dcActions.delete(id);}
}
const relayInFlight=new Set();
async function forwardOrderReply(sock,chat,msg,raw,cfg){
  if(chat!==cfg.groupId||!msg.key.id)return false;
  const explicit=/^\.(?:pesan|bukti)\s+#?(ORV-[A-F0-9]{12})(?:\s+([\s\S]*))?$/i.exec(raw),quote=quoteMessageId(msg.message);
  const o=explicit?orders.byId(explicit[1].toUpperCase()):quote?orders.data.orders.find(x=>x.quote?.key?.id===quote||x.waReplyIds?.includes(quote)):null;
  if(!o||o.groupId!==chat||o.doneAt||o.cancelledAt)return false;
  const sender=[msg.key.participant,msg.key.participantAlt,msg.key.participantPhone].filter(Boolean).map(x=>String(x).replace(/:\d+@/,'@'));
  const buyers=[o.buyerJid,o.buyerAccountId,o.quote?.key?.participant].filter(Boolean).map(x=>String(x).replace(/:\d+@/,'@'));
  if(!sender.some(x=>buyers.includes(x)))return false;
  const key=msg.key.id, job=o.id+":"+key;if(o.waForwarded?.includes(key)||relayInFlight.has(job))return true;relayInFlight.add(job);
  const m=msg.message.ephemeralMessage?.message||msg.message;let media=null;
  try{if(m.imageMessage||m.videoMessage){if(Number((m.imageMessage||m.videoMessage).fileLength)>M.MAX)throw Error('Media maksimal 8 MiB.');media=M.validate(await promos.downloadPhoto(sock,msg));}
    const text=String(explicit?explicit[2]||'':raw).slice(0,1500);if(!text&&!media)return false;
    if(!B.waOrderReply)throw Error('Discord belum online.');
    await B.waOrderReply(o,{key,text,media});o.waForwarded=[...(o.waForwarded||[]),key].slice(-100);orders.save();return true;
  }catch(e){await sendText(sock,chat,'✦ Pesan ke staff Discord belum terkirim. Coba reply lagi atau .pesan #'+o.id+' isi pesan. Jangan kirim password/OTP di grup.',msg).catch(()=>{});return true;}finally{relayInFlight.delete(job);}
}

async function handleCommand(sock, msg) {
  if (!msg || !msg.message || msg.key.fromMe) return;
  const chat = msg.key.remoteJid || '';
  const raw = getText(msg.message).trim();
  if (!isGroupJid(chat)) { if (/^\.link\s+/i.test(raw) && /^\d+@(?:s\.whatsapp\.net|lid)$/.test(chat)) { try { const id=usablePrivateJid(msg.key.remoteJidAlt)||usablePrivateJid(chat);  B.acceptLink(raw.split(/\s+/)[1],id); await sendText(sock,chat,'Akun terhubung! Kembali ke Discord dan gunakan /game.'); } catch(e){await sendText(sock,chat,e.message);} } return; }
  const config = loadConfig();
  if(await forwardOrderReply(sock,chat,msg,raw,config))return;
  if (chat === config.adminGroupId && await announcements.handle(sock,chat,msg,raw,config)) return;
  if (chat === config.adminGroupId && await promos.handle(sock,chat,msg,raw,config)) return;
  if (!raw) return;

  // Jawaban puzzle teks biasa hanya diproses di grup Luckyverse yang sudah disetel.
  if (chat === config.luckyverseGroupId && !raw.startsWith('.')) {
    if (!markGameMessageOnce(chat, msg)) return;
    const answer = luckyverse.handleText((await resolvePrivateJid(sock, chat, msg)) || msgSender(msg), msg.pushName || 'Pemain', raw);
    if (answer) return sendText(sock, chat, answer, msg);
    return;
  }

  // Formulir order dari buyer hanya diproses di grup utama, bukan grup admin.
  if (chat === config.groupId && !raw.startsWith('.')) {
    if (await handleOrderForm(sock, chat, msg, raw, config)) return;
    if (!storeIsOpen()) return sendStoreClosedReminder(sock, chat, msg);
  }
  if (!raw.startsWith('.') || raw.length > 350) return;
  const parts = raw.slice(1).split(/\s+/).filter(Boolean);
  if (!parts.length) return;
  const command = normalizeCommand(parts[0]);
  if (chat === config.groupId && command === "order" && !storeIsOpen()) {
    return sendStoreClosedReminder(sock, chat, msg);
  }

  // .id tetap dapat digunakan untuk membaca ID grup saat setup.
  if (command === 'id') {
    const role = chat === config.groupId ? 'STORE' : chat === config.adminGroupId ? 'ADMIN' : chat === config.luckyverseGroupId ? 'LUCKYVERSE' : 'BELUM TERDAFTAR';
    return sendText(sock, chat, `✦ ID grup: ${chat}\nPeran: ${role}`, msg);
  }
  // Grup Store ditetapkan lewat config.json atau .aktifkan oleh owner terdaftar.
  if (command === 'aktifkan') {
    if (!(await senderIsGroupAdmin(sock, chat, msg))) return;
    const current = loadConfig();
    if (current.groupId === chat) return sendText(sock, chat, '✦ Store sudah aktif di grup ini.', msg);
    if (current.groupId || chat === current.adminGroupId || chat === current.luckyverseGroupId) {
      return sendText(sock, chat, '⛔ Peran grup sudah ditetapkan. Penggantian hanya melalui config.json.', msg);
    }
    const sender = [msgSender(msg), msg.key.participantAlt, msg.key.participantPhone].map(localId).filter(Boolean);
    const owners = Array.isArray(current.ownerPhones) ? current.ownerPhones.map(digits) : [];
    if (!owners.some(id => sender.includes(id))) return sendText(sock, chat, '⛔ Isi groupId atau ownerPhones di config.json terlebih dahulu.', msg);
    current.groupId = chat;
    saveConfig(current);
    return sendText(sock, chat, '✦ ORIVELA Starfall aktif di grup Store ini! ♡', msg);
  }
  if (command === 'setluckyverse') {
    if (!(await senderIsGroupAdmin(sock, chat, msg))) return;
    if (config.luckyverseGroupId === chat) return sendText(sock, chat, '✨ Luckyverse sudah aktif di grup ini.', msg);
    if (!config.groupId || !(await senderIsGroupAdmin(sock, config.groupId, msg))) return sendText(sock, chat, '⛔ Setup Luckyverse memerlukan admin Store yang juga admin Luckyverse, atau pengaturan config.json.', msg);
    const current = loadConfig();
    if (current.groupId !== config.groupId || current.luckyverseGroupId || chat === current.groupId || chat === current.adminGroupId) {
      return sendText(sock, chat, '⛔ Peran grup bentrok atau sudah ditetapkan. Periksa config.json.', msg);
    }
    current.luckyverseGroupId = chat;
    current.gameGroupId = chat;
    saveConfig(current);
    return sendText(sock, chat, '✨ Grup Luckyverse aktif. Ketik .games untuk melihat menu.', msg);
  }
  if (command === 'setvoucheradmin') {
    if (![config.groupId, config.luckyverseGroupId, config.adminGroupId].includes(chat)) return;
    if (!(await senderIsGroupAdmin(sock, chat, msg))) return;
    return sendText(sock, chat, config.adminGroupId ? `✦ Voucher otomatis mengikuti grup Admin order: ${config.adminGroupId}. Tidak perlu grup tambahan.` : 'Atur grup Admin terlebih dahulu dengan .setnotif ID_GRUP dari Store atau config.json.', msg);
  }
  if (command === 'setnotif' && chat === config.groupId) {
    if (!(await senderIsGroupAdmin(sock, chat, msg))) return;
    const target = parts[1] || '';
    if (!isGroupJid(target) || target === chat || target === config.luckyverseGroupId) return sendText(sock, chat, '⛔ Gunakan ID grup Admin yang berbeda dari Store dan Luckyverse.', msg);
    if (config.adminGroupId === target) return sendText(sock, chat, '✦ Grup Admin sudah terhubung.', msg);
    if (config.adminGroupId) return sendText(sock, chat, '⛔ Grup Admin sudah ditetapkan. Penggantian hanya melalui config.json.', msg);
    try {
      await sock.groupMetadata(target);
      const current = loadConfig();
      if (current.groupId !== chat || current.adminGroupId || target === current.luckyverseGroupId) return sendText(sock, chat, '⛔ Konfigurasi berubah atau peran grup bentrok.', msg);
      current.adminGroupId = target;
      current.luckyverseAdminGroupId = target;
      saveConfig(current);
      await sendText(sock, target, '✦ Grup ADMIN ORIVELA terhubung. Notifikasi order dan voucher masuk ke sini.');
      await sendText(sock, chat, '✦ Grup Admin berhasil dihubungkan! ♡', msg);
      await flushPendingNotifications(sock);
      await flushPendingVoucherNotifications(sock);
    } catch (error) {
      console.error('Gagal menghubungkan grup Admin:', error.message);
      return sendText(sock, chat, 'Periksa ID, akses bot dan config.json. Pengaturan mungkin sudah tersimpan.', msg);
    }
    return;
  }

  // Validasi voucher hanya boleh dijalankan admin di grup notifikasi voucher.
  const voucherAdminTarget = voucherAdminGroup(config);
  if (isGroupJid(voucherAdminTarget) && chat === voucherAdminTarget && ['pakai', 'cekvoucher', 'kirimulang'].includes(command)) {
    return handleVoucherAdminCommand(sock, msg, chat, parts, command);
  }

  // Grup Luckyverse: pulihkan command admin game sebelum meneruskan command pemain.
  if (config.luckyverseGroupId && chat === config.luckyverseGroupId) {
    if (!markGameMessageOnce(chat, msg)) return;
    if (GAME_ADMIN_COMMANDS.has(command)) {
      return handleGameAdminCommand(sock, msg, chat, command, parts.slice(1));
    }
    return handleLuckyverseCommand(sock, msg, chat, parts, command, config);
  }

  // Grup admin: hanya admin grup yang boleh menandai pembayaran dan penyelesaian.
  if (config.adminGroupId && chat === config.adminGroupId && chat !== config.groupId) {
    if (command === 'listkode') {
      if(!(await verifiedOrderAdmin(sock,chat,msg)))return;
      for(const page of catalogCodePages(parts.slice(1).join(' ')))await sendText(sock,chat,page,msg);
      return;
    }
    if (command === 'harga') { if(await verifiedOrderAdmin(sock,chat,msg))return sendText(sock,chat,catalogMessage(parts.slice(1).join(' ')),msg);return; }
    if (['paid', 'd', 'rekap', 'nominal', 'ambil', 'lepas', 'tagih', 'qris', 'cancel'].includes(command)) {
      return handleAdminOrderCommand(sock, msg, chat, parts, command);
    }
    return; // tidak menanggapi katalog, order, dan perintah publik di grup admin
  }

  // Keluar jika berasal dari grup WhatsApp lain.
  if (config.groupId !== chat) return;
  if (command === 'promo') {
    await sweepPayments(sock,config);
    const pages=promos.publicPages(chat);
    if(!pages.length)return sendText(sock,chat,'☾ Saat ini belum ada promo aktif, lovelies! ♡',msg);
    for(const page of pages)await sendText(sock,chat,page,msg);
    return;
  }
  if (command === 'pricelist' || command === 'list') return sock.sendMessage(chat,{image:{url:path.join(ROOT,'data','pricelist.png')},caption:'✦ ORIVELA STARFALL PRICELIST ✦\nKetik .harga NamaProduk untuk melihat paket yang bisa dipesan.'},{quoted:msg});
  if (command === 'harga') return sendText(sock,chat,catalogMessage(parts.slice(1).join(' ')),msg);
  const publicText = publicReply(command);
  // Formulir lama tetap disimpan di data/texts.json; hanya label yang ditampilkan diubah.
  // Parser di order-system.js menerima Device maupun Device/Lokasi untuk kompatibilitas.
  if (publicText) {
    const response = command === 'order'
      ? publicText.replace(/\bDevice\s*[:：]/gi, 'Device/Lokasi :')
      : publicText;
    return sendText(sock, chat, response, msg);
  }

  if (command === 'helpadmin') {
    if (!(await senderIsGroupAdmin(sock, chat, msg))) return;
    return sendText(sock, chat,
      '✦ ADMIN COMMANDS\n.cancel (reply NEW ORDER, setelah cek dana) / .cancel #ID\n.payment - Petunjuk pembayaran\n.proses - Cadangan manual; .paid otomatis mengirim proses ke Store\n.done - Status selesai (lama)\n.welcome on / off - Sambutan\n\nDi grup admin notif:\n.notif - buat announcement Store\n.cancelnotif - batal setup announcement\n.promo - setup promo\n.listpromo - promo aktif\n.endpromo ID - akhiri promo\n.cancelpromo - batal setup\n.listkode / .listkode NamaProduk - daftar kode paket\nReply NEW ORDER: .ambil KODE (contoh P008) / .paid [nominal] / .d\n.lepas (sebelum PAID)\n.nominal nominal\nAlternatif tetap: .paid #ID [nominal], .d #ID\n.rekap / .rekap all\n.tagih #ID NOMINAL - hanya kirim ulang tagihan terkunci\n.qris #ID - kirim ulang QRIS\n\nDi grup utama (admin):\n.setnotif IDgrup', msg);
  }
  if (!['payment', 'bayar', 'proses', 'done', 'welcome'].includes(command)) return;
  if (!(await senderIsGroupAdmin(sock, chat, msg))) return;
  if (command === 'proses') return sendText(sock, chat, texts.prosesManual, msg);
  if (command === 'done') return sendText(sock, chat, texts.done, msg);
  if (command === 'welcome') {
    if (!['on','off'].includes(parts[1])) return sendText(sock, chat, 'Contoh: .welcome on / .welcome off', msg);
    config.welcomeEnabled = parts[1] === 'on';
    saveConfig(config);
    return sendText(sock, chat, `Welcome otomatis ${config.welcomeEnabled ? 'AKTIF' : 'NONAKTIF'}.`, msg);
  }
  return sendText(sock,chat,'QRIS hanya dikirim setelah admin mengambil order di grup Admin. Tunggu tagihan khusus order yaa ♡',msg);
}

async function connect() {
  // Impor dinamis mendukung distribusi Baileys ESM maupun CommonJS.
  const baileys = await import('@whiskeysockets/baileys');
  makeWASocket = typeof baileys.default === 'function' ? baileys.default : (baileys.makeWASocket || baileys.default?.default);
  useMultiFileAuthState = baileys.useMultiFileAuthState || baileys.default?.useMultiFileAuthState;
  DisconnectReason = baileys.DisconnectReason || baileys.default?.DisconnectReason;

  const cfg = loadConfig();
  const pairingMode = cfg.pairingMode ?? 'code';
  if (!['code', 'qr'].includes(pairingMode)) {
    throw new Error('pairingMode harus code atau qr di config.json.');
  }
  if (pairingMode === 'code' && !/^62\d{7,13}$/.test(digits(cfg.botPhone))) {
    console.error('ISI config.json -> botPhone = nomor WHATSAPP BOT format 62..., bukan nomor admin.');
    process.exitCode = 1;
    return;
  }
  const { state, saveCreds } = await useMultiFileAuthState(AUTH);
  let hasAskedForPairing = false;
  const sock = makeWASocket({
    auth: state, logger: LOG, markOnlineOnConnect: false, syncFullHistory: false,
    browser: ['Ubuntu', 'Chrome', '120.0.0']
  });
  activeSocket = sock;
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async update => {
    if (activeSocket !== sock) return;
    if (update.qr && !state.creds.registered) {
      if (pairingMode === 'qr') {
        try {
          const qr = await require('qrcode').toString(update.qr, { type: 'terminal', small: true });
          if (activeSocket !== sock || state.creds.registered) return;
          console.log('\n=== QR TAUTKAN WHATSAPP BOT (RAHASIA) ===');
          console.log(qr);
          console.log('Di WA nomor bot: Perangkat tertaut > Tautkan perangkat > scan QR terbaru.');
          console.log('QR akan diperbarui ketika WhatsApp mengirim QR baru. Jangan bagikan QR ini.\n');
        } catch (error) {
          console.error('Gagal menampilkan QR pairing:', error.message);
        }
      } else if (!hasAskedForPairing) {
        hasAskedForPairing = true;
        try {
          const phone = digits(loadConfig().botPhone);
          const code = await sock.requestPairingCode(phone);
          if (activeSocket !== sock || state.creds.registered) return;
          console.log('\n=== KODE TAUTKAN WHATSAPP BOT (RAHASIA) ===');
          console.log(code);
          console.log('Di WA nomor bot: Perangkat tertaut > Tautkan perangkat > Tautkan dengan nomor telepon.');
          console.log('Jika kode kedaluwarsa, Stop lalu Start untuk mencoba meminta kode baru.');
          console.log('Jangan kirim screenshot atau kode ini ke orang lain.\n');
        } catch (error) {
          hasAskedForPairing = false;
          console.error('Gagal mendapatkan kode pairing:', error.message);
        }
      }
    }
    if (update.connection === 'open') {
      B.waSender=async (event)=>{const c=loadConfig();if(activeSocket!==sock||!isGroupJid(c.groupId)||!sock.user?.id)throw Error('WA belum online/grup Store belum diatur');if(event.kind==='info'){const tag=event.tagAll===true;const ids=tag?memberJids(await sock.groupMetadata(c.groupId)):[];await sock.sendMessage(c.groupId,M.waContent(posts.waAnnouncement(event.body,ids,tag),event.media));return;}const pages=posts.promoPages(B.flatPromos(),B.allReservations(),postCatalog,{platform:'wa',onlyId:event.promoId});for(const p of pages)await sock.sendMessage(c.groupId,{text:p.title+'\n\n'+p.description});};
      console.log('✦ ORIVELA Starfall ONLINE!');
      console.log('✦ V5.0 | Store · Admin · Luckyverse | Promo · Announcement · Auto Open/Close');
      const c = loadConfig();
      console.log('Grup utama:', c.groupId || 'belum diaktifkan');
      console.log('Grup admin notif:', c.adminGroupId || 'belum diatur');
      console.log('Grup Luckyverse:', c.luckyverseGroupId || 'belum diatur; ketik .setluckyverse sebagai admin di grup game');
      console.log('Grup admin voucher:', voucherAdminGroup(c) || 'mengikuti grup admin order / belum diatur');
      flushPendingNotifications(sock).catch(e => console.error('Gagal mengirim notif tertunda:', e.message));
      flushProcessingNotifications(sock).catch(e => console.error('Gagal mengirim notif proses tertunda:', e.message));
      flushPendingVoucherNotifications(sock).catch(e => console.error('Gagal mengirim notifikasi voucher tertunda:', e.message));
      sweepPayments(sock,c).catch(e=>console.error('Payment watcher:',e.message));
      promos.tick(sock,c).catch(e=>console.error('Promo watcher:',e.message));
      startMiningWatcher(sock);
      startStoreSchedule(sock);
    }
    if (update.connection === 'close') {
      const reason = update.lastDisconnect?.error?.output?.statusCode;
      const loggedOut = reason === DisconnectReason.loggedOut;
      console.log('Koneksi terputus; reason =', reason ?? 'unknown');
      activeSocket = null; B.waSender=null;
      stopStoreSchedule();
      if (miningInterval) { clearInterval(miningInterval); miningInterval = null; }
      if (loggedOut) {
        console.error('Sesi telah logout. Jangan kirim file auth. Hubungkan ulang nomor bot secara aman.');
        return;
      }
      if (!retryHandle) {
        retryHandle = setTimeout(() => {
          retryHandle = null;
          const again=()=>connect().catch(e=>{console.error('Reconnect WA gagal:',e.message);retryHandle=setTimeout(()=>{retryHandle=null;again();},30000);});again();
        }, 5000);
      }
    }
  });
  sock.ev.on('messages.upsert', ({ type, messages }) => {
    if (activeSocket !== sock || type !== 'notify') return;
    for (const msg of messages || []) {
      handleCommand(sock, msg).catch(e => console.error('Gagal menangani pesan:', e.stack || e));
    }
  });
  sock.ev.on('group-participants.update', ({ id, participants, action }) => {
    if (activeSocket !== sock) return;
    if (action !== 'add' || !Array.isArray(participants) || !participants.length) return;
    const c = loadConfig();
    if (c.groupId === id && c.welcomeEnabled) {
      sendText(sock, id, texts.welcome).catch(e => console.error('Gagal kirim welcome grup utama:', e.message));
    }
    if (c.luckyverseGroupId === id && c.gameWelcomeEnabled) {
      const welcome = [
        '✨ *SELAMAT DATANG DI ORIVELA LUCKYVERSE!* ✨',
        'Tempat main mini-games dan mengumpulkan koin virtual.',
        '',
        '🎮 .games - Lihat daftar permainan',
        '🪙 .balance - Cek saldo koin',
        '👤 .profile - Lihat profil pemain',
        '⛏️ .mine - Mulai menambang',
        '🎟️ .voucher - Lihat pilihan penukaran voucher',
        '',
        'Baca petunjuk setiap game sebelum bermain. Koin hanya berlaku di dalam game.'
      ].join('\n');
      sendText(sock, id, welcome).catch(e => console.error('Gagal kirim welcome Luckyverse:', e.message));
    }
  });
}

if (require.main === module) {
  connect().catch(err => {
    console.error('Bot gagal dijalankan:', err.stack || err);
    process.exitCode = 1;
  });
}
B.wa={orders,promos,game:luckyverse,loadConfig,discordOrderAction,adminLocks,adminOrderMessage};
module.exports = { performDiscordOrderAction,actualBuyer,forwardOrderReply, connect, loadConfig, getText, localId, IDsForParticipant, phoneFromJid, handleCommand, AdminLocks, adminLocks, orders, resolveOrderReference, luckyverse, voucherPrivateMessage, voucherAdminMessage, resolvePrivateJid, promos, sweepPayments, paymentDue, jakartaClock, storeIsOpen, startStoreSchedule, stopStoreSchedule, handleStoreClosedReminder };
