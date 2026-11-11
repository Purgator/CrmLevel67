// The palette: search, pick, run. All Dynamics work happens in the page
// (src/page/engine.js); this file only talks to it through scripting.executeScript.
import { COMMANDS, CATEGORIES } from '../shared/commands.js';
import { fuzzyRank } from '../shared/fuzzy.js';
import { icon } from '../shared/icons.js';

const api = globalThis.browser ?? chrome;
const $ = (id) => document.getElementById(id);
const GUID = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;
const THEMES = ['auto', 'light', 'dark'];
const THEME_ICON = { auto: 'sun-moon', light: 'sun', dark: 'moon' };
const byId = new Map(COMMANDS.map((c) => [c.id, c]));

const state = {
  tab: null,
  ctx: null, // null while connecting
  imp: { user: null, permitted: false, check: null }, // check: what the server says about the impersonation
  keepOpen: true, // stay open after a command runs
  favs: [],
  recents: [],
  theme: 'auto',
  query: '',
  cat: 'all',
  visible: [],
  selected: 0,
  entities: null,
};

// h('div', { class: 'x', onclick: fn }, ...children)
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

// ── Page bridge ───────────────────────────────────────────────────────────
async function inject() {
  await api.scripting.executeScript({ target: { tabId: state.tab.id }, world: 'MAIN', files: ['/page/ui.js', '/page/engine.js'] }); // absolute: Firefox resolves relative paths against the popup's folder
}
async function call(method, ...args) {
  const [frame] = await api.scripting.executeScript({
    target: { tabId: state.tab.id },
    world: 'MAIN',
    func: (m, a) => window.__level67[m](...a),
    args: [method, args],
  });
  return frame ? frame.result : null;
}
const background = (msg) => api.runtime.sendMessage(msg);

// ── Small UI helpers ──────────────────────────────────────────────────────
let toastTimer;
function toast(message, kind = 'error') {
  const el = $('toast');
  el.className = `toast ${kind}`;
  el.replaceChildren(icon(kind === 'error' ? 'triangle-alert' : 'square-check', 16), h('span', null, message));
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 4500 : 2600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function applyTheme() {
  const dark = state.theme === 'dark' || (state.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const btn = $('theme');
  btn.replaceChildren(icon(THEME_ICON[state.theme], 18));
  btn.title = `Theme: ${state.theme} (click to change)`;
  btn.setAttribute('aria-label', btn.title);
}

const save = (patch) => api.storage.local.set(patch).catch(() => {});

function reasonDisabled(cmd) {
  const { ctx } = state;
  if (!ctx) return 'Still connecting to the page…';
  if (!ctx.dynamics) return ctx.blocked ? 'Extensions cannot run on this page.' : 'Open a Dynamics 365 / Power Apps app to use this.';
  if (cmd.needs && !ctx.form) return 'Open a record form first.';
  if (cmd.needs === 'saved' && !ctx.saved) return 'Save the record first.';
  return '';
}

// ── Header ────────────────────────────────────────────────────────────────
function renderHeader() {
  const { ctx } = state;
  const env = $('env');
  const label = env.lastElementChild;
  const context = $('context');
  if (!ctx) {
    env.className = 'env';
    label.textContent = 'Connecting…';
    context.hidden = true;
  } else if (!ctx.dynamics) {
    env.className = 'env off';
    label.textContent = 'Not a Dynamics 365 / Power Apps page';
    context.hidden = true;
  } else {
    env.className = 'env on';
    label.textContent = [ctx.org, ctx.version && `v${ctx.version}`].filter(Boolean).join(' · ') || 'Connected';
    context.hidden = false;
    if (ctx.form) {
      context.replaceChildren(h('code', null, ctx.entity), ' · ', h('b', null, ctx.recordName || (ctx.saved ? 'Untitled record' : 'New record')));
      context.title = ctx.saved ? ctx.recordId : '';
    } else {
      context.replaceChildren('No record open. Record commands wake up on a form.');
      context.title = '';
    }
  }

  const banners = [];
  if (state.imp.user) {
    const { check } = state.imp;
    const bad = check && check.state !== 'ok';
    banners.push(h('div', { class: `banner${bad ? ' bad' : ''}`, title: check ? check.detail : null }, icon('drama', 16),
      h('span', null, 'Acting as ', h('b', null, state.imp.user.name)),
      check && h('em', { class: 'check' }, check.label),
      h('button', { type: 'button', onclick: stopImpersonation }, 'Stop')));
  }
  if (ctx && ctx.flags) {
    banners.push(h('div', { class: 'banner' }, icon('bug', 16),
      h('span', null, 'Debug flags are active on this tab'),
      h('button', { type: 'button', onclick: () => execute(byId.get('clear-flags')) }, 'Clear')));
  }
  $('banners').replaceChildren(...banners);
}

// ── List view ─────────────────────────────────────────────────────────────
let searchInput;
let listEl;
let chipsEl;

function showList() {
  searchInput = h('input', { type: 'text', placeholder: `Search ${COMMANDS.length} commands…`, autocomplete: 'off', spellcheck: 'false',
    role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'list', 'aria-label': 'Search commands' });
  searchInput.value = state.query;
  searchInput.addEventListener('input', () => {
    state.query = searchInput.value;
    state.selected = 0;
    renderList();
  });
  chipsEl = h('div', { class: 'chips', role: 'tablist', 'aria-label': 'Categories' });
  listEl = h('div', { class: 'list', id: 'list', role: 'listbox', 'aria-label': 'Commands' });
  $('view').replaceChildren(h('div', { class: 'search' }, icon('search', 16), searchInput), chipsEl, listEl);
  renderList();
  searchInput.focus();
}

function groupsFor() {
  const fav = (id) => state.favs.includes(id);
  const q = state.query.trim();
  if (q) {
    const pool = state.cat === 'all' ? COMMANDS : state.cat === 'fav' ? COMMANDS.filter((c) => fav(c.id)) : COMMANDS.filter((c) => c.cat === state.cat);
    return [['', fuzzyRank(q, pool, (c) => [[c.title, 1], [c.keywords, 0.7], [c.desc, 0.5]])]];
  }
  if (state.cat === 'fav') return [['', state.favs.map((id) => byId.get(id)).filter(Boolean)]];
  if (state.cat !== 'all') return [['', COMMANDS.filter((c) => c.cat === state.cat)]];
  const groups = [];
  const favs = state.favs.map((id) => byId.get(id)).filter(Boolean);
  if (favs.length) groups.push(['Favourites', favs]);
  const recents = state.recents.map((id) => byId.get(id)).filter((c) => c && !fav(c.id)).slice(0, 3);
  if (recents.length) groups.push(['Recent', recents]);
  for (const cat of CATEGORIES) groups.push([cat.label, COMMANDS.filter((c) => c.cat === cat.id)]);
  return groups;
}

function renderList() {
  const chips = [{ id: 'all', label: 'All' }, { id: 'fav', label: 'Favourites', icon: 'star' }, ...CATEGORIES];
  chipsEl.replaceChildren(...chips.map((c) => h('button', {
    class: 'chip', type: 'button', role: 'tab', 'aria-selected': String(state.cat === c.id),
    onclick: () => { state.cat = c.id; state.selected = 0; renderList(); searchInput.focus(); },
  }, c.icon && icon(c.icon, 12), c.label)));

  const groups = groupsFor();
  state.visible = [];
  const nodes = [];
  for (const [title, cmds] of groups) {
    if (!cmds.length) continue;
    if (title) nodes.push(h('div', { class: 'group' }, title));
    for (const cmd of cmds) {
      const index = state.visible.length;
      state.visible.push(cmd);
      const reason = reasonDisabled(cmd);
      const isFav = state.favs.includes(cmd.id);
      const star = h('button', { class: `star${isFav ? ' on' : ''}`, type: 'button', tabindex: '-1',
        title: isFav ? 'Remove from favourites' : 'Add to favourites', 'aria-label': isFav ? 'Remove from favourites' : 'Add to favourites',
        onclick: (e) => { e.stopPropagation(); toggleFav(cmd.id); } }, icon('star', 15));
      nodes.push(h('div', {
        class: `cmd${reason ? ' off' : ''}`, role: 'option', id: `cmd-${index}`, 'data-index': index, title: reason || null, 'aria-disabled': reason ? 'true' : null,
        onclick: (e) => { state.selected = index; paintSelection(); execute(cmd, undefined, e.shiftKey); },
        onmousemove: () => { if (state.selected !== index) { state.selected = index; paintSelection(false); } },
      },
      h('div', { class: 'ico' }, icon(cmd.icon, 17)),
      h('div', { class: 'txt' }, h('div', { class: 'title' }, cmd.title), h('div', { class: 'desc' }, cmd.desc)),
      h('span', { class: 'enter' }, icon('corner-down-left', 14)),
      star));
    }
  }
  if (!state.visible.length) {
    nodes.push(state.cat === 'fav' && !state.query.trim()
      ? h('div', { class: 'empty' }, h('strong', null, 'No favourites yet'), 'Hover a command and click its star, or press Ctrl+D.')
      : h('div', { class: 'empty' }, h('strong', null, 'No command matches'), 'Try another word, or pick a different category.'));
  }
  listEl.replaceChildren(...nodes);
  state.selected = Math.min(state.selected, Math.max(0, state.visible.length - 1));
  paintSelection(false);
}

function paintSelection(scroll = true) {
  for (const el of listEl.querySelectorAll('.cmd')) {
    const on = Number(el.dataset.index) === state.selected;
    el.classList.toggle('sel', on);
    el.setAttribute('aria-selected', String(on));
    if (on) {
      searchInput.setAttribute('aria-activedescendant', el.id);
      if (scroll) el.scrollIntoView({ block: 'nearest' });
    }
  }
}

function toggleFav(id) {
  state.favs = state.favs.includes(id) ? state.favs.filter((f) => f !== id) : [...state.favs, id];
  save({ favs: state.favs });
  renderList();
  // The Favourites group grew or shrank above: keep the cursor on the same command.
  const index = state.visible.map((c) => c.id).lastIndexOf(id);
  if (index !== -1) {
    state.selected = index;
    paintSelection();
  }
}

// ── Running commands ──────────────────────────────────────────────────────
// Re-read what the page shows: a command may have changed the record or the page.
async function refreshContext() {
  const ctx = await call('context').catch(() => null);
  if (!ctx) return;
  state.ctx = ctx;
  renderHeader();
  if (listEl && listEl.isConnected) renderList();
}

// `invert` (Shift held) does the opposite of the "keep open" setting, once.
async function execute(cmd, args, invert) {
  const reason = reasonDisabled(cmd);
  if (reason) return toast(reason);
  if (cmd.view === 'impersonate') return showImpersonate();
  if (cmd.input && !args) return showInput(cmd);

  state.recents = [cmd.id, ...state.recents.filter((id) => id !== cmd.id)].slice(0, 6);
  await save({ recents: state.recents });
  document.body.classList.add('busy');
  try {
    const res = await call('run', cmd.id, args || {}, { theme: state.theme });
    if (!res) throw new Error('The page did not answer. Reload it and try again.');
    if (!res.ok) throw new Error(res.error);
    // A page that reloads takes the palette's view of it along: always close then.
    const keep = state.keepOpen !== !!invert && !res.navigate;
    if (res.copy) await copyText(res.copy);
    if (res.open) await api.tabs.create({ url: res.open, index: state.tab.index + 1, active: !keep });
    if (!keep) {
      if (res.toast) await call('notify', res.toast, res.kind || 'ok', state.theme);
      window.close();
      return true;
    }
    toast(res.toast || (res.open ? 'Opened in a background tab' : `${cmd.title}: done`), 'ok');
    if (!listEl.isConnected) showList();
    else {
      renderList();
      if (state.visible[state.selected] !== cmd) {
        const index = state.visible.lastIndexOf(cmd); // the Recent group grew above: stay on the same command
        if (index !== -1) state.selected = index;
      }
      paintSelection();
    }
    await refreshContext();
    setTimeout(refreshContext, 900); // in-app navigation settles a little later
    return true;
  } catch (err) {
    toast(String((err && err.message) || err));
    return false;
  } finally {
    document.body.classList.remove('busy');
  }
}

// ── Input view ────────────────────────────────────────────────────────────
function paneHead(cmd) {
  return h('div', { class: 'pane-head' },
    h('button', { class: 'ghost', type: 'button', title: 'Back (Esc)', 'aria-label': 'Back', onclick: showList }, icon('arrow-left', 18)),
    h('h2', null, cmd.title));
}

async function loadEntities() {
  if (state.entities) return state.entities;
  const res = await call('entities').catch(() => null);
  state.entities = res && res.ok ? res.list : [];
  return state.entities;
}

function entityField(field, input, wrap) {
  const box = h('div', { class: 'suggest', role: 'listbox', hidden: true });
  wrap.append(box);
  let items = [];
  let sel = 0;
  const paint = () => {
    box.replaceChildren(...items.map((e, i) => h('div', { class: i === sel ? 'sel' : '', role: 'option',
      onmousedown: (ev) => { ev.preventDefault(); pick(e); } }, h('code', null, e.name), h('small', null, e.label))));
    box.hidden = !items.length;
  };
  const pick = (e) => { input.value = e.name; items = []; paint(); input.dispatchEvent(new Event('change')); };
  const refresh = async () => {
    const all = await loadEntities();
    const q = input.value.trim();
    if (document.activeElement !== input) return;
    items = q ? fuzzyRank(q, all, (e) => [[e.name, 1], [e.label, 0.9]]).slice(0, 6) : [];
    if (items.length === 1 && items[0].name === q.toLowerCase()) items = [];
    sel = 0;
    paint();
  };
  input.addEventListener('input', refresh);
  input.addEventListener('blur', () => { items = []; paint(); });
  input.addEventListener('keydown', (e) => {
    if (!items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      paint();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      pick(items[sel]);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      items = [];
      paint();
    }
  });
  loadEntities(); // warm the cache while the user types
}

function showInput(cmd) {
  const inputs = {};
  const wraps = {};
  const fields = cmd.input.map((f) => {
    const input = h('input', { type: 'text', id: `f-${f.name}`, placeholder: f.placeholder, autocomplete: 'off', spellcheck: 'false' });
    const wrap = h('div', { class: 'field' }, h('label', { for: `f-${f.name}` }, f.label), input);
    inputs[f.name] = input;
    wraps[f.name] = wrap;
    if (f.type === 'entity') {
      if (state.ctx && state.ctx.entity) input.value = state.ctx.entity;
      entityField(f, input, wrap);
    }
    if (f.type === 'guid') {
      wrap.append(h('div', { class: 'hint' }, 'Tip: paste a full record URL and both fields fill in.'));
      input.addEventListener('input', () => {
        // A pasted record URL carries both the table (etn) and the id.
        const m = /[?&]id=(?:%7b)?([0-9a-f-]{36})/i.exec(input.value);
        const etn = /[?&]etn=([a-z0-9_]+)/i.exec(input.value);
        if (m && input.value.includes('://')) {
          input.value = m[1];
          if (etn && inputs.entity) inputs.entity.value = etn[1];
        }
      });
    }
    return wrap;
  });
  const submit = h('button', { class: 'primary', type: 'submit' }, cmd.title);
  const form = h('form', { class: 'pane', novalidate: true }, paneHead(cmd), h('p', null, cmd.desc), fields, submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const args = {};
    let bad = null;
    for (const f of cmd.input) {
      const value = inputs[f.name].value.trim();
      const error = !value ? 'Required.'
        : f.type === 'guid' && !GUID.test(value) ? 'That does not look like a GUID.'
        : f.type === 'entity' && !/^[a-z][a-z0-9_]*$/i.test(value) ? 'Use the logical name, like "account".' : '';
      wraps[f.name].classList.toggle('bad', !!error);
      wraps[f.name].querySelector('.error')?.remove();
      if (error) {
        wraps[f.name].append(h('div', { class: 'error' }, error));
        bad = bad || inputs[f.name];
      }
      args[f.name] = value;
    }
    if (bad) return bad.focus();
    submit.disabled = true;
    await execute(cmd, args);
    submit.disabled = false;
  });
  $('view').replaceChildren(form);
  const first = cmd.input.find((f) => !inputs[f.name].value) || cmd.input[0];
  inputs[first.name].focus();
  inputs[first.name].select();
}

// ── Impersonation view ────────────────────────────────────────────────────
function showImpersonate() {
  const cmd = byId.get('impersonate');
  const results = h('div', { class: 'users', role: 'list' });
  const input = h('input', { type: 'text', id: 'f-user', placeholder: 'Name or email…', autocomplete: 'off', spellcheck: 'false' });
  let seq = 0;
  let timer;
  const search = async () => {
    const mine = ++seq;
    const res = await call('searchUsers', input.value).catch((err) => ({ ok: false, error: String(err.message || err) }));
    if (mine !== seq) return;
    if (!res || !res.ok) return results.replaceChildren(h('div', { class: 'muted' }, (res && res.error) || 'Search failed.'));
    if (!res.users.length) return results.replaceChildren(h('div', { class: 'muted' }, 'No enabled user matches.'));
    results.replaceChildren(...res.users.map((u) => h('button', { class: 'user', type: 'button', role: 'listitem', onclick: () => startImpersonation(u) },
      h('div', { class: 'avatar', 'aria-hidden': 'true' }, u.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()),
      h('span', null, h('b', null, u.name), h('small', null, u.email || u.id)))));
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 220); });
  $('view').replaceChildren(h('div', { class: 'pane' }, paneHead(cmd),
    h('p', null, 'Pick a user and the app reloads. From then on the server reads and saves data as them: "Modified by" shows them, with you as the delegate.'
      + ' The page header keeps your own name. You need the "Act on behalf of another user" privilege (System Administrators have it).'),
    h('div', { class: 'field' }, h('label', { for: 'f-user' }, 'User'), input),
    results));
  results.replaceChildren(h('div', { class: 'muted' }, 'Searching…'));
  input.focus();
  search();
}

// Must run inside the click handler: Firefox only allows permissions.request there.
function startImpersonation(user) {
  const { origin } = state.ctx;
  const done = (res) => {
    if (res && res.ok && res.applied) return window.close();
    toast((res && res.error) || 'Could not start impersonation.');
  };
  const starting = background({ type: 'imp:start', origin, user, tabId: state.tab.id });
  if (state.imp.permitted) return starting.then(done, (err) => toast(String(err.message || err)));
  const site = new URL(origin);
  // No port in the pattern: Firefox rejects them, and without one every port matches.
  api.permissions.request({ origins: [`${site.protocol}//${site.hostname}/*`] }).then(async (granted) => {
    if (!granted) return toast('Level 67 needs access to this site to impersonate a user.');
    const first = await starting.catch(() => null);
    if (first && first.applied) return window.close();
    // Either we or the background's permission listener applies it; both are fine.
    await background({ type: 'imp:apply' }).catch(() => null);
    const status = await background({ type: 'imp:status', origin });
    done({ ok: true, applied: !!(status && status.user) });
  }, (err) => toast(String(err.message || err)));
}

async function stopImpersonation() {
  await background({ type: 'imp:stop', origin: state.ctx.origin, tabId: state.tab.id }).catch(() => null);
  window.close();
  state.imp.user = null;
  renderHeader();
}

// Ask the server who it thinks we are, and say so next to the "Acting as" banner.
async function checkImpersonation() {
  const { user } = state.imp;
  if (!user) return;
  const who = await call('whoAmI').catch(() => null);
  if (state.imp.user !== user) return;
  if (!who || !who.ok) {
    state.imp.check = { state: 'error', label: 'refused', detail: (who && who.error) || 'The server did not answer.' };
  } else if (who.userId === user.id.toLowerCase()) {
    state.imp.check = { state: 'ok', label: 'confirmed', detail: 'The server answers as this user.' };
  } else {
    state.imp.check = { state: 'off', label: 'not applied', detail: 'The server still answers as you. Stop, reload the page and try again.' };
  }
  renderHeader();
}

// ── Settings view ─────────────────────────────────────────────────────────
function segmented(label, options, current, onPick) {
  const group = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
  const paint = (value) => group.replaceChildren(...options.map(([id, text]) => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(id === value), 'data-value': String(id),
    onclick: () => { onPick(id); paint(id); },
  }, text)));
  paint(current);
  return group;
}

function showSettings() {
  const reset = h('button', { class: 'secondary', type: 'button', onclick: () => {
    state.favs = [];
    state.recents = [];
    save({ favs: [], recents: [] });
    toast('Favourites and recent commands cleared', 'ok');
  } }, 'Clear favourites and recents');
  $('view').replaceChildren(h('div', { class: 'pane settings' }, paneHead({ title: 'Settings' }),
    h('div', { class: 'setting' },
      h('div', null, h('b', null, 'After running a command'), h('small', null, 'Hold Shift while you click or press Enter to do the opposite once. Commands that reload the page always close the menu.')),
      segmented('After running a command', [[true, 'Keep open'], [false, 'Close']], state.keepOpen, (value) => { state.keepOpen = value; save({ keepOpen: value }); })),
    h('div', { class: 'setting' },
      h('div', null, h('b', null, 'Theme'), h('small', null, 'Auto follows your system. Applies to this menu and to the panels shown in the page.')),
      segmented('Theme', THEMES.map((t) => [t, t[0].toUpperCase() + t.slice(1)]), state.theme, (value) => { state.theme = value; save({ theme: value }); applyTheme(); })),
    h('div', { class: 'setting' },
      h('div', null, h('b', null, 'Keyboard shortcut'), h('small', null, 'Alt+Shift+L opens Level 67. Change it in your browser\'s extension shortcut settings.'))),
    h('div', { class: 'setting' },
      h('div', null, h('b', null, 'Your data'), h('small', null, 'Favourites, recent commands and these settings are stored in this browser only.')),
      reset)));
}

// ── Keyboard ──────────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  const inList = !!listEl && listEl.isConnected;
  if (e.key === 'Escape') {
    if (!inList) { e.preventDefault(); showList(); } else if (state.query) { e.preventDefault(); state.query = ''; searchInput.value = ''; renderList(); }
    return;
  }
  if (!inList) return;
  const n = state.visible.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (n) state.selected = (state.selected + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    paintSelection();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (n) execute(state.visible[state.selected], undefined, e.shiftKey);
  } else if (e.key.toLowerCase() === 'd' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (n) toggleFav(state.visible[state.selected].id);
  } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && document.activeElement !== searchInput) {
    searchInput.focus();
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────
async function boot() {
  const stored = await api.storage.local.get(['favs', 'recents', 'theme', 'keepOpen']).catch(() => ({}));
  state.keepOpen = stored.keepOpen !== false;
  state.favs = Array.isArray(stored.favs) ? stored.favs.filter((id) => byId.has(id)) : [];
  state.recents = Array.isArray(stored.recents) ? stored.recents.filter((id) => byId.has(id)) : [];
  state.theme = THEMES.includes(stored.theme) ? stored.theme : 'auto';
  applyTheme();
  $('theme').addEventListener('click', () => {
    state.theme = THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length];
    save({ theme: state.theme });
    applyTheme();
  });
  const gear = $('settings');
  gear.replaceChildren(icon('settings', 18));
  gear.addEventListener('click', () => (document.querySelector('.settings') ? showList() : showSettings()));
  const about = $('about');
  about.append(`v${api.runtime.getManifest().version}`, icon('external-link', 12));
  about.addEventListener('click', (e) => { e.preventDefault(); api.tabs.create({ url: about.href }); });
  renderHeader();
  showList();
  // Firefox can open the popup before it is focusable: claim the focus again once it is.
  const refocus = () => { if (searchInput.isConnected && document.activeElement === document.body) searchInput.focus(); };
  window.addEventListener('focus', refocus);
  setTimeout(refocus, 80);

  try {
    [state.tab] = await api.tabs.query({ active: true, currentWindow: true });
    await inject();
    state.ctx = (await call('context')) || { dynamics: false };
  } catch {
    state.ctx = { dynamics: false, blocked: true }; // browser pages, stores, PDF viewer…
  }
  if (state.ctx.dynamics) {
    const status = await background({ type: 'imp:status', origin: state.ctx.origin }).catch(() => null);
    if (status && status.ok) state.imp = { user: status.user, permitted: status.permitted, check: null };
    checkImpersonation();
  }
  renderHeader();
  if (listEl.isConnected) renderList();
}

boot();
