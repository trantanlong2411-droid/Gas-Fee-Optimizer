import assert from 'node:assert/strict';
const site=(process.env.WORKER_URL||'https://gas-fee-optimizer.trantanlong2411.workers.dev').replace(/\/$/,'');
const expected='pharos-gas-optimizer-2026-11-07-v1';
async function get(path,method='GET',body){
 const r=await fetch(site+path,{method,headers:body?{'content-type':'application/json'}:{},
 body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(95000),cache:'no-store'});
 const raw=await r.text();let data;try{data=JSON.parse(raw)}catch{data={error:raw.slice(0,300)}}
 return {status:r.status,data};
}
let health;
for(let i=0;i<24;i++){
 try{health=await get('/api/health');if(health.status===200&&health.data.version===expected)break;
  console.log('WAIT_FOR_WORKER_DEPLOY',i,health.status,health.data.version||health.data.error||'unknown')}
 catch(e){console.log('WAIT_FOR_WORKER_DEPLOY',i,String(e.message||e).slice(0,130));}
 await new Promise(resolve=>setTimeout(resolve,4500));
}
assert.equal(health?.status,200,'Worker is not reachable');
assert.equal(health.data.version,expected,'Worker has not deployed current build');
const market=await get('/api/market');
assert.equal(market.status,200,JSON.stringify(market.data).slice(0,360));
assert.equal(market.data.quote.chainId,1672);
assert.ok(Number(market.data.quote.gasPriceGwei)>0);
assert.ok(market.data.history.length>=1);
const simulation=await get('/api/demo','POST',{targetGwei:0,deadlineStep:4});
assert.equal(simulation.status,200);assert.equal(simulation.data.selected.reason,'DEADLINE');
assert.equal(simulation.data.mode,'SIMULATION_NO_BROADCAST');
const example=await get('/api/receipt?hash=0x28a76a84b85e494cdf509611421e08ee871e74e9bd8b332e9ebcf146b60bd61b');
assert.equal(example.status,200,JSON.stringify(example.data).slice(0,300));
assert.ok(example.data.actualPaidPROS);
const invalid=await get('/api/schedule','POST',{rawTransaction:'0x1234',targetGwei:'5',
 deadlineUtc:new Date(Date.now()+60000).toISOString(),consent:true});
assert.equal(invalid.status,400);
const page=await fetch(site,{signal:AbortSignal.timeout(16000)});
assert.equal(page.status,200);assert.match(await page.text(),/Gas Fee Optimizer/);
console.log('PHAROS_GAS_DEPLOYED_VERIFIED',JSON.stringify({
 site,version:expected,gasGwei:market.data.quote.gasPriceGwei,
 baseFeeGwei:market.data.quote.baseFeeGwei,historySamples:market.data.history.length,
 deadlineSimulated:true,independentRealReceipt:example.data.actualPaidPROS,
 signedPayloadRejected:true,autoBroadcastLiveTested:false}));
