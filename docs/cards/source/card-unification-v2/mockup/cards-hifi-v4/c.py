from lib import *


def state_card(kind, title):
    loading = K('ld', '◌', title, '加载中', '<i class="skl" style="width:90%"></i><i class="skl" style="width:65%"></i><div class="t">快照完整前控件禁用</div>')
    streaming = K('wait', '↻', title, '生成中', '<div class="s">内容逐步出现；尚未形成可处理请求。</div><div class="bar"><i></i></div>')
    empty = K('', '□', title, '空内容', '<div class="emp">没有可展示的数据</div>')
    error_body = '<div class="s">读取服务端状态失败，尚未得知最新展示状态。</div>' if kind == 'read' else '<div class="s">内容定义无效，未执行任何动作。</div>'
    error = K('fail', '!', title, '读取失败' if kind == 'read' else '内容无效', error_body)
    return f'<tr><th>{title}</th><td>{loading}</td><td>{streaming}</td><td>{empty}</td><td>{error}</td></tr>'


RELOAD_DEMO = K('fail', '!', 'Routine 展示状态', '读取失败', '<div class="s">读取服务端状态失败，尚未得知最新展示状态。</div><div id="reload-content" class="t" aria-live="polite"></div><div id="reload-count" class="t"></div>', B(('', '重新加载', 'data-reload')), ident='reload-card', source='只重新读取展示状态；不调用 Routine 变更或任何外部动作')
C1 = f'''<section id="c1"><h2>C1 · 加载、流式、空与出错 <small>只有读取失败提供“重新加载”，不会重新执行动作</small></h2><div class="stt-wrap"><table class="stt"><tr><th></th><th>加载中</th><th>流式生成中</th><th>内容为空</th><th>出错</th></tr>{state_card('read','Interaction / Routine')}{state_card('content','DisplayBlock')}</table></div><h3>可操作的读取失败场景</h3><div class="pad">{RELOAD_DEMO}<p class="note">本地确定性演示：只更新展示状态，动作执行次数保持 0。按钮独立于横向滚动表格，窄屏也可操作。</p></div></section>'''

AUTHORITY = '''<section id="owners"><h2>三个状态所有者 <small>UI 可合成文案，持久状态不合并</small></h2><div class="table-scroll"><table class="tbl"><tr><th>所有者</th><th>回答的问题</th><th>示例</th></tr><tr><td>Intervention</td><td>用户是否仍需回答或决定</td><td>pending / answered / declined / superseded</td></tr><tr><td>Run</td><td>这一轮是否仍在执行</td><td>running / completed / stopped</td></tr><tr><td>ExternalEffect / 业务事务</td><td>外部动作是否执行、结果是否确定</td><td>executing / succeeded / failed / uncertain</td></tr></table></div><div class="row r3"><div class="pad"><b>Run 已结束</b><p class="tx">pending 输入请求仍可回答；保留来源、权限与 expiry。</p></div><div class="pad"><b>外部结果未知</b><p class="tx">运行已停止，发送结果未确认。没有“已作废”，也没有重新执行按钮。</p></div><div class="pad"><b>活动事件边界</b><p class="tx">agent.tool.completed 只表示执行活动；付款、发信、安装与 Routine 以业务事实为准。</p></div></div></section>'''

DRAFT = K('wait', '✉', '邮件草稿 · r2', '待发送', '<div class="mail mc"><div class="to"><span>收件人</span>review@example.com</div><div class="sj">评审改期到周五 15:00</div><p class="clip">最终发送前显示完整正文与 fingerprint。</p></div>', B(('', '查看 / 编辑'), ('p', '审阅发送')), source='来源 Bot：小紫 · Task：评审协调')
APPR = K('wait', '⌘', '运行构建命令', '等待本人决定', '<div class="s">按钮在窄屏可换行，不截断、不遮挡。</div>', B(('l', '拒绝'), ('p', '允许一次')))
C2 = f'''<section id="mobile"><h2>C2 · 390px 窄屏主画面 <small>另跑 375px 文档溢出回归</small></h2><div class="row r3m"><div class="mph"><div class="mst"><span>11:16</span><span>Web 原型</span></div><div class="mtb"><span>‹</span><b>小紫</b><span class="cnt">2</span></div><div class="chat">{U('告诉示例联系人评审改期')}{M('小紫', DRAFT)}{M('墨', APPR)}</div><div class="mip">发消息…</div></div><div class="pad tx"><b>响应式规则</b><p>主验收 viewport 为 390px；375px 额外验证 document.documentElement.scrollWidth 不超过 viewport。</p><p>按钮最小高度 44px，允许换行；标题与来源可换行，详情使用可用宽度。</p><p>结构化表格只在自身容器横向滚动，不撑宽文档。</p></div></div></section>'''

C3 = f'''<section id="dark"><h2>C3 · 深色与状态可读性 <small>页面右上可实际切换主题</small></h2><div class="dark-demo">{win('WorkPal', '深色语义示例', chat(M('小紫', DRAFT), M('小橙', K('ok', '✓', '已保存选择', '已回答', '<div class="s">终态正文保持完整可读，使用 ✓ 图标、文字和颜色共同表达。</div>')), M('小蓝', K('fail', '⬡', '授权失败', '授权失败', '<div class="s">安装已完成；授权失败独立显示。正文不降低整块透明度。</div>')), M('墨', K('exp', '◷', '输入请求', '已过期', '<div class="s">原问题与来源仍可读；没有重新执行入口。</div>'))))}</div></section>'''

TERMINAL = f'''<section id="terminal"><h2>终态与未知结果 <small>正文不淡化 · 无重新执行按钮</small></h2><div class="grid"><div class="pad">{K('rej', '✉', '外发草稿', '已拒绝', '<div class="s">正文和收件人保持可读；未发送。</div>')}</div><div class="pad">{K('fail', '⬡', '授权连接', '授权失败', '<div class="s">安装已完成；授权事务失败。</div>')}</div><div class="pad">{K('fail', '↗', '外发结果', 'Run：已停止 · Effect：uncertain', '<div class="s"><b>运行已停止，发送结果未确认</b></div><div class="t">不要假设未发送，也不要自动再次发送。</div>')}</div></div></section>'''

KB_ROWS = ''.join(f'<tr><td>{a}</td><td>{b}</td><td>{c}</td></tr>' for a, b, c in [
    ('Tab / Shift+Tab', '页面与对话框', '按 DOM 顺序浏览控件；原生 dialog 约束焦点。'),
    ('Enter / Space', '当前聚焦控件', '只触发该控件；没有全局 consequential 快捷键。'),
    ('Esc', '最上层', '关闭 dialog、面板或 queue；不等于拒绝或取消。'),
    ('焦点恢复', '关闭后', '返回触发入口；来源 Interaction 可被聚焦。'),
    ('状态播报', 'aria-live="polite"', 'revision、queue、安装与重新加载结果可被读出。'),
])
C4 = f'''<section id="keyboard"><h2>C4 · 键盘与无障碍 <small>文字、图标或形状和颜色共同表达状态</small></h2><div class="row"><div class="pad"><b>可聚焦示例</b><button type="button" class="btn">次按钮</button><button type="button" class="btn p">主按钮</button><p class="t">Tab 到此按钮后按 Enter 才触发；页面没有全局发送或批准监听。</p></div><div class="pad"><b>减少动态效果</b><p class="tx">遵循 prefers-reduced-motion；焦点使用 :focus-visible 外描边。所有状态都有文本，失败使用方形/叹号，过期使用空心环。</p></div></div><div class="table-scroll"><table class="tbl"><tr><th>按键/能力</th><th>作用域</th><th>行为</th></tr>{KB_ROWS}</table></div></section>'''

page('c-states.html', 'WorkPal 卡片 · ④ 状态和环境', '独立状态所有者 · 加载/读取失败 · 390/375px · 深色 · 键盘', AUTHORITY + C1 + C2 + C3 + TERMINAL + C4)
