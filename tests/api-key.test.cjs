const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { harness } = require('./report-state.test.cjs');
const modulePromise = import('../assets/staff-auth.mjs');
const KEY = 'carta_groq_api_key';
const config = { tenantId: 'tenant', webClientId: 'web', apiScope: 'api://api/Reports.Generate', redirectUris: ['http://localhost:8000/auth-redirect.html'] };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject}; }
const tick = () => new Promise(setImmediate);
async function setup({ login, acquire, fetchRequest, logout } = {}) {
  const states = [], calls = [], requests = []; let cacheClears = 0, options;
  const account = { name: 'POC tester', homeAccountId: 'test-user' };
  const library = { CacheLookupPolicy: {AccessTokenAndRefreshToken: 3}, PublicClientApplication: class {
    constructor(value) { options = value; }
    async initialize() {}
    setActiveAccount() {}
    async loginPopup(request) { calls.push(['login', request]); return login ? login(request) : {account}; }
    async acquireTokenSilent(request) { calls.push(['token', request]); return acquire ? acquire(request) : {accessToken: 'fake-access-token'}; }
    async logoutPopup(request) { calls.push(['logout', request]); if (logout) return logout(request); }
    async clearCache() { cacheClears++; }
  }};
  const {createStaffSession} = await modulePromise;
  const session = await createStaffSession({ config, library, origin: 'http://localhost:8000', onState: state => states.push(state),
    fetchRequest: async (url, request) => {requests.push({url, ...request}); return fetchRequest ? fetchRequest(url, request) : Response.json(request.method === 'POST' ? {sql: 'SELECT 1', model: 'openai/gpt-oss-120b', reportId: 'test-report'} : {authorized: true});}
  });
  return {session, states, calls, requests, get options() {return options;}, get cacheClears() {return cacheClears;}};
}

test('legacy key cleanup removes only the app record, without reading or restoring keys', () => {
  const records = new Map([[KEY, 'gsk_fixture_old_key'], ['unrelated-setting', 'keep']]); let reads = 0;
  const h = harness({storage: {getItem() {reads++; throw Error('must not read');}, setItem() {throw Error('must not save');}, removeItem(key) {records.delete(key);}}});
  assert.equal(reads, 0); assert.equal(records.has(KEY), false); assert.equal(records.get('unrelated-setting'), 'keep');
  assert.equal(h.ui.legacyKeyStatus.textContent, '');
});
for (const blocked of ['getter', 'remove']) test('blocked legacy storage ' + blocked + ' preserves public reporting and hides AI', async () => {
  const storage = blocked === 'getter' ? () => {throw Error('gsk_private_storage_detail');} : {removeItem() {throw Error('gsk_private_storage_detail');}};
  const h = harness({storage, authorized: false});
  assert.match(h.ui.legacyKeyStatus.textContent, /could not be cleared/); assert(!h.ui.legacyKeyStatus.textContent.includes('gsk_private'));
  const publicReport = h.run('public report'); await tick();
  h.queries[0].resolve({schema: {fields: [{name: 'route'}]}, numRows: 1, get: () => ({route: '4'})}); await publicReport;
  assert.equal(h.state().rows.length, 1); await h.ask(); assert.equal(h.generations.length, 0);
});

test('key entry, remember/forget controls and browser Groq calls are removed', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'app.js'), 'utf8');
  for (const id of ['groqApiKeyInput', 'saveGroqKeyBtn', 'forgetGroqKeyBtn']) assert(!html.includes(id));
  assert(!source.includes('api.groq.com')); assert(!source.includes('localStorage.setItem'));
  assert.match(html, /id="tab-ai"[^>]* hidden/);
});

test('Microsoft session uses tenant authority, dedicated callback, memory cache and no automatic login', async () => {
  const h = await setup(); assert.equal(h.options.auth.authority, 'https://login.microsoftonline.com/tenant');
  assert.equal(h.options.auth.redirectUri, config.redirectUris[0]); assert.equal(h.options.cache.cacheLocation, 'memoryStorage');
  assert.equal(h.options.system.loggerOptions.piiLoggingEnabled, false);
  assert.equal(h.states.at(-1).authorized, false); assert.equal(h.states.at(-1).signedIn, false);
  await assert.rejects(h.session.requestReport({}), /not enabled/); assert.equal(h.requests.length, 0); assert.equal(h.calls.length, 0);
});

test('identity sign-in and custom API authorization are separate, and token values never enter UI state', async () => {
  const h = await setup(); await h.session.signIn();
  assert.deepEqual(h.calls[0][1].scopes, ['openid', 'profile']);
  assert.deepEqual(h.calls[1][1].scopes, [config.apiScope]); assert.equal(h.calls[1][1].cacheLookupPolicy, 3);
  assert.equal(h.requests[0].url, '/.netlify/functions/report'); assert.equal(h.requests[0].headers.Authorization, 'Bearer fake-access-token');
  assert.equal(h.requests[0].redirect, 'error'); assert.equal(h.states.at(-1).authorized, true);
  assert.equal(h.states.at(-1).name, 'POC tester'); assert(!JSON.stringify(h.states).includes('fake-access-token'));
});

test('AI stays hidden while backend authorization is pending', async () => {
  const gate = deferred(); const h = await setup({fetchRequest: () => gate.promise});
  const signin = h.session.signIn(); await tick();
  assert.equal(h.states.at(-1).signedIn, true); assert.equal(h.states.at(-1).authorized, false); assert.equal(h.states.at(-1).busy, true);
  gate.resolve(Response.json({authorized: true})); await signin; assert.equal(h.states.at(-1).authorized, true);
});
for (const status of [401, 403, 503]) test('backend authorization HTTP ' + status + ' cannot reveal AI', async () => {
  const h = await setup({fetchRequest: () => Response.json({}, {status})}); await h.session.signIn();
  assert.equal(h.states.at(-1).authorized, false); assert.equal(h.states.at(-1).signedIn, true);
  if (status === 403) assert.equal(h.states.at(-1).message, 'AI reporting is not enabled for this account.');
});

test('missing API consent/assignment does not undo ordinary identity sign-in', async () => {
  const h = await setup({acquire: () => {throw Object.assign(Error('private identity details'), {errorCode: 'interaction_required'});}});
  await h.session.signIn(); assert.equal(h.states.at(-1).signedIn, true); assert.equal(h.states.at(-1).authorized, false);
  assert.equal(h.states.at(-1).message, 'AI reporting is not enabled for this account.'); assert.equal(h.requests.length, 0);
});

test('failed identity sign-in has a generic message and leaves public reporting available', async () => {
  const h = await setup({login: () => {throw Error('private token details');}}); await h.session.signIn();
  assert.equal(h.states.at(-1).signedIn, false); assert.equal(h.states.at(-1).busy, false);
  assert(!h.states.at(-1).message.includes('private token')); assert.equal(h.requests.length, 0);
});

test('sign-out immediately hides AI and a late authorization probe cannot restore it', async () => {
  const gate = deferred(); const h = await setup({fetchRequest: () => gate.promise});
  const signin = h.session.signIn(); await tick(); await h.session.signOut();
  assert.equal(h.states.at(-1).authorized, false); assert.equal(h.states.at(-1).signedIn, false);
  gate.resolve(Response.json({authorized: true})); await signin;
  assert.equal(h.states.at(-1).authorized, false); assert.equal(h.states.at(-1).signedIn, false);
});

test('a blocked Microsoft logout still clears local account state and cache', async () => {
  const h = await setup({logout: () => {throw Error('popup blocked');}}); await h.session.signIn(); await h.session.signOut();
  assert.equal(h.states.at(-1).authorized, false); assert.equal(h.states.at(-1).signedIn, false); assert.equal(h.cacheClears, 1);
});

test('each backend POST renews through MSAL and sends only approved request fields', async () => {
  const h = await setup(); await h.session.signIn();
  const body = {question: 'Count routes', schema: 'Table data.simple_bus_routes', model: 'openai/gpt-oss-120b'};
  await h.session.requestReport(body);
  assert.equal(h.calls.filter(call => call[0] === 'token').length, 2);
  const request = h.requests.at(-1); assert.equal(request.url, '/.netlify/functions/report'); assert.equal(request.method, 'POST');
  assert.equal(request.headers.Authorization, 'Bearer fake-access-token'); assert.deepEqual(JSON.parse(request.body), body);
  assert(!request.body.includes('fake-access-token'));
});
for (const status of [401, 403]) test('POST HTTP ' + status + ' removes authorization immediately', async () => {
  const h = await setup({fetchRequest: (_url, options) => options.method === 'POST' ? Response.json({}, {status}) : Response.json({authorized: true})});
  await h.session.signIn(); await assert.rejects(h.session.requestReport({}), /not enabled/);
  assert.equal(h.states.at(-1).authorized, false);
  await assert.rejects(h.session.requestReport({}), /not enabled/); assert.equal(h.requests.length, 2);
});

test('backend quota denial displays Retry-After and never starts a frontend fallback', async () => {
  const h = await setup({fetchRequest: (_url, options) => options.method === 'POST' ? Response.json({}, {status: 429, headers: {'Retry-After': '60'}}) : Response.json({authorized: true})});
  await h.session.signIn(); await assert.rejects(h.session.requestReport({}), /60 seconds/); assert.equal(h.requests.length, 2);
});

test('sign-out during token acquisition prevents a late backend POST', async () => {
  const gate = deferred(); let acquisitions = 0;
  const h = await setup({acquire: () => ++acquisitions === 1 ? {accessToken: 'fixture-token'} : gate.promise});
  await h.session.signIn(); const report = h.session.requestReport({}); const denied = assert.rejects(report, /canceled/);
  await h.session.signOut(); gate.resolve({accessToken: 'stale-token'}); await denied; assert.equal(h.requests.length, 1);
});

test('sign-out during a backend POST prevents a late report result', async () => {
  const gate = deferred(); const h = await setup({fetchRequest: (_url, options) => options.method === 'POST' ? gate.promise : Response.json({authorized: true})});
  await h.session.signIn(); const report = h.session.requestReport({}); const denied = assert.rejects(report, /canceled/); await tick();
  await h.session.signOut(); gate.resolve(Response.json({sql: 'stale SQL'})); await denied;
});

test('loss of access cancels pending AI generation without terminating public reporting', async () => {
  const h = harness(); const pending = h.ask();
  vm.runInContext('aiAuthorized = false; cancelStaffAi("Access changed.");', h.ui);
  h.generations[0].resolve({sql: 'stale SQL', usedModel: 'mock'}); await pending;
  assert.equal(h.queries.length, 0); assert.equal(h.resources().terminated, 0); assert.equal(h.ui.askAiBtn.disabled, true);
  const report = h.run('public report'); await tick();
  h.queries[0].resolve({schema: {fields: [{name: 'route'}]}, numRows: 1, get: () => ({route: '4'})}); await report;
  assert.equal(h.state().rows[0].route, '4');
});

test('loss of access cancels only the active AI query connection', async () => {
  const h = harness(); const pending = h.ask(); h.generations[0].resolve({sql: 'AI SQL', usedModel: 'mock'}); await tick();
  vm.runInContext('aiAuthorized = false; cancelStaffAi("Access changed.");', h.ui); await pending;
  assert.equal(h.connections[0].cancelled, true); assert.equal(h.resources().terminated, 0);
  h.queries[0].reject(Error('canceled fixture query'));
});

test('sign-out cannot clear a newer public report while an old AI response is pending', async () => {
  const h = harness(); const pending = h.ask(); const current = h.run('public report'); await tick();
  h.queries[0].resolve({schema: {fields: [{name: 'route'}]}, numRows: 1, get: () => ({route: '4'})}); await current;
  vm.runInContext('aiAuthorized = false; cancelStaffAi("Access changed.");', h.ui);
  h.generations[0].resolve({sql: 'stale SQL', usedModel: 'mock'}); await pending;
  assert.equal(h.state().report.title, 'public report'); assert.equal(h.state().rows[0].route, '4');
});

test('loss of access clears a completed AI report without terminating the database', async () => {
  const h = harness(); const pending = h.ask(); h.generations[0].resolve({sql: 'AI SQL', usedModel: 'mock'}); await tick();
  h.queries[0].resolve({schema: {fields: [{name: 'route'}]}, numRows: 1, get: () => ({route: '4'})}); await pending;
  assert.equal(h.state().rows.length, 1);
  vm.runInContext('aiAuthorized = false; cancelStaffAi("Access changed.");', h.ui);
  assert.equal(h.state().rows.length, 0); assert.equal(h.ui.sqlQueryBox.value, ''); assert.equal(h.resources().terminated, 0);
});
