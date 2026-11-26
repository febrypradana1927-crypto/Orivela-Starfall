'use strict';

// Orivela Luckyverse game engine for the existing ORIVELA Starfall Baileys bot.
// No new npm dependency is required. All balances are virtual in-game coins only.
const fs = require('node:fs');
const path = require('node:path');
const { randomInt, randomBytes } = require('node:crypto');

const DAY = 24 * 60 * 60 * 1000;
const ENERGY_MAX = 20;
const ENERGY_INTERVAL = 3 * 1000;
const MIN_BET = 1;
const MAX_BET = 200000;
const MINING_DURATION = 30 * 1000;
const COMMAND_COOLDOWN = 5 * 1000;
const VOUCHER_VALIDITY = 5 * DAY;
const VOUCHER_TIERS = {
  5000: { discount: 5000, cost: 5000000 },
  10000: { discount: 10000, cost: 9500000 },
  15000: { discount: 15000, cost: 14000000 }
};

const ITEMS = {
  stone:   { name: 'Stone', emoji: '🪨', price: 1 },
  coal:    { name: 'Coal', emoji: '⚫', price: 3 },
  copper:  { name: 'Copper', emoji: '🟠', price: 5 },
  iron:    { name: 'Iron', emoji: '⚙️', price: 10 },
  silver:  { name: 'Silver', emoji: '🥈', price: 18 },
  gold:    { name: 'Gold Ore', emoji: '🟡', price: 35 },
  ruby:    { name: 'Ruby', emoji: '❤️', price: 80 },
  emerald: { name: 'Emerald', emoji: '💚', price: 120 },
  diamond: { name: 'Diamond', emoji: '💎', price: 250 }
};

const ITEM_ALIASES = {
  stone: 'stone', batu: 'stone', coal: 'coal', batubara: 'coal',
  copper: 'copper', tembaga: 'copper', iron: 'iron', besi: 'iron',
  silver: 'silver', perak: 'silver', gold: 'gold', emas: 'gold',
  ruby: 'ruby', rubi: 'ruby', emerald: 'emerald', zamrud: 'emerald',
  diamond: 'diamond', berlian: 'diamond'
};

const PICKAXES = {
  wooden: { name: 'Wooden Pickaxe', tier: 1, maxDurability: 20, price: 0, requires: {} },
  stone:  { name: 'Stone Pickaxe', tier: 2, maxDurability: 40, price: 1000, requires: { stone: 100 } },
  iron:   { name: 'Iron Pickaxe', tier: 3, maxDurability: 80, price: 5000, requires: { coal: 30, copper: 25 } },
  gold:   { name: 'Gold Pickaxe', tier: 4, maxDurability: 150, price: 15000, requires: { iron: 30, silver: 20 } },
  crystal:{ name: 'Crystal Pickaxe', tier: 5, maxDurability: 300, price: 50000, requires: { gold: 25, ruby: 15 } }
};
const PICKAXE_ORDER = ['wooden', 'stone', 'iron', 'gold', 'crystal'];

const AREAS = {
  stone: { name: 'Stone Mine', minTier: 1, description: 'Mineral dasar dan batu umum.' },
  deep: { name: 'Deep Mine', minTier: 2, description: 'Peluang lebih baik untuk besi dan perak.' },
  crystal: { name: 'Crystal Cave', minTier: 4, description: 'Area langka untuk emas dan permata.' }
};
const AREA_ALIASES = { stone: 'stone', batu: 'stone', deep: 'deep', dalam: 'deep', crystal: 'crystal', kristal: 'crystal' };

const WORDS = [
  ['KOMPUTER', 'Perangkat untuk mengolah data'], ['MATAHARI', 'Bintang pusat tata surya kita'],
  ['PELANGI', 'Muncul dengan warna-warni setelah hujan'], ['KUCING', 'Hewan peliharaan yang suka mengeong'],
  ['SEKOLAH', 'Tempat belajar para siswa'], ['JENDELA', 'Bagian rumah untuk melihat ke luar'],
  ['PISANG', 'Buah berwarna kuning saat matang'], ['BINTANG', 'Benda langit yang tampak bercahaya'],
  ['KELINCI', 'Hewan bertelinga panjang'], ['SAMUDRA', 'Laut yang sangat luas'],
  ['KAMERA', 'Alat untuk mengambil foto'], ['GITAR', 'Alat musik yang dimainkan dengan dipetik'],
  ['LENTERA', 'Alat penerangan tradisional'], ['KEMBANG', 'Sinonim dari bunga'],
  ['ANGKASA', 'Ruang luas di luar atmosfer bumi'], ['SEPATU', 'Dipakai untuk melindungi kaki'],
  ['BULAN', 'Satelit alami bumi'], ['PANTAI', 'Tempat bertemunya daratan dan laut'],
  ['KELAPA', 'Buah yang airnya sering diminum'], ['MERPATI', 'Jenis burung yang sering berwarna putih'],
  ['KERTAS', 'Bahan untuk menulis atau menggambar'], ['PAYUNG', 'Digunakan saat hujan'],
  ['JAGUNG', 'Bahan pangan dengan biji pada tongkol'], ['LEMARI', 'Tempat menyimpan pakaian atau barang'],
  ['GUNUNG', 'Daratan tinggi yang menjulang'], ['BATERAI', 'Sumber energi untuk banyak perangkat'],
  ['COKELAT', 'Makanan yang dibuat dari kakao'], ['KOMPAS', 'Alat penunjuk arah'],
  ['KAMERA', 'Alat untuk mengambil gambar'], ['MELATI', 'Bunga putih yang harum']
];

const SLOT_SYMBOLS = [
  { symbol: '🍒', weight: 30, multiplier: 1.5, label: 'Cherry' },
  { symbol: '🍋', weight: 25, multiplier: 2, label: 'Lemon' },
  { symbol: '🍀', weight: 20, multiplier: 2.5, label: 'Clover' },
  { symbol: '🔔', weight: 12, multiplier: 3.5, label: 'Bell' },
  { symbol: '⭐', weight: 7, multiplier: 5, label: 'Star' },
  { symbol: '💎', weight: 4, multiplier: 8, label: 'Diamond' },
  { symbol: '7️⃣', weight: 2, multiplier: 12, label: 'Lucky Seven' }
];

function safeName(name) {
  const value = String(name || 'Pemain').replace(/[\r\n\u0000-\u001f]/g, ' ').trim().slice(0, 40);
  return value || 'Pemain';
}
function fmt(value) { return Number(value || 0).toLocaleString('id-ID'); }
function randomItem(list) { return list[randomInt(0, list.length)]; }
function xpThreshold(level) { return 50 * (level - 1) * level; }
function levelInfo(xp) {
  let level = 1;
  while (xp >= xpThreshold(level + 1)) level++;
  const progress = xp - xpThreshold(level);
  const needed = level * 100;
  return { level, progress, needed };
}
function scramble(word) {
  const chars = word.split('');
  if (chars.length < 2) return word;
  for (let attempt = 0; attempt < 10; attempt++) {
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(0, i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    const result = chars.join('');
    if (result !== word) return result;
  }
  return word.split('').reverse().join('');
}
function weightedSlotSymbol() {
  let roll = randomInt(1, 101);
  for (const item of SLOT_SYMBOLS) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return SLOT_SYMBOLS[0];
}
function rollOre(area) {
  const roll = randomInt(1, 1001);
  const tables = {
    stone: [
      [405, null], [650, 'coal'], [810, 'copper'], [910, 'iron'],
      [960, 'silver'], [985, 'gold'], [993, 'ruby'], [997, 'emerald'], [1000, 'diamond']
    ],
    deep: [
      [260, null], [440, 'coal'], [620, 'copper'], [790, 'iron'],
      [890, 'silver'], [940, 'gold'], [970, 'ruby'], [988, 'emerald'], [1000, 'diamond']
    ],
    crystal: [
      [160, null], [240, 'coal'], [340, 'copper'], [460, 'iron'],
      [600, 'silver'], [750, 'gold'], [860, 'ruby'], [940, 'emerald'], [1000, 'diamond']
    ]
  };
  return (tables[area] || tables.stone).find(([limit]) => roll <= limit)?.[1] ?? null;
}

class LuckyverseGame {
  constructor(filePath) {
    this.filePath = filePath;
    this.file = filePath;
    this.sessions = new Map();
    this.cooldowns = new Map();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!parsed || parsed.version !== 1 || !parsed.players || typeof parsed.players !== 'object') {
        throw new Error('data/luckyverse.json tidak valid. Jangan ditimpa; pulihkan dari backup.');
      }
      this.data = parsed;
      // Preserve existing player IDs and balances; bridge V4.1's shorter player schema.
      for (const [id, p] of Object.entries(this.data.players)) {
        p.id ||= id;
        for (const key of ['gamesPlayed', 'gamesWon', 'totalMined']) {
          if (!Number.isSafeInteger(p[key])) p[key] = 0;
        }
        if (p.pickaxe === 'wood') p.pickaxe = 'wooden';
        if (p.pickaxe === 'diamond') p.pickaxe = 'crystal';
        if (typeof p.lastDaily === 'number') p.lastDaily = p.lastDaily > 0 ? new Date(p.lastDaily).toISOString() : null;
        if (p.miningJob?.status === 'pending') {
          p.miningJob.area ||= p.area || 'stone';
          p.miningJob.pickaxe ||= p.pickaxe || 'wooden';
        }
        this.getPlayer(id, p.name);
      }
      if (!this.data.vouchers || typeof this.data.vouchers !== 'object' || Array.isArray(this.data.vouchers)) {
        this.data.vouchers = {};
        this.save();
      }
    } else {
      this.data = { version: 1, players: {}, vouchers: {} };
      this.save();
    }
  }

  save() {
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  getPlayer(userId, displayName) {
    const rawId = String(userId || '').trim();
    const id = Object.hasOwn(this.data.players, rawId) ? rawId : rawId.replace(/:\d+@/, '@');
    if (!id) throw new Error('ID pemain tidak tersedia.');
    let player = this.data.players[id];
    if (!player) {
      const now = Date.now();
      player = this.data.players[id] = {
        id,
        name: safeName(displayName),
        balance: 250,
        xp: 0,
        items: { stone: 10 },
        pickaxe: 'wooden',
        durability: PICKAXES.wooden.maxDurability,
        energy: ENERGY_MAX,
        energyUpdatedAt: now,
        lastDaily: null,
        area: 'stone',
        gamesPlayed: 0,
        gamesWon: 0,
        totalMined: 0,
        miningJob: null,
        createdAt: new Date(now).toISOString()
      };
      this.save();
    } else {
      player.name = safeName(displayName || player.name);
      player.items ||= {};
      player.balance = Number.isSafeInteger(player.balance) ? player.balance : 0;
      player.xp = Number.isSafeInteger(player.xp) ? player.xp : 0;
      player.pickaxe = PICKAXES[player.pickaxe] ? player.pickaxe : 'wooden';
      player.durability = Number.isSafeInteger(player.durability) ? player.durability : PICKAXES[player.pickaxe].maxDurability;
      player.energy = Number.isSafeInteger(player.energy) ? Math.max(0, Math.min(ENERGY_MAX, player.energy)) : ENERGY_MAX;
      player.energyUpdatedAt = Number.isFinite(player.energyUpdatedAt) ? player.energyUpdatedAt : Date.now();
      player.area = AREAS[player.area] ? player.area : 'stone';
      if (!Object.prototype.hasOwnProperty.call(player, 'miningJob')) player.miningJob = null;
    }
    return player;
  }

  findPlayersByIdentifier(identifier) {
    const raw = String(identifier || '').trim();
    if (!raw) return [];

    const normalizeId = (value) => String(value || '')
      .trim()
      .replace(/^@/, '')
      .split(':')[0]
      .replace(/@(s\.whatsapp\.net|c\.us|lid)$/i, '')
      .replace(/[^0-9]/g, '');

    const token = raw.replace(/^@/, '');
    const targetDigits = normalizeId(token);
    const found = new Set();

    for (const [key, candidate] of Object.entries(this.data.players)) {
      const storedId = String(candidate.id || key).trim();
      const exactMatch = storedId === raw || storedId === token || key === raw || key === token;
      const digitMatch = targetDigits && normalizeId(storedId) === targetDigits;
      if (exactMatch || digitMatch) found.add(candidate);
    }

    return [...found];
  }

  addXp(player, amount) {
    const oldLevel = levelInfo(player.xp).level;
    player.xp += amount;
    const newLevel = levelInfo(player.xp).level;
    let message = `✨ XP +${amount}`;
    if (newLevel > oldLevel) {
      const bonus = (newLevel - oldLevel) * 50;
      player.balance += bonus;
      message += `\n🎉 LEVEL UP! Kamu sekarang Level ${newLevel} dan mendapat bonus ${fmt(bonus)} koin!`;
    }
    return message;
  }

  regenerateEnergy(player, now = Date.now()) {
    if (player.energy >= ENERGY_MAX) {
      player.energy = ENERGY_MAX;
      player.energyUpdatedAt = now;
      return;
    }
    const elapsed = Math.max(0, now - player.energyUpdatedAt);
    const gained = Math.floor(elapsed / ENERGY_INTERVAL);
    if (gained > 0) {
      player.energy = Math.min(ENERGY_MAX, player.energy + gained);
      player.energyUpdatedAt += gained * ENERGY_INTERVAL;
      if (player.energy >= ENERGY_MAX) player.energyUpdatedAt = now;
    }
  }

  checkCooldown(userId, commandKey, now = Date.now()) {
    const key = `${String(userId || '')}:${commandKey}`;
    const until = this.cooldowns.get(key) || 0;
    if (until > now) {
      const seconds = Math.max(1, Math.ceil((until - now) / 1000));
      return `⏳ Cooldown aktif. Tunggu ${seconds} detik sebelum memakai perintah ini lagi.`;
    }
    this.cooldowns.set(key, now + COMMAND_COOLDOWN);
    return null;
  }

  createVoucherSerial() {
    let serial;
    do {
      serial = `ORV-${randomBytes(8).toString('hex').toUpperCase()}`;
    } while (this.data.vouchers[serial]);
    return serial;
  }

  cfg() {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(this.filePath), '..', 'config.json'), 'utf8'));
  }

  orderReservation(serial) {
    const file = path.join(path.dirname(this.filePath), 'orders.json');
    if (!fs.existsSync(file)) return require('../shared').dcTickets().find(t=>t.voucher===serial&&!['cancelled','expired'].includes(t.status)) || null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data.orders)) throw new Error('Database order tidak valid; voucher tidak dapat diperiksa.');
    return data.orders.find(o => o.voucher === serial && !o.cancelledAt) || require('../shared').dcTickets().find(t=>t.voucher===serial&&!['cancelled','expired'].includes(t.status)) || null;
  }

  redeemVoucher(userId, displayName, discount, requestId, callNumber) {
    if (this.cfg().voucherRedemptionEnabled !== true) return { error: 'Penukaran voucher belum diaktifkan admin. Koin tidak dipotong.' };
    const tier = VOUCHER_TIERS[Number(discount)];
    if (!tier) {
      return { error: 'Pilihan voucher tidak valid. Gunakan .voucher 5000, .voucher 10000, atau .voucher 15000.' };
    }

    const requestKey = String(requestId || '').trim();
    if (requestKey) {
      const existing = Object.values(this.data.vouchers).find(v => v.requestId === requestKey) || this.data.vouchers[this.data.requests?.[requestKey]];
      if (existing) return { duplicate: true, voucher: existing };
    }

    const player = this.getPlayer(userId, displayName);
    if (player.balance < tier.cost) {
      return {
        error: `Koin belum cukup untuk voucher Rp${fmt(tier.discount)}.
Biaya: ${fmt(tier.cost)} koin
Saldo kamu: ${fmt(player.balance)} koin.`
      };
    }

    const now = Date.now();
    const serial = this.createVoucherSerial();
    const voucher = {
      serial,
      ownerId: String(player.id),
      ownerName: player.name,
      callNumber: String(callNumber || 'Tidak tersedia'),
      discount: tier.discount,
      cost: tier.cost,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + VOUCHER_VALIDITY).toISOString(),
      status: 'active',
      requestId: requestKey || null,
      dmSentAt: null,
      adminNotifiedAt: null,
      redeemedAt: null,
      redeemedBy: null
    };

    const previousBalance = player.balance;
    player.balance -= tier.cost;
    this.data.vouchers[serial] = voucher;
    try {
      this.save();
    } catch (error) {
      player.balance = previousBalance;
      delete this.data.vouchers[serial];
      return { error: 'Penukaran gagal disimpan. Saldo tidak berubah. Coba lagi nanti.' };
    }
    return { voucher, balance: player.balance, cost: tier.cost };
  }

  markVoucherDmSent(serial) {
    const voucher = this.data.vouchers[String(serial || '').trim().toUpperCase()];
    if (!voucher || voucher.status !== 'active') return false;
    voucher.dmSentAt = new Date().toISOString();
    this.save();
    return true;
  }

  cancelVoucherAndRefund(serial) {
    const voucher = this.data.vouchers[String(serial || '').trim().toUpperCase()];
    if (!voucher || voucher.status !== 'active' || voucher.dmSentAt || voucher.dmSent || this.orderReservation(voucher.serial)) return false;
    const player = this.data.players[voucher.ownerId];
    if (!player) return false;
    player.balance += voucher.cost;
    voucher.status = 'cancelled';
    voucher.cancelledAt = new Date().toISOString();
    voucher.cancelReason = 'DM delivery failed';
    this.save();
    return true;
  }

  pendingVoucherNotifications() {
    return Object.values(this.data.vouchers).filter(v =>
      v.status === 'active' && (v.dmSentAt || v.dmSent) && !v.adminNotifiedAt && !v.adminNotified
    );
  }

  markVoucherAdminNotified(serial) {
    const voucher = this.data.vouchers[String(serial || '').trim().toUpperCase()];
    if (!voucher || voucher.status !== 'active' || !(voucher.dmSentAt || voucher.dmSent)) return false;
    voucher.adminNotifiedAt = new Date().toISOString();
    this.save();
    return true;
  }

  getVoucher(serial) {
    const key = String(serial || '').trim().toUpperCase();
    const voucher = this.data.vouchers[key];
    if (!voucher) return { error: 'Kode voucher tidak ditemukan.' };
    const order = this.orderReservation(key);
    if (order) return { voucher: { ...voucher, status: order.paidAt ? 'used' : 'reserved', orderId: order.id } };
    if (voucher.status === 'redeemed' || voucher.status === 'used') return { voucher: { ...voucher, status: 'used' } };
    if (voucher.status === 'active' && Date.now() >= Date.parse(voucher.expiresAt)) {
      voucher.status = 'expired';
      voucher.expiredAt = new Date().toISOString();
      this.save();
    }
    return { voucher };
  }

  markVoucherRedeemed(serial, adminName) {
    const result = this.getVoucher(serial);
    if (result.error) return result;
    const voucher = result.voucher;
    if (voucher.status === 'expired') return { error: 'Voucher sudah kedaluwarsa.' };
    if (voucher.status === 'used' || voucher.status === 'redeemed') return { error: 'Voucher ini sudah pernah digunakan.' };
    if (voucher.status !== 'active') return { error: `Voucher tidak aktif. Status: ${voucher.status}.` };
    voucher.status = 'redeemed';
    voucher.redeemedAt = new Date().toISOString();
    voucher.redeemedBy = safeName(adminName);
    this.save();
    return { voucher };
  }

  completeMining(userId) {
    const player = this.data.players[String(userId || '')];
    const job = player && player.miningJob;
    if (!player || !job || job.status !== 'pending' || Date.now() < Number(job.finishAt)) return null;

    const ranges = {
      stone: {
        stone: [300, 600], coal: [100, 220], copper: [60, 120], iron: [25, 60],
        silver: [10, 25], gold: [3, 10], ruby: [1, 4], emerald: [0, 2], diamond: [0, 1]
      },
      deep: {
        stone: [250, 500], coal: [120, 250], copper: [80, 160], iron: [50, 100],
        silver: [25, 60], gold: [10, 25], ruby: [3, 8], emerald: [1, 4], diamond: [0, 2]
      },
      crystal: {
        stone: [200, 400], coal: [80, 160], copper: [70, 140], iron: [60, 120],
        silver: [40, 80], gold: [20, 45], ruby: [8, 20], emerald: [4, 12], diamond: [1, 4]
      }
    };
    const areaKey = AREAS[job.area] ? job.area : 'stone';
    const area = AREAS[areaKey];
    const toolKey = PICKAXES[job.pickaxe] ? job.pickaxe : 'wooden';
    const tool = PICKAXES[toolKey];
    const multiplier = 1 + Math.max(0, tool.tier - 1) * 0.1;
    const found = [];
    let totalValue = 0;

    for (const [key, [min, max]] of Object.entries(ranges[areaKey])) {
      const base = randomInt(min, max + 1);
      const qty = Math.floor(base * multiplier);
      if (qty <= 0) continue;
      player.items[key] = (player.items[key] || 0) + qty;
      const value = qty * ITEMS[key].price;
      totalValue += value;
      found.push(`${ITEMS[key].emoji} ${ITEMS[key].name} ×${fmt(qty)} (nilai jual ${fmt(value)})`);
    }
    player.totalMined++;
    const xpMessage = this.addXp(player, 10);
    job.status = 'ready';
    job.completedAt = new Date().toISOString();
    job.resultText = [
      `⛏️ *MINING SELESAI · ${area.name.toUpperCase()}*`,
      `Alat: ${tool.name}`,
      '',
      ...found,
      '',
      `💰 Estimasi nilai jual hasil: ${fmt(totalValue)} koin`,
      xpMessage,
      `⚡ Energy: ${player.energy}/${ENERGY_MAX}`,
      `🛠️ Durability: ${player.durability}/${tool.maxDurability}`,
      `🪙 Saldo: ${fmt(player.balance)} koin`,
      '',
      'Hasil sudah masuk inventory. Jual semua dengan .sell all atau atur jumlah, contoh .sell iron 20.'
    ].join('\n');
    this.save();
    return { userId: String(userId), chatId: job.chatId, mentionJid: job.mentionJid, message: job.resultText };
  }

  markMiningNotified(userId) {
    const player = this.data.players[String(userId || '')];
    if (!player || !player.miningJob || player.miningJob.status !== 'ready') return false;
    player.miningJob = null;
    this.save();
    return true;
  }

  help() {
    return [
      '✦ ORIVELA LUCKYVERSE ✦',
      'Game koin virtual ORIVELA Starfall.',
      '',
      '🧩 SUSUN KATA',
      '.susunkata - Hadiah 15 koin, cooldown 5 detik',
      '',
      '⛏️ MINING SIMULATOR',
      '.mine - Mulai mining, hasil keluar setelah 30 detik',
      '.mining - Status tambang dan alat',
      '.minearea - Lihat area tambang',
      '.minearea deep / crystal - Pindah area',
      '.inventory - Lihat mineral',
      '.sell all - Jual semua mineral',
      '.sell iron 5 - Jual 5 iron',
      '.upgrade - Upgrade pickaxe',
      '.repair - Perbaiki pickaxe',
      '.shop - Lihat biaya upgrade',
      '',
      '🪙 LUCK GAMES',
      '.coinflip gambar 50 - Tebak gambar',
      '.coinflip angka 50 - Tebak angka',
      '.coins gambar 50 - Alias perintah coinflip',
      '.slots 50 - Putar slot machine',
      'Coinflip dan slot memiliki cooldown 5 detik.',
      '',
      '🎟️ TUKAR KOIN KE VOUCHER',
      '.voucher - Lihat pilihan voucher',
      '.voucher 5000 - Tukar 5.000.000 koin ke voucher Rp5.000',
      '.voucher 10000 - Tukar 9.500.000 koin ke voucher Rp10.000',
      '.voucher 15000 - Tukar 14.000.000 koin ke voucher Rp15.000',
      'Voucher dikirim ke chat pribadi dan berlaku 5 hari.',
      '',
      '👤 AKUN',
      '.balance - Cek saldo',
      '.give @nomor 100 - Transfer 100 koin ke pemain lain',
      '.profile - Profil pemain',
      '.daily - Hadiah harian',
      '.leaderboard - Peringkat pemain',
      '.games - Tampilkan daftar perintah',
      '',
      'Koin hanya berlaku di Luckyverse. Voucher berlaku satu kali untuk satu item dan tidak dapat diuangkan.'
    ].join('\n');
  }

  handleText(userId, displayName, raw) {
    userId = String(userId || '').replace(/:\d+@/, '@');
    const session = this.sessions.get(String(userId || ''));
    if (!session) return null;
    const player = this.getPlayer(userId, displayName);
    const now = Date.now();
    if (now > session.expiresAt) {
      this.sessions.delete(String(userId));
      return `⌛ Waktu Susun Kata habis! Jawabannya: *${session.answer}*. Ketik .susunkata untuk main lagi.`;
    }
    const answer = String(raw || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
    if (!answer) return null;
    if (answer === session.answer) {
      this.sessions.delete(String(userId));
      player.balance += session.reward;
      player.gamesPlayed++;
      player.gamesWon++;
      const xpMessage = this.addXp(player, 25);
      this.save();
      return `🎉 BENAR BANGET!\nJawaban: *${session.answer}*\n🪙 Hadiah: +${fmt(session.reward)} koin\n${xpMessage}\nSaldo: ${fmt(player.balance)} koin\nKetik .susunkata untuk ronde berikutnya.`;
    }
    session.attempts--;
    if (session.attempts <= 0) {
      this.sessions.delete(String(userId));
      player.gamesPlayed++;
      this.save();
      return `😵 Kesempatan habis! Jawabannya *${session.answer}*. Tidak ada koin yang dipotong. Coba lagi dengan .susunkata.`;
    }
    return `Belum tepat 😼 Coba lagi! Sisa kesempatan: ${session.attempts}. Petunjuk: ${session.hint}`;
  }

  handleCommand(userId, displayName, command, args = [], context = {}) {
    userId = String(userId || '').replace(/:\d+@/, '@');
    const cmd = String(command || '').toLowerCase();
    const player = this.getPlayer(userId, displayName);
    const argText = args.join(' ').trim();

    if (['games', 'game', 'help', 'helpgame', 'menu'].includes(cmd)) return this.help();
    if (cmd === 'voucher' || cmd === 'tukervoucher' || cmd === 'redeemvoucher') {
      if (!args[0]) {
        return [
          '🎟️ *ORIVELA STARFALL VOUCHER*',
          '5.000.000 koin → potongan Rp5.000',
          '9.500.000 koin → potongan Rp10.000',
          '14.000.000 koin → potongan Rp15.000',
          '',
          'Gunakan .voucher 5000, .voucher 10000, atau .voucher 15000.',
          'Voucher dikirim ke chat pribadi dan berlaku 5 hari.',
          this.cfg().voucherRedemptionEnabled === true ? '' : 'Penukaran belum diaktifkan admin.'
        ].join('\n');
      }
      return 'Penukaran voucher perlu dilakukan melalui pengiriman chat pribadi. Gunakan perintah .voucher 5000, .voucher 10000, atau .voucher 15000 di grup ORIVELA Luckyverse.';
    }

    if (cmd === 'give') {
      if (args.length < 2) {
        return [
          '💸 *GIVE COIN · ORIVELA LUCKYVERSE*',
          'Cara pakai: .give @nomor jumlah',
          'Contoh: .give @628123456789 100',
          'Penerima harus sudah terdaftar di Luckyverse.'
        ].join('\n');
      }

      const recipientToken = String(args[0] || '').trim();
      const amountText = String(args[1] || '').replace(/[,_]/g, '');
      const amount = Number(amountText);

      if (!recipientToken) return 'Tentukan penerima. Contoh: .give @628123456789 100.';
      if (!/^\d+$/.test(amountText) || !Number.isSafeInteger(amount) || amount <= 0) {
        return 'Jumlah koin harus bilangan bulat positif. Contoh: .give @628123456789 100.';
      }

      const matches = context.platform === 'dc' ? [this.data.players[recipientToken]].filter(Boolean) : this.findPlayersByIdentifier(recipientToken).filter(p=>!String(p.id).startsWith('dc-'));
      if (matches.length === 0) {
        return 'Penerima belum ditemukan. Pastikan dia sudah pernah memakai game Luckyverse dan gunakan nomor yang terdaftar.';
      }
      if (matches.length > 1) {
        return 'Nomor penerima cocok dengan lebih dari satu akun. Minta admin memastikan ID pemain yang benar.';
      }

      const recipient = matches[0];
      const senderId = String(player.id || userId || '').trim();
      const recipientId = String(recipient.id || '').trim();
      const normalizeForCompare = (value) => String(value || '')
        .trim()
        .replace(/^@/, '')
        .split(':')[0]
        .replace(/@(s\.whatsapp\.net|c\.us|lid)$/i, '')
        .replace(/[^0-9]/g, '');

      if (recipient === player || recipientId === senderId ||
          (normalizeForCompare(senderId) && normalizeForCompare(senderId) === normalizeForCompare(recipientId))) {
        return 'Kamu tidak bisa mengirim koin ke akun sendiri.';
      }
      if (!Number.isSafeInteger(player.balance) || player.balance < amount) {
        return `Saldo kamu tidak cukup. Saldo saat ini: ${fmt(player.balance)} koin.`;
      }
      if (!Number.isSafeInteger(recipient.balance) || recipient.balance < 0 ||
          !Number.isSafeInteger(recipient.balance + amount)) {
        return 'Saldo penerima tidak valid untuk transfer ini. Hubungi admin.';
      }

      const senderBalanceBefore = player.balance;
      const recipientBalanceBefore = recipient.balance;
      player.balance -= amount;
      recipient.balance += amount;

      try {
        this.save();
      } catch (error) {
        player.balance = senderBalanceBefore;
        recipient.balance = recipientBalanceBefore;
        return 'Transfer gagal disimpan. Saldo tidak diubah. Coba lagi nanti.';
      }

      return [
        '💸 *GIVE BERHASIL!*',
        `Pengirim: ${player.name}`,
        `Penerima: ${recipient.name}`,
        `Jumlah dikirim: ${fmt(amount)} koin`,
        `Saldo kamu: ${fmt(player.balance)} koin`
      ].join('\n');
    }

    if (['balance', 'bal', 'saldo'].includes(cmd)) {
      this.save();
      return `🪙 *ORIVELA BALANCE*\n${player.name}\nSaldo: *${fmt(player.balance)} koin*\nKoin hanya berlaku di dalam game.`;
    }

    if (['profile', 'profil', 'me'].includes(cmd)) {
      this.regenerateEnergy(player);
      const lv = levelInfo(player.xp);
      const tool = PICKAXES[player.pickaxe];
      this.save();
      return [
        '✦ PLAYER PROFILE ✦',
        `👤 Nama: ${player.name}`,
        `⭐ Level: ${lv.level} (${lv.progress}/${lv.needed} XP)`,
        `✨ Total XP: ${fmt(player.xp)}`,
        `🪙 Balance: ${fmt(player.balance)} koin`,
        `⛏️ Pickaxe: ${tool.name}`,
        `🛠️ Durability: ${player.durability}/${tool.maxDurability}`,
        `⚡ Energy: ${player.energy}/${ENERGY_MAX}`,
        `🎮 Game dimainkan: ${fmt(player.gamesPlayed)}`,
        `🏆 Kemenangan: ${fmt(player.gamesWon)}`,
        `🪨 Total menambang: ${fmt(player.totalMined)}`
      ].join('\n');
    }

    if (cmd === 'daily') {
      const now = Date.now();
      if (player.lastDaily && now - Date.parse(player.lastDaily) < DAY) {
        const remaining = DAY - (now - Date.parse(player.lastDaily));
        const hours = Math.floor(remaining / 3600000);
        const minutes = Math.ceil((remaining % 3600000) / 60000);
        return `🎁 Daily sudah diklaim! Coba lagi dalam ${hours} jam ${minutes} menit.`;
      }
      player.lastDaily = new Date(now).toISOString();
      player.balance += 100;
      player.energy = ENERGY_MAX;
      player.energyUpdatedAt = now;
      const xpMessage = this.addXp(player, 10);
      this.save();
      return `🎁 *DAILY REWARD*\n🪙 +100 koin\n⚡ Energy dipulihkan ke ${ENERGY_MAX}/${ENERGY_MAX}\n${xpMessage}\nSaldo sekarang: ${fmt(player.balance)} koin.`;
    }

    if (cmd === 'leaderboard' || cmd === 'rank') {
      const entries = Object.values(this.data.players)
        .filter(p=>context.platform==='dc' ? (String(p.id).startsWith('dc-')||context.linkedIds?.includes(p.id)) : !String(p.id).startsWith('dc-'))
        .sort((a, b) => levelInfo(b.xp).level - levelInfo(a.xp).level || b.xp - a.xp || b.balance - a.balance)
        .slice(0, 10);
      if (!entries.length) return 'Belum ada pemain. Ketik .games untuk memulai!';
      return ['🏆 *LUCKYVERSE LEADERBOARD*', ...entries.map((p, i) => {
        const lv = levelInfo(p.xp).level;
        const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
        return `${medal} ${p.name} · Lv.${lv} · ${fmt(p.xp)} XP`;
      })].join('\n');
    }

    if (cmd === 'susunkata' || cmd === 'wordmix') {
      if (args[0] && ['stop', 'batal', 'cancel'].includes(String(args[0]).toLowerCase())) {
        this.sessions.delete(String(userId));
        return 'Ronde Susun Kata dibatalkan. Ketik .susunkata untuk mulai lagi.';
      }
      const current = this.sessions.get(String(userId));
      if (current) return `Kamu masih punya ronde aktif!\nHuruf: *${current.scrambled}*\nPetunjuk: ${current.hint}\nSisa kesempatan: ${current.attempts}\nKetik .susunkata stop untuk membatalkan.`;
      const cooldown = this.checkCooldown(userId, 'susunkata');
      if (cooldown) return cooldown;
      const [answer, hint] = randomItem(WORDS);
      const reward = 15;
      const session = { answer, hint, scrambled: scramble(answer), reward, attempts: 3, expiresAt: Date.now() + 120000 };
      this.sessions.set(String(userId), session);
      return `🔤 *SUSUN KATA*\nSusun huruf berikut menjadi kata yang benar:\n\n✨ Huruf: *${session.scrambled}*\n💡 Petunjuk: ${hint}\n🎁 Hadiah: ${reward} koin + 25 XP\n⏳ Waktu: 2 menit\n🧩 Kesempatan: 3 kali\n\nKetik jawaban langsung di chat. Tidak perlu titik di depan jawaban!`;
    }

    if (cmd === 'balance' || cmd === 'profile' || cmd === 'daily') return null;

    if (cmd === 'mining' || cmd === 'mineinfo') {
      this.regenerateEnergy(player);
      const tool = PICKAXES[player.pickaxe];
      const area = AREAS[player.area];
      const lv = levelInfo(player.xp);
      this.save();
      return `⛏️ *MINING STATUS*\nArea: ${area.name}\nPickaxe: ${tool.name}\nDurability: ${player.durability}/${tool.maxDurability}\nEnergy: ${player.energy}/${ENERGY_MAX}\nLevel: ${lv.level}\nXP: ${player.xp}\nKetik .mine untuk menambang.`;
    }

    if (cmd === 'minearea' || cmd === 'area') {
      if (!argText) {
        const tier = PICKAXES[player.pickaxe].tier;
        return ['🗺️ *MINING AREAS*', ...Object.entries(AREAS).map(([key, area]) => {
          const unlocked = tier >= area.minTier;
          return `${unlocked ? '✅' : '🔒'} ${area.name} (${key}) · Butuh Pickaxe Tier ${area.minTier}${player.area === key ? ' · AKTIF' : ''}`;
        }), '', 'Pindah area: .minearea deep atau .minearea crystal'].join('\n');
      }
      const key = AREA_ALIASES[argText.toLowerCase()];
      if (!key || !AREAS[key]) return 'Area tidak dikenal. Pilih: stone, deep, atau crystal.';
      const area = AREAS[key];
      if (PICKAXES[player.pickaxe].tier < area.minTier) return `🔒 ${area.name} terkunci. Kamu membutuhkan Pickaxe Tier ${area.minTier}.`;
      player.area = key;
      this.save();
      return `🗺️ Area tambang aktif: *${area.name}*\n${area.description}\nKetik .mine untuk mulai menambang.`;
    }

    if (cmd === 'mine') {
      const now = Date.now();
      this.regenerateEnergy(player, now);
      if (player.miningJob) {
        if (player.miningJob.status === 'ready') {
          return '⛏️ Mining sudah selesai. Hasil sedang dikirim ke grup. Jangan mulai mining baru dulu.';
        }
        const remaining = Math.max(0, Number(player.miningJob.finishAt) - now);
        if (remaining > 0) {
          return `⛏️ Mining masih berjalan. Hasil akan keluar dalam sekitar ${Math.ceil(remaining / 1000)} detik lagi.`;
        }
        this.completeMining(userId);
        return '⛏️ Waktu mining selesai. Hasil sedang diproses dan akan dikirim ke grup.';
      }

      const tool = PICKAXES[player.pickaxe];
      const area = AREAS[player.area];
      if (tool.tier < area.minTier) {
        player.area = 'stone';
        this.save();
        return 'Area ini terkunci untuk pickaxe kamu. Area dikembalikan ke Stone Mine.';
      }
      if (player.energy <= 0) {
        this.save();
        return '😮‍💨 Energi habis. Tunggu pemulihan energi atau klaim .daily.';
      }
      if (player.durability <= 0) {
        return `⛏️ Pickaxe rusak! Ketik .repair untuk memperbaikinya. Biaya perbaikan: ${20 + tool.tier * 10} koin.`;
      }

      player.energy--;
      player.durability--;
      player.miningJob = {
        status: 'pending',
        startedAt: now,
        finishAt: now + MINING_DURATION,
        area: player.area,
        pickaxe: player.pickaxe,
        chatId: String(context.chatId || ''),
        mentionJid: String(context.mentionJid || '') || null
      };
      this.save();
      return [
        '⛏️ *MINING DIMULAI!*',
        `Area: ${area.name}`,
        `Pickaxe: ${tool.name}`,
        '⏳ Durasi: 30 detik',
        '🎁 Kamu akan mendapat satu paket mineral dalam jumlah besar setelah waktu selesai.',
        'Hasil akan dikirim otomatis ke grup ini. Cek .inventory setelah mining selesai.'
      ].join('\n');
    }

    if (cmd === 'inventory' || cmd === 'inv' || cmd === 'bag') {
      const rows = Object.entries(ITEMS).map(([key, item]) => `${item.emoji} ${item.name}: ${fmt(player.items[key] || 0)}`);
      this.save();
      return ['🎒 *MINING INVENTORY*', ...rows, '', `⛏️ Alat: ${PICKAXES[player.pickaxe].name}`, `🪙 Balance: ${fmt(player.balance)} koin`].join('\n');
    }

    if (cmd === 'pickaxe' || cmd === 'tool') {
      const tool = PICKAXES[player.pickaxe];
      return `⛏️ *PICKAXE STATUS*\n${tool.name}\nTier: ${tool.tier}/5\nDurability: ${player.durability}/${tool.maxDurability}\nKetik .upgrade untuk upgrade atau .repair untuk perbaikan.`;
    }

    if (cmd === 'upgrade') {
      const currentIndex = PICKAXE_ORDER.indexOf(player.pickaxe);
      if (currentIndex >= PICKAXE_ORDER.length - 1) return '✨ Pickaxe kamu sudah di level maksimum: Crystal Pickaxe!';
      const nextKey = PICKAXE_ORDER[currentIndex + 1];
      const next = PICKAXES[nextKey];
      const missing = [];
      if (player.balance < next.price) missing.push(`koin ${fmt(next.price - player.balance)}`);
      for (const [item, qty] of Object.entries(next.requires)) {
        const have = player.items[item] || 0;
        if (have < qty) missing.push(`${ITEMS[item].name} ${qty - have}`);
      }
      if (missing.length) {
        const req = Object.entries(next.requires).map(([item, qty]) => `${ITEMS[item].emoji} ${ITEMS[item].name} ×${qty}`).join(', ') || 'tidak ada';
        return `🛠️ *UPGRADE PICKAXE*\nAlat berikutnya: ${next.name}\nBiaya: ${fmt(next.price)} koin + ${req}\nKamu masih membutuhkan: ${missing.join(', ')}.\n\nKetik .sell all untuk menjual mineral.`;
      }
      player.balance -= next.price;
      for (const [item, qty] of Object.entries(next.requires)) player.items[item] -= qty;
      player.pickaxe = nextKey;
      player.durability = next.maxDurability;
      this.save();
      return `🎉 *UPGRADE BERHASIL!*\nPickaxe baru: ${next.name}\nDurability: ${player.durability}/${next.maxDurability}\nKoin tersisa: ${fmt(player.balance)}\nArea baru mungkin sudah terbuka. Ketik .minearea untuk melihatnya.`;
    }

    if (cmd === 'repair') {
      const tool = PICKAXES[player.pickaxe];
      if (player.durability >= tool.maxDurability) return `✨ ${tool.name} masih dalam kondisi prima (${player.durability}/${tool.maxDurability}).`;
      const cost = 20 + tool.tier * 10;
      if (player.balance < cost) return `🛠️ Biaya perbaikan ${cost} koin. Saldo kamu ${fmt(player.balance)} koin; klaim .daily atau jual mineral dulu.`;
      player.balance -= cost;
      player.durability = tool.maxDurability;
      this.save();
      return `🔧 Pickaxe berhasil diperbaiki!\nDurability: ${player.durability}/${tool.maxDurability}\nBiaya: ${cost} koin\nSaldo: ${fmt(player.balance)} koin.`;
    }

    if (cmd === 'shop') {
      const currentIndex = PICKAXE_ORDER.indexOf(player.pickaxe);
      const rows = PICKAXE_ORDER.map((key, i) => {
        const tool = PICKAXES[key];
        const req = Object.entries(tool.requires).map(([item, qty]) => `${ITEMS[item].name} ×${qty}`).join(', ');
        const status = i < currentIndex ? '✅ dimiliki sebelumnya' : i === currentIndex ? '⭐ alat aktif' : '🔒 upgrade berikutnya';
        return `${status}\n${tool.name} · ${tool.maxDurability} durability · ${fmt(tool.price)} koin${req ? ` + ${req}` : ''}`;
      });
      return ['🏪 *MINING SHOP*', ...rows, '', `Perbaikan pickaxe: ${20 + PICKAXES[player.pickaxe].tier * 10} koin`, 'Untuk membeli upgrade berikutnya, ketik .upgrade.'].join('\n');
    }

    if (cmd === 'sell' || cmd === 'jual') {
      const itemArg = String(args[0] || 'all').toLowerCase();
      const quantityArg = args[1] === undefined ? null : Number(args[1]);
      const sellAll = ['all', 'semua'].includes(itemArg);
      const itemKey = ITEM_ALIASES[itemArg];
      if (!sellAll && !itemKey) return 'Mineral tidak dikenal. Contoh: .sell all atau .sell iron 5.';
      if (quantityArg !== null && (!Number.isSafeInteger(quantityArg) || quantityArg <= 0)) return 'Jumlah harus bilangan bulat positif. Contoh: .sell stone 10.';
      const toSell = {};
      if (sellAll) {
        for (const key of Object.keys(ITEMS)) if ((player.items[key] || 0) > 0) toSell[key] = player.items[key];
      } else {
        const available = player.items[itemKey] || 0;
        const qty = quantityArg === null ? available : quantityArg;
        if (qty > available) return `Kamu hanya punya ${fmt(available)} ${ITEMS[itemKey].name}.`;
        if (qty <= 0) return `Kamu belum punya ${ITEMS[itemKey].name} untuk dijual.`;
        toSell[itemKey] = qty;
      }
      const keys = Object.keys(toSell);
      if (!keys.length) return 'Inventory kamu belum punya mineral untuk dijual. Ketik .mine dulu!';
      let total = 0;
      const lines = [];
      for (const [key, qty] of Object.entries(toSell)) {
        const value = qty * ITEMS[key].price;
        player.items[key] -= qty;
        total += value;
        lines.push(`${ITEMS[key].emoji} ${ITEMS[key].name} ×${qty}: ${fmt(value)} koin`);
      }
      player.balance += total;
      this.save();
      return ['💰 *MINERAL SOLD*', ...lines, '', `Total diterima: *${fmt(total)} koin*`, `Saldo baru: ${fmt(player.balance)} koin`].join('\n');
    }

    if (cmd === 'coinflip' || cmd === 'flip' || cmd === 'coin' || cmd === 'coins') {
      if (args.length < 2) return '🪙 Cara main: .coinflip gambar 50 atau .coinflip angka 50\nTaruhan: 1–200.000 koin virtual.';
      let choice = String(args[0]).toLowerCase();
      let betText = args[1];
      if (/^\d+$/.test(choice) && args[1]) {
        betText = choice;
        choice = String(args[1]).toLowerCase();
      }
      const choices = { gambar: 'heads', heads: 'heads', head: 'heads', angka: 'tails', tails: 'tails', tail: 'tails' };
      if (!choices[choice]) return 'Pilih sisi koin: gambar atau angka. Contoh: .coinflip gambar 50';
      const bet = Number(betText);
      const validation = this.validateBet(player, bet);
      if (validation) return validation;
      const cooldown = this.checkCooldown(userId, 'coinflip');
      if (cooldown) return cooldown;
      player.balance -= bet;
      const result = randomInt(0, 2) === 0 ? 'heads' : 'tails';
      const won = choices[choice] === result;
      player.gamesPlayed++;
      let payout = 0;
      if (won) {
        payout = bet * 2;
        player.balance += payout;
        player.gamesWon++;
      }
      const xpMessage = this.addXp(player, 3);
      this.save();
      return [
        '🪙 *COINFLIP RESULT*',
        `Pilihanmu: ${choices[choice] === 'heads' ? 'GAMBAR' : 'ANGKA'}`,
        `Hasil koin: ${result === 'heads' ? '🖼️ GAMBAR' : '🔢 ANGKA'}`,
        won ? `🎉 Kamu menang! Hadiah total: ${fmt(payout)} koin.` : `🙈 Belum beruntung. Taruhan ${fmt(bet)} koin tidak kembali.`,
        xpMessage,
        `🪙 Saldo sekarang: ${fmt(player.balance)} koin`
      ].join('\n');
    }

    if (cmd === 'slots' || cmd === 'slot') {
      if (args.length < 1) return '🎰 Cara main: .slots 50\nTaruhan: 1–200.000 koin virtual.';
      const bet = Number(args[0]);
      const validation = this.validateBet(player, bet);
      if (validation) return validation;
      const cooldown = this.checkCooldown(userId, 'slots');
      if (cooldown) return cooldown;
      player.balance -= bet;
      const symbols = [weightedSlotSymbol(), weightedSlotSymbol(), weightedSlotSymbol()];
      const triple = symbols[0].symbol === symbols[1].symbol && symbols[1].symbol === symbols[2].symbol;
      const pair = !triple && (symbols[0].symbol === symbols[1].symbol || symbols[0].symbol === symbols[2].symbol || symbols[1].symbol === symbols[2].symbol);
      let multiplier = 0;
      let resultText = 'Tidak ada kombinasi. Coba lagi nanti!';
      if (triple) {
        multiplier = symbols[0].multiplier;
        resultText = `🎉 Tiga ${symbols[0].label}! Multiplier ×${multiplier}.`;
      } else if (pair) {
        multiplier = 1.25;
        resultText = '✨ Dua simbol cocok! Hadiah penghibur ×1,25.';
      }
      const payout = Math.floor(bet * multiplier);
      if (payout > 0) player.balance += payout;
      player.gamesPlayed++;
      if (payout > bet) player.gamesWon++;
      const xpMessage = this.addXp(player, 3);
      this.save();
      return [
        '🎰 *SLOT MACHINE*',
        `┏━━━━━━━━━━┓`,
        `┃  ${symbols.map(x => x.symbol).join('  │  ')}  ┃`,
        `┗━━━━━━━━━━┛`,
        resultText,
        payout > 0 ? `💰 Hadiah total: ${fmt(payout)} koin.` : `🪙 Taruhan ${fmt(bet)} koin tidak kembali.`,
        xpMessage,
        `🪙 Saldo sekarang: ${fmt(player.balance)} koin`
      ].join('\n');
    }

    return null;
  }

  validateBet(player, bet) {
    if (!Number.isSafeInteger(bet) || bet < MIN_BET || bet > MAX_BET) return `Taruhan harus antara ${MIN_BET} dan ${fmt(MAX_BET)} koin virtual.`;
    if (bet > player.balance) return `Saldo tidak cukup! Saldo kamu ${fmt(player.balance)} koin. Ketik .daily atau main game lain untuk mengumpulkan koin.`;
    return null;
  }
}

module.exports = { LuckyverseGame, ITEMS, PICKAXES, AREAS, VOUCHER_TIERS, VOUCHER_VALIDITY, MINING_DURATION, levelInfo };
