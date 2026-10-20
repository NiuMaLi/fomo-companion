// Developer-only, uses the web-access CDP Proxy on an agent-owned FOMO tab.
// Replays only a LOCAL account-init response; sends no registration/trade POST to FOMO.
// Never prints identity, holdings, token values or raw messages.
import fs from 'node:fs/promises';

const target = process.argv[2];
if (!target || !/^[A-F0-9]{32}$/.test(target)) throw new Error('Pass an agent-owned FOMO target ID');
const bundle = await fs.readFile(new URL('../.output/chrome-mv3/content-scripts/page.js', import.meta.url), 'utf8');
const expression = `(async()=>{
  if(location.origin!=='https://fomo.family')return {error:'wrong_origin'};
  const probeNativeFetch=window.fetch.bind(window);
  const probeHtml=await(await probeNativeFetch(location.origin,{credentials:'omit'})).text();
  const probeRoot=probeHtml.match(/\\/assets\\/root-v2-[\\w-]+\\.js/)?.[0];
  if(!probeRoot)return {error:'root_not_found'};
  const probeSource=await(await probeNativeFetch(probeRoot,{credentials:'omit'})).text();
  const probeQuery=probeSource.match(/queryClient-[\\w.-]+\\.js/)?.[0];
  if(!probeQuery)return {error:'query_cache_not_found'};
  const probeClient=(await import('/assets/'+probeQuery)).q;
  const probeAccount=probeClient.getQueryCache().getAll().find(x=>x.queryKey[0]==='account'&&x.state.data?.id)?.state.data.id;
  if(!probeAccount)return {error:'current_account_not_found'};
  let probeLocalInitializations=0;
  window.fetch=(input,init)=>{
    if(String(input)==='https://prod-api.fomo.family/v2/users'&&init?.method==='POST'&&init?.headers?.['X-Fomo-Local-Probe']==='1'){
      probeLocalInitializations++;
      return Promise.resolve(new Response(JSON.stringify({success:true,responseObject:{id:probeAccount}}),{headers:{'Content-Type':'application/json'}}));
    }
    return probeNativeFetch(input,init);
  };
  const probeResult={localBootstrap:true,session:false,price:false,credentialForwarded:false,health:[]};
  let probeResolve;
  const probeDone=new Promise(resolve=>{probeResolve=resolve;});
  const probeListener=event=>{
    const m=event.data;
    if(event.source!==window||m?.source!=='fomo-companion-v1')return;
    if(m.type==='session'){probeResult.session=true;probeResult.positionCount=m.session.positions.length;probeResult.minimumBuyUsd=m.session.minimumBuyUsd;probeResult.minimumSellUsd=m.session.minimumSellUsd;}
    if(m.type==='price')probeResult.price=true;
    if(m.type==='health')probeResult.health.push(m.status);
    if('jwt'in m||'token'in m||'cookie'in m)probeResult.credentialForwarded=true;
    if(probeResult.session&&probeResult.price)probeResolve();
  };
  window.addEventListener('message',probeListener);
  ${bundle}
  await window.fetch('https://prod-api.fomo.family/v2/users',{method:'POST',headers:{'X-Fomo-Local-Probe':'1'}});
  let probeTimer;
  await Promise.race([probeDone,new Promise(resolve=>{probeTimer=setTimeout(resolve,12000);})]);
  clearTimeout(probeTimer);window.removeEventListener('message',probeListener);
  return {...probeResult,localInitializations:probeLocalInitializations};
})()`;
const response = await fetch(`http://localhost:3456/eval?target=${target}`, { method: 'POST', body: expression });
const result = await response.json();
console.log(JSON.stringify(result, null, 2));
if (!result.value?.session || !result.value?.price || result.value?.credentialForwarded) process.exitCode = 1;
