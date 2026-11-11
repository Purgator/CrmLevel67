// Command registry: the single source of truth for what the palette offers.
// Each command id maps to a handler of the same name in src/page/engine.js.
//
//   needs: 'form'  -> a record form must be open
//          'saved' -> the open record must already exist (has an id)
//   input: fields the popup asks for before running ('entity' | 'guid' | 'text')
//   view:  a dedicated popup screen instead of a direct run ('impersonate')

export const CATEGORIES = [
  { id: 'record', label: 'Record' },
  { id: 'navigate', label: 'Navigate' },
  { id: 'admin', label: 'Admin' },
  { id: 'debug', label: 'Debug' },
  { id: 'tools', label: 'Tools' },
];

const ENTITY = { name: 'entity', type: 'entity', label: 'Table', placeholder: 'account, contact, new_project…' };

export const COMMANDS = [
  // ── Record ────────────────────────────────────────────────────────────
  { id: 'logical-names', cat: 'record', icon: 'tags', needs: 'form', title: 'Show logical names',
    desc: 'Toggle schema names on fields, tabs and sections', keywords: 'schema name label attribute' },
  { id: 'god-mode', cat: 'record', icon: 'crown', needs: 'form', title: 'God mode',
    desc: 'Show hidden fields, unlock locked ones, lift required', keywords: 'unlock visible editable hidden enable' },
  { id: 'changed-fields', cat: 'record', icon: 'pencil-line', needs: 'form', title: 'Changed fields',
    desc: 'List every field with unsaved changes', keywords: 'dirty modified unsaved' },
  { id: 'fill-required', cat: 'record', icon: 'wand-sparkles', needs: 'form', title: 'Fill required fields',
    desc: 'Put placeholder values in empty mandatory fields', keywords: 'minimum values mandatory populate' },
  { id: 'copy-record-id', cat: 'record', icon: 'fingerprint', needs: 'saved', title: 'Copy record ID',
    desc: 'Copy the GUID of this record', keywords: 'guid identifier clipboard' },
  { id: 'copy-record-url', cat: 'record', icon: 'link', needs: 'saved', title: 'Copy record URL',
    desc: 'Copy a shareable link to this record', keywords: 'link share clipboard' },
  { id: 'open-web-api', cat: 'record', icon: 'braces', needs: 'saved', title: 'Open record in Web API',
    desc: 'Raw JSON of this record in a new tab', keywords: 'json odata rest' },
  { id: 'all-fields', cat: 'record', icon: 'table-properties', needs: 'saved', title: 'All fields',
    desc: 'Every column and value, even those not on the form', keywords: 'attributes values columns data' },
  { id: 'record-properties', cat: 'record', icon: 'info', needs: 'saved', title: 'Record properties',
    desc: 'Created, modified, owner, status and form details', keywords: 'created modified owner audit' },
  { id: 'optionset-values', cat: 'record', icon: 'list-ordered', needs: 'form', title: 'Choice values',
    desc: 'Numeric values behind every choice on the form', keywords: 'optionset picklist option set codes' },
  { id: 'clone-record', cat: 'record', icon: 'copy-plus', needs: 'form', title: 'Clone record',
    desc: 'Open a new form pre-filled with this record\'s values', keywords: 'duplicate copy' },
  { id: 'refresh-subgrids', cat: 'record', icon: 'refresh-cw', needs: 'form', title: 'Refresh subgrids',
    desc: 'Reload every subgrid on the form', keywords: 'grid reload' },
  { id: 'refresh-form', cat: 'record', icon: 'rotate-ccw', needs: 'saved', title: 'Refresh without saving',
    desc: 'Reload the record data and discard autosave', keywords: 'reload discard autosave' },
  { id: 'blur-data', cat: 'record', icon: 'eye-off', title: 'Blur sensitive data',
    desc: 'Blur values for screenshots and demos', keywords: 'privacy hide screenshot demo anonymize' },
  { id: 'table-processes', cat: 'record', icon: 'workflow', needs: 'form', title: 'Table processes',
    desc: 'Workflows, business rules and flows on this table', keywords: 'workflow business rule bpf action flow' },
  { id: 'table-metadata', cat: 'record', icon: 'columns-3', needs: 'form', title: 'Table columns',
    desc: 'Column metadata: names, types, requirement level', keywords: 'metadata attributes schema entity definition' },
  { id: 'form-editor', cat: 'record', icon: 'layout-template', needs: 'form', title: 'Open form editor',
    desc: 'Edit this form in the Power Apps form designer', keywords: 'designer customize maker' },

  // ── Navigate ──────────────────────────────────────────────────────────
  { id: 'open-by-id', cat: 'navigate', icon: 'search', title: 'Open record by ID',
    desc: 'Jump to any record from its table and GUID', keywords: 'guid find go',
    input: [ENTITY, { name: 'id', type: 'guid', label: 'Record ID', placeholder: '00000000-0000-0000-0000-000000000000' }] },
  { id: 'new-record', cat: 'navigate', icon: 'plus', title: 'New record',
    desc: 'Open a blank form for any table', keywords: 'create add', input: [ENTITY] },
  { id: 'open-list', cat: 'navigate', icon: 'list', title: 'Open table list',
    desc: 'List view of any table, even one hidden from the app', keywords: 'view grid entity list', input: [ENTITY] },
  { id: 'my-profile', cat: 'navigate', icon: 'circle-user', title: 'My user record',
    desc: 'Open your own user record', keywords: 'me profile systemuser' },
  { id: 'advanced-find', cat: 'navigate', icon: 'funnel', title: 'Advanced find',
    desc: 'Open the classic advanced find', keywords: 'query search filter' },
  { id: 'maker-portal', cat: 'navigate', icon: 'hammer', title: 'Power Apps maker portal',
    desc: 'Open make.powerapps.com on this environment', keywords: 'make customize' },
  { id: 'solutions', cat: 'navigate', icon: 'package', title: 'Solutions',
    desc: 'Open the solutions of this environment', keywords: 'customizations import export' },
  { id: 'admin-center', cat: 'navigate', icon: 'shield', title: 'Power Platform admin center',
    desc: 'Open this environment in the admin center', keywords: 'ppac environment settings' },

  // ── Admin ─────────────────────────────────────────────────────────────
  { id: 'impersonate', cat: 'admin', icon: 'drama', title: 'Impersonate a user',
    desc: 'See the app exactly as another user does', keywords: 'act as login as another user security test', view: 'impersonate' },
  { id: 'list-users', cat: 'admin', icon: 'users', title: 'Users', desc: 'List of users', keywords: 'systemuser security' },
  { id: 'list-teams', cat: 'admin', icon: 'users-round', title: 'Teams', desc: 'List of teams', keywords: 'security' },
  { id: 'list-roles', cat: 'admin', icon: 'key-round', title: 'Security roles', desc: 'List of security roles', keywords: 'permissions privileges' },
  { id: 'list-business-units', cat: 'admin', icon: 'building-2', title: 'Business units', desc: 'List of business units', keywords: 'bu organization' },
  { id: 'list-system-jobs', cat: 'admin', icon: 'cog', title: 'System jobs', desc: 'Async operations and background jobs', keywords: 'asyncoperation workflow running failed' },
  { id: 'list-plugin-traces', cat: 'admin', icon: 'bug', title: 'Plug-in trace logs', desc: 'Trace logs written by plug-ins', keywords: 'plugin trace log error exception' },
  { id: 'list-processes', cat: 'admin', icon: 'git-branch', title: 'Processes', desc: 'Workflows, actions and business process flows', keywords: 'workflow flow' },
  { id: 'list-env-variables', cat: 'admin', icon: 'variable', title: 'Environment variables', desc: 'Environment variable definitions', keywords: 'config settings' },
  { id: 'list-web-resources', cat: 'admin', icon: 'file-code', title: 'Web resources', desc: 'Scripts, pages and images', keywords: 'javascript html' },
  { id: 'list-mailboxes', cat: 'admin', icon: 'mail', title: 'Mailboxes', desc: 'Mailbox configuration and status', keywords: 'email server side sync' },
  { id: 'list-solution-history', cat: 'admin', icon: 'history', title: 'Solution history', desc: 'Past solution imports and operations', keywords: 'import deployment' },
  { id: 'advanced-settings', cat: 'admin', icon: 'settings', title: 'Advanced settings',
    desc: 'Open the classic settings area', keywords: 'classic legacy configuration' },

  // ── Debug ─────────────────────────────────────────────────────────────
  { id: 'forms-monitor', cat: 'debug', icon: 'activity', title: 'Forms monitor',
    desc: 'Reload with the live monitor for form events', keywords: 'monitor events trace' },
  { id: 'command-checker', cat: 'debug', icon: 'square-check', title: 'Command checker',
    desc: 'Reload with the ribbon command checker enabled', keywords: 'ribbon button rules' },
  { id: 'perf-center', cat: 'debug', icon: 'gauge', title: 'Performance center',
    desc: 'Reload with the performance overlay enabled', keywords: 'perf slow timing' },
  { id: 'disable-handlers', cat: 'debug', icon: 'zap-off', title: 'Disable form handlers',
    desc: 'Reload with all form event handlers turned off', keywords: 'onload onchange script' },
  { id: 'disable-rules', cat: 'debug', icon: 'ban', title: 'Disable business rules',
    desc: 'Reload with business rules turned off', keywords: 'business rule' },
  { id: 'disable-libraries', cat: 'debug', icon: 'file-x', title: 'Disable form libraries',
    desc: 'Reload without the form\'s JavaScript libraries', keywords: 'script javascript web resource' },
  { id: 'dark-mode', cat: 'debug', icon: 'moon', title: 'Dynamics dark mode',
    desc: 'Reload the app with the dark theme flag', keywords: 'theme night' },
  { id: 'clear-flags', cat: 'debug', icon: 'eraser', title: 'Clear debug flags',
    desc: 'Reload without any debugging flag', keywords: 'reset restore normal' },

  // ── Tools ─────────────────────────────────────────────────────────────
  { id: 'env-info', cat: 'tools', icon: 'server', title: 'Environment details',
    desc: 'Organization, version, IDs, user and app at a glance', keywords: 'org version environment id about' },
  { id: 'my-roles', cat: 'tools', icon: 'id-card', title: 'My roles and teams',
    desc: 'Security roles and teams of the current user', keywords: 'security permissions whoami' },
  { id: 'record-count', cat: 'tools', icon: 'hash', title: 'Count records',
    desc: 'Total number of rows in a table', keywords: 'total rows how many', input: [ENTITY] },
  { id: 'api-playground', cat: 'tools', icon: 'terminal', title: 'Web API playground',
    desc: 'Run Web API queries and read the JSON in the page', keywords: 'odata query fetch rest json' },
  { id: 'web-api-root', cat: 'tools', icon: 'globe', title: 'Web API root',
    desc: 'Open the Web API service document', keywords: 'odata endpoint' },
  { id: 'diagnostics', cat: 'tools', icon: 'stethoscope', title: 'Network diagnostics',
    desc: 'Open the built-in latency and bandwidth test', keywords: 'diag latency speed' },
];

// Icons used by the popup chrome itself (not tied to a command).
export const UI_ICONS = ['star', 'sun', 'moon', 'sun-moon', 'arrow-left', 'corner-down-left', 'x', 'triangle-alert', 'external-link', 'search'];
