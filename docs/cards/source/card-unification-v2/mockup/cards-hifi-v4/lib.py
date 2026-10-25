from pathlib import Path

AV = {'墨': '1-dot-ink-s.svg', '小橙': '2-treble-orange-s.svg', '小蓝': '3-wave-blue-s.svg', '小紫': '4-bounce-purple-s.svg'}


def U(t):
    return f'<div class="u">{t}</div>'


def M(n, i):
    return f'<div class="m"><img src="{AV[n]}" alt=""><div class="w"><div class="n">{n}</div>{i}</div></div>'


def T(t):
    return f'<div class="b">{t}</div>'


def bd(c, t):
    return f'<span class="bd {c}"><i aria-hidden="true"></i><span>{t}</span></span>'


def K(st, ic, title, badge, body, bt='', cls='', ident='', source=''):
    id_attr = f' id="{ident}"' if ident else ''
    src = f'<div class="source">{source}</div>' if source else ''
    return (f'<article class="k a {st} {cls}"{id_attr} role="group" aria-label="{title}，{badge}" tabindex="-1">'
            f'<div class="h"><span class="ic" aria-hidden="true">{ic}</span><b>{title}</b>{bd(st, badge) if badge else ""}</div>'
            f'<div class="body">{body}</div>{src}{bt}</article>')


def B(*items):
    buttons = []
    for item in items:
        c, t = item[:2]
        attrs = item[2] if len(item) > 2 else ''
        buttons.append(f'<button type="button" class="btn {c}" {attrs}>{t}</button>')
    return '<div class="bt">' + ''.join(buttons) + '</div>'


def note(t):
    return f'<div class="note">{t}</div>'


def cap(t):
    return f'<div class="cap">{t}</div>'


def win(title, sub, inner, cls='', h=''):
    st = f' style="height:{h}px"' if h else ''
    return (f'<section class="win {cls}" aria-label="{title} {sub}"><div class="wt"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>'
            f'{title} <span>{sub}</span></div><div class="wb"{st}>{inner}</div></section>')


def chat(*x):
    return '<div class="chat">' + ''.join(x) + '</div>'


def ib(i, t='', attrs=''):
    return f'<button type="button" class="ib" aria-label="{t or i}" title="{t}" {attrs}>{i}</button>'


def ph(ic, title, tag='', btns=(('✕', '关闭'),), extra=''):
    controls = ''.join(ib(a, b, 'data-close') if b == '关闭' else ib(a, b) for a, b in btns)
    return f'<div class="ph"><span class="ic" aria-hidden="true">{ic}</span><b>{title}</b>{tag}{extra}<span class="sp"></span>{controls}</div>'


AG = '<span class="ag">Agent 生成 · 只读</span>'


COMMON_JS = r'''
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  let lastTrigger = null;
  const showDialog = (id, trigger) => {
    const d = document.getElementById(id);
    if (!d) return;
    lastTrigger = trigger || document.activeElement;
    d._trigger = lastTrigger;
    if (!d.open) d.showModal();
  };
  const closeDialog = d => {
    if (!d) return;
    d.close();
    const t = d._trigger;
    if (t && t.isConnected) t.focus();
  };
  document.addEventListener('click', e => {
    const open = e.target.closest('[data-open]');
    if (open) showDialog(open.dataset.open, open);
    const close = e.target.closest('[data-close]');
    if (close) {
      const d = close.closest('dialog');
      if (d) requestDraftClose(d); else {
        const p = close.closest('[data-panel]');
        if (p) { p.hidden = true; close._trigger?.focus(); }
      }
    }
    const po = e.target.closest('[data-panel-open]');
    if (po) {
      const p = document.getElementById(po.dataset.panelOpen);
      if (p) { p.hidden = false; p.querySelector('button')?.focus(); p._trigger = po; }
    }
  });
  $$('dialog').forEach(d => {
    d.addEventListener('click', e => { if (e.target === d && !d.classList.contains('draft')) requestDraftClose(d); });
    d.addEventListener('cancel', e => { e.preventDefault(); requestDraftClose(d); });
    d.addEventListener('close', () => d._trigger?.focus());
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || $('dialog[open]')) return;
    const panels = $$('[data-panel]:not([hidden])');
    const p = panels.at(-1);
    if (p) { p.hidden = true; p._trigger?.focus(); }
  });
  $$('[data-theme-toggle]').forEach(b => b.addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme !== 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    b.setAttribute('aria-pressed', String(dark));
    b.textContent = dark ? '切换浅色' : '切换深色';
  }));
  const queue = $('#attention-queue');
  $('[data-queue-open]')?.addEventListener('click', e => {
    queue.hidden = !queue.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!queue.hidden));
    if (!queue.hidden) queue.querySelector('button')?.focus();
  });
  const updateQueueCount = () => {
    const n = $$('.pr[data-queue-for]', queue).filter(x => !x.hidden).length;
    $$('[data-queue-count]').forEach(x => x.textContent = n);
    $('#queue-empty').hidden = n !== 0;
  };
  $$('[data-queue-jump]').forEach(b => b.addEventListener('click', () => {
    const target = document.getElementById(b.dataset.queueJump);
    queue.hidden = true;
    $('[data-queue-open]')?.setAttribute('aria-expanded', 'false');
    target?.scrollIntoView({block: 'center'});
    target?.focus();
    target?.classList.add('hl2');
    setTimeout(() => target?.classList.remove('hl2'), 1200);
  }));
  $$('[data-resolve]').forEach(b => b.addEventListener('click', () => {
    const card = document.getElementById(b.dataset.resolve);
    if (!card || card.dataset.resolved) return;
    card.dataset.resolved = 'true';
    card.className = 'k a ok';
    const badge = $('.bd', card);
    badge.className = 'bd ok';
    $('.bd span', card).textContent = b.dataset.resultLabel || '已决定 · 等待执行结果';
    $('.bt', card)?.remove();
    const r = document.createElement('div');
    r.className = 'res';
    r.textContent = '本地演示：只记录 Intervention 决定，外部结果仍以 ExternalEffect 或业务事务为准。';
    card.append(r);
    const item = $(`[data-queue-for="${card.id}"]`);
    if (item) item.hidden = true;
    updateQueueCount();
  }));
  if (queue) updateQueueCount();

  const draft = $('#draft-dialog');
  const revisions = [{id: 'r1', to: 'review@example.com', subject: '评审改期到周五 15:00', body: '周五评审改到 15:00，地点不变。请带一页 Q3 结论，议程见附件。', status: 'pending'}];
  let draftMode = 'view';
  let editBaseline = '';
  const fingerprint = s => {
    let h = 2166136261;
    for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
    return 'fp-' + (h >>> 0).toString(16).padStart(8, '0');
  };
  const latest = () => revisions.at(-1);
  const content = r => `${r.to}\n${r.subject}\n${r.body}`;
  const fill = (id, value) => { const n = document.getElementById(id); if (n) n.textContent = value; };
  function renderDraft(mode = 'view') {
    if (!draft) return;
    draftMode = mode;
    const r = latest();
    ['view', 'edit', 'confirm'].forEach(x => $(`#draft-${x}`).hidden = x !== mode);
    fill('draft-mode-label', mode === 'edit' ? '编辑中 · 新 revision 尚未保存' : mode === 'confirm' ? '最终发送确认' : `待发送 · ${r.id}`);
    if (mode === 'edit') {
      $('#draft-to-input').value = r.to;
      $('#draft-subject-input').value = r.subject;
      $('#draft-body-input').value = r.body;
      editBaseline = content(r);
      $('#draft-to-input').focus();
    } else if (mode === 'confirm') {
      fill('confirm-to', r.to); fill('confirm-subject', r.subject); fill('confirm-body', r.body);
      fill('confirm-revision', r.id); fill('confirm-fingerprint', fingerprint(content(r)));
      $('#draft-send').focus();
    } else {
      fill('draft-to', r.to); fill('draft-subject', r.subject); fill('draft-body', r.body);
      fill('draft-fingerprint', fingerprint(content(r)));
    }
    fill('draft-revisions', revisions.map(x => `${x.id} · ${x.status} · ${fingerprint(content(x))}`).join('\n'));
    fill('draft-live-revision', `${r.id} · ${fingerprint(content(r))}`);
    $('.bd span', $('#a10-card')).textContent = `待发送 · ${r.id}`;
  }
  function requestDraftClose(d) {
    if (d !== draft || draftMode !== 'edit') { closeDialog(d); return; }
    const candidate = {to: $('#draft-to-input').value, subject: $('#draft-subject-input').value, body: $('#draft-body-input').value};
    if (content(candidate) !== editBaseline) showDialog('draft-discard', document.activeElement);
    else closeDialog(d);
  }
  window.requestDraftClose = requestDraftClose;
  $('[data-draft-edit]')?.addEventListener('click', () => renderDraft('edit'));
  $('[data-draft-cancel-edit]')?.addEventListener('click', () => renderDraft('view'));
  $('[data-draft-save]')?.addEventListener('click', () => {
    const previous = latest();
    const candidate = {to: $('#draft-to-input').value.trim(), subject: $('#draft-subject-input').value.trim(), body: $('#draft-body-input').value.trim()};
    if (!candidate.to || !candidate.subject || !candidate.body) { $('#draft-validation').hidden = false; return; }
    $('#draft-validation').hidden = true;
    previous.status = 'superseded';
    revisions.push({...candidate, id: `r${revisions.length + 1}`, status: 'pending'});
    renderDraft('view');
    fill('draft-outcome', `本地演示：已保存不可变 ${latest().id}；${previous.id} 保留为 superseded，待处理入口仅指向 ${latest().id}。`);
  });
  $('[data-draft-prepare]')?.addEventListener('click', () => renderDraft('confirm'));
  $('[data-draft-back]')?.addEventListener('click', () => renderDraft('view'));
  $('#draft-send')?.addEventListener('click', () => {
    const r = latest(), fp = fingerprint(content(r));
    fill('draft-outcome', `本地演示：发送决定已绑定 ${r.id} / ${fp}；尚未执行外部发送，等待 ExternalEffect 或业务事务结果。`);
    const card = $('#a10-card');
    card.className = 'k a wait';
    $('.bd', card).className = 'bd wait';
    $('.bd span', card).textContent = '已决定 · 等待发送结果';
    $('#a10-card .bt')?.remove();
    closeDialog(draft);
  });
  $('#draft-discard [data-discard-continue]')?.addEventListener('click', e => closeDialog(e.currentTarget.closest('dialog')));
  $('#draft-discard [data-discard-confirm]')?.addEventListener('click', e => {
    closeDialog(e.currentTarget.closest('dialog')); closeDialog(draft); renderDraft('view');
  });
  $$('[data-open="draft-dialog"]').forEach(b => b.addEventListener('click', () => renderDraft(b.dataset.draftConfirm ? 'confirm' : 'view')));
  if (draft) renderDraft();

  $('#save-selection')?.addEventListener('click', () => {
    const card = $('#a12-select');
    const selected = $('input[name="demo-card"]:checked');
    const address = $('input[name="demo-address"]:checked');
    if (!selected || !address) return;
    fill('selection-result', `已选择 ${selected.dataset.label} 与 ${address.dataset.label}；此步骤没有付款。`);
    card.className = 'k a ok';
    $('.bd', card).className = 'bd ok'; $('.bd span', card).textContent = '已选择';
    $('#save-selection').disabled = true;
    $('#payment-approval').hidden = false;
    $('#payment-approval').scrollIntoView({block: 'nearest'});
  });
  $$('[data-payment-decision]').forEach(b => b.addEventListener('click', () => {
    const approved = b.dataset.paymentDecision === 'approve';
    const card = $('#payment-approval');
    card.className = approved ? 'k a wait' : 'k a rej';
    $('.bd', card).className = approved ? 'bd wait' : 'bd rej';
    $('.bd span', card).textContent = approved ? '已批准 · 等待付款结果' : '已拒绝';
    fill('payment-result', approved ? '本地演示：已记录付款决定；未扣款。结果须由 ExternalEffect 或支付业务事务确认。' : '本地演示：已记录拒绝；未发起付款。');
    $('#payment-approval .bt')?.remove();
  }));

  const install = $('#install-demo');
  $('[data-install-secondary]')?.addEventListener('click', () => {
    fill('install-audit', install.dataset.stage === 'auth' ? '本地演示：已记录暂不授权；安装结果保持独立且不回滚。' : '本地演示：已记录暂不安装。');
  });
  $('[data-install-primary]')?.addEventListener('click', e => {
    if (install.dataset.stage === 'pending') {
      install.dataset.stage = 'auth';
      fill('install-step', '✓ 已安装'); $('#install-step').className = 'step ok';
      fill('auth-step', '● 待授权'); $('#auth-step').className = 'step wait';
      fill('install-badge', '安装完成 · 待授权');
      fill('install-audit', '本地演示：安装事务 install-demo-01 已完成；授权是另一个后端动作，尚未开始。');
      e.currentTarget.textContent = '授权'; $('[data-install-secondary]').textContent = '暂不授权';
    } else if (install.dataset.stage === 'auth') {
      install.dataset.stage = 'decided';
      fill('auth-step', '✓ 已记录授权决定'); $('#auth-step').className = 'step ok';
      fill('install-badge', '等待连接结果');
      fill('install-audit', '本地演示：授权决定已记录；未宣称已连接，等待 ExternalEffect 或连接业务事务。');
      $('#install-demo .bt')?.remove();
    }
  });
  $('[data-reload]')?.addEventListener('click', () => {
    const card = $('#reload-card');
    card.className = 'k a ok';
    $('.bd', card).className = 'bd ok'; $('.bd span', card).textContent = '读取完成';
    fill('reload-content', '已重新读取展示状态：Routine 当前为启用。未执行、暂停或恢复任何动作。');
    fill('reload-count', '本地确定性演示：读取次数 1；动作执行次数 0。');
    $('[data-reload]').disabled = true;
  });
  $$('[data-share-kind]').forEach(r => r.addEventListener('change', () => {
    $('#public-share-rules').hidden = r.value !== 'public' || !r.checked;
  }));
  $('[data-share-record]')?.addEventListener('click', () => {
    const kind = $('input[name="share-kind"]:checked')?.value || 'space';
    fill('share-result', kind === 'public'
      ? '本地演示：公开只读分享需单独确认； expiry=2026-10-31T15:00:00Z；撤销入口保持可用。未创建真实链接。'
      : '本地演示：默认仅限 Space 内且要求登录。未创建真实链接。');
  });
})();
'''


def page(fn, title, sub, body, js=''):
    html = f'''<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="style.css"><title>{title}</title></head><body><a class="back" href="index.html">← 总索引</a><button type="button" class="theme-toggle" data-theme-toggle aria-pressed="false">切换深色</button><main><h1>{title}<small>{sub}</small></h1><div class="pgw">{body}</div></main><script>{COMMON_JS}\n{js}</script></body></html>'''
    Path(fn).write_text(html, encoding='utf-8')
