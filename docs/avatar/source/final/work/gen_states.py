# 生成侧边栏用的「工作中 / 出错」静帧（v0.7 草案）：写到 mockups/color/{c,cs}_nf/<角色>-<颜色>-work|fail.svg
import sys,re; sys.path.insert(0,'/workspace/WorkPal-avatar-visual/drafts/v0.7/assets'); import props_v07 as P
OUT='/workspace/WorkPal-ui-review/mockups/color/'
BOT={'1-dot':86.75,'2-treble':86.75,'3-wave':80.25,'4-bounce':86.25}
def fit_meta(s):
    m=re.search(r'data-s="([\d.]+)" data-cx="([\d.]+)" data-cy="([\d.]+)"',s); return map(float,m.groups())
def work(ch,col,tier):
    s=P.compose(ch,col,tier,laptop=True)
    # 瞳孔偏右 +0.12R′（v0.6 3.2 静帧）；瞳孔在 fit 内，原坐标 0.12R = 3.75
    s=s.replace('<g id="pupilL"','<g transform="translate(3.75 0)"><g id="pupilL"',1)
    k=s.index('<g id="symbol"'); s=s[:k]+'</g>'+s[k:]
    return s
def fail(ch,col,tier):
    s=P.compose(ch,col,tier,laptop=False,xe=True)
    sc,bx,by=fit_meta(s); px=50+sc*(50-bx); py=50+sc*(BOT[ch]-by); Rp=31.25*sc
    # 泄气下沉 0.06R′、sy 0.95、sx 1.03（底部中点）；符号耷拉 0.04R′、转 8°
    i=s.index('<g id="fit"'); j=s.rindex('</svg>')
    s=s[:i]+f'<g transform="translate(0 {0.06*Rp:.3f}) translate({px:.3f} {py:.3f}) scale(1.03 0.95) translate({-px:.3f} {-py:.3f})">'+s[i:j]+'</g>'+s[j:]
    k=s.index('<g id="symbol"'); 
    end=s.index('<g class="xe"') if '<g class="xe"' in s else None
    s=s[:k]+'<g transform="translate(0 1.25) rotate(8 50 30)">'+s[k:]
    close='</g></g></g></svg>' if ch=='4-bounce' else '</g></g></svg>'
    # 符号组在 x 叉眼之后插入的位置之前结束：简单做法——在 xeyes 前闭合
    xi=s.index('<g id="xeyes">'); s=s[:xi]+'</g>'+s[xi:]
    return s
for tier in ('c','cs'):
    for ch in BOT:
        for col in P.DARK['c']:
            open(OUT+f'{tier}_nf/{ch}-{col}-work.svg','w').write(work(ch,col,tier))
            open(OUT+f'{tier}_nf/{ch}-{col}-fail.svg','w').write(fail(ch,col,tier))
print('ok')
