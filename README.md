# ORIVELA Starfall V3 — Unified Edition (trial build)

One Ecosystem. Two Platforms. One Universe.

Baca `BACA-DULU.txt` untuk langkah instalasi KiosPanel dari nol. Paket ini merupakan integrasi source WhatsApp terbaru yang diunggah (V5.0) dan Discord V2.2. Belum diuji dengan akun Discord/WhatsApp asli. Node.js 22.12+ atau 24 LTS direkomendasikan. Jangan mengunggah ke repo publik: setelah dikonfigurasi, file akan mengandung data rahasia dan data pelanggan.

## Arsitektur dan perubahan

- `index.js` memulai satu proses dengan dua koneksi independen; WA dapat dinonaktifkan saat menguji Discord. `shared.js` mengatur koordinasi, jadwal, link, promo, dan antrean konten. Jangan menjalankan `wa/orivela-main-fixed.js` atau `discord/index.js` sendiri, atau mengaktifkan dua instance yang mengakses file yang sama.
- WA menggunakan source V5.0 termasuk format order, pengambilan order, verifikasi manual, QRIS, rekap, jadwal, welcome, admin game, dan Luckyverse asli. Discord mempertahankan layout emoji, panel V2.2, ticket privat, welcome/autorole retry, Content Studio, review, arsip, dan kontrol admin. Perintah game Discord tetap tidak mengekspos coinflip/slots seperti V2.2; perintah WA asli tetap ada. Akun WA perlu dilink untuk bermain/redeem di Discord, supaya satu saldo digunakan kedua platform.
- Penyimpanan JSON atomik, bukan SQLite. Ada ledger order WA dan Discord yang terpisah karena format platform berbeda, namun katalog, promo, slot, engine game/voucher, jadwal, link, dan rekap dihubungkan melalui satu proses. Reservasi slot/voucher diperiksa sinkron sebelum menyimpan order. Bukan database terdistribusi atau transaksi ACID lintas file. Jangan edit data ketika bot hidup.
- Katalog tunggal `discord/data/catalog.json` (22 produk, 101 paket) dan pricelist terbaru memakai versi harga Discord. ZIP WA yang diberikan memiliki 106 paket dengan beberapa SKU dan harga berbeda. Periksa harga/paket melalui `.harga` / `/harga` sebelum produksi; jangan mengasumsikan kode lama masih sama. Harga order yang sudah diterbitkan tetap terkunci. Gunakan produk yang memang berhak Anda jual/distribusikan sesuai aturan penyedia.
- QRIS kedua platform menggunakan payload dan template terbaru dari Discord; QR nominal dan masa invoice 30 menit. Tidak terhubung API GoPay Merchant. Admin memeriksa dana masuk; QR yang disimpan masih mungkin dibayar setelah invoice bot expired. Pembayaran baru harus dinonaktifkan saat uji awal.
- `wa/config.json` diawali dengan nomor/grup kosong, pembayaran nonaktif. Session WA, token, node_modules, cache, dan transaksi/player asli dari ZIP WA tidak dimasukkan. Ini sengaja untuk uji server baru tanpa kontak pelanggan asli. Konfigurasi WA lama dapat diisikan sendiri pada tahap migrasi. `.env` hanya placeholder.
- Konten WA dan Discord menggunakan background celestial. Staff dapat membuat konten sekali, antrean posting mengirim ke kedua platform yang aktif. Upload foto custom pada prompt WA sekarang menggunakan caption sebagai bahan render, bukan meneruskan foto asli. Tidak ada mention massal otomatis. Konten yang dibuat saat WA_ENABLED=false tidak otomatis dikirim ke WA setelah diaktifkan. Promo lama pada chat WA merupakan snapshot saat diposting; cek `.promo` untuk harga/slot aktual, sedangkan Discord memperbarui panel aktif. Jika timeout setelah server sudah menerima pesan, retry dapat menghasilkan duplikat pesan; jangan gunakan jumlah pesan sebagai bukti transaksi.
- Simpan data dan session pada storage permanen. Root backup harian menyimpan 7 hari data, backup privat `/backup` tersedia. Session/token tidak termasuk backup command, harus dibackup terpisah dan privat.

## Struktur file

```
index.js
package.json
.env / .env.example
shared.js
backup.js
wa/                         # WA V5.0 adapter
  config.json               # grup/nomor WA
  orivela-main-fixed.js
  order-system.js
  promo-system.js
  announcement-system.js
  luckyverse-game.js
  data/                     # data WA, media
  auth_info_baileys/        # dibuat saat pairing (rahasia)
discord/                    # Discord adapter V2.2
  index.js
  config.json
  data/catalog.json         # katalog tunggal
  data/qris-payload.txt
  data/runtime/store.json   # data Discord (dibuat saat start)
  assets/                   # media
  lib/
shared-data/state.json      # jadwal, link, outbox (dibuat saat pakai)
backups/                    # backup harian (dibuat saat start)
```

## Akses staff

Discord: Administrator untuk `/setup` dan `/backup`; Store Admin untuk `/store`, `/sales`, `/promo end`, `/welcome repair`; Sales Staff untuk ticket pembelian; Warranty Staff untuk garansi; Support Staff untuk customer support; Content Staff/Sales Staff/Store Admin untuk Content Studio. Administrator punya akses penuh, gunakan hanya akun owner/staff tepercaya. Pemilik ticket melihat ticket sendiri. Role bot harus di atas Member/Customer/staff yang ingin dikelola. Staff WA tetap memakai admin grup yang terverifikasi oleh sistem lama.

| Kebutuhan | Discord | WA |
|---|---|---|
| Katalog | /pricelist, /harga | .pricelist, .harga, .listkode |
| Order | Open Purchase Ticket | .order, form order |
| Claim / invoice / paid / done | Tombol staff ticket | .ambil KODE, .qris, .paid, .d |
| Garansi | #garansi | .garansi (hubungi admin) |
| Bantuan | #customer-support | admin WA |
| Info | /content information | .notif (reply prompt) |
| Promo | /content promo, /promo list, /promo end | .promo, .listpromo, .endpromo |
| Jam toko | /store mode, /store schedule | otomatis membaca jadwal bersama |
| Link | /link | DM `.link KODE` |
| Luckyverse | /game, /voucher | .games, .mine, .daily, .voucher dll |
| Laporan | /sales | .rekap, .rekap all |
| Backup | /backup | backup folder data lewat hosting |

## Checklist trial

1. Discord login dan /setup. Pastikan welcome & autorole pada member baru.
2. Ticket pembelian, garansi, support; panel dan transcript. Jangan membayar tagihan dulu.
3. WA login melalui QR, tiga grup test, .menu dan .harga. Jangan pakai grup produksi.
4. Staff publish informasi dan promo dari masing-masing platform. Cek foto, format, dan expiry.
5. Uji satu slot terakhir dengan dua platform; cancel salah satu, pastikan slot kembali.
6. /link lalu .balance dan /game balance, daily hanya sekali, voucher satu kali pakai. Cek tidak ada data identitas yang bocor ke channel publik. ID WA/LID mungkin memerlukan pemeriksaan owner.
7. /store mode close, pastikan pembelian baru tutup, garansi/support tetap buka; kembalikan mode auto.
8. Cek log dan RAM/disk. Trial 2GB storage mungkin sempit untuk dependency dan backup; jangan upload cache. Restart, cek data dan queue masih ada.
9. Verifikasi merchant dan izin QRIS sebelum uji pembayaran kecil. Bandingkan saldo merchant, total, expiry, dan rekap. Jangan menerima transaksi asli sebelum semua tes berhasil.
10. Backup sebelum hosting trial habis. Masa trial bukan jaminan uptime; verifikasi jaringan port 443 ke Discord/WA, storage permanen, dan harga perpanjangan.

## Migrasi data WA asli (hanya setelah trial)

Jangan copy database lama ke bot aktif. Stop kedua instance. Simpan salinan semua file lama di lokasi pribadi. Source ZIP terbaru mengandung beberapa file runtime WA; paket ini tidak membawa file tersebut. Jika ingin mempertahankan data, ambil backup produksi paling baru dari hosting lama (bukan otomatis memakai snapshot ZIP). Periksa order pending/invoice/voucher aktif dan rekonsiliasi manual sebelum pindah. Salin file lama `orders.json`, `order-admin-locks.json`, `luckyverse.json`, `qris-invoices.json`, `promotions.json` jika ada, dan `store-schedule-state.json` jika masih relevan, ke `wa/data/` pada salinan proyek offline untuk diuji. Jangan menimpa `texts.json` atau katalog baru. Promo lama, SKU lama, nominal dan merchant QR lama mungkin tidak kompatibel; tutup promo lama dengan aman, jangan mengubah invoice lama. Jangan gabungkan saldo akun atau file Discord lama tanpa migrasi terkontrol. Salin konfigurasi grup dan nomor yang dibutuhkan saja, bukan seluruh config tanpa audit. Session WA dapat dipair ulang; jangan mengekspor `auth_info_baileys` ke chat atau repo publik. Jika restore dari file `/backup`, data berisi mapping path JSON; pulihkan saat proses mati dengan memeriksa path dan data, bukan menimpa sembarangan. Trial ini tidak mengandung script migrasi otomatis karena belum ada database produksi terbaru yang diperiksa dan perubahan katalog/QR.

## Hasil uji lokal & batasan

`npm test` menjalankan 7 tes integrasi mock WA/shared, lalu 11 tes logika Discord V2.2. Node --check terhadap source JS. Render QR dengan dependency QR dari ZIP WA lama berhasil pada 1024x1024; dibaca kembali untuk nominal uji 12345. Tidak mengirim pembayaran sungguhan. Tidak ada akses network untuk instalasi dependency Discord/Jimp atau pengujian API live di sini. Karena itu belum dapat menjamin kompatibilitas runtime, performa, uptime, delivery aktual, atau hasil pairing. UI dan rendering foto dinamis wajib diuji di hosting. Baileys adalah library tidak resmi; risiko putus/akun dibatasi oleh WhatsApp tetap ada. Jangan gunakan blast/spam. Jika koneksi ANJAS sebelumnya timeout, retry tidak bisa memperbaiki firewall atau routing hosting yang diblokir. Jika console error, sensor token, pairing QR/kode, nomor pelanggan, dan ID sensitif sebelum screenshot.
