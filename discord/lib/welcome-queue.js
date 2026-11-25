'use strict';
const crypto=require('node:crypto');
function enqueue(queue,id,joinedAt,sendWelcome=true){const key=String(id);const old=queue[key];if(old&&old.joinedAt===joinedAt){if(sendWelcome&&!old.sendWelcome){old.sendWelcome=true;old.welcomeDone=false;}return old;}return queue[key]={id:key,joinedAt,sendWelcome,roleDone:false,welcomeDone:!sendWelcome,attempts:0,nextAt:0};}
function nonce(job){return crypto.createHash('sha256').update(job.id+':'+job.joinedAt).digest('hex').slice(0,24);}
function delay(attempt){return Math.min(300000,5000*2**Math.min(attempt,6));}
async function run(job,{role,welcome,save,log=()=>{},now=Date.now}){if(job.nextAt>now())return false;for(const [key,fn] of [['roleDone',role],['welcomeDone',welcome]]){if(job[key])continue;try{await fn(job);job[key]=true;save();}catch(e){log(key,e);}}if(job.roleDone&&job.welcomeDone)return true;job.attempts++;job.nextAt=now()+delay(job.attempts);save();return false;}
module.exports={enqueue,nonce,delay,run};
