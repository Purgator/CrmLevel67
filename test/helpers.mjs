// Loads the page engine and the Xrm mock into a node:vm sandbox that stands in
// for a Dynamics 365 browser tab.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

export function createPage({ mock = true, href = 'https://contoso.crm4.dynamics.com/main.aspx?appid=abc123&pagetype=entityrecord&etn=account' } = {}) {
  const page = { panels: [], playgrounds: [], toasts: [], navigations: [], themes: [] };
  const sandbox = {
    URL, console, setTimeout, clearTimeout, Promise, Date, JSON, Math,
    frames: [],
    location: { href, origin: new URL(href).origin, assign: (url) => page.navigations.push(url) },
    fetch: async () => { throw new Error('network disabled in tests'); },
    CSSStyleSheet: class { replaceSync(css) { this.css = css; } },
    document: { adoptedStyleSheets: [] },
    __level67ui: {
      version: 'test',
      panel: (spec) => page.panels.push(spec),
      playground: (spec) => page.playgrounds.push(spec),
      toast: (message, kind) => page.toasts.push({ message, kind }),
      setTheme: (theme) => page.themes.push(theme),
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  if (mock) vm.runInContext(read('test/mock/xrm.js'), sandbox, { filename: 'xrm.js' });
  vm.runInContext(read('src/page/engine.js'), sandbox, { filename: 'engine.js' });
  page.window = sandbox;
  page.engine = sandbox.__level67;
  page.mock = sandbox.__mock;
  page.xrm = sandbox.Xrm;
  page.run = (id, args) => page.engine.run(id, args, { theme: 'dark' });
  return page;
}
