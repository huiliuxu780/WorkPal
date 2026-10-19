# v0.7 草案：彩色笔记本 / 叉眼 + 每个角色的笔记本摆放（波浪 0.85×）。不改 final/
import json, re
C='/workspace/WorkPal-ui-review/mockups/color/'; F='/workspace/WorkPal-avatar-visual/final/'
G=json.load(open('/workspace/WorkPal-avatar-visual/drafts/v0.7/geom.json'))
DARK={'c':{'orange':'#92550e','blue':'#0641a4','purple':'#3a0bad','brown':'#553d23','pink':'#941152','black':'#191b22'},
      'cs':{'orange':'#77460b','blue':'#053587','purple':'#30098d','brown':'#46321d','pink':'#790e43','black':'#14161b'}}
R=31.25
def f(x): return f'{x:.4f}'
def laptop_g(dark, LX, LY, k, Rp):
    # 和 v0.6 props.py 同一造型；单位用 R′；k = 1.35 × 角色缩放（波浪 0.85）
    r=Rp
    return (f'<g id="laptop" transform="translate({f(LX)} {f(LY)}) scale({f(1.35*k)})">'
      f'<rect x="{f(-.25*r)}" y="{f(-.34*r)}" width="{f(.5*r)}" height="{f(.4*r)}" rx="{f(.05*r)}" fill="#fff" stroke="{dark}" stroke-width="{f(.07*r)}"/>'
      f'<rect id="glow" x="{f(-.18*r)}" y="{f(-.27*r)}" width="{f(.36*r)}" height="{f(.26*r)}" rx="{f(.03*r)}" fill="#4ADE80" opacity="0.4"/>'
      f'<rect id="cursor" x="{f(-.10*r)}" y="{f(-.20*r)}" width="{f(.05*r)}" height="{f(.12*r)}" fill="{dark}" opacity="1"/>'
      f'<path d="M {f(-.33*r)} {f(.08*r)} H {f(.33*r)} L {f(.28*r)} {f(.17*r)} H {f(-.28*r)} Z" fill="{dark}" stroke="{dark}" stroke-width="{f(.03*r)}" stroke-linejoin="round"/></g>')
SCALE={'1-dot':1.0,'2-treble':1.0,'3-wave':0.85,'4-bounce':1.0}
place={}
for ch,g in G.items():
    k=SCALE[ch]; Rp=g['Rp']; hw=0.466*k*Rp; hb=0.25*k*Rp; ht=0.506*k*Rp
    LX=min(g['cx']+1.30*Rp, 99-hw); LY=min(g['cy']+0.50*Rp, 99-hb)
    place[ch]=dict(scale=k,LX=round(LX,2),LY=round(LY,2),box=[round(LX-hw,2),round(LY-ht,2),round(LX+hw,2),round(LY+hb,2)],rel=[round((LX-g['cx'])/Rp,2),round((LY-g['cy'])/Rp,2)])
json.dump(place,open('/workspace/WorkPal-avatar-visual/drafts/v0.7/assets/laptop-place.json','w'),indent=1,ensure_ascii=False)
def compose(ch,col,tier,laptop=True,xe=False,mask=None):
    s=open(C+f'{tier}_nf/{ch}-{col}.svg').read(); end=s.rindex('</svg>')
    if mask=='body':   # 只留身体轮廓，用于计算遮挡
        b=s[s.index('<g id="body"'):s.index('<g id="eyewhite"')]
        fit=s[s.index('<g id="fit"'):s.index('>',s.index('<g id="fit"'))+1]
        pre='<g transform="rotate(2.75 50 86.25)">' if ch=='4-bounce' else ''
        body=re.sub(r'fill="#[0-9a-fA-F]+"','fill="#000"',b); body=re.sub(r'stroke="#[0-9a-fA-F]+"','stroke="#000"',body)
        return s[:s.index('>',s.index('<svg'))+1]+fit+pre+body+('</g>' if pre else '')+'</g></svg>'
    if xe:
        x=open(F+f'assets/props/xeyes-{ch}.svg').read(); x=x[x.index('<g id="xeyes">'):x.rindex('</svg>')].replace('stroke="#000"',f'stroke="{DARK[tier][col]}"')
        if tier=='cs': x=re.sub(r'stroke-width="([\d.]+)"',lambda m:f'stroke-width="{float(m.group(1))*2.2:.3f}"',x)
        s=re.sub(r'(<g id="pupil[LR]")',r'\1 opacity="0"',s)
        close='</g></g></svg>' if ch=='4-bounce' else '</g></svg>'
        i=s.rindex(close); s=s[:i]+x+s[i:]; end=s.rindex('</svg>')
    if laptop:
        p=place[ch]; lap=laptop_g(DARK[tier][col],p['LX'],p['LY'],p['scale'],G[ch]['Rp'])
        if mask=='laptop': return s[:s.index('>',s.index('<svg'))+1]+re.sub(r'(fill|stroke)="#[0-9a-fA-F]+"',r'\1="#000"',lap)+'</svg>'
        s=s[:end]+lap+s[end:]
    return s
if __name__=='__main__':
    for col in DARK['c']:
        open(f'/workspace/WorkPal-avatar-visual/drafts/v0.7/assets/laptop-{col}.svg','w').write(
          f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-20 -20 40 40"><!-- v0.7 草案：笔记本，描边/底座/光标 = {col} 大档深色 {DARK["c"][col]}；本地坐标，按 laptop-place.json 摆放 --> '+laptop_g(DARK['c'][col],0,0,1.0,R)+'</svg>')
    print(json.dumps(place,ensure_ascii=False))
