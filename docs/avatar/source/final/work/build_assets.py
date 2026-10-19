#!/usr/bin/env python3
# WorkPal 头像 v0.7 FINAL 资源生成脚本（2026-10-18）
# 输入：/workspace/WorkPal-ui-review/mockups/color/{c,cs,ct}_nf/（v0.7 草案确认过的无脚 C 配色 SVG）、
#       /workspace/WorkPal-ui-review/mockups/color/ct/（有脚原坐标版，只用来做 16px）、final/assets/props/
# 输出：release-v0.7/ 根目录角色 SVG、assets/props、assets/static、assets/anchors.json、assets/palette.json、demo/layers.json
import os, re, json, subprocess, math
REL='/workspace/WorkPal-avatar-visual/release-v0.7/'
SRC='/workspace/WorkPal-ui-review/mockups/color/'
F6='/workspace/WorkPal-avatar-visual/final/'
CH=['1-dot','2-treble','3-wave','4-bounce']
COL=['orange','blue','purple','brown','pink','ink']        # ink = 原 black（Buzz 等）
SRCCOL={'ink':'black'}
BODY={'orange':'#e8983a','blue':'#4184f4','purple':'#885cf1','brown':'#996e42','pink':'#e54896','ink':'#343946'}
DARK={'L':{'orange':'#92550e','blue':'#0641a4','purple':'#3a0bad','brown':'#553d23','pink':'#941152','ink':'#191b22'},
      'S':{'orange':'#77460b','blue':'#053587','purple':'#30098d','brown':'#46321d','pink':'#790e43','ink':'#14161b'},
      'XS':{'orange':'#6f410a','blue':'#04327e','purple':'#2d0884','brown':'#412e1b','pink':'#710d3f','ink':'#121419'}}
TIER={'L':('c_nf',''),'S':('cs_nf','-s'),'XS':('ct_nf','-xs')}
BOT={'1-dot':86.75,'2-treble':86.75,'3-wave':80.25,'4-bounce':86.25}   # 原坐标身体最低点（支点 y）
R=31.25; CY0=57.8125
LAP_K={'1-dot':1.0,'2-treble':1.0,'3-wave':0.85,'4-bounce':1.0}
HEAD='<!-- WorkPal 头像 v0.7 FINAL（2026-10-18）· {what} · 无脚 · C 配色 · viewBox 100，按头像框 1.25 倍居中绘制、不裁切 -->'
def rd(p): return open(p).read()
def wr(p,s): os.makedirs(os.path.dirname(p),exist_ok=True); open(p,'w').write(s)
def meta(s):
    m=re.search(r'data-s="([\d.]+)" data-cx="([\d.]+)" data-cy="([\d.]+)"',s); return tuple(map(float,m.groups()))
def svg_open(s): return s[:s.index('>',s.index('<svg'))+1].replace(' width="512" height="512"','')
anchors={}; layers={}
for ch in CH:
    anchors[ch]={}; layers[ch]={}
    for t,(d,suf) in TIER.items():
        s0=rd(SRC+f'{d}/{ch}-orange.svg'); sc,bx,by=meta(s0)
        Rp=R*sc; cx=50+sc*(50-bx); cy=50+sc*(CY0-by); px=cx; py=50+sc*(BOT[ch]-by)
        k=LAP_K[ch]
        a=dict(fit=dict(s=sc,cx=bx,cy=by), Rp=round(Rp,3), body_centre=[round(cx,2),round(cy,2)], pivot=[round(px,2),round(py,2)],
               tilt=2.75 if ch=='4-bounce' else 0,
               laptop=dict(scale=k, x=round(min(cx+1.30*Rp,99-0.466*k*Rp),2), y=round(min(cy+0.50*Rp,99-0.25*k*Rp),2)),
               card=dict(x=round(min(cx+1.30*Rp,99-0.30*Rp),2), y=round(min(cy+0.50*Rp,99-0.34*Rp),2)),
               shadow=dict(cx=round(px,2),cy=round(py+0.06*Rp,2),rx=round(0.55*Rp,2),ry=round(0.08*Rp,2)))
        anchors[ch][t]=a
        # 角色 SVG：每色一份
        for c in COL:
            s=rd(SRC+f'{d}/{ch}-{SRCCOL.get(c,c)}.svg')
            s=svg_open(s)+HEAD.format(what=f'{ch} · {c} · {t} 档')+s[s.index('>',s.index('<svg'))+1:]
            wr(REL+f'{ch}-{c}{suf}.svg',s)
        # 分层（demo 用；颜色用占位符）
        b=svg_open(s0); body=s0[s0.index('<g id="body"'):s0.index('<g id="eyewhite"')]
        ew=s0[s0.index('<g id="eyewhite"'):s0.index('<g id="pupilL"')]
        pl=s0[s0.index('<g id="pupilL"'):s0.index('<g id="pupilR"')]
        pr=s0[s0.index('<g id="pupilR"'):s0.index('<g id="symbol"')]
        end=s0.rindex('</g></g></svg>') if ch=='4-bounce' else s0.rindex('</g></svg>')
        sy=s0[s0.index('<g id="symbol"'):end]
        tok=lambda x:x.replace(BODY['orange'],'{BODY}').replace(DARK[t]['orange'],'{DARK}')
        layers[ch][t]=dict(body=tok(body),eyewhite=tok(ew),pupilL=tok(pl),pupilR=tok(pr),symbol=tok(sy))
# ---------- 16px：身体 + 眼，无符号；用极小档深色 ----------
def chrome_bbox(svg):
    open('/tmp/_bb.svg','w').write(svg)
    open('/tmp/_bb.html','w').write('<body style="margin:0;background:#fff"><img src="/tmp/_bb.svg" width=800 height=800>')
    subprocess.run(['google-chrome','--headless=new','--no-sandbox','--hide-scrollbars','--window-size=800,800','--screenshot=/tmp/_bb.png','file:///tmp/_bb.html'],capture_output=True)
    from PIL import Image; import numpy as np
    a=np.asarray(Image.open('/tmp/_bb.png').convert('L'))<200; ys,xs=np.where(a)
    return [v/8 for v in (xs.min(),ys.min(),xs.max()+1,ys.max()+1)]
fit16={}
for ch in CH:
    s=rd(SRC+f'ct/{ch}-orange.svg')
    core=s[s.index('<g id="body"'):s.index('<g id="symbol"')]
    if ch=='4-bounce': core=f'<g id="tilt" transform="rotate(2.75 50 86.25)">{core}</g>'
    sil=re.sub(r'(fill|stroke)="#[0-9a-fA-F]+"',r'\1="#000"',core)
    x0,y0,x1,y1=chrome_bbox('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'+sil+'</svg>')
    sc=92/max(x1-x0,y1-y0); bx,by=(x0+x1)/2,(y0+y1)/2; fit16[ch]=dict(s=round(sc,4),cx=bx,cy=by)
    for c in COL:
        cc=rd(SRC+f'ct/{ch}-{SRCCOL.get(c,c)}.svg'); g=cc[cc.index('<g id="body"'):cc.index('<g id="symbol"')]
        if ch=='4-bounce': g=f'<g id="tilt" transform="rotate(2.75 50 86.25)">{g}</g>'
        wr(REL+f'{ch}-{c}-16.svg',f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'+HEAD.format(what=f'{ch} · {c} · 16px（身体 + 眼，无符号、无道具）')+
           f'<g id="fit" transform="translate(50 50) scale({sc:.4f}) translate({-bx:.2f} {-by:.2f})">{g}</g></svg>')
# ---------- 道具 ----------
def lap(dark,R=R):
    f=lambda x:f'{x:.4f}'
    return (f'<g id="laptop"><rect x="{f(-.25*R)}" y="{f(-.34*R)}" width="{f(.5*R)}" height="{f(.4*R)}" rx="{f(.05*R)}" fill="#fff" stroke="{dark}" stroke-width="{f(.07*R)}"/>'
      f'<rect id="glow" x="{f(-.18*R)}" y="{f(-.27*R)}" width="{f(.36*R)}" height="{f(.26*R)}" rx="{f(.03*R)}" fill="#4ADE80" opacity="0.4"/>'
      f'<rect id="cursor" x="{f(-.10*R)}" y="{f(-.20*R)}" width="{f(.05*R)}" height="{f(.12*R)}" fill="{dark}"/>'
      f'<path d="M {f(-.33*R)} {f(.08*R)} H {f(.33*R)} L {f(.28*R)} {f(.17*R)} H {f(-.28*R)} Z" fill="{dark}" stroke="{dark}" stroke-width="{f(.03*R)}" stroke-linejoin="round"/></g>')
for c in COL:
    for t,suf in (('L',''),('S','-s')):
        wr(REL+f'assets/props/laptop-{c}{suf}.svg',f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-20 -20 40 40"><!-- 笔记本 v0.7：本地坐标、单位 R=31.25；摆放 translate(anchors.laptop.x,y) scale(1.35 × laptop.scale × fit.s)；描边/底座/光标 = {c} {t} 档深色 {DARK[t][c]} -->'+lap(DARK[t][c])+'</svg>')
# 黄牌、问号：本地坐标，加 0.05R′ 白描边（v0.7：道具可压住彩色身体，用白边分开）
card=rd(F6+'assets/props/card.svg'); m=re.search(r'<rect[^>]*/>',card).group(0)
wr(REL+'assets/props/card.svg','<svg xmlns="http://www.w3.org/2000/svg" viewBox="-20 -20 40 40"><!-- 黄牌 v0.7：本地坐标（原点 = 锚点），单位 R=31.25；摆放 translate(anchors.card.x,y) scale(fit.s)；#F5C84B，白描边 1.5625（0.05R） -->'
   +'<g id="card">'+m.replace('/>',' stroke="#fff" stroke-width="1.5625" paint-order="stroke"/>')+'</g></svg>')
for nm in ('question.svg','question-dark.svg'):
    q=rd(F6+'assets/props/'+nm); g=q[q.index('<g id="question"'):q.rindex('</svg>')]
    g=re.sub(r'<g id="question" transform="[^"]+">','<g id="question">',g,count=1)
    col=re.search(r'fill="(#[0-9A-Fa-f]{6})"',g).group(1)
    halo=re.sub(r'fill="#[0-9A-Fa-f]{6}"','fill="#fff"',g); halo=re.sub(r'stroke="#[0-9A-Fa-f]{6}"','stroke="#fff"',halo)
    halo=re.sub(r'stroke-width="[\d.]+"','stroke-width="4.3"',halo).replace('<g id="question">','<g id="question-halo">')
    if 'stroke-width' not in halo: halo=halo.replace('<path ','<path stroke="#fff" stroke-width="4.3" stroke-linejoin="round" ')
    wr(REL+'assets/props/'+nm,f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-20 -20 40 40"><!-- 问号 v0.7：本地坐标（原点 = 锚点），摆放同黄牌；{col}，外加白色描边光晕（约 0.05R 可见宽度） -->'+halo+g+'</svg>')
# v0.6 的 props/check.svg/png 是有脚版核对图，不是道具，v0.7 不再提供（核对图见 review-6-props-check.png）
# 叉眼：与角色 SVG 同 viewBox、同 fit，可直接叠在对应角色文件上（静帧用；动画按 demo 分层实现）
for ch in CH:
    x=rd(F6+f'assets/props/xeyes-{ch}.svg'); g=x[x.index('<g id="xeyes">'):x.rindex('</svg>')]
    for t,(d,suf) in (('L',TIER['L']),('S',TIER['S'])):
        a=anchors[ch][t]['fit']
        for c in COL:
            gg=g.replace('stroke="#000"',f'stroke="{DARK[t][c]}"')
            if t=='S': gg=re.sub(r'stroke-width="([\d.]+)"',lambda m:f'stroke-width="{float(m.group(1))*2.2:.4f}"',gg)
            inner=f'<g id="tilt" transform="rotate(2.75 50 86.25)">{gg}</g>' if ch=='4-bounce' else gg
            wr(REL+f'assets/props/xeyes-{ch}-{c}{suf}.svg',f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><!-- 叉眼 v0.7：{ch} {c} {t} 档，深色 {DARK[t][c]}，线宽 {"0.154R（×2.2）" if t=="S" else "0.07R"}；叠在 {ch}-{c}{suf}.svg 上，同时隐藏 pupilL / pupilR -->'
               +f'<g id="fit" transform="translate(50 50) scale({a["s"]:.4f}) translate({-a["cx"]:.2f} {-a["cy"]:.2f})">{inner}</g></svg>')
json.dump(dict(version='0.7',note='坐标都是 viewBox 100 画布单位；fit 把原坐标（R=31.25，身体中心 (50,57.8125)）映射到画布；Rp=R′',
               tiers={'L':'≥58px（58/64）','S':'24–35px','XS':'18px 群聊头像簇'},anchors=anchors,fit16=fit16),open(REL+'assets/anchors.json','w'),ensure_ascii=False,indent=1)
json.dump(dict(body=BODY,dark=DARK,eyewhite='#fff',props={'card':'#F5C84B','question_light':'#3F8FDF','question_dark':'#7CB8F2','laptop_glow':'#4ADE80','prop_outline':'#fff'},
               shadow={'light':'#000 @0.10','dark':'#000 @0.25'},
               status={'_note':'2026-10-19 徐哥确认（UX §16）；16px 状态点和侧边栏徽标共用','light':{'run':'#22a356','approval':'#d97706','answer':'#3F8FDF','fail':'#e5484d','done':'#22a356'},
                       'dark':{'run':'#4ADE80','approval':'#F5C84B','answer':'#7CB8F2','fail':'#e5484d','done':'#4ADE80'},
                       'glyph':{'fail':'!','done':'✓'},'glyph_color':{'light':'#fff','dark':'#1a1a1a','fail_any_theme':'#fff'},
                       'ring':{'color':'当前背景色','dot16':'1.5px','badge':'2px','dot16_same_hue':'2px','badge_same_hue':'2.5px','same_hue_rule':'徽标 / 点颜色和身体 ΔE(CIE76) < 25，或色相角差 < 30°（ink 饱和度低，不算）','same_hue_pairs':{'approval':['orange','brown'],'answer':['blue'],'fail':['pink']}},'backgrounds':{'light':'#ffffff','dark':'#1a1a1a'}}),open(REL+'assets/palette.json','w'),ensure_ascii=False,indent=1)
json.dump(dict(layers=layers,anchors=anchors,body=BODY,dark=DARK),open(REL+'demo/layers.json','w'),ensure_ascii=False)
print('ok', len([f for f in os.listdir(REL) if f.endswith('.svg')]),'root svgs')
