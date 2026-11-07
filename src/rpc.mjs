// Pharos Mainnet public JSON-RPC. Fixed upstream prevents request-supplied URL SSRF.
export const RPC='https://rpc.pharos.xyz';
export const CHAIN_ID=1672n;
export async function rpc(method,params=[],fetcher=fetch){
 const res=await fetcher(RPC,{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000)});
 if(!res.ok)throw Error('Pharos RPC HTTP '+res.status);
 const text=await res.text();if(text.length>120000)throw Error('Oversized JSON-RPC result');
 const parsed=JSON.parse(text);
 if(parsed.error)throw Error('Pharos '+method+': '+String(parsed.error.message||parsed.error.code).slice(0,240));
 if(parsed.result===undefined)throw Error('Missing Pharos RPC result for '+method);
 return parsed.result;
}
export function qty(value){
 if(typeof value!=='string'||!/^0x[0-9a-fA-F]+$/.test(value))throw Error('Invalid blockchain quantity');
 return BigInt(value);
}
export async function gasQuote(caller=rpc,at=Date.now()){
 const chain=qty(await caller('eth_chainId',[]));
 if(chain!==CHAIN_ID)throw Error('Expected Pharos Mainnet chain ID 1672');
 const block=await caller('eth_getBlockByNumber',['latest',false]);
 if(!block||!block.number||!block.timestamp)throw Error('Pharos block unavailable');
 const gasPrice=qty(await caller('eth_gasPrice',[]));
 let priority=0n;
 try{priority=qty(await caller('eth_maxPriorityFeePerGas',[]))}catch{}
 const base=block.baseFeePerGas?qty(block.baseFeePerGas):null;
 if(gasPrice<=0n || gasPrice>1000000000000n)throw Error('Pharos gas quote outside plausible range');
 return {observedAtUtc:new Date(at).toISOString(),timestampMs:at,blockNumber:Number(qty(block.number)),
  gasPriceWei:gasPrice.toString(),priorityWei:priority.toString(),
  baseFeeWei:base===null?null:base.toString(),gasPriceGwei:toGwei(gasPrice),
  baseFeeGwei:base===null?null:toGwei(base),priorityGwei:toGwei(priority),
  chainId:1672,network:'Pharos Mainnet',source:'Public Pharos JSON-RPC eth_gasPrice, eth_getBlockByNumber',
  note:'Indicative live quote. Exact paid gas depends on the block where the transaction lands.'};
}
export function toGwei(wei){
 const n=BigInt(wei),s=n.toString().padStart(10,'0');
 return s.slice(0,-9)+'.'+s.slice(-9).replace(/0+$/,'').padEnd(1,'0');
}
export function toPros(wei){
 const n=BigInt(wei),neg=n<0n,v=neg?-n:n;
 const a=v.toString().padStart(19,'0');
 return (neg?'-':'')+a.slice(0,-18)+'.'+a.slice(-18).replace(/0+$/,'').padEnd(1,'0');
}
