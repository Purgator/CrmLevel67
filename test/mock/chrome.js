// Fake extension APIs for `npm run preview`: the popup runs in an iframe and
// "injects" into its parent page, which hosts the Xrm mock and the real engine.
(() => {
  'use strict';
  const page = window.parent;
  const store = (area) => ({
    get: async (keys) => {
      const all = JSON.parse(area.getItem('level67-mock') || '{}');
      return Object.fromEntries([].concat(keys).filter((k) => k in all).map((k) => [k, all[k]]));
    },
    set: async (patch) => area.setItem('level67-mock', JSON.stringify({ ...JSON.parse(area.getItem('level67-mock') || '{}'), ...patch })),
  });
  let impersonated = JSON.parse(sessionStorage.getItem('level67-imp') || 'null');
  const setImp = (user) => {
    impersonated = user;
    sessionStorage.setItem('level67-imp', JSON.stringify(user));
    page.__mock.log.push(user ? `impersonation rule added for ${user.name} (${user.aad || user.id})` : 'impersonation rule removed');
    page.__mockChanged();
    setTimeout(() => window.location.reload(), 300);
  };

  window.chrome = {
    runtime: {
      id: 'mock',
      getManifest: () => ({ version: 'preview' }),
      sendMessage: async (msg) => {
        if (msg.type === 'imp:status') return { ok: true, user: impersonated, permitted: true };
        if (msg.type === 'imp:start') { setImp(msg.user); return { ok: true, applied: true }; }
        if (msg.type === 'imp:stop') { setImp(null); return { ok: true, stopped: true }; }
        return { ok: true, applied: false };
      },
    },
    storage: { local: store(localStorage) },
    tabs: {
      query: async () => [{ id: 1, index: 0, url: page.location.href }],
      create: async ({ url }) => { page.__mock.log.push(`new tab: ${url}`); page.__mockChanged(); },
    },
    scripting: {
      executeScript: async ({ func, args }) => {
        if (!func) return [{}]; // files are already loaded by the mock page
        const fn = page.eval(`(${func.toString()})`);
        return [{ result: await fn(...args) }];
      },
    },
    permissions: { request: async () => true },
  };
})();
