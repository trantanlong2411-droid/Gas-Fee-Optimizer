import {Transaction,parseUnits} from 'ethers';
import {qty,toGwei,toPros} from './rpc.mjs';
export const MIN_DEADLINE_MS=20000;
export const MAX_DEADLINE_MS=24*60*60*1000;
const min=(a,b)=>a<b?a:b;
export function signedTransaction(raw){
 if(typeof raw!=='string'||!/^0x[\da-fA-F]{100,16000}$/.test(raw))throw Error('Enter a full signed raw EIP-1559 transaction hex');
 let tx;
 try{tx=Transaction.from(raw)}catch{throw Error('The supplied raw transaction could not be decoded')}
 if(tx.type!==2)throw Error('Only signed EIP-1559 type-2 transactions are supported. Legacy fixed-gas transactions cannot benefit from waiting.');
 if(!tx.isSigned()||!tx.hash||!tx.from)throw Error('Transaction is not signed');
 if(tx.chainId!==1672n)throw Error('Signed transaction must target Pharos Mainnet chain ID 1672');
 if(!tx.maxFeePerGas||tx.maxFeePerGas<=0n||tx.maxPriorityFeePerGas===null)throw Error('Transaction is missing valid EIP-1559 fee limits');
 if(tx.maxFeePerGas>1000000000000n||tx.gasLimit>30000000n)throw Error('Transaction fee cap or gas limit exceeds demo safety limits');
 if(tx.maxPriorityFeePerGas>tx.maxFeePerGas)throw Error('Priority fee cannot exceed maxFeePerGas');
 return {hash:tx.hash,from:tx.from,to:tx.to,nonce:tx.nonce,gasLimit:tx.gasLimit.toString(),
   valueWei:tx.value.toString(),valuePros:toPros(tx.value),maxFeeWei:tx.maxFeePerGas.toString(),
   priorityWei:tx.maxPriorityFeePerGas.toString(),maxFeeGwei:toGwei(tx.maxFeePerGas),
   priorityGwei:toGwei(tx.maxPriorityFeePerGas),chainId:1672,type:2,raw:tx.serialized};
}
export function validateSchedule(input,now=Date.now()){
 if(!input||input.consent!==true)throw Error('Explicit consent is required before holding a signed transaction for automatic broadcast');
 const decoded=signedTransaction(input.rawTransaction);
 if(typeof input.deadlineUtc!=='string'||!/^20\d\d-\d\d-\d\dT/.test(input.deadlineUtc))throw Error('Enter an ISO 8601 UTC deadline');
 const deadlineMs=Date.parse(input.deadlineUtc);
 if(!Number.isFinite(deadlineMs)||deadlineMs<now+MIN_DEADLINE_MS||deadlineMs>now+MAX_DEADLINE_MS)throw Error('Deadline must be 20 seconds to 24 hours into the future');
 const target=String(input.targetGwei||'');
 if(!/^(?:\d{1,3})(?:\.\d{1,9})?$/.test(target))throw Error('Target gas price must be a number with up to 9 decimals (gwei)');
 const targetWei=parseUnits(target,'gwei');
 if(targetWei>500000000000n)throw Error('Target gas cannot exceed 500 gwei in this demo');
 return {decoded,deadlineMs,targetWei:targetWei.toString(),targetGwei:toGwei(targetWei)};
}
export function effectiveFeeWei(quote,tx){
 if(!quote||!tx)return null;
 const cap=BigInt(tx.maxFeeWei),priority=BigInt(tx.priorityWei);
 if(quote.baseFeeWei!==null&&quote.baseFeeWei!==undefined){
  const base=BigInt(quote.baseFeeWei);
  if(base>cap)return null;
  return min(cap,base+priority);
 }
 return min(cap,BigInt(quote.gasPriceWei));
}
export function decision(job,quote,now){
 if(job.status!=='PENDING'&&job.status!=='RETRYING'&&job.status!=='BROADCASTING')return {send:false,reason:'ALREADY_HANDLED'};
 if(now>=job.deadlineMs)return {send:true,reason:'DEADLINE',effectiveWei:quote?effectiveFeeWei(quote,job):null};
 if(!quote)return {send:false,reason:'GAS_QUOTE_UNAVAILABLE'};
 const price=effectiveFeeWei(quote,job);
 if(price!==null&&price<=BigInt(job.targetWei))
  return {send:true,reason:'TARGET_REACHED',effectiveWei:price};
 return {send:false,reason:price===null?'MAX_FEE_BELOW_BASE_FEE':'WAIT_FOR_LOWER_GAS',
  effectiveWei:price};
}
export function addHistory(old,sample){
 const collection=Array.isArray(old)?old:[];
 if(collection.length&&sample.timestampMs-collection.at(-1).timestampMs<10000)return collection;
 return [...collection,sample].filter(x=>sample.timestampMs-x.timestampMs<=24*60*60*1000).slice(-1440);
}
export function receiptReport(receipt,requestBaselineWei){
 if(!receipt||!receipt.gasUsed||!receipt.effectiveGasPrice||!receipt.blockNumber)throw Error('Missing gasUsed or effectiveGasPrice in mined receipt');
 const used=qty(receipt.gasUsed),perGas=qty(receipt.effectiveGasPrice),baseline=BigInt(requestBaselineWei);
 const actual=used*perGas,estimatedAtRequest=used*baseline,difference=estimatedAtRequest-actual;
 const percentage=estimatedAtRequest===0n?null:Number((difference*10000n)/estimatedAtRequest)/100;
 return {receiptStatus:receipt.status==='0x1'?'SUCCESS':receipt.status==='0x0'?'REVERTED':'UNKNOWN',
  minedBlock:Number(qty(receipt.blockNumber)),gasUsed:used.toString(),
  effectiveGasWei:perGas.toString(),effectiveGasGwei:toGwei(perGas),
  actualPaidWei:actual.toString(),actualPaidPROS:toPros(actual),
  requestPriceWei:baseline.toString(),requestPriceGwei:toGwei(baseline),
  baselineEquivalentPROS:toPros(estimatedAtRequest),
  estimatedSavingsWei:difference.toString(),estimatedSavingsPROS:toPros(difference),
  savingsPercent:percentage,
  note:'Actual paid = receipt gasUsed × effectiveGasPrice. Request-time comparison reuses the actual gasUsed but the quote at job creation, not a recorded alternative transaction.'};
}
export function publicJob(j){
 if(!j)return null;
 const {raw,accessHash,...other}=j;
 return {...other,
  rawStored:!!raw,
  sensitiveNote:'Raw signed payload and access token are not exposed. A signed transaction is broadcast-capable and should be treated as sensitive until used.'};
}
export function demoDecision(input={}){
 // Deterministic policy proof only, no blockchain call or real signed payload.
 const series=[38,31,26,43,55];
 const threshold=Number(input.targetGwei??28);
 if(!Number.isFinite(threshold)||threshold<0||threshold>500)throw Error('Invalid target gas in demo');
 const deadlineIndex=Number(input.deadlineStep??4);
 if(!Number.isInteger(deadlineIndex)||deadlineIndex<1||deadlineIndex>4)throw Error('Demo deadline step must be 1-4');
 const history=series.slice(0,deadlineIndex+1).map((price,i)=>({
  tick:i,gasGwei:price,deadline:i===deadlineIndex,chosen:price<=threshold||i===deadlineIndex,
  reason:price<=threshold?'TARGET_REACHED':i===deadlineIndex?'DEADLINE':'WAIT'}));
 const selected=history.find(x=>x.chosen);
 return {mode:'SIMULATION_NO_BROADCAST',samples:history,selected,deadlineMetInSimulatedClock:true,
  warning:'These are illustrative gas numbers and simulated scheduling decisions, NOT real network data or an on-chain transaction.'};
}
