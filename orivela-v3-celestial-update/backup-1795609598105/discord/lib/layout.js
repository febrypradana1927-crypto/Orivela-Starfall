'use strict';
// Edit labels here; internal keys and saved Discord IDs remain unchanged.
const legacyPublic={welcome:['start','welcome'],rules:['start','rules'],information:['start','information'],announcement:['start','announcement'],status:['store','store-status'],prices:['store','pricelist'],promo:['store','promo'],purchase:['store','open-ticket'],testimonials:['store','testimonials'],terms:['care','syarat-garansi'],warranty:['care','garansi'],support:['care','customer-support'],games:['lucky','game-zone'],gameinfo:['lucky','game-information']};
const publicIcons={welcome:'🌙',rules:'📜',information:'🧭',announcement:'📣',status:'🪐',prices:'🏷️',promo:'🎀',purchase:'🛒',testimonials:'⭐',terms:'📋',warranty:'🛡️',support:'💌',games:'🎮',gameinfo:'✨'};
const legacyStaff={orders:'new-orders',complaints:'new-complaints',supportlog:'new-support',transactions:'transaction-logs',transcripts:'ticket-logs',sales:'sales-report',botlog:'bot-logs',studio:'content-studio'};
const staffIcons={orders:'📥',complaints:'🛡️',supportlog:'💬',transactions:'💳',transcripts:'📁',sales:'📊',botlog:'⚙️',studio:'🎨'};
const legacyCategories={start:'୨ৎ START HERE',store:'୨ৎ STARFALL STORE',care:'୨ৎ CUSTOMER CARE',lucky:'୨ৎ LUCKYVERSE',purchase:'୨ৎ PURCHASE TICKETS',warranty:'୨ৎ WARRANTY TICKETS',support:'୨ৎ SUPPORT TICKETS',staff:'୨ৎ STAFF AREA',archive:'୨ৎ TICKET ARCHIVE'};
const categories={start:'╭─ 🌙・START HERE ─✦',store:'╭─ 🛍️・STARFALL STORE ─✦',care:'╭─ 💌・CUSTOMER CARE ─✦',lucky:'╭─ 🔮・LUCKYVERSE ─✦',purchase:'╭─ 🛒・PURCHASE TICKETS ─✦',warranty:'╭─ 🛡️・WARRANTY TICKETS ─✦',support:'╭─ 🎧・SUPPORT TICKETS ─✦',staff:'╭─ 👑・STAFF AREA ─✦',archive:'╭─ 📦・TICKET ARCHIVE ─✦'};
const publicSpecs=Object.fromEntries(Object.entries(legacyPublic).map(([k,[cat,name]])=>[k,[cat,`${publicIcons[k]}・${name}`]]));
const staffSpecs=Object.fromEntries(Object.entries(legacyStaff).map(([k,name])=>[k,`${staffIcons[k]}・${name}`]));
function ticketName(type,id,closed=false){if(closed)return '📦・closed-'+id.toLowerCase();return ({purchase:'🛒・order-',warranty:'🛡️・garansi-',support:'💌・support-'})[type]+id.slice(4);}
// Only migrate legacy defaults, not manually customized channels.
function shouldRename(current,oldName,newName){return current===oldName&&current!==newName;}
module.exports={publicSpecs,staffSpecs,categories,legacyPublic,legacyStaff,legacyCategories,ticketName,shouldRename};
