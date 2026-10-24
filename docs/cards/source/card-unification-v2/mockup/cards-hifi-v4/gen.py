import sys
sys.dont_write_bytecode = True

from lib import *

cols = []


def col(title, items):
    cols.append(f'<section class="col"><div class="top">{title}</div><div class="feed">{"".join(items)}</div></section>')


def scene(title, items):
    return [f'<div class="cap">{title}</div>'] + items


mail = '<div class="mail mc"><div class="to"><span>收件人</span>review@example.com</div><div class="sj">评审改期到周五 15:00</div><p class="clip">周五评审改到 15:00，地点不变。请带一页 Q3 结论，议程见附件。</p></div>'

# A1–A13：13 个互动产品场景。
col('A1 · requestApproval(tool)', scene('工具审批 · 可寻址来源', [
    U('重新构建报告模块'),
    M('墨', K('wait', '⌘', '运行构建命令', '等待本人决定', '<div class="s">写入构建产物并清理旧缓存。</div><a class="more" href="a-detail.html#v5">查看完整命令与参数 →</a>', B(('l', '拒绝'), ('p', '允许一次')), source='来源 Bot：墨 · Task：报告构建 · Run：run-demo-01 · Step：2')),
    note('按钮只提交决定；工具活动事件不单独证明外部结果。')
]))
col('A2 · requestInput(secret)', scene('密钥输入 · 私聊收集', [
    M('小蓝', K('wait', '◇', '填写连接密钥', '等你填写', '<div class="s">仅用于示例服务连接；值不会进入消息或日志。</div><div class="in">••••••••••••</div>', B(('l', '取消'), ('p', '安全保存')), source='来源 Bot：小蓝 · Task：连接示例服务 · 私聊 Intervention：input-demo-02')),
    note('群聊只给私聊引导；完成后的群回执脱敏。')
]))
col('A3 · requestInput(secret)', scene('登录 · 两个敏感字段', [
    M('小橙', K('wait', '↗', '登录示例网站', '等你填写', '<div class="fm"><label>用户名<span class="in">demo-user</span></label><label>密码<span class="in">••••••••</span></label></div>', B(('l', '取消'), ('p', '安全保存')), source='来源 Bot：小橙 · Task：示例网站登录 · 私聊')),
    note('只回显非敏感用户名；密钥内容永不出现在对话中。')
]))
col('A4 · requestInput(question)', scene('群聊提问 · 回复目标明确', [
    U('@墨 需要补充什么？'),
    M('墨', T('请补充报告周期：本季度还是全年？') + K('wait', '?', '报告周期', '等你回答', '<div class="in">本季度</div>', B(('l', '稍后再答'), ('p', '提交回答')), source='回复给 Bot：墨 · Task：Q3 报告 · reply target：question-demo-04')),
    note('不是孤立追问；回答绑定 Bot、Task 和 reply target。')
]))
col('A5 · requestInput(choice)', scene('群聊选择 · 不依赖孤立“A”', [
    M('小紫', K('wait', 'A', '选择报告版式', '等你选择', '<div class="pick"><label><input type="radio" name="layout" checked> 一页结论</label><label><input type="radio" name="layout"> 完整报告</label></div>', B(('l', '取消'), ('p', '提交选择')), source='回复给 Bot：小紫 · Task：Q3 报告 · choice：choice-demo-05')),
    note('选项只是输入；提交事务以 Intervention resolution 为准。')
]))
col('A6 · requestApproval(tool)', scene('创建空间 · 本人决定', [
    M('墨', K('wait', '+', '创建“Q3 评审”Space', '等待本人决定', '<dl class="kv"><dt>用途</dt><dd>汇总评审材料</dd><dt>成员</dt><dd>3 位演示成员</dd></dl>', B(('l', '取消'), ('p', '创建')), source='来源 Bot：墨 · Task：评审准备 · ExternalEffect：创建后单独记录')),
]))
col('A7 · requestApproval(connect)', scene('授权 · 与安装分离', [
    M('小蓝', K('wait', '⬡', '授权 Notion 连接', '等待本人授权', '<dl class="kv"><dt>范围</dt><dd>读写所选页面</dd><dt>前提</dt><dd>连接器已安装</dd></dl>', B(('l', '暂不'), ('p', '授权')), source='来源 Bot：小蓝 · Task：会议同步 · 授权 Intervention：connect-demo-07')),
    note('OAuth 窗口关闭但未完成时保持 pending，不记为外部失败。')
]))
col('A8 · requestApproval(tool)', scene('保存技能 · 内容快照', [
    M('小紫', K('wait', 'S', '保存技能“周报整理”', '等待本人决定', '<div class="s">目标：把本周记录整理成周报。保存绑定当前内容快照。</div>', B(('l', '丢弃'), ('p', '保存')), source='来源 Bot：小紫 · Task：技能教学 · revision：skill-r1')),
]))
col('A9 · requestSessionControl(takeover)', scene('接管电脑 · 只暂停当前 Bot', [
    M('小橙', K('wait', '▭', '需要你完成验证码', '等待接管', '<div class="s">打开桌面后由你操作；不收集密码或验证码。</div>', B(('l', '不做了'), ('p', '打开桌面')), source='来源 Bot：小橙 · Task：车票预订 · session：takeover-demo-09')),
]))
col('A10 · requestApproval(outbound)', scene('外发草稿 · 最新 pending revision', [
    U('告诉示例联系人评审改期'),
    M('小紫', K('wait', '✉', '邮件草稿 · r1', '待发送', mail, '<div class="bt"><a class="btn p" href="a-detail.html#v1">查看与编辑</a></div>', ident='a10-summary', source='来源 Bot：小紫 · Task：评审协调 · Intervention：outbound-demo-10')),
    note('同卡编辑；保存形成不可变 revision，最终发送绑定 fingerprint。')
]))
col('A11 · requestInput(form)', scene('结构化表单 · 就地校验', [
    M('小橙', K('wait', '≡', '补充收货信息', '等你填写', '<div class="fm"><label>收货地址<span class="in">示例市示例路 88 号</span></label><div class="row"><label>电话<span class="in">138••••8000</span></label><label>邮编<span class="in">200000</span></label></div></div>', B(('l', '取消'), ('p', '提交')), source='来源 Bot：小橙 · Task：采购 · form：form-demo-11')),
    note('敏感支付信息走 saved_item 或 secret，不混入普通表单。')
]))
col('A12 · requestInput(saved_item)', scene('选择已保存项 · 此步不付款', [
    U('再买一箱矿泉水'),
    M('小橙', K('wait', '¥', '选择付款卡与地址', '等你选择', '<div class="pick"><div class="lb">付款卡</div><label><input type="radio" name="demo-card" data-label="示例卡 •••• 4821" checked> 示例卡 <span class="mask">•••• 4821</span></label></div><div class="pick"><div class="lb">收货地址</div><label><input type="radio" name="demo-address" data-label="家 · 示例路 88 号" checked> 家 · 示例路 88 号</label></div><div id="selection-result" class="t" aria-live="polite">只选择已保存项，不发生扣款。</div>', B(('p', '确认选择', 'id="save-selection"')), ident='a12-select', source='来源 Bot：小橙 · Task：采购 · Intervention：saved-item-demo-12')),
    M('小橙', K('wait', '¥', '独立付款审批 · ¥59.90', '等待本人付款决定', '<dl class="kv"><dt>商户</dt><dd>示例商店</dd><dt>金额</dt><dd>¥59.90</dd><dt>付款卡</dt><dd>•••• 4821</dd></dl><div id="payment-result" class="t" aria-live="polite">A12 完成后才出现；未经本人确认不得扣款。</div>', B(('l', '拒绝付款', 'data-payment-decision="deny"'), ('p', '确认付款', 'data-payment-decision="approve"')), ident='payment-approval', cls='payment-approval', source='独立 Intervention：payment-demo-12b · ExternalEffect / 支付事务是结果权威').replace('id="payment-approval"', 'id="payment-approval" hidden')),
    note('两个连续场景：saved_item resolution → payment approval。')
]))
col('A13 · PlanReviewView（plan_review）', scene('计划审阅 · 独立成员，不进入工具授权', [
    M('墨', K('wait', '≡', '审阅报告计划 · v2', '等待本人审阅', '<div class="s">1. 聚合数据　2. 生成图表　3. 提交结论</div><div class="t">批准此计划版本不批准任何工具调用、连接器或凭据。</div><div class="t">旧 revision 保留 superseded；只有 v2 可审阅。</div>', B(('l', '拒绝'), ('p', '批准计划')), ident='a13-plan-review', source='来源 Bot：墨 · Task：Q3 报告 · plan_review Intervention · plan revision：v2')),
    note('独立 plan_review 成员；后续工具、连接器与付款各自审批。')
]))

# D1–D7：7 个展示产品场景。
col('D1 · showContent(markdown)', scene('Markdown · 按渲染高度折叠', [
    M('墨', '<div class="b lm"><p>结论：保留高效渠道，收缩低效投放。</p><p>详细说明按实际渲染行数或高度折叠，而不是按字符数。</p><a href="a-detail.html#v3" class="more">展开全文 →</a></div>'),
    note('简单静态表格可保留在 Markdown；复杂数据用结构化 table。')
]))
col('D2 · showContent(table)', scene('结构化表格 · 排序与分页', [
    M('小蓝', K('', '▦', '渠道经营对比', '6 行数据', '<div class="table-scroll"><table class="tbl"><tr><th>渠道</th><th>营收</th><th>变化</th></tr><tr><td>华东</td><td>97</td><td>+10%</td></tr><tr><td>华南</td><td>81</td><td>+4%</td></tr></table></div>', '<div class="bt"><button type="button" class="btn x">按营收排序</button></div>')),
    note('排序、筛选和分页由结构化 columns / rows 驱动。')
]))
col('D3 · showContent(chart)', scene('图表 · 有数据表替代', [
    M('小蓝', K('ok', '⌁', '季度营收趋势', '展示', '<svg viewBox="0 0 320 120" width="100%" role="img" aria-label="5月至10月营收总体上升"><polyline points="10,100 65,82 120,90 175,60 230,44 300,22" fill="none" stroke="#1680f3" stroke-width="3"/></svg><a href="a-detail.html#v2" class="more">打开图表与数据表 →</a>')),
]))
col('D4 · showContent(collection)', scene('集合 · 只读条目与链接', [
    M('小橙', K('', '▤', '三个候选结果', '展示', '<div class="steps"><div class="step">候选 A · 现货</div><div class="step">候选 B · 明日送达</div><div class="step">候选 C · 线下自提</div></div><a class="more" href="#d4-example" id="d4-example">查看只读详情 →</a>')),
    note('条目内没有购买按钮；购买必须另发审批。')
]))
col('D5 · showContent(media)', scene('媒体 · 图片与文件', [
    M('小紫', K('', '↗', '评审材料', '2 个文件', '<div class="steps"><a class="step" href="a-detail.html#v4">PDF · 评审议程</a><a class="step" href="a-detail.html#v4">XLSX · 数据摘要</a></div>')),
]))
html_rules = '<div class="share-rules"><b>复杂只读报告</b><br>无同源 · 无网络 · 无表单提交<br>无父页面访问 · 无顶层跳转</div>'
col('D6 · showContent(html)', scene('HTML 沙箱 · 无副作用控件', [
    M('小蓝', K('', '▤', 'Q3 经营报告', 'Agent 生成 · 只读', html_rules + '<a class="more" href="a-detail.html#v2">打开只读报告 →</a>')),
    note('批准、付款、发送、删除和授权不得放在 HTML 内。')
]))
col('D7 · showContent(task_status)', scene('任务状态 · 不是 attention queue', [
    M('小蓝', K('run', '◷', 'Q3 报告任务', 'Run：运行中', '<div class="steps2"><div class="st2"><span class="d2 ok"></span>取数<em>完成</em></div><div class="st2"><span class="d2 run"></span>出图<em>运行中</em></div></div><a class="more" href="a-detail.html#v6">查看运行详情 →</a>')),
    note('普通后台工作留在工作投影，不进入 N1。')
]))

# B1–B7：7 个补充产品场景。
col('B1 · requestSessionControl(return)', scene('交还桌面 · 独立会话控制', [
    M('小橙', K('wait', '▭', '你正在操作桌面', '等待交还', '<div class="s">完成后把控制权交还给小橙。</div>', B(('l', '保持接管'), ('p', '交还给 Bot')), source='session：takeover-demo-09 · 与 A9 同源')),
]))
col('B2 · requestApproval(routine)', scene('Routine 修改 · 业务事务确认', [
    M('墨', K('wait', '↻', '修改每日 AI 摘要', '等待本人决定', '<dl class="diff"><dt>触发</dt><dd><del>每天 08:00</del> → <ins>每天 08:30</ins></dd><dt>时区</dt><dd>Asia/Shanghai</dd></dl>', B(('l', '保留原设置'), ('p', '确认修改')), source='来源 Bot：墨 · Routine：routine-demo-b2 · 结果以 Routine 事务为准')),
]))
col('B3 · install + connect', scene('安装与授权 · 两个独立后端动作', [
    M('小蓝', K('wait', '⬡', '安装 Notion 连接器', '等待安装决定', '<div class="steps"><div id="install-step" class="step">安装：待处理</div><div id="auth-step" class="step">授权：未开始</div></div><div id="install-audit" class="t" aria-live="polite">安装与授权分别记录状态和审计。</div>', B(('l', '暂不安装', 'data-install-secondary'), ('p', '安装', 'data-install-primary')), ident='install-demo', source='安装事务：install-demo-01 · 授权 Intervention：connect-demo-b3')).replace('id="install-demo"', 'id="install-demo" data-stage="pending"'),
    M('小蓝', K('fail', '⬡', '安装失败 · 授权未开始', '安装失败', '<div class="steps"><div class="step fail">安装：包校验失败</div><div class="step">授权：未开始</div></div><div class="t">没有重新执行按钮；审计保留安装失败事实。</div>')),
    M('小蓝', K('fail', '⬡', '已安装 · 授权失败', '授权失败', '<div class="steps"><div class="step ok">安装：已完成</div><div class="step fail">授权：账号范围未开放</div></div><div class="t">安装结果保持完成；授权失败独立记录。</div>')),
]))
col('B4 · showContent(page)', scene('Page 入口 · 展示类型', [
    M('小紫', K('ok', '▤', 'Q3 销售看板', '已更新', '<div class="pg"><div class="th"><i></i><div class="c"><b style="height:40%"></b><b style="height:75%"></b><b style="height:55%"></b></div></div><div class="pt"><b>销售看板</b><div class="t">Space 内 · 按 Page 权限打开</div></div></div>', '<div class="bt"><a class="btn p" href="a-detail.html#v2">打开</a></div>')),
]))
col('B5 · showContent(voice)', scene('语音消息 · 展示与转写', [
    M('墨', '<div class="vo"><button type="button" class="pl" aria-label="播放语音">▶</button><span class="wv" aria-hidden="true">' + ''.join(f'<i style="height:{h}px"></i>' for h in (6, 12, 18, 9, 15, 20, 8, 13, 6, 17)) + '</span><span class="tm">0:14</span></div><div class="t">转写：周五评审改到下午三点。</div>'),
]))
col('B6 · 消息操作', scene('表情回应 · 不是卡片', [
    '<div class="ur"><div class="u">这版周报很好</div><div class="rx"><button type="button" aria-label="取消爱心回应">♥ 2</button><span>👀 1</span></div></div>',
    note('回应属于消息 affordance，不进入四组卡片协议。')
]))
col('B7 · inline reference', scene('消息内跳转 · 不是卡片', [
    M('墨', T('结论来自 <a class="lk" href="#a10-summary">邮件草稿 r1 <span class="ar">↗</span></a>，目标不可用时只显示“内容不可用”。')),
    note('引用只负责定位与可见性校验，不携带执行权限。')
]))

protocol = 'type InteractionView =\n  | InputRequestView      requestInput(question | choice | form | secret | saved_item)\n  | ActionApprovalView    requestApproval(tool | payment | outbound | routine | install | connect)\n  | PlanReviewView        plan_review · 计划版本审阅，独立成员\n  | SessionControlView    requestSessionControl(takeover | return)\nshowContent(markdown | table | chart | collection | media | html | task_status | page | voice)'
body = '<div class="ann"><b>CARD-01 目标协议（示意，不是现有生产 API）</b><div class="protocol">' + protocol + '</div><ul><li>统一 Card Shell，不统一业务 payload。27 个产品场景完整保留；B6 是消息操作，B7 是 inline reference。</li><li>plan_review 是独立成员：批准计划版本不批准任何工具调用、连接器或凭据。</li><li>Intervention、Run、ExternalEffect 分别拥有状态。画面中的状态切换均为本地确定性演示。</li></ul></div><div class="grid">' + ''.join(cols) + '</div>'
page('cards.html', 'WorkPal 卡片 · ① 27 个产品场景', '13 个 A 类 + 7 个 D 类 + 7 个 B 类 · 390px 主验收 · 全部内容来自生成脚本', body)

if __name__ == '__main__':
    import architecture
    import idx
    import a
    import b
    import c
    print('Generated architecture, index, cards, details, alerts, and states HTML.')
