// WorkPal 头像动作引擎 v0.7 FINAL（2026-10-18）——演示用参考实现，数值以 MOTION-SPEC.md 为准。
// 坐标约定：整体组（grp）在「原坐标」里动（R=31.25，身体中心 (50,57.8125)），外面套 fit（等比放大到画布）；
// 所以规范里以 R′ 为单位的位移，在这里直接写成 ×R 即可（fit 已经乘了 s）。道具和阴影在画布坐标里，用 R′。
const R=31.25, CY0=57.8125, NS='http://www.w3.org/2000/svg';
const BOT={'1-dot':86.75,'2-treble':86.75,'3-wave':80.25,'4-bounce':86.25};
const OUT=t=>{const c=1-t;return 1-c*c*c}, IN=t=>t*t*t, IO=t=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2, cl=t=>Math.max(0,Math.min(1,t)), lerp=(a,b,t)=>a+(b-a)*t;
const rnd=(a,b)=>a+Math.random()*(b-a);
// 关键帧插值：[[ms,值,缓动(到这一帧)],...]
function K(keys,t){if(t<=keys[0][0])return keys[0][1];for(let i=1;i<keys.length;i++){const[a,va]=keys[i-1],[b,vb,e]=keys[i];if(t<=b)return va+(vb-va)*(e||IO)((t-a)/(b-a))}return keys[keys.length-1][1]}
// ---- 出错 failed v0.7（MOTION-SPEC §3.5）----
const FAIL={len:1240,
 ty:[[0,0],[150,-0.12,OUT],[300,0,IN],[940,0],[1240,0.06,IO]],
 sy:[[0,1],[150,1.08,OUT],[300,1,IO],[940,1],[1240,0.95,IO]],
 sx:[[0,1],[150,0.93,OUT],[300,1,IO],[940,1],[1240,1.03,IO]],
 rot:[[300,0],[400,-6,OUT],[560,4.5],[720,-2.5],[860,1],[940,0]],
 tx:[[300,0],[400,-0.06,OUT],[560,0.045],[720,-0.025],[860,0.01],[940,0]],
 eye:[[0,1],[150,1.10,OUT],[300,1,IO]],
 symy:[[0,0],[150,-0.05,OUT],[300,0,IO],[940,0],[1240,0.04,IO]],
 symr:[[940,0],[1240,8,IO]],
 x:[[300,0],[400,1,OUT]], pup:[[300,1],[360,0,t=>t]],
 sh:[[0,0],[60,1,t=>t],[300,1],[400,0,t=>t]], lagP:40, lagS:70};
function hopAt(u,h){ // 420ms 弹跳（§3.2）；返回 [ty,sx,sy]，ty 单位：原坐标
  if(u<0||u>=420)return[0,1,1];
  if(u<60){const k=OUT(u/60);return[0,lerp(1,1.08,k),lerp(1,.92,k)]}
  if(u<230){const k=OUT((u-60)/170);return[-h*R*k,lerp(1.08,.96,k),lerp(.92,1.04,k)]}
  if(u<400){const k=IO((u-230)/170);return[-h*R*(1-k),lerp(.96,1.06,k),lerp(1.04,.94,k)]}
  const k=(u-400)/20;return[0,lerp(1.06,1,k),lerp(.94,1,k)]}
const SIG_LEN={'1-dot':1300,'2-treble':1600,'3-wave':1800,'4-bounce':1100};
function signature(n,u){
  const o={ty:0,sx:1,sy:1,tx:0,rot:0,symTx:0,symTy:0,symRot:0,air:false};
  if(n=='1-dot'){const b=u%650,k=Math.sin(Math.PI*cl(b/650));o.symTy=-.32*R*k;o.pupY=-.08*R;if(b>560){o.sx=1.03;o.sy=.97}}
  if(n=='2-treble'){const k=Math.sin(u/400*Math.PI*2*0.75*2);o.symRot=12*k;o.rot=2.5*k;o.tx=.03*R*k;const beat=u%533;if(beat<120)o.ty=-.03*R*Math.sin(Math.PI*beat/120)}
  if(n=='3-wave'){const k=Math.sin(u/900*Math.PI*2);o.symTy=-.10*R*Math.sin(Math.PI*cl(u/1800));o.symRot=10*k;o.symTx=.05*R*k;o.rot=-2*k}
  if(n=='4-bounce'){const [y,x,s]=u<420?hopAt(u,.22):hopAt(u-460,.30);o.ty=y;o.sx=x;o.sy=s;o.air=true;const [y2]=u<500?hopAt(u-80,.22):hopAt(u-540,.30);o.symTy=(y2-y)*.6}
  return o;
}
function sched(a,key,lo,hi,now){if(!a[key])a[key]=now+rnd(lo,hi);}
function propFor(st){return st=='working'?'lap':st=='approval'?'card':st=='waiting'?'q':null}
function popS(t){const u=cl(t/320);return u<.6?lerp(0,1.12,OUT(u/.6)):lerp(1.12,1,(u-.6)/.4)}
function pupilTarget(st,t){
  if(st=='working'){if(t<1260)return[0,0];return[.09*R,.07*R]}            // 看屏幕（勘误 S 夹紧后的值）
  if(st=='approval')return[.10*R,.04*R]; if(st=='waiting')return[0,-.08*R]; return[0,0];}
function staticPupil(st){return st=='working'?[.09*R,.07*R]:pupilTarget(st,0)}
function frame(a,now,RM){
  const t=now-a.t0, st=a.state, q=a.el, n=a.n;
  let tx=0,ty=0,sx=1,sy=1,rot=0,blink=1,xe=0,pupO=1,dP=0,pp=[0,0],propS={card:0,q:0,lap:0},glow=0,cur=0,propY=0,propRot=0,symTx=0,symTy=0,symRot=0,eyeS=1,air=false,shTarget=0,oneShot=false;
  const breathe=(amp=.035)=>{const b=(1-Math.cos(now/3600*2*Math.PI))/2;sy*=1+amp*b;sx*=1-amp*b};
  const symSway=(amp=1)=>{symRot+=4*amp*Math.sin(now/2600*2*Math.PI+a.ph);symTy+=-.02*R*amp*Math.sin(now/1800*2*Math.PI+a.ph)};
  const addSig=(lo,hi)=>{sched(a,'sigAt',lo,hi,now);const u=now-a.sigAt;
    if(u>=0&&u<SIG_LEN[n]){const o=signature(n,u);ty+=o.ty;tx+=o.tx;sx*=o.sx;sy*=o.sy;rot+=o.rot;symTx+=o.symTx;symTy+=o.symTy;symRot+=o.symRot;if(o.air)air=true;if(o.pupY)pp=[pp[0],o.pupY];return true}
    if(u>=SIG_LEN[n])a.sigAt=now+rnd(lo,hi);return false};
  const glance=(lo,hi)=>{sched(a,'glAt',lo,hi,now);const u=now-a.glAt;
    if(u>=0&&u<1400){if(!a.glDir)a.glDir=Math.random()<.5?-1:1;const k=u<250?OUT(u/250):u<1150?1:1-IO((u-1150)/250);pp=[a.glDir*.10*R*k,pp[1]];rot+=a.glDir*2*k}
    else if(u>=1400){a.glAt=now+rnd(lo,hi);a.glDir=0}};
  if(RM){ // 静态帧（§5）：无阴影
    pp=staticPupil(st);const p=propFor(st);if(p)propS[p]=1;
    if(st=='failed'){xe=1;pupO=0;ty=.06*R;sy=.95;sx=1.03;symTy=.04*R;symRot=8}
    if(st=='working'){glow=.4;cur=1}
  } else {
  const tin=t-(a.prev&&propFor(a.prev)?160:0);
  if(st=='idle'){breathe();symSway();
    if(!addSig(9000,18000)){glance(3000,7000);
      sched(a,'hopAt',6000,14000,now);const u=now-a.hopAt;if(u>=0&&u<420){const [y,x,s]=hopAt(u,.08);ty+=y;sx*=x;sy*=s;air=true}else if(u>=420)a.hopAt=now+rnd(6000,14000);}}
  if(st=='working'){
    if(t<1260){const [y,x,s]=hopAt(t%420,.18);ty=y;sx=x;sy=s;air=true;pp=pupilTarget(st,t)}
    else{const PER=(t>31260&&!a.pulses.length)?1200:600,b=(t-1260)%PER,k=b<180?Math.sin(Math.PI*b/180):0;ty+=.03*R*k;sy*=1-.03*k;sx*=1+.03*k;
      const b2=(t-1340)%PER,k2=b2>=0&&b2<200?Math.sin(Math.PI*b2/200):0;symTy+=.025*R*k2;symRot+=3*k2;pp=pupilTarget(st,t);
      glow=.25+(PER>600?.15:.35)*k;cur=((t-1260)%1000)<500?1:0;
      a.pulses=a.pulses.filter(p=>now-p<420);if(a.pulses.length){const [y,x,s]=hopAt(now-a.pulses[0],.18);ty=y;sx=x;sy=s;air=true}else addSig(15000,25000);}
    propS.lap=popS(t);}
  if(st=='approval'||st=='waiting'){
    breathe();symSway(.6);const p=propFor(st);let s=popS(tin);pp=pupilTarget(st,t);
    if(st=='approval'){if(tin>320)propY=Math.sin((tin-320)/1600*2*Math.PI)*.05*R;
      const nudge=a.nudgeAt?now-a.nudgeAt:(tin>3000?(tin-3000)%30000:-1);
      if(nudge>=0&&nudge<900){const k=Math.sin(nudge/900*Math.PI*6);propRot=14*k;rot+=3*Math.sin(Math.PI*nudge/900);
        const [y,x,s2]=hopAt(nudge-100,.08);ty+=y;sx*=x;sy*=s2;air=nudge>100&&nudge<520;pp=nudge<450?[0,0]:pp;s*=1+.1*Math.abs(k)}
      if(a.nudgeAt&&now-a.nudgeAt>=900)a.nudgeAt=0;}
    if(st=='waiting'&&tin>320){const c=(tin-320)%8000,side=c<4000?1:-1,k=IO(cl((c%4000)/500));
      rot+=lerp(-side*4,side*4,k)*(tin<820?cl((tin-320)/500):1);propRot=side*8*k;pp=[pp[0]+side*.05*R,pp[1]];
      if(c%4000>2600&&c%4000<3200){const g=Math.sin(Math.PI*((c%4000)-2600)/600);pp=[pp[0]-side*.18*R*g,pp[1]]}}
    if(a.reAt&&now-a.reAt<320)s*=1+.15*Math.sin((now-a.reAt)/320*Math.PI);
    propS[p]=tin<0?0:s;}
  if(st=='failed'){ // v0.7 摇头版
    oneShot=true;const re=a.reAt&&now-a.reAt<FAIL.len;const u=re?now-a.reAt:t,F=FAIL;
    ty=K(F.ty,u)*R;sy=K(F.sy,u);sx=K(F.sx,u);rot=K(F.rot,u);tx=K(F.tx,u)*R;eyeS=K(F.eye,u);
    symTy=K(F.symy,u)*R;symRot=K(F.symr,u)+0.4*(K(F.rot,u-F.lagS)-rot);
    dP=0.5*((K(F.tx,u-F.lagP)-K(F.tx,u))*R+(K(F.rot,u-F.lagP)-rot)*Math.PI/180*0.9*R);
    xe=re?1:K(F.x,u);pupO=re?0:K(F.pup,u);shTarget=K(F.sh,u);a.shA=shTarget;}
  const tc=now-a.tc;
  if(a.prev){const op=propFor(a.prev);if(op&&op!=propFor(st)&&tc<160)propS[op]=1-OUT(tc/160);
    if(a.prev=='failed'&&tc<120){xe=Math.max(xe,1-tc/120);pupO=Math.min(pupO,tc/120)}
    if(tc<200){const k=OUT(tc/200);pp=[lerp(a.ppPrev[0],pp[0],k),lerp(a.ppPrev[1],pp[1],k)]}}
  if(st!='failed'&&!(st=='working'&&t>=1260)&&now>a.blinkAt){const b=now-a.blinkAt;
    if(b<160)blink=b<80?lerp(1,.1,b/80):lerp(.1,1,(b-80)/80);
    else if(a.dbl&&b>280&&b<440){const c=b-280;blink=c<80?lerp(1,.1,c/80):lerp(.1,1,(c-80)/80)}
    else if(b>=440||(!a.dbl&&b>=160)){a.blinkAt=now+2500+Math.random()*3500;a.dbl=Math.random()<.15}}
  }
  // 形变分档（§0.3）：循环 0.90–1.10；一次性 0.80–1.20；58px 网格里一次性 sy ≤1.12。旋转：循环 ±5°，出错摇头 ±6°。
  const lo=oneShot?.8:.9,hi=oneShot?(a.grid?1.12:1.2):1.1;sx=Math.max(lo,Math.min(hi,sx));sy=Math.max(lo,Math.min(hi,sy));
  const rl=oneShot?6:5;rot=Math.max(-rl,Math.min(rl,rot));
  // 地面阴影（§0.4）：只在离地动作里；离地前后淡入 80ms / 淡出 200ms（出错由时间轴直接给）
  if(st!='failed'&&!RM){const dt=Math.min(50,now-(a.lastNow||now));a.shA=air?Math.min(1,(a.shA||0)+dt/80):Math.max(0,(a.shA||0)-dt/200)}
  if(RM)a.shA=0; a.lastNow=now;
  const lift=Math.max(0,-ty)/R/0.1;const shS=Math.max(.8,1-.08*lift),shO=Math.max(.06,.10-.02*lift)*(a.shA||0);
  a.pp=pp; const A=a.A, P=a.P;
  q.querySelector('.grp').setAttribute('transform',`translate(${tx+50} ${ty+BOT[n]}) rotate(${rot}) scale(${sx} ${sy}) translate(-50 ${-BOT[n]})`);
  q.querySelector('.symw').setAttribute('transform',`translate(${symTx} ${symTy}) rotate(${symRot} ${a.piv[0]} ${a.piv[1]})`);
  q.querySelector('.eyes').setAttribute('transform',`translate(${a.ec.x} ${a.ec.y}) scale(${eyeS} ${blink*eyeS}) translate(${-a.ec.x} ${-a.ec.y})`);
  q.querySelector('.pup').setAttribute('transform',`translate(${pp[0]+dP} ${pp[1]})`);q.querySelector('.pup').style.opacity=pupO;
  q.querySelector('.xe').setAttribute('transform',`translate(${dP} 0)`);
  q.querySelectorAll('.xs').forEach(x=>x.setAttribute('transform',`scale(${Math.max(xe,0.0001)})`));q.querySelector('.xe').style.opacity=xe>0?1:0;
  const sh=q.querySelector('.sh');sh.setAttribute('opacity',shO);sh.setAttribute('transform',`translate(${A.shadow.cx} ${A.shadow.cy}) scale(${shS}) translate(${-A.shadow.cx} ${-A.shadow.cy})`);
  const pr=A.Rp/R*a.ps;
  q.querySelector('.card').setAttribute('transform',`translate(${A.card.x} ${A.card.y+propY*A.Rp/R}) rotate(${propRot}) scale(${propS.card*pr})`);
  q.querySelector('.q').setAttribute('transform',`translate(${A.card.x} ${A.card.y+propY*A.Rp/R}) rotate(${propRot}) scale(${propS.q*pr})`);
  q.querySelector('.lap').setAttribute('transform',`translate(${A.laptop.x} ${A.laptop.y}) scale(${propS.lap*pr*1.35*A.laptop.scale})`);
  q.querySelector('.glow').setAttribute('opacity',glow);q.querySelector('.cur').setAttribute('opacity',cur);
}
