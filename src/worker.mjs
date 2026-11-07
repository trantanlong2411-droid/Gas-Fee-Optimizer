import {GasScheduler} from './scheduler.mjs';
import {demoDecision,receiptReport} from './policy.mjs';
import {rpc,qty,toPros,toGwei} from './rpc.mjs';
import {HTML} from './page.mjs';
export {GasScheduler};
export const VERSION='pharos-gas-optimizer-2026-11-07-v1';
const json=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const limit=new Map();
function limited(request,kind){
 const key=(request.headers.get('cf-connecting-ip')||'anonymous').slice(0,90)+':'+kind,now=Date.now();
 const v=limit.get(key);
 if(!v||now-v.since>60000){limit.set(key,{since:now,n:1});return false;}
 v.n++;return v.n>(kind==='schedule'?4:kind==='receipt'?12:25);
}
function stub(env){
 if(!env?.SCHEDULER)throw Error('SCHEDULER Durable Object is not bound. Check wrangler.jsonc migrations.');
 return env.SCHEDULER.get(env.SCHEDULER.idFromName('pharos-gas-global-market-v1'));
}
async function forward(env,route,request){
 const headers=new Headers();
 if(request.headers.has('authorization'))headers.set('authorization',request.headers.get('authorization'));
 if(request.method==='POST')headers.set('content-type','application/json');
 return stub(env).fetch(new Request('https://internal'+route,{
  method:request.method,headers,body:request.method==='POST'?await request.text():undefined
 }));
}
export default {
 async fetch(request,env){
  const url=new URL(request.url),path=url.pathname;
  if(path==='/'&&request.method==='GET')return new Response(HTML,{headers:{
   'content-type':'text/html;charset=utf-8','cache-control':'no-store',
   'x-content-type-options':'nosniff',
   'content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  }});
  if(path==='/api/health'&&request.method==='GET')return json({ok:true,version:VERSION,
   network:'Pharos Mainnet',chainId:1672,
   oracle:'https://rpc.pharos.xyz',gasSource:['eth_getBlockByNumber','eth_gasPrice'],
   broadcastRpc:'eth_sendRawTransaction',hostedMcpWriteDisabled:true,
   persistence:'Cloudflare Durable Objects alarm + SQLite',
   scheduling:'gas threshold or deadline, whichever comes first',
   types:['signed EIP-1559 type-2'],gasHistory:'24 hours since first visit',
   privacy:'No private keys. Signed raw transaction is held until broadcast or cancelled.',
   caveat:'Submission attempts can be delayed by network outages and alarms; no guaranteed inclusion or deadline execution. Real paid gas requires a mined transaction receipt.',
   broadcastProofStatus:'Not verified by funded Mainnet transaction; only safe read and invalid-payload method checks are automated.'});
  if(path==='/api/market'&&request.method==='GET'){
   if(limited(request,'market'))return json({ok:false,error:'Rate limit exceeded'},429);
   try{return await forward(env,'/market',request)}catch(e){return json({ok:false,error:String(e.message||e).slice(0,250)},503);}
  }
  if(path==='/api/demo'&&request.method==='POST'){
   try{
    const text=await request.text();
    if(text.length>300)throw Error('Demo input too long');
    return json({ok:true,...demoDecision(JSON.parse(text))});
   }catch(e){return json({ok:false,error:String(e.message||e).slice(0,160)},400);}
  }
  if(path==='/api/schedule'&&request.method==='POST'){
   if(limited(request,'schedule'))return json({ok:false,error:'Rate limit reached: retry in 60 seconds'},429);
   try{return await forward(env,'/schedule',request)}
   catch(e){return json({ok:false,error:String(e.message||e).slice(0,260)},503);}
  }
  const match=path.match(/^\/api\/jobs\/([a-f\d-]{36})(?:\/(cancel))?$/);
  if(match && ((request.method==='GET'&&!match[2])||(request.method==='POST'&&match[2]==='cancel'))){
   try{return await forward(env,'/job/'+match[1]+(match[2]?'/cancel':''),request)}
   catch(e){return json({ok:false,error:String(e.message||e).slice(0,200)},503);}
  }
  if(path==='/api/receipt'&&request.method==='GET'){
   if(limited(request,'receipt'))return json({ok:false,error:'Rate limited'},429);
   const hash=url.searchParams.get('hash')||'';
   if(!/^0x[0-9a-fA-F]{64}$/.test(hash))return json({ok:false,error:'Provide a 32-byte transaction hash'},400);
   try{
    if(qty(await rpc('eth_chainId',[]))!==1672n)throw Error('Wrong chain');
    const receipt=await rpc('eth_getTransactionReceipt',[hash]);
    if(!receipt)return json({ok:false,error:'No mined receipt found on Pharos Mainnet yet'},404);
    const used=qty(receipt.gasUsed),price=qty(receipt.effectiveGasPrice);
    return json({ok:true,hash,network:'Pharos Mainnet',chainId:1672,
     minedBlock:Number(qty(receipt.blockNumber)),
     gasUsed:used.toString(),effectiveGasGwei:toGwei(price),
     actualPaidPROS:toPros(used*price),receiptStatus:receipt.status==='0x1'?'SUCCESS':'REVERTED',
     explorer:'https://pharosscan.xyz/tx/'+hash,
     note:'Historical observed receipt only. This transaction was NOT submitted by the optimizer; it has no recorded request-time quote or verified savings.'});
   }catch(e){return json({ok:false,error:String(e.message||e).slice(0,200)},502);}
  }
  return json({ok:false,error:'Unknown route'},404);
 }
};
