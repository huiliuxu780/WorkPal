from lib import *

P = [
    ('cards.html', '① 27 个产品场景', 'A1–A13 · D1–D7 · B1–B7；含 A12 两步付款与 B3 分步安装授权', 'shot-cards.png'),
    ('a-detail.html', '② 7 个详情场景', 'V1–V7；A10 同卡 revision、fingerprint 与最终发送确认', 'shot-a-detail.png'),
    ('b-alerts.html', '③ 4 类提醒场景', 'N1 Attention queue · N2 成员等待 · N3 未读 · N4 Web 通知', 'shot-b-alerts.png'),
    ('c-states.html', '④ 状态与环境', '三个状态所有者 · 390/375px · 深色 · 键盘与读取失败', 'shot-c-states.png'),
]
cards = ''.join(f'<a class="ix" href="{h}"><div class="ixi" style="background-image:url({s})"></div><b>{t}</b><span class="t">{d}</span></a>' for h, t, d, s in P)
CHECKS = [
    ('目标协议', 'InteractionView = InputRequestView | ActionApprovalView | PlanReviewView | SessionControlView；严格 payload，不从可选字段猜类型。'),
    ('三个状态所有者', 'Intervention、Run、ExternalEffect 分开；Run 结束不自动终止 Interaction。'),
    ('权威结果', 'ExternalEffect 或业务事务；agent.tool.completed 仅是执行活动。'),
    ('关键路径', 'A10 revision/fingerprint · A12 两步付款 · B3 安装/授权 · N1 来源跳转 · 重新加载。'),
    ('视觉与无障碍', '每张互动卡至多两个按钮和一个文字入口；终态可读；390px 主验收与 375px 回归。'),
    ('演示边界', '本地确定性状态切换；无真实网络成功提示；通知只画 Web 能力。'),
]
checks = ''.join(f'<div class="check"><b>{a}</b><span class="t">{b}</span></div>' for a, b in CHECKS)
body = f'''<div class="ann"><b>产品评审入口</b>　先读 <a href="../../card-requirements.md">PRD</a>、<a href="../../card-unification.md">统一说明</a> 与 <a href="STYLE-SPEC.md">STYLE-SPEC</a>。本原型对应 CARD-01 已确认决策，不代表生产 API 已存在或实现阻塞已解除。</div><div class="ixg">{cards}</div><h2>覆盖清单</h2><div class="checklist">{checks}</div><h2>原型操作提示</h2><div class="pad tx">使用 Tab 浏览控件，Enter/Space 只触发当前聚焦按钮，Esc 关闭最上层。A10 在详情页操作；A12 与 B3 在卡片总览操作；N1 在提醒页操作；读取失败“重新加载”在状态页操作。所有业务状态变化均为本地确定性演示。</div>'''
page('index.html', 'WorkPal 消息卡片 · CARD-01 v4 对齐版', '27 个产品场景 · 7 个详情场景 · 4 类提醒 · 可运行本地演示', body)
