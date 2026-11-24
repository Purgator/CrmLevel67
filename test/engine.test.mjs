import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPage, fakeElement } from './helpers.mjs';

const ID = 'a1b2c3d4-0000-4000-8000-000000000067';
const plain = (v) => JSON.parse(JSON.stringify(v)); // strip the vm realm's prototypes
const attr = (page, name) => page.xrm.Page.data.entity.attributes.get(name);
const control = (page, name) => page.xrm.Page.ui.controls.get(name);
const ok = async (page, id, args) => {
  const res = await page.run(id, args);
  assert.equal(res.ok, true, `${id} failed: ${res.error}`);
  return res;
};

test('context describes a saved record', () => {
  const ctx = createPage().engine.context();
  assert.deepEqual(JSON.parse(JSON.stringify(ctx)), {
    dynamics: true, origin: 'https://contoso.crm4.dynamics.com', org: 'contoso-dev', version: '9.2.26103.165', userName: 'Sam Admin',
    form: true, saved: true, entity: 'account', recordId: ID, recordName: 'Contoso Ltd', flags: false, classic: false,
  });
});

test('context on a list page, a new record and a non-Dynamics page', () => {
  const page = createPage();
  page.mock.setMode('list');
  assert.partialDeepStrictEqual(page.engine.context(), { dynamics: true, form: false, saved: false, entity: '' });
  page.mock.setMode('new');
  assert.partialDeepStrictEqual(page.engine.context(), { dynamics: true, form: true, saved: false, recordId: '' });
  assert.deepEqual({ ...createPage({ mock: false }).engine.context() }, { dynamics: false });
});

test('commands fail cleanly outside Dynamics and for unknown ids', async () => {
  const res = await createPage({ mock: false }).run('god-mode');
  assert.equal(res.ok, false);
  assert.match(res.error, /not a Dynamics 365/);
  assert.match((await createPage().run('constructor')).error, /Unknown command/);
});

test('form commands explain themselves when no record is open or saved', async () => {
  const page = createPage();
  page.mock.setMode('list');
  assert.match((await page.run('god-mode')).error, /Open a record form/);
  page.mock.setMode('new');
  assert.match((await page.run('copy-record-id')).error, /not been saved/);
  assert.match((await page.run('all-fields')).error, /not been saved/);
});

test('logical names are drawn as chips under the field labels', async () => {
  const page = createPage({ fieldLabels: true });
  const res = await ok(page, 'logical-names');
  assert.match(res.toast, /shown on \d+ fields/);
  const [sheet] = page.window.document.adoptedStyleSheets;
  assert.ok(sheet.css.includes('[id$="name-field-label"]::after, [id="name_c"]::after { content: "name"; }'), 'one rule covers both clients');
  assert.ok(sheet.css.indexOf('"name-field-label"') < sheet.css.indexOf('"accountnumber-field-label"'), 'shorter names first, so the longer rule wins');
  assert.equal(control(page, 'name').getLabel(), 'Account Name', 'field labels themselves are left alone');
  assert.equal(page.xrm.Page.ui.tabs.get(0).getLabel(), 'Summary ⟨SUMMARY_TAB⟩');
  // Clicking a label copies its logical name.
  const [onClick] = [...page.listeners];
  onClick({ target: { closest: () => ({ id: 'id-1-accountnumber-field-label' }) } });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(page.copied, ['accountnumber']);
  assert.match(page.toasts.at(-1).message, /Copied: accountnumber/);
  assert.match((await ok(page, 'logical-names')).toast, /hidden/);
  assert.equal(page.window.document.adoptedStyleSheets.length, 0);
  assert.equal(page.listeners.size, 0);
  assert.equal(page.xrm.Page.ui.tabs.get(0).getLabel(), 'Summary');
});

test('logical names fall back to the labels on an unknown layout', async () => {
  const page = createPage();
  await ok(page, 'logical-names');
  assert.equal(control(page, 'name').getLabel(), 'Account Name ⟨name⟩');
  assert.equal(page.xrm.Page.ui.tabs.get(0).getLabel(), 'Summary ⟨SUMMARY_TAB⟩');
  assert.equal(page.xrm.Page.ui.tabs.get(0).sections.get(0).getLabel(), 'Account Information ⟨ACCOUNT_INFORMATION⟩');
  const res = await ok(page, 'logical-names');
  assert.match(res.toast, /hidden/);
  assert.equal(control(page, 'name').getLabel(), 'Account Name');
  assert.equal(page.xrm.Page.ui.tabs.get(0).getLabel(), 'Summary');
});

test('god mode shows, unlocks and un-requires everything', async () => {
  const page = createPage();
  const res = await ok(page, 'god-mode');
  assert.equal(control(page, 'creditlimit').getVisible(), true);
  assert.equal(control(page, 'accountnumber').getDisabled(), false);
  assert.equal(attr(page, 'name').getRequiredLevel(), 'none');
  assert.equal(page.xrm.Page.ui.tabs.get(2).getVisible(), true);
  assert.equal(page.xrm.Page.ui.tabs.get(1).sections.get(1).getVisible(), true);
  assert.match(res.toast, /\d+ restrictions lifted/);
  assert.match((await ok(page, 'god-mode')).toast, /Nothing was hidden/);
});

test('changed fields lists dirty attributes only', async () => {
  const page = createPage();
  assert.match((await ok(page, 'changed-fields')).toast, /No unsaved changes/);
  attr(page, 'telephone1').setValue('0102030405');
  await ok(page, 'changed-fields');
  const rows = page.panels.at(-1).sections[0].rows;
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0][0], rows[0][1].text, rows[0][2]], ['Main Phone', 'telephone1', '0102030405']);
});

test('fill required fields respects types and skips lookups', async () => {
  const page = createPage();
  const res = await ok(page, 'fill-required');
  assert.equal(attr(page, 'emailaddress1').getValue(), 'level67@example.com');
  assert.equal(attr(page, 'numberofemployees').getValue(), 1); // min is 1
  assert.equal(attr(page, 'customertypecode').getValue(), 1);
  assert.equal(attr(page, 'parentaccountid').getValue(), null);
  assert.equal(attr(page, 'name').getValue(), 'Contoso Ltd'); // already filled: untouched
  assert.equal(res.toast, '3 required fields filled, 1 left for you (lookups)');
});

test('copy id and url', async () => {
  const page = createPage();
  assert.equal((await ok(page, 'copy-record-id')).copy, ID);
  assert.equal((await ok(page, 'copy-record-url')).copy,
    `https://contoso.crm4.dynamics.com/main.aspx?appid=abc123&pagetype=entityrecord&etn=account&id=${ID}`);
});

test('open record in Web API resolves the entity set', async () => {
  assert.equal((await ok(createPage(), 'open-web-api')).open, `https://contoso.crm4.dynamics.com/api/data/v9.2/accounts(${ID})`);
});

test('all fields shows values, formatted values and lookup targets', async () => {
  const page = createPage();
  await ok(page, 'all-fields');
  const spec = page.panels.at(-1);
  const rows = Object.fromEntries(spec.sections[0].rows.map((r) => [r[0].text, r]));
  assert.equal(rows.revenue[1].text, 1500000);
  assert.equal(rows.revenue[2], '€1,500,000.00');
  assert.equal(rows.primarycontactid[2], 'Ada Lovelace (contact)');
  assert.equal(rows.emailaddress1[1].text, 'null');
  assert.ok(!Object.keys(rows).some((k) => k.includes('@')), 'annotations are folded into their column');
  assert.equal(spec.json.accountid, ID);
});

test('record properties', async () => {
  const page = createPage();
  await ok(page, 'record-properties');
  const [record, form] = page.panels.at(-1).sections;
  const map = Object.fromEntries(record.rows.map(([k, v]) => [k, typeof v === 'object' ? v.text : v]));
  assert.equal(map['Created by'], 'Sam Admin');
  assert.equal(map.Status, 'Active (0)');
  assert.equal(map['Record ID'], ID);
  assert.deepEqual(plain(form.rows.map((r) => r[0])), ['Form name', 'Form ID', 'Form type']);
  assert.equal(form.rows[2][1], 'Update (2)');
});

test('choice values marks the selected option', async () => {
  const page = createPage();
  await ok(page, 'optionset-values');
  const industry = page.panels.at(-1).sections.find((s) => s.title === 'Industry · industrycode');
  assert.deepEqual(plain(industry.rows.map((r) => [r[0].text, r[1], r[2] && r[2].text])), [[1, 'Accounting', ''], [7, 'Consulting', 'selected'], [33, 'Transportation', '']]);
});

test('clone record passes values and lookups as form parameters', async () => {
  const page = createPage();
  await ok(page, 'clone-record');
  const call = page.mock.log.at(-1);
  assert.ok(call.startsWith('openForm {"entityName":"account"} '));
  const params = JSON.parse(call.slice(call.indexOf('} ') + 2));
  assert.equal(params.name, 'Contoso Ltd');
  assert.equal(params.industrycode, 7);
  assert.equal(params.primarycontactid, 'c0ffee00-1111-4222-8333-444444444444');
  assert.equal(params.primarycontactidname, 'Ada Lovelace');
  assert.equal(params.primarycontactidtype, 'contact');
  assert.equal(params.lastonholdtime, '2026-09-14T09:30:00.000Z');
  assert.ok(!('ownerid' in params) && !('statecode' in params) && !('emailaddress1' in params));
});

test('refresh subgrids and refresh form', async () => {
  const page = createPage();
  assert.equal((await ok(page, 'refresh-subgrids')).toast, '2 subgrids refreshed');
  attr(page, 'name').setValue('x');
  await ok(page, 'refresh-form');
  assert.equal(attr(page, 'name').getIsDirty(), false);
});

test('blur adds one rule to the page, and removes it again', async () => {
  const page = createPage({ elements: [fakeElement(), fakeElement(), fakeElement()] });
  assert.equal((await ok(page, 'blur-data')).toast, '3 values blurred. Run again to remove.');
  const [sheet] = page.window.document.adoptedStyleSheets;
  assert.match(sheet.css, /\.ms-crm-Inline-Value.*\{ filter: blur\(5px\) !important; \}/);
  assert.equal((await ok(page, 'blur-data')).toast, 'Blur removed');
  assert.equal(page.window.document.adoptedStyleSheets.length, 0);
});

test('blur says so when the page shows nothing to blur', async () => {
  const page = createPage();
  const res = await ok(page, 'blur-data');
  assert.equal(res.kind, 'info');
  assert.match(res.toast, /no value yet/);
});

test('whoAmI reports the user the server answers as', async () => {
  const page = createPage();
  assert.deepEqual(plain(await page.engine.whoAmI()), { ok: true, userId: page.mock.USER_ID, pageUserId: page.mock.USER_ID });
  page.mock.effectiveUser = () => page.mock.USERS[2].systemuserid; // impersonating Grace
  assert.equal((await page.engine.whoAmI()).userId, page.mock.USERS[2].systemuserid);
  await ok(page, 'my-profile');
  assert.match(page.mock.log.at(-1), new RegExp(`^openForm \\{"entityName":"systemuser","entityId":"${page.mock.USERS[2].systemuserid}"`));
});

test('table processes are grouped by kind', async () => {
  const page = createPage();
  await ok(page, 'table-processes');
  const spec = page.panels.at(-1);
  assert.deepEqual(plain(spec.sections.map((s) => [s.title, s.rows.length])), [['Business process flows', 1], ['Business rules', 1], ['Workflows', 2]]);
  assert.deepEqual(plain(spec.sections[2].rows[1].slice(0, 3).map((c) => c.text || c)), ['Account: validate VAT', 'Draft', 'Real-time']);
});

test('table columns hides virtual name columns', async () => {
  const page = createPage();
  await ok(page, 'table-metadata');
  const names = page.panels.at(-1).sections[0].rows.map((r) => r[1].text);
  assert.ok(names.includes('new_score') && !names.includes('primarycontactidname'));
  assert.deepEqual(plain(names), [...names].sort());
});

test('form editor targets the maker portal', async () => {
  assert.equal((await ok(createPage(), 'form-editor')).open,
    'https://make.powerapps.com/e/e1e2e3e4-5555-4666-8777-888888888888/s/fd140aaf-4df4-11dd-bd17-0019b9312238/entity/account/form/edit/8448b78f-8f42-454e-8e2a-f8196b0419af?source=powerappsportal');
});

test('navigation commands validate input', async () => {
  const page = createPage();
  assert.match((await page.run('open-by-id', { entity: 'account', id: 'nope' })).error, /not a valid record ID/);
  assert.match((await page.run('open-by-id', { entity: "acc'ount", id: ID })).error, /logical name/);
  assert.match((await page.run('new-record', {})).error, /logical name/);
  await ok(page, 'open-by-id', { entity: ' Account ', id: `{${ID.toUpperCase()}}` });
  assert.equal(page.mock.log.at(-1), `openForm {"entityName":"account","entityId":"${ID}"}`);
  await ok(page, 'new-record', { entity: 'contact' });
  assert.equal(page.mock.log.at(-1), 'openForm {"entityName":"contact"}');
  await ok(page, 'open-list', { entity: 'lead' });
  assert.equal(page.mock.log.at(-1), 'navigateTo {"pageType":"entitylist","entityName":"lead"}');
  assert.match((await page.run('open-list', { entity: 'nope' })).error, /does not exist/);
});

test('open by id can pick a random record', async () => {
  const page = createPage();
  const res = await ok(page, 'open-by-id', { entity: 'account', mode: 'random' });
  assert.match(page.mock.log.at(-1), /^openForm \{"entityName":"account","entityId":"(a1b2c3d4-0000-4000-8000-00000000006[78])"\}$/);
  assert.match(res.toast, /random account/);
  assert.match((await page.run('open-by-id', { entity: 'nope', mode: 'random' })).error, /./);
});

test('open by id takes a list of ids separated by commas or lines', async () => {
  const page = createPage();
  const other = 'a1b2c3d4-0000-4000-8000-000000000068';
  const res = await ok(page, 'open-by-id', { entity: 'account', mode: 'many', ids: `${ID},\n{${other.toUpperCase()}} ; ${ID}` });
  assert.deepEqual(plain(res.open), ['ID', 'other'].map((k) => `https://contoso.crm4.dynamics.com/main.aspx?appid=abc123&pagetype=entityrecord&etn=account&id=${k === 'ID' ? ID : other}`));
  assert.match((await page.run('open-by-id', { entity: 'account', mode: 'many', ids: `${ID}, nope` })).error, /Not a valid GUID: nope/);
  assert.match((await page.run('open-by-id', { entity: 'account', mode: 'many', ids: ' ' })).error, /at least one/);
  const lines = Array.from({ length: 21 }, (_, i) => `a1b2c3d4-0000-4000-8000-${String(i).padStart(12, '0')}`).join('\n');
  assert.match((await page.run('open-by-id', { entity: 'account', mode: 'many', ids: lines })).error, /at most 20/);
  await ok(page, 'open-by-id', { entity: 'account', mode: 'many', ids: ID }); // a single id opens in place
  assert.equal(page.mock.log.at(-1), `openForm {"entityName":"account","entityId":"${ID}"}`);
});

test('records and lists open as links when the new tab setting is on', async () => {
  const page = createPage();
  const base = 'https://contoso.crm4.dynamics.com/main.aspx?appid=abc123&pagetype=';
  assert.equal((await page.run('open-by-id', { entity: 'account', id: ID }, { openIn: 'new' })).open, `${base}entityrecord&etn=account&id=${ID}`);
  assert.equal((await page.run('open-list', { entity: 'lead' }, { openIn: 'new' })).open, `${base}entitylist&etn=lead`);
  assert.equal((await page.run('new-record', { entity: 'contact' }, { openIn: 'new' })).open, `${base}entityrecord&etn=contact`);
  const before = page.mock.log.length;
  await page.run('list-users', {}, { openIn: 'current' });
  assert.equal(page.mock.log.length, before + 1);
});

test('admin shortcuts open the right tables', async () => {
  const page = createPage();
  const expected = { 'list-users': 'systemuser', 'list-teams': 'team', 'list-roles': 'role', 'list-business-units': 'businessunit',
    'list-system-jobs': 'asyncoperation', 'list-plugin-traces': 'plugintracelog', 'list-processes': 'workflow',
    'list-env-variables': 'environmentvariabledefinition', 'list-web-resources': 'webresource', 'list-mailboxes': 'mailbox',
    'list-solution-history': 'msdyn_solutionhistory' };
  for (const [id, entity] of Object.entries(expected)) {
    await ok(page, id);
    assert.equal(page.mock.log.at(-1), `navigateTo {"pageType":"entitylist","entityName":"${entity}"}`);
  }
  await ok(page, 'my-profile');
  assert.equal(page.mock.log.at(-1), 'openForm {"entityName":"systemuser","entityId":"11111111-2222-4333-8444-555555555555"}');
});

test('link commands build environment-aware URLs', async () => {
  const page = createPage();
  const env = 'e1e2e3e4-5555-4666-8777-888888888888';
  const base = 'https://contoso.crm4.dynamics.com';
  const urls = {
    'advanced-find': `${base}/main.aspx?pagetype=advancedfind`,
    'advanced-settings': `${base}/main.aspx?settingsonly=true`,
    'maker-portal': `https://make.powerapps.com/environments/${env}/home`,
    solutions: `https://make.powerapps.com/environments/${env}/solutions`,
    'admin-center': `https://admin.powerplatform.microsoft.com/environments/environment/${env}/hub`,
    'web-api-root': `${base}/api/data/v9.2/`,
    diagnostics: `${base}/tools/diagnostics/diag.aspx`,
  };
  for (const [id, url] of Object.entries(urls)) assert.equal((await ok(page, id)).open, url, id);
});

test('debug flags are merged into the URL and cleared', async () => {
  const flagsOf = (url) => new URL(url).searchParams.get('flags');
  let page = createPage();
  let res = await ok(page, 'disable-handlers');
  assert.equal(flagsOf(res.navigate), 'DisableFormHandlers=true');
  page = createPage({ href: res.navigate });
  assert.equal(page.engine.context().flags, true);
  res = await ok(page, 'dark-mode');
  assert.equal(flagsOf(res.navigate), 'DisableFormHandlers=true,themeOption=darkmode');
  page = createPage({ href: res.navigate });
  res = await ok(page, 'disable-rules'); // same key: replaced, not duplicated
  assert.equal(flagsOf(res.navigate), 'DisableFormHandlers=businessrule,themeOption=darkmode');
  res = await ok(createPage({ href: res.navigate }), 'forms-monitor');
  assert.equal(new URL(res.navigate).searchParams.get('monitor'), 'true');
  res = await ok(createPage({ href: res.navigate }), 'clear-flags');
  const params = new URL(res.navigate).searchParams;
  assert.deepEqual([params.has('flags'), params.has('monitor'), params.get('appid')], [false, false, 'abc123']);
  assert.equal((await ok(createPage(), 'command-checker')).navigate.includes('ribbondebug=true'), true);
  assert.equal((await ok(createPage(), 'perf-center')).navigate.includes('perf=true'), true);
  assert.equal(flagsOf((await ok(createPage(), 'disable-libraries')).navigate), 'DisableFormLibraries=true');
});

test('reload commands navigate the tab', async () => {
  const page = createPage();
  const res = await ok(page, 'forms-monitor');
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(page.navigations, [res.navigate]);
});

test('environment details', async () => {
  const page = createPage();
  await ok(page, 'env-info');
  const spec = page.panels.at(-1);
  assert.deepEqual(plain(spec.sections.map((s) => s.title)), ['Environment', 'User', 'App']);
  const flat = Object.fromEntries(spec.sections.flatMap((s) => s.rows).map(([k, v]) => [k, typeof v === 'object' ? v.text : v]));
  assert.equal(flat.Organization, 'contoso-dev');
  assert.equal(flat['Environment ID'], 'e1e2e3e4-5555-4666-8777-888888888888');
  assert.equal(flat['Security roles'], 'System Administrator, Salesperson');
  assert.equal(flat['App ID'], '99999999-aaaa-4bbb-8ccc-dddddddddddd');
  assert.equal(flat['Form factor'], 'Desktop');
});

test('my roles and teams', async () => {
  const page = createPage();
  await ok(page, 'my-roles');
  const [roles, teams] = page.panels.at(-1).sections;
  assert.deepEqual(plain(roles.rows.map((r) => r[0])), ['Salesperson', 'System Administrator']);
  assert.deepEqual(plain(teams.rows.map((r) => r[0])), ['Contoso HQ']);
});

test('record count', async () => {
  const page = createPage();
  assert.match((await ok(page, 'record-count', { entity: 'account' })).toast, /^12[,.\s  ]?345 rows in account/);
  assert.match((await page.run('record-count', { entity: 'ghost' })).error, /No count available/);
});

test('web api playground runs queries and reports errors', async () => {
  const page = createPage();
  await ok(page, 'api-playground');
  const pg = page.playgrounds.at(-1);
  assert.equal(pg.examples[0], `accounts(${ID})`);
  assert.equal((await pg.run('WhoAmI')).UserId, '11111111-2222-4333-8444-555555555555');
  assert.equal((await pg.run('/accounts?$select=name\n  &$top=5')).value.length, 2);
  await assert.rejects(pg.run('ghosts'), /Resource not found/);
});

test('entities and user search', async () => {
  const page = createPage();
  const entities = await page.engine.entities();
  assert.equal(entities.ok, true);
  assert.deepEqual({ ...entities.list[0] }, { name: 'account', label: 'Account' });
  const users = await page.engine.searchUsers('ada');
  assert.deepEqual(plain(users.users.map((u) => u.name)), ['Ada Lovelace']);
  assert.ok(users.users[0].aad && users.users[0].id);
  assert.equal((await page.engine.searchUsers("o'brien")).ok, true);
  assert.equal((await page.engine.searchUsers('')).users.length, 5);
});

test('run applies the theme and notify shows a toast', async () => {
  const page = createPage();
  await ok(page, 'copy-record-id');
  assert.deepEqual(page.themes, ['dark']);
  page.engine.notify('hello', 'ok', 'light');
  assert.deepEqual(page.toasts, [{ message: 'hello', kind: 'ok' }]);
});

test('legacy web client: the form lives in an iframe', async () => {
  const page = createPage();
  const form = page.xrm.Page;
  page.mock.setMode('list');
  page.window.frames.push({ get Xrm() { throw new Error('cross-origin'); } }, { Xrm: { ...page.xrm, Page: form } });
  assert.partialDeepStrictEqual(page.engine.context(), { form: true, entity: 'account' });
});
