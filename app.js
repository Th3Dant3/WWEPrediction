'use strict';
/* PREDICTION CHAMPIONSHIP — frontend
 * Backend contract is unchanged (Apps Script actions: loginAccount, getDashboard, submitPick,
 * lockPick, setMatchWinner, completeEvent, saveEvent, saveMatch, registerAccount, logoutAccount).
 * What is new here: optimistic UI for picks/locks/winners, polling so the reveal reaches the other
 * player without a refresh, reveal/result detection for animations, and the admin drawer.
 */
let TOKEN=localStorage.getItem('pc_token')||'';
let DATA=null,AUTH_MODE='login',BUSY=false,selId='',firstShow=true;
let pending=0,chain=Promise.resolve(),inflight=false,again=false,failCount=0,armKey='',armTimer=null,pendingRender=false;
let shown={DANTE:0,TRIGGER:0},fresh={flip:new Set(),slam:new Set(),hit:new Set()};
const PLAYERS=['DANTE','TRIGGER'];
const NAME={DANTE:'Dante',TRIGGER:'Trigger',ADMIN:'Admin'};
const OTHER={DANTE:'Trigger',TRIGGER:'Dante'};
const LOCK='<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M7 10V7a5 5 0 0 1 10 0v3h1.5A1.5 1.5 0 0 1 20 11.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19.5v-8A1.5 1.5 0 0 1 5.5 10H7zm2 0h6V7a3 3 0 0 0-6 0v3z"/></svg>';
const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ini=c=>c?c.split(' ').map(w=>w[0]).slice(0,2).join(''):'?';
const show=(id,visible)=>$(id).classList.toggle('hidden',!visible);

function toast(msg,kind){
  const e=$('toast');$('toastText').textContent=msg;e.classList.toggle('err',kind==='err');e.classList.add('on');
  clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.remove('on'),kind==='err'?5200:2800);
}

/**
 * Browser-to-Apps-Script cross-origin transport. (Unchanged.)
 * No token or password is put in the URL: requests are POST forms.
 * The hidden iframe relays the server response through postMessage.
 */
function rpc(action,...args){
  if(!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(PC_API_URL))
    return Promise.reject(Error('Set the deployed Web App URL in config.js first.'));
  return new Promise((resolve,reject)=>{
    const id=crypto.randomUUID();
    const frame=document.createElement('iframe');
    frame.name='pc_rpc_'+id;
    frame.style.display='none';
    frame.setAttribute('title','API transport');
    const form=document.createElement('form');
    form.method='POST';form.action=PC_API_URL;form.target=frame.name;
    form.style.display='none';
    const field=document.createElement('input');
    field.name='payload';field.type='hidden';
    field.value=JSON.stringify({id,action,args,origin:window.location.origin});
    form.appendChild(field);
    const cleanup=()=>{window.removeEventListener('message',onMessage);clearTimeout(timer);frame.remove();form.remove();};
    const onMessage=(event)=>{
      if(!/^https:\/\/(?:[a-z0-9-]+\.)*googleusercontent\.com$/.test(event.origin) && event.origin!=='https://script.google.com')return;
      if(!event.data||event.data.type!=='PC_API_RESPONSE'||event.data.id!==id)return;
      cleanup();
      event.data.ok?resolve(event.data.result):reject(Error(event.data.error||'API error'));
    };
    const timer=setTimeout(()=>{cleanup();reject(Error('API did not respond. Verify deployment access and PC_Settings ALLOWED_ORIGINS.'));},45000);
    window.addEventListener('message',onMessage);
    document.body.appendChild(frame);document.body.appendChild(form);
    form.submit();
  });
}

/* Writes run one at a time so "save pick" always lands before "lock pick". */
function queue(fn){pending++;const p=chain.then(fn);chain=p.catch(()=>{});return p.finally(()=>{pending--;});}
const settle=()=>refresh();
const failed=e=>{toast(e&&e.message||String(e),'err');return refresh(true);};

/* ---------------- helpers ---------------- */
function parseDate(s){
  s=String(s||'');
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)){const [y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d);}
  const d=new Date(s);return isNaN(d)?null:d;
}
const fmtDate=s=>{const d=parseDate(s);return d?d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):String(s||'');};
const dateVal=e=>{const d=parseDate(e.eventDate);return d?d.getTime():0;};
const me=()=>DATA.user.role;
const isAdmin=()=>DATA.user.isAdmin===true;
const curEvent=()=>DATA.events.find(e=>e.id===selId)||null;
const matchesOf=e=>e?DATA.matches.filter(m=>m.eventId===e.id).sort((a,b)=>a.sortOrder-b.sortOrder):[];
const pickOf=(role,m,s)=>m.picks.find(p=>p.role===role&&p.slotId===s.id)||{};
const scoreOf=e=>{const s=(e&&DATA.scores[e.id])||{};return{DANTE:Number(s.DANTE)||0,TRIGGER:Number(s.TRIGGER)||0};};
function defaultEventId(){
  const open=DATA.events.filter(e=>e.status==='OPEN').sort((a,b)=>dateVal(a)-dateVal(b));
  if(open.length)return open[0].id;
  const all=DATA.events.slice().sort((a,b)=>dateVal(b)-dateVal(a));
  return all.length?all[0].id:'';
}
function localScores(e){
  const t={DANTE:0,TRIGGER:0};
  matchesOf(e).forEach(m=>{if(!m.winner)return;PLAYERS.forEach(r=>m.slots.forEach(s=>{const p=pickOf(r,m,s);if(p.lockedAt&&p.choice===m.winner)t[r]+=Number(s.points)||0;}));});
  return t;
}
function isWaiting(){
  const E=curEvent();if(!E||E.status!=='OPEN'||!PLAYERS.includes(me()))return false;
  return matchesOf(E).some(m=>m.lockProgress[me()]===m.slots.length&&!m.fullyLocked);
}

/* ---------------- sign in ---------------- */
function switchAuth(mode){
  AUTH_MODE=mode;show('inviteWrap',mode==='signup');
  $('loginTab').classList.toggle('active',mode==='login');$('signupTab').classList.toggle('active',mode==='signup');
  $('authBtn').textContent=mode==='login'?'Sign in':'Create account';
  $('password').autocomplete=mode==='login'?'current-password':'new-password';
  $('authMsg').textContent='';
}
async function submitAuth(event){
  if(event)event.preventDefault();
  if(BUSY)return;BUSY=true;const msg=$('authMsg');
  try{
    const username=$('username').value.trim(),password=$('password').value;
    if(AUTH_MODE==='signup'){
      await rpc('registerAccount',{username,password,inviteCode:$('invite').value.trim()});
      switchAuth('login');msg.className='note ok';msg.textContent='Account created. Sign in using your new username and password.';return;
    }
    msg.className='note warn';msg.textContent='Signing in...';
    const session=await rpc('loginAccount',username,password);
    TOKEN=session.token;localStorage.setItem('pc_token',TOKEN);$('password').value='';msg.textContent='';
    await refresh(true);
  }catch(e){msg.className='note bad';msg.textContent=e.message||String(e);}
  finally{BUSY=false;}
}
function showAuth(message){
  show('dashboard',false);show('auth',true);
  const m=$('authMsg');m.className='note bad';m.textContent=message||'';
}
async function logOut(){
  try{if(TOKEN)await rpc('logoutAccount',TOKEN);}catch(e){console.warn('Logout call failed:',e);}
  TOKEN='';DATA=null;selId='';firstShow=true;localStorage.removeItem('pc_token');showAuth('');
}
/* Only an expired or missing session signs the user out. Any other failure keeps the dashboard. */
const sessionError=e=>/Session expired|Please sign in/i.test(e&&e.message||'');

/* ---------------- data loop ---------------- */
async function refresh(force){
  if(!TOKEN)return false;
  if(inflight){again=true;return false;}
  if(pending>0&&!force)return false;
  inflight=true;
  try{
    const next=await rpc('getDashboard',TOKEN);
    if(pending>0&&!force)return true;
    failCount=0;show('netNote',false);
    applyData(next);
    return true;
  }catch(e){
    console.error('[Prediction Championship] Dashboard refresh failed:',e);
    if(sessionError(e)){TOKEN='';DATA=null;localStorage.removeItem('pc_token');showAuth('Session expired. Please sign in again.');return false;}
    failCount++;
    if(!DATA)showAuth('Could not restore session: '+(e.message||String(e)));
    else{if(failCount===1)toast('Update failed: '+(e.message||String(e)),'err');if(failCount>=2)show('netNote',true);}
    return false;
  }finally{
    inflight=false;
    if(again){again=false;refresh();}
  }
}
function applyData(next){
  const prev=DATA;
  DATA=next;
  if(!selId||!DATA.events.some(e=>e.id===selId))selId=defaultEventId();
  if(prev)detectChanges(prev,next);
  renderAll();
}
/* Compare snapshots so reveals and results animate when they happen, not on every poll. */
function detectChanges(prev,next){
  const E=curEvent();if(!E)return;
  const role=next.user.role;let revealed=false,resultMatch=null;const scorers=new Set();
  matchesOf(E).forEach(m=>{
    const pm=prev.matches.find(x=>x.id===m.id);if(!pm)return;
    if(!pm.fullyLocked&&m.fullyLocked){
      revealed=true;
      m.picks.forEach(p=>{if(p.role!==role)fresh.flip.add(p.role+':'+m.id+':'+p.slotId);});
    }
    if(!pm.winner&&m.winner){
      resultMatch=m;
      m.picks.forEach(p=>{if(p.lockedAt&&p.choice===m.winner){fresh.hit.add(p.role+':'+m.id+':'+p.slotId);scorers.add(p.role);}});
    }
  });
  if(resultMatch){toast('Result in: '+resultMatch.winner+' wins.');fireConfetti(scorers);}
  else if(revealed)toast('Both locked. Picks revealed.');
  else{
    const before=prev.matches.filter(x=>x.eventId===E.id).length,after=matchesOf(E).length;
    if(after>before&&role!=='ADMIN')toast('New match added.');
  }
}

/* ---------------- rendering ---------------- */
function renderAll(){
  const first=firstShow;firstShow=false;
  show('auth',false);show('dashboard',true);
  $('identity').textContent='Signed in as '+DATA.user.username+', '+(me()==='ADMIN'?'Admin':'Player ('+NAME[me()]+')');
  show('adminBtn',isAdmin());
  renderHero(first);renderEvents();renderBouts();renderHistory();renderFinish();
  if(first){shown={DANTE:0,TRIGGER:0};setTimeout(updateScores,1200);}else updateScores();
}
function pipsHtml(n){const total=Math.max(5,n);return Array.from({length:total},(_,i)=>'<i class="'+(i<n?'on':'')+'"></i>').join('');}
function renderHero(first){
  const E=curEvent(),adv=DATA.advantage||{DANTE:0,TRIGGER:0};
  const title=E?E.title:'No event yet';
  const evEl=$('evt');
  if(evEl.textContent!==title){evEl.textContent=title;if(!first){evEl.classList.remove('replay');void evEl.offsetWidth;evEl.classList.add('replay');}}
  if(first)evEl.classList.add('replay');
  $('bugTitle').textContent=title;
  $('evMeta').textContent=E?(fmtDate(E.eventDate)+(E.location?' in '+E.location:'')+'. '+(E.titleOnLine?'Championship match, title on the line.':'Title not on the line, advantage points only.')):'The administrator can create the first event.';
  const st=$('evStatus');st.classList.toggle('hidden',!E);
  if(E){st.textContent=E.status==='COMPLETED'?'Completed':'Open for predictions';st.className='evstatus '+(E.status==='COMPLETED'?'done':'open');}
  $('advD').textContent=adv.DANTE;$('advT').textContent=adv.TRIGGER;
  $('pips-DANTE').innerHTML=pipsHtml(Number(adv.DANTE)||0);$('pips-TRIGGER').innerHTML=pipsHtml(Number(adv.TRIGGER)||0);
  PLAYERS.forEach(r=>$('champ-'+r).classList.toggle('hidden',String(DATA.champion).toUpperCase()!==r));
  const prevDone=DATA.events.filter(e=>e.status==='COMPLETED'&&(!E||e.id!==E.id)).sort((a,b)=>dateVal(b)-dateVal(a))[0];
  show('rowLast',!!prevDone);
  if(prevDone){const s=scoreOf(prevDone);$('lastLabel').textContent=prevDone.title;$('lastD').textContent=s.DANTE;$('lastT').textContent=s.TRIGGER;}
  const ms=matchesOf(E);
  PLAYERS.forEach(r=>$('lk-'+r).textContent=ms.reduce((n,m)=>n+(m.lockProgress[r]||0),0));
}
function renderEvents(){
  const nav=$('events'),list=DATA.events.slice().sort((a,b)=>dateVal(b)-dateVal(a));
  show('events',list.length>1);
  nav.innerHTML=list.length>1?list.map(e=>'<button class="evpill" type="button" data-act="event" data-id="'+esc(e.id)+'" aria-pressed="'+(e.id===selId)+'"><i class="'+(e.status==='OPEN'?'open':'')+'"></i>'+esc(e.title)+'</button>').join(''):'';
}
function renderHistory(){
  const E=curEvent(),done=DATA.events.filter(e=>e.status==='COMPLETED'&&(!E||e.id!==E.id)).sort((a,b)=>dateVal(b)-dateVal(a));
  $('history').innerHTML=done.map(e=>{const s=scoreOf(e);return '<button class="hrow" type="button" data-act="event" data-id="'+esc(e.id)+'"><span><b>'+esc(e.title)+'</b> finished</span><span>Dante '+s.DANTE+', Trigger '+s.TRIGGER+'</span></button>';}).join('');
}
function renderFinish(){
  const E=curEvent(),b=$('finishBtn'),ok=isAdmin()&&E&&E.status==='OPEN';
  b.classList.toggle('hidden',!ok);if(!ok)return;
  const ms=matchesOf(E),ready=ms.length>0&&ms.every(m=>m.winner);
  b.disabled=!ready;b.title=ready?'':'Every match needs a winner first.';
  const armed=armKey==='finish:'+E.id;b.classList.toggle('armed',armed);
  b.textContent=armed?'Tap again to finish event':'Finish event';
}
function renderBouts(){
  if(hold){pendingRender=true;return;}
  pendingRender=false;
  const E=curEvent(),box=$('bouts');
  if(!E){box.innerHTML='<div class="empty">No events yet. '+(isAdmin()?'Open Admin tools to create the first event.':'The administrator will add the first event soon.')+'</div>';}
  else{
    const ms=matchesOf(E);
    box.innerHTML=ms.length?ms.map(m=>bout(m,E)).join(''):'<div class="empty">Match card coming soon.'+(isAdmin()&&E.status==='OPEN'?' Add the first match in Admin tools.':'')+'</div>';
  }
  fresh={flip:new Set(),slam:new Set(),hit:new Set()};
}
function tile(role,m,s,j,E){
  const mine=role===me(),both=m.fullyLocked,key=role+':'+m.id+':'+s.id,p=pickOf(role,m,s),locked=!!p.lockedAt;
  const d='style="--d:'+(j*0.12+(role==='TRIGGER'?0.18:0)).toFixed(2)+'s"';
  let cls='ticket cut',face='',hit=false;
  if(!(both||mine)){
    const n=m.lockProgress[role]||0,all=n===m.slots.length;
    cls+=' sealed'+(all?' armed':n?' partial':'');
    face='<div class="stub display">×'+esc(s.points)+'</div><div class="art"></div><div class="main"><div class="who">'+(all?LOCK+' Locked in':n?n+' of '+m.slots.length+' locked':'Still deciding')+'</div></div>';
  }else{
    hit=!!(m.winner&&locked&&p.choice===m.winner);const miss=!!(m.winner&&locked&&p.choice!==m.winner);
    if(locked)cls+=' done';if(miss)cls+=' miss';
    if(fresh.flip.has(key))cls+=' flip';if(fresh.slam.has(key))cls+=' slam';
    face='<div class="stub display">×'+esc(s.points)+'</div><div class="art"><span class="ini display">'+esc(ini(p.choice))+'</span></div>'+
      (hit?'<span class="badge'+(fresh.hit.has(key)?' pop':'')+'">+'+esc(s.points)+'</span>':'')+
      '<div class="main"><div class="who">'+(locked?LOCK+' Locked':(mine?'Draft':'Not locked'))+'</div><div class="pick display">'+esc(p.choice||'Not picked')+'</div></div>';
  }
  let picker='';
  if(mine&&!locked&&E.status==='OPEN'&&!m.winner){
    const taken=new Set(m.slots.filter(x=>x.id!==s.id).map(x=>pickOf(role,m,x).choice));
    picker='<div class="chips">'+m.choices.map(c=>'<button class="chip'+(p.choice===c?' on':'')+'" type="button" data-act="pick" data-m="'+esc(m.id)+'" data-s="'+esc(s.id)+'" data-c="'+esc(c)+'"'+(taken.has(c)?' disabled':'')+'>'+esc(c)+'</button>').join('')+'</div>'+
      '<button class="hold" type="button" data-m="'+esc(m.id)+'" data-s="'+esc(s.id)+'"'+(p.choice?'':' disabled')+'><span>'+(p.choice?'Hold to lock pick':'Choose a wrestler first')+'</span></button>'+
      (p.choice?'<p class="hint">Permanent once locked.</p>':'');
  }
  return '<div class="slotwrap"><div class="cardwrap'+(hit?' hit':'')+'"><div class="'+cls+'" '+d+'><div class="face cut">'+face+'</div></div></div>'+picker+'</div>';
}
function bout(m,E){
  const role=me(),n=m.slots.length,lp=m.lockProgress||{};
  const lanes=PLAYERS.map(r=>'<div class="lane '+r.toLowerCase()+'"><div class="lanehead"><span class="av"></span><span class="display">'+NAME[r]+'</span><span class="prog">'+(lp[r]||0)+' of '+n+' locked'+(r===role?', you':'')+'</span></div>'+m.slots.map((s,j)=>tile(r,m,s,j,E)).join('')+'</div>');
  let st,stc='state';
  if(m.winner){st='Winner: '+esc(m.winner);stc+=' done';}
  else if(m.fullyLocked){st='Both locked, awaiting result';stc+=' both';}
  else if(PLAYERS.every(r=>lp[r]===n)){st='Both locked. Revealing picks...';stc+=' both';}
  else if(role==='ADMIN')st=((lp.DANTE||0)+(lp.TRIGGER||0))+' of '+(n*2)+' picks locked';
  else if(lp[role]===n)st='Waiting on '+OTHER[role];
  else st=(lp[role]||0)+' of '+n+' of your picks locked';
  let foot='';
  if(isAdmin()&&E.status==='OPEN'){
    foot=m.fullyLocked
      ?'<div class="foot"><span>'+(m.winner?'Winner recorded. Tap another name to correct it.':'Record the winner')+'</span>'+m.choices.map(c=>{const armed=armKey==='win:'+m.id+':'+c;return '<button class="chip win'+(m.winner===c?' on':'')+(armed?' armed':'')+'" type="button" data-act="win" data-m="'+esc(m.id)+'" data-c="'+esc(c)+'">'+(armed?'Confirm '+esc(c)+'?':esc(c))+'</button>';}).join('')+'</div>'
      :'<div class="foot muted">Winners unlock once both players lock every pick.</div>';
  }
  return '<article class="bout"><div class="bouthead"><h3 class="display">'+esc(m.title)+'</h3><span class="'+stc+'">'+st+'</span></div><div class="lanes">'+lanes[0]+'<div class="vs display">VS</div>'+lanes[1]+'</div>'+foot+'</article>';
}

/* ---------------- scores + confetti ---------------- */
function updateScores(){
  const t=scoreOf(curEvent());
  PLAYERS.forEach(r=>{
    const els=document.querySelectorAll('[data-score="'+r+'"]'),from=shown[r],to=t[r],lead=to>t[r==='DANTE'?'TRIGGER':'DANTE'];
    els.forEach(e=>e.classList.toggle('lead',lead));
    if(reduced||from===to){els.forEach(e=>e.textContent=to);shown[r]=to;return;}
    const t0=performance.now(),dur=900;
    (function step(now){const k=Math.min(1,(now-t0)/dur),e=1-Math.pow(1-k,3),v=Math.round(from+(to-from)*e);
      els.forEach(el=>el.textContent=v);if(k<1)requestAnimationFrame(step);else shown[r]=to;})(t0);
  });
}
function fireConfetti(scorers){
  const colors=[];
  if(scorers.has('DANTE'))colors.push('#ff2d3f','#ff98a1','#ffffff');
  if(scorers.has('TRIGGER'))colors.push('#f3b94a','#ffe3a1','#ffffff');
  if(reduced||!colors.length)return;
  const c=$('fx'),ctx=c.getContext('2d');c.width=innerWidth;c.height=innerHeight;
  const P=Array.from({length:150},()=>({x:innerWidth*(.15+Math.random()*.7),y:-10-Math.random()*120,vx:(Math.random()-.5)*6,vy:2+Math.random()*4,s:6+Math.random()*8,r:Math.random()*6,vr:(Math.random()-.5)*.3,c:colors[Math.floor(Math.random()*colors.length)]}));
  const t0=performance.now();
  (function f(now){const k=(now-t0)/2800;ctx.clearRect(0,0,c.width,c.height);
    P.forEach(p=>{p.x+=p.vx;p.y+=p.vy;p.vy+=.06;p.r+=p.vr;ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.r);ctx.fillStyle=p.c;ctx.globalAlpha=Math.max(0,1-k*.85);ctx.fillRect(-p.s/2,-p.s/4,p.s,p.s/2);ctx.restore();});
    if(k<1.15)requestAnimationFrame(f);else ctx.clearRect(0,0,c.width,c.height);})(t0);
}

/* ---------------- player actions (optimistic) ---------------- */
function doPick(mid,sid,choice){
  const m=DATA.matches.find(x=>x.id===mid);if(!m)return;
  let p=m.picks.find(x=>x.role===me()&&x.slotId===sid);
  if(p&&p.lockedAt)return;
  if(!p){p={role:me(),slotId:sid,choice:'',lockedAt:'',updatedAt:''};m.picks.push(p);}
  p.choice=choice;renderBouts();
  queue(()=>rpc('submitPick',TOKEN,{matchId:mid,slotId:sid,choice})).then(settle,failed);
}
function doLock(mid,sid){
  const m=DATA.matches.find(x=>x.id===mid);if(!m)return;
  const p=m.picks.find(x=>x.role===me()&&x.slotId===sid);
  if(!p||!p.choice||p.lockedAt)return;
  const choice=p.choice;
  p.lockedAt=new Date().toISOString();m.lockProgress[me()]=(m.lockProgress[me()]||0)+1;
  fresh.slam.add(me()+':'+mid+':'+sid);
  toast('Pick locked.');renderBouts();renderHero(false);
  queue(async()=>{
    await rpc('submitPick',TOKEN,{matchId:mid,slotId:sid,choice});
    await rpc('lockPick',TOKEN,{matchId:mid,slotId:sid});
  }).then(settle,failed);
}

/* ---------------- admin actions ---------------- */
function arm(key,fn){
  if(armKey===key){armKey='';clearTimeout(armTimer);fn();renderBouts();renderFinish();return;}
  armKey=key;clearTimeout(armTimer);
  armTimer=setTimeout(()=>{armKey='';renderBouts();renderFinish();},4000);
  renderBouts();renderFinish();
}
function doWinner(mid,choice){
  const E=curEvent(),m=DATA.matches.find(x=>x.id===mid);if(!E||!m||m.winner===choice)return;
  const scorers=new Set();m.winner=choice;
  m.slots.forEach(s=>PLAYERS.forEach(r=>{const p=pickOf(r,m,s);if(p.lockedAt&&p.choice===choice){fresh.hit.add(r+':'+m.id+':'+s.id);scorers.add(r);}}));
  DATA.scores[E.id]=localScores(E);
  renderBouts();renderFinish();updateScores();toast('Winner recorded. Scores updated.');fireConfetti(scorers);
  queue(()=>rpc('setMatchWinner',TOKEN,{matchId:mid,winner:choice})).then(settle,failed);
}
function doFinish(){
  const E=curEvent();if(!E)return;
  toast('Finishing event...');
  queue(()=>rpc('completeEvent',TOKEN,E.id)).then(()=>{toast('Event completed.');return refresh();},failed);
}

/* ---------------- admin drawer ---------------- */
let chips=[];
const parseSlots=v=>{const a=String(v).split(',').map(x=>Number(x.trim()));return a.length&&a.length<=6&&a.every(n=>Number.isInteger(n)&&n>=1&&n<=10)?a:null;};
function openDrawer(tab){
  $('drawer').classList.add('open');$('scrim').classList.add('open');
  drawerTab(tab||'event');
}
function closeDrawer(){$('drawer').classList.remove('open');$('scrim').classList.remove('open');}
function drawerTab(tab){
  $('tabEvent').classList.toggle('active',tab==='event');$('tabMatch').classList.toggle('active',tab==='match');
  show('createEventForm',tab==='event');show('createMatchForm',tab==='match');
  if(tab==='match'){
    const open=DATA?DATA.events.filter(e=>e.status==='OPEN').sort((a,b)=>dateVal(a)-dateVal(b)):[];
    $('matchEvent').innerHTML=open.length?open.map(e=>'<option value="'+esc(e.id)+'"'+(e.id===selId?' selected':'')+'>'+esc(e.title)+'</option>').join(''):'<option value="">No open events. Create one first.</option>';
    renderChips();
  }
}
function addChips(text){
  String(text).split(/[\n,]/).map(x=>x.trim().slice(0,90)).filter(Boolean).forEach(c=>{if(!chips.includes(c)&&chips.length<30)chips.push(c);});
  renderChips();
}
function renderChips(){
  $('mTags').innerHTML=chips.map((c,i)=>'<span class="tag">'+esc(c)+'<button type="button" data-act="rmchip" data-i="'+i+'" aria-label="Remove '+esc(c)+'">×</button></span>').join('');
  show('mWarn',/\bvs\.?\b/i.test($('mInput').value+' '+chips.join(' ')));
  const sl=parseSlots($('matchSlots').value);
  $('mPreview').innerHTML=sl?'<small class="muted" style="width:100%">Each player gets one pick per ticket</small>'+sl.map(n=>'<span>×'+n+'</span>').join(''):'<small class="note bad">Use whole numbers from 1 to 10, up to six, like 3,2</small>';
  $('mSubmit').disabled=!($('matchTitle').value.trim()&&chips.length>=2&&sl&&$('matchEvent').value);
}
async function createEvent(ev){
  if(ev)ev.preventDefault();
  const status=$('createEventStatus');status.className='note warn';status.textContent='Saving event...';
  console.info('[Prediction Championship] Create Event handler called');
  try{
    if(!TOKEN)throw Error('Not signed in.');
    const data={title:$('eventTitle').value.trim(),eventDate:$('eventDate').value,location:$('eventLocation').value.trim(),titleOnLine:$('titleOnLine').checked};
    const created=await queue(()=>rpc('saveEvent',TOKEN,data));
    if(!created||!created.id)throw Error('API did not confirm an event ID. Verify PC_EVENTS before retrying.');
    status.className='note ok';status.textContent='Event saved. ID: '+created.id;
    console.info('[Prediction Championship] Event saved:',created.id);
    $('createEventForm').reset();selId=created.id;await refresh(true);
  }catch(e){
    const message='Event NOT saved: '+(e.message||String(e));
    status.className='note bad';status.textContent=message;console.error('[Prediction Championship] '+message,e);
  }
}
async function createMatch(ev){
  if(ev)ev.preventDefault();
  const status=$('createMatchStatus');status.className='note warn';status.textContent='Adding match...';
  try{
    if(!TOKEN)throw Error('Not signed in.');
    const data={eventId:$('matchEvent').value,title:$('matchTitle').value.trim(),choices:chips.join(', '),slots:$('matchSlots').value};
    await queue(()=>rpc('saveMatch',TOKEN,data));
    status.className='note ok';status.textContent='Match added. Players may now predict.';
    $('matchTitle').value='';chips=[];$('matchSlots').value='1';selId=data.eventId||selId;renderChips();await refresh(true);
    toast('Match added. Players can pick now.');
  }catch(e){status.className='note bad';status.textContent='Match NOT added: '+(e.message||String(e));}
}

/* ---------------- hold to lock ---------------- */
let hold=null;
function endHold(){if(pendingRender){pendingRender=false;renderBouts();}}
function startHold(b){
  if(hold||b.disabled)return;
  b.classList.add('holding');
  hold={b,t:setTimeout(()=>{const {m,s}=b.dataset;hold=null;doLock(m,s);endHold();},900)};
}
function cancelHold(){if(!hold)return;clearTimeout(hold.t);hold.b.classList.remove('holding');hold=null;endHold();}
document.addEventListener('pointerdown',e=>{const b=e.target.closest&&e.target.closest('.hold');if(b)startHold(b);});
window.addEventListener('pointerup',cancelHold);window.addEventListener('pointercancel',cancelHold);
document.addEventListener('pointerout',e=>{if(hold&&e.target===hold.b&&!hold.b.contains(e.relatedTarget))cancelHold();});
document.addEventListener('keydown',e=>{
  const b=e.target.closest&&e.target.closest('.hold');
  if(b&&(e.key===' '||e.key==='Enter')){e.preventDefault();if(!e.repeat)startHold(b);}
  if(e.key==='Escape')closeDrawer();
});
document.addEventListener('keyup',e=>{if(e.key===' '||e.key==='Enter')cancelHold();});
document.addEventListener('contextmenu',e=>{if(e.target.closest&&e.target.closest('.hold'))e.preventDefault();});

/* ---------------- fighter card tilt ---------------- */
let tiltEl=null;
const resetTilt=f=>{const i=f.querySelector('.fc-in');['--rx','--ry','--shine'].forEach(p=>i.style.removeProperty(p));};
document.addEventListener('pointermove',e=>{
  if(reduced)return;const f=e.target.closest&&e.target.closest('.fcard');
  if(tiltEl&&tiltEl!==f){resetTilt(tiltEl);tiltEl=null;}
  if(!f)return;tiltEl=f;
  const r=f.getBoundingClientRect(),x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height,i=f.querySelector('.fc-in');
  i.style.setProperty('--rx',((.5-y)*10)+'deg');i.style.setProperty('--ry',((x-.5)*12)+'deg');
  i.style.setProperty('--sx',(x*100)+'%');i.style.setProperty('--sy',(y*100)+'%');i.style.setProperty('--shine',.3);
});

/* ---------------- wiring ---------------- */
document.addEventListener('click',e=>{
  const b=e.target.closest&&e.target.closest('[data-act]');if(!b)return;
  const a=b.dataset.act;
  if(a==='pick')doPick(b.dataset.m,b.dataset.s,b.dataset.c);
  else if(a==='win')arm('win:'+b.dataset.m+':'+b.dataset.c,()=>doWinner(b.dataset.m,b.dataset.c));
  else if(a==='event'){
    if(b.dataset.id===selId)return;
    selId=b.dataset.id;shown=scoreOf(curEvent());fresh={flip:new Set(),slam:new Set(),hit:new Set()};
    renderHero(false);renderEvents();renderBouts();renderHistory();renderFinish();updateScores();window.scrollTo({top:0,behavior:reduced?'auto':'smooth'});
  }
  else if(a==='rmchip'){chips.splice(Number(b.dataset.i),1);renderChips();}
});
$('loginTab').addEventListener('click',()=>switchAuth('login'));
$('signupTab').addEventListener('click',()=>switchAuth('signup'));
$('authForm').addEventListener('submit',submitAuth);
$('logout').addEventListener('click',logOut);
$('adminBtn').addEventListener('click',()=>openDrawer('event'));
$('dclose').addEventListener('click',closeDrawer);
$('scrim').addEventListener('click',closeDrawer);
$('tabEvent').addEventListener('click',()=>drawerTab('event'));
$('tabMatch').addEventListener('click',()=>drawerTab('match'));
$('finishBtn').addEventListener('click',()=>{const E=curEvent();if(E)arm('finish:'+E.id,doFinish);});
$('createEventForm').addEventListener('submit',createEvent);
$('createMatchForm').addEventListener('submit',createMatch);
const mInput=$('mInput');
mInput.addEventListener('keydown',e=>{
  if(e.key==='Enter'||e.key===','){e.preventDefault();addChips(mInput.value);mInput.value='';}
  else if(e.key==='Backspace'&&!mInput.value&&chips.length){chips.pop();renderChips();}
});
mInput.addEventListener('input',renderChips);
mInput.addEventListener('paste',e=>{e.preventDefault();addChips((e.clipboardData||window.clipboardData).getData('text'));});
mInput.addEventListener('blur',()=>{if(mInput.value.trim()){addChips(mInput.value);mInput.value='';}});
$('matchTitle').addEventListener('input',renderChips);
$('matchSlots').addEventListener('input',renderChips);
$('matchEvent').addEventListener('change',renderChips);

/* Polling: faster while you are waiting on the other player, slower when nothing can change. */
function pollDelay(){
  if(!DATA)return 6000;
  const E=curEvent();
  if(!E||E.status!=='OPEN')return 25000;
  return isWaiting()?4000:9000;
}
async function pollLoop(){
  if(TOKEN&&DATA&&!document.hidden&&!pending)await refresh();
  setTimeout(pollLoop,pollDelay());
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&TOKEN&&DATA&&!pending)refresh();});

if(TOKEN){const m=$('authMsg');m.className='note warn';m.textContent='Restoring your session...';refresh().then(ok=>{if(ok)$('authMsg').textContent='';});}
setTimeout(pollLoop,6000);

// Safe diagnostic (do not paste tokens in the Console):
async function pcCheckAdmin(){
  const state=await rpc('checkSession',TOKEN);
  console.log('[Prediction Championship] Session permissions',state);
  return state;
}