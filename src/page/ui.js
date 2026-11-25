// In-page UI for Level 67: toasts and a side panel, rendered in a shadow root
// so neither the page's CSS nor ours can leak. Runs in the page's MAIN world.
// DOM is built with createElement/textContent only (no innerHTML): record data
// is untrusted and some hosts enforce Trusted Types.
(() => {
  'use strict';
  const VERSION = '1.1.0';
  if (window.__level67ui && window.__level67ui.version === VERSION) return;

  const CSS = `
:host { all: initial; }
.root {
  --bg: #ffffff; --bg2: #f5f6fa; --bg3: #eceef5; --fg: #171a26; --fg2: #5b6275; --line: #e1e4ee;
  --accent: #6d4aff; --accent2: #00b8d9; --ok: #12a05c; --err: #d92d4a; --warn: #c77700;
  --shadow: 0 18px 50px rgba(20, 22, 40, .22);
  font: 13px/1.45 "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
  color: var(--fg);
}
.root[data-theme="dark"] {
  --bg: #171923; --bg2: #1f2230; --bg3: #2a2e40; --fg: #eceef7; --fg2: #9aa1b8; --line: #2e3246;
  --accent: #9b85ff; --accent2: #3fd6ee; --ok: #3ddc91; --err: #ff6b84; --warn: #ffb648;
  --shadow: 0 18px 50px rgba(0, 0, 0, .55);
}
* { box-sizing: border-box; }
.toasts { position: fixed; z-index: 2147483647; right: 20px; bottom: 20px; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; pointer-events: none; }
.toast {
  pointer-events: auto; max-width: 420px; padding: 10px 14px 10px 12px; border-radius: 10px;
  background: var(--bg); color: var(--fg); border: 1px solid var(--line); box-shadow: var(--shadow);
  display: flex; gap: 10px; align-items: flex-start; animation: in .18s ease-out;
}
.toast::before { content: ""; flex: none; width: 4px; align-self: stretch; border-radius: 4px; background: linear-gradient(var(--accent), var(--accent2)); }
.toast.ok::before { background: var(--ok); } .toast.error::before { background: var(--err); } .toast.warn::before { background: var(--warn); }
.toast b { display: block; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--fg2); font-weight: 600; }
.toast.out { opacity: 0; transform: translateY(6px); transition: all .2s; }
@keyframes in { from { opacity: 0; transform: translateY(8px); } }
@keyframes slide { from { transform: translateX(30px); opacity: 0; } }
.panel {
  position: fixed; z-index: 2147483646; top: 0; right: 0; height: 100vh; width: min(560px, 100vw);
  background: var(--bg); border-left: 1px solid var(--line); box-shadow: var(--shadow);
  display: flex; flex-direction: column; animation: slide .2s ease-out;
}
.panel.wide { width: min(820px, 100vw); }
header { padding: 14px 16px 12px; border-bottom: 1px solid var(--line); background: var(--bg); }
.bar { display: flex; align-items: center; gap: 10px; }
.logo { flex: none; width: 26px; height: 26px; border-radius: 8px; background: linear-gradient(135deg, var(--accent), var(--accent2)); display: grid; place-items: center; color: #fff; font-weight: 800; font-size: 11px; }
h1 { flex: 1; margin: 0; font-size: 15px; font-weight: 650; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub { margin: 4px 0 0 36px; color: var(--fg2); font-size: 12px; overflow-wrap: anywhere; }
button, input, textarea { font: inherit; color: inherit; }
.btn { border: 1px solid var(--line); background: var(--bg2); border-radius: 7px; padding: 4px 10px; cursor: pointer; white-space: nowrap; }
.btn:hover { background: var(--bg3); } .btn:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.root[data-theme="dark"] .btn.primary { color: #14121f; }
.btn.icon { padding: 4px 8px; font-size: 14px; line-height: 1; }
.tools { display: flex; gap: 8px; margin-top: 12px; }
.tools input { flex: 1; min-width: 0; }
input, textarea { background: var(--bg2); border: 1px solid var(--line); border-radius: 7px; padding: 6px 10px; }
.count { color: var(--fg2); font-size: 12px; align-self: center; white-space: nowrap; }
.body { flex: 1; overflow: auto; padding: 4px 0 24px; }
h2 { margin: 16px 16px 6px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--fg2); font-weight: 650; }
.note { margin: 6px 16px; color: var(--fg2); }
table { width: 100%; border-collapse: collapse; table-layout: auto; }
th { position: sticky; top: 0; background: var(--bg2); text-align: left; font-weight: 600; font-size: 11px; color: var(--fg2); padding: 6px 8px; border-bottom: 1px solid var(--line); }
td { padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; cursor: copy; }
th:first-child, td:first-child { padding-left: 16px; } th:last-child, td:last-child { padding-right: 16px; }
tr:hover td { background: var(--bg2); }
td.mono, pre { font-family: "Cascadia Code", Consolas, ui-monospace, monospace; font-size: 12px; }
td.dim { color: var(--fg2); }
td.flash { background: color-mix(in srgb, var(--ok) 22%, transparent) !important; }
a { color: var(--accent); }
.tag { display: inline-block; padding: 0 7px; border-radius: 99px; background: var(--bg3); font-size: 11px; }
.tag.on { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
.tag.off { background: color-mix(in srgb, var(--err) 16%, transparent); color: var(--err); }
.empty { padding: 28px 16px; text-align: center; color: var(--fg2); }
.pg { padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; }
.pg textarea { width: 100%; min-height: 64px; resize: vertical; font-family: "Cascadia Code", Consolas, ui-monospace, monospace; font-size: 12px; }
.pg .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.chip { border: 1px dashed var(--line); background: none; border-radius: 99px; padding: 2px 10px; cursor: pointer; color: var(--fg2); font-size: 12px; }
.chip:hover { color: var(--fg); border-color: var(--accent); }
pre { margin: 0 16px; padding: 12px; background: var(--bg2); border: 1px solid var(--line); border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
pre.error { color: var(--err); }
@media (prefers-reduced-motion: reduce) { .toast, .panel { animation: none; } }
`;

  let host, root, toasts, panelEl;
  let theme = 'auto';

  // h('div', {class: 'x', onclick: fn}, child, 'text', ...)
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  function ensure() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = 'level67-root';
    const shadow = host.attachShadow({ mode: 'open' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      shadow.append(h('style', null, CSS));
    }
    root = h('div', { class: 'root' });
    toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    root.append(toasts);
    shadow.append(root);
    document.documentElement.append(host);
    panelEl = null;
    applyTheme();
  }

  function applyTheme() {
    if (!root) return;
    const dark = theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    root.dataset.theme = dark ? 'dark' : 'light';
  }

  function setTheme(value) {
    theme = ['light', 'dark'].includes(value) ? value : 'auto';
    applyTheme();
  }

  function toast(message, kind = 'ok', ms = 3200) {
    ensure();
    const el = h('div', { class: `toast ${kind}` }, h('div', null, h('b', null, 'Level 67'), message));
    toasts.append(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 250);
    }, ms);
  }

  async function copy(text) {
    text = String(text);
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Clipboard API can be blocked by permissions policy: fall back to execCommand.
      const ta = h('textarea', { style: 'position:fixed;opacity:0;top:0;left:0' });
      ta.value = text;
      root.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
      return ok;
    }
  }

  function closePanel() {
    if (panelEl) panelEl.remove();
    panelEl = null;
  }

  function shell(title, subtitle, wide) {
    ensure();
    closePanel();
    const head = h('header', null,
      h('div', { class: 'bar' },
        h('div', { class: 'logo', 'aria-hidden': 'true' }, '67'),
        h('h1', null, title),
        h('button', { class: 'btn icon', title: 'Close (Esc)', 'aria-label': 'Close', onclick: closePanel }, '✕')),
      subtitle ? h('div', { class: 'sub' }, subtitle) : null);
    const body = h('div', { class: 'body' });
    panelEl = h('section', { class: `panel${wide ? ' wide' : ''}`, role: 'dialog', 'aria-label': title }, head, body);
    panelEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closePanel(); }
    });
    root.append(panelEl);
    return { head, body };
  }

  const cellText = (c) => (c == null ? '' : typeof c === 'object' ? String(c.text ?? '') : String(c));

  function toCsv(sections) {
    const esc = (v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = [];
    for (const s of sections) {
      if (sections.length > 1) lines.push(esc(s.title || ''));
      if (s.columns) lines.push(s.columns.map(esc).join(','));
      for (const r of s.rows) lines.push(r.map((c) => esc(cellText(c))).join(','));
      if (sections.length > 1) lines.push('');
    }
    return lines.join('\r\n');
  }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = h('a', { href: url, download: name });
    root.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // spec: { title, subtitle, wide, name, json, sections: [{ title, columns, rows, note }] }
  // A cell is a plain value or { text, href, mono, dim, tag: 'on' | 'off' | '' }.
  function panel(spec) {
    const { head, body } = shell(spec.title, spec.subtitle, spec.wide);
    const sections = spec.sections || [];
    const total = sections.reduce((n, s) => n + s.rows.length, 0);
    const count = h('span', { class: 'count' }, `${total} rows`);
    const filter = h('input', { type: 'search', placeholder: 'Filter…', 'aria-label': 'Filter rows' });
    const fileBase = (spec.name || spec.title).replace(/[^\w-]+/g, '-').toLowerCase();
    head.append(h('div', { class: 'tools' },
      filter, count,
      spec.json !== undefined && h('button', { class: 'btn', title: 'Copy the raw data as JSON', onclick: async () => {
        toast((await copy(JSON.stringify(spec.json, null, 2))) ? 'JSON copied' : 'Copy failed', 'ok');
      } }, 'Copy JSON'),
      h('button', { class: 'btn', title: 'Download as CSV', onclick: () => download(`${fileBase}.csv`, '﻿' + toCsv(sections), 'text/csv') }, 'CSV')));

    const blocks = [];
    for (const s of sections) {
      const block = h('div', null, s.title ? h('h2', null, s.title) : null, s.note ? h('div', { class: 'note' }, s.note) : null);
      const trs = [];
      if (s.rows.length) {
        const tbody = h('tbody');
        for (const row of s.rows) {
          const tr = h('tr', null, row.map((c) => {
            const o = c != null && typeof c === 'object' ? c : { text: c };
            const text = cellText(c);
            const inner = o.href ? h('a', { href: o.href, target: '_blank', rel: 'noopener' }, text)
              : o.tag !== undefined ? h('span', { class: `tag ${o.tag}` }, text) : text;
            return h('td', { class: [o.mono && 'mono', o.dim && 'dim'].filter(Boolean).join(' ') || null, title: 'Click to copy' }, inner);
          }));
          tr.dataset.q = row.map(cellText).join(' ').toLowerCase();
          trs.push(tr);
          tbody.append(tr);
        }
        block.append(h('table', null, s.columns ? h('thead', null, h('tr', null, s.columns.map((c) => h('th', null, c)))) : null, tbody));
      } else if (!s.note) {
        block.append(h('div', { class: 'empty' }, 'Nothing here.'));
      }
      blocks.push({ block, trs });
      body.append(block);
    }
    if (!sections.length) body.append(h('div', { class: 'empty' }, 'Nothing to show.'));

    body.addEventListener('click', async (e) => {
      if (e.target.closest('a')) return;
      const td = e.target.closest('td');
      if (!td || !td.textContent) return;
      if (await copy(td.textContent)) {
        td.classList.add('flash');
        setTimeout(() => td.classList.remove('flash'), 350);
      }
    });
    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      let shown = 0;
      for (const { block, trs } of blocks) {
        let any = false;
        for (const tr of trs) {
          const hit = !q || tr.dataset.q.includes(q);
          tr.hidden = !hit;
          if (hit) { any = true; shown++; }
        }
        block.hidden = !!q && trs.length > 0 && !any;
      }
      count.textContent = q ? `${shown} of ${total} rows` : `${total} rows`;
    });
    filter.focus();
  }

  // Interactive Web API console. run(query) resolves to parsed JSON.
  function playground({ subtitle, examples, run }) {
    const { body } = shell('Web API playground', subtitle, true);
    const input = h('textarea', { spellcheck: 'false', placeholder: 'accounts?$select=name&$top=5', 'aria-label': 'Web API query' });
    const out = h('pre', null, 'Run a query to see the response. Ctrl+Enter runs it.');
    const status = h('span', { class: 'count' });
    let last = null;
    const go = async () => {
      const q = input.value.trim();
      if (!q) return;
      status.textContent = 'Running…';
      out.className = '';
      const t0 = performance.now();
      try {
        last = await run(q);
        const n = last && Array.isArray(last.value) ? `${last.value.length} rows · ` : '';
        status.textContent = `${n}${Math.round(performance.now() - t0)} ms`;
        out.textContent = JSON.stringify(last, null, 2);
      } catch (err) {
        last = null;
        status.textContent = 'Failed';
        out.className = 'error';
        out.textContent = String((err && err.message) || err);
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); }
    });
    body.append(
      h('div', { class: 'pg' },
        input,
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onclick: go }, 'Run'),
          h('button', { class: 'btn', onclick: async () => { if (last) toast((await copy(JSON.stringify(last, null, 2))) ? 'JSON copied' : 'Copy failed'); } }, 'Copy JSON'),
          status),
        h('div', { class: 'row' }, examples.map((ex) => h('button', { class: 'chip', onclick: () => { input.value = ex; input.focus(); } }, ex)))),
      out);
    input.focus();
  }

  window.__level67ui = { version: VERSION, toast, panel, playground, closePanel, setTheme, copy };
})();
