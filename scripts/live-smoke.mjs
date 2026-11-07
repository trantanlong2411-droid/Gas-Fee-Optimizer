import {mkdir,writeFile} from 'node:fs/promises';
import {rpc,gasQuote,qty,toGwei,toPros} from '../src/rpc.mjs';
const checkedAtUtc=new Date().toISOString();
const quote=await gasQuote();
const historicalHash='0x28a76a84b85e494cdf509611421e08ee871e74e9bd8b332e9ebcf146b60bd61b';
const r=await rpc('eth_getTransactionReceipt',[historicalHash]);
let actualHistoricalReceipt=null;
if(r?.blockNumber&&r?.gasUsed&&r?.effectiveGasPrice){
 const gas=qty(r.gasUsed),price=qty(r.effectiveGasPrice);
 actualHistoricalReceipt={txHash:historicalHash,block:Number(qty(r.blockNumber)),
  gasUsed:gas.toString(),effectiveGwei:toGwei(price),
  gasActuallyPaidPROS:toPros(gas*price),
  note:'A historic independent Mainnet transaction, NOT an optimizer-submitted transaction.'};
}
let invalidWriteMethod={called:false,accepted:false,error:null,methodRecognized:false};
try{
 invalidWriteMethod.called=true;
 await rpc('eth_sendRawTransaction',['0xdeadbeef']);
 invalidWriteMethod.accepted=true;
 invalidWriteMethod.error='Unexpectedly returned success for an intentionally invalid raw byte payload';
}catch(err){
 invalidWriteMethod.error=String(err.message||err).slice(0,220);
 invalidWriteMethod.methodRecognized=!/method not found|unsupported method|does not exist|not available/i.test(invalidWriteMethod.error);
}
const proof={
 schema:'pharos-gas-fee-optimizer-read-only-mainnet-proof-v1',
 checkedAtUtc,chainId:quote.chainId,currentQuote:quote,
 independentlyMinedReceipt:actualHistoricalReceipt,
 broadcasterProbe:invalidWriteMethod,
 signedTransactionBroadcastedByOptimizer:false,
 highGasDeadlineBroadcastTest:'Simulated in deterministic local unit test, not live submitted on-chain',
 paidSavingsMeasuredForOptimizerJob:false,
 note:'Network data/receipt are real Pharos RPC reads. Only invalid bytes were submitted to probe the broadcast method. No funded transaction was signed or broadcast by this test.'
};
await mkdir('proof',{recursive:true});
await writeFile('proof/live-rpc-proof.json',JSON.stringify(proof,null,2)+'\n');
console.log('PHAROS_GAS_LIVE_RPC_PROOF',JSON.stringify(proof));
if(quote.chainId!==1672||!quote.gasPriceWei)process.exitCode=1;
