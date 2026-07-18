/**
 * Single-page UserOp observability UI, served at GET /debug (dev). Self-contained (inline CSS/JS,
 * same-origin fetch to this bundler) so it works under `wrangler dev` with no build step. Enter a
 * chainId + userOpHash and it polls GET /v1/debug/:chainId/:hash to show WHICH stage the op is in,
 * WHERE it's stored, and WHAT (if anything) is blocking it — plus live chain health/funding.
 */
export const DEBUG_PAGE_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vela Bundler — UserOp Inspector</title>
<style>
  :root { --bg:#0f1117; --panel:#171a23; --line:#262a36; --txt:#e6e8ef; --muted:#8b90a0;
          --accent:#5b8cff; --ok:#2ec16b; --warn:#f5a623; --bad:#ef4d4d; --idle:#333846; }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--txt);
    font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
  header { padding:16px 20px; border-bottom:1px solid var(--line); display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  header h1 { font-size:15px; margin:0; font-weight:600; letter-spacing:.3px; }
  header .sp { flex:1; } input,button,select { font:inherit; }
  input,select { background:var(--panel); border:1px solid var(--line); color:var(--txt); padding:7px 10px; border-radius:7px; }
  input#hash { width:min(560px,60vw); } input#chain { width:110px; }
  button { background:var(--accent); border:0; color:#fff; padding:7px 14px; border-radius:7px; cursor:pointer; }
  button.ghost { background:transparent; border:1px solid var(--line); color:var(--muted); }
  main { padding:20px; max-width:1100px; margin:0 auto; }
  .pipe { display:flex; gap:8px; margin:8px 0 20px; overflow-x:auto; }
  .step { flex:1; min-width:120px; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px; position:relative; }
  .step .k { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.5px; }
  .step .v { font-size:13px; margin-top:4px; }
  .step.active { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent) inset; }
  .step.done { border-color:#2a4; } .step.done .dot { background:var(--ok); }
  .step.ok { border-color:var(--ok); box-shadow:0 0 0 1px var(--ok) inset; }
  .step.bad { border-color:var(--bad); box-shadow:0 0 0 1px var(--bad) inset; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--idle); position:absolute; top:12px; right:12px; }
  .step.active .dot { background:var(--accent); } .step.ok .dot { background:var(--ok); } .step.bad .dot { background:var(--bad); }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  @media(max-width:820px){ .grid{ grid-template-columns:1fr; } }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .card h2 { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.6px; margin:0 0 10px; }
  .row { display:flex; justify-content:space-between; gap:14px; padding:3px 0; border-bottom:1px dashed var(--line); }
  .row:last-child { border-bottom:0; } .row .lab { color:var(--muted); } .row .val { text-align:right; word-break:break-all; }
  .pill { display:inline-block; padding:2px 9px; border-radius:20px; font-size:12px; font-weight:600; }
  .p-ok{background:rgba(46,193,107,.15);color:var(--ok)} .p-warn{background:rgba(245,166,35,.15);color:var(--warn)}
  .p-bad{background:rgba(239,77,77,.15);color:var(--bad)} .p-idle{background:rgba(139,144,160,.15);color:var(--muted)}
  .p-live{background:rgba(91,140,255,.15);color:var(--accent)}
  .banner { padding:11px 14px; border-radius:9px; margin-bottom:16px; font-size:13px; }
  .banner.bad{ background:rgba(239,77,77,.12); border:1px solid var(--bad); }
  .banner.warn{ background:rgba(245,166,35,.12); border:1px solid var(--warn); }
  .banner.ok{ background:rgba(46,193,107,.1); border:1px solid var(--ok); }
  a { color:var(--accent); } .muted{ color:var(--muted); } code{ color:#b6c2ff; }
  .foot { color:var(--muted); font-size:12px; margin-top:18px; }
</style></head>
<body>
<header>
  <h1>🔎 Vela Bundler — UserOp Inspector</h1>
  <span class="sp"></span>
  <label class="muted">chain</label><input id="chain" value="42161" />
  <input id="hash" placeholder="0x… userOpHash (64 hex)" />
  <button id="go">Inspect</button>
  <button id="auto" class="ghost">Auto ⏱ off</button>
</header>
<main>
  <div id="banner"></div>
  <div class="pipe" id="pipe"></div>
  <div class="grid">
    <div class="card"><h2>This op</h2><div id="op"></div></div>
    <div class="card"><h2>Chain health &amp; funding</h2><div id="chain"></div></div>
  </div>
  <div class="foot" id="ts"></div>
  <div class="foot">Stages: <b>Ingress</b> validate+simulate+gate → <b>Mempool</b> (DO storage <code>mp:</code>, retried ~10s, 5-min TTL) →
    <b>In-flight</b> (pending receipt, fee-bump→cancellation) → <b>Confirmed</b>/<b>Failed</b> (receipt store <code>rc:</code> + KV).
    "unknown" = never accepted here / TTL-evicted / (queue mode) lives in a RelayerDO.</div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const STAGES = ["Ingress","Mempool","In-flight","Terminal"];
let timer = null;

function pill(text, cls){ return '<span class="pill '+cls+'">'+text+'</span>'; }
function rows(obj){ return Object.entries(obj).filter(([,v])=>v!==undefined&&v!==null&&v!=='')
  .map(([k,v])=>'<div class="row"><span class="lab">'+k+'</span><span class="val">'+v+'</span></div>').join(''); }
function ms(x){ return x==null?'':(x<1000?x+'ms':(x/1000).toFixed(1)+'s'); }

function renderPipe(stage){
  const idx = {mempool:1,"in-flight":2,confirmed:3,failed:3}[stage];
  $('pipe').innerHTML = STAGES.map((s,i)=>{
    let cls='step';
    if(stage==='unknown'){ /* none active */ }
    else if(i<idx) cls+=' done';
    else if(i===idx){ cls += stage==='confirmed'?' ok':(stage==='failed'?' bad':' active'); }
    const label = (i===3) ? (stage==='confirmed'?'Confirmed ✓':stage==='failed'?'Failed ✕':'Terminal') : s;
    return '<div class="'+cls+'"><span class="dot"></span><div class="k">'+(i+1)+'</div><div class="v">'+label+'</div></div>';
  }).join('');
}

function stagePill(stage){
  return { mempool:pill('IN MEMPOOL','p-live'), "in-flight":pill('IN FLIGHT','p-warn'),
    confirmed:pill('CONFIRMED','p-ok'), failed:pill('FAILED','p-bad'), unknown:pill('NOT FOUND HERE','p-idle') }[stage]||stage;
}

function render(d){
  const op=d.op, kv=d.kv, c=d.chain;
  renderPipe(op.stage);

  // banner: surface the blocker
  let b='';
  if(op.stage==='confirmed') b='<div class="banner ok">✓ Landed on-chain. '+op.detail+'</div>';
  else if(op.stage==='failed') b='<div class="banner bad">✕ '+op.detail+'</div>';
  else if(c.insufficientFundsEoa) b='<div class="banner bad">💸 Fronting EOA <code>'+c.insufficientFundsEoa+'</code> is out of gas (shortfall '+(c.insufficientFundsWei||'?')+' wei) — the treasury refill is the blocker. Check funding below.</div>';
  else if(op.stage==='unknown') b='<div class="banner warn">'+op.detail+'</div>';
  else if(op.stage==='in-flight' && op.inFlight && op.inFlight.ageMs>300000) b='<div class="banner warn">⏳ In-flight '+ms(op.inFlight.ageMs)+' — likely underpriced; fee-bump/cancellation should be running.</div>';
  $('banner').innerHTML=b;

  // op card
  let o='<div class="row"><span class="lab">stage</span><span class="val">'+stagePill(op.stage)+'</span></div>';
  o+='<div class="row"><span class="lab">detail</span><span class="val">'+op.detail+'</span></div>';
  if(op.mempool) o+=rows({ where:'DO mempool (mp:)', sender:op.mempool.sender, nonce:op.mempool.nonce, prefund:op.mempool.prefund+' wei', 'waiting for':ms(op.mempool.ageMs), rpcOverride:op.mempool.rpcUrlOverride });
  if(op.inFlight) o+=rows({ where:'pending receipt (in-flight)', txHash:op.inFlight.txHash, txNonce:op.inFlight.txNonce, 'fronting EOA':op.inFlight.eoaAddress, 'reconcile checks':op.inFlight.checkCount, 'fee-bumps':op.inFlight.bumpCount, cancelAttempted:op.inFlight.lastCancelAt?'yes':'no', 'in-flight for':ms(op.inFlight.ageMs), priorHashes:(op.inFlight.priorTxHashes||[]).join(', ') });
  if(op.receipt) o+=rows({ where:'receipt store (rc:) + KV', success:op.receipt.success, txHash:op.receipt.txHash, actualGasCost:op.receipt.actualGasCost, actualGasUsed:op.receipt.actualGasUsed });
  if(kv) o+=rows({ 'KV marker':kv.present?('status='+(kv.status||'?')+(kv.hasReceipt?' (has receipt)':'')):'none' });
  $('op').innerHTML=o;

  // chain card
  $('chain').innerHTML=rows({
    chainId:c.chainId, mempoolSize:c.mempoolSize, pendingReceipts:c.pendingReceiptCount,
    'oldest mempool op':ms(c.oldestMempoolAgeMs), lockedEOAs:(c.lockedEOAs||[]).join(', ')||'none',
    insufficientFundsEoa:c.insufficientFundsEoa||'none', lastSubmitError:c.lastSubmitError||'none'
  });
  $('ts').textContent='updated '+new Date().toLocaleTimeString();
}

async function poll(){
  const chain=$('chain').value.trim(), hash=$('hash').value.trim();
  if(!/^0x[0-9a-fA-F]{64}$/.test(hash)){ $('banner').innerHTML='<div class="banner warn">Enter a valid userOpHash (0x + 64 hex).</div>'; return; }
  try{
    const r=await fetch('/v1/debug/'+chain+'/'+hash,{cache:'no-store'});
    const d=await r.json();
    if(d.error){ $('banner').innerHTML='<div class="banner bad">'+d.error+'</div>'; return; }
    render(d);
  }catch(e){ $('banner').innerHTML='<div class="banner bad">fetch failed: '+e+'</div>'; }
}
$('go').onclick=poll;
$('hash').addEventListener('keydown',e=>{ if(e.key==='Enter') poll(); });
$('auto').onclick=function(){
  if(timer){ clearInterval(timer); timer=null; this.textContent='Auto ⏱ off'; this.classList.add('ghost'); }
  else { poll(); timer=setInterval(poll,2000); this.textContent='Auto ⏱ 2s'; this.classList.remove('ghost'); }
};
// deep-link: /debug?chain=1&hash=0x..
const q=new URLSearchParams(location.search);
if(q.get('chain')) $('chain').value=q.get('chain');
if(q.get('hash')){ $('hash').value=q.get('hash'); poll(); }
</script>
</body></html>`;
