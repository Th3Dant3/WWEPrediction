'use strict';
/* PREDICTION CHAMPIONSHIP — frontend
 * Backend contract (Apps Script actions: loginAccount, getDashboard, submitPick,
 * lockPick, lockSpend, rollBoosts, setMatchWinner, completeEvent, saveEvent, setEventRules, saveMatch,
 * updateMatch, deleteMatch, registerAccount, logoutAccount).
 * Scoring rules v3 (advantage bank with limit, title spend, boosts, Royal Rumble) are computed on the server;
 * this file only displays them and sends the player's actions.
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
const RULE_TEXT={
  TITLE:'WWE PLE, Top (title match): correct picks earn points, and a boosted pick counts double. Before results start, each player places advantage on matches: Wild Card (+1) or X2 (+2) when their pick is right, or a cash-in, interference or something they write (+1 if it happens, even if their pick is wrong). Each placement costs 1 advantage and is used up. The higher total (picks plus bonuses) takes the title, and the player who loses it earns +1 advantage.',
  NON_TITLE:'WWE PLE, Mid: the winner earns +2 advantage, the loser +1, and a draw gives +1 each. These points stop at 4 held before a title event.',
  LOW:'WWE PLE, Low: the winner earns +1 advantage, the loser and a draw earn 0. These points count toward the limit of 4.',
  NON_WWE:'Non-WWE event: the winner earns +1 advantage, outside the 4-point limit.'};
const SUMMARY={
  TITLE:'Scoring: title match. Spend advantage, the higher total takes the title.',
  NON_TITLE:'Scoring: winner +2, loss +1, draw +1 each.',
  LOW:'Scoring: winner +1, loss 0, draw 0.',
  NON_WWE:'Scoring: winner +1, outside the limit of 4.'};
/* The check marks: promotion + level + "one night of a two-night event" decide the scoring type.
   The server makes the same decision (pcRulesFrom_) and has the final say. */
function kindFrom(c){
  if(c.promotion==='OTHER')return 'NON_WWE';
  if(c.promotion==='AAA')return 'LOW';
  if(c.promotion==='WWE'){if(c.twoNight)return 'LOW';return{TOP:'TITLE',MID:'NON_TITLE',LOW:'LOW'}[c.tier]||'';}
  return '';
}
function eventLabel(E){
  if(!E||!E.eventType)return 'Scoring not set';
  const p=E.promotion||(E.eventType==='NON_WWE'?'OTHER':'WWE');
  if(p==='AAA')return E.twoNight?'AAA PLE, one night of two':'AAA PLE';
  if(p==='OTHER')return 'Non-WWE event';
  if(E.twoNight)return 'WWE PLE, one night of two';
  return 'WWE PLE, '+({TITLE:'Top (title match)',NON_TITLE:'Mid',LOW:'Low'}[E.eventType]||'');
}
function ruleText(E){
  if(!E||!E.eventType)return isAdmin()?'Tick the promotion and level below before finishing this event.':'The scoring for this event is not set yet.';
  const p=E.promotion||(E.eventType==='NON_WWE'?'OTHER':'WWE');
  if(E.twoNight)return 'One night of a two-night event: the winner of this night earns +1 advantage, the loser and a draw earn 0. Each night is its own event. These points count toward the limit of 4.';
  if(p==='AAA')return 'AAA PLE: the winner earns +1 advantage, the loser and a draw earn 0. These points count toward the limit of 4.';
  return RULE_TEXT[E.eventType]||'';
}
function buildChecks(p){
  const c=(id,kind,val,label)=>'<label class="f check"><input type="checkbox" id="'+p+'_'+id+'" data-check="'+p+'" data-kind="'+kind+'" data-val="'+val+'"> '+label+'</label>';
  $(p+'Checks').innerHTML='<fieldset class="checks"><legend>Event</legend>'+c('promo_WWE','promo','WWE','WWE PLE')+c('promo_AAA','promo','AAA','AAA PLE')+c('promo_OTHER','promo','OTHER','Other non-WWE event')+'</fieldset>'+
    '<fieldset class="checks"><legend>WWE PLE level</legend>'+c('tier_TOP','tier','TOP','Top: title match')+c('tier_MID','tier','MID','Mid: winner 2, loss 1, draw 1')+c('tier_LOW','tier','LOW','Low: winner 1, loss 0, draw 0')+'</fieldset>'+
    c('night','night','1','One night of a two-night event (winner +1)')+'<p class="hint" id="'+p+'_sum"></p>';
  syncChecks(p);
}
function readChecks(p){
  const g=id=>!!$(p+'_'+id).checked;
  return{promotion:['WWE','AAA','OTHER'].find(v=>g('promo_'+v))||'',tier:['TOP','MID','LOW'].find(v=>g('tier_'+v))||'',twoNight:g('night')};
}
function writeChecks(p,c){
  ['WWE','AAA','OTHER'].forEach(v=>{$(p+'_promo_'+v).checked=c.promotion===v;});
  ['TOP','MID','LOW'].forEach(v=>{$(p+'_tier_'+v).checked=c.tier===v;});
  $(p+'_night').checked=!!c.twoNight;
  syncChecks(p);
}
function syncChecks(p){
  const c=readChecks(p),tiersOn=c.promotion==='WWE'&&!c.twoNight;
  ['TOP','MID','LOW'].forEach(v=>{const b=$(p+'_tier_'+v);b.disabled=!tiersOn;if(!tiersOn)b.checked=false;});
  $(p+'_night').disabled=!c.promotion;
  const k=kindFrom(readChecks(p));
  $(p+'_sum').textContent=k?(c.promotion==='AAA'?'Scoring: AAA PLE, winner +1.':SUMMARY[k]):(c.promotion==='WWE'?'Choose Top, Mid or Low, or tick the two-night box.':'Tick WWE PLE, AAA PLE or Other non-WWE event.');
}
function onCheck(p,t){
  if(t.checked){
    if(t.dataset.kind==='promo')['WWE','AAA','OTHER'].forEach(v=>{if(v!==t.dataset.val)$(p+'_promo_'+v).checked=false;});
    if(t.dataset.kind==='tier')['TOP','MID','LOW'].forEach(v=>{if(v!==t.dataset.val)$(p+'_tier_'+v).checked=false;});
  }
  syncChecks(p);
}
const GENERAL_RULES='Calling the winner of every match earns +1 advantage, outside the limit. Each match gives 1 pick, or 2 when there are 6 or more choices. The Royal Rumble has 2 winner picks and 4 final-four predictions, and Dante and Trigger type the wrestler names themselves.';
/* What a placement of advantage can be. The server uses the same keys and values. */
const MODE={
  WILD:{label:'Wild Card',desc:'+1 if your pick in that match is right'},
  X2:{label:'X2',desc:'+2 if your pick in that match is right'},
  CASHIN:{label:'Cash-in happens',desc:'+1 if it happens, even if your pick is wrong'},
  INTERFERENCE:{label:'Interference happens',desc:'+1 if it happens, even if your pick is wrong'},
  CUSTOM:{label:'Something else (write it)',desc:'+1 if it happens, even if your pick is wrong'}};
const propKey=a=>a.k==='CUSTOM'?'CUSTOM:'+normName(a.t):a.k;
const fmtEdge=n=>(n>0?'+':'')+n;
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
/* ---- Eastern Time (America/New_York: EST in winter, EDT in summer) ---- */
const ET='America/New_York';
const etFmt=new Intl.DateTimeFormat('en-US',{timeZone:ET,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
function etParts(t){const o={};etFmt.formatToParts(new Date(t)).forEach(p=>{o[p.type]=p.value;});return{y:+o.year,mo:+o.month,d:+o.day,h:(+o.hour)%24,mi:+o.minute};}
/** The instant (ms) when the Eastern Time wall clock reads y-mo-d h:mi. Handles the spring/fall clock changes. */
function etInstant(y,mo,d,h,mi){
  const want=Date.UTC(y,mo-1,d,h,mi);let t=want;
  for(let i=0;i<3;i++){const p=etParts(t);t+=want-Date.UTC(p.y,p.mo-1,p.d,p.h,p.mi);}
  return t;
}
const fmtTimeET=t=>new Intl.DateTimeFormat('en-US',{timeZone:ET,hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(t));
/** When an event starts: {t, exact}. With no start time it falls back to the start of the date (exact:false). */
function startOf(E){
  const d=parseDate(E.eventDate);if(!d)return null;
  const y=d.getFullYear(),mo=d.getMonth()+1,dd=d.getDate(),hm=/^(\d{2}):(\d{2})$/.exec(E.startTime||'');
  return hm?{t:etInstant(y,mo,dd,+hm[1],+hm[2]),exact:true}:{t:etInstant(y,mo,dd,0,0),exact:false};
}
function saveQuickTime(){
  const E=curEvent();if(!E||!isAdmin())return;
  const t=$('cdTime').value;
  if(!/^\d{2}:\d{2}$/.test(t)){toast('Pick a start time first (Eastern Time).','err');return;}
  const d=parseDate(E.eventDate),date=d?d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()):E.eventDate;
  E.startTime=t;renderHero(false);tickCountdown();toast('Start time saved.');
  queue(()=>rpc('updateEvent',TOKEN,{eventId:E.id,title:E.title,eventDate:date,startTime:t,location:E.location||''})).then(settle,failed);
}
function whenText(E){const st=startOf(E);return fmtDate(E.eventDate)+(st&&st.exact?', '+fmtTimeET(st.t):'');}
const nowFmt=new Intl.DateTimeFormat('en-US',{timeZone:ET,weekday:'short',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'});
const dayFmt=new Intl.DateTimeFormat('en-US',{timeZone:ET,weekday:'short',month:'short',day:'numeric',year:'numeric'});
/** The live "right now" clock, always in Eastern Time. */
function tickClock(){$('etClock').textContent='Eastern Time: '+nowFmt.format(new Date());}
const startLine=(st,verb)=>verb+' '+dayFmt.format(new Date(st.t))+(st.exact?', '+fmtTimeET(st.t):' (time not set)');
const cdUnit=(v,l)=>'<span class="cd-unit"><b>'+(l==='days'||l==='day'?v:String(v).padStart(2,'0'))+'</b><i>'+l+'</i></span>';
function tickCountdown(){
  const E=DATA?curEvent():null;
  const st=E&&E.status==='OPEN'?startOf(E):null;
  show('countdown',!!st);
  if(!st){$('bugCd').textContent='';return;}
  const now=Date.now(),diff=st.t-now;
  $('cdWhen').textContent=startLine(st,diff>0?'Starts':'Started');
  const setter=!st.exact&&isAdmin();
  show('cdSet',setter);show('cdHint',setter);
  if(setter)$('cdHint').textContent='Set the start time (Eastern Time) for an exact countdown:';
  $('countdown').classList.toggle('live',diff<=0);
  if(diff>0){
    const s=Math.floor(diff/1000),p={d:Math.floor(s/86400),h:Math.floor(s%86400/3600),m:Math.floor(s%3600/60),s:s%60};
    if(st.exact){
      $('cdLabel').textContent='Starts in';
      $('cdUnits').innerHTML=cdUnit(p.d,'days')+cdUnit(p.h,'hrs')+cdUnit(p.m,'min')+cdUnit(p.s,'sec');
      $('bugCd').textContent=p.d>0?p.d+'d '+pad2(p.h)+'h '+pad2(p.m)+'m':pad2(p.h)+':'+pad2(p.m)+':'+pad2(p.s);
    }else{
      const days=Math.ceil(diff/86400000);
      $('cdLabel').textContent='Starts in (date only)';
      $('cdUnits').innerHTML=cdUnit(days,days===1?'day':'days');
      $('bugCd').textContent=days+(days===1?' day':' days');
    }
  }else{
    const hrs=(now-st.t)/3600000;
    $('cdLabel').textContent=st.exact?(hrs<10?'Live now':'Started '+fmtDate(E.eventDate)):'Event day';
    $('cdUnits').innerHTML='';
    $('bugCd').textContent=st.exact&&hrs<10?'Live':'';
  }
}
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
/** Rumble names are typed by the players, so compare them ignoring case, accents, punctuation and extra spaces. */
const normName=s=>String(s==null?'':s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const sameName=(m,a,b)=>m.matchType==='RUMBLE'?normName(a)===normName(b):a===b;
function localScores(e){
  const t={DANTE:0,TRIGGER:0};
  matchesOf(e).forEach(m=>{
    if(!m.winner)return;
    PLAYERS.forEach(r=>m.slots.forEach(s=>{
      const p=pickOf(r,m,s);if(!p.lockedAt)return;
      if(s.group==='F'){if((m.finalFour||[]).some(x=>sameName(m,x,p.choice)))t[r]+=Number(s.points)||0;}
      else if(sameName(m,p.choice,m.winner))t[r]+=Number(s.points)||0;
    }));
  });
  return t;
}
function isWaiting(){
  const E=curEvent();if(!E||E.status!=='OPEN'||!PLAYERS.includes(me()))return false;
  if(E.spend&&E.spend[me()]&&E.spend[me()].locked&&!PLAYERS.every(r=>E.spend[r].locked))return true;
  if(matchesOf(E).some(m=>m.pending))return true; // a result is waiting for someone to confirm
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
  const pe=prev.events.find(x=>x.id===E.id),ne=next.events.find(x=>x.id===E.id);
  if(pe&&ne&&pe.status==='OPEN'&&ne.status==='COMPLETED'){
    if(ne.result&&ne.result.transfer){toast('New champion: '+(NAME[ne.result.transfer.to]||ne.result.transfer.to)+'!');fireConfetti(new Set([ne.result.transfer.to]));}
    else toast('Event finished. Advantage awarded.');
    return;
  }
  const bothSpend=ev=>!!(ev&&ev.spend&&PLAYERS.every(r=>ev.spend[r].locked&&ev.spend[r].amount!==null));
  const spendRevealed=!bothSpend(pe)&&bothSpend(ne);
  if(spendRevealed)PLAYERS.forEach(r=>{if(r!==role)fresh.flip.add('spend:'+r);});
  const boostsOpened=!!(pe&&ne&&!pe.picksOpen&&ne.picksOpen);
  let proposed=null,cleared=null;
  matchesOf(E).forEach(m=>{
    const pm=prev.matches.find(x=>x.id===m.id);if(!pm)return;
    if(!pm.pending&&m.pending&&m.pending.by!==role)proposed=m;
    if(pm.pending&&!m.pending&&!m.winner)cleared=m;
  });
  if(proposed&&!resultMatch){toast(NAME[proposed.pending.by]+' recorded a result for "'+proposed.title+'". Confirm it or dispute it.');return;}
  if(cleared&&!resultMatch){toast('The proposed result for "'+cleared.title+'" was cleared. Record it again.');return;}
  if(resultMatch){toast('Result in: '+resultMatch.winner+' wins.');fireConfetti(scorers);}
  else if(spendRevealed)toast('Both spends locked. Revealed.');
  else if(revealed)toast('Both locked. Picks revealed.');
  else if(boostsOpened&&role!=='ADMIN')toast('Boosts rolled. Picks are open.');
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
  $('knownNames').innerHTML=(DATA.knownNames||[]).map(n=>'<option value="'+esc(n)+'"></option>').join('');
  renderHero(first);renderEvents();renderRules();renderResult();renderBouts();renderHistory();renderFinish();
  if(first){shown={DANTE:0,TRIGGER:0};setTimeout(updateScores,1200);}else updateScores();
}
function pipsHtml(n){const total=Math.max(5,Math.min(10,n));return Array.from({length:total},(_,i)=>'<i class="'+(i<n?'on':'')+'"></i>').join('');}
function renderHero(first){
  const E=curEvent(),adv=DATA.advantage||{DANTE:0,TRIGGER:0};
  const title=E?E.title:'No event yet';
  const evEl=$('evt');
  if(evEl.textContent!==title){evEl.textContent=title;if(!first){evEl.classList.remove('replay');void evEl.offsetWidth;evEl.classList.add('replay');}}
  if(first)evEl.classList.add('replay');
  $('bugTitle').textContent=title;
  $('evMeta').textContent=E?(whenText(E)+(E.location?' in '+E.location:'')+'. '+eventLabel(E)+(E.eventType==='TITLE'?', title on the line.':'.')):'The administrator can create the first event.';
  const st=$('evStatus');st.classList.toggle('hidden',!E);
  if(E){st.textContent=E.status==='COMPLETED'?'Completed':'Open for predictions';st.className='evstatus '+(E.status==='COMPLETED'?'done':'open');}
  $('advD').textContent=adv.DANTE;$('advT').textContent=adv.TRIGGER;
  $('pips-DANTE').innerHTML=pipsHtml(Number(adv.DANTE)||0);$('pips-TRIGGER').innerHTML=pipsHtml(Number(adv.TRIGGER)||0);
  PLAYERS.forEach(r=>$('champ-'+r).classList.toggle('hidden',String(DATA.champion).toUpperCase()!==r));
  const prevDone=DATA.events.filter(e=>e.status==='COMPLETED'&&(!E||e.id!==E.id)).sort((a,b)=>dateVal(b)-dateVal(a))[0];
  show('rowLast',!!prevDone);
  if(prevDone){const s=scoreOf(prevDone);$('lastLabel').textContent=prevDone.title;$('lastD').textContent=s.DANTE;$('lastT').textContent=s.TRIGGER;}
  edgeRow(E);tickCountdown();
  const ms=matchesOf(E);
  PLAYERS.forEach(r=>$('lk-'+r).textContent=ms.reduce((n,m)=>n+(m.lockProgress[r]||0),0));
}
function edgeRow(E){
  const lab=$('edgeLabel'),d=$('evEdgeD'),t=$('evEdgeT');
  if(!E){lab.textContent='Advantage this event';d.textContent=t.textContent='-';return;}
  if(E.status==='COMPLETED'){
    const r=E.result;
    if(r&&r.net){lab.textContent='Advantage earned';d.textContent=fmtEdge(r.net.DANTE);t.textContent=fmtEdge(r.net.TRIGGER);}
    else if(r&&r.edge){lab.textContent='Advantage earned';d.textContent=fmtEdge(r.edge.DANTE.edge);t.textContent=fmtEdge(r.edge.TRIGGER.edge);}
    else{const s=scoreOf(E);lab.textContent='Advantage earned (old rule)';d.textContent=s.DANTE>s.TRIGGER?'+1':'0';t.textContent=s.TRIGGER>s.DANTE?'+1':'0';}
    return;
  }
  const pv=(DATA.preview||{})[E.id];
  if(E.eventType==='TITLE'){
    lab.textContent='Title total (picks + bonus)';
    d.textContent=pv?pv.DANTE:'-';t.textContent=pv?pv.TRIGGER:'-';return;
  }
  lab.textContent='Advantage if it ended now';
  d.textContent=pv?fmtEdge(pv.DANTE):'-';t.textContent=pv?fmtEdge(pv.TRIGGER):'-';
}
function renderRules(){
  const E=curEvent(),bar=$('rulesBar'),ms=matchesOf(E);
  show('rulesNote',!!E);
  if(E){
    const t=ruleText(E);
    $('rulesNote').textContent=t+' '+GENERAL_RULES;
  }
  const bn=$('boostNote'),showBoost=!!(E&&E.status==='OPEN'&&ms.length);
  show('boostNote',showBoost);
  if(showBoost){
    bn.textContent=E.boost?('Boosts are live: '+E.boost.count+' boosted pick'+(E.boost.count===1?'':'s')+' across '+E.boost.matches+' matches, shown with a gold x2 on the card. Picks are open.')
      :E.picksOpen?'This event was already in progress, so it keeps its original pick values.'
      :isAdmin()?'Picks are closed. Press Roll boosts below to open them. The number of boosts depends on the number of matches.'
      :'Picks are closed. Waiting for the administrator to roll the boosts. Picks open as soon as they do, and this page updates by itself.';
    bn.classList.toggle('alert',!E.boost&&!E.picksOpen);
  }
  const showBar=!!(isAdmin()&&E&&E.status==='OPEN');
  show('rulesBar',showBar);
  if(showBar){
    const key=E.id+'|'+E.eventType+'|'+E.promotion+'|'+E.tier+'|'+E.twoNight;
    if(bar.dataset.key!==key){bar.dataset.key=key;writeChecks('rb',{promotion:E.promotion||'',tier:E.tier||'',twoNight:!!E.twoNight});}
    const lockedAny=ms.some(m=>((m.lockProgress.DANTE||0)+(m.lockProgress.TRIGGER||0))>0),won=ms.some(m=>m.winner);
    show('rollBtn',ms.length>0&&!lockedAny&&!won);
    $('rollBtn').textContent=E.boost?'Re-roll boosts':'Roll boosts';
  }
}
function saveRules(ev){
  if(ev)ev.preventDefault();
  const E=curEvent();if(!E||E.status!=='OPEN')return;
  const c=readChecks('rb'),kind=kindFrom(c);
  if(!kind){toast(c.promotion==='WWE'?'Choose Top, Mid or Low, or tick the two-night box.':'Tick WWE PLE, AAA PLE or Other non-WWE event first.','err');return;}
  E.eventType=kind;E.promotion=c.promotion;E.tier=c.promotion==='WWE'&&!c.twoNight?c.tier:'';E.twoNight=c.twoNight;E.titleOnLine=kind==='TITLE';
  if(DATA.preview)delete DATA.preview[E.id];
  $('rulesBar').dataset.key=E.id+'|'+E.eventType+'|'+E.promotion+'|'+E.tier+'|'+E.twoNight;
  renderHero(false);renderRules();renderFinish();renderBouts();toast('Event saved.');
  queue(()=>rpc('setEventRules',TOKEN,{eventId:E.id,promotion:c.promotion,tier:c.tier,twoNight:c.twoNight})).then(settle,failed);
}
function doRoll(){
  const E=curEvent();if(!E)return;
  toast('Rolling boosts...');
  queue(()=>rpc('rollBoosts',TOKEN,{eventId:E.id})).then(r=>{toast('Boosts rolled: '+r.count+' boosted pick'+(r.count===1?'':'s')+'.');return refresh(true);},failed);
}
function renderResult(){
  const E=curEvent(),box=$('resultBox'),nm=x=>NAME[x]||x;
  if(!E||E.status!=='COMPLETED'){show('resultBox',false);return;}
  show('resultBox',true);
  const r=E.result;
  if(!r){box.innerHTML='<h3 class="display">Final result</h3><p class="muted" style="margin:0">This event was scored under the original rule: the event winner earned +1 advantage.</p>';return;}
  if(r.rules==='v3'&&r.delta){
    const col=(role,cls)=>{const a=r.delta[role];return '<div class="rescol '+cls+'"><span class="display">'+NAME[role]+'</span><b>'+fmtEdge(r.net[role])+' advantage</b><ul>'+(a.parts.length?a.parts.map(p=>'<li>'+fmtEdge(p.n)+' '+esc(p.why)+'</li>').join(''):'<li>No advantage earned</li>')+'</ul></div>';};
    let t='';
    if(r.kind==='TITLE'){
      const bn=r.bonus||r.spent;
      t='Title totals: Dante '+r.totals.DANTE+' (picks '+r.points.DANTE+' + bonus '+bn.DANTE+'), Trigger '+r.totals.TRIGGER+' (picks '+r.points.TRIGGER+' + bonus '+bn.TRIGGER+'). '+
        (r.transfer?nm(r.transfer.from)+' loses the title to '+nm(r.transfer.to)+' and earns +1 advantage.':nm(r.champion)+' keeps the title.');
    }
    let al='';
    if(r.allocations){
      const one=role=>{const list=r.allocations[role]||[];return list.length?'<li><b>'+NAME[role]+'</b>: '+list.map(a=>(MODE[a.k]?MODE[a.k].label:a.k)+(a.k==='CUSTOM'?' "'+esc(a.t)+'"':'')+' on '+esc(a.matchTitle||'a match')+(a.void?' (void)':' ('+fmtEdge(a.earned)+')')).join('; ')+'</li>':'';};
      const rows=one('DANTE')+one('TRIGGER');if(rows)al='<ul class="alloclist">'+rows+'</ul>';
    }
    box.innerHTML='<h3 class="display">Final result</h3><div class="resgrid">'+col('DANTE','d')+col('TRIGGER','t')+'</div>'+(t?'<p class="restitle">'+esc(t)+'</p>':'')+al;
    return;
  }
  // finished under the earlier v2 rules
  const col=(role,cls)=>{const a=r.edge[role];return '<div class="rescol '+cls+'"><span class="display">'+NAME[role]+'</span><b>'+fmtEdge(a.edge)+' advantage</b><ul>'+(a.parts.length?a.parts.map(p=>'<li>'+fmtEdge(p.n)+' '+esc(p.why)+'</li>').join(''):'<li>No advantage earned</li>')+'</ul></div>';};
  const tr=r.transfer;
  const t=E.titleOnLine?(tr?'Title changes hands: '+nm(tr.from)+' loses it to '+nm(tr.to)+(tr.consolation?' and earns 1 exclusive point.':(tr.penalty?' and drops '+tr.penalty+' point.':'.')):nm(r.champion)+' keeps the title.'):'';
  box.innerHTML='<h3 class="display">Final result</h3><div class="resgrid">'+col('DANTE','d')+col('TRIGGER','t')+'</div>'+(t?'<p class="restitle">'+esc(t)+'</p>':'');
}
function renderEvents(){
  const nav=$('events'),list=DATA.events.slice().sort((a,b)=>dateVal(b)-dateVal(a));
  show('events',list.length>1);
  nav.innerHTML=list.length>1?list.map(e=>'<button class="evpill" type="button" data-act="event" data-id="'+esc(e.id)+'" aria-pressed="'+(e.id===selId)+'"><i class="'+(e.status==='OPEN'?'open':'')+'"></i>'+esc(e.title)+'</button>').join(''):'';
}
function renderHistory(){
  const E=curEvent(),done=DATA.events.filter(e=>e.status==='COMPLETED'&&(!E||e.id!==E.id)).sort((a,b)=>dateVal(b)-dateVal(a));
  $('history').innerHTML=done.map(e=>{
    const s=scoreOf(e),r=e.result;let right;
    if(r&&r.net)right='Advantage: Dante '+fmtEdge(r.net.DANTE)+', Trigger '+fmtEdge(r.net.TRIGGER);
    else if(r&&r.edge)right='Advantage: Dante '+fmtEdge(r.edge.DANTE.edge)+', Trigger '+fmtEdge(r.edge.TRIGGER.edge);
    else right='Dante '+s.DANTE+', Trigger '+s.TRIGGER;
    return '<button class="hrow" type="button" data-act="event" data-id="'+esc(e.id)+'"><span><b>'+esc(e.title)+'</b> finished</span><span>'+right+'</span></button>';
  }).join('');
}
function renderFinish(){
  const E=curEvent(),b=$('finishBtn'),ok=isAdmin()&&E&&E.status==='OPEN';
  show('editEventBtn',isAdmin()&&!!E);
  b.classList.toggle('hidden',!ok);if(!ok)return;
  const ms=matchesOf(E),ready=ms.length>0&&ms.every(m=>m.winner)&&!!E.eventType;
  b.disabled=!ready;b.title=ready?'':(!E.eventType?'Set the event type first.':'Every match needs a winner first.');
  const armed=armKey==='finish:'+E.id;b.classList.toggle('armed',armed);
  b.textContent=armed?'Tap again to finish event':'Finish event';
}
/* allocDraft = the placements a player is building before locking; rumbleDraft also holds the result being entered */
let allocDraft=[],allocSel={m:'',k:'X2',t:''},allocFor='',rumbleDraft={};
function bankOf(role){const b=(DATA.bank&&DATA.bank[role])||{};const l=Number(b.limited)||0,x=Number(b.extra)||0;return{limited:l,extra:x,total:l+x};}
function renderSpend(E){
  const box=$('spendBox');
  const on=!!(E&&E.status==='OPEN'&&E.eventType==='TITLE'&&E.spend&&matchesOf(E).length);
  show('spendBox',on);if(!on)return;
  if(allocFor!==E.id){allocFor=E.id;allocDraft=[];allocSel={m:'',k:'X2',t:''};}
  const role=me(),mine=bankOf(role),ms=matchesOf(E);
  allocDraft=allocDraft.filter(a=>ms.some(m=>m.id===a.m));
  if(!allocSel.m||!ms.some(m=>m.id===allocSel.m))allocSel.m=ms[0]?ms[0].id:'';
  const both=PLAYERS.every(r=>E.spend[r].locked&&E.spend[r].allocs);
  const titleOf=id=>{const m=ms.find(x=>x.id===id);return m?esc(m.title):'(deleted match)';};
  const label=a=>titleOf(a.m)+': <b>'+esc(MODE[a.k]?MODE[a.k].label:a.k)+'</b>'+(a.k==='CUSTOM'?' "'+esc(a.t)+'"':'');
  const lane=r=>{
    const s=E.spend[r],bk=bankOf(r),own=r===role;let body;
    if(own&&!s.locked){
      const used=allocDraft.length,rows=allocDraft.map((a,i)=>'<li><span>'+label(a)+'</span><button type="button" class="xbtn" data-act="adel" data-i="'+i+'" aria-label="Remove this placement">×</button></li>').join('');
      body='<p class="who">Placed '+used+' of '+mine.total+'</p><ul class="alloclist">'+(rows||'<li class="muted">Nothing placed yet. Locking with nothing placed spends no advantage.</li>')+'</ul>'+
        '<div class="allocadd"><select class="in" data-act="amatch" aria-label="Match">'+ms.map(m=>'<option value="'+esc(m.id)+'"'+(m.id===allocSel.m?' selected':'')+'>'+esc(m.title)+'</option>').join('')+'</select>'+
        '<select class="in" data-act="amode" aria-label="What to place">'+Object.keys(MODE).map(k=>'<option value="'+k+'"'+(k===allocSel.k?' selected':'')+'>'+MODE[k].label+'</option>').join('')+'</select>'+
        (allocSel.k==='CUSTOM'?'<input class="in" data-act="atext" maxlength="60" placeholder="What will happen?" value="'+esc(allocSel.t)+'" autocomplete="off" aria-label="What will happen">':'')+
        '<button type="button" class="chip" data-act="aadd"'+(used>=mine.total?' disabled':'')+'>Add (costs 1)</button></div><p class="hint">'+esc(MODE[allocSel.k].label)+': '+MODE[allocSel.k].desc+'.</p>'+
        '<button class="hold" type="button" data-spend="1"><span>Hold to lock spend</span></button><p class="hint">Permanent once locked. Placed advantage is used up, even if a placement does not pay.</p>';
    }else if(s.locked&&s.allocs&&(own||both)){
      const rows=s.allocs.map(a=>'<li><span>'+label(a)+'</span></li>').join('');
      const plain=s.amount>0&&!s.allocs.length?'<li class="muted">'+s.amount+' advantage as plain bonus points (older style)</li>':'';
      body='<div class="spendval display'+(fresh.flip.has('spend:'+r)?' flip':'')+'">'+s.amount+'</div><div class="who">'+LOCK+' '+(s.auto?'Nothing to spend':'Locked')+'</div><ul class="alloclist">'+(rows||plain||(s.auto?'':'<li class="muted">Nothing placed</li>'))+'</ul>';
    }else{
      body='<div class="spendval sealedval display">?</div><div class="who">'+(s.locked?LOCK+' Locked in, sealed':'Still deciding')+'</div>';
    }
    return '<div class="spendlane '+r.toLowerCase()+'"><div class="lanehead"><span class="av"></span><span class="display">'+NAME[r]+'</span><span class="prog">holds '+bk.total+'</span></div>'+body+'</div>';
  };
  box.innerHTML='<h3 class="display">Place your advantage</h3><p>Put advantage on a match. Wild Card (+1) and X2 (+2) count when your pick in that match is right. A cash-in, interference or something you write counts +1 if the players confirm it happened, even if your pick was wrong. Each placement costs 1 and is used up. Your total is your correct picks plus these bonuses, and the higher total takes the title. '+
    (PLAYERS.includes(role)?'You hold '+mine.total+' ('+mine.limited+' inside the limit of 4, '+mine.extra+' outside it).':'')+'</p><div class="spendgrid">'+lane('DANTE')+lane('TRIGGER')+'</div>';
}
function renderBouts(){
  if(hold){pendingRender=true;return;}
  const ae=document.activeElement;
  if(ae&&ae.closest&&ae.closest('#bouts,#spendBox')&&/^(INPUT|SELECT)$/.test(ae.tagName)){pendingRender=true;return;} // keep what is being typed
  pendingRender=false;
  const E=curEvent(),box=$('bouts');
  renderSpend(E);
  if(!E){box.innerHTML='<div class="empty">No events yet. '+(isAdmin()?'Open Admin tools to create the first event.':'The administrator will add the first event soon.')+'</div>';}
  else{
    const ms=matchesOf(E);
    box.innerHTML=ms.length?ms.map(m=>bout(m,E)).join(''):'<div class="empty">Match card coming soon.'+(isAdmin()&&E.status==='OPEN'?' Add the first match in Admin tools.':'')+'</div>';
  }
  fresh={flip:new Set(),slam:new Set(),hit:new Set()};
}
function tile(role,m,s,j,E){
  const mine=role===me(),both=m.fullyLocked,key=role+':'+m.id+':'+s.id,p=pickOf(role,m,s),locked=!!p.lockedAt;
  const grp=s.group==='F'?'F':'W',boosted=grp==='W'&&Number(s.points)>1;
  const d='style="--d:'+(j*0.12+(role==='TRIGGER'?0.18:0)).toFixed(2)+'s"';
  const stubTxt=grp==='F'?'F':'×'+esc(s.points),sname='<span class="slotname">'+esc(s.name||'')+'</span>';
  let cls='ticket cut',face='',hit=false;
  if(!(both||mine)){
    const n=m.lockProgress[role]||0,all=n===m.slots.length;
    cls+=' sealed'+(all?' armed':n?' partial':'');
    face='<div class="stub display">'+stubTxt+'</div><div class="art">'+sname+'</div><div class="main"><div class="who">'+(all?LOCK+' Locked in':n?n+' of '+m.slots.length+' locked':'Still deciding')+'</div></div>';
  }else{
    hit=!!(m.winner&&locked&&(grp==='F'?(m.finalFour||[]).some(x=>sameName(m,x,p.choice)):sameName(m,p.choice,m.winner)));
    const miss=!!(m.winner&&locked&&!hit);
    if(locked)cls+=' done';if(miss)cls+=' miss';
    if(fresh.flip.has(key))cls+=' flip';if(fresh.slam.has(key))cls+=' slam';
    face='<div class="stub display">'+stubTxt+'</div><div class="art"><span class="ini display">'+esc(ini(p.choice))+'</span>'+sname+'</div>'+
      (hit?'<span class="badge'+(fresh.hit.has(key)?' pop':'')+'">+'+esc(s.points)+'</span>':'')+
      '<div class="main"><div class="who">'+(locked?LOCK+' Locked':(mine?'Draft':'Not locked'))+'</div><div class="pick display">'+esc(p.choice||'Not picked')+'</div></div>';
  }
  let picker='';
  if(mine&&!locked&&E.status==='OPEN'&&!m.winner){
    if(!E.picksOpen)picker='<p class="closednote">Picks are closed until the administrator rolls the boosts.</p>';
    else{
      const taken=new Set(m.slots.filter(x=>x.id!==s.id&&(x.group==='F'?'F':'W')===grp).map(x=>pickOf(role,m,x).choice));
      const rumbleM=m.matchType==='RUMBLE';
      const sel=rumbleM
        ?'<input class="in pickinput" list="knownNames" data-act="pickinput" data-m="'+esc(m.id)+'" data-s="'+esc(s.id)+'" data-cur="'+esc(p.choice||'')+'" value="'+esc(p.choice||'')+'" maxlength="60" placeholder="Type a wrestler name" autocomplete="off" aria-label="'+esc(s.name||'Wrestler')+'"><p class="hint">Type a name, then press Enter or tap away to save it.</p>'
      :m.choices.length>8
        ?'<select class="in pickselect" data-act="pickselect" data-m="'+esc(m.id)+'" data-s="'+esc(s.id)+'" aria-label="Choose a wrestler"><option value="">Choose a wrestler...</option>'+m.choices.map(c=>'<option value="'+esc(c)+'"'+(p.choice===c?' selected':'')+(taken.has(c)?' disabled':'')+'>'+esc(c)+'</option>').join('')+'</select>'
        :'<div class="chips">'+m.choices.map(c=>'<button class="chip'+(p.choice===c?' on':'')+'" type="button" data-act="pick" data-m="'+esc(m.id)+'" data-s="'+esc(s.id)+'" data-c="'+esc(c)+'"'+(taken.has(c)?' disabled':'')+'>'+esc(c)+'</button>').join('')+'</div>';
      picker=sel+'<button class="hold" type="button" data-m="'+esc(m.id)+'" data-s="'+esc(s.id)+'"'+(p.choice?'':' disabled')+'><span>'+(p.choice?'Hold to lock pick':(rumbleM?'Type a name first':'Choose a wrestler first'))+'</span></button>'+(p.choice?'<p class="hint">Permanent once locked.</p>':'');
    }
  }
  return '<div class="slotwrap"><div class="cardwrap'+(hit?' hit':'')+(boosted?' boosted':'')+'"><div class="'+cls+'" '+d+'><div class="face cut">'+face+'</div></div></div>'+picker+'</div>';
}
/** The wrestlers the players typed (each once, ignoring case/spacing) plus any the admin added. */
function rumblePool(m){
  const seen=new Map(),add=n=>{const t=String(n||'').replace(/\s+/g,' ').trim(),k=normName(t);if(k&&!seen.has(k))seen.set(k,t);};
  (m.picks||[]).forEach(p=>add(p.choice));
  const d=rumbleDraft[m.id];if(d)d.final.forEach(add);
  return Array.from(seen.values());
}
const draftOf=m=>rumbleDraft[m.id]||(rumbleDraft[m.id]={final:(m.finalFour||[]).slice(),winner:m.winner||'',props:(m.props||[]).slice()});
/** Predictions someone placed on this match that can be confirmed afterwards (cash-in, interference, written). */
function matchProps(m,E){
  const out=new Map();
  if(!E.spend)return [];
  PLAYERS.forEach(r=>{((E.spend[r]&&E.spend[r].allocs)||[]).forEach(a=>{
    if(a.m!==m.id||!(a.k==='CASHIN'||a.k==='INTERFERENCE'||a.k==='CUSTOM'))return;
    const k=propKey(a),label=a.k==='CASHIN'?'Cash-in':a.k==='INTERFERENCE'?'Interference':a.t;
    if(!out.has(k))out.set(k,{key:k,label,by:[r]});else out.get(k).by.push(r);
  });});
  return Array.from(out.values());
}
function formFoot(m,E,props){
  const d=draftOf(m),admin=isAdmin();
  let top;
  if(m.matchType==='RUMBLE'){
    const inFinal=c=>d.final.some(x=>normName(x)===normName(c));
    const ff=rumblePool(m).map(c=>'<button class="chip'+(inFinal(c)?' on':'')+'" type="button" data-act="rff" data-m="'+esc(m.id)+'" data-c="'+esc(c)+'">'+esc(c)+'</button>').join('')||'<span class="muted">No names yet.</span>';
    const wn=d.final.length?d.final.map(c=>'<button class="chip win'+(normName(d.winner)===normName(c)?' on':'')+'" type="button" data-act="rwin" data-m="'+esc(m.id)+'" data-c="'+esc(c)+'">'+esc(c)+'</button>').join(''):'<span class="muted">Choose the final four first.</span>';
    top='<div><span>Real final four ('+d.final.length+' of 4). Tap the names the players typed, or add another.</span><div class="chips">'+ff+'</div>'+
      '<div class="addname"><input class="in" id="rAdd_'+esc(m.id)+'" list="knownNames" maxlength="60" placeholder="Another wrestler (typed by neither player)" autocomplete="off"><button class="chip" type="button" data-act="radd" data-m="'+esc(m.id)+'">Add</button></div></div>'+
      '<div><span>Winner</span><div class="chips">'+wn+'</div></div>';
  }else{
    top='<div><span>Who won?</span><div class="chips">'+m.choices.map(c=>'<button class="chip win'+(d.winner===c?' on':'')+'" type="button" data-act="rwin" data-m="'+esc(m.id)+'" data-c="'+esc(c)+'">'+esc(c)+'</button>').join('')+'</div></div>';
  }
  const pr=props.length?'<div><span>Which predictions happened? (a bonus for whoever made them, even with a wrong pick)</span><div class="chips">'+props.map(x=>'<button class="chip'+(d.props.includes(x.key)?' on':'')+'" type="button" data-act="rprop" data-m="'+esc(m.id)+'" data-k="'+esc(x.key)+'">'+esc(x.label)+' ('+x.by.map(r=>NAME[r]).join(', ')+')</button>').join('')+'</div></div>':'';
  const armed=armKey==='rec:'+m.id;
  const label=admin?(armed?'Tap again to record (final)':'Record result (final)'):(armed?'Tap again to send':'Send for confirmation');
  const intro=admin?(m.winner?'Confirmed: '+esc(m.winner)+'. Record again to correct it.':'Record the result. As administrator it is final at once.'):'Record what happened. The other player has to confirm it before it counts.';
  return '<div class="foot rumble"><div class="muted">'+intro+'</div>'+top+pr+'<div><button class="finish'+(armed?' armed':'')+'" type="button" data-act="rrec" data-m="'+esc(m.id)+'">'+label+'</button></div></div>';
}
function pendingFoot(m,E,props){
  const p=m.pending,mine=p.by===me(),admin=isAdmin();
  const happened=props.filter(x=>(p.props||[]).includes(x.key)).map(x=>esc(x.label));
  const sum='<b>'+NAME[p.by]+'</b> says <b>'+esc(p.winner)+'</b> won.'+((p.finalFour&&p.finalFour.length)?' Final four: '+p.finalFour.map(esc).join(', ')+'.':'')+(props.length?' Happened: '+(happened.length?happened.join(', '):'none of the predictions')+'.':'');
  const armed=armKey==='cfm:'+m.id;
  let btns;
  if(admin)btns='<button class="finish'+(armed?' armed':'')+'" type="button" data-act="cfm" data-m="'+esc(m.id)+'">'+(armed?'Tap again to confirm':'Confirm as administrator')+'</button><button class="finish" type="button" data-act="rej" data-m="'+esc(m.id)+'">Clear it</button>';
  else if(mine)btns='<span class="muted">Waiting for '+OTHER[me()]+' to confirm.</span><button class="finish" type="button" data-act="rej" data-m="'+esc(m.id)+'">Withdraw</button>';
  else btns='<button class="finish'+(armed?' armed':'')+'" type="button" data-act="cfm" data-m="'+esc(m.id)+'">'+(armed?'Tap again to confirm':'Confirm this result')+'</button><button class="finish" type="button" data-act="rej" data-m="'+esc(m.id)+'">Dispute</button>';
  return '<div class="foot pending"><div>'+sum+'</div><div class="pbtns">'+btns+'</div></div>';
}
function resultFoot(m,E){
  if(E.status!=='OPEN')return '';
  const admin=isAdmin();if(!admin&&!PLAYERS.includes(me()))return '';
  const spendOk=!(E.eventType==='TITLE'&&E.spend&&!PLAYERS.every(r=>E.spend[r].locked));
  if(!m.fullyLocked)return '<div class="foot muted">Results unlock once both players lock every pick.</div>';
  if(!spendOk)return '<div class="foot muted">Results unlock once both players have locked their advantage spend.</div>';
  const props=matchProps(m,E);
  if(m.pending)return pendingFoot(m,E,props);
  if(m.winner&&!admin){
    const happened=props.filter(x=>(m.props||[]).includes(x.key)).map(x=>esc(x.label));
    return '<div class="foot"><span>Confirmed: <b>'+esc(m.winner)+'</b> won.'+(props.length?' Happened: '+(happened.length?happened.join(', '):'none of the predictions')+'.':'')+'</span></div>';
  }
  return formFoot(m,E,props);
}
function bout(m,E){
  const role=me(),n=m.slots.length,lp=m.lockProgress||{};
  const lanes=PLAYERS.map(r=>'<div class="lane '+r.toLowerCase()+'"><div class="lanehead"><span class="av"></span><span class="display">'+NAME[r]+'</span><span class="prog">'+(lp[r]||0)+' of '+n+' locked'+(r===role?', you':'')+'</span></div>'+m.slots.map((s,j)=>tile(r,m,s,j,E)).join('')+'</div>');
  let st,stc='state';
  if(m.winner){st='Winner: '+esc(m.winner);stc+=' done';}
  else if(m.pending){st='Result proposed by '+NAME[m.pending.by];stc+=' both';}
  else if(m.fullyLocked){st='Both locked, awaiting result';stc+=' both';}
  else if(PLAYERS.every(r=>lp[r]===n)){st='Both locked. Revealing picks...';stc+=' both';}
  else if(role==='ADMIN')st=((lp.DANTE||0)+(lp.TRIGGER||0))+' of '+(n*2)+' picks locked';
  else if(lp[role]===n)st='Waiting on '+OTHER[role];
  else st=(lp[role]||0)+' of '+n+' of your picks locked';
  const foot=resultFoot(m,E);
  const editBtn=isAdmin()&&E.status==='OPEN'?'<button class="editbtn" type="button" data-act="editmatch" data-m="'+esc(m.id)+'">Edit match</button>':'';
  return '<article class="bout"><div class="bouthead"><h3 class="display">'+esc(m.title)+(m.matchKey&&m.matchKey!=='STANDARD'?' <small class="muted">'+esc(m.matchLabel||m.matchKey)+'</small>':'')+'</h3><span class="bright">'+editBtn+'<span class="'+stc+'">'+st+'</span></span></div><div class="lanes">'+lanes[0]+'<div class="vs display">VS</div>'+lanes[1]+'</div>'+foot+'</article>';
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

function addAlloc(){
    const E=curEvent();if(!E)return;
    const t=allocSel.k==='CUSTOM'?allocSel.t.replace(/\s+/g,' ').trim():'';
    if(!allocSel.m){toast('Choose a match first.','err');return;}
    if(allocSel.k==='CUSTOM'){
      if(!t){toast('Write what you are predicting.','err');return;}
      if(/[^\p{L}\p{N} .,'\u2019&!?:\-]/u.test(t)||/^[=+\-@]/.test(t)){toast('Use letters, numbers and simple punctuation only.','err');return;}
    }
    const cand={m:allocSel.m,k:allocSel.k,t},key=propKey(cand),here=allocDraft.filter(x=>x.m===cand.m);
    if(here.some(x=>propKey(x)===key)){toast('You already added that to this match.','err');return;}
    if((cand.k==='X2'||cand.k==='WILD')&&here.some(x=>x.k==='X2'||x.k==='WILD')){toast('A match can have Wild Card or X2, not both.','err');return;}
    if(cand.k==='CUSTOM'&&here.filter(x=>x.k==='CUSTOM').length>=3){toast('At most 3 written predictions per match.','err');return;}
    if(allocDraft.length>=bankOf(me()).total){toast('You have placed everything you hold.','err');return;}
    allocDraft.push(cand);allocSel.t='';renderBouts();
  }
function doLockSpend(){
  const E=curEvent();if(!E||!E.spend)return;
  const allocations=allocDraft.map(a=>({matchId:a.m,mode:a.k,text:a.t||''}));
  E.spend[me()]={locked:true,amount:allocations.length,allocs:allocDraft.map(a=>Object.assign({},a))};
  toast('Spend locked.');renderBouts();
  queue(()=>rpc('lockSpend',TOKEN,{eventId:E.id,allocations})).then(settle,failed);
}

/* ---------------- admin actions ---------------- */
function arm(key,fn){
  if(armKey===key){armKey='';clearTimeout(armTimer);fn();renderBouts();renderFinish();applyEditMode();applyEventEditMode();return;}
  armKey=key;clearTimeout(armTimer);
  armTimer=setTimeout(()=>{armKey='';renderBouts();renderFinish();applyEditMode();applyEventEditMode();},4000);
  renderBouts();renderFinish();applyEditMode();applyEventEditMode();
}
function doFinish(){
  const E=curEvent();if(!E)return;
  toast('Finishing event...');
  queue(()=>rpc('completeEvent',TOKEN,E.id)).then(()=>refresh(),failed);
}

/** Record a result. A player SENDS it for the other player to confirm; the administrator records it as final. */
function doResult(mid){
  const d=rumbleDraft[mid],m=DATA.matches.find(x=>x.id===mid);if(!d||!m)return;
  const payload={matchId:mid,winner:d.winner,props:d.props.slice()};
  if(m.matchType==='RUMBLE')payload.finalFour=d.final.slice();
  const admin=isAdmin();
  toast(admin?'Recording result...':'Sending for confirmation...');
  queue(()=>rpc(admin?'setMatchWinner':'proposeResult',TOKEN,payload)).then(()=>{delete rumbleDraft[mid];return refresh(true);},failed);
}
function doConfirm(mid){
  toast('Confirming...');
  queue(()=>rpc('confirmResult',TOKEN,{matchId:mid})).then(()=>refresh(true),failed);
}
function doReject(mid){
  toast('Clearing the proposed result...');
  queue(()=>rpc('rejectResult',TOKEN,{matchId:mid})).then(()=>refresh(true),failed);
}

/* ---------------- admin drawer ---------------- */
let chips=[],editId='';   // chips: [{orig,name}] orig = the saved name (null for a new wrestler)
const blankChips=n=>Array.from({length:n},()=>({orig:null,name:''}));
let matchConfirm=false,deleteConfirm=false,editEventId='',typeBuiltFor='';
/* ---- match types: a grouped list from the server (a short fallback if the server is older) ---- */
const FALLBACK_TYPES=[
  {key:'STANDARD',label:'Normal / One Fall',group:'Standard and singles',hint:'Two competitors. Won by pinfall, submission, knockout, countout or disqualification.'},
  {key:'RUMBLE',label:'Royal Rumble',group:'Tag team and multi-competitor',hint:'Each player makes 2 winner picks and 4 final-four predictions.'}];
const matchTypeList=()=>(DATA&&DATA.matchTypes&&DATA.matchTypes.length)?DATA.matchTypes:FALLBACK_TYPES;
/** family: 'RUMBLE' shows only the Rumble, 'STANDARD' shows everything except it, falsy shows all. */
function buildMatchTypeSelect(keep,family){
  const list=matchTypeList().filter(t=>!family||(family==='RUMBLE'?t.key==='RUMBLE':t.key!=='RUMBLE'));
  const groups=[];
  list.forEach(t=>{let g=groups.find(x=>x.name===t.group);if(!g){g={name:t.group,items:[]};groups.push(g);}g.items.push(t);});
  $('matchType').innerHTML=groups.map(g=>'<optgroup label="'+esc(g.name)+'">'+g.items.map(t=>'<option value="'+esc(t.key)+'">'+esc(t.label)+'</option>').join('')+'</optgroup>').join('');
  $('matchType').value=keep||'STANDARD';
  updateTypeHint();
}
function updateTypeHint(){const t=matchTypeList().find(x=>x.key===$('matchType').value);$('mTypeHint').textContent=t?t.hint:'';}
function resetMatchForm(){
  editId='';chips=blankChips(2);matchConfirm=false;deleteConfirm=false;
  typeBuiltFor='';
  $('matchTitle').value='';$('matchType').value='STANDARD';
  const st=$('createMatchStatus');st.className='note';st.textContent='';
}
function openDrawer(tab){
  resetMatchForm();resetEventForm();
  $('drawer').classList.add('open');$('scrim').classList.add('open');
  drawerTab(tab||'event');
}
function closeDrawer(){$('drawer').classList.remove('open');$('scrim').classList.remove('open');}
function drawerTab(tab){
  $('tabEvent').classList.toggle('active',tab==='event');$('tabMatch').classList.toggle('active',tab==='match');
  show('createEventForm',tab==='event');show('createMatchForm',tab==='match');
  if(tab==='event')applyEventEditMode();
  if(tab==='match'){
    const open=DATA?DATA.events.filter(e=>e.status==='OPEN').sort((a,b)=>dateVal(a)-dateVal(b)):[];
    $('matchEvent').innerHTML=open.length?open.map(e=>'<option value="'+esc(e.id)+'"'+(e.id===selId?' selected':'')+'>'+esc(e.title)+'</option>').join(''):'<option value="">No open events. Create one first.</option>';
    renderChips();
  }
}
/* ---- edit an existing match (the server enforces the same rules; this just explains them) ---- */
function editState(){
  const m=editId&&DATA?DATA.matches.find(x=>x.id===editId):null;
  if(!m)return{m:null,locked:false,won:false};
  return{m,locked:((m.lockProgress.DANTE||0)+(m.lockProgress.TRIGGER||0))>0,won:!!m.winner};
}
function openEdit(mid){
  const m=DATA&&DATA.matches.find(x=>x.id===mid);if(!m)return;
  resetMatchForm();resetEventForm();editId=mid;
  chips=m.choices.map(c=>({orig:c,name:c}));
  $('matchTitle').value=m.title;
  $('drawer').classList.add('open');$('scrim').classList.add('open');
  drawerTab('match');
}
function applyEditMode(){
  const {m,locked,won}=editState(),edit=!!m;
  $('matchEventWrap').classList.toggle('hidden',edit);
  const want=edit?'e:'+editId:'add';
  if(typeBuiltFor!==want){typeBuiltFor=want;buildMatchTypeSelect(edit?(m.matchKey||'STANDARD'):'STANDARD',edit?m.matchType:'');}
  $('matchType').disabled=!!(edit&&m.matchType==='RUMBLE');   // a Rumble keeps its own pick structure
  $('tabMatch').textContent=edit?'Edit match':'Add match';
  $('mSubmit').textContent=matchConfirm?'Confirm and apply':(edit?'Save changes':'Add match');
  const d=$('mDelete');d.classList.toggle('hidden',!edit);d.disabled=false;
  const armed=edit&&armKey==='del:'+editId;d.classList.toggle('armed',armed);
  d.textContent=armed?(deleteConfirm?'Tap again to delete anyway':'Tap again to delete this match'):'Delete match';
  const note=$('mLockNote');note.classList.toggle('hidden',!edit);
  if(edit)note.textContent=won?'A result is recorded, so only the match name can change. To restructure it, delete the match (you will be asked to confirm) and add it again.'
    :locked?'Picks are locked. You can rename or add wrestlers freely. Removing a wrestler, or going to fewer picks, clears the locked picks it affects after you confirm, and those players pick again. Deleting the match also asks first.'
    :'Edit anything. Renaming a wrestler updates every pick on them. Removing one clears draft picks on them. Going to 6 or more wrestlers adds a second pick (without a boost).';
  if(edit&&m.matchType==='RUMBLE')note.textContent='A Royal Rumble has no name list: Dante and Trigger type the wrestlers themselves. You can change the match name here.';
}
function renderNames(){
  const won=editState().won;
  $('mNames').innerHTML=chips.map((c,i)=>'<div class="namerow"><input class="in nameinp" data-i="'+i+'" value="'+esc(c.name)+'" maxlength="90" placeholder="Name '+(i+1)+'" aria-label="Name '+(i+1)+'" autocomplete="off"'+(won?' disabled':'')+'>'+(won||chips.length<=2?'':'<button type="button" class="xbtn" data-act="rmchip" data-i="'+i+'" aria-label="Remove name '+(i+1)+'">×</button>')+'</div>').join('');
  const ae=document.activeElement;if(!ae||ae.id!=='mCount')$('mCount').value=chips.length;
}
function setCount(n){
  if(!Number.isFinite(n))return;
  n=Math.max(2,Math.min(30,Math.floor(n)));
  while(chips.length<n)chips.push({orig:null,name:''});
  if(chips.length>n)chips.length=n;
  renderChips();
}
function refreshMatchForm(){
  if(matchConfirm){matchConfirm=false;$('mSubmit').textContent=editId?'Save changes':'Add match';}
  const em=editState().m,type=em?em.matchType:$('matchType').value,rumble=type==='RUMBLE';
  show('namesBox',!rumble);show('rumbleNote',rumble);
  const names=chips.map(c=>c.name.trim());
  const dup=new Set(names.map(n=>n.toLowerCase())).size!==names.length,empty=names.some(n=>!n),bad=names.some(n=>/[,\n]/.test(n));
  const vs=names.some(n=>/\bvs\.?\b/i.test(n));
  let warn='';
  if(!rumble){
    if(vs)warn='That reads like a matchup. Put one wrestler or team in each box.';
    else if(dup)warn='Two boxes have the same name.';
    else if(empty)warn='Fill in every name box, or lower the number.';
    else if(bad)warn='Names cannot contain commas.';
  }
  $('mWarn').textContent=warn;show('mWarn',!!warn);
  const picks=rumble?'2 winner picks and 4 final-four predictions':(names.length>=6?'2 picks':'1 pick');
  $('mPreview').textContent='Each player gets '+picks+' in this match.';
  $('mSubmit').disabled=!($('matchTitle').value.trim()&&(rumble||(names.length>=2&&!dup&&!empty&&!bad&&!vs))&&(editId||$('matchEvent').value));
}
function renderChips(){applyEditMode();renderNames();refreshMatchForm();}
/* ---- edit / delete an existing event ---- */
function eventRisk(E){
  const ms=E?matchesOf(E):[];
  const locks=ms.reduce((n,m)=>n+(m.lockProgress.DANTE||0)+(m.lockProgress.TRIGGER||0),0),results=ms.filter(m=>m.winner).length;
  return{ms,locks,results,risky:!!E&&(E.status==='COMPLETED'||locks>0||results>0)};
}
function resetEventForm(){
  editEventId='';
  $('createEventForm').reset();writeChecks('ne',{});$('eConfirm').value='';
  const st=$('createEventStatus');st.className='note';st.textContent='';
  applyEventEditMode();
}
function pad2(n){return(n<10?'0':'')+n;}
function openEventEdit(){
  const E=curEvent();if(!E||!isAdmin())return;
  resetMatchForm();resetEventForm();editEventId=E.id;
  $('eventTitle').value=E.title;
  const d=parseDate(E.eventDate);$('eventDate').value=d?d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()):'';
  $('eventLocation').value=E.location||'';$('eventTime').value=E.startTime||'';
  $('drawer').classList.add('open');$('scrim').classList.add('open');
  drawerTab('event');
}
function applyEventEditMode(){
  const E=editEventId&&DATA?DATA.events.find(x=>x.id===editEventId):null,edit=!!E;
  $('tabEvent').textContent=edit?'Edit event':'New event';
  $('neChecks').classList.toggle('hidden',edit);
  $('eSubmit').textContent=edit?'Save changes':'Create event';
  show('eDelete',edit);show('eNote',edit);
  const r=eventRisk(E);
  show('eConfirmWrap',edit&&r.risky);
  const d=$('eDelete');
  d.disabled=edit&&r.risky&&$('eConfirm').value.trim()!==E.title;
  const armed=edit&&!r.risky&&armKey==='delev:'+E.id;d.classList.toggle('armed',armed);
  d.textContent=armed?'Tap again to delete this event':'Delete event';
  if(edit){
    const mt=r.ms.length+' match'+(r.ms.length===1?'':'es');
    $('eNote').textContent=E.status==='COMPLETED'
      ?'This event is finished. You can change its name, date and city. Deleting it removes its '+mt+' and takes its advantage back out of the standings; if it moved the title (and nothing later did) the title goes back. Type the event name to confirm.'
      :r.risky?'Deleting removes this event, its '+mt+', '+r.locks+' locked pick'+(r.locks===1?'':'s')+(r.results?' and '+r.results+' recorded result'+(r.results===1?'':'s'):'')+'. Type the event name to confirm.'
      :'You can change the name, date and city here. Deleting removes this event and its '+mt+'. The promotion and level are changed with the check marks above the card.';
  }
}
async function doDeleteEvent(){
  const E=DATA&&DATA.events.find(x=>x.id===editEventId);if(!E)return;
  const status=$('createEventStatus');status.className='note warn';status.textContent='Deleting event...';
  try{
    const r=await queue(()=>rpc('deleteEvent',TOKEN,{eventId:E.id,confirmTitle:$('eConfirm').value.trim()}));
    if(selId===E.id)selId='';
    resetEventForm();closeDrawer();await refresh(true);
    toast('Event deleted.'+(r&&r.championReset?' The title went back to the previous champion.':''));
  }catch(e){status.className='note bad';status.textContent='Event NOT deleted: '+(e.message||String(e));}
}
async function createEvent(ev){
  if(ev)ev.preventDefault();
  const status=$('createEventStatus');
  if(editEventId){
    status.className='note warn';status.textContent='Saving changes...';
    try{
      const data={eventId:editEventId,title:$('eventTitle').value.trim(),eventDate:$('eventDate').value,startTime:$('eventTime').value,location:$('eventLocation').value.trim()};
      await queue(()=>rpc('updateEvent',TOKEN,data));
      resetEventForm();closeDrawer();await refresh(true);toast('Event updated.');
    }catch(e){status.className='note bad';status.textContent='Changes NOT saved: '+(e.message||String(e));}
    return;
  }
  status.className='note warn';status.textContent='Saving event...';
  console.info('[Prediction Championship] Create Event handler called');
  try{
    if(!TOKEN)throw Error('Not signed in.');
    const c=readChecks('ne');
    if(!kindFrom(c))throw Error(c.promotion==='WWE'?'Choose Top, Mid or Low, or tick the two-night box.':'Tick WWE PLE, AAA PLE or Other non-WWE event.');
    if(!$('eventTime').value)throw Error('Enter the start time (Eastern Time).');
    const data={title:$('eventTitle').value.trim(),eventDate:$('eventDate').value,startTime:$('eventTime').value,location:$('eventLocation').value.trim(),promotion:c.promotion,tier:c.tier,twoNight:c.twoNight};
    const created=await queue(()=>rpc('saveEvent',TOKEN,data));
    if(!created||!created.id)throw Error('API did not confirm an event ID. Verify PC_EVENTS before retrying.');
    status.className='note ok';status.textContent='Event saved. ID: '+created.id;
    console.info('[Prediction Championship] Event saved:',created.id);
    $('createEventForm').reset();writeChecks('ne',{});selId=created.id;await refresh(true);
  }catch(e){
    const message='Event NOT saved: '+(e.message||String(e));
    status.className='note bad';status.textContent=message;console.error('[Prediction Championship] '+message,e);
  }
}
async function submitMatch(ev){
  if(ev)ev.preventDefault();
  const status=$('createMatchStatus'),editing=!!editId;
  status.className='note warn';status.textContent=editing?'Saving changes...':'Adding match...';
  try{
    if(!TOKEN)throw Error('Not signed in.');
    const names=chips.map(c=>c.name.trim());
    if(editing){
      const renames={};chips.forEach(c=>{const n=c.name.trim();if(c.orig&&c.orig!==n)renames[c.orig]=n;});
      const data={matchId:editId,title:$('matchTitle').value.trim(),choices:names,renames,matchType:$('matchType').value,confirm:matchConfirm};
      const r=await queue(()=>rpc('updateMatch',TOKEN,data));
      resetMatchForm();closeDrawer();await refresh(true);
      toast('Match updated.'+(r&&r.voidedLocked?' '+r.voidedLocked+' locked pick'+(r.voidedLocked===1?'':'s')+' cleared.':'')+(r&&r.clearedDrafts?' '+r.clearedDrafts+' draft pick(s) cleared.':''));
      return;
    }
    const data={eventId:$('matchEvent').value,title:$('matchTitle').value.trim(),choices:$('matchType').value==='RUMBLE'?'':names.join(', '),matchType:$('matchType').value,confirm:matchConfirm};
    await queue(()=>rpc('saveMatch',TOKEN,data));
    status.className='note ok';status.textContent='Match added. Roll the boosts once the card is final.';
    $('matchTitle').value='';chips=blankChips(2);matchConfirm=false;selId=data.eventId||selId;renderChips();await refresh(true);
    toast('Match added.');
  }catch(e){
    const msg=e.message||String(e);
    if(/^CONFIRM:/.test(msg)){matchConfirm=true;status.className='note warn';status.textContent=msg.replace(/^CONFIRM:\s*/,'')+' Press "Confirm and apply" to continue.';applyEditMode();$('mSubmit').disabled=false;return;}
    status.className='note bad';status.textContent=(editing?'Changes NOT saved: ':'Match NOT added: ')+msg;
  }
}
async function doDeleteMatch(){
  const status=$('createMatchStatus');status.className='note warn';status.textContent='Deleting match...';
  try{
    await queue(()=>rpc('deleteMatch',TOKEN,{matchId:editId,confirm:deleteConfirm}));
    resetMatchForm();closeDrawer();await refresh(true);toast('Match deleted.');
  }catch(e){
    const msg=e.message||String(e);
    if(/^CONFIRM:/.test(msg)){
      deleteConfirm=true;armKey='del:'+editId;clearTimeout(armTimer);armTimer=setTimeout(()=>{armKey='';applyEditMode();},8000);
      status.className='note warn';status.textContent=msg.replace(/^CONFIRM:\s*/,'')+' Tap Delete again to confirm.';applyEditMode();return;
    }
    status.className='note bad';status.textContent='Match NOT deleted: '+msg;
  }
}

/* ---------------- hold to lock ---------------- */
let hold=null;
function endHold(){if(pendingRender){pendingRender=false;renderBouts();}}
function startHold(b){
  if(hold||b.disabled)return;
  b.classList.add('holding');
  hold={b,t:setTimeout(()=>{const {m,s}=b.dataset,spendLock=!!b.dataset.spend;hold=null;if(spendLock)doLockSpend();else doLock(m,s);endHold();},900)};
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
  else if(a==='event'){
    if(b.dataset.id===selId)return;
    selId=b.dataset.id;shown=scoreOf(curEvent());fresh={flip:new Set(),slam:new Set(),hit:new Set()};
    renderHero(false);renderEvents();renderRules();renderResult();renderBouts();renderHistory();renderFinish();updateScores();window.scrollTo({top:0,behavior:reduced?'auto':'smooth'});
  }
  else if(a==='rmchip'){chips.splice(Number(b.dataset.i),1);renderChips();}
  else if(a==='editmatch')openEdit(b.dataset.m);
  else if(a==='aadd')addAlloc();
  else if(a==='adel'){allocDraft.splice(Number(b.dataset.i),1);renderBouts();}
  else if(a==='rprop'){const d=rumbleDraft[b.dataset.m];if(d){const i=d.props.indexOf(b.dataset.k);if(i>=0)d.props.splice(i,1);else d.props.push(b.dataset.k);renderBouts();}}
  else if(a==='cfm')arm('cfm:'+b.dataset.m,()=>doConfirm(b.dataset.m));
  else if(a==='rej')doReject(b.dataset.m);
  else if(a==='rff'){const d=rumbleDraft[b.dataset.m];if(d){const c=b.dataset.c,k=normName(c),i=d.final.findIndex(x=>normName(x)===k);if(i>=0){const gone=d.final.splice(i,1)[0];if(normName(d.winner)===normName(gone))d.winner='';}else if(d.final.length<4)d.final.push(c);renderBouts();}}
  else if(a==='radd'){
    const d=rumbleDraft[b.dataset.m],inp=$('rAdd_'+b.dataset.m);
    if(d&&inp){
      const v=inp.value.replace(/\s+/g,' ').trim();if(!v)return;
      if(/[^\p{L}\p{N} .,'\u2019&\-]/u.test(v)||/^[=+\-@]/.test(v)){toast('Names can use letters, numbers and simple punctuation only.','err');return;}
      if(d.final.some(x=>normName(x)===normName(v))){toast('That wrestler is already in the final four.','err');return;}
      if(d.final.length>=4){toast('The final four is full. Remove one first.','err');return;}
      d.final.push(v);inp.value='';renderBouts();
    }
  }
  else if(a==='rwin'){const d=rumbleDraft[b.dataset.m];if(d){d.winner=b.dataset.c;renderBouts();}}
  else if(a==='rrec'){
    const d=rumbleDraft[b.dataset.m],m=DATA.matches.find(x=>x.id===b.dataset.m);
    if(!d||!m||!d.winner){toast(m&&m.matchType==='RUMBLE'?'Pick the 4 finalists and the winner first.':'Choose who won first.','err');return;}
    if(m.matchType==='RUMBLE'&&d.final.length!==4){toast('Pick the 4 finalists and the winner first.','err');return;}
    arm('rec:'+b.dataset.m,()=>doResult(b.dataset.m));
  }
});
$('loginTab').addEventListener('click',()=>switchAuth('login'));
$('signupTab').addEventListener('click',()=>switchAuth('signup'));
$('authForm').addEventListener('submit',submitAuth);
$('logout').addEventListener('click',logOut);
$('adminBtn').addEventListener('click',()=>openDrawer('event'));
$('dclose').addEventListener('click',closeDrawer);
$('scrim').addEventListener('click',closeDrawer);
$('tabEvent').addEventListener('click',()=>{resetMatchForm();resetEventForm();drawerTab('event');});
$('editEventBtn').addEventListener('click',openEventEdit);
$('eConfirm').addEventListener('input',applyEventEditMode);
$('eDelete').addEventListener('click',()=>{const E=DATA&&DATA.events.find(x=>x.id===editEventId);if(!E)return;if(eventRisk(E).risky)doDeleteEvent();else arm('delev:'+E.id,doDeleteEvent);});
$('tabMatch').addEventListener('click',()=>{resetMatchForm();resetEventForm();drawerTab('match');});
$('mDelete').addEventListener('click',()=>{if(editId)arm('del:'+editId,doDeleteMatch);});
$('rulesBar').addEventListener('submit',saveRules);
$('rollBtn').addEventListener('click',doRoll);
document.addEventListener('change',e=>{
  const s=e.target;if(!s||!s.dataset)return;
  if(s.dataset.act==='pickselect'&&s.value)doPick(s.dataset.m,s.dataset.s,s.value);
  else if(s.dataset.act==='pickinput'){
    const v=s.value.replace(/\s+/g,' ').trim();
    if(v&&(/[^\p{L}\p{N} .,'\u2019&\-]/u.test(v)||/^[=+\-@]/.test(v))){toast('Names can use letters, numbers and simple punctuation only.','err');s.value=s.dataset.cur||'';}
    else if(v&&v!==(s.dataset.cur||''))doPick(s.dataset.m,s.dataset.s,v);
    if(s.blur)s.blur();
  }
  else if(s.dataset.act==='amatch')allocSel.m=s.value;
  else if(s.dataset.act==='amode'){allocSel.k=s.value;if(s.blur)s.blur();renderBouts();}
  else if(s.dataset.check)onCheck(s.dataset.check,s);
});
document.addEventListener('focusout',e=>{if(pendingRender&&e.target&&e.target.closest&&e.target.closest('#bouts,#spendBox'))setTimeout(()=>renderBouts(),0);});
document.addEventListener('input',e=>{const t=e.target;if(t&&t.dataset&&t.dataset.act==='atext')allocSel.t=t.value;});
$('finishBtn').addEventListener('click',()=>{const E=curEvent();if(E)arm('finish:'+E.id,doFinish);});
$('createEventForm').addEventListener('submit',createEvent);
$('createMatchForm').addEventListener('submit',submitMatch);
$('mNames').addEventListener('input',e=>{
  const t=e.target;if(!t.classList||!t.classList.contains('nameinp'))return;
  chips[Number(t.dataset.i)].name=t.value;refreshMatchForm();
});
$('mCount').addEventListener('input',()=>setCount(Number($('mCount').value)));
$('mCount').addEventListener('change',()=>{$('mCount').value=chips.length;});
$('matchTitle').addEventListener('input',refreshMatchForm);
$('matchType').addEventListener('change',()=>{updateTypeHint();refreshMatchForm();});
$('matchEvent').addEventListener('change',refreshMatchForm);

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

buildChecks('ne');buildChecks('rb');
$('cdTimeSave').addEventListener('click',saveQuickTime);
tickClock();
setInterval(()=>{if(!document.hidden){tickClock();tickCountdown();}},1000);
if(TOKEN){const m=$('authMsg');m.className='note warn';m.textContent='Restoring your session...';refresh().then(ok=>{if(ok)$('authMsg').textContent='';});}
setTimeout(pollLoop,6000);

// Safe diagnostic (do not paste tokens in the Console):
async function pcCheckAdmin(){
  const state=await rpc('checkSession',TOKEN);
  console.log('[Prediction Championship] Session permissions',state);
  return state;
}