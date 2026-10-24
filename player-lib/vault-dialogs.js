/* =========================================================================
   In-app dialogs: vaultAlert, vaultConfirm, vaultPrompt.

   They replace the browser's alert() / confirm() / prompt(), which look
   foreign, block the page, and in a danger case sit one Enter away from
   accepted. Each returns a Promise:

     await vaultAlert(message, { title, okLabel })                  -> undefined
     await vaultConfirm(message, { title, okLabel, cancelLabel,
                                   danger, list })                  -> true | false
     await vaultPrompt(message, { title, value, placeholder,
                                  okLabel, cancelLabel })           -> string | null

   message is plain text: a blank line starts a new paragraph, a single line
   break stays a line break. `list` (any of them) adds a bullet list under the
   message. Everything is escaped, so callers can pass filenames as they are.

   While a dialog is open nothing behind it gets a key (the library and
   player shortcuts stay quiet), the rest of the page is inert, Tab stays
   inside, Esc cancels and Enter answers OK, except on a focused button
   (which answers for itself) and in a textarea. `danger` paints OK red and
   starts on Cancel. Two dialogs can be open at once: the newest one is on
   top and has the keyboard, and each hands focus back to whatever had it
   when it opened.

   Load early (db-viewer.html, before shortcuts.js): the key guard is a
   window capture listener and has to be the first one registered.
   ========================================================================= */

(function () {
  'use strict';

  const stack = [];          // open dialogs, newest last
  const madeInert = new Set();
  let seq = 0;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** The message (and optional bullet list) as escaped HTML. */
  function vaultDialogMessageHtml(message, list) {
    const text = String(message == null ? '' : message).replace(/\r\n?/g, '\n').trim();
    const paras = text ? text.split(/\n\s*\n/) : [];
    let html = paras.map(p => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');
    const items = Array.isArray(list) ? list.filter(x => x != null && String(x) !== '') : [];
    if (items.length) html += `<ul>${items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
    return html;
  }

  const DEFAULT_TITLE = { alert: 'Vault', confirm: 'Please confirm', prompt: 'Enter a value' };

  function el(tag, cls, attrs) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    for (const k in attrs || {}) n.setAttribute(k, attrs[k]);
    return n;
  }

  function focusables(d) {
    return [d.input, d.cancelBtn, d.okBtn].filter(Boolean);
  }

  /** Inert everything at body level except the top dialog's overlay. */
  function syncInert() {
    for (const n of madeInert) n.inert = false;
    madeInert.clear();
    const top = stack[stack.length - 1];
    if (!top || !document.body) return;
    for (const n of Array.from(document.body.children)) {
      if (n === top.ov || n.inert) continue;
      n.inert = true;
      madeInert.add(n);
    }
  }

  function open(kind, message, o) {
    o = o || {};
    const id = `vdlg${++seq}`;
    const danger = kind === 'confirm' && !!o.danger;
    const opener = document.activeElement;

    const ov = el('div', 'vdlg-ov');
    const box = el('div', 'vdlg' + (danger ? ' is-danger' : ''), {
      role: kind === 'prompt' ? 'dialog' : 'alertdialog',
      'aria-modal': 'true',
      'aria-labelledby': `${id}-t`,
      'aria-describedby': `${id}-m`,
    });
    const title = el('h2', 'vdlg-title', { id: `${id}-t` });
    title.textContent = o.title || DEFAULT_TITLE[kind];
    const msg = el('div', 'vdlg-msg', { id: `${id}-m` });
    msg.innerHTML = vaultDialogMessageHtml(message, o.list);
    box.appendChild(title);
    box.appendChild(msg);

    let input = null;
    if (kind === 'prompt') {
      input = el('input', 'vdlg-input', { type: 'text', 'aria-labelledby': `${id}-m`, autocomplete: 'off', spellcheck: 'false' });
      input.value = o.value == null ? '' : String(o.value);
      if (o.placeholder) input.setAttribute('placeholder', String(o.placeholder));
      box.appendChild(input);
    }

    const actions = el('div', 'vdlg-actions');
    let cancelBtn = null;
    if (kind !== 'alert') {
      cancelBtn = el('button', 'vdlg-btn vdlg-cancel', { type: 'button' });
      cancelBtn.textContent = o.cancelLabel || 'Cancel';
      actions.appendChild(cancelBtn);
    }
    const okBtn = el('button', 'vdlg-btn vdlg-ok' + (danger ? ' is-danger' : ''), { type: 'button' });
    okBtn.textContent = o.okLabel || 'OK';
    actions.appendChild(okBtn);
    box.appendChild(actions);
    ov.appendChild(box);

    const okValue = () => kind === 'confirm' ? true : kind === 'prompt' ? input.value : undefined;
    const cancelValue = kind === 'confirm' ? false : kind === 'prompt' ? null : undefined;

    return new Promise((resolve) => {
      const d = { kind, ov, box, input, okBtn, cancelBtn, done: false };
      d.ok = () => finish(okValue());
      d.cancel = () => finish(cancelValue);
      function finish(value) {
        if (d.done) return;
        d.done = true;
        const i = stack.indexOf(d);
        if (i >= 0) stack.splice(i, 1);
        ov.remove();
        syncInert();
        // Back to whoever had focus, if it is still there and not behind
        // another open dialog; otherwise to the dialog still on top.
        const top = stack[stack.length - 1];
        if (opener && opener.isConnected && typeof opener.focus === 'function' &&
            (!top || top.box.contains(opener))) {
          try { opener.focus({ preventScroll: true }); } catch { /* gone */ }
        } else if (top) top.first.focus();
        resolve(value);
      }
      okBtn.addEventListener('click', d.ok);
      if (cancelBtn) cancelBtn.addEventListener('click', d.cancel);
      // A press that starts and ends on the dim backdrop is a cancel. Not for
      // a prompt, where a stray click would throw away what was typed.
      let downOnBackdrop = false;
      ov.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === ov; });
      ov.addEventListener('click', (e) => {
        if (kind !== 'prompt' && downOnBackdrop && e.target === ov) d.cancel();
        downOnBackdrop = false;
      });

      d.first = input || (danger ? cancelBtn : okBtn);
      stack.push(d);
      document.body.appendChild(ov);
      syncInert();
      d.first.focus();
      if (input && typeof input.select === 'function') input.select();
    });
  }

  /* One guard for every key event while a dialog is open: the dialog acts on
     Esc, Enter and Tab, and nothing behind it hears anything. Typing in the
     prompt's box still works, since stopping propagation is not preventing
     the default. */
  function onKey(e) {
    const d = stack[stack.length - 1];
    if (!d) return;
    e.stopImmediatePropagation();
    if (e.type !== 'keydown') return;
    const t = e.target;
    if (e.key === 'Escape') {
      e.preventDefault();
      d.cancel();
    } else if (e.key === 'Enter') {
      if (e.repeat || e.isComposing) { e.preventDefault(); return; }
      if (t && t.tagName === 'TEXTAREA') return;
      // A focused button answers for itself (Enter on Cancel cancels).
      if (t && t.tagName === 'BUTTON' && d.box.contains(t)) return;
      e.preventDefault();
      d.ok();
    } else if (e.key === 'Tab') {
      const f = focusables(d);
      const i = f.indexOf(t);
      e.preventDefault();
      const next = i < 0 ? 0 : (i + (e.shiftKey ? f.length - 1 : 1)) % f.length;
      f[next].focus();
    }
  }

  /* Focus that wanders outside the top dialog (a click on the backdrop, a
     script focusing something behind) comes back in. */
  function onFocusIn(e) {
    const d = stack[stack.length - 1];
    if (!d || d.box.contains(e.target)) return;
    d.first.focus();
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    for (const type of ['keydown', 'keypress', 'keyup']) window.addEventListener(type, onKey, true);
    window.addEventListener('focusin', onFocusIn, true);
  }

  window.vaultAlert = (message, o) => open('alert', message, o);
  window.vaultConfirm = (message, o) => open('confirm', message, o);
  window.vaultPrompt = (message, o) => open('prompt', message, o);
  window.vaultDialogOpen = () => stack.length > 0;
  window.vaultDialogMessageHtml = vaultDialogMessageHtml;
})();
