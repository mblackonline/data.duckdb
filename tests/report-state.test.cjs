const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];

function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert(first >= 0 && last > first, `Missing application section: ${start}`);
  return source.slice(first, last);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function result(rows) {
  return { schema: { fields: Object.keys(rows[0] || {}).map(name => ({ name })) }, toArray: () => rows };
}

function harness({ actualGenerator = false } = {}) {
  const queries = [], generations = [], apiCalls = [], downloads = [];
  const context = { console, Blob, performance: { now: () => 0 } };
  for (const name of ["quickSearchInput", "exportCsvBtn", "resultsMeta", "resultsScope", "resultsFreshness", "sqlQueryBox", "tableContainer", "errorBanner", "askAiBtn", "aiQuestionInput", "groqApiKeyInput", "groqKeyStatus", "aiStatusText", "groqModelSelect"]) {
    context[name] = { value: "", textContent: "", innerHTML: "", disabled: false, style: {}, listeners: new Map(), addEventListener(type, fn) { this.listeners.set(type, fn); } };
  }
  Object.assign(context, {
    mockConn: { query(sql) { const pending = deferred(); queries.push({ sql, ...pending }); return pending.promise; } },
    localStorage: { setItem() {} },
    GROQ_STORAGE_KEY: "mock-storage-key",
    GROQ_MODELS: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
    CARTA_NTD_ID: "40001",
    isOffTopicQuestion: () => false,
    validateCartaSql() {},
    buildGroqSchemaPrompt: async () => "Table data.simple_bus_routes: name VARCHAR",
    extractSql: sql => sql,
    callGroqChat(key, model) { const pending = deferred(); apiCalls.push({ model, ...pending }); return pending.promise; },
    generateSqlWithGroq(...args) { const pending = deferred(); generations.push({ args, ...pending }); return pending.promise; },
    URL: { createObjectURL(blob) { downloads.push(blob); return "blob:mock"; }, revokeObjectURL() {} },
    document: { createElement: () => ({ click() {} }) }
  });
  context.groqApiKeyInput.value = "mock-key";
  context.groqModelSelect.value = "openai/gpt-oss-120b";
  context.aiQuestionInput.value = "List CARTA routes";
  vm.createContext(context);
  const blocks = [
    section("    // State", "    // DOM elements"),
    section("    const REPORT_TIME_ZONE", "    // Friendly descriptions"),
    section("    // Execute a SQL query and render table", "    // ========================================================================="),
    section('    askAiBtn.addEventListener("click", async () => {', "    function showError("),
    section("    function showError(", "    initDuckDB();")
  ];
  if (actualGenerator) blocks.push(section("    async function generateSqlWithGroq(", '    askAiBtn.addEventListener("click", async () => {'));
  vm.runInContext(blocks.join("\n"), context);
  vm.runInContext("conn = mockConn;", context);
  return {
    ui: context, queries, generations, apiCalls, downloads,
    run: (sql, title = sql) => context.executeQuery(sql, title),
    ask: () => context.askAiBtn.listeners.get("click")(),
    filter(value) { context.quickSearchInput.value = value; context.quickSearchInput.listeners.get("input")(); },
    export: () => context.exportCsvBtn.listeners.get("click")(),
    state: () => JSON.parse(vm.runInContext("JSON.stringify({ rows: currentRows, columns: currentColumns, report: currentReport, requestId: reportRequestId })", context))
  };
}

async function load(h, sql = "initial", rows = [{ stop: "Market" }]) {
  const pending = h.run(sql);
  h.queries.at(-1).resolve(result(rows));
  await pending;
}

test("application JavaScript syntax is valid", () => {
  new vm.Script(source.replace(/^\s*import .*;\s*$/m, ""));
});

test("starting a report invalidates old rows and blocks filtering and export", async () => {
  const h = harness(); await load(h);
  const pending = h.run("next");
  assert.deepEqual(h.state().rows, []); assert.deepEqual(h.state().columns, []);
  assert.equal(h.state().report, null);
  assert(h.ui.quickSearchInput.disabled); assert(h.ui.exportCsvBtn.disabled);
  const loading = h.ui.tableContainer.innerHTML;
  h.filter("Market"); h.export();
  assert.equal(h.ui.tableContainer.innerHTML, loading); assert.equal(h.downloads.length, 0);
  h.queries.at(-1).resolve(result([{ route: "4" }])); await pending;
  assert.deepEqual(h.state().columns, ["route"]);
  assert.equal(h.ui.quickSearchInput.disabled, false);
  assert.equal(h.ui.exportCsvBtn.disabled, false);
});

test("a failed report cannot restore or export previous rows", async () => {
  const h = harness(); await load(h);
  const pending = h.run("failure");
  h.queries.at(-1).reject(Error("network unavailable"));
  await assert.rejects(pending, /network unavailable/);
  const errorTable = h.ui.tableContainer.innerHTML;
  h.filter(""); h.export();
  assert.deepEqual(h.state().rows, []); assert.deepEqual(h.state().columns, []);
  assert.equal(h.state().report, null); assert.equal(h.downloads.length, 0);
  assert.equal(h.ui.tableContainer.innerHTML, errorTable);
  assert.equal(h.ui.errorBanner.textContent, "network unavailable");
  assert.equal(h.ui.exportCsvBtn.textContent, "Download loaded rows (CSV)");
});

test("an old success cannot replace a newer report", async () => {
  const h = harness();
  const old = h.run("old"); const current = h.run("current");
  h.queries[1].resolve(result([{ current_column: "new" }])); await current;
  const view = h.ui.tableContainer.innerHTML;
  h.queries[0].resolve(result([{ old_column: "old" }])); await old;
  assert.equal(h.state().report.title, "current");
  assert.deepEqual(h.state().columns, ["current_column"]);
  assert.deepEqual(h.state().rows, [{ current_column: "new" }]);
  assert.equal(h.ui.tableContainer.innerHTML, view);
  assert.equal(h.ui.sqlQueryBox.value, "current");
});

test("an old success stays hidden while the current query is pending", async () => {
  const h = harness(); const old = h.run("old"); const current = h.run("current");
  h.queries[0].resolve(result([{ old: "outdated" }])); await old;
  assert.equal(h.state().report, null); assert.deepEqual(h.state().rows, []);
  assert.match(h.ui.resultsMeta.textContent, /Running: current/);
  h.queries[1].resolve(result([{ current: "new" }])); await current;
});

test("an old failure cannot overwrite current success or pending state", async () => {
  for (const finishCurrentFirst of [true, false]) {
    const h = harness(); const old = h.run("old"); const current = h.run("current");
    if (finishCurrentFirst) { h.queries[1].resolve(result([{ current: "new" }])); await current; }
    h.queries[0].reject(Error("outdated error")); await old;
    assert.equal(h.ui.errorBanner.textContent, "");
    assert(!h.ui.resultsMeta.textContent.includes("old"));
    if (!finishCurrentFirst) { h.queries[1].resolve(result([{ current: "new" }])); await current; }
    assert.equal(h.state().report.title, "current");
  }
});

test("a failed current request cannot be replaced by an old successful result", async () => {
  const h = harness(); const old = h.run("old"); const current = h.run("current");
  h.queries[1].reject(Error("current error")); await assert.rejects(current, /current error/);
  h.queries[0].resolve(result([{ old: "outdated" }])); await old;
  assert.equal(h.state().report, null); assert.deepEqual(h.state().rows, []);
  assert.equal(h.ui.errorBanner.textContent, "current error");
});

test("empty results and conversion failures leave no exportable data", async () => {
  const h = harness(); await load(h, "empty", []);
  assert(h.ui.exportCsvBtn.disabled); assert(h.ui.quickSearchInput.disabled);
  const pending = h.run("conversion failure");
  h.queries.at(-1).resolve({ schema: { fields: [{ name: "new" }] }, toArray() { throw Error("bad result"); } });
  await assert.rejects(pending, /bad result/);
  assert.deepEqual(h.state().rows, []); assert.deepEqual(h.state().columns, []);
});

test("filter counts and CSV contents belong to the latest completed report", async () => {
  const h = harness(); await load(h, "latest", [{ stop: "Market" }, { stop: "Broad" }]);
  h.filter("Market");
  assert.match(h.ui.resultsMeta.textContent, /1 displayed \/ 2 loaded/);
  h.export(); assert.equal(h.downloads.length, 1);
  assert.equal(await h.downloads[0].text(), "stop\r\nMarket\r\nBroad");
});

test("superseded AI generation cannot execute SQL or restore old results", async () => {
  const h = harness(); await load(h);
  const ai = h.ask();
  assert.deepEqual(h.state().rows, []); assert.equal(h.ui.sqlQueryBox.value, "");
  const current = h.run("preset");
  h.queries.at(-1).resolve(result([{ preset: "current" }])); await current;
  h.generations[0].resolve({ sql: "outdated AI SQL", usedModel: "mock" }); await ai;
  assert.equal(h.queries.length, 2); assert.equal(h.state().report.title, "preset");
  assert.equal(h.ui.sqlQueryBox.value, "preset"); assert.equal(h.ui.askAiBtn.disabled, false);
});

test("superseded AI errors do not overwrite a current report", async () => {
  const h = harness(); const ai = h.ask();
  await load(h, "preset", [{ preset: "current" }]);
  h.generations[0].reject(Error("outdated Groq error")); await ai;
  assert.equal(h.state().report.title, "preset"); assert.equal(h.ui.errorBanner.textContent, "");
});

test("superseded AI correction cannot submit its retry SQL", async () => {
  const h = harness(); const ai = h.ask();
  h.generations[0].resolve({ sql: "bad AI SQL", usedModel: "mock" });
  await new Promise(setImmediate);
  h.queries[0].reject(Error("binder error")); await new Promise(setImmediate);
  assert.equal(h.generations.length, 2);
  await load(h, "preset", [{ preset: "current" }]);
  h.generations[1].resolve({ sql: "old retry SQL", usedModel: "mock" }); await ai;
  assert.equal(h.queries.length, 2); assert.equal(h.state().report.title, "preset");
});

test("current AI self-correction can still succeed", async () => {
  const h = harness(); const ai = h.ask();
  h.generations[0].resolve({ sql: "bad AI SQL", usedModel: "mock" }); await new Promise(setImmediate);
  h.queries[0].reject(Error("binder error")); await new Promise(setImmediate);
  h.generations[1].resolve({ sql: "fixed AI SQL", usedModel: "mock" }); await new Promise(setImmediate);
  h.queries[1].resolve(result([{ route: "4" }])); await ai;
  assert.deepEqual(h.state().rows, [{ route: "4" }]);
  assert.equal(h.ui.sqlQueryBox.value, "fixed AI SQL"); assert.equal(h.ui.errorBanner.textContent, "");
  assert.equal(h.ui.askAiBtn.disabled, false);
});

test("an older AI completion cannot enable the button for a newer AI request", async () => {
  const h = harness(); const old = h.ask(); const current = h.ask();
  h.generations[0].resolve({ sql: "old", usedModel: "mock" }); await old;
  assert.equal(h.ui.askAiBtn.disabled, true);
  h.generations[1].reject(Error("current generation failure")); await current;
  assert.equal(h.ui.askAiBtn.disabled, false); assert.deepEqual(h.state().rows, []);
});

test("superseded actual Groq generation does not try another model", async () => {
  const h = harness({ actualGenerator: true }); const ai = h.ask(); await new Promise(setImmediate);
  assert.equal(h.apiCalls.length, 1);
  await load(h, "preset", [{ preset: "current" }]);
  h.apiCalls[0].resolve({ ok: false, status: 429 }); await ai;
  assert.equal(h.apiCalls.length, 1); assert.equal(h.state().report.title, "preset");
});
