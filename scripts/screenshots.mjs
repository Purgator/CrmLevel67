// Regenerates the README screenshots in docs/ from the preview environment.
// Start `npm run preview` first, then run `node scripts/screenshots.mjs`.
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import puppeteer from 'puppeteer';

const docs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const url = `http://localhost:${process.env.PORT || 6767}/`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await mkdir(docs, { recursive: true });

const browser = await puppeteer.launch();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1360, height: 780, deviceScaleFactor: 1.5 });
  const load = async (scheme) => {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    await page.goto(url);
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.reload();
    const frame = await (await page.waitForSelector('#popup')).contentFrame();
    await frame.waitForSelector('#env.on');
    return frame;
  };
  const popupClip = async () => {
    const box = await (await page.$('#popup')).boundingBox();
    return { x: box.x - 14, y: box.y - 14, width: box.width + 28, height: box.height + 28 };
  };

  // 1. The palette next to a record, logical names shown.
  let popup = await load('dark');
  await page.evaluate(() => window.__level67.run('logical-names', {}, { theme: 'dark' }));
  await popup.type('.search input', 'fie');
  await wait(300);
  await page.screenshot({ path: path.join(docs, 'palette.png') });

  // 2. The side panel.
  popup = await load('dark');
  await page.evaluate(() => window.__level67.run('all-fields', {}, { theme: 'dark' }));
  await wait(400);
  await page.screenshot({ path: path.join(docs, 'panel.png') });

  // 3. The popup alone, light theme.
  popup = await load('light');
  await wait(300);
  await page.screenshot({ path: path.join(docs, 'popup-light.png'), clip: await popupClip() });

  // 4. Impersonation picker, dark theme.
  popup = await load('dark');
  await popup.type('.search input', 'impersonate');
  await page.keyboard.press('Enter');
  await popup.waitForSelector('.user');
  await wait(300);
  await page.screenshot({ path: path.join(docs, 'impersonate.png'), clip: await popupClip() });
  // 5. Settings, light theme.
  popup = await load('light');
  await popup.click('#settings');
  await wait(300);
  await page.screenshot({ path: path.join(docs, 'settings.png'), clip: await popupClip() });
  console.log('screenshots written to docs/');
} finally {
  await browser.close();
}
