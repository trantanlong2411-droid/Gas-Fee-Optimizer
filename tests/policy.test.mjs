import test from 'node:test';import assert from 'node:assert/strict';
import {Wallet,parseUnits} from 'ethers';
import {toPros,toGwei,gasQuote} from '../src/rpc.mjs';
import {signedTransaction,validateSchedule,effectiveFeeWei,decision,addHistory,receiptReport,demoDecision} from '../src/policy.mjs';
import {GasScheduler} from '../src/scheduler.mjs';
const NOW=Date.parse('2026-11-07T10:00:00Z');
const wei=n=>parseUnits(String(n),'gwei').toString();
const w=Wallet.createRandom();
const baseTx={chainId:1672,type:2,to:'0x0000000000000000000000000000000000000011',
 value:0n,gasLimit:21000n,nonce:0,maxFeePerGas:parseUnits('80','gwei'),
 maxPriorityFeePerGas:parseUnits('1','gwei')};
const quote=(base=15)=>({baseFeeWei:wei(base),priorityWei:wei(1),gasPriceWei:wei(base+2),
 gasPriceGwei:String(base+2),timestampMs:NOW,blockNumber:500,chainId:1672});
class Storage{
 m=new Map();alarmTime=null;
 async get(k){return this.m.get(k)}
 async put(k,v){this.m.set(k,v)}
 async delete(k){this.m.delete(k)}
 async list({prefix}={}){return new Map([...this.m].filter(([k])=>!prefix||k.startsWith(prefix)))}
 async setAlarm(t){this.alarmTime=t}
}
test('only accepts signed EIP-1559 Pharos mainnet and explicit consent',async()=>{
 const raw=await w.signTransaction(baseTx);
 const tx=signedTransaction(raw);assert.equal(tx.chainId,1672);assert.equal(tx.type,2);
 assert.equal(tx.from.toLowerCase(),w.address.toLowerCase());
 assert.ok(tx.hash.startsWith('0x'));
 assert.throws(()=>validateSchedule({rawTransaction:raw,targetGwei:'5',deadlineUtc:new Date(NOW+100000).toISOString(),consent:false},NOW),/consent/);
 const valid=validateSchedule({rawTransaction:raw,targetGwei:'5',deadlineUtc:new Date(NOW+100000).toISOString(),consent:true},NOW);
 assert.equal(valid.targetWei,wei(5));
 const wrong=await w.signTransaction({...baseTx,chainId:1});
 assert.throws(()=>signedTransaction(wrong),/1672/);
 const legacy=await w.signTransaction({type:0,chainId:1672,nonce:0,to:baseTx.to,gasLimit:21000,gasPrice:parseUnits('5','gwei'),value:0});
 assert.throws(()=>signedTransaction(legacy),/EIP-1559/);
});
test('gas target sends when favorable; deadline forces attempt even if expensive',()=>{
 const j={status:'PENDING',deadlineMs:NOW+60000,maxFeeWei:wei(80),priorityWei:wei(1),targetWei:wei(9)};
 assert.equal(decision(j,quote(7),NOW).reason,'TARGET_REACHED');
 assert.equal(decision(j,quote(12),NOW).reason,'WAIT_FOR_LOWER_GAS');
 assert.equal(decision(j,quote(20),NOW+60000).reason,'DEADLINE');
 assert.equal(effectiveFeeWei(quote(90),j),null);
 assert.equal(decision(j,null,NOW+60000).reason,'DEADLINE');
});
test('gas history bounded and precise gas cost comparisons',()=>{
 const hist=addHistory([],quote(10));
 assert.equal(addHistory(hist,{...quote(8),timestampMs:NOW+5000}).length,1);
 assert.equal(addHistory(hist,{...quote(8),timestampMs:NOW+60000}).length,2);
 const receipt={gasUsed:'0x5208',effectiveGasPrice:'0x'+parseUnits('8','gwei').toString(16),blockNumber:'0x100',status:'0x1'};
 const comparison=receiptReport(receipt,wei(10));
 assert.equal(comparison.actualPaidPROS,'0.000168');
 assert.equal(comparison.baselineEquivalentPROS,'0.00021');
 assert.equal(comparison.estimatedSavingsPROS,'0.000042');
 assert.equal(comparison.savingsPercent,20);
 assert.equal(toPros(0),'0.0');assert.equal(toGwei(0),'0.0');
});
test('dry-run policy explicitly demonstrates fallback at deadline, never claims a real broadcast',()=>{
 const fast=demoDecision({targetGwei:29,deadlineStep:4});
 assert.equal(fast.selected.reason,'TARGET_REACHED');assert.equal(fast.selected.tick,2);
 const deadline=demoDecision({targetGwei:0,deadlineStep:4});
 assert.equal(deadline.selected.reason,'DEADLINE');assert.equal(deadline.selected.tick,4);
 assert.equal(deadline.mode,'SIMULATION_NO_BROADCAST');
});
test('market reads live-shaped Pharos JSONRPC methods and validates chain',async()=>{
 const methods=[];
 const caller=async method=>{
  methods.push(method);
  if(method==='eth_chainId')return '0x688';
  if(method==='eth_gasPrice')return '0x'+parseUnits('5','gwei').toString(16);
  if(method==='eth_maxPriorityFeePerGas')return '0x'+parseUnits('1','gwei').toString(16);
  if(method==='eth_getBlockByNumber')return {number:'0xff',timestamp:'0x6900',baseFeePerGas:'0x'+parseUnits('3','gwei').toString(16)};
  throw Error('Unknown method '+method);
 };
 const q=await gasQuote(caller,NOW);assert.equal(q.chainId,1672);assert.equal(q.gasPriceGwei,'5.0');assert.equal(q.baseFeeGwei,'3.0');
 assert.ok(methods.includes('eth_gasPrice'));
});
test('Durable Object alarm accepts a private-token job, broadcasts one pre-signed tx, and stores actual receipt gas',async()=>{
 const raw=await w.signTransaction(baseTx),tx=signedTransaction(raw),storage=new Storage();
 const sent=[],called=[];
 const caller=async(method,args)=>{
  called.push(method);
  if(method==='eth_chainId')return '0x688';
  if(method==='eth_getBlockByNumber')return {number:'0x100',timestamp:'0x6900',baseFeePerGas:'0x'+parseUnits('3','gwei').toString(16)};
  if(method==='eth_gasPrice')return '0x'+parseUnits('5','gwei').toString(16);
  if(method==='eth_maxPriorityFeePerGas')return '0x'+parseUnits('1','gwei').toString(16);
  if(method==='eth_sendRawTransaction'){sent.push(args[0]);return tx.hash;}
  if(method==='eth_getTransactionReceipt')return {gasUsed:'0x5208',
   effectiveGasPrice:'0x'+parseUnits('4','gwei').toString(16),blockNumber:'0x101',status:'0x1'};
  throw Error('Unknown method '+method);
 };
 const doObj=new GasScheduler({storage},{TEST_RPC:caller});
 const response=await doObj.fetch(new Request('https://internal/schedule',{method:'POST',body:JSON.stringify({
  rawTransaction:raw,targetGwei:'5',deadlineUtc:new Date(Date.now()+60000).toISOString(),consent:true
 })}));
 assert.equal(response.status,201);const created=await response.json();
 assert.equal(created.ok,true);assert.equal(created.job.rawStored,true);
 assert.ok(!JSON.stringify(created).includes(raw));
 const id=created.job.id,token=created.accessToken;
 const unauth=await doObj.fetch(new Request('https://internal/job/'+id));
 assert.equal(unauth.status,401);
 await doObj.alarm();
 assert.equal(sent.length,1);
 let authenticated=await (await doObj.fetch(new Request('https://internal/job/'+id,{headers:{authorization:'Bearer '+token}}))).json();
 assert.equal(authenticated.job.status,'SUBMITTED');assert.equal(authenticated.job.rawStored,false);
 await doObj.alarm();
 authenticated=await (await doObj.fetch(new Request('https://internal/job/'+id,{headers:{authorization:'Bearer '+token}}))).json();
 assert.equal(authenticated.job.status,'MINED');assert.equal(authenticated.job.receipt.actualPaidPROS,'0.000084');
 await doObj.alarm();assert.equal(sent.length,1);
});
test('simulated outages retry but never label a transaction as mined without a receipt',async()=>{
 const raw=await w.signTransaction(baseTx),storage=new Storage();
 const caller=async method=>{
  if(method==='eth_chainId')return '0x688';
  if(method==='eth_getBlockByNumber')return {number:'0x100',timestamp:'0x6900',baseFeePerGas:'0x'+parseUnits('3','gwei').toString(16)};
  if(method==='eth_gasPrice')return '0x'+parseUnits('5','gwei').toString(16);
  if(method==='eth_maxPriorityFeePerGas')return '0x'+parseUnits('1','gwei').toString(16);
  if(method==='eth_sendRawTransaction')throw Error('Injected RPC outage');
  if(method==='eth_getTransactionByHash')return null;
  throw Error('Unknown '+method);
 };
 const obj=new GasScheduler({storage},{TEST_RPC:caller});
 const request=await obj.fetch(new Request('https://internal/schedule',{method:'POST',body:JSON.stringify({
  rawTransaction:raw,targetGwei:'0',deadlineUtc:new Date(Date.now()+60000).toISOString(),consent:true
 })}));assert.equal(request.status,201);const c=await request.json();
 const j=await storage.get('job:'+c.job.id);
 j.deadlineMs=Date.now()-1;await storage.put('job:'+j.id,j);
 await obj.alarm();
 const status=await storage.get('job:'+j.id);
 assert.equal(status.status,'RETRYING');assert.equal(status.attempts,1);assert.ok(status.raw);
 assert.match(status.lastError,/RPC outage/);
});
