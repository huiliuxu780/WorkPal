#!/bin/bash
# 重新生成 v0.7 演示截图、关键帧和 compare.gif（需要 google-chrome、python3 + Pillow）
set -e; cd "$(dirname "$0")/.."; python3 work/build_demo.py >/dev/null
U="file://$PWD/demo/index.html"; G="google-chrome --headless=new --no-sandbox --hide-scrollbars --virtual-time-budget=4000"
mkdir -p work/gif && rm -f work/gif/*.png
$G --force-device-scale-factor=2 --window-size=990,620 --screenshot=demo/light.png "$U?t=3000" 2>/dev/null
$G --force-device-scale-factor=2 --window-size=990,620 --screenshot=demo/dark.png "$U?t=3000&dark=1" 2>/dev/null
$G --force-device-scale-factor=2 --window-size=990,620 --screenshot=demo/static.png "$U?t=0&rm=1" 2>/dev/null
$G --window-size=1100,1000 --screenshot=demo/v7.png "$U?t=3000" 2>/dev/null
for t in 0 150 300 400 560 720 940 1240; do $G --force-device-scale-factor=2 --window-size=1100,620 --screenshot=work/gif/f$(printf %04d $t).png "$U?t=$t" 2>/dev/null; done
for t in $(seq 0 50 5950); do $G --window-size=1100,620 --screenshot=work/gif/g$(printf %05d $t).png "$U?t=$t" 2>/dev/null; done
python3 work/compose.py
rm -rf work/gif
