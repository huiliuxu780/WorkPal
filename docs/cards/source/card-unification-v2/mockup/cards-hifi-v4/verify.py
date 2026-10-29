from pathlib import Path
import re
import shutil
import os
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
PAGES = ['index', 'cards', 'a-detail', 'b-alerts', 'c-states']
results = []
errors = []


def record(name, fn):
    try:
        detail = fn()
        results.append((name, 'PASS', detail or ''))
        print(f'PASS {name}: {detail or "ok"}')
    except Exception as exc:
        results.append((name, 'FAIL', str(exc)))
        errors.append((name, str(exc)))
        print(f'FAIL {name}: {exc}')


def chrome_executable():
    configured = os.environ.get('CHROME_BIN')
    if configured:
        return configured
    for name in ('google-chrome', 'chromium', 'chromium-browser', 'chrome'):
        found = shutil.which(name)
        if found:
            return found
    mac = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    return str(mac) if mac.exists() else None


with sync_playwright() as p:
    kwargs = {'headless': True}
    executable = chrome_executable()
    if executable:
        kwargs['executable_path'] = executable
    browser = p.chromium.launch(**kwargs)
    print(f'Browser: Chromium {browser.version}')
    page = browser.new_page(viewport={'width': 1452, 'height': 900})
    page_errors = []
    page.on('pageerror', lambda exc: page_errors.append(str(exc)))

    def open_page(name):
        page.goto((ROOT / f'{name}.html').as_uri(), wait_until='load')
        page.evaluate('document.fonts.ready')

    def navigation():
        open_page('index')
        links = page.locator('.ixg a.ix')
        assert links.count() == 4
        for name in PAGES[1:]:
            page.locator(f'.ixg a[href="{name}.html"]').click()
            assert page.url.endswith(f'{name}.html')
            page.locator('.back').click()
            assert page.url.endswith('index.html')
        return 'index → four scene groups → index'

    record('Core 1 navigation and return', navigation)

    def draft_flow():
        open_page('a-detail')
        page.locator('[data-open="draft-dialog"]:not([data-draft-confirm])').click()
        assert page.locator('#draft-dialog').evaluate('(d) => d.open')
        page.locator('[data-draft-edit]').click()
        page.locator('#draft-subject-input').fill('评审改期到周五 16:00')
        page.locator('#draft-body-input').fill('周五评审改到 16:00，地点不变。请带一页 Q3 结论，议程见附件。')
        page.locator('[data-draft-save]').click()
        log = page.locator('#draft-revisions').inner_text()
        assert 'r1 · superseded' in log and 'r2 · pending' in log
        live = page.locator('#draft-live-revision').inner_text()
        fp = live.split(' · ')[-1]
        page.locator('[data-draft-prepare]').click()
        assert page.locator('#confirm-subject').inner_text() == '评审改期到周五 16:00'
        assert page.locator('#confirm-body').inner_text() == '周五评审改到 16:00，地点不变。请带一页 Q3 结论，议程见附件。'
        assert page.locator('#confirm-fingerprint').inner_text() == fp
        page.locator('#draft-send').click()
        outcome = page.locator('#draft-outcome').inner_text()
        assert 'r2' in outcome and fp in outcome and '尚未执行外部发送' in outcome
        assert not page.locator('#draft-dialog').evaluate('(d) => d.open')
        return f'r1 superseded; r2 pending; confirmation and decision share {fp}'

    record('Core 3 A10 revision, fingerprint, final content', draft_flow)

    def queue_flow():
        open_page('b-alerts')
        assert page.locator('.pr[data-queue-for]:visible').count() == 2
        page.locator('[data-queue-jump="interaction-tool"]').click()
        assert page.locator('#attention-queue').is_hidden()
        assert page.evaluate('document.activeElement.id') == 'interaction-tool'
        page.locator('[data-resolve="interaction-tool"]:not([data-result-label])').click()
        assert page.locator('[data-queue-for="interaction-tool"]').is_hidden()
        assert page.locator('.pr[data-queue-for]:not([hidden])').count() == 1
        assert page.locator('[data-queue-count]').first.inner_text() == '1'
        assert 'ExternalEffect' in page.locator('#interaction-tool').inner_text()
        return 'source focused; processed entry removed; count 2 → 1'

    record('Core 4 attention queue source and removal', queue_flow)

    def payment_flow():
        open_page('cards')
        assert page.locator('#payment-approval').is_hidden()
        page.locator('#save-selection').click()
        assert page.locator('#payment-approval').is_visible()
        assert '没有付款' in page.locator('#selection-result').inner_text()
        page.locator('[data-payment-decision="approve"]').click()
        text = page.locator('#payment-result').inner_text()
        assert '未扣款' in text and 'ExternalEffect' in text
        return 'saved_item completes before independent payment approval'

    record('A12 two-step saved item and payment', payment_flow)

    def install_flow():
        open_page('cards')
        demo = page.locator('#install-demo')
        assert demo.get_attribute('data-stage') == 'pending'
        page.locator('[data-install-primary]').click()
        assert demo.get_attribute('data-stage') == 'auth'
        assert '已安装' in page.locator('#install-step').inner_text()
        assert '待授权' in page.locator('#auth-step').inner_text()
        page.locator('[data-install-primary]').click()
        assert '等待 ExternalEffect' in page.locator('#install-audit').inner_text()
        text = page.locator('body').inner_text()
        assert '安装：包校验失败' in text and '授权：账号范围未开放' in text
        return 'install completion → separate authorization; distinct failure states present'

    record('Core 5 install and authorization states', install_flow)

    def reload_flow():
        open_page('c-states')
        page.locator('[data-reload]').click()
        assert '读取次数 1；动作执行次数 0' in page.locator('#reload-count').inner_text()
        assert '未执行、暂停或恢复任何动作' in page.locator('#reload-content').inner_text()
        assert page.locator('[data-reload]').is_disabled()
        return 'display refreshed; action execution count remains zero'

    record('Core 6 reload only rereads state', reload_flow)

    def keyboard_flow():
        open_page('a-detail')
        page.locator('[data-panel-open="report-panel"]').click()
        assert page.locator('#report-panel').is_visible()
        page.keyboard.press('Escape')
        assert page.locator('#report-panel').is_hidden()
        assert page.evaluate('document.activeElement.dataset.panelOpen') == 'report-panel'
        trigger = page.locator('[data-open="draft-dialog"]:not([data-draft-confirm])')
        trigger.click()
        page.keyboard.press('Escape')
        assert not page.locator('#draft-dialog').evaluate('(d) => d.open')
        assert page.evaluate('document.activeElement.dataset.open') == 'draft-dialog'
        trigger.click()
        page.locator('[data-draft-edit]').click()
        page.locator('#draft-subject-input').fill('未保存修改')
        page.keyboard.press('Escape')
        assert page.locator('#draft-discard').evaluate('(d) => d.open')
        page.keyboard.press('Escape')
        assert not page.locator('#draft-discard').evaluate('(d) => d.open')
        assert page.locator('#draft-dialog').evaluate('(d) => d.open')
        page.keyboard.press('Escape')
        assert page.locator('#draft-discard').evaluate('(d) => d.open')
        page.locator('[data-discard-continue]').click()
        page.locator('[data-draft-cancel-edit]').click()
        page.keyboard.press('Escape')
        page.locator('body').click(position={'x': 4, 'y': 4})
        page.keyboard.press('Enter')
        assert not page.locator('#draft-dialog').evaluate('(d) => d.open')
        page.keyboard.press('Tab')
        outline = page.evaluate('getComputedStyle(document.activeElement).outlineStyle')
        assert outline != 'none'
        return 'Tab/focus visible; Esc closes top layer; focus restored; no global Enter action'

    record('Core 2 and 7 dialogs, Esc, Tab, focus', keyboard_flow)

    def structure_and_buttons():
        open_page('cards')
        assert page.locator('.grid > section.col').count() == 27
        a7 = page.evaluate('''() => {
          const cols = [...document.querySelectorAll('.grid > section.col')];
          const c = cols.find(x => (x.querySelector('.top')?.textContent || '').trim().startsWith('A7'));
          return c ? {text: c.innerText, cards: c.querySelectorAll('.k').length} : null;
        }''')
        assert a7 and a7['cards'] == 2, (
            'A7 风险卡缺失：必须同时渲染 app authorization 与真实 connect.mcp_assignment 卡。')
        assert 'connect.app_authorization' in a7['text'], (
            'A7 连接授权映射错误：必须使用独立 connect.app_authorization。')
        assert 'requestApproval(connect)' not in a7['text'], (
            'A7 连接授权映射错误：app authorization 不能使用通用 connect 审批。')
        mcp = page.evaluate('''() => {
          const card = document.querySelector('#a7-mcp-assignment');
          if (!card) return null;
          const warn = card.querySelector('.warn');
          return {
            title: card.querySelector('.h b')?.textContent.trim() || '',
            text: card.innerText,
            warn: warn ? warn.innerText : '',
            actions: [...card.querySelectorAll(':scope > .bt > .btn')].map(b => b.textContent.trim()),
          };
        }''')
        assert mcp, 'A7 风险卡缺失：找不到 #a7-mcp-assignment。'
        assert 'MCP assignment' in mcp['title'] and '全部工具' in mcp['title'], (
            'A7 MCP assignment 标题未明确“全部工具”风险。')
        assert 'connect.mcp_assignment' in mcp['text'], (
            'A7 MCP assignment 卡内缺少 connect.mcp_assignment 类型标识。')
        assert mcp['warn'], 'A7 MCP assignment 卡内缺少 .warn 风险块。'
        for phrase in ('allowAllTools: true', '高风险', '全部工具'):
            assert phrase in mcp['warn'], (
                f'A7 MCP assignment 卡内风险块未显示“{phrase}”。')
        assert '允许全部工具' in mcp['actions'], (
            'A7 MCP assignment 主操作未明确允许全部工具。')
        assert len(mcp['actions']) <= 2, (
            f'A7 MCP assignment 操作超过两个按钮：{mcp["actions"]}')
        a8 = page.evaluate('''() => {
          const cols = [...document.querySelectorAll('.grid > section.col')];
          const c = cols.find(x => (x.querySelector('.top')?.textContent || '').trim().startsWith('A8'));
          return c ? c.innerText : null;
        }''')
        assert a8 and 'requestApproval(skill_save)' in a8 and 'TaughtSkill' in a8, (
            'A8 技能保存映射错误：必须使用 requestApproval(skill_save)，权威是 TaughtSkill 业务事务。')
        assert 'requestApproval(tool)' not in a8, (
            'A8 技能保存映射错误：保存技能不是工具审批。')
        protocol_text = page.locator('.ann').inner_text()
        assert 'connect.mcp_assignment' in protocol_text and 'skill_save' in protocol_text, (
            '目标协议缺少 connect.mcp_assignment 或 skill_save 独立成员。')
        open_page('a-detail')
        assert page.locator('section[id^="v"]').count() == 8
        open_page('b-alerts')
        assert page.locator('section[id^="n"]').count() == 4
        for name in PAGES[1:]:
            open_page(name)
            too_many = page.locator('.k').evaluate_all('''cards => cards.filter(c => c.querySelectorAll(':scope > .bt > .btn').length > 2 || c.querySelectorAll(':scope > .bt > .text-entry').length > 1).map(c => c.id || c.getAttribute('aria-label'))''')
            assert not too_many, f'{name}: {too_many}'
            forbidden = page.locator('button').evaluate_all('''bs => bs.map(b => b.innerText).filter(t => /重试|重新发起/.test(t))''')
            assert not forbidden, f'{name}: {forbidden}'
            opacities = page.locator('.k.rej .body,.k.void .body,.k.exp .body,.k.done .body,.k.fail .body').evaluate_all('(ns) => [...new Set(ns.map(n => getComputedStyle(n).opacity))]')
            assert all(x == '1' for x in opacities), f'{name}: {opacities}'
        return '27/8/4 scenes; A7/A8 strict approval variants; button limits; no forbidden action labels; terminal body opacity 1'

    record('Scene counts, button limits, terminal readability', structure_and_buttons)

    def a8_playbook():
        open_page('cards')
        info = page.evaluate('''() => {
          const cols = [...document.querySelectorAll('.grid > section.col')];
          const c = cols.find(x => (x.querySelector('.top')?.textContent || '').trim().startsWith('A8'));
          if (!c) return null;
          const card = c.querySelector('.k');
          return {
            buttons: [...card.querySelectorAll(':scope > .bt > .btn')].map(b => b.textContent.trim()),
            entries: [...card.querySelectorAll('a.more, .text-entry')].map(a => a.textContent.trim()),
            text: c.innerText,
          };
        }''')
        assert info, 'cards.html 缺少 A8 场景'
        assert info['buttons'] == ['丢弃', '保存'], info['buttons']
        assert len(info['entries']) == 1 and '查看 playbook' in info['entries'][0], info['entries']
        assert 'requestApproval(skill_save)' in info['text'] and 'TaughtSkill' in info['text']
        open_page('a-detail')
        trigger = page.locator('#v8 [data-open="a8-playbook"]')
        assert trigger.count() == 1, 'a-detail.html 缺少 A8 playbook 入口'
        trigger.click()
        dialog = page.locator('#a8-playbook')
        assert dialog.evaluate('(d) => d.open'), 'A8 playbook 详情没有打开'
        text = dialog.inner_text()
        for label in ('名称', '目标', '适用时机', '输入', '步骤', '检查方式', '返回内容', '授权边界', '失败处理'):
            assert label in text, f'A8 playbook 详情缺少“{label}”'
        assert dialog.locator('input, textarea, select').count() == 0, 'A8 playbook 详情出现了可编辑控件'
        labels = [t.strip() for t in dialog.locator('button').all_inner_texts()]
        assert all(t in ('', '✕', '关闭') for t in labels), labels
        assert '等待本人决定' in page.locator('#a8-skill-save-detail .bd').inner_text()
        page.keyboard.press('Escape')
        assert not dialog.evaluate('(d) => d.open'), 'Esc 没有关闭 A8 playbook 详情'
        assert page.evaluate('document.activeElement?.dataset.open') == 'a8-playbook', (
            '关闭后焦点没有返回“查看 playbook”')
        assert '等待本人决定' in page.locator('#a8-skill-save-detail .bd').inner_text()
        page.set_viewport_size({'width': 390, 'height': 844})
        open_page('a-detail')
        page.locator('#v8 [data-open="a8-playbook"]').click()
        dialog = page.locator('#a8-playbook')
        assert dialog.evaluate('(d) => d.open')
        box = dialog.bounding_box()
        assert box and box['x'] >= 0 and box['x'] + box['width'] <= 390.5, box
        assert page.evaluate('document.documentElement.scrollWidth <= 390')
        assert dialog.evaluate('(d) => d.scrollWidth <= d.clientWidth')
        page.keyboard.press('Escape')
        page.set_viewport_size({'width': 1452, 'height': 900})
        return 'one text entry; read-only detail; no edit controls; Esc restores focus; 390 fits'

    record('A8 read-only playbook detail', a8_playbook)

    def a13_plan_review_semantics():
        open_page('cards')
        region = page.evaluate('''() => {
          const cols = [...document.querySelectorAll('.grid > section.col')];
          const c = cols.find(x => (x.querySelector('.top')?.textContent || '').trim().startsWith('A13'));
          if (!c) return null;
          return {title: c.querySelector('.top').textContent.trim(), text: c.innerText};
        }''')
        assert region, 'cards.html 缺少 A13 场景区域，无法验证计划审阅分类'
        blob = region['title'] + '\n' + region['text']
        assert 'requestApproval(tool)' not in blob, (
            'A13 被错误归为工具审批：A13 区域标题或正文出现 requestApproval(tool)；'
            '计划审阅必须是独立 PlanReviewView（plan_review），不得经过工具授权分支。')
        assert 'PlanReviewView' in blob, (
            'A13 被错误归为工具审批：A13 区域缺少独立类型 PlanReviewView，'
            '实现者会把它接回工具授权链。')
        assert 'plan_review' in blob, (
            'A13 被错误归为工具审批：A13 区域缺少 plan_review 类型标识，'
            '无法证明它是独立 Intervention kind。')
        for phrase in ('不批准任何工具调用', '连接器', '凭据'):
            assert phrase in blob, (
                f'A13 被错误归为工具审批：A13 区域未写明“{phrase}”，'
                '计划批准与工具授权之间的边界缺失。')
        source = (ROOT / 'cards.html').read_text(encoding='utf-8')
        start = source.find('A13 ·')
        assert start != -1, 'cards.html 源文件缺少 A13 列'
        end = source.find('<section class="col"', start)
        chunk = source[start:end if end != -1 else len(source)]
        assert 'requestApproval(tool)' not in chunk, (
            'A13 被错误归为工具审批：cards.html 的 A13 列片段出现 requestApproval(tool)。')
        return 'A13 title/body = PlanReviewView + plan_review; no requestApproval(tool)'

    record('A13 independent PlanReviewView in rendered cards', a13_plan_review_semantics)

    def a13_docs_and_mapping():
        package_root = ROOT.parents[1]
        docs = {
            'card-requirements.md': package_root / 'card-requirements.md',
            'card-unification.md': package_root / 'card-unification.md',
            'STYLE-SPEC.md': ROOT / 'STYLE-SPEC.md',
            'architecture.py': ROOT / 'architecture.py',
            'card-unification.html': package_root / 'card-unification.html',
        }
        texts = {name: path.read_text(encoding='utf-8') for name, path in docs.items()}
        for name, text in texts.items():
            assert 'PlanReviewView' in text, (
                f'{name}: A13 计划审阅被错误归为工具审批，缺少独立 PlanReviewView。')
        for name in ('card-requirements.md', 'card-unification.md', 'STYLE-SPEC.md', 'architecture.py'):
            text = texts[name]
            assert 'ActionApprovalView' in text and 'SessionControlView' in text, (
                f'{name}: 目标 InteractionView 成员不完整，无法证明 PlanReviewView 独立于工具审批。')
        ask_lines = [l for l in texts['card-unification.md'].splitlines() if '`ask`' in l and '计划审阅' in l]
        assert ask_lines, 'card-unification.md: 缺少旧 ask 计划审阅的兼容映射行'
        for line in ask_lines:
            assert 'PlanReviewView' in line, (
                '旧 ask 计划审阅兼容映射未落到独立 PlanReviewView，仍会被实现为工具审批。')
            assert 'requestApproval' not in line, (
                '旧 ask 计划审阅兼容映射落到 requestApproval，属于把计划审阅并入工具审批。')
        rows = [r for r in re.findall(r'<tr><td>.*?</td><td>.*?</td></tr>', texts['card-unification.html']) if '计划审阅' in r]
        assert rows, 'card-unification.html: 缺少旧 ask 计划审阅兼容映射行'
        for row in rows:
            assert 'PlanReviewView' in row, (
                'card-unification.html: 旧 ask 计划审阅映射未落到 PlanReviewView，仍按工具审批呈现。')
            assert 'requestApproval' not in row, (
                'card-unification.html: 旧 ask 计划审阅映射落到 requestApproval，属于工具审批误归类。')
        for name in ('card-requirements.md', 'card-unification.md', 'STYLE-SPEC.md', 'architecture.py'):
            text = texts[name]
            for phrase in ('skill_save', 'connect.app_authorization', 'connect.mcp_assignment'):
                assert phrase in text, (
                    f'{name}: 审批变体不完整，缺少 {phrase}。')
            for line in text.splitlines():
                if 'skill_draft' in line:
                    assert 'skill_save' in line and 'requestApproval(tool)' not in line, (
                        f'{name}: skill_draft 仍被映射为工具审批：{line.strip()}')
                if 'app_connect' in line:
                    assert 'connect.app_authorization' in line, (
                        f'{name}: app_connect 未映射到独立 connect.app_authorization：{line.strip()}')
                if 'mcp_approval' in line:
                    assert 'connect.mcp_assignment' in line, (
                        f'{name}: mcp_approval 未映射到独立 connect.mcp_assignment：{line.strip()}')
                if '保存技能' in line and 'requestApproval(tool)' in line:
                    raise AssertionError(
                        f'{name}: A8 被错误归为工具审批：保存技能与 requestApproval(tool) 出现在同一行：{line.strip()}')
        html = texts['card-unification.html']
        for token, target in (
            ('skill_draft', 'skill_save'),
            ('app_connect', 'connect.app_authorization'),
            ('mcp_approval', 'connect.mcp_assignment'),
        ):
            rows = [r for r in re.findall(r'<tr><td>.*?</td><td>.*?</td></tr>', html) if token in r]
            assert rows, f'card-unification.html: 缺少 {token} 兼容映射行'
            assert all(target in row for row in rows), (
                f'card-unification.html: {token} 未映射到独立 {target}')
        for name in ('card-requirements.md', 'card-unification.md', 'STYLE-SPEC.md', 'architecture.py'):
            for line in texts[name].splitlines():
                if '计划审阅' in line and 'requestApproval(tool)' in line:
                    raise AssertionError(
                        f'{name}: A13 被错误归为工具审批，计划审阅与 requestApproval(tool) 出现在同一行：{line.strip()}')
        return 'docs and generated HTML keep plan_review, skill_save and connect variants independent; legacy mappings are strict'

    record('A13 independent PlanReviewView across documents and compat mapping', a13_docs_and_mapping)

    def responsive():
        observations = []
        for width in (390, 375):
            page.set_viewport_size({'width': width, 'height': 844})
            for name in PAGES:
                open_page(name)
                metrics = page.evaluate('({sw:document.documentElement.scrollWidth,vw:window.innerWidth})')
                assert metrics['sw'] <= width, f'{width} {name}: {metrics}'
                clipped = page.locator('button:visible').evaluate_all('''bs => bs.filter(b => {const r=b.getBoundingClientRect();return r.left < -1 || r.right > window.innerWidth + 1 || b.scrollWidth > b.clientWidth + 1}).map(b => b.innerText || b.getAttribute('aria-label'))''')
                assert not clipped, f'{width} {name}: clipped {clipped}'
                if name == 'cards':
                    a13 = page.evaluate('''() => {
                      const c = document.getElementById('a13-plan-review');
                      if (!c) return null;
                      const r = c.getBoundingClientRect();
                      const els = [c, ...c.querySelectorAll('*')].filter(el => el.clientWidth > 0);
                      const clipped = els.filter(el => {
                        const b = el.getBoundingClientRect();
                        return b.right > window.innerWidth + 1 || b.left < -1 || el.scrollWidth > el.clientWidth + 1;
                      }).map(el => el.className || el.tagName);
                      return {right: Math.round(r.right), width: Math.round(r.width), clipped};
                    }''')
                    assert a13, f'{width}: cards.html 缺少 #a13-plan-review，无法验证窄屏'
                    assert a13['right'] <= width + 1, f'{width}: A13 卡片越出 viewport：{a13}'
                    assert not a13['clipped'], f'{width}: A13 卡片内部溢出或截断：{a13["clipped"]}'
                    observations.append(f'A13@{width}=w{a13["width"]}/r{a13["right"]}')
                observations.append(f'{name}@{width}={metrics["sw"]}')
            if name:
                open_page('c-states')
                page.locator('#mobile').evaluate('(section) => window.scrollTo(0, section.getBoundingClientRect().top + window.scrollY - 8)')
                page.screenshot(path=ROOT / f'shot-mobile-{width}.png', full_page=False, animations='disabled', caret='hide')
        page.set_viewport_size({'width': 1452, 'height': 900})
        return '; '.join(observations)

    record('390px primary and 375px overflow regression', responsive)

    def dark_mode():
        page.set_viewport_size({'width': 1452, 'height': 900})
        open_page('c-states')
        page.locator('[data-theme-toggle]').click()
        assert page.locator('html').get_attribute('data-theme') == 'dark'
        bg = page.locator('body').evaluate('(b) => getComputedStyle(b).backgroundColor')
        assert bg == 'rgb(28, 28, 28)', bg
        badges = page.locator('#terminal .bd').all_inner_texts()
        assert badges and all(t.strip() for t in badges)
        shapes = page.locator('#terminal .bd i').count()
        assert shapes == len(badges)
        page.locator('[data-theme-toggle]').click()
        return f'dark background {bg}; {len(badges)} terminal states retain text and icon/shape'

    record('Dark mode and non-color state cues', dark_mode)

    def javascript_errors():
        assert not page_errors, '; '.join(page_errors)
        return 'no uncaught page errors across exercised paths'

    record('JavaScript runtime', javascript_errors)
    browser.close()


def documentation_and_secrets():
    package_root = ROOT.parents[1]
    files = [package_root / 'card-requirements.md', package_root / 'card-unification.md', ROOT / 'STYLE-SPEC.md']
    text = '\n'.join(f.read_text(encoding='utf-8') for f in files)
    for phrase in ('requestInput', 'requestApproval', 'requestSessionControl', 'showContent', 'ExternalEffect', 'agent.tool.completed'):
        assert phrase in text
    assert '问开发助手' not in text and '待定' not in text
    all_files = [package_root / 'card-unification.html', *files, *ROOT.glob('*.py'), *ROOT.glob('*.html'), ROOT / 'style.css']
    leaked = []
    for f in all_files:
        body = f.read_text(encoding='utf-8')
        local_path_pattern = '|'.join((re.escape('/' + 'Users' + '/'), re.escape('/' + 'workspace' + '/')))
        if re.search(local_path_pattern + r'|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----', body):
            leaked.append(f.name)
    assert not leaked, str(leaked)
    return 'protocol/state rules present; no stale open-question wording, local identity paths, or key patterns'


record('Documentation and secret scan', documentation_and_secrets)

print(f'\nVerification: {sum(r[1] == "PASS" for r in results)}/{len(results)} checks passed.')
if errors:
    raise SystemExit(1)
