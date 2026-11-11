// A small fake of the Dynamics 365 client API (Xrm) and Dataverse Web API.
// Used by the unit tests (inside a node:vm sandbox) and by `npm run preview`
// (in a real browser page), so Level 67 can be developed without an org.
// It only touches `window`, so both hosts can run it unchanged.
(() => {
  'use strict';
  const RECORD_ID = 'a1b2c3d4-0000-4000-8000-000000000067';
  const USER_ID = '11111111-2222-4333-8444-555555555555';
  const log = [];
  const changed = () => { if (typeof window.__mockChanged === 'function') window.__mockChanged(); };
  const note = (text) => { log.push(text); changed(); };

  const collection = (items) => ({
    forEach: (fn) => items.forEach(fn),
    get: (key) => (key === undefined ? items.slice() : typeof key === 'number' ? items[key] : items.find((i) => i.getName() === key) || null),
    getLength: () => items.length,
  });

  function makeAttribute(def) {
    let value = def.value === undefined ? null : def.value;
    let dirty = false;
    let required = def.required || 'none';
    const controls = [];
    const a = {
      getName: () => def.name,
      getAttributeType: () => def.type,
      getValue: () => value,
      setValue: (v) => { value = v; dirty = true; changed(); },
      getIsDirty: () => dirty,
      getRequiredLevel: () => required,
      setRequiredLevel: (level) => { required = level; changed(); },
      getFormat: () => def.format || null,
      getMaxLength: () => def.maxLength || 100,
      getMin: () => (def.min === undefined ? 0 : def.min),
      getMax: () => (def.max === undefined ? 1000000 : def.max),
      controls: collection(controls),
      _controls: controls,
      _reset: () => { dirty = false; },
    };
    if (def.options) a.getOptions = () => def.options.map(([v, text]) => ({ value: v, text }));
    return a;
  }

  function makeControl(def, attribute) {
    let label = def.label;
    let visible = def.visible !== false;
    let disabled = !!def.disabled;
    const c = {
      getName: () => def.name,
      getLabel: () => label,
      setLabel: (l) => { label = l; changed(); },
      getVisible: () => visible,
      setVisible: (v) => { visible = v; changed(); },
      getDisabled: () => disabled,
      setDisabled: (d) => { disabled = d; changed(); },
      getControlType: () => def.controlType || 'standard',
      getAttribute: () => attribute || null,
    };
    if (def.controlType === 'subgrid') c.refresh = () => note(`subgrid ${def.name} refreshed`);
    return c;
  }

  const FIELDS = [
    { name: 'name', label: 'Account Name', type: 'string', value: 'Contoso Ltd', required: 'required' },
    { name: 'telephone1', label: 'Main Phone', type: 'string', value: '+33 1 23 45 67 89' },
    { name: 'emailaddress1', label: 'Email', type: 'string', format: 'email', required: 'required' },
    { name: 'websiteurl', label: 'Website', type: 'string', format: 'url', value: 'https://contoso.example' },
    { name: 'revenue', label: 'Annual Revenue', type: 'money', value: 1500000 },
    { name: 'numberofemployees', label: 'Employees', type: 'integer', required: 'required', min: 1 },
    { name: 'industrycode', label: 'Industry', type: 'optionset', value: 7, options: [[1, 'Accounting'], [7, 'Consulting'], [33, 'Transportation']] },
    { name: 'customertypecode', label: 'Relationship Type', type: 'optionset', required: 'required', options: [[1, 'Competitor'], [3, 'Customer'], [8, 'Partner']] },
    { name: 'donotemail', label: 'Do not allow Emails', type: 'boolean', value: false },
    { name: 'lastonholdtime', label: 'Last On Hold Time', type: 'datetime', value: new Date(Date.UTC(2026, 8, 14, 9, 30)) },
    { name: 'primarycontactid', label: 'Primary Contact', type: 'lookup', value: [{ id: '{C0FFEE00-1111-4222-8333-444444444444}', name: 'Ada Lovelace', entityType: 'contact' }] },
    { name: 'parentaccountid', label: 'Parent Account', type: 'lookup', required: 'required' },
    { name: 'creditlimit', label: 'Credit Limit', type: 'money', value: 50000, visible: false },
    { name: 'accountnumber', label: 'Account Number', type: 'string', value: 'ACC-0067', disabled: true },
    { name: 'description', label: 'Description', type: 'memo', value: 'Key account since 2019.' },
    { name: 'ownerid', label: 'Owner', type: 'owner', value: [{ id: `{${USER_ID.toUpperCase()}}`, name: 'Sam Admin', entityType: 'systemuser' }] },
    { name: 'statecode', label: 'Status', type: 'optionset', value: 0, options: [[0, 'Active'], [1, 'Inactive']] },
  ];

  function makeForm(mode) {
    const attributes = FIELDS.map((f) => makeAttribute(mode === 'new' && !['ownerid', 'statecode'].includes(f.name) ? { ...f, value: undefined } : f));
    const controls = FIELDS.map((f, i) => {
      const c = makeControl(f, attributes[i]);
      attributes[i]._controls.push(c);
      return c;
    });
    controls.push(makeControl({ name: 'Contacts', label: 'Contacts', controlType: 'subgrid' }));
    controls.push(makeControl({ name: 'Opportunities', label: 'Opportunities', controlType: 'subgrid' }));
    const section = (name, label, visible = true) => {
      let v = visible; let l = label;
      return { getName: () => name, getLabel: () => l, setLabel: (x) => { l = x; changed(); }, getVisible: () => v, setVisible: (x) => { v = x; changed(); } };
    };
    const tab = (name, label, sections, visible = true) => {
      let v = visible; let l = label;
      return { getName: () => name, getLabel: () => l, setLabel: (x) => { l = x; changed(); }, getVisible: () => v, setVisible: (x) => { v = x; changed(); },
        sections: collection(sections) };
    };
    return {
      data: {
        entity: {
          getEntityName: () => 'account',
          getId: () => (mode === 'new' ? '' : `{${RECORD_ID.toUpperCase()}}`),
          getPrimaryAttributeValue: () => attributes[0].getValue(),
          attributes: collection(attributes),
        },
        refresh: () => { attributes.forEach((a) => a._reset()); note('form data refreshed'); return Promise.resolve(); },
      },
      ui: {
        controls: collection(controls),
        tabs: collection([
          tab('SUMMARY_TAB', 'Summary', [section('ACCOUNT_INFORMATION', 'Account Information'), section('ADDRESS', 'Address')]),
          tab('DETAILS_TAB', 'Details', [section('COMPANY_PROFILE', 'Company Profile'), section('BILLING', 'Billing', false)]),
          tab('ADMIN_TAB', 'Administration', [section('ADMIN', 'Admin')], false),
        ]),
        formSelector: { getCurrentItem: () => ({ getId: () => '8448B78F-8F42-454E-8E2A-F8196B0419AF', getLabel: () => 'Account' }) },
        getFormType: () => (mode === 'new' ? 1 : 2),
      },
    };
  }

  const globalContext = {
    getClientUrl: () => window.location.origin,
    getVersion: () => '9.2.26103.165',
    getCurrentAppProperties: () => Promise.resolve({ appId: '99999999-aaaa-4bbb-8ccc-dddddddddddd', displayName: 'Sales Hub', uniqueName: 'msdyn_saleshub' }),
    client: { getClient: () => 'Web', getFormFactor: () => 1 },
    organizationSettings: {
      uniqueName: 'contoso-dev', organizationId: '{0A0B0C0D-1111-4222-8333-0E0F0A0B0C0D}', bapEnvironmentId: 'e1e2e3e4-5555-4666-8777-888888888888',
      languageId: 1033, isAutoSaveEnabled: true, organizationGeo: 'EUR', baseCurrency: { name: 'Euro' },
    },
    userSettings: {
      userId: `{${USER_ID.toUpperCase()}}`, userName: 'Sam Admin', languageId: 1036,
      roles: { get: () => [{ id: 'r1', name: 'System Administrator' }, { id: 'r2', name: 'Salesperson' }] },
    },
  };

  const Xrm = {
    Page: makeForm('record'),
    Utility: { getGlobalContext: () => globalContext },
    Navigation: {
      openForm: (options, params) => { note(`openForm ${JSON.stringify(options)}${params ? ` ${JSON.stringify(params)}` : ''}`); return Promise.resolve({}); },
      navigateTo: (page) => {
        if (page.entityName === 'nope') return Promise.reject(new Error("Entity 'nope' does not exist."));
        note(`navigateTo ${JSON.stringify(page)}`);
        return Promise.resolve();
      },
    },
  };

  // ── Fake Web API ──────────────────────────────────────────────────────────
  const FV = '@OData.Community.Display.V1.FormattedValue';
  const LK = '@Microsoft.Dynamics.CRM.lookuplogicalname';
  const RECORD = {
    '@odata.context': 'mock', accountid: RECORD_ID, name: 'Contoso Ltd', telephone1: '+33 1 23 45 67 89', emailaddress1: null,
    revenue: 1500000, [`revenue${FV}`]: '€1,500,000.00', industrycode: 7, [`industrycode${FV}`]: 'Consulting',
    createdon: '2024-03-02T08:15:00Z', [`createdon${FV}`]: '3/2/2024 9:15 AM', modifiedon: '2026-11-10T16:42:00Z', [`modifiedon${FV}`]: '11/10/2026 5:42 PM',
    _createdby_value: USER_ID, [`_createdby_value${FV}`]: 'Sam Admin', [`_createdby_value${LK}`]: 'systemuser',
    _modifiedby_value: USER_ID, [`_modifiedby_value${FV}`]: 'Sam Admin', [`_modifiedby_value${LK}`]: 'systemuser',
    _ownerid_value: USER_ID, [`_ownerid_value${FV}`]: 'Sam Admin', [`_ownerid_value${LK}`]: 'systemuser',
    _owningbusinessunit_value: 'b0b0b0b0-0000-4000-8000-000000000001', [`_owningbusinessunit_value${FV}`]: 'Contoso HQ', [`_owningbusinessunit_value${LK}`]: 'businessunit',
    _primarycontactid_value: 'c0ffee00-1111-4222-8333-444444444444', [`_primarycontactid_value${FV}`]: 'Ada Lovelace', [`_primarycontactid_value${LK}`]: 'contact',
    statecode: 0, [`statecode${FV}`]: 'Active', statuscode: 1, [`statuscode${FV}`]: 'Active', versionnumber: 4815162342,
  };
  const ENTITIES = [['account', 'Account', 'accounts'], ['contact', 'Contact', 'contacts'], ['lead', 'Lead', 'leads'], ['opportunity', 'Opportunity', 'opportunities'],
    ['incident', 'Case', 'incidents'], ['systemuser', 'User', 'systemusers'], ['team', 'Team', 'teams'], ['new_project', 'Project', 'new_projects'],
    ['new_projecttask', 'Project Task', 'new_projecttasks'], ['email', 'Email', 'emails'], ['task', 'Task', 'tasks'], ['workflow', 'Process', 'workflows']];
  const USERS = [['Sam Admin', 'sam@contoso.example'], ['Ada Lovelace', 'ada@contoso.example'], ['Grace Hopper', 'grace@contoso.example'],
    ['Alan Turing', 'alan@contoso.example'], ['Margaret Hamilton', 'margaret@contoso.example']]
    .map(([fullname, internalemailaddress], i) => ({ fullname, internalemailaddress, systemuserid: i ? `0000000${i}-aaaa-4bbb-8ccc-dddddddddddd` : USER_ID,
      azureactivedirectoryobjectid: `aad0000${i}-aaaa-4bbb-8ccc-dddddddddddd` }));
  const label = (text) => ({ UserLocalizedLabel: { Label: text } });

  function route(path) {
    const [resource, query = ''] = path.split('?');
    const q = decodeURIComponent(query);
    let m;
    if (resource === 'WhoAmI') return { UserId: USER_ID, BusinessUnitId: 'b0b0b0b0-0000-4000-8000-000000000001', OrganizationId: '0a0b0c0d-1111-4222-8333-0e0f0a0b0c0d' };
    if (resource === 'EntityDefinitions') return { value: ENTITIES.map(([n, l, s]) => ({ LogicalName: n, DisplayName: label(l), EntitySetName: s })) };
    if ((m = /^EntityDefinitions\(LogicalName='(\w+)'\)(\/Attributes)?$/.exec(resource))) {
      const entity = ENTITIES.find((e) => e[0] === m[1]);
      if (!entity) return null;
      if (!m[2]) return { LogicalName: entity[0], EntitySetName: entity[2], PrimaryNameAttribute: 'name' };
      return { value: [
        ...FIELDS.map((f) => ({ LogicalName: f.name, SchemaName: f.name[0].toUpperCase() + f.name.slice(1), DisplayName: label(f.label),
          AttributeType: f.type[0].toUpperCase() + f.type.slice(1), RequiredLevel: { Value: f.required === 'required' ? 'ApplicationRequired' : 'None' },
          IsCustomAttribute: false, AttributeOf: null })),
        { LogicalName: 'new_score', SchemaName: 'new_Score', DisplayName: label('Score'), AttributeType: 'Integer', RequiredLevel: { Value: 'Recommended' }, IsCustomAttribute: true, AttributeOf: null },
        { LogicalName: 'primarycontactidname', SchemaName: 'PrimaryContactIdName', DisplayName: {}, AttributeType: 'String', RequiredLevel: { Value: 'None' }, IsCustomAttribute: false, AttributeOf: 'primarycontactid' },
      ] };
    }
    if (resource === `accounts(${RECORD_ID})`) return RECORD;
    if (resource === 'accounts') return { value: [{ accountid: RECORD_ID, name: 'Contoso Ltd' }, { accountid: 'a1b2c3d4-0000-4000-8000-000000000068', name: 'Fabrikam Inc' }] };
    if (resource === 'workflows') return { value: [
      { name: 'Account: notify owner', category: 0, statecode: 1, mode: 0, workflowid: 'f0000000-0000-4000-8000-000000000001' },
      { name: 'Account: validate VAT', category: 0, statecode: 0, mode: 1, workflowid: 'f0000000-0000-4000-8000-000000000002' },
      { name: 'Lock credit limit', category: 2, statecode: 1, mode: 1, workflowid: 'f0000000-0000-4000-8000-000000000003' },
      { name: 'Onboarding', category: 4, statecode: 1, mode: 0, workflowid: 'f0000000-0000-4000-8000-000000000004' },
    ] };
    if (resource === `systemusers(${USER_ID})`) return { fullname: 'Sam Admin', systemuserid: USER_ID,
      systemuserroles_association: [{ name: 'System Administrator', roleid: 'd0000000-0000-4000-8000-000000000001' }, { name: 'Salesperson', roleid: 'd0000000-0000-4000-8000-000000000002' }],
      teammembership_association: [{ name: 'Contoso HQ', teamid: 'e0000000-0000-4000-8000-000000000001' }] };
    if (resource === 'systemusers') {
      const needle = ((/contains\(fullname,'(.*?)'\)/.exec(q) || [])[1] || '').replace(/''/g, "'").toLowerCase();
      return { value: USERS.filter((u) => !needle || u.fullname.toLowerCase().includes(needle) || u.internalemailaddress.includes(needle)) };
    }
    if (resource.startsWith('RetrieveTotalRecordCount')) {
      const names = JSON.parse((/@p=(.*)$/.exec(q) || [])[1] || '[]');
      const known = names.filter((n) => ENTITIES.some((e) => e[0] === n));
      return { EntityRecordCountCollection: { Count: known.length, Keys: known, Values: known.map(() => 12345) } };
    }
    return null;
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : input.url);
    const at = url.indexOf('/api/data/');
    if (at === -1) return realFetch(input, init);
    const path = url.slice(url.indexOf('/', at + 10) + 1);
    const body = route(path);
    // Hosts that can tell who is impersonated (preview, end-to-end tests) answer WhoAmI as that user.
    if (path === 'WhoAmI' && typeof window.__mock.effectiveUser === 'function') body.UserId = (await window.__mock.effectiveUser()) || body.UserId;
    const json = body || { error: { code: '0x80060888', message: `Resource not found for the segment '${url.split('/').pop().split('?')[0]}'.` } };
    return { ok: !!body, status: body ? 200 : 404, json: async () => json };
  };

  window.Xrm = Xrm;
  window.__mock = {
    log, RECORD_ID, USER_ID, USERS, realFetch,
    // 'record' = saved record form, 'new' = unsaved create form, 'list' = no form at all
    setMode(mode) { Xrm.Page = mode === 'list' ? { data: null, ui: null } : makeForm(mode); changed(); },
  };
})();
