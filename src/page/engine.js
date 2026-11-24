// Level 67 engine. Injected in the page's MAIN world so it can reach the
// Dynamics 365 client API (Xrm). Exposes window.__level67 with:
//   context()            -> what the popup needs to know about this page
//   run(id, args, opts)  -> run a command; always resolves to { ok, ... }
//   entities()           -> table list for autocomplete
//   searchUsers(text)    -> users for impersonation
//   whoAmI()             -> the user the server answers as
//   notify(msg, kind)    -> show a toast in the page
// Every result is plain JSON so it can cross the extension boundary.
(() => {
  'use strict';
  const VERSION = '1.0.1';
  if (window.__level67 && window.__level67.version === VERSION) return;

  const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const FORMATTED = '@OData.Community.Display.V1.FormattedValue';
  const LOOKUP_TYPE = '@Microsoft.Dynamics.CRM.lookuplogicalname';
  const DEFAULT_SOLUTION = 'fd140aaf-4df4-11dd-bd17-0019b9312238';
  // Values worth hiding in a screenshot: field values, lookups, grid cells, record title, header fields, people.
  const BLUR = [
    // Unified Interface
    'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="search"])', 'textarea', 'select',
    '[role="gridcell"]', '[role="combobox"]', '[role="textbox"]', '[contenteditable="true"]', '.ag-cell',
    '[data-id="header_title"]', '[id^="headerControlsList"] > div > div:first-child',
    '[data-id$="selected_tag_text"]', '[data-id$="_selected_tag"]', '[data-id$=".fieldControl-checkbox-container"]',
    '[data-id*="fieldControl"] a', '[data-id*="fieldControl"] [role="link"]', '[role="presentation"] > img',
    '.ms-Persona-primaryText', '.ms-Persona-secondaryText',
    // Classic web client
    '.ms-crm-Inline-Value', '#FormTitle h1', '.ms-crm-List-DataCell',
  ].join(', ');
  // How each client marks the label of a form field: an id ending in
  // "<control>-field-label" (Unified Interface) or a cell with id "<control>_c" (classic).
  const MAX_OPEN = 20; // records opened at once from a list of IDs
  const RANDOM_POOL = 5000; // records a "random record" draws from
  const FIELD_LABEL = '[id$="-field-label"]';
  const CLASSIC_LABEL = '.ms-crm-InlineEditLabel';
  const state = { logical: null, blur: null, entities: null, sets: new Map() };
  const ui = () => window.__level67ui;

  // ── Environment ─────────────────────────────────────────────────────────
  function findXrm() {
    const wins = [window];
    try { for (let i = 0; i < window.frames.length; i++) wins.push(window.frames[i]); } catch { /* ignore */ }
    let fallback = null;
    for (const w of wins) {
      try {
        const x = w.Xrm;
        if (!x) continue;
        if (formOf(x)) return x; // legacy web client keeps the form in an iframe
        fallback = fallback || x;
      } catch { /* cross-origin frame */ }
    }
    return fallback;
  }

  function formOf(xrm) {
    try {
      const p = xrm.Page;
      return p && p.data && p.data.entity && p.ui ? p : null;
    } catch { return null; }
  }

  const safe = (fn, fallback) => { try { const v = fn(); return v == null ? fallback : v; } catch { return fallback; } };
  const cleanId = (id) => String(id || '').replace(/[{}]/g, '').toLowerCase();

  function getEnv() {
    const xrm = findXrm();
    if (!xrm) return null;
    const gc = safe(() => xrm.Utility.getGlobalContext()) || safe(() => xrm.Page.context);
    if (!gc || typeof gc.getClientUrl !== 'function') return null;
    const version = safe(() => gc.getVersion(), '9.2');
    const [major, minor] = version.split('.').map(Number);
    const apiVersion = major > 9 || (major === 9 && minor >= 2) ? 'v9.2' : `v${major}.${minor || 0}`;
    const clientUrl = gc.getClientUrl().replace(/\/$/, '');
    const form = formOf(xrm);
    const org = gc.organizationSettings || {};
    const user = gc.userSettings || {};
    return {
      xrm, gc, form, version, clientUrl,
      apiBase: `${clientUrl}/api/data/${apiVersion}`,
      entity: form ? safe(() => form.data.entity.getEntityName(), '') : '',
      recordId: form ? cleanId(safe(() => form.data.entity.getId(), '')) : '',
      orgName: org.uniqueName || safe(() => gc.getOrgUniqueName(), ''),
      envId: org.bapEnvironmentId || '',
      userId: cleanId(user.userId || safe(() => gc.getUserId(), '')),
      userName: user.userName || safe(() => gc.getUserName(), ''),
    };
  }

  function needForm(env) {
    if (!env.form) throw new Error('Open a record form first.');
    return env.form;
  }
  function needSaved(env) {
    needForm(env);
    if (!env.recordId) throw new Error('This record has not been saved yet.');
    return env.form;
  }
  function entityArg(args) {
    const name = String((args && args.entity) || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('Enter a table logical name, like "account".');
    return name;
  }

  // Resolve even if a platform promise never settles, so the popup cannot hang.
  const settle = (promise, ms = 4000) => Promise.race([promise, new Promise((r) => setTimeout(r, ms))]);

  // ── Web API ─────────────────────────────────────────────────────────────
  async function api(env, path) {
    const res = await fetch(`${env.apiBase}/${path.replace(/^\/+/, '')}`, {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
        Prefer: 'odata.include-annotations="*"',
      },
    });
    if (!res.ok) {
      let message = '';
      try { message = (await res.json()).error.message; } catch { /* not JSON */ }
      throw new Error(message || `Web API request failed (HTTP ${res.status}).`);
    }
    return res.status === 204 ? null : res.json();
  }

  async function entitySet(env, name) {
    if (state.sets.has(name)) return state.sets.get(name);
    const meta = await api(env, `EntityDefinitions(LogicalName='${name}')?$select=EntitySetName`);
    state.sets.set(name, meta.EntitySetName);
    return meta.EntitySetName;
  }

  // A random record of a table: one of the first RANDOM_POOL it can read, so a huge table is not fully random.
  async function randomId(env, entity) {
    const meta = await api(env, `EntityDefinitions(LogicalName='${entity}')?$select=EntitySetName,PrimaryIdAttribute`);
    const idAttr = meta.PrimaryIdAttribute || `${entity}id`;
    const data = await api(env, `${meta.EntitySetName}?$select=${idAttr}&$top=${RANDOM_POOL}`);
    const ids = data.value.map((r) => cleanId(r[idAttr])).filter(Boolean);
    if (!ids.length) throw new Error(`There is no record to open in "${entity}".`);
    return ids[Math.floor(Math.random() * ids.length)];
  }

  // IDs separated by commas, semicolons, spaces or new lines; braces are fine, duplicates are dropped.
  function parseIds(text) {
    const tokens = String(text || '').split(/[\s,;]+/).filter(Boolean).map(cleanId);
    if (!tokens.length) throw new Error('Enter at least one record ID.');
    const bad = tokens.filter((t) => !GUID.test(t));
    if (bad.length) throw new Error(`Not a valid GUID: ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? ` (+${bad.length - 3} more)` : ''}`);
    return [...new Set(tokens)];
  }

  async function recordPath(env) {
    return `${await entitySet(env, env.entity)}(${env.recordId})`;
  }

  // ── Small helpers ───────────────────────────────────────────────────────
  const each = (collection, fn) => { try { collection.forEach(fn); } catch { /* ignore */ } };
  const attrLabel = (attr) => safe(() => attr.controls.get(0).getLabel(), '') || attr.getName();
  const open = (url) => ({ open: url });

  // This document plus its same-origin frames, nested ones included (the
  // classic web client keeps the form in a frame).
  function docs() {
    const out = [];
    const walk = (win, depth) => {
      try { if (win.document && !out.includes(win.document)) out.push(win.document); } catch { return; /* cross-origin frame */ }
      if (depth >= 3) return;
      try { for (let i = 0; i < win.frames.length; i++) walk(win.frames[i], depth + 1); } catch { /* ignore */ }
    };
    walk(window, 0);
    return out;
  }

  // Adds CSS to a document and returns a function that removes it. A <style>
  // element when the page allows one, a constructed sheet otherwise.
  function addCss(doc, css) {
    try {
      const style = doc.createElement('style');
      style.textContent = css;
      (doc.head || doc.documentElement).append(style);
      if (style.sheet && style.sheet.cssRules.length) return () => style.remove();
      style.remove(); // blocked by the page's content security policy
    } catch { /* no DOM to speak of */ }
    try {
      const sheet = new (doc.defaultView || window).CSSStyleSheet();
      sheet.replaceSync(css);
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
      return () => { doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((x) => x !== sheet); };
    } catch { /* no constructable stylesheets here */ }
    return () => {};
  }

  // The user the server reads and writes data as: the impersonated one while
  // impersonating. Asked through a query, because WhoAmI itself ignores
  // impersonation on some versions.
  async function effectiveUserId(env) {
    try {
      const me = await api(env, "systemusers?$select=systemuserid&$filter=Microsoft.Dynamics.CRM.EqualUserId(PropertyName='systemuserid')");
      if (me.value && me.value[0]) return cleanId(me.value[0].systemuserid);
    } catch (err) {
      if (/privilege|prvActOnBehalfOfAnotherUser|0x80040220|0x8004/i.test(String(err && err.message))) throw err; // an impersonation the server refuses
    }
    const who = await api(env, 'WhoAmI').catch(() => null);
    return cleanId(who && who.UserId) || env.userId;
  }

  function display(value) {
    if (value == null) return '';
    if (value instanceof Date) return value.toLocaleString();
    if (Array.isArray(value)) return value.map((v) => (v && typeof v === 'object' ? v.name || v.id : v)).join(', ');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  function reloadWith(mutate) {
    const url = new URL(window.location.href);
    mutate(url.searchParams);
    setTimeout(() => window.location.assign(url.toString()), 150);
    return { navigate: url.toString(), toast: 'Reloading…', kind: 'info' };
  }
  function setFlag(params, key, value) {
    const flags = new Map((params.get('flags') || '').split(',').filter(Boolean).map((f) => {
      const i = f.indexOf('=');
      return i === -1 ? [f, 'true'] : [f.slice(0, i), f.slice(i + 1)];
    }));
    flags.set(key, value);
    params.set('flags', [...flags].map(([k, v]) => `${k}=${v}`).join(','));
  }

  // A link to a table list or a record, in the app the user is in. The popup
  // opens it in a new tab, which is what the "open in new tab" setting asks for.
  function pageUrl(env, type, entity, id) {
    const appId = new URL(window.location.href).searchParams.get('appid');
    return `${env.clientUrl}/main.aspx?${appId ? `appid=${appId}&` : ''}pagetype=${type}&etn=${entity}${id ? `&id=${id}` : ''}`;
  }
  async function openList(env, entity) {
    if (env.openIn === 'new') return open(pageUrl(env, 'entitylist', entity));
    const nav = env.xrm.Navigation;
    if (nav && nav.navigateTo) {
      await settle(nav.navigateTo({ pageType: 'entitylist', entityName: entity }));
      return {};
    }
    return open(`${env.clientUrl}/main.aspx?pagetype=entitylist&etn=${entity}`);
  }
  async function openRecord(env, entity, id, params) {
    if (env.openIn === 'new' && !params) return open(pageUrl(env, 'entityrecord', entity, id));
    const nav = env.xrm.Navigation;
    if (nav && nav.openForm) await settle(nav.openForm({ entityName: entity, entityId: id || undefined }, params));
    else env.xrm.Utility.openEntityForm(entity, id || undefined, params);
    return {};
  }
  const list = (entity) => (env) => openList(env, entity);

  // ── Commands ────────────────────────────────────────────────────────────
  const handlers = {
    'logical-names'(env) {
      const form = needForm(env);
      if (state.logical) {
        const same = state.logical.entity === env.entity;
        state.logical.off();
        state.logical = null;
        if (same) return { toast: 'Logical names hidden' };
      }
      const undo = [];
      const relabel = (obj) => safe(() => {
        const label = obj.getLabel();
        const name = obj.getName();
        if (!name || typeof obj.setLabel !== 'function') return;
        obj.setLabel(label ? `${label} ⟨${name}⟩` : `⟨${name}⟩`);
        undo.push(() => obj.setLabel(label));
      });

      // Fields: a chip under the label, drawn with CSS only so the app's own
      // rendering is left alone and fields that appear later get one too.
      const fields = []; // [control name, logical name]
      each(form.ui.controls, (c) => safe(() => {
        const name = c.getName();
        const logical = safe(() => c.getAttribute().getName(), '') || name;
        if (name && /^[\w.-]+$/.test(name) && /^[\w.-]+$/.test(logical)) fields.push([name, logical]);
      }));
      fields.sort((a, b) => a[0].length - b[0].length); // "name" also ends "firstname": the longer rule must win
      const targets = docs().filter((doc) => safe(() => doc.querySelector(`${FIELD_LABEL}, ${CLASSIC_LABEL}`), null));
      if (targets.length && fields.length) {
        const chip = 'display: block; width: fit-content; max-width: 100%; box-sizing: border-box; margin: 3px 0 2px; padding: 1px 7px;'
          + ' border-radius: 6px; background: #4a2fd0; color: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, .25);'
          + ' font: 600 11.5px/1.55 "Cascadia Code", Consolas, ui-monospace, monospace; letter-spacing: 0; text-transform: none;'
          + ' white-space: normal; overflow-wrap: anywhere; cursor: copy;';
        const css = `${FIELD_LABEL} { display: block !important; height: auto !important; max-height: none !important; overflow: visible !important;`
          + ' white-space: normal !important; text-overflow: clip !important; cursor: copy; }'
          + `:has(> ${FIELD_LABEL}) { overflow: visible !important; height: auto !important; max-height: none !important; }`
          + `${FIELD_LABEL}::after, [id$="_c"]::after { ${chip} }`
          + fields.map(([name, logical]) => `[id$="${name}-field-label"]::after, [id="${name}_c"]::after { content: "${logical}"; }`).join('');
        const onClick = (e) => {
          const label = safe(() => e.target.closest(`${FIELD_LABEL}, td[id$="_c"]`), null);
          if (!label) return;
          const hit = fields.filter(([name]) => label.id === `${name}_c` || label.id.endsWith(`${name}-field-label`)).pop();
          if (!hit) return;
          Promise.resolve(ui().copy(hit[1])).then((ok) => ui().toast(ok ? `Copied: ${hit[1]}` : 'Could not copy to the clipboard', ok ? 'ok' : 'error'));
        };
        for (const doc of targets) {
          undo.push(addCss(doc, css));
          doc.addEventListener('click', onClick, true);
          undo.push(() => doc.removeEventListener('click', onClick, true));
        }
      } else {
        each(form.ui.controls, relabel); // unknown layout (legacy web client): write the name into the label itself
      }
      each(form.ui.tabs, (tab) => { relabel(tab); each(tab.sections, relabel); });
      state.logical = { entity: env.entity, off: () => undo.forEach((fn) => safe(fn)) };
      return { toast: targets.length ? `Logical names shown on ${fields.length} fields. Click one to copy it. Run again to hide.`
        : 'Logical names shown. Run again to hide.' };
    },

    'god-mode'(env) {
      const form = needForm(env);
      let n = 0;
      each(form.ui.controls, (c) => {
        safe(() => { if (c.getVisible && !c.getVisible()) { c.setVisible(true); n++; } });
        safe(() => { if (c.getDisabled && c.getDisabled()) { c.setDisabled(false); n++; } });
      });
      each(form.data.entity.attributes, (a) => safe(() => {
        if (a.getRequiredLevel() !== 'none') { a.setRequiredLevel('none'); n++; }
      }));
      each(form.ui.tabs, (tab) => {
        safe(() => { if (!tab.getVisible()) { tab.setVisible(true); n++; } });
        each(tab.sections, (s) => safe(() => { if (!s.getVisible()) { s.setVisible(true); n++; } }));
      });
      return { toast: n ? `God mode on: ${n} restrictions lifted` : 'Nothing was hidden, locked or required' };
    },

    'changed-fields'(env) {
      const form = needForm(env);
      const rows = [];
      each(form.data.entity.attributes, (a) => {
        if (safe(() => a.getIsDirty(), false)) rows.push([attrLabel(a), { text: a.getName(), mono: true }, display(safe(() => a.getValue()))]);
      });
      if (!rows.length) return { toast: 'No unsaved changes on this form', kind: 'info' };
      ui().panel({ title: 'Changed fields', subtitle: `${rows.length} unsaved change${rows.length > 1 ? 's' : ''} on ${env.entity}`,
        sections: [{ columns: ['Field', 'Logical name', 'New value'], rows }] });
      return {};
    },

    'fill-required'(env) {
      const form = needForm(env);
      let filled = 0;
      let skipped = 0;
      each(form.data.entity.attributes, (a) => {
        try {
          if (a.getRequiredLevel() !== 'required' || a.getValue() != null) return;
          const type = a.getAttributeType();
          let value;
          if (type === 'string' || type === 'memo') {
            const format = safe(() => a.getFormat(), '');
            value = format === 'email' ? 'level67@example.com' : format === 'url' ? 'https://example.com' : 'Level 67';
            const max = safe(() => a.getMaxLength(), 0);
            if (max) value = value.slice(0, max);
          } else if (['integer', 'decimal', 'double', 'money'].includes(type)) {
            const min = safe(() => a.getMin(), 0);
            const max = safe(() => a.getMax(), 0);
            value = min > 0 ? min : max < 0 ? max : 0;
          } else if (type === 'boolean') value = false;
          else if (type === 'datetime') value = new Date();
          else if (type === 'optionset' || type === 'multiselectoptionset') {
            const first = (a.getOptions() || []).find((o) => o && o.value != null && o.value !== -1);
            if (!first) { skipped++; return; }
            value = type === 'optionset' ? first.value : [first.value];
          } else { skipped++; return; } // lookups need a real record: left to the user
          a.setValue(value);
          filled++;
        } catch { skipped++; }
      });
      if (!filled && !skipped) return { toast: 'No empty required field', kind: 'info' };
      return { toast: `${filled} required field${filled === 1 ? '' : 's'} filled${skipped ? `, ${skipped} left for you (lookups)` : ''}`, kind: skipped ? 'warn' : 'ok' };
    },

    'copy-record-id'(env) {
      needSaved(env);
      return { copy: env.recordId, toast: `Record ID copied: ${env.recordId}` };
    },

    'copy-record-url'(env) {
      needSaved(env);
      const appId = new URL(window.location.href).searchParams.get('appid');
      const url = `${env.clientUrl}/main.aspx?${appId ? `appid=${appId}&` : ''}pagetype=entityrecord&etn=${env.entity}&id=${env.recordId}`;
      return { copy: url, toast: 'Record URL copied' };
    },

    async 'open-web-api'(env) {
      needSaved(env);
      return open(`${env.apiBase}/${await recordPath(env)}`);
    },

    async 'all-fields'(env) {
      needSaved(env);
      const record = await api(env, await recordPath(env));
      const rows = [];
      const columnName = (key) => (/^_.+_value$/.test(key) ? key.slice(1, -6) : key); // lookups come back as _name_value
      for (const key of Object.keys(record).sort((a, b) => columnName(a).localeCompare(columnName(b)))) {
        if (key.includes('@')) continue;
        const value = record[key];
        const lookup = record[key + LOOKUP_TYPE];
        const name = columnName(key);
        const shown = record[key + FORMATTED];
        rows.push([
          { text: name, mono: true },
          value == null ? { text: 'null', dim: true, mono: true } : { text: typeof value === 'object' ? JSON.stringify(value) : value, mono: true },
          shown == null ? (lookup ? `(${lookup})` : '') : lookup ? `${shown} (${lookup})` : shown,
        ]);
      }
      ui().panel({ title: 'All fields', subtitle: `${env.entity} · ${env.recordId}`, wide: true, name: `${env.entity}-fields`, json: record,
        sections: [{ columns: ['Column', 'Value', 'Display value'], rows }] });
      return {};
    },

    async 'record-properties'(env) {
      const form = needSaved(env);
      const r = await api(env, await recordPath(env));
      const rows = [];
      const add = (label, value, mono) => { if (value != null && value !== '') rows.push([label, mono ? { text: value, mono: true } : value]); };
      add('Table', env.entity, true);
      add('Record ID', env.recordId, true);
      add('Name', safe(() => form.data.entity.getPrimaryAttributeValue()));
      add('Created on', r['createdon' + FORMATTED] || r.createdon);
      add('Created by', r['_createdby_value' + FORMATTED]);
      add('Modified on', r['modifiedon' + FORMATTED] || r.modifiedon);
      add('Modified by', r['_modifiedby_value' + FORMATTED]);
      add('Owner', r['_ownerid_value' + FORMATTED]);
      add('Owner ID', r._ownerid_value, true);
      add('Business unit', r['_owningbusinessunit_value' + FORMATTED]);
      add('Status', r.statecode == null ? null : `${r['statecode' + FORMATTED] || ''} (${r.statecode})`);
      add('Status reason', r.statuscode == null ? null : `${r['statuscode' + FORMATTED] || ''} (${r.statuscode})`);
      add('Version number', r.versionnumber, true);
      const frows = [];
      const item = safe(() => form.ui.formSelector.getCurrentItem());
      if (item) {
        frows.push(['Form name', safe(() => item.getLabel(), '')]);
        frows.push(['Form ID', { text: cleanId(safe(() => item.getId(), '')), mono: true }]);
      }
      const types = { 1: 'Create', 2: 'Update', 3: 'Read only', 4: 'Disabled', 6: 'Bulk edit' };
      const ft = safe(() => form.ui.getFormType());
      if (ft != null) frows.push(['Form type', `${types[ft] || 'Unknown'} (${ft})`]);
      ui().panel({ title: 'Record properties', subtitle: `${env.entity} · ${env.recordId}`, name: `${env.entity}-properties`,
        sections: [{ title: 'Record', rows }, { title: 'Form', rows: frows }] });
      return {};
    },

    'optionset-values'(env) {
      const form = needForm(env);
      const sections = [];
      each(form.data.entity.attributes, (a) => {
        const options = safe(() => a.getOptions());
        if (!Array.isArray(options) || !options.length) return;
        const current = [].concat(safe(() => a.getValue(), []));
        sections.push({
          title: `${attrLabel(a)} · ${a.getName()}`,
          rows: options.filter((o) => o && o.value != null).map((o) => [
            { text: o.value, mono: true }, o.text,
            current.includes(o.value) ? { text: 'selected', tag: 'on' } : '',
          ]),
        });
      });
      if (!sections.length) return { toast: 'No choice field on this form', kind: 'info' };
      sections.sort((a, b) => a.title.localeCompare(b.title));
      ui().panel({ title: 'Choice values', subtitle: `${sections.length} choice fields on ${env.entity}`, name: `${env.entity}-choices`, sections });
      return {};
    },

    async 'clone-record'(env) {
      const form = needForm(env);
      const skip = new Set(['createdon', 'createdby', 'modifiedon', 'modifiedby', 'createdonbehalfby', 'modifiedonbehalfby',
        'statecode', 'statuscode', 'ownerid', 'owningbusinessunit', 'owninguser', 'owningteam', `${env.entity}id`]);
      const params = {};
      let n = 0;
      each(form.data.entity.attributes, (a) => {
        try {
          const name = a.getName();
          const value = a.getValue();
          if (skip.has(name) || value == null || value === '') return;
          const type = a.getAttributeType();
          if (type === 'lookup' || type === 'customer' || type === 'owner') {
            if (!value[0] || value.length > 1) return; // party lists cannot be passed as parameters
            params[name] = cleanId(value[0].id);
            params[`${name}name`] = value[0].name || '';
            params[`${name}type`] = value[0].entityType;
          } else if (type === 'datetime') params[name] = value.toISOString();
          else if (type === 'multiselectoptionset') params[name] = `[${value.join(',')}]`;
          else if (['string', 'memo', 'boolean', 'optionset', 'integer', 'decimal', 'double', 'money'].includes(type)) params[name] = value;
          else return;
          n++;
        } catch { /* skip unreadable attribute */ }
      });
      await openRecord(env, env.entity, null, params);
      return { toast: `Clone opened with ${n} values copied. Review, then save.` };
    },

    'refresh-subgrids'(env) {
      const form = needForm(env);
      let n = 0;
      each(form.ui.controls, (c) => safe(() => {
        if (c.getControlType() === 'subgrid' && c.refresh) { c.refresh(); n++; }
      }));
      return n ? { toast: `${n} subgrid${n > 1 ? 's' : ''} refreshed` } : { toast: 'No subgrid on this form', kind: 'info' };
    },

    async 'refresh-form'(env) {
      const form = needSaved(env);
      await settle(form.data.refresh(false));
      return { toast: 'Form reloaded without saving' };
    },

    'blur-data'() {
      if (state.blur) {
        state.blur.off();
        state.blur = null;
        return { toast: 'Blur removed' };
      }
      // One rule per document, frames included: the form of the classic client lives in one.
      const all = docs();
      const count = all.reduce((n, doc) => n + safe(() => doc.querySelectorAll(BLUR).length, 0), 0);
      const undo = all.map((doc) => addCss(doc, `${BLUR} { filter: blur(5px) !important; }`));
      state.blur = { off: () => undo.forEach((fn) => safe(fn)) };
      return count ? { toast: `${count} values blurred. Run again to remove.` }
        : { toast: 'Blur is on, but this page shows no value yet. Run again to remove.', kind: 'info' };
    },

    async 'table-processes'(env) {
      needForm(env);
      const data = await api(env, `workflows?$select=name,category,statecode,mode&$filter=primaryentity eq '${env.entity}' and type eq 1&$orderby=name`);
      const kinds = { 0: 'Workflows', 1: 'Dialogs', 2: 'Business rules', 3: 'Actions', 4: 'Business process flows', 5: 'Cloud flows', 6: 'Desktop flows' };
      const groups = new Map();
      for (const w of data.value) {
        const title = kinds[w.category] || `Other (${w.category})`;
        if (!groups.has(title)) groups.set(title, []);
        groups.get(title).push([
          w.name,
          w.statecode === 1 ? { text: 'Active', tag: 'on' } : { text: 'Draft', tag: 'off' },
          w.category === 0 ? (w.mode === 1 ? 'Real-time' : 'Background') : '',
          { text: w.workflowid, mono: true, dim: true },
        ]);
      }
      if (!groups.size) return { toast: `No process on ${env.entity}`, kind: 'info' };
      ui().panel({ title: 'Table processes', subtitle: `${data.value.length} processes on ${env.entity}`, wide: true, name: `${env.entity}-processes`,
        sections: [...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([title, rows]) => ({ title, columns: ['Name', 'State', 'Mode', 'ID'], rows })) });
      return {};
    },

    async 'table-metadata'(env) {
      needForm(env);
      const data = await api(env, `EntityDefinitions(LogicalName='${env.entity}')/Attributes?$select=LogicalName,SchemaName,DisplayName,AttributeType,RequiredLevel,IsCustomAttribute,AttributeOf`);
      const rows = data.value.filter((a) => !a.AttributeOf).sort((a, b) => a.LogicalName.localeCompare(b.LogicalName)).map((a) => {
        const required = (a.RequiredLevel && a.RequiredLevel.Value) || 'None';
        return [
          safe(() => a.DisplayName.UserLocalizedLabel.Label, ''),
          { text: a.LogicalName, mono: true },
          { text: a.SchemaName, mono: true, dim: true },
          a.AttributeType,
          required === 'None' ? '' : { text: required === 'ApplicationRequired' ? 'Required' : required === 'SystemRequired' ? 'System' : 'Recommended', tag: '' },
          a.IsCustomAttribute ? { text: 'custom', tag: 'on' } : '',
        ];
      });
      ui().panel({ title: 'Table columns', subtitle: `${rows.length} columns on ${env.entity}`, wide: true, name: `${env.entity}-columns`,
        sections: [{ columns: ['Display name', 'Logical name', 'Schema name', 'Type', 'Required', ''], rows }] });
      return {};
    },

    'form-editor'(env) {
      const form = needForm(env);
      const formId = cleanId(safe(() => form.ui.formSelector.getCurrentItem().getId(), ''));
      if (!formId) throw new Error('Could not find the ID of the current form.');
      if (env.envId) return open(`https://make.powerapps.com/e/${env.envId}/s/${DEFAULT_SOLUTION}/entity/${env.entity}/form/edit/${formId}?source=powerappsportal`);
      return open(`${env.clientUrl}/main.aspx?pagetype=formeditor&etn=${env.entity}&extraqs=${encodeURIComponent(`formtype=main&formId=${formId}`)}`);
    },

    // Navigate
    async 'open-by-id'(env, args) {
      const entity = entityArg(args);
      if (args.mode === 'random') {
        const id = await randomId(env, entity);
        return { ...(await openRecord(env, entity, id)), toast: `Opened a random ${entity}: ${id}` };
      }
      if (args.mode === 'many') {
        const ids = parseIds(args.ids);
        if (ids.length === 1) return openRecord(env, entity, ids[0]);
        if (ids.length > MAX_OPEN) throw new Error(`That is ${ids.length} records: open at most ${MAX_OPEN} at once.`);
        return { open: ids.map((id) => pageUrl(env, 'entityrecord', entity, id)), toast: `Opening ${ids.length} records in new tabs` };
      }
      const id = cleanId(String(args.id || '').trim());
      if (!GUID.test(id)) throw new Error('That is not a valid record ID (GUID).');
      return openRecord(env, entity, id);
    },
    'new-record': (env, args) => openRecord(env, entityArg(args), null),
    'open-list': (env, args) => openList(env, entityArg(args)),
    async 'my-profile'(env) {
      const id = await effectiveUserId(env).catch(() => env.userId);
      if (!id) throw new Error('Could not find the current user.');
      return openRecord(env, 'systemuser', id);
    },
    'advanced-find': (env) => open(`${env.clientUrl}/main.aspx?pagetype=advancedfind`),
    'maker-portal': (env) => open(env.envId ? `https://make.powerapps.com/environments/${env.envId}/home` : 'https://make.powerapps.com/'),
    'solutions': (env) => open(env.envId ? `https://make.powerapps.com/environments/${env.envId}/solutions`
      : `${env.clientUrl}/tools/solution/home_solution.aspx?etc=7100`),
    'admin-center': (env) => open(env.envId ? `https://admin.powerplatform.microsoft.com/environments/environment/${env.envId}/hub`
      : 'https://admin.powerplatform.microsoft.com/environments'),

    // Admin
    'list-users': list('systemuser'),
    'list-teams': list('team'),
    'list-roles': list('role'),
    'list-business-units': list('businessunit'),
    'list-system-jobs': list('asyncoperation'),
    'list-plugin-traces': list('plugintracelog'),
    'list-processes': list('workflow'),
    'list-env-variables': list('environmentvariabledefinition'),
    'list-web-resources': list('webresource'),
    'list-mailboxes': list('mailbox'),
    'list-solution-history': list('msdyn_solutionhistory'),
    'advanced-settings': (env) => open(`${env.clientUrl}/main.aspx?settingsonly=true`),

    // Debug: documented URL switches of the Unified Interface.
    'forms-monitor': () => reloadWith((p) => p.set('monitor', 'true')),
    'command-checker': () => reloadWith((p) => p.set('ribbondebug', 'true')),
    'perf-center': () => reloadWith((p) => p.set('perf', 'true')),
    'disable-handlers': () => reloadWith((p) => setFlag(p, 'DisableFormHandlers', 'true')),
    'disable-rules': () => reloadWith((p) => setFlag(p, 'DisableFormHandlers', 'businessrule')),
    'disable-libraries': () => reloadWith((p) => setFlag(p, 'DisableFormLibraries', 'true')),
    'dark-mode': () => reloadWith((p) => setFlag(p, 'themeOption', 'darkmode')),
    'clear-flags': () => reloadWith((p) => ['flags', 'monitor', 'ribbondebug', 'perf'].forEach((k) => p.delete(k))),

    // Tools
    async 'env-info'(env) {
      const { gc } = env;
      const org = gc.organizationSettings || {};
      const user = gc.userSettings || {};
      const mono = (v) => ({ text: v, mono: true });
      const rowsOf = (pairs) => pairs.filter(([, v]) => v != null && v !== '').map(([k, v, m]) => [k, m ? mono(v) : v]);
      const app = await settle(Promise.resolve(safe(() => gc.getCurrentAppProperties())).catch(() => null), 2500);
      const sections = [
        { title: 'Environment', rows: rowsOf([
          ['Organization', env.orgName], ['Organization ID', cleanId(org.organizationId), true], ['Environment ID', env.envId, true],
          ['Version', env.version, true], ['URL', env.clientUrl, true], ['Web API', env.apiBase, true],
          ['Region', org.organizationGeo], ['Base language', org.languageId], ['Base currency', safe(() => org.baseCurrency.name)],
          ['Autosave', org.isAutoSaveEnabled == null ? null : org.isAutoSaveEnabled ? 'Enabled' : 'Disabled'],
        ]) },
        { title: 'User', rows: rowsOf([
          ['Name', env.userName], ['User ID', env.userId, true], ['Language', user.languageId],
          ['Security roles', safe(() => (user.roles.get ? user.roles.get() : user.roles).map((r) => r.name).filter(Boolean).join(', ')) || safe(() => user.securityRoles.length)],
        ]) },
        { title: 'App', rows: rowsOf([
          ['Name', app && app.displayName], ['Unique name', app && app.uniqueName, true], ['App ID', app && cleanId(app.appId), true],
          ['Client', safe(() => gc.client.getClient())], ['Form factor', safe(() => ({ 0: 'Unknown', 1: 'Desktop', 2: 'Tablet', 3: 'Phone' })[gc.client.getFormFactor()])],
        ]) },
      ].filter((s) => s.rows.length);
      ui().panel({ title: 'Environment details', subtitle: env.clientUrl, name: 'environment', sections });
      return {};
    },

    async 'my-roles'(env) {
      const id = await effectiveUserId(env);
      if (!id) throw new Error('Could not find the current user.');
      const u = await api(env, `systemusers(${id})?$select=fullname&$expand=systemuserroles_association($select=name,roleid),teammembership_association($select=name,teamid)`);
      const row = (name, id) => [name, { text: id, mono: true, dim: true }];
      const roles = (u.systemuserroles_association || []).map((r) => row(r.name, r.roleid)).sort((a, b) => a[0].localeCompare(b[0]));
      const teams = (u.teammembership_association || []).map((t) => row(t.name, t.teamid)).sort((a, b) => a[0].localeCompare(b[0]));
      ui().panel({ title: 'My roles and teams', subtitle: u.fullname || env.userName, name: 'my-roles', json: u,
        sections: [
          { title: `Security roles assigned directly (${roles.length})`, columns: ['Role', 'ID'], rows: roles },
          { title: `Teams (${teams.length})`, columns: ['Team', 'ID'], rows: teams, note: teams.length ? 'Roles granted through a team apply on top of the direct ones.' : '' },
        ] });
      return {};
    },

    async 'record-count'(env, args) {
      const entity = entityArg(args);
      const data = await api(env, `RetrieveTotalRecordCount(EntityNames=@p)?@p=${encodeURIComponent(JSON.stringify([entity]))}`);
      const c = data && data.EntityRecordCountCollection;
      const i = c && c.Keys ? c.Keys.indexOf(entity) : -1;
      if (i === -1) throw new Error(`No count available for "${entity}".`);
      return { toast: `${Number(c.Values[i]).toLocaleString()} rows in ${entity} (Dataverse snapshot, refreshed about daily)`, kind: 'info' };
    },

    async 'api-playground'(env) {
      const examples = ['WhoAmI', 'accounts?$select=name&$top=5', "EntityDefinitions(LogicalName='account')?$select=LogicalName,PrimaryNameAttribute"];
      if (env.recordId) examples.unshift(await recordPath(env).catch(() => 'WhoAmI'));
      ui().playground({
        subtitle: `GET ${env.apiBase}/…`,
        examples: [...new Set(examples)],
        run: (query) => api(env, query.replace(/\s*[\r\n]+\s*/g, '')),
      });
      return {};
    },

    'web-api-root': (env) => open(`${env.apiBase}/`),
    'diagnostics': (env) => open(`${env.clientUrl}/tools/diagnostics/diag.aspx`),
  };

  // ── Public API ──────────────────────────────────────────────────────────
  function context() {
    try {
      const env = getEnv();
      if (!env) return { dynamics: false };
      const params = new URL(window.location.href).searchParams;
      return {
        dynamics: true,
        origin: window.location.origin,
        org: env.orgName,
        version: env.version,
        userName: env.userName,
        form: !!env.form,
        saved: !!env.recordId,
        entity: env.entity,
        recordId: env.recordId,
        recordName: env.form ? display(safe(() => env.form.data.entity.getPrimaryAttributeValue())) : '',
        flags: ['flags', 'monitor', 'ribbondebug', 'perf'].some((k) => params.has(k)),
        classic: !!safe(() => document.querySelector('iframe[id^="contentIFrame"]'), null),
      };
    } catch {
      return { dynamics: false };
    }
  }

  async function run(id, args, opts) {
    try {
      if (opts && opts.theme) ui().setTheme(opts.theme);
      const handler = Object.prototype.hasOwnProperty.call(handlers, id) ? handlers[id] : null;
      if (!handler) throw new Error(`Unknown command: ${id}`);
      const env = getEnv();
      if (!env) throw new Error('This page is not a Dynamics 365 / Power Apps model-driven app.');
      env.openIn = opts && opts.openIn === 'new' ? 'new' : 'current';
      return { ok: true, ...((await handler(env, args || {})) || {}) };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  async function entities() {
    try {
      const env = getEnv();
      if (!env) return { ok: false, error: 'Not a Dynamics 365 page.' };
      if (!state.entities) {
        const data = await api(env, 'EntityDefinitions?$select=LogicalName,DisplayName,EntitySetName');
        state.entities = data.value.map((e) => {
          state.sets.set(e.LogicalName, e.EntitySetName);
          return { name: e.LogicalName, label: safe(() => e.DisplayName.UserLocalizedLabel.Label, '') };
        }).sort((a, b) => a.name.localeCompare(b.name));
      }
      return { ok: true, list: state.entities };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  async function searchUsers(text) {
    try {
      const env = getEnv();
      if (!env) return { ok: false, error: 'Not a Dynamics 365 page.' };
      const q = encodeURIComponent(String(text || '').trim().replace(/'/g, "''"));
      const filter = `isdisabled eq false${q ? ` and (contains(fullname,'${q}') or contains(internalemailaddress,'${q}'))` : ''}`;
      const query = (cols) => api(env, `systemusers?$select=${cols}&$filter=${filter}&$orderby=fullname&$top=8`);
      let data;
      try {
        data = await query('fullname,internalemailaddress,azureactivedirectoryobjectid');
      } catch {
        data = await query('fullname,internalemailaddress'); // on-premises has no Entra object id
      }
      return { ok: true, users: data.value.map((u) => ({
        id: u.systemuserid, name: u.fullname || '(no name)', email: u.internalemailaddress || '', aad: u.azureactivedirectoryobjectid || '',
      })) };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  // Who the server says we are, so the popup can prove an impersonation is live.
  async function whoAmI() {
    try {
      const env = getEnv();
      if (!env) return { ok: false, error: 'Not a Dynamics 365 page.' };
      return { ok: true, userId: await effectiveUserId(env), pageUserId: env.userId };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  function notify(message, kind, theme) {
    if (theme) ui().setTheme(theme);
    ui().toast(message, kind || 'ok');
  }

  window.__level67 = { version: VERSION, context, run, entities, searchUsers, whoAmI, notify, commands: Object.keys(handlers) };
})();
