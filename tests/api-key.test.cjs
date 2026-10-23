const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { harness } = require("./report-state.test.cjs");

const KEY = "carta_groq_api_key";
const source = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").match(/<script type="module">([\s\S]*?)<\/script>/)[1];

function storageWith(saved) {
  const entries = new Map([["unrelated-setting", "keep"]]);
  if (saved !== undefined) entries.set(KEY, saved);
  return {
    entries, writes: 0,
    getItem(key) { return entries.get(key) ?? null; },
    setItem(key, value) { this.writes++; entries.set(key, value); },
    removeItem(key) { entries.delete(key); }
  };
}

function typeKey(h, value) {
  h.ui.groqApiKeyInput.value = value;
  h.ui.groqApiKeyInput.listeners.get("input")();
}

function remember(h) { h.ui.saveGroqKeyBtn.listeners.get("click")(); }
function forget(h) { h.ui.forgetGroqKeyBtn.listeners.get("click")(); }

test("typing and asking use the key without persisting it, and a reload does not restore it", async () => {
  const storage = storageWith();
  const h = harness({ storage });
  typeKey(h, "  gsk_tab_only  ");
  const pending = h.ask();
  assert.equal(h.generations[0].args[0], "gsk_tab_only");
  h.generations[0].reject(Error("mock request failed")); await pending;
  assert.equal(storage.writes, 0);
  assert.equal(storage.getItem(KEY), null);
  const next = harness({ storage });
  assert.notEqual(next.ui.groqApiKeyInput.value, "gsk_tab_only");
  assert.match(h.ui.groqKeyStatus.textContent, /this tab only/);
});

test("remembering is explicit and survives reload; editing requires consent again", () => {
  const storage = storageWith();
  const h = harness({ storage });
  typeKey(h, "  gsk_remembered  "); remember(h);
  assert.equal(storage.writes, 1);
  const next = harness({ storage });
  assert.equal(next.ui.groqApiKeyInput.value, "gsk_remembered");
  assert.match(next.ui.groqKeyStatus.textContent, /Remembered key loaded/);
  typeKey(next, "gsk_replacement");
  assert.equal(storage.getItem(KEY), null);
  assert.match(next.ui.groqKeyStatus.textContent, /this tab only/);
  remember(next);
  assert.equal(harness({ storage }).ui.groqApiKeyInput.value, "gsk_replacement");
});

test("Forget clears the field and saved key while preserving unrelated browser settings", () => {
  const storage = storageWith();
  const h = harness({ storage });
  typeKey(h, "gsk_forget"); remember(h); forget(h);
  assert.equal(h.ui.groqApiKeyInput.value, "");
  assert.equal(storage.getItem(KEY), null);
  assert.equal(storage.entries.get("unrelated-setting"), "keep");
  assert.match(h.ui.groqKeyStatus.textContent, /Key forgotten/);
  assert.notEqual(harness({ storage }).ui.groqApiKeyInput.value, "gsk_forget");
});

test("remembering an empty key gives guidance without a storage write", () => {
  const storage = storageWith();
  const h = harness({ storage });
  typeKey(h, "   "); remember(h);
  assert.equal(storage.writes, 0);
  assert.match(h.ui.groqKeyStatus.textContent, /Enter a key before/);
});

test("legacy automatically saved keys become tab-only and require fresh consent", () => {
  const storage = storageWith("gsk_legacy");
  const h = harness({ storage });
  assert.equal(h.ui.groqApiKeyInput.value, "gsk_legacy");
  assert.equal(storage.getItem(KEY), null);
  assert.equal(storage.writes, 0);
  assert.match(h.ui.groqKeyStatus.textContent, /Previously saved key is now this tab only/);
  assert.notEqual(harness({ storage }).ui.groqApiKeyInput.value, "gsk_legacy");
  remember(h);
  assert.equal(harness({ storage }).ui.groqApiKeyInput.value, "gsk_legacy");
});

for (const saved of ['{"version":1,', '{"version":1,"remember":false,"key":"gsk_no_consent"}', '{"version":1,"remember":true,"key":123}']) {
  test(`invalid saved record is cleared without being restored: ${saved}`, () => {
    const storage = storageWith(saved);
    const h = harness({ storage });
    // The shared harness starts with a mock input, which should not become stored data.
    assert.equal(h.ui.groqApiKeyInput.value, "mock-key");
    assert.equal(storage.getItem(KEY), null);
    assert.equal(storage.writes, 0);
  });
}

for (const blocked of ["getter", "read"]) {
  test(`blocked storage ${blocked} does not prevent public reporting or tab-only AI`, async () => {
    const storage = blocked === "getter"
      ? () => { throw Error("mock storage access denied"); }
      : { getItem() { throw Error("mock read denied"); }, setItem() { throw Error("mock write denied"); }, removeItem() { throw Error("mock clear denied"); } };
    const h = harness({ storage });
    assert.match(h.ui.groqKeyStatus.textContent, /Browser storage is unavailable/);
    typeKey(h, "gsk_no_storage");
    const report = h.run("public preset or builder report");
    await new Promise(setImmediate);
    h.queries[0].resolve({ schema: { fields: [{ name: "route" }] }, numRows: 1, get: () => ({ route: "4" }) });
    await report;
    assert.deepEqual(h.state().rows, [{ route: "4" }]);
    const ai = h.ask();
    assert.equal(h.generations[0].args[0], "gsk_no_storage");
    h.generations[0].reject(Error("mock API failure")); await ai;
    assert.equal(h.ui.askAiBtn.disabled, false);
  });
}

test("failed remember cleans up the saved copy and retains a tab-only key", () => {
  const storage = storageWith();
  storage.setItem = () => { throw Error("mock quota exceeded"); };
  const h = harness({ storage });
  typeKey(h, "gsk_quota"); remember(h);
  assert.equal(h.ui.groqApiKeyInput.value, "gsk_quota");
  assert.equal(storage.getItem(KEY), null);
  assert.match(h.ui.groqKeyStatus.textContent, /Could not remember.*this tab only/);
});

test("failed removal warns that a saved key may remain and clears the field on Forget", () => {
  const storage = storageWith();
  const h = harness({ storage });
  typeKey(h, "gsk_retained"); remember(h);
  storage.removeItem = () => { throw Error("mock remove denied with sensitive detail"); };
  forget(h);
  assert.equal(h.ui.groqApiKeyInput.value, "");
  assert(storage.getItem(KEY));
  assert.match(h.ui.groqKeyStatus.textContent, /A saved key may remain; clear this site's browser data/);
  assert(!h.ui.groqKeyStatus.textContent.includes("sensitive detail"));
  assert(!h.ui.groqKeyStatus.textContent.includes("gsk_retained"));
});

test("failed legacy cleanup does not claim the key was made tab-only", () => {
  const storage = storageWith("gsk_legacy");
  storage.removeItem = () => { throw Error("mock remove denied"); };
  const h = harness({ storage });
  assert.equal(h.ui.groqApiKeyInput.value, "gsk_legacy");
  assert.equal(storage.getItem(KEY), "gsk_legacy");
  assert.match(h.ui.groqKeyStatus.textContent, /A saved key may remain/);
  assert(!h.ui.groqKeyStatus.textContent.includes("is now this tab only"));
});

test("failed write and removal do not claim that persistence was cleared", () => {
  const storage = storageWith();
  const h = harness({ storage });
  typeKey(h, "gsk_old"); remember(h);
  storage.setItem = () => { throw Error("mock quota exceeded"); };
  storage.removeItem = () => { throw Error("mock remove denied"); };
  typeKey(h, "gsk_new"); remember(h);
  assert.equal(h.ui.groqApiKeyInput.value, "gsk_new");
  assert.match(h.ui.groqKeyStatus.textContent, /A saved key may remain/);
  assert.equal(harness({ storage }).ui.groqApiKeyInput.value, "gsk_old");
});

test("Forget prevents pending Groq fallback and leaves the database connected", async () => {
  const h = harness({ actualGenerator: true });
  const ai = h.ask(); await new Promise(setImmediate);
  forget(h);
  h.apiCalls[0].resolve({ ok: false, status: 429 }); await ai;
  assert.equal(h.apiCalls.length, 1);
  assert.equal(h.queries.length, 0);
  assert.equal(h.ui.groqApiKeyInput.value, "");
  assert.equal(h.ui.askAiBtn.disabled, false);
  assert.equal(h.resources().terminated, 0);
});

test("Forget prevents an AI query failure from sending a correction request", async () => {
  const h = harness();
  const ai = h.ask();
  h.generations[0].resolve({ sql: "bad AI SQL", usedModel: "mock" });
  await new Promise(setImmediate);
  forget(h);
  h.queries[0].reject(Error("binder error")); await ai;
  assert.equal(h.generations.length, 1);
  assert.deepEqual(h.state().rows, []);
  assert.equal(h.resources().terminated, 0);
});

test("Forget does not clear a newer public report while an older AI response is pending", async () => {
  const h = harness();
  const ai = h.ask();
  const report = h.run("public report"); await new Promise(setImmediate);
  h.queries[0].resolve({ schema: { fields: [{ name: "route" }] }, numRows: 1, get: () => ({ route: "4" }) });
  await report;
  forget(h);
  h.generations[0].resolve({ sql: "stale AI SQL", usedModel: "mock" }); await ai;
  assert.equal(h.state().report.title, "public report");
  assert.deepEqual(h.state().rows, [{ route: "4" }]);
});

test("blocked browser storage still allows actual DuckDB initialization to enable public reports", async () => {
  const h = harness({ storage: () => { throw Error("mock storage access denied"); } });
  h.ui.renderPresets = () => {};
  h.ui.populateDatasetDropdown = () => {};
  h.ui.REMOTE_DUCKDB_URL = "https://example.invalid/catalog.duckdb";
  h.ui.Worker = class { addEventListener() {} };
  h.ui.duckdb = {
    VoidLogger: class { log() {} },
    getJsDelivrBundles: () => ({}),
    selectBundle: async () => ({ mainWorker: "worker.js", mainModule: "module.wasm" }),
    AsyncDuckDB: class {
      async instantiate() {}
      async open() {}
      async connect() { return { query: async () => ({ toArray: () => [{ view_name: "simple_bus_routes" }] }) }; }
    }
  };
  h.ui.runBuilderBtn.disabled = true;
  h.ui.runCustomSqlBtn.disabled = true;
  vm.runInContext(source.slice(source.indexOf("    async function initDuckDB()"), source.indexOf("    function populateDatasetDropdown()")), h.ui);
  await h.ui.initDuckDB();
  assert.match(h.ui.dbStatusText.textContent, /Connected/);
  assert.equal(h.ui.runBuilderBtn.disabled, false);
  assert.equal(h.ui.runCustomSqlBtn.disabled, false);
});
