'use strict';
const path=require('node:path'),fs=require('node:fs');
const texts=require('./data/texts.json');
const isGroupJid=s=>/^\d+(?:-\d+)?@g\.us$/.test(String(s||''));
const digits=s=>String(s||'').replace(/\D/g,'');
const normalizeCommand=s=>String(s||'').toLowerCase().trim();
const publicReply=c=>({menu:texts.menu,order:texts.order,rules:texts.rules,garansi:texts.garansi})[c]||null;
module.exports={texts,isGroupJid,digits,normalizeCommand,publicReply};
