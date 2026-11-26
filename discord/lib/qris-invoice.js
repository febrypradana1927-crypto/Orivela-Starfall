'use strict';
// Amount-embedded QRIS for a merchant's own static QR payload, ONLY if issuer permits.
const fs = require('node:fs');
const path = require('node:path');
const MAX_AMOUNT = 10000000; // conservative application limit, not a regulatory assertion
function amountValue(value) {
  if (!['number','string'].includes(typeof value)) throw new Error('Nominal harus rupiah bulat.');
  if (typeof value === 'string' && !/^\d+$/.test(value)) throw new Error('Nominal harus rupiah bulat tanpa pemisah.');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_AMOUNT || typeof value === 'boolean') throw new Error('Nominal harus 1 sampai 10000000 rupiah.');
  return n;
}
function crc16(text) {
  let crc = 0xffff;
  for (const b of Buffer.from(text, 'ascii')) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = ((crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
function field(id, value) {
  if (!/^\d{2}$/.test(id) || !value.length || value.length > 99 || !/^[\x20-\x7e]+$/.test(value)) throw new Error('Field QRIS tidak didukung.');
  return id + String(value.length).padStart(2, '0') + value;
}
function parsePayload(raw) {
  const text = String(raw || '').trim();
  if (!/^[\x20-\x7e]+$/.test(text) || text.length > 2000) throw new Error('Payload QRIS harus berupa teks EMV ASCII asli, bukan URL atau gambar.');
  const tags = new Map();
  let i = 0;
  while (i < text.length) {
    const id = text.slice(i, i + 2), len = text.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(id) || !/^\d{2}$/.test(len) || +len < 1 || i + 4 + +len > text.length || tags.has(id)) throw new Error('Struktur QRIS tidak valid.');
    tags.set(id, text.slice(i + 4, i + 4 + +len));
    i += 4 + +len;
    if (id === '63' && i !== text.length) throw new Error('CRC bukan field terakhir.');
  }
  if (tags.get('00') !== '01' || !/^[0-9a-fA-F]{4}$/.test(tags.get('63') || '') || crc16(text.slice(0,-4)) !== tags.get('63').toUpperCase()) throw new Error('Format atau checksum QRIS tidak valid.');
  if (tags.get('53') !== '360' || tags.get('58') !== 'ID' || !/^\d{4}$/.test(tags.get('52') || '') || !tags.get('59') || !tags.get('60') || ![...tags.keys()].some(k => +k >= 26 && +k <= 51)) throw new Error('Payload bukan QRIS merchant IDR yang didukung.');
  return tags;
}
function makeAmountPayload(raw, amount) {
  const n = amountValue(amount);
  const tags = parsePayload(raw);
  if (tags.get('01') !== '11' || tags.has('54') || ['55','56','57'].some(t => tags.has(t))) throw new Error('Gunakan QRIS statis tanpa nominal/tip yang didukung penerbit.');
  tags.set('01', '12');
  tags.delete('63');
  let out = '';
  for (const [id, value] of tags) {
    out += field(id, value);
    if (id === '53') out += field('54', String(n));
  }
  out += '6304';
  return out + crc16(out);
}
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().trim().replace(/\b(hari|days)\b/g,'day').replace(/\b(minggu|weeks)\b/g,'week').replace(/\b(bulan|months)\b/g,'month').replace(/\b(tahun|years)\b/g,'year').replace(/\b(users)\b/g,'user').replace(/\bstandart\b/g,'standard').replace(/\s*\/\s*/g,' / ').replace(/\s+/g,' ');
function lookupCatalog(file, order) {
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  const aliases = {'prime':'amazon / prime','amazon':'amazon / prime','amazon prime':'amazon / prime','disney+':'disney','hbo':'hbo max','b station':'bstation','bilibili':'bstation','ibispaint':'ibis paint','iqiyi':'iqiyi'};
  const product = v => aliases[normalize(v)] || normalize(v);
  const key = r => JSON.stringify([product(r.product),normalize(r.variant),normalize(r.duration)]);
  const matches = rows.filter(r => key(r) === key(order));
  if (matches.length !== 1) return null;
  return matches[0];
}

function catalogPrice(file, order) {
  const row=lookupCatalog(file,order);
  return row && row.amount !== null ? amountValue(row.amount) : null;
}
class InvoiceStore {
  constructor(file) { this.file = file; }
  load() {
    if (!fs.existsSync(this.file)) return {version:1, invoices:{}};
    const data = JSON.parse(fs.readFileSync(this.file,'utf8'));
    if (data.version !== 1 || !data.invoices || typeof data.invoices !== 'object' || Array.isArray(data.invoices)) throw new Error('Database tagihan tidak valid; pulihkan backup.');
    return data;
  }
  get(id) {
    const data = this.load();
    return Object.hasOwn(data.invoices, String(id)) ? data.invoices[String(id)] : null;
  }
  issue(order, amount, raw) {
    const n = amountValue(amount), id = String(order.id);
    if (!/^[\w-]{1,100}$/.test(id) || ['__proto__','constructor','prototype'].includes(id)) throw new Error('ID order tidak valid.');
    if (order.paidAt || order.doneAt || order.cancelledAt) throw new Error('Order sudah dibayar atau selesai.');
    const data = this.load();
    const old = Object.hasOwn(data.invoices,id) ? data.invoices[id] : null;
    if (old) {
      if (old.amount !== n) throw new Error('Tagihan sudah dikunci. Jangan menerbitkan nominal baru untuk order yang sama.');
      return old;
    }
    const invoice = {id, amount:n, payload:makeAmountPayload(raw,n), createdAt:new Date().toISOString()};
    data.invoices[id] = invoice;
    fs.mkdirSync(path.dirname(this.file),{recursive:true});
    fs.writeFileSync(this.file+'.tmp', JSON.stringify(data,null,2)+'\n',{mode:0o600});
    fs.renameSync(this.file+'.tmp',this.file);
    return invoice;
  }
}
// Celestial template has an opaque white panel. Keep QR modules pixel-aligned,
// with a minimum four-module quiet zone on each edge. No scaling or antialiasing.
const QR_PANEL=Object.freeze({left:344,top:400,side:566,width:1254,height:1254});
function paintQR(template,modules) {
  const {left,top,side,width,height}=QR_PANEL;
  if(template.width!==width||template.height!==height)throw Error('Template QRIS harus 1254 × 1254.');
  const scale=Math.floor(side/(modules.size+8));
  if(scale<5)throw Error('QR terlalu padat untuk template.');
  const startX=left+Math.floor((side-modules.size*scale)/2),startY=top+Math.floor((side-modules.size*scale)/2);
  for(let y=top;y<top+side;y++)for(let x=left;x<left+side;x++){
    const r=Math.floor((y-startY)/scale),c=Math.floor((x-startX)/scale);
    const black=r>=0&&r<modules.size&&c>=0&&c<modules.size&&modules.get(r,c);
    const i=(y*template.width+x)*4;template.data[i]=template.data[i+1]=template.data[i+2]=black?0:255;template.data[i+3]=255;
  }
  return template;
}
async function render(invoice) {
  // Only render the already-validated invoice payload; the template has no QR.
  const tags=parsePayload(invoice.payload);
  if(tags.get('01')!=='12'||!tags.has('54'))throw Error('Payload invoice QRIS harus memiliki nominal.');
  amountValue(tags.get('54'));
  if(invoice.amount!==undefined&&amountValue(invoice.amount)!==amountValue(tags.get('54')))throw Error('Nominal invoice dan QRIS berbeda.');
  const {PNG}=require('pngjs');
  const template=PNG.sync.read(fs.readFileSync(path.join(__dirname,'..','assets','qr-celestial.png')));
  const modules=require('qrcode').create(invoice.payload,{errorCorrectionLevel:'M'}).modules;
  return PNG.sync.write(paintQR(template,modules));
}
module.exports = {amountValue,crc16,parsePayload,makeAmountPayload,catalogPrice,lookupCatalog,InvoiceStore,render,paintQR,QR_PANEL};
