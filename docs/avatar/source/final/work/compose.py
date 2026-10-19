import glob
from PIL import Image,ImageDraw,ImageFont
F=ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',20)
# compare.gif：4 角色 × 5 状态，0–6s，50ms 一帧
fr=[Image.open(f).convert('RGB').crop((132,142,408,592)) for f in sorted(glob.glob('work/gif/g*.png'))]
pal=[f.quantize(colors=96,method=Image.MEDIANCUT) for f in fr]
pal[0].save('assets/compare.gif',save_all=True,append_images=pal[1:],duration=50,loop=0,optimize=True)
# 出错关键帧（64 + 24px），2×
lab={0:'0 静止',150:'150 吓一跳顶点',300:'300 落回·叉眼开始',400:'400 第1摆 −6°',560:'560 第2摆 +4.5°',720:'720 第3摆 −2.5°',940:'940 摇停',1240:'1240 泄气·停住'}
tiles=[]
for f in sorted(glob.glob('work/gif/f*.png')):
    t=int(f[-8:-4]); im=Image.open(f).convert('RGB').crop((264,1004,1636,1184))
    tile=Image.new('RGB',(1372,216),'white'); tile.paste(im,(0,36)); ImageDraw.Draw(tile).text((8,4),'出错 t = '+lab[t]+' ms',fill=(60,60,60),font=F); tiles.append(tile)
W=Image.new('RGB',(1372*2+10,216*4),'white')
for i,t in enumerate(tiles): W.paste(t,((i%2)*1382,(i//2)*216))
W.save('review-2-failed-keyframes.png')
# 24px 放大（每状态一行，原样 + 4×）
im=Image.open('work/gif/g03000.png').convert('RGB')
rows=[im.crop((620,y+20,818,y+70)) for y in (142,232,322,412,502)]
Z=Image.new('RGB',(198+792+30,5*200+10),'white')
for i,r in enumerate(rows): Z.paste(r,(5,10+i*200+75)); Z.paste(r.resize((792,200),Image.NEAREST),(220,10+i*200))
Z.save('demo/z24.png'); print('ok',len(fr))
