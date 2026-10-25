// Offline browser integration check using the installed MSAL cache implementation.
// Usage: node tests/staff-session-browser.cjs <temporary npm prefix with playwright-core>
// Only interactive Microsoft login/logout are replaced by fixture token hydration/cache clearing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');
const { securityHeaders } = require('./security-headers.cjs');

assert(process.argv[2], 'Provide a temporary npm prefix containing playwright-core.');
const requireCheck = createRequire(path.join(path.resolve(process.argv[2]), 'verify.cjs'));
const { chromium } = requireCheck('playwright-core');
const root = path.join(__dirname, '..');
const fixtureHtml = `<!doctype html><title>Session cache verification</title>
<script src="/msal.js"></script><script type="module" src="/session-fixture.mjs"></script>`;
const fixtureModule = `import {createStaffSession} from '/staff-auth.mjs';
const tenantId = '11111111-1111-4111-8111-111111111111';
const webClientId = '22222222-2222-4222-8222-222222222222';
const apiScope = 'api://33333333-3333-4333-8333-333333333333/Reports.Generate';
const authority = 'https://login.microsoftonline.com/' + tenantId;
const account = {homeAccountId: 'fixture.' + tenantId, localAccountId: '44444444-4444-4444-8444-444444444444',
  environment: 'login.microsoftonline.com', tenantId, username: 'fixture@example.invalid', name: 'Fixture user'};
const claims = {oid: account.localAccountId, sub: account.localAccountId, tid: tenantId, aud: webClientId,
  name: account.name, preferred_username: account.username, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600};
const encode = value => btoa(JSON.stringify(value)).replace(/=/g,'').replace(/\\+/g,'-').replace(/\\//g,'_');
const idToken = encode({alg:'RS256',typ:'JWT'}) + '.' + encode(claims) + '.fixture';
account.idTokenClaims = claims;
const fixture = globalThis.fixture = {states: [], logins: 0};
const library = {...msal, PublicClientApplication: class extends msal.PublicClientApplication {
  constructor(options) {super({...options, auth: {...options.auth,
    cloudDiscoveryMetadata: JSON.stringify({tenant_discovery_endpoint: authority + '/v2.0/.well-known/openid-configuration', metadata: [
      {preferred_network: 'login.microsoftonline.com', preferred_cache: 'login.microsoftonline.com', aliases: ['login.microsoftonline.com']}
    ]}),
    authorityMetadata: JSON.stringify({authorization_endpoint: authority + '/oauth2/v2.0/authorize',
      token_endpoint: authority + '/oauth2/v2.0/token', issuer: authority + '/v2.0',
      jwks_uri: authority + '/discovery/v2.0/keys', end_session_endpoint: authority + '/oauth2/v2.0/logout'})
  }});}
  async loginPopup() {
    fixture.logins++;
    const result = {authority, uniqueId: account.localAccountId, tenantId, scopes: [apiScope], account,
      idToken, idTokenClaims: claims, accessToken: 'fixture-api-access-token', fromCache: false,
      expiresOn: new Date(Date.now()+3600000), extExpiresOn: new Date(Date.now()+3600000),
      tokenType: 'Bearer', correlationId: '55555555-5555-4555-8555-555555555555'};
    await this.hydrateCache(result, {scopes:[apiScope]});
    return result;
  }
  async logoutPopup({account}) {await this.clearCache({account});}
}};
try {
  fixture.session = await createStaffSession({library, config: {tenantId, webClientId, apiScope,
    redirectUris: [location.origin + '/auth-redirect.html']}, onState: state => fixture.states.push(state)});
  fixture.ready = true;
} catch(error) {fixture.error = error.message;}
`;

async function main() {
  let backendStatus = 200, probes = 0;
  const server = http.createServer((request, response) => {
    for (const [name, value] of Object.entries(securityHeaders)) response.setHeader(name, value);
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/.netlify/functions/report') {
      probes++;
      assert.equal(request.headers.authorization, 'Bearer fixture-api-access-token');
      response.writeHead(backendStatus, {'Content-Type': 'application/json'});
      response.end(JSON.stringify({authorized: backendStatus === 200})); return;
    }
    const file = pathname === '/msal.js' ? 'node_modules/@azure/msal-browser/lib/msal-browser.min.js'
      : pathname === '/staff-auth.mjs' ? 'assets/staff-auth.mjs' : null;
    response.writeHead(pathname === '/' || pathname === '/session-fixture.mjs' || file ? 200 : 404, {'Content-Type': file || pathname === '/session-fixture.mjs' ? 'text/javascript' : 'text/html', 'Cache-Control': 'no-store'});
    response.end(file ? fs.readFileSync(path.join(root, file)) : pathname === '/session-fixture.mjs' ? fixtureModule : pathname === '/' ? fixtureHtml : 'Not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true});
    const context = await browser.newContext();
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const ready = async () => {
      await page.waitForFunction(() => fixture.ready || fixture.error);
      assert.equal(await page.evaluate(() => fixture.error), undefined);
    };
    await page.goto(origin); await ready();
    assert.equal(await page.evaluate(() => fixture.states.at(-1).signedIn), false);
    await page.evaluate(() => fixture.session.signIn());
    assert.equal(await page.evaluate(() => fixture.states.at(-1).authorized), true);
    const firstProbes = probes;
    const cache = await page.evaluate(() => ({session: JSON.stringify({...sessionStorage}), local: JSON.stringify({...localStorage})}));
    assert(cache.session.includes('fixture-api-access-token'));
    assert(!cache.local.includes('fixture-api-access-token') && !cache.local.includes('fixture@example.invalid'));
    await page.reload(); await ready();
    await page.waitForFunction(() => fixture.states.at(-1)?.authorized === true);
    assert.equal(probes, firstProbes + 1);
    assert.equal(await page.evaluate(() => fixture.logins), 0);
    console.log('PASS: real MSAL account/token cache survives same-tab refresh, restores without login, and rechecks backend access');
    const second = await context.newPage(); await second.goto(origin);
    await second.waitForFunction(() => fixture.ready || fixture.error);
    assert.equal(await second.evaluate(() => fixture.states.at(-1).signedIn), false);
    await second.close();
    backendStatus = 403;
    await page.reload(); await ready();
    await page.waitForFunction(() => fixture.states.at(-1)?.message === 'AI reporting is not enabled for this account.');
    assert.equal(await page.evaluate(() => fixture.states.some(state => state.authorized)), false);
    await page.evaluate(() => fixture.session.signOut());
    const cleared = await page.evaluate(() => JSON.stringify({...sessionStorage}));
    assert(!cleared.includes('fixture-api-access-token') && !cleared.includes('fixture@example.invalid'));
    backendStatus = 200;
    const beforeSignedOutReload = probes;
    await page.reload(); await ready();
    assert.equal(await page.evaluate(() => fixture.states.at(-1).signedIn), false);
    assert.equal(probes, beforeSignedOutReload);
    assert.deepEqual(errors, []);
    console.log('PASS: a separate tab starts signed out, denied access stays denied, and sign-out clears cached identity/tokens before refresh');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {console.error(error); process.exitCode = 1;});
