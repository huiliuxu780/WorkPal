from lib import *
import panels

LONG = '<p><b>结论：</b>保留高效渠道预算，收缩两个低效投放位。</p><p><b>依据：</b>华东营收环比改善，低效投放连续低于目标；客单价变化属于可控因素。</p><p><b>建议：</b>先调整投放，再在下一周复盘留存。长消息按实际渲染高度或行数折叠。</p><p><b>风险：</b>短期曝光会变化，需要提前同步口径。</p>'
V3 = f'''<section id="v3"><h2>V3 · 长消息全文 <small>渲染高度/行数折叠 · 不以字符数决定 UI 高度</small></h2>{cap('对话摘要与右侧全文面板；目录、复制和下载不改变消息')}
{win('WorkPal', '私聊 · 墨', '<div class="split">' + chat(U('Q3 评审怎么定？'), M('墨', f'<div class="b lm"><div class="clip4">{LONG}</div><span class="more">展开全部 · 4 行摘要</span></div>')) + f'<div class="pn">{ph("¶", "墨的回复 · 全文", btns=())}<div class="pb read"><div class="toc"><b>目录</b><span class="on">结论</span><span>依据</span><span>建议</span><span>风险</span></div><div class="lm">{LONG}</div></div></div></div>')}</section>'''

img = '<div class="ph-img"><svg viewBox="0 0 200 130" role="img" aria-label="演示风景图"><rect width="200" height="130" fill="#e8eef7"/><circle cx="150" cy="35" r="16" fill="#f5c26b"/><path d="M0 130 L60 60 L100 100 L130 75 L200 130Z" fill="#7aa7e0"/><path d="M0 130 L40 95 L80 130Z" fill="#4c86d1"/></svg></div>'
V4 = f'''<section id="v4"><h2>V4 · 图片放大与文件预览 <small>灯箱 Esc 关闭 · 不支持类型明确降级</small></h2><div class="row"><div>{cap('图片：实际可打开与关闭灯箱')}
{win('WorkPal', '私聊 · 小蓝', chat(U('现场照片发我了'), M('小蓝', '<div class="ims">' + img + img + '</div>' + B(('p', '放大图片', 'data-open="image-dialog"')))))}</div>
<div>{cap('文件：可读预览与下载信息')}<div class="pad"><div class="steps"><div class="step ok">PDF · 评审议程 · 可预览</div><div class="step ok">XLSX · 数据摘要 · 结构化预览</div><div class="step">SKETCH · 暂不支持预览 · 可下载</div></div><p class="tx">HTML 文件始终进入同一沙箱边界，不能直接执行或访问父页面。</p></div></div></div>
<dialog id="image-dialog" class="wide" aria-labelledby="image-title"><div class="mh"><b id="image-title">演示图片 · 1 / 2</b><button type="button" class="ib" data-close aria-label="关闭图片">✕</button></div><div class="mf">{img}</div><div class="mft"><button type="button" class="btn" data-close>关闭</button></div></dialog></section>'''

V5 = f'''<section id="v5"><h2>V5 · 工具审批详情 <small>完整参数可滚动 · 敏感值遮罩 · 详情决定仍需本人确认</small></h2>{cap('打开审批详情；Esc 只关闭，不等于拒绝；没有全局 Enter 批准')}
{win('WorkPal', '私聊 · 墨', chat(U('重新构建报告模块'), M('墨', K('wait', '⌘', '运行构建命令', '等待本人决定', '<div class="s">写入构建产物并清理旧缓存。</div>', B(('l', '拒绝'), ('p', '查看详情', 'data-open="approval-dialog"')), source='来源 Bot：墨 · Task：报告构建 · Run：run-demo-v5 · Step：2'))))}
<dialog id="approval-dialog" aria-labelledby="approval-title"><div class="mh"><b id="approval-title">工具审批详情</b>{bd('wait','等待本人决定')}<button type="button" class="ib" data-close aria-label="关闭审批详情">✕</button></div><div class="mf"><pre class="code">cd project/report\npnpm build\n# 仅清理项目内旧构建产物</pre><div class="warn"><b>注意</b>：会替换构建产物；敏感 token 仅显示 sk-••••••••。</div><div class="table-scroll"><table class="tbl"><tr><th>参数</th><th>值</th></tr><tr><td>source</td><td>内置工具</td></tr><tr><td>working directory</td><td>project/report</td></tr><tr><td>network</td><td>禁止</td></tr><tr><td>来源</td><td>墨 · Task：报告构建 · Step 2</td></tr></table></div></div><div class="mft"><button type="button" class="btn" data-close>关闭</button><button type="button" class="btn p" data-close>记录本人决定（演示）</button></div></dialog></section>'''

V6 = f'''<section id="v6"><h2>V6 · task_status 运行详情 <small>Run 状态与 Interaction 生命周期分开</small></h2>{cap('运行停止不自动作废请求；外部结果不确定时不提供重新执行')}
{win('WorkPal', '工作投影 · 小蓝', '<div class="split">' + chat(M('小蓝', K('fail', '◷', 'Q3 报告 Run', 'Run：已停止', '<div class="s">运行已停止。已有 pending 输入请求仍按自己的 Intervention 生命周期处理。</div>'))) + '<div class="pn"><div class="ph"><b>步骤与外部事实</b></div><div class="pb"><div class="steps2"><div class="st2"><span class="d2 ok"></span>读取数据<em>完成</em></div><div class="st2"><span class="d2 run"></span>外发报告<em>结果未确认</em></div></div><div class="t sec">ExternalEffect：uncertain</div><div class="warn">运行已停止，发送结果未确认</div><p class="t">agent.tool.completed 只表示执行活动，不证明报告已经发出。</p></div></div></div>')}</section>'''

V7 = f'''<section id="v7"><h2>V7 · Routine 详情与历史 <small>工作投影保留历史 · 变更另发审批</small></h2>{cap('历史属于 Routine 工作投影，不进入 attention queue')}
{win('WorkPal', 'Routine · 墨', '<div class="split">' + chat(M('墨', K('ok', '↻', '每周经营周报', '已启用', '<dl class="kv"><dt>触发</dt><dd>每周五 09:00 · Asia/Shanghai</dd><dt>投递</dt><dd>Space 内只读 Page</dd></dl>'))) + '<div class="pn"><div class="ph"><b>配置与历史运行</b></div><div class="pb"><p class="t">暂停、恢复、删除和修改都会创建独立 B2 审批，不在详情直接生效。</p><div class="table-scroll"><table class="tbl"><tr><th>结果</th><th>时间</th><th>耗时</th><th>业务事实</th></tr><tr><td>✓ 成功</td><td>10-24 09:00</td><td>38s</td><td>业务事务确认</td></tr><tr><td>! 失败</td><td>10-10 09:00</td><td>12s</td><td>连接授权失效</td></tr></table></div></div></div></div>')}</section>'''

body = panels.V1 + panels.V2 + ''.join(f'<div class="blk">{x}</div>' for x in (V3, V4, V5, V6, V7))
page('a-detail.html', 'WorkPal 卡片 · ② 7 个详情场景', 'V1 外发草稿 · V2 HTML/图表 · V3 长文 · V4 媒体 · V5 审批 · V6 运行 · V7 Routine', body, panels.JS)
