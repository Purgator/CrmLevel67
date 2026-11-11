// Background worker: owns user impersonation.
// Impersonation = a session-scoped declarativeNetRequest rule that adds the
// Dataverse "act as" header to Web API calls of one environment. Rules and
// state live in session storage, so everything resets when the browser closes.
'use strict';

const api = globalThis.browser ?? chrome;
const ACTIVE = 'impersonations'; // { [origin]: { ruleId, user } }
const PENDING = 'pending'; // { origin, user, tabId } waiting for a host permission

const read = async (key, fallback) => (await api.storage.session.get(key))[key] ?? fallback;
const write = (key, value) => api.storage.session.set({ [key]: value });
// Match pattern for a site. No port: Firefox rejects ports in match patterns,
// and on-premises orgs often live on one (https://crm.contoso.local:5555).
const sitePattern = (origin) => {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
};
const permitted = (origin) => api.permissions.contains({ origins: [sitePattern(origin)] });

// Serialize state changes: the popup and permissions.onAdded can race.
let queue = Promise.resolve();
const locked = (fn) => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
};

// The "AS" badge belongs to the tabs of the impersonated environment only.
// A tab's URL is visible here exactly when we have access to its site, which
// is always the case for an environment being impersonated.
async function paint(tab, active) {
  let origin = '';
  try { origin = new URL(tab.url).origin; } catch { /* no access to this tab, or no URL yet */ }
  const user = active[origin]?.user;
  await api.action.setBadgeText({ tabId: tab.id, text: user ? 'AS' : '' }).catch(() => {});
  await api.action.setTitle({ tabId: tab.id, title: user ? `Level 67 - acting as ${user.name}` : 'Level 67' }).catch(() => {});
}

async function badge(active) {
  await api.action.setBadgeText({ text: '' });
  await api.action.setBadgeBackgroundColor({ color: '#d97706' });
  await Promise.all((await api.tabs.query({})).map((tab) => paint(tab, active)));
}

// Browsers drop per-tab badges on navigation, and a tab can move to or away
// from an impersonated environment: repaint whenever one loads.
api.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!change.status && !change.url) return;
  read(ACTIVE, {}).then((active) => paint(tab, active)).catch(() => {});
});

async function start(origin, user, tabId) {
  const active = await read(ACTIVE, {});
  const ruleId = active[origin]?.ruleId ?? Math.max(0, ...Object.values(active).map((a) => a.ruleId)) + 1;
  // Entra object id when we have it (online), systemuserid otherwise (on-premises).
  const header = user.aad ? { header: 'CallerObjectId', value: user.aad } : { header: 'MSCRMCallerID', value: user.id };
  await api.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [{
      id: ruleId,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ ...header, operation: 'set' }] },
      // Every kind of request to the Web API, not only XHR: the app also calls it from frames and workers.
      condition: { urlFilter: `|${origin}/api/data/`, resourceTypes: ['xmlhttprequest', 'main_frame', 'sub_frame', 'ping', 'other'] },
    }],
  });
  active[origin] = { ruleId, user };
  await write(ACTIVE, active);
  await badge(active);
  if (tabId != null) await api.tabs.reload(tabId).catch(() => {});
}

async function stop(origin, tabId) {
  const active = await read(ACTIVE, {});
  if (active[origin]) {
    await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [active[origin].ruleId] });
    delete active[origin];
    await write(ACTIVE, active);
    await badge(active);
  }
  if (tabId != null) await api.tabs.reload(tabId).catch(() => {});
}

async function applyPending() {
  const pending = await read(PENDING, null);
  if (!pending || !(await permitted(pending.origin))) return false;
  await api.storage.session.remove(PENDING);
  await start(pending.origin, pending.user, pending.tabId);
  return true;
}

async function handle(msg) {
  switch (msg && msg.type) {
    case 'imp:status':
      return { user: (await read(ACTIVE, {}))[msg.origin]?.user ?? null, permitted: await permitted(msg.origin) };
    case 'imp:start':
      if (!/^https?:\/\/[^/]+$/.test(msg.origin) || !msg.user || !msg.user.id) throw new Error('Invalid impersonation request.');
      await write(PENDING, { origin: msg.origin, user: msg.user, tabId: msg.tabId });
      return { applied: await applyPending() };
    case 'imp:apply':
      return { applied: await applyPending() };
    case 'imp:stop':
      await api.storage.session.remove(PENDING);
      await stop(msg.origin, msg.tabId);
      return { stopped: true };
    default:
      return null;
  }
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== api.runtime.id || !msg || typeof msg.type !== 'string' || !msg.type.startsWith('imp:')) return false;
  locked(() => handle(msg)).then(
    (result) => sendResponse({ ok: true, ...result }),
    (err) => sendResponse({ ok: false, error: String((err && err.message) || err) }),
  );
  return true; // async response
});

// The popup may close while the browser shows the permission prompt (Firefox):
// finish the pending impersonation from here once access is granted.
api.permissions.onAdded.addListener(() => { locked(applyPending).catch(() => {}); });

// Keep the badge truthful after a worker restart.
read(ACTIVE, {}).then(badge).catch(() => {});
