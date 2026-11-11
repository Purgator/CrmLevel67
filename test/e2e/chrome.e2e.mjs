// End-to-end test: loads the built Chrome package in headless Chrome, opens the
// real popup against a fake Dynamics 365 page and checks the full chain
// (popup -> scripting.executeScript -> page engine -> background -> network rule).
// Run with `npm run test:e2e`.
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { build } from '../../scripts/build.mjs';
import { root } from '../helpers.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const steps = [];
const step = (name) => { steps.push(name); console.log(`  ✔ ${name}`); };

// A fake org: the Xrm mock plus one real endpoint that echoes request headers.
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
  res.end(url.pathname === '/plain' ? '<!doctype html><title>Plain</title><h1>Not Dynamics</h1>'
    : '<!doctype html><title>Mock org</title><h1>Mock Dynamics 365</h1><input value="secret"><script src="/mock/xrm.js"></script>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://localhost:${server.address().port}`;

// The shipped manifest only has access to Dynamics domains (plus activeTab on
// click). Headless automation cannot click the toolbar, so the test copy gets
// localhost access instead.
const chrome = (await build()).find((o) => o.target === 'chrome');
const extDir = await mkdtemp(path.join(tmpdir(), 'level67-e2e-'));
await cp(chrome.dir, extDir, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('http://localhost/*');
await writeFile(path.join(extDir, 'manifest.json'), JSON.stringify(manifest));

const browser = await puppeteer.launch({ pipe: true, enableExtensions: [extDir] });
let failed = false;
try {
  const workerTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
  const worker = await workerTarget.worker();
  step('service worker starts');

  const page = (await browser.pages())[0];
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${origin}/main.aspx?appid=abc&pagetype=entityrecord&etn=account`);

  const openPopup = async () => {
    for (let attempt = 0; ; attempt++) {
      await page.bringToFront();
      try {
        await worker.evaluate('chrome.action.openPopup()');
        break;
      } catch (err) {
        if (attempt === 9) throw err; // the window may still be settling after a tab closed
        await wait(250);
      }
    }
    const target = await browser.waitForTarget((t) => t.type() === 'page' && t.url().endsWith('popup/popup.html'));
    const popup = await target.asPage();
    popup.on('pageerror', (e) => errors.push(`popup: ${e}`));
    await popup.waitForSelector('#env.on, #env.off');
    return popup;
  };
  const closed = (popup) => new Promise((r) => (popup.isClosed() ? r() : popup.once('close', r)));
  const runFromPalette = async (query) => {
    const popup = await openPopup();
    await popup.type('.search input', query);
    await popup.keyboard.press('Enter');
    return popup;
  };
  const shadow = (fn) => page.evaluate(`(${fn})(document.getElementById('level67-root').shadowRoot)`);

  let popup = await openPopup();
  assert.equal(await popup.$eval('#env', (e) => e.textContent), 'contoso-dev · v9.2.26103.165');
  assert.equal(await popup.$eval('#context', (e) => e.textContent), 'account · Contoso Ltd');
  assert.equal(await popup.$$eval('.cmd', (els) => els.length), 52);
  assert.equal(await popup.$$eval('.cmd.off', (els) => els.length), 0);
  step('popup connects to the page and lists 52 enabled commands');
  await popup.close();

  await closed(await runFromPalette('god mode'));
  assert.equal(await page.evaluate(() => Xrm.Page.ui.controls.get('creditlimit').getVisible()), true);
  assert.match(await shadow((s) => s.querySelector('.toast').textContent), /God mode on: \d+ restrictions lifted/);
  step('god mode runs in the page and the popup closes');

  await closed(await runFromPalette('all fields'));
  assert.equal(await shadow((s) => s.querySelector('.panel h1').textContent), 'All fields');
  assert.ok(await shadow((s) => s.querySelectorAll('.panel tbody tr').length) > 10);
  step('all fields opens the side panel');

  await closed(await runFromPalette('copy record id'));
  assert.match(await shadow((s) => [...s.querySelectorAll('.toast')].at(-1).textContent), /Record ID copied: a1b2c3d4/);
  step('copy record id reports success');

  await closed(await runFromPalette('blur'));
  assert.equal(await page.$eval('input', (i) => getComputedStyle(i).filter), 'blur(5px)');
  step('blur applies a stylesheet');

  popup = await runFromPalette('web api root');
  const apiTab = await browser.waitForTarget((t) => t.url() === `${origin}/api/data/v9.2/`);
  await closed(popup);
  await (await apiTab.asPage()).close();
  step('link commands open a new tab');

  popup = await runFromPalette('open record by id');
  await popup.waitForSelector('#f-id');
  await popup.type('#f-id', 'not-a-guid');
  await popup.keyboard.press('Enter');
  assert.equal(await popup.$eval('.field .error', (e) => e.textContent), 'That does not look like a GUID.');
  await popup.$eval('#f-id', (i) => { i.value = ''; });
  await popup.type('#f-id', 'c0ffee00-1111-4222-8333-444444444444');
  await popup.keyboard.press('Enter');
  await closed(popup);
  assert.match(await page.evaluate(() => __mock.log.at(-1)), /^openForm \{"entityName":"account","entityId":"c0ffee00/);
  step('input commands validate, then run');

  // Impersonation: pick a user, expect a session rule, a badge and the header on the wire.
  const headers = () => page.evaluate(() => __mock.realFetch('/api/data/v9.2/headers').then((r) => r.json()));
  assert.equal((await headers()).callerobjectid, undefined);
  popup = await runFromPalette('impersonate');
  await popup.waitForSelector('.user');
  await popup.type('#f-user', 'grace');
  await popup.waitForFunction(() => document.querySelectorAll('.user').length === 1);
  const reloaded = page.waitForNavigation();
  await popup.click('.user');
  await Promise.all([closed(popup), reloaded]);
  const rules = await worker.evaluate('chrome.declarativeNetRequest.getSessionRules()');
  assert.equal(rules.length, 1);
  assert.equal(rules[0].condition.urlFilter, `|${origin}/api/data/`);
  assert.equal((await headers()).callerobjectid, 'aad00002-aaaa-4bbb-8ccc-dddddddddddd');
  assert.equal(await worker.evaluate('chrome.action.getBadgeText({})'), 'AS');
  step('impersonation adds the CallerObjectId header and a badge');

  popup = await openPopup();
  assert.equal(await popup.$eval('.banner span', (e) => e.textContent), 'Acting as Grace Hopper');
  const reloadedAgain = page.waitForNavigation();
  await popup.click('.banner button');
  await Promise.all([closed(popup), reloadedAgain]);
  assert.equal((await worker.evaluate('chrome.declarativeNetRequest.getSessionRules()')).length, 0);
  assert.equal((await headers()).callerobjectid, undefined);
  assert.equal(await worker.evaluate('chrome.action.getBadgeText({})'), '');
  step('stopping impersonation removes the rule and the badge');

  const nav = page.waitForNavigation();
  await closed(await runFromPalette('forms monitor'));
  await nav;
  assert.equal(new URL(page.url()).searchParams.get('monitor'), 'true');
  popup = await openPopup();
  assert.equal(await popup.$eval('.banner span', (e) => e.textContent), 'Debug flags are active on this tab');
  await popup.close();
  step('debug flags reload the tab and show a banner');

  await page.goto(`${origin}/plain`);
  popup = await openPopup();
  assert.equal(await popup.$eval('#env', (e) => e.textContent), 'Not a Dynamics 365 / Power Apps page');
  assert.equal(await popup.$$eval('.cmd:not(.off)', (els) => els.length), 0);
  await popup.close();
  step('non-Dynamics pages disable every command');

  await wait(200);
  assert.deepEqual(errors, [], 'no uncaught error in the page or the popup');
  step('no uncaught errors');
} catch (err) {
  failed = true;
  console.error(`\n  ✖ after "${steps.at(-1) || 'start'}":`, err);
} finally {
  await browser.close();
  server.close();
  await rm(extDir, { recursive: true, force: true }).catch(() => {});
}
console.log(failed ? '\nE2E FAILED' : `\nE2E passed (${steps.length} steps)`);
process.exit(failed ? 1 : 0);
