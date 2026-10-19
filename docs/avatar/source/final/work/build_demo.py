#!/usr/bin/env python3
# 把 demo/template.html + demo/frame.js + demo/layers.json 合成为自包含的 demo/index.html（file:// 下可直接打开）
D='/workspace/WorkPal-avatar-visual/release-v0.7/demo/'
t=open(D+'template.html').read().replace('/*LAYERS*/',open(D+'layers.json').read()).replace('/*FRAMEJS*/',open(D+'frame.js').read())
open(D+'index.html','w').write(t); print('index.html',len(t))
