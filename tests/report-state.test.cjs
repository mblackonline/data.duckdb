const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "assets", "app.js"), "utf8");

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
  return { schema: { fields: Object.keys(rows[0] || {}).map(name => ({ name })) }, numRows: rows.length, get: index => rows[index], toArray: () => rows };
}

function harness({ actualGenerator = false, authorized = true, storage = { getItem() { return null; }, setItem() {}, removeItem() {} } } = {}) {
  const queries = [], generations = [], apiCalls = [], downloads = [];
  const context = { console, Blob, TextEncoder, AbortController, AbortSignal, DOMException, setTimeout, clearTimeout, performance: { now: () => 0 } };
  for (const name of ["quickSearchInput", "exportCsvBtn", "resultsMeta", "resultsScope", "resultsFreshness", "sqlQueryBox", "runCustomSqlBtn", "runBuilderBtn", "stopReportBtn", "reconnectBtn", "presetGrid", "dbStatusDot", "dbStatusText", "tableContainer", "errorBanner", "askAiBtn", "aiQuestionInput", "aiStatusText", "groqModelSelect", "aiSettings", "rowsPerPage", "previousPageBtn", "nextPageBtn", "pageStatus", "staffSignInBtn", "staffSignOutBtn", "staffName", "staffAuthStatus", "legacyKeyStatus"]) {
    context[name] = { value: "", textContent: "", innerHTML: "", disabled: false, hidden: false, style: {}, focus() {}, classList: { add() {}, remove() {} }, listeners: new Map(), querySelectorAll: () => [], addEventListener(type, fn) { this.listeners.set(type, fn); } };
  }
  const connections = [];
  context.csvExportStatus = { textContent: "" };
  context.resultsTitle = { textContent: "" };
  context.resultsSummary = { textContent: "" };
  context.resultsFreshnessSummary = { textContent: "" };
  context.reportPagination = { hidden: true };
  context.exportCsvBtn.textContent = "Download report (CSV)";
  let terminated = 0, reloaded = 0;
  Object.assign(context, {
    mockConn: { query(sql) { const pending = deferred(); queries.push({ sql, ...pending }); return pending.promise; } },
    mockDb: {
      connect: async () => {
        const connection = {
          closed: false, cancelled: false,
          send(sql, streaming) {
            assert.equal(streaming, true);
            const pending = deferred(); queries.push({ sql, connection, ...pending });
            return pending.promise.then(table => {
              if (table[Symbol.asyncIterator]) return table;
              const batch = table.numRows === undefined ? result(table.toArray()) : table;
              return { schema: batch.schema, open: async () => {}, cancel: async () => {}, async *[Symbol.asyncIterator]() { yield batch; } };
            });
          },
          cancelSent: async () => { connection.cancelled = true; return true; },
          close: async () => { connection.closed = true; }
        };
        connections.push(connection);
        return connection;
      },
      detach() {}
    },
    mockWorker: { terminate() { terminated++; } },
    location: { reload() { reloaded++; } },
    localStorage: storage,
    GROQ_MODELS: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
    CARTA_NTD_ID: "40001",
    isOffTopicQuestion: () => false,
    findStandardReport: () => null,
    validateCartaSql() {},
    normalizeReportSql: async (parsed, connection, sql) => ({ sql, ordered: true }),
    buildGroqSchemaPrompt: async () => "Table data.simple_bus_routes: name VARCHAR",
    extractSql: sql => sql,
    mockStaffSession: { requestReport(body, signal) { const pending = deferred(); apiCalls.push({ model: body.model, body, signal, ...pending }); return pending.promise; } },
    generateSqlWithBackend(...args) { const pending = deferred(); generations.push({ args, ...pending }); return pending.promise; },
    URL: { createObjectURL(blob) { downloads.push(blob); return "blob:mock"; }, revokeObjectURL() {} },
    document: { createElement: () => ({ click() {} }) }
  });
  if (typeof storage === "function") Object.defineProperty(context, "localStorage", { get: storage });
  context.groqModelSelect.value = "openai/gpt-oss-120b";
  context.aiQuestionInput.value = "List CARTA routes";
  context.reconnectBtn.hidden = true;
  context.rowsPerPage.value = "100";
  vm.createContext(context);
  const blocks = [
    section("    // State", "    // DOM elements"),
    section("    const GROQ_STORAGE_KEY", "    // Setup Tabs"),
    section("    const REPORT_TIME_ZONE", "    // Friendly descriptions"),
    section('    runCustomSqlBtn.addEventListener("click", () => {', "    // Execute a SQL query and render table"),
    section("    // Execute a SQL query and render table", "    // ========================================================================="),
    section('    askAiBtn.addEventListener("click", async () => {', "    function showError("),
    section("    function showError(", "    initDuckDB();")
  ];
  if (actualGenerator) blocks.push(section("    async function generateSqlWithBackend(", '    askAiBtn.addEventListener("click", async () => {'));
  vm.runInContext(blocks.join("\n"), context);
  vm.runInContext("conn = mockConn; db = mockDb; duckdbWorker = mockWorker; staffSession = mockStaffSession;", context);
  vm.runInContext(`aiAuthorized = ${authorized};`, context);
  return {
    ui: context, queries, generations, apiCalls, downloads, connections,
    run: (sql, title = sql) => context.executeQuery(sql, title),
    runPage: (sql, title = sql, page = null) => context.executePagedQuery(sql, title, null, null, page),
    next: () => context.nextPageBtn.listeners.get("click")(),
    previous: () => context.previousPageBtn.listeners.get("click")(),
    changePageSize(value) { context.rowsPerPage.value = String(value); return context.rowsPerPage.listeners.get("change")(); },
    ask: () => context.askAiBtn.listeners.get("click")(),
    filter(value) { context.quickSearchInput.value = value; context.quickSearchInput.listeners.get("input")(); },
    export: () => context.exportCsvBtn.listeners.get("click")(),
    stop: () => context.stopReportBtn.listeners.get("click")(),
    reconnect: () => context.reconnectBtn.listeners.get("click")(),
    resources: () => ({ terminated, reloaded }),
    state: () => JSON.parse(vm.runInContext("JSON.stringify({ rows: currentRows, columns: currentColumns, report: currentReport, requestId: reportRequestId, pendingQueries: activeQueries.size })", context))
  };
}

async function load(h, sql = "initial", rows = [{ stop: "Market" }]) {
  const pending = h.run(sql);
  await new Promise(setImmediate);
  h.queries.at(-1).resolve(result(rows));
  await pending;
}

module.exports = { harness };

if (require.main === module) {
test("application JavaScript syntax is valid", () => {
  new vm.Script(source.replace(/^\s*import .*;\s*$/gm, ""));
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
  await new Promise(setImmediate);
  h.queries.at(-1).resolve(result([{ route: "4" }])); await pending;
  assert.deepEqual(h.state().columns, ["route"]);
  assert.equal(h.ui.quickSearchInput.disabled, false);
  assert.equal(h.ui.exportCsvBtn.disabled, false);
});

test("a failed report cannot restore or export previous rows", async () => {
  const h = harness(); await load(h);
  const pending = h.run("failure");
  await new Promise(setImmediate);
  h.queries.at(-1).reject(Error("network unavailable"));
  await assert.rejects(pending, /network unavailable/);
  const errorTable = h.ui.tableContainer.innerHTML;
  h.filter(""); h.export();
  assert.deepEqual(h.state().rows, []); assert.deepEqual(h.state().columns, []);
  assert.equal(h.state().report, null); assert.equal(h.downloads.length, 0);
  assert.equal(h.ui.tableContainer.innerHTML, errorTable);
  assert.equal(h.ui.errorBanner.textContent, "network unavailable");
  assert.equal(h.ui.exportCsvBtn.textContent, "Download report (CSV)");
});

test("an old success cannot replace a newer report", async () => {
  const h = harness();
  const old = h.run("old"); await new Promise(setImmediate);
  const current = h.run("current");
  await new Promise(setImmediate);
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
  const h = harness(); const old = h.run("old"); await new Promise(setImmediate);
  const current = h.run("current");
  await new Promise(setImmediate);
  h.queries[0].resolve(result([{ old: "outdated" }])); await old;
  assert.equal(h.state().report, null); assert.deepEqual(h.state().rows, []);
  assert.match(h.ui.resultsMeta.textContent, /Running: current/);
  h.queries[1].resolve(result([{ current: "new" }])); await current;
});

test("an old failure cannot overwrite current success or pending state", async () => {
  for (const finishCurrentFirst of [true, false]) {
    const h = harness(); const old = h.run("old"); await new Promise(setImmediate);
    const current = h.run("current");
    await new Promise(setImmediate);
    if (finishCurrentFirst) { h.queries[1].resolve(result([{ current: "new" }])); await current; }
    h.queries[0].reject(Error("outdated error")); await old;
    assert.equal(h.ui.errorBanner.textContent, "");
    assert(!h.ui.resultsMeta.textContent.includes("old"));
    if (!finishCurrentFirst) { h.queries[1].resolve(result([{ current: "new" }])); await current; }
    assert.equal(h.state().report.title, "current");
  }
});

test("a failed current request cannot be replaced by an old successful result", async () => {
  const h = harness(); const old = h.run("old"); await new Promise(setImmediate);
  const current = h.run("current");
  await new Promise(setImmediate);
  h.queries[1].reject(Error("current error")); await assert.rejects(current, /current error/);
  h.queries[0].resolve(result([{ old: "outdated" }])); await old;
  assert.equal(h.state().report, null); assert.deepEqual(h.state().rows, []);
  assert.equal(h.ui.errorBanner.textContent, "current error");
});

test("empty reports remain downloadable, while conversion failures invalidate the report", async () => {
  const h = harness(); await load(h, "empty", []);
  assert.equal(h.ui.exportCsvBtn.disabled, false); assert(h.ui.quickSearchInput.disabled);
  const pending = h.run("conversion failure");
  await new Promise(setImmediate);
  h.queries.at(-1).resolve({ schema: { fields: [{ name: "new" }] }, toArray() { throw Error("bad result"); } });
  await assert.rejects(pending, /bad result/);
  assert.deepEqual(h.state().rows, []); assert.deepEqual(h.state().columns, []);
});

test("a validation failure never reaches the database query method", async () => {
  const h = harness(); await load(h);
  h.ui.validateCartaSql = async () => { throw Error("policy rejected SQL"); };
  await assert.rejects(h.run("blocked"), /policy rejected SQL/);
  assert.equal(h.queries.length, 1);
  assert.deepEqual(h.state().rows, []);
  assert.equal(h.ui.errorBanner.textContent, "policy rejected SQL");
});

test("the manual SQL button uses the execution policy and handles rejection", async () => {
  const h = harness();
  h.ui.sqlQueryBox.value = "blocked SQL";
  h.ui.validateCartaSql = async () => { throw Error("policy rejected SQL"); };
  h.ui.runCustomSqlBtn.listeners.get("click")();
  await new Promise(setImmediate);
  assert.equal(h.queries.length, 0);
  assert.equal(h.ui.errorBanner.textContent, "policy rejected SQL");
  assert.equal(h.ui.exportCsvBtn.disabled, true);
});

test("supersession during validation prevents obsolete SQL from being submitted", async () => {
  const h = harness(); const gate = deferred();
  h.ui.validateCartaSql = () => gate.promise;
  const old = h.run("old");
  h.ui.validateCartaSql = async () => {};
  await load(h, "current", [{ current: "new" }]);
  gate.resolve(); await old;
  assert.equal(h.queries.length, 1);
  assert.equal(h.queries[0].sql, "current");
  assert.equal(h.state().report.title, "current");
});

test("filter counts and CSV contents belong to the latest completed report", async () => {
  const h = harness(); await load(h, "latest", [{ stop: "Market" }, { stop: "Broad" }]);
  h.filter("Market");
  assert.match(h.ui.resultsMeta.textContent, /1 displayed \/ 2 loaded/);
  const download = h.export();
  await new Promise(setImmediate);
  h.queries.at(-1).resolve(result([{ stop: "Market" }, { stop: "Broad" }]));
  await download;
  assert.equal(h.downloads.length, 1);
  assert.equal(await h.downloads[0].text(), "stop\r\nMarket\r\nBroad\r\n");
});

test("superseded AI generation cannot execute SQL or restore old results", async () => {
  const h = harness(); await load(h);
  const ai = h.ask();
  assert.deepEqual(h.state().rows, []); assert.equal(h.ui.sqlQueryBox.value, "");
  const current = h.run("preset");
  await new Promise(setImmediate);
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
  assert.equal(h.ui.aiStatusText.textContent, "Report ready.");
});

test("a failed SQL correction ends the browser request without another AI attempt", async () => {
  const h = harness(); const ai = h.ask();
  h.generations[0].resolve({ sql: "bad AI SQL", usedModel: "mock" }); await new Promise(setImmediate);
  h.queries[0].reject(Error("binder error")); await new Promise(setImmediate);
  h.generations[1].resolve({ sql: "bad correction SQL", usedModel: "mock" }); await new Promise(setImmediate);
  h.queries[1].reject(Error("correction failed")); await ai;
  assert.equal(h.generations.length, 2); assert.equal(h.queries.length, 2);
  assert.match(h.ui.errorBanner.textContent, /correction failed/);
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

test("display output is capped at 5000 rows while report download remains available", async () => {
  const h = harness();
  await load(h, "large report", Array.from({ length: 5001 }, (_, n) => ({ number: n })));
  assert.equal(h.state().rows.length, 5000);
  assert.equal(h.state().report.truncated, true);
  assert.match(h.ui.resultsScope.textContent, /Partial result.*5,000.*row limit/);
  assert.equal(h.ui.exportCsvBtn.disabled, false);
  assert.equal(h.ui.exportCsvBtn.textContent, "Download report (CSV)");
  assert.match(h.ui.resultsMeta.textContent, /\[Partial result\]/);
  assert.equal(h.connections[0].cancelled, true);
  assert.equal(h.connections[0].closed, true);
});

test("exactly 5000 rows are not falsely marked truncated", async () => {
  const h = harness();
  await load(h, "exact cap", Array.from({ length: 5000 }, (_, n) => ({ number: n })));
  assert.equal(h.state().rows.length, 5000); assert.equal(h.state().report.truncated, false);
  assert(!h.ui.exportCsvBtn.textContent.includes("partial"));
});

test("stream consumption stops before reading all batches", async () => {
  const h = harness(); let batches = 0, cancelled = false;
  const pending = h.run("streamed report"); await new Promise(setImmediate);
  h.queries[0].resolve({
    schema: { fields: [{ name: "number" }] },
    open: async () => {},
    cancel: async () => { cancelled = true; },
    async *[Symbol.asyncIterator]() {
      for (let batch = 0; batch < 10; batch++) {
        batches++;
        yield result(Array.from({ length: 750 }, (_, row) => ({ number: batch * 750 + row })));
      }
    }
  });
  await pending;
  assert.equal(batches, 7); assert.equal(h.state().rows.length, 5000);
  assert.equal(cancelled, true); assert.equal(h.connections[0].closed, true);
});

test("stream schema is read only after the Arrow reader opens", async () => {
  const h = harness();
  const pending = h.run("lazy schema"); await new Promise(setImmediate);
  const reader = {
    open: async () => { reader.schema = { fields: [{ name: "number" }] }; },
    cancel: async () => {},
    async *[Symbol.asyncIterator]() { yield result([{ number: 42 }]); }
  };
  h.queries[0].resolve(reader); await pending;
  assert.deepEqual(h.state().rows, [{ number: "42" }]);
  assert.equal(h.connections[0].closed, true);
});

test("an oversized first row fails without exporting a clipped value", async () => {
  const h = harness();
  await assert.rejects(load(h, "large cell", [{ text: "x".repeat(100001) }]), /row is too large/);
  assert.deepEqual(h.state().rows, []); assert.equal(h.ui.exportCsvBtn.disabled, true);
  await load(h, "recovery", [{ text: "normal" }]);
  assert.equal(h.state().report.title, "recovery"); assert.equal(h.resources().terminated, 0);
});

test("a later oversized row stops at a complete row boundary", async () => {
  const h = harness();
  await load(h, "large later cell", [{ text: "first" }, { text: "x".repeat(100001) }, { text: "last" }]);
  assert.deepEqual(h.state().rows, [{ text: "first" }]);
  assert.match(h.ui.resultsScope.textContent, /large cell/);
  assert.equal(h.state().report.truncated, true);
});

test("the output byte budget counts UTF-8 bytes", async () => {
  const h = harness();
  await load(h, "UTF-8 report", Array.from({ length: 30 }, () => ({ text: "😀".repeat(50000) })));
  assert.equal(h.state().rows.length, 26);
  assert.equal(h.state().report.truncated, true);
  assert.match(h.ui.resultsScope.textContent, /output size/);
});

test("excessive columns are rejected and table size is bounded", async () => {
  const h = harness();
  const wide = Object.fromEntries(Array.from({ length: 101 }, (_, n) => ["c" + n, "x"]));
  await assert.rejects(load(h, "too wide", [wide]), /too many columns/);
  const row = Object.fromEntries(Array.from({ length: 100 }, (_, n) => ["c" + n, "x"]));
  await load(h, "many cells", Array.from({ length: 501 }, () => row));
  assert.equal(h.state().rows.length, 500); assert.equal(h.state().report.truncated, true);
});

test("Stop terminates an unresponsive worker and exposes Reconnect", async () => {
  const h = harness(); const pending = h.run("unresponsive"); await new Promise(setImmediate);
  h.stop(); await pending;
  assert.equal(h.resources().terminated, 1); assert.equal(h.ui.reconnectBtn.hidden, false);
  assert.equal(h.ui.runCustomSqlBtn.disabled, true); assert.equal(h.ui.askAiBtn.disabled, true);
  assert.deepEqual(h.state().rows, []); assert.equal(h.state().pendingQueries, 0);
  assert.match(h.ui.errorBanner.textContent, /Report stopped/);
  h.reconnect(); assert.equal(h.resources().reloaded, 1);
});

test("the deadline stops work even when no result is returned", async () => {
  const h = harness(); let deadline;
  h.ui.setTimeout = (fn, ms) => {
    if (ms === 30000) { deadline = fn; return {}; }
    return setTimeout(fn, ms);
  };
  const pending = h.run("timeout"); await new Promise(setImmediate);
  assert.equal(typeof deadline, "function"); deadline(); await pending;
  assert.equal(h.resources().terminated, 1); assert.equal(h.state().pendingQueries, 0);
  assert.match(h.ui.errorBanner.textContent, /30 seconds/);
});

test("Stop also recovers from blocked validation or stream cleanup", async () => {
  const h = harness(); const validation = deferred();
  h.ui.validateCartaSql = () => validation.promise;
  const pending = h.run("blocked validation"); await new Promise(setImmediate);
  h.stop(); await pending;
  assert.equal(h.queries.length, 0); assert.equal(h.state().pendingQueries, 0);
  validation.resolve();

  const h2 = harness(); const cleanup = deferred();
  const pending2 = h2.run("blocked cleanup"); await new Promise(setImmediate);
  h2.connections[0].cancelSent = () => cleanup.promise;
  h2.queries[0].resolve(result(Array.from({ length: 5001 }, (_, n) => ({ n }))));
  await new Promise(setImmediate);
  h2.stop(); await pending2;
  assert.equal(h2.resources().terminated, 1); assert.equal(h2.state().pendingQueries, 0);
  assert.equal(h2.ui.exportCsvBtn.disabled, true); cleanup.resolve(true);
});

test("AI does not retry output-limit or memory-limit failures", async () => {
  for (const memoryFailure of [false, true]) {
    const h = harness(); const ai = h.ask();
    h.generations[0].resolve({ sql: "large AI report", usedModel: "mock" }); await new Promise(setImmediate);
    if (memoryFailure) h.queries[0].reject(Error("Out of Memory Error: allocation failed"));
    else h.queries[0].resolve(result([{ text: "x".repeat(100001) }]));
    await ai;
    assert.equal(h.generations.length, 1); assert.equal(h.ui.exportCsvBtn.disabled, true);
    assert.equal(h.state().pendingQueries, 0);
  }
});

test("overlapping streams use isolated connections", async () => {
  const h = harness();
  const old = h.run("old stream"); await new Promise(setImmediate);
  const current = h.run("current stream"); await new Promise(setImmediate);
  assert.notEqual(h.queries[0].connection, h.queries[1].connection);
  h.queries[1].resolve(result([{ current: "new" }])); await current;
  h.queries[0].resolve(result([{ old: "outdated" }])); await old;
  assert.equal(h.queries[0].connection.cancelled, true);
  assert.equal(h.queries[1].connection.cancelled, false);
  assert.deepEqual(h.state().rows, [{ current: "new" }]);
});

test("backend requests send disclosed context and bind correction to the original preferred model", async () => {
  const h = harness({ actualGenerator: true });
  const requests = [], logs = [];
  h.ui.console = Object.fromEntries(["log", "info", "warn", "error", "debug"].map(method => [method, (...args) => logs.push(args)]));
  vm.runInContext('availableViews = ["simple_bus_routes", "simple_bus_stops"];', h.ui);
  h.ui.VIEW_KEYWORDS = {}; h.ui.matchBestView = () => "simple_bus_routes";
  h.ui.getColumnsForView = async () => [{ name: "name", type: "VARCHAR" }];
  h.ui.mockConn.query = async () => result([{ name: "Public route sample" }]);
  h.ui.mockStaffSession.requestReport = async body => {
    requests.push(body); return { sql: "SELECT * FROM data.simple_bus_routes", model: "openai/gpt-oss-20b" };
  };
  vm.runInContext(section("    const sampleCache", "    function extractSql("), h.ui);
  const generated = await h.ui.generateSqlWithBackend("List CARTA routes");
  h.ui.groqModelSelect.value = "openai/gpt-oss-20b";
  await h.ui.generateSqlWithBackend("List CARTA routes", "Unknown column", null, generated.generation);
  assert.equal(requests.length, 2);
  assert.match(requests[0].schema, /Table data.simple_bus_routes: "name" \(VARCHAR\)/);
  assert.match(requests[0].schema, /Public route sample/);
  assert.match(requests[0].schema, /Other available tables: data.simple_bus_stops/);
  assert.equal(requests[0].question, "List CARTA routes"); assert.equal(requests[0].error, undefined);
  assert.equal(requests[1].error, "Unknown column");
  assert.deepEqual(Object.keys(requests[1]).sort(), ["error", "model", "question", "schema"]);
  assert.equal(requests[1].model, "openai/gpt-oss-120b");
  assert.deepEqual(Object.keys(requests[0]).sort(), ["model", "question", "schema"]);
  assert.deepEqual(logs, []);
});

for (const status of [400, 404, 429, 401]) {
  test(`backend HTTP ${status} never causes a browser model-fallback loop`, async () => {
    const h = harness({ actualGenerator: true });
    const pending = h.ui.generateSqlWithBackend("List CARTA routes");
    const rejected = assert.rejects(pending, /backend failure/);
    await new Promise(setImmediate);
    h.apiCalls[0].reject(Error("backend failure")); await rejected;
    assert.equal(h.apiCalls.length, 1);
  });
}

for (const failStartup of [false, true]) {
  test(`DuckDB startup ${failStartup ? "failure" : "success"} uses a silent logger without console output`, async () => {
    const h = harness();
    const logs = [];
    let suppliedLogger;
    class VoidLogger { log() {} }
    h.ui.console = Object.fromEntries(["log", "info", "warn", "error", "debug", "trace"].map(method => [method, (...args) => logs.push(args)]));
    h.ui.duckdb = {
      VoidLogger,
      getJsDelivrBundles: () => ({}),
      selectBundle: async () => ({ mainWorker: "worker.js", mainModule: "module.wasm" }),
      AsyncDuckDB: class {
        constructor(logger) { suppliedLogger = logger; }
        async instantiate() { if (failStartup) throw Error("mock secret initialization detail"); }
        async open() {}
        async connect() { return { query: async () => result([{ view_name: "simple_bus_routes" }]) }; }
      }
    };
    h.ui.Worker = class { addEventListener() {} };
    h.ui.renderPresets = () => {};
    h.ui.populateDatasetDropdown = () => {};
    h.ui.REMOTE_DUCKDB_URL = "https://example.invalid/catalog.duckdb";
    vm.runInContext(section("    async function initDuckDB()", "    async function populateDatasetDropdown()"), h.ui);
    await h.ui.initDuckDB();
    assert(suppliedLogger instanceof VoidLogger);
    assert.deepEqual(logs, []);
    if (failStartup) {
      assert.equal(h.ui.dbStatusText.textContent, "Connection error");
      assert.match(h.ui.errorBanner.textContent, /mock secret initialization detail/);
    } else {
      assert.match(h.ui.dbStatusText.textContent, /Connected \(1 CARTA datasets ready\)/);
      assert.equal(h.ui.askAiBtn.disabled, false);
    }
  });
}
}
