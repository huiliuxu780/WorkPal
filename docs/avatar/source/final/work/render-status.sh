#!/bin/bash
# 生成 review-status-colors.png：浅色 / 深色样张 + 同色相风险格 4× 放大
set -e; cd "$(dirname "$0")/.."; U="file://$PWD/work/status-colors.html"
G="google-chrome --headless=new --no-sandbox --hide-scrollbars --virtual-time-budget=2000 --window-size=1400,420"
$G --force-device-scale-factor=2 --screenshot=/tmp/_sc2.png "$U" 2>/dev/null
$G --screenshot=/tmp/_sc1.png "$U" 2>/dev/null
$G --dump-dom "$U" 2>/dev/null | grep -o 'data-rects="[^"]*"' | sed 's/^data-rects="//;s/"$//;s/&quot;/"/g' > /tmp/_rects.json
python3 - <<'PY'
import json
from PIL import Image,ImageDraw,ImageFont
F=ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',22)
r=json.load(open('/tmp/_rects.json')); a=Image.open('/tmp/_sc2.png').convert('RGB'); one=Image.open('/tmp/_sc1.png').convert('RGB')
x1=max(v[2] for v in r.values())+24; y1=max(v[3] for v in r.values())+40
top=a.crop((0,0,x1*2,y1*2))
pairs=[('l','answer','blue','浅色 · 等你回答 #3F8FDF 在蓝 Bot #4184f4 上'),('d','answer','blue','深色 · 等你回答 #7CB8F2 在蓝 Bot 上'),
       ('l','approval','orange','浅色 · 等审批 #d97706 在橙 Bot #e8983a 上'),('d','approval','orange','深色 · 等审批 #F5C84B 在橙 Bot 上'),
       ('l','fail','pink','浅色 · 失败 #e5484d 在粉 Bot #e54896 上'),('l','run','blue','浅色 · 运行中 #22a356 在蓝 Bot 上（对照）')]
tiles=[]
for th,k,c,lab in pairs:
    b=r[f'{th}-{k}-{c}']; cr=one.crop((b[0]+2,b[1]+2,b[2]-2,b[3]-2)); z=cr.resize((cr.width*4,cr.height*4),Image.NEAREST)
    t=Image.new('RGB',(max(z.width+20,740),z.height+74),'white'); t.paste(z,(10,68)); d=ImageDraw.Draw(t); d.text((10,6),lab,fill=(60,60,60),font=F); d.text((10,36),'1× 截图放大 4 倍'+('（同色相，描边加粗）' if (k,c) in {('answer','blue'),('approval','orange'),('fail','pink')} else ''),fill=(140,140,140),font=F); tiles.append(t)
tw=max(t.width for t in tiles); th_=max(t.height for t in tiles)
W=Image.new('RGB',(max(top.width,tw*3+20),top.height+th_*2+30),'white'); W.paste(top,(0,0))
for i,t in enumerate(tiles): W.paste(t,(10+(i%3)*tw,top.height+10+(i//3)*th_))
W.save('review-status-colors.png'); print(W.size)
PY
