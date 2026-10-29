from lib import *


def qrow(ic, title, who, target):
    return f'''<button type="button" class="pr" data-queue-for="{target}" data-queue-jump="{target}"><span class="ic">{ic}</span><span class="prt"><b>{title}</b><span class="t">{who} · pending Intervention</span></span><span class="go" aria-hidden="true">↗</span></button>'''


QUEUE = f'''<div id="attention-queue" class="pend" role="region" aria-label="Attention queue"><div class="pdh"><b>Attention queue</b><span class="cnt" data-queue-count>2</span><span class="sp"></span><span class="t">仅当前用户必须处理</span></div><div class="grp">Pending Interactions</div>{qrow('⌘', '运行构建命令', '墨 · Task：报告构建', 'interaction-tool')}{qrow('?', '补充报告周期', '小紫 · Task：Q3 报告', 'interaction-question')}<div id="queue-empty" class="emp" hidden>没有需要你处理的 Interaction</div><div class="pdf">点击只返回来源 Interaction；处理后条目立即消失。无运行历史、完成历史或普通后台工作。</div></div>'''
SIDEBAR = '''<div class="sbar"><div class="sbh">WorkPal</div><button type="button" class="sbi pdi" data-queue-open aria-expanded="true"><span>◉</span>Attention<span class="cnt" data-queue-count>2</span></button><div class="sbi on"><img src="1-dot-ink-s.svg" alt="">墨<span class="t">2 条未读</span></div><div class="sbi"><img src="4-bounce-purple-s.svg" alt="">小紫<span class="t">待处理 1</span></div></div>'''
TOOL = K('wait', '⌘', '运行构建命令', '等待本人决定', '<div class="s">写入构建产物并清理旧缓存。</div>', B(('l', '拒绝', 'data-resolve="interaction-tool" data-result-label="已拒绝"'), ('p', '允许一次', 'data-resolve="interaction-tool"')), ident='interaction-tool', source='来源 Bot：墨 · Task：报告构建 · Run：run-demo-n1 · Intervention：tool-demo-n1')
QUESTION = K('wait', '?', '补充报告周期', '等你回答', '<div class="in">本季度</div>', B(('l', '稍后再答'), ('p', '提交回答', 'data-resolve="interaction-question" data-result-label="已回答"')), ident='interaction-question', source='回复给 Bot：小紫 · Task：Q3 报告 · Intervention：question-demo-n1')
N1 = f'''<section id="n1"><h2>N1 · Attention queue <small>轻量待处理，不是第二个 Task Center</small></h2>{cap('可操作：点 queue 条目跳回来源；处理后条目与计数同步消失')}
{win('WorkPal', '当前用户的 pending Interactions', '<div class="three"><div class="wb">' + SIDEBAR + chat(TOOL, QUESTION) + '</div></div>')}{QUEUE}</section>'''

N2 = f'''<section id="n2"><h2>N2 · 群聊成员等待标记 <small>只标等待中的 Bot · 决定后消失</small></h2><div class="row"><div>{cap('成员面板')}
<div class="pad mp"><div class="mb"><span class="av"><img src="1-dot-ink-s.svg" alt=""></span><div><b>墨</b><div class="t">等待你的工具决定</div></div>{bd('wait','等你批准 1')}</div><div class="mb"><span class="av"><img src="3-wave-blue-s.svg" alt=""></span><div><b>小蓝</b><div class="t">普通后台工作</div></div><span class="t">运行中</span></div><div class="mb"><span class="av"><img src="2-treble-orange-s.svg" alt=""></span><div><b>小橙</b><div class="t">空闲</div></div></div></div></div>
<div>{cap('可寻址来源')}<div class="pad tx"><p>群聊问题和选择绑定 Bot，以及 Task 或明确 reply target。成员标记点击后只跳回来源 Interaction。</p><p>普通后台工作保留自己的工作投影，不加入 N1。</p></div></div></div></section>'''

N3 = f'''<section id="n3"><h2>N3 · 未读与待处理角标 <small>文字 + 形状 + 颜色共同区分</small></h2><div class="row r3"><div class="pad"><b>2 条未读</b><span class="bd">数字 2 · 普通未读</span><p class="t">打开会话后按未读规则清零。</p></div><div class="pad"><b>待处理 1</b><span class="bd wait">● 待处理 · 1</span><p class="t">只在 Intervention 不再 pending 后消失。</p></div><div class="pad"><b>@我</b><span class="bd fail">! @我 · 1</span><p class="t">Bot 间消息与进度更新不计未读。</p></div></div></section>'''

WEB1 = '''<div class="dnt"><div class="dnh"><span class="aic">W</span>Web Notification<span class="sp"></span><span class="t">现在</span></div><div class="dnb"><img src="1-dot-ink-s.svg" alt=""><div><b>墨 · 需要你批准</b><p>报告构建有一个工具审批。打开 WorkPal 查看。</p></div></div><div class="bt"><button type="button" class="btn p">查看来源</button></div></div>'''
WEB2 = '''<div class="dnt"><div class="dnh"><span class="aic">W</span>Web Push<span class="sp"></span><span class="t">按策略</span></div><div class="dnb"><img src="4-bounce-purple-s.svg" alt=""><div><b>小紫 · 草稿待处理</b><p>你有一个外发草稿需要处理。打开 WorkPal 查看。</p></div></div><div class="bt"><button type="button" class="btn p">查看来源</button></div></div>'''
N4 = f'''<section id="n4"><h2>N4 · Web 通知 <small>仅 Web Notification / 现有 Web Push · 不包含原生手机应用</small></h2><div class="row"><div class="pad">{cap('脱敏通知内容')}{WEB1}{WEB2}<p class="t">不包含收件人、正文、金额、卡号、地址、验证码、密码、参数或文件名；通知内不能直接批准。</p></div><div class="pad tx"><b>提醒策略</b><p>新 consequential 请求与接管请求可按设置通知；当前会话前台不通知。普通展示与后台进度不通知。</p><p>只有存在可信 expiresAt 时才允许按通知策略引用过期时间；不承诺固定提前量。终态后不再提醒。</p><p>点击通知回到来源 Interaction；若已终态，只展示终态。</p></div></div></section>'''

page('b-alerts.html', 'WorkPal 卡片 · ③ 4 类提醒场景', 'N1 Attention queue · N2 成员等待 · N3 未读角标 · N4 Web 通知', N1 + N2 + N3 + N4)
