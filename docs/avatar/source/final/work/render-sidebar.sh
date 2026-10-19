#!/bin/bash
# 用新状态色（SPEC.md §4，2026-10-19 确认）重拍侧边栏草图 review-9-sidebar.png。
# 只读引用 /workspace/WorkPal-ui-review/mockups/conversation.html：复制到 /tmp，覆盖状态色变量，不改原文件。
set -e
cd "$(dirname "$0")/.."
M=/workspace/WorkPal-ui-review/mockups
T=/tmp/wp-sidebar-$$; mkdir -p $T
CSS='<base href="file://'$M'/"><style>:root{--run:#22a356!important;--wait:#d97706!important;--fail:#e5484d!important;--ok:#22a356!important}
.bd[style*="--fail"]{display:grid;place-items:center;color:#fff;font:800 9px/1 system-ui}.bd[style*="--fail"]::after{content:"!"}.bd.hue{border-width:2.5px!important}</style>'
# 同色相加粗描边（SPEC §4.2）：等审批在 orange/brown、失败在 pink → 2.5px
JS='<script>const HUE={"--wait":["orange","brown"],"--fail":["pink"]};document.querySelectorAll(".bd").forEach(b=>{const i=b.parentElement.querySelector("img[data-col]");const st=b.getAttribute("style")||"";for(const k in HUE)if(st.includes(k)&&i&&HUE[k].includes(i.dataset.col))b.classList.add("hue")})</script>'
python3 - "$M/conversation.html" "$T/c.html" "$CSS" "$JS" <<'P'
import sys; s=open(sys.argv[1]).read(); s=s.replace('<head>','<head>'+sys.argv[3],1); s=s.replace('</body>',sys.argv[4]+'</body>') if '</body>' in s else s+sys.argv[4]; open(sys.argv[2],'w').write(s)
P
G="google-chrome --headless=new --no-sandbox --disable-gpu --hide-scrollbars --virtual-time-budget=4000 --force-device-scale-factor=2"
$G --window-size=1440,900 --screenshot=$T/a.png "file://$T/c.html" 2>/dev/null
$G --window-size=1440,900 --screenshot=$T/b.png "file://$T/c.html?collapsed=1" 2>/dev/null
python3 - $T <<'P'
import sys; from PIL import Image
t=sys.argv[1]; a=Image.open(t+'/a.png'); b=Image.open(t+'/b.png')
im=Image.new('RGB',(860,520),(252,252,252))
im.paste(a.crop((0,0,680,520)),(0,0)); im.paste(b.crop((0,0,164,520)),(696,0))
im.save('review-9-sidebar.png')
P
rm -rf $T; echo review-9-sidebar.png
