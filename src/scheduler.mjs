import {rpc,gasQuote,toGwei} from './rpc.mjs';
import {validateSchedule,effectiveFeeWei,decision,addHistory,receiptReport,publicJob} from './policy.mjs';

const json=(data,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const JOB_PREFIX='job:';
const RETRY_MS=15000;
const GAS_REFRESH_MS=60000;
const MAX_ACTIVE=25;
async function hashToken(token){
 const bytes=new TextEncoder().encode(token);
 const out=await crypto.subtle.digest('SHA-256',bytes);
 return [...new Uint8Array(out)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export class GasScheduler {
 constructor(ctx,env){this.ctx=ctx;this.env=env;this.caller=env?.TEST_RPC||rpc;}
 async listJobs(){return [...(await this.ctx.storage.list({prefix:JOB_PREFIX})).values()];}
 async update(job){await this.ctx.storage.put(JOB_PREFIX+job.id,job);}
 async market(force=false){
  const now=Date.now(),cached=await this.ctx.storage.get('latestGas');
  if(!force&&cached&&now-cached.timestampMs<35000)return cached;
  const sample=await gasQuote(this.caller,now);
  const prev=await this.ctx.storage.get('gasHistory')||[];
  await this.ctx.storage.put('latestGas',sample);
  await this.ctx.storage.put('gasHistory',addHistory(prev,sample));
  return sample;
 }
 async arm(){
  const now=Date.now(),jobs=await this.listJobs();
  let next=now+GAS_REFRESH_MS;
  for(const job of jobs){
   if(['PENDING','RETRYING','BROADCASTING'].includes(job.status)){
    if(job.deadlineMs>now)next=Math.min(next,job.deadlineMs);
    if(job.nextAttemptMs&&job.nextAttemptMs>now)next=Math.min(next,job.nextAttemptMs);
    if(job.deadlineMs<=now)next=Math.min(next,now+2000);
   }
   if(job.status==='SUBMITTED')next=Math.min(next,now+25000);
  }
  await this.ctx.storage.setAlarm(Math.max(now+500,next));
 }
 async status(id,request){
  if(!/^[0-9a-f-]{36}$/.test(id))return json({ok:false,error:'Invalid job identifier'},400);
  const token=request.headers.get('authorization')?.replace(/^Bearer\s+/i,'')||'';
  if(!/^[0-9a-f-]{36}\.[0-9a-f-]{36}$/.test(token))return json({ok:false,error:'Missing job access token'},401);
  const job=await this.ctx.storage.get(JOB_PREFIX+id);
  if(!job||job.accessHash!==await hashToken(token))return json({ok:false,error:'Job not found or incorrect access token'},404);
  return json({ok:true,job:publicJob(job)});
 }
 async cancel(id,request){
  if(!/^[0-9a-f-]{36}$/.test(id))return json({ok:false,error:'Invalid job identifier'},400);
  const token=request.headers.get('authorization')?.replace(/^Bearer\s+/i,'')||'';
  const job=await this.ctx.storage.get(JOB_PREFIX+id);
  if(!job||!token||job.accessHash!==await hashToken(token))return json({ok:false,error:'Not authorized'},403);
  if(!['PENDING','RETRYING'].includes(job.status))return json({ok:false,error:'Job can no longer be cancelled because broadcasting has begun or it has already finished'},409);
  job.status='CANCELED';job.raw=null;job.updatedAtUtc=new Date().toISOString();
  await this.update(job);await this.arm();
  return json({ok:true,job:publicJob(job)});
 }
 async create(request){
  let input;
  try{const body=await request.text();if(body.length>19000)throw Error('Request is too long');input=JSON.parse(body);}
  catch(e){return json({ok:false,error:'Invalid JSON or signed transaction payload'},400);}
  try{
   const now=Date.now(),spec=validateSchedule(input,now);
   const jobs=await this.listJobs();
   if(jobs.filter(j=>['PENDING','RETRYING','BROADCASTING','SUBMITTED'].includes(j.status)).length>=MAX_ACTIVE)
    return json({ok:false,error:'Scheduler capacity reached: try again later'},429);
   if(jobs.some(j=>j.hash===spec.decoded.hash&&['PENDING','RETRYING','BROADCASTING','SUBMITTED'].includes(j.status)))
    return json({ok:false,error:'This signed transaction is already in the scheduler'},409);
   const quote=await this.market();
   const baseline=effectiveFeeWei(quote,spec.decoded);
   if(baseline===null)throw Error('Current base fee exceeds the signed maximum; sign a higher fee cap or try later. Request-time benchmark cannot be calculated safely.');
   const id=crypto.randomUUID(),token=crypto.randomUUID()+'.'+crypto.randomUUID();
   const job={id,hash:spec.decoded.hash,from:spec.decoded.from,to:spec.decoded.to,nonce:spec.decoded.nonce,
    gasLimit:spec.decoded.gasLimit,valuePros:spec.decoded.valuePros,
    maxFeeWei:spec.decoded.maxFeeWei,priorityWei:spec.decoded.priorityWei,
    maxFeeGwei:spec.decoded.maxFeeGwei,priorityGwei:spec.decoded.priorityGwei,
    targetWei:spec.targetWei,targetGwei:spec.targetGwei,deadlineMs:spec.deadlineMs,
    deadlineUtc:new Date(spec.deadlineMs).toISOString(),createdAtUtc:new Date(now).toISOString(),
    requestPriceWei:baseline.toString(),requestPriceGwei:toGwei(baseline),
    requestNetworkGasGwei:quote.gasPriceGwei,requestQuoteBlock:quote.blockNumber,
    status:'PENDING',trigger:null,attempts:0,lastError:null,nextAttemptMs:null,
    receipt:null,submittedAtUtc:null,firstAttemptAtUtc:null,broadcastResult:null,
    raw:spec.decoded.raw,accessHash:await hashToken(token),updatedAtUtc:new Date(now).toISOString()
   };
   await this.update(job);
   // For immediately favorable conditions, the alarm can wake promptly.
   await this.ctx.storage.setAlarm(Math.max(now+500,
    Math.min(now+5000,spec.deadlineMs)));
   return json({ok:true,job:publicJob(job),accessToken:token,
    warning:'Signed raw transactions are broadcast-capable. Preserve your private access token to inspect or cancel this job. The scheduler targets on-time submission, not guaranteed block inclusion.'},201);
  }catch(e){return json({ok:false,error:String(e.message||e).slice(0,330)},400);}
 }
 async broadcast(job,quote,now,reason){
  const firstAttempt=!job.firstAttemptAtUtc;
  job.status='BROADCASTING';job.trigger=reason;job.attempts++;
  if(firstAttempt)job.firstAttemptAtUtc=new Date(now).toISOString();
  job.updatedAtUtc=new Date(now).toISOString();
  await this.update(job);
  try{
   const returned=await this.caller('eth_sendRawTransaction',[job.raw]);
   if(typeof returned!=='string'||returned.toLowerCase()!==job.hash.toLowerCase())throw Error('RPC returned an unexpected transaction hash');
   job.status='SUBMITTED';job.broadcastResult='ACCEPTED_BY_RPC';job.submittedAtUtc=new Date().toISOString();
   job.raw=null;job.lastError=null;
  }catch(e){
   let known=false;
   try{
    const tx=await this.caller('eth_getTransactionByHash',[job.hash]);
    known=!!tx&&typeof tx.hash==='string'&&tx.hash.toLowerCase()===job.hash.toLowerCase();
   }catch{}
   if(known){
    job.status='SUBMITTED';job.broadcastResult='ALREADY_SEEN_ON_CHAIN';
    job.submittedAtUtc=new Date().toISOString();job.raw=null;job.lastError=null;
   }else{
    job.status='RETRYING';job.lastError=String(e.message||e).slice(0,260);
    job.nextAttemptMs=now+RETRY_MS;
    if(now>job.deadlineMs+10*60000){
     job.status='BROADCAST_FAILED';job.raw=null;
    }
   }
  }
  job.updatedAtUtc=new Date().toISOString();
  await this.update(job);
 }
 async receipt(job){
  try{
   const r=await this.caller('eth_getTransactionReceipt',[job.hash]);
   if(!r||!r.blockNumber)return;
   job.receipt=receiptReport(r,job.requestPriceWei);
   job.status=job.receipt.receiptStatus==='REVERTED'?'MINED_REVERTED':'MINED';
   job.receivedAtUtc=new Date().toISOString();
   job.updatedAtUtc=job.receivedAtUtc;
   await this.update(job);
  }catch(e){
   job.lastReceiptError=String(e.message||e).slice(0,160);
   await this.update(job);
  }
 }
 async process(){
  let quote=null;
  try{quote=await this.market()}catch(e){console.log('GAS_QUOTE_TEMPORARILY_UNAVAILABLE',String(e.message||e).slice(0,160));}
  const now=Date.now(),jobs=await this.listJobs();
  const pending=jobs.filter(j=>['PENDING','RETRYING','BROADCASTING'].includes(j.status));
  // Ensure deadlines and retries are prioritized, rather than a single slow job starving others.
  pending.sort((a,b)=>a.deadlineMs-b.deadlineMs);
  for(const job of pending.slice(0,20)){
   if(job.nextAttemptMs&&now<job.nextAttemptMs&&now<job.deadlineMs)continue;
   const policy=decision(job,quote,now);
   if(policy.send)await this.broadcast(job,quote,now,policy.reason);
  }
  for(const job of jobs.filter(j=>j.status==='SUBMITTED').slice(0,12))await this.receipt(job);
  for(const job of jobs){
   if(!['PENDING','RETRYING','BROADCASTING','SUBMITTED'].includes(job.status)&&Date.parse(job.updatedAtUtc)<now-7*86400000)
    await this.ctx.storage.delete(JOB_PREFIX+job.id);
  }
 }
 async alarm(){
  try{await this.process();await this.arm();}
  catch(e){
   console.log('GAS_SCHEDULER_ALARM_ERROR',String(e.message||e).slice(0,210));
   // Re-arm even after a transient provider failure to continue attempting deadlines.
   await this.ctx.storage.setAlarm(Date.now()+RETRY_MS);
  }
 }
 async fetch(request){
  const url=new URL(request.url),path=url.pathname;
  if(path==='/market'){
   let quote=null,warning=null;
   try{quote=await this.market()}catch(e){warning=String(e.message||e).slice(0,200);quote=await this.ctx.storage.get('latestGas')||null;}
   await this.arm();
   const history=await this.ctx.storage.get('gasHistory')||[];
   return json({ok:!!quote,quote,history:history.slice(-480),
    sampleCount:history.length,sampleIntervalSeconds:60,
    warning:warning||'24-hour rolling history begins when this Worker is first visited. Gas price samples are indicative, not paid receipts.',
    endpoint:'https://rpc.pharos.xyz',chainId:1672},quote?200:503);
  }
  if(path==='/schedule'&&request.method==='POST')return this.create(request);
  const match=path.match(/^\/job\/([0-9a-f-]{36})(?:\/(cancel))?$/);
  if(match&&request.method==='GET'&&!match[2])return this.status(match[1],request);
  if(match&&request.method==='POST'&&match[2]==='cancel')return this.cancel(match[1],request);
  return json({ok:false,error:'Unknown scheduler operation'},404);
 }
}
