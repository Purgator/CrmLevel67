import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { COMMANDS, CATEGORIES, UI_ICONS } from '../src/shared/commands.js';
import { fuzzyScore, fuzzyRank } from '../src/shared/fuzzy.js';
import { build } from '../scripts/build.mjs';
import { createPage, root } from './helpers.mjs';

test('command ids are unique and well formed', () => {
  const ids = COMMANDS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  const cats = new Set(CATEGORIES.map((c) => c.id));
  for (const c of COMMANDS) {
    assert.match(c.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(cats.has(c.cat), `${c.id}: unknown category ${c.cat}`);
    assert.ok(c.title && c.desc && c.icon, `${c.id}: title, desc and icon are required`);
    assert.ok(c.desc.length <= 54, `${c.id}: description too long for one line (${c.desc.length})`);
    assert.ok([undefined, 'form', 'saved'].includes(c.needs), `${c.id}: bad needs`);
  }
});

test('every command has an engine handler, and the other way round', () => {
  const handlers = new Set(createPage().engine.commands);
  for (const c of COMMANDS) if (!c.view) assert.ok(handlers.has(c.id), `no handler for ${c.id}`);
  const ids = new Set(COMMANDS.map((c) => c.id));
  for (const h of handlers) assert.ok(ids.has(h), `handler ${h} is not in the registry`);
});

test('every icon is in the generated sprite', () => {
  const source = readFileSync(path.join(root, 'src/shared/icons.js'), 'utf8');
  for (const name of [...COMMANDS.map((c) => c.icon), ...UI_ICONS]) assert.ok(source.includes(`"${name}":[`), `icon ${name} missing: run npm run icons`);
});

test('fuzzy scoring', () => {
  assert.equal(fuzzyScore('xyz', 'God mode'), -1);
  assert.ok(fuzzyScore('god', 'God mode') > fuzzyScore('gm', 'God mode'));
  assert.ok(fuzzyScore('gm', 'God mode') > 0);
  assert.ok(fuzzyScore('mode', 'God mode') > fuzzyScore('ode', 'God mode'));
  assert.equal(fuzzyScore('', 'anything'), 0);
});

test('fuzzy ranking finds commands by title, keyword and initials', () => {
  const fields = (c) => [[c.title, 1], [c.keywords, 0.7], [c.desc, 0.5]];
  const top = (q) => fuzzyRank(q, COMMANDS, fields)[0]?.id;
  assert.equal(top('god'), 'god-mode');
  assert.ok(fuzzyRank('guid', COMMANDS, fields).slice(0, 2).some((c) => c.id === 'copy-record-id'));
  assert.equal(top('imperso'), 'impersonate');
  assert.equal(top('plugin'), 'list-plugin-traces');
  assert.equal(top('logical'), 'logical-names');
  assert.equal(top('wap'), 'api-playground');
  assert.equal(fuzzyRank('zzzzqq', COMMANDS, fields).length, 0);
  assert.equal(fuzzyRank('  ', COMMANDS, fields).length, COMMANDS.length);
});

test('build produces a valid package per browser', async () => {
  const out = await build();
  assert.deepEqual(out.map((o) => o.target), ['chrome', 'firefox']);
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const { target, dir, file } of out) {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.version, pkg.version);
    assert.ok(manifest.description.length <= 132, 'Chrome Web Store limit');
    const refs = [manifest.action.default_popup, ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
      manifest.background.service_worker, ...(manifest.background.scripts || []), 'page/ui.js', 'page/engine.js'].filter(Boolean);
    for (const ref of refs) assert.ok(existsSync(path.join(dir, ref)), `${target}: ${ref} missing`);
    assert.ok(!existsSync(path.join(dir, 'icons/icon.svg')));
    if (target === 'chrome') {
      assert.equal(manifest.background.service_worker, 'background.js');
      assert.equal(manifest.browser_specific_settings, undefined);
    } else {
      assert.deepEqual(manifest.background.scripts, ['background.js']);
      assert.equal(manifest.background.service_worker, undefined);
      assert.ok(manifest.browser_specific_settings.gecko.id);
    }
    const zip = readFileSync(file);
    assert.equal(zip.readUInt32LE(0), 0x04034b50, 'local file header');
    const end = zip.subarray(zip.length - 22);
    assert.equal(end.readUInt32LE(0), 0x06054b50, 'end of central directory');
    assert.equal(end.readUInt16LE(10), out.find((o) => o.target === target).files);
    assert.ok(zip.includes(Buffer.from('popup/popup.html')) && !zip.includes(Buffer.from('popup\\popup.html')), 'entries use forward slashes');
  }
});
