import test from "node:test";
import assert from "node:assert/strict";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createReportHandler } from "../netlify/lib/report-api.mjs";
import defaults from "../netlify/ai-settings.json" with { type: "json" };

const time = Date.parse("2026-10-24T12:00:00Z");
const tenant = "11111111-1111-4111-8111-111111111111";
const audience = "22222222-2222-4222-8222-222222222222";
const client = "33333333-3333-4333-8333-333333333333";
const user = "44444444-4444-4444-8444-444444444444";
const otherUser = "55555555-5555-4555-8555-555555555555";
const models = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];
const keys = await generateKeyPair("RS256");
const publicKey = await exportJWK(keys.publicKey);
const keySet = createLocalJWKSet({ keys: [{ ...publicKey, kid: "test", alg: "RS256", use: "sig" }] });
const baseClaims = {
  iss: `https://login.microsoftonline.com/${tenant}/v2.0`, aud: audience,
  tid: tenant, azp: client, oid: user, sub: "test-subject", ver: "2.0",
  scp: "Reports.Generate", roles: ["AI.ReportUser"],
  iat: time / 1000 - 30, nbf: time / 1000 - 30, exp: time / 1000 + 3 * 86400
};
async function token(overrides = {}, signingKey = keys.privateKey, alg = "RS256") {
  const claims = { ...baseClaims, ...overrides };
  for (const name of Object.keys(claims)) if (claims[name] === undefined) delete claims[name];
  return new SignJWT(claims).setProtectedHeader({ alg, kid: "test", typ: "JWT" }).sign(signingKey);
}
const validToken = await token();
const input = { question: "Count CARTA routes", schema: 'Table data.simple_bus_routes: "route_id" (VARCHAR)', model: models[0] };
const completion = () => Response.json({ choices: [{ message: { content: "SELECT COUNT(*) FROM data.simple_bus_routes" }, finish_reason: "stop" }] });

function harness({ settings = {}, provider = completion, env = {} } = {}) {
  const calls = [];
  const state = { time, secretReads: 0 };
  const environment = { ENTRA_TENANT_ID: tenant, ENTRA_API_CLIENT_ID: audience, ENTRA_WEB_CLIENT_ID: client, ...env };
  Object.defineProperty(environment, "GROQ_API_KEY", {
    get() { state.secretReads++; return Object.hasOwn(env, "GROQ_API_KEY") ? env.GROQ_API_KEY : "fake-server-key"; }
  });
  const handler = createReportHandler({
    env: environment, settings: { ...defaults, ...settings }, keySet, now: () => state.time,
    fetchProvider: async (url, options) => {
      assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
      assert.equal(options.redirect, "error");
      calls.push({ url, ...options, parsed: JSON.parse(options.body) });
      return provider(url, options, calls.length);
    }
  });
  function request(body = input, { auth = validToken, method = "POST", headers = {}, raw, signal } = {}) {
    return handler(new Request("https://poc.invalid/.netlify/functions/report", {
      method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), "Content-Type": "application/json", ...headers },
      ...(method === "GET" || method === "OPTIONS" ? {} : { body: raw ?? JSON.stringify(body) }),
      ...(signal ? { signal } : {})
    }));
  }
  return { request, calls, state, environment };
}

test("authorization probe validates access without reading the provider key", async () => {
  const h = harness(); const response = await h.request(null, { method: "GET" });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { authorized: true });
  assert.equal(h.state.secretReads, 0);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

for (const [name, claims] of [
  ["wrong issuer", { iss: "https://attacker.invalid" }],
  ["wrong audience / ID token", { aud: client }],
  ["expired token", { exp: time / 1000 - 1 }],
  ["not-yet-valid token", { nbf: time / 1000 + 60 }],
  ["missing expiry", { exp: undefined }],
  ["missing issue time", { iat: undefined }],
  ["missing not-before", { nbf: undefined }],
  ["missing subject", { sub: undefined }]
]) test(`denies ${name} before reading the key`, async () => {
  const h = harness(); const response = await h.request(input, { auth: await token(claims) });
  assert.equal(response.status, 401); assert.equal(h.calls.length, 0);
  assert.equal(h.state.secretReads, 0);
});

for (const [name, claims] of [
  ["wrong tenant", { tid: otherUser }], ["wrong client", { azp: audience }],
  ["missing client", { azp: undefined }], ["v1 token", { ver: "1.0" }],
  ["missing user ID", { oid: undefined }], ["invalid user ID", { oid: "../someone" }],
  ["empty subject", { sub: "" }], ["future issue time", { iat: time / 1000 + 60 }],
  ["app-only token", { idtyp: "app" }], ["missing delegated scope", { scp: undefined }],
  ["scope substring", { scp: "NotReports.Generate" }], ["missing role", { roles: [] }],
  ["role substring", { roles: ["NotAI.ReportUser"] }], ["role in incorrect claim type", { roles: "AI.ReportUser" }],
  ["administrator without application role", { roles: [], wids: ["global-admin"] }]
]) test(`denies ${name} before reading the key`, async () => {
  const h = harness(); const response = await h.request(input, { auth: await token(claims) });
  assert.equal(response.status, 403); assert.equal(h.calls.length, 0); assert.equal(h.state.secretReads, 0);
});

test("denies missing, malformed, wrong-signature and wrong-algorithm tokens", async () => {
  const wrongKeys = await generateKeyPair("RS256");
  for (const auth of [null, "bad", await token({}, wrongKeys.privateKey), await token({}, new Uint8Array(32), "HS256")]) {
    const h = harness(); const response = await h.request(input, { auth });
    assert.equal(response.status, 401); assert.equal(h.calls.length, 0); assert.equal(h.state.secretReads, 0);
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
  }
});

test("missing identity configuration and disallowed methods fail closed", async () => {
  const h = harness({ env: { ENTRA_TENANT_ID: "" } });
  assert.equal((await h.request()).status, 503); assert.equal(h.calls.length, 0);
  const method = await harness().request(null, { method: "OPTIONS" });
  assert.equal(method.status, 405); assert.equal(method.headers.get("allow"), "GET, POST");
});

for (const model of models) test(`allows ${model} with fixed provider settings and safe output`, async () => {
  const h = harness(); const response = await h.request({ ...input, model });
  assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.model, model);
  assert.deepEqual(Object.keys(result).sort(), ["model", "sql"]);
  assert.equal(h.calls[0].parsed.max_completion_tokens, 4096); assert.equal(h.calls[0].parsed.temperature, 0);
  assert.equal(h.calls[0].headers.Authorization, "Bearer fake-server-key");
  assert(!h.calls[0].body.includes("fake-server-key"));
  assert(h.calls[0].parsed.messages[0].content.includes("40001"));
  assert(h.calls[0].parsed.messages[0].content.includes(input.schema));
  assert(!h.calls[0].body.includes(user)); assert(!h.calls[0].body.includes(validToken));
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("rejects unsupported models, arbitrary URLs, provider options and malformed inputs", async () => {
  for (const body of [null, [], {}, { ...input, model: "unapproved" }, { ...input, url: "https://attacker.invalid" },
    { ...input, messages: [] }, { ...input, max_completion_tokens: 99999 }, { ...input, question: " " },
    { ...input, question: "x".repeat(8001) }, { ...input, schema: "" }, { ...input, schema: "x".repeat(200001) },
    { ...input, error: " " }, { ...input, error: null }, { ...input, error: 1 }, { ...input, error: "x".repeat(16001) },
    { ...input, reportId: "legacy-tracking-id" }
  ]) {
    const h = harness(); assert.equal((await h.request(body)).status, 400);
    assert.equal(h.calls.length, 0);
  }
  const h = harness(); assert.equal((await h.request(null, { raw: "{" })).status, 400);
  assert.equal((await h.request(input, { headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await h.request(input, { headers: { "Content-Encoding": "gzip" } })).status, 415);
});

test("enforces actual byte size, including multibyte input without Content-Length", async () => {
  const h = harness(); const response = await h.request({ ...input, schema: "中".repeat(90000) });
  assert.equal(response.status, 413); assert.equal(h.calls.length, 0);
  assert.equal((await h.request(input, { headers: { "Content-Length": "262145" } })).status, 413);
  assert.equal((await harness().request({ ...input, question: "x".repeat(8000) })).status, 200);
});

test("a missing provider key cannot reach Groq", async () => {
  const missing = harness({ env: { GROQ_API_KEY: "" } });
  assert.equal((await missing.request()).status, 503); assert.equal(missing.calls.length, 0);
});

test("repeated AI requests need no storage transport and have no application user quota", async t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected storage or other network access"); });
  const h = harness();
  const responses = await Promise.all(Array.from({ length: 205 }, () => h.request()));
  assert(responses.every(response => response.status === 200));
  assert.equal(h.calls.length, 205);
  for (const response of responses) {
    assert.deepEqual(Object.keys(await response.json()).sort(), ["model", "sql"]);
  }
});

for (const status of [400, 404, 429]) test(`tries the other model once after provider HTTP ${status}`, async () => {
  const h = harness({ provider: (_url, _options, attempt) => attempt === 1 ? new Response("private error", { status }) : completion() });
  const response = await h.request(); assert.equal(response.status, 200); assert.equal((await response.json()).model, models[1]);
  assert.equal(h.calls.length, 2);
});

test("a correction can include provider fallback without a stored report permit", async () => {
  const h = harness({ provider: (_url, _options, attempt) => attempt % 2 ? new Response("limited", { status: 429 }) : completion() });
  assert.equal((await h.request()).status, 200);
  const correction = { ...input, error: "Unknown column" };
  assert.equal((await h.request(correction)).status, 200); assert.equal(h.calls.length, 4);
  assert(h.calls[2].parsed.messages[1].content.includes("Unknown column"));
});

test("authorized corrections can be repeated across function instances without user tracking", async () => {
  const a = harness(), b = harness();
  const correction = { ...input, error: "Unknown column" };
  const responses = await Promise.all([a.request(correction), a.request(correction), b.request(correction)]);
  assert(responses.every(response => response.status === 200));
  assert.equal(a.calls.length + b.calls.length, 3);
  assert.equal((await b.request(correction, { auth: await token({ oid: otherUser }) })).status, 200);
});

test("every correction revalidates authorization, without cached role decisions", async () => {
  const h = harness(); assert.equal((await h.request()).status, 200);
  const response = await h.request({ ...input, error: "Unknown column" }, { auth: await token({ roles: [] }) });
  assert.equal(response.status, 403); assert.equal(h.calls.length, 1);
});

test("provider errors and network failures are sanitized and do not retry the same model", async () => {
  for (const provider of [() => new Response("fake-server-key secret prompt", { status: 401 }), () => { throw Error("network private details"); }]) {
    const h = harness({ provider }); const response = await h.request(); const text = await response.text();
    assert.equal(response.status, 502); assert.equal(h.calls.length, 1);
    assert(!text.includes("fake-server-key")); assert(!text.includes("secret prompt")); assert(!text.includes("private details"));
  }
  const h = harness({ provider: () => new Response("unavailable", { status: 429 }) });
  assert.equal((await h.request()).status, 502); assert.equal(h.calls.length, 2);
});

test("rejects invalid, truncated and oversized provider responses", async () => {
  for (const provider of [() => new Response("{"), () => Response.json(null), () => Response.json({}),
    () => Response.json({ choices: [{ message: { content: "SELECT 1" }, finish_reason: "length" }] }),
    () => new Response("x".repeat(262145))]) {
    const h = harness({ provider }); assert.equal((await h.request()).status, 502);
    assert.equal(h.calls.length, 1);
  }
});

test("provider timeout aborts fetch and does not attempt fallback", async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const h = harness({ settings: { providerTimeoutMs: 15 }, provider: (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }) });
    assert.equal((await h.request()).status, 504); assert.equal(h.calls.length, 1); assert(h.calls[0].signal.aborted);
  } finally { clearInterval(keepAlive); }
});

test("a stalled response body is also subject to the provider deadline", async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const h = harness({ settings: { providerTimeoutMs: 15 }, provider: () => new Response(new ReadableStream({ start() {} })) });
    assert.equal((await h.request()).status, 504); assert.equal(h.calls.length, 1);
  } finally { clearInterval(keepAlive); }
});

test("abandoned requests cannot start a provider call", async () => {
  const abort = new AbortController(); abort.abort(); const h = harness();
  assert.equal((await h.request(input, { signal: abort.signal })).status, 504); assert.equal(h.calls.length, 0);
});
