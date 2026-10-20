// Developer-only: inject the production bridge before a normal page reload in an
// agent-owned FOMO tab. Logs only structural checks and public token metadata.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const target = process.argv[2];
const clickOnly = process.argv.includes('--click-only');
if (!target || !/^[A-F0-9]{32}$/.test(target)) throw new Error('Pass an agent-owned FOMO target ID');
const [port, endpoint] = (await fs.readFile(path.join(os.homedir(), 'Library/Application Support/Google/Chrome/DevToolsActivePort'), 'utf8')).trim().split('\n');
const ws = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { ws.close(); reject(new Error('CDP connection timeout')); }, 10000);
  ws.onopen = () => { clearTimeout(timer); resolve(); };
  ws.onerror = error => { clearTimeout(timer); reject(error); };
});
let next = 0; const requests = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); const request = requests.get(m.id); if (request) { requests.delete(m.id); clearTimeout(request.timer); m.error ? request.reject(new Error(m.error.message)) : request.resolve(m.result); } };
function send(method, params = {}, sessionId) { return new Promise((resolve, reject) => { const id = ++next; const timer = setTimeout(() => { requests.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000); requests.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }); }
let session, injection;
try {
  session = (await send('Target.attachToTarget', { targetId: target, flatten: true })).sessionId;
  await send('Page.enable', {}, session);
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (result.exceptionDetails) throw new Error('Page evaluation failed');
    return result.result?.value;
  };
  if (!await evaluate("location.origin==='https://fomo.family'")) throw new Error('Wrong origin');
  const bundle = await fs.readFile(new URL('../.output/chrome-mv3/content-scripts/page.js', import.meta.url), 'utf8').then(s=>s.replaceAll('fomo-companion-v1','fomo-companion-verification-v020'));
  const setup = `window.__fomoVerification={session:false,price:false,logo:false,selection:false,health:[]};window.addEventListener('message',e=>{const m=e.data;if(e.source!==window||m?.source!=='fomo-companion-verification-v020')return;const r=window.__fomoVerification;const mint=location.pathname.split('/')[3];if(m.type==='session'){r.session=true;r.positionCount=m.session.positions.length;r.holdingLogos=m.session.positions.filter(p=>p.logoUrl).length;r.hasCost=m.session.positions.some(p=>p.costUsd!==undefined);}if(m.type==='context'&&m.asset?.tokenAddress===mint){r.asset=m.asset;r.logo=!!m.asset.logoUrl;}if(m.type==='health')r.health.push(m.status);if(m.type==='price'&&m.price.tokenAddress===mint)r.price=true;if(m.type==='selection'&&m.selection.asset.tokenAddress===mint){r.selection=true;r.selectedPrice=m.selection.priceUsd;}if('jwt'in m||'cookie'in m||'token'in m)r.credentialForwarded=true;});`;
  injection = !clickOnly ? await send('Page.addScriptToEvaluateOnNewDocument', { source: setup + '\n' + bundle }, session) : undefined;
  if (!clickOnly) await send('Page.reload', {}, session);
  let result;
  for (let i = 0; i < (clickOnly ? 0 : 80); i++) { result = await evaluate('window.__fomoVerification'); if (result?.session && result?.price && result?.logo) break; await new Promise(r => setTimeout(r, 500)); }
  for (let i = 0; i < 20; i++) {
    const chartReady = await evaluate(`!!document.querySelector('iframe[id^="tradingview_"]')?.contentWindow?.tradingViewApi?.activeChart()`);
    if (chartReady) break;
    await new Promise(r => setTimeout(r, 500));
  }
  // Allow the bridge's iframe readiness poll to attach before the trusted click.
  await new Promise(r => setTimeout(r, 1200));
  // Choose a point inside the observed same-origin chart canvas, away from axes.
  const coords = await evaluate(`(()=>{const f=document.querySelector('iframe[id^="tradingview_"]');if(!f?.contentDocument)return;const canvases=[...f.contentDocument.querySelectorAll('canvas')].map(e=>({e,r:e.getBoundingClientRect()})).filter(x=>x.r.width>300&&x.r.height>150);const c=canvases.sort((a,b)=>b.r.height-a.r.height)[0];if(!c)return;const r=f.getBoundingClientRect();return{x:r.x+c.r.x+c.r.width*.45,y:r.y+c.r.y+c.r.height*.35};})()`);
  if (coords) {
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }, session);

    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...coords }, session);
    await new Promise(r => setTimeout(r, 80));
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...coords, buttons: 1, button: 'left', clickCount: 1, pointerType: 'mouse' }, session);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...coords, buttons: 0, button: 'left', clickCount: 1, pointerType: 'mouse' }, session);
    await new Promise(r => setTimeout(r, 300));
    await send('Emulation.setFocusEmulationEnabled', { enabled: false }, session);
  }
  result = await evaluate('window.__fomoVerification');
  console.log(JSON.stringify(result, null, 2));
  if (!result?.session || !result?.price || !result?.logo || !result?.selection || result?.credentialForwarded) process.exitCode = 1;
} finally {
  if (session) {
    await send('Emulation.setFocusEmulationEnabled', { enabled: false }, session).catch(() => {});
    if (injection) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection.identifier }, session).catch(() => {});
    await send('Target.detachFromTarget', { sessionId: session }).catch(() => {});
  }
  ws.close();
}
