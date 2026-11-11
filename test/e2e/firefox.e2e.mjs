// End-to-end test for the Firefox package, in a real (headless) Firefox.
// WebDriver cannot see inside an extension popup, so the test triggers the
// toolbar button from the browser-chrome context, drives the popup through a
// frame script, and checks the effects on the page and on the network.
// Needs Firefox installed. Run with `npm run test:e2e:firefox`.
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, cp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Builder } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { build, zip } from '../../scripts/build.mjs';
import { root } from '../helpers.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const steps = [];
const step = (name) => { steps.push(name); console.log(`  ✔ ${name}`); };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/data/v9.2/headers') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(req.headers));
  }
  if (url.pathname === '/mock/xrm.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(await readFile(path.join(root, 'test/mock/xrm.js')));
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><title>Mock org</title><h1>Mock Dynamics 365</h1><input value="secret"><script src="/mock/xrm.js"></script>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://localhost:${server.address().port}`;

// Test copy of the package with localhost access, so impersonation can be checked.
const target = (await build()).find((o) => o.target === 'firefox');
const work = await mkdtemp(path.join(tmpdir(), 'level67-fx-'));
await cp(target.dir, work, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(work, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('http://localhost/*');
await writeFile(path.join(work, 'manifest.json'), JSON.stringify(manifest));
const files = (await readdir(work, { recursive: true, withFileTypes: true })).filter((e) => e.isFile())
  .map((e) => path.relative(work, path.join(e.parentPath, e.name)).split(path.sep).join('/')).sort();
const xpi = path.join(work, 'level67-test.xpi');
await writeFile(xpi, zip(await Promise.all(files.map(async (name) => ({ name, data: await readFile(path.join(work, name)) })))));

// Clicking the toolbar needs the browser-chrome context, which geckodriver gates behind a flag.
const options = new firefox.Options().addArguments('-headless');
const service = new firefox.ServiceBuilder().addArguments('--allow-system-access');
const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(service).build();
let failed = false;
try {
  // Install it the way about:debugging does. (driver.installAddon uploads a copy
  // that geckodriver deletes afterwards, which breaks later script injection.)
  await driver.setContext(firefox.Context.CHROME);
  const installed = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
    const { FileUtils } = ChromeUtils.importESModule('resource://gre/modules/FileUtils.sys.mjs');
    AddonManager.installTemporaryAddon(new FileUtils.File(arguments[0])).then((addon) => done(addon.id), (e) => done('ERROR ' + e));`, xpi);
  await driver.setContext(firefox.Context.CONTENT);
  assert.equal(installed, 'level67@purgator.github.io');
  step('Firefox accepts the package');
  await driver.get(`${origin}/main.aspx?appid=abc&pagetype=entityrecord&etn=account`);

  const inChrome = async (fn) => {
    await driver.setContext(firefox.Context.CHROME);
    try { return await fn(); } finally { await driver.setContext(firefox.Context.CONTENT); }
  };
  // Trigger the toolbar button the way a click does (this grants activeTab and opens the popup).
  const openPopup = async () => {
    await inChrome(() => driver.executeScript(`
      const { ExtensionParent } = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
      const extension = WebExtensionPolicy.getByID('level67@purgator.github.io').extension;
      ExtensionParent.apiManager.global.browserActionFor(extension).triggerAction(window);`));
    for (let i = 0; i < 40; i++) {
      const state = await popup('return d.getElementById("env") && d.getElementById("env").className');
      if (typeof state === 'string' && /\b(on|off)\b/.test(state)) return;
      await wait(150);
    }
    throw new Error('The popup did not connect to the page.');
  };
  // Run code inside the popup document through a frame script: d = document, w = window.
  const popup = (code) => inChrome(() => driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const browser = [...document.querySelectorAll('.webextension-popup-browser')].find((b) => b.currentURI && b.currentURI.spec.endsWith('popup/popup.html'));
    if (!browser) return done({ closed: true });
    const id = 'level67-' + Math.random();
    const mm = browser.messageManager;
    const listener = (m) => { mm.removeMessageListener(id, listener); done(m.data); };
    mm.addMessageListener(id, listener);
    mm.loadFrameScript('data:,' + encodeURIComponent('(async () => { const d = content.document; const w = content; let result;'
      + ' const type = (sel, v) => { const i = d.querySelector(sel); i.focus(); i.value = v; i.dispatchEvent(new w.Event("input", { bubbles: true })); };'
      + ' const enter = () => d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));'
      + ' try { result = await (async () => { ' + arguments[0] + ' })(); } catch (e) { result = { error: String(e) }; }'
      + ' sendAsyncMessage(' + JSON.stringify(id) + ', result === undefined ? null : result); })();'), false);
    setTimeout(() => done({ timeout: true }), 5000);`, code));
  const runFromPalette = async (query) => {
    await openPopup();
    await popup(`type('.search input', ${JSON.stringify(query)}); enter();`);
    await wait(700);
  };
  const page = (script) => driver.executeScript(script);
  const toasts = () => page(`return [...(document.getElementById('level67-root')?.shadowRoot.querySelectorAll('.toast') || [])].map((t) => t.textContent)`);
  const popupClosed = async () => (await popup('return 1')).closed === true;

  await openPopup();
  assert.deepEqual(await popup('return [d.getElementById("env").textContent, d.getElementById("context").textContent, d.querySelectorAll(".cmd").length, d.querySelectorAll(".cmd.off").length]'),
    ['contoso-dev · v9.2.26103.165', 'account · Contoso Ltd', 52, 0]);
  step('toolbar click opens the popup, which connects to the page');

  await popup(`type('.search input', 'god mode'); enter();`);
  await wait(700);
  assert.equal(await page('return Xrm.Page.ui.controls.get("creditlimit").getVisible()'), true);
  assert.match((await toasts()).join(' | '), /God mode on: \d+ restrictions lifted/);
  assert.equal(await popupClosed(), true);
  step('god mode runs in the page and the popup closes');

  await runFromPalette('all fields');
  assert.equal(await page(`return document.getElementById('level67-root').shadowRoot.querySelector('.panel h1').textContent`), 'All fields');
  step('all fields opens the side panel');

  await runFromPalette('copy record id');
  assert.match((await toasts()).join(' | '), /Record ID copied: a1b2c3d4/);
  step('copy record id reports success');

  await runFromPalette('open record by id');
  assert.equal(await popup(`type('#f-id', 'nope'); d.querySelector('form').requestSubmit(); await new Promise((r) => w.setTimeout(r, 100)); return d.querySelector('.field .error').textContent;`),
    'That does not look like a GUID.');
  await popup(`type('#f-id', 'c0ffee00-1111-4222-8333-444444444444'); d.querySelector('form').requestSubmit();`);
  await wait(700);
  assert.match(await page('return __mock.log.at(-1)'), /^openForm \{"entityName":"account","entityId":"c0ffee00/);
  step('input commands validate, then run');

  const headers = () => driver.executeAsyncScript(`const done = arguments[arguments.length - 1];
    __mock.realFetch('/api/data/v9.2/headers').then((r) => r.json()).then(done, (e) => done({ error: String(e) }));`);
  assert.equal((await headers()).callerobjectid, undefined);
  await runFromPalette('impersonate');
  assert.equal(await popup(`type('#f-user', 'grace'); await new Promise((r) => w.setTimeout(r, 900)); return d.querySelectorAll('.user').length;`), 1);
  await popup(`d.querySelector('.user').click();`);
  await wait(2000); // rule added, tab reloaded
  assert.equal((await headers()).callerobjectid, 'aad00002-aaaa-4bbb-8ccc-dddddddddddd');
  step('impersonation adds the CallerObjectId header');

  await openPopup();
  assert.equal(await popup('return d.querySelector(".banner span").textContent'), 'Acting as Grace Hopper');
  await popup(`d.querySelector('.banner button').click();`);
  await wait(2000);
  assert.equal((await headers()).callerobjectid, undefined);
  step('stopping impersonation removes the header');

  await runFromPalette('forms monitor');
  await wait(800);
  assert.equal(new URL(await driver.getCurrentUrl()).searchParams.get('monitor'), 'true');
  step('debug flags reload the tab');
} catch (err) {
  failed = true;
  console.error(`\n  ✖ after "${steps.at(-1) || 'start'}":`, err);
} finally {
  await driver.quit();
  server.close();
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
console.log(failed ? '\nFIREFOX E2E FAILED' : `\nFirefox E2E passed (${steps.length} steps)`);
process.exit(failed ? 1 : 0);
