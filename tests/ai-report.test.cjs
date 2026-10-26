const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { harness } = require("./report-state.test.cjs");
const source = fs.readFileSync(path.join(__dirname, "..", "assets", "app.js"), "utf8");
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
function table(rows) { return { schema: { fields: Object.keys(rows[0] || {}).map(name => ({ name })) }, numRows: rows.length, get: index => rows[index], toArray: () => rows }; }
function setup(options) {
  const h = harness(options);
  h.ui.VIEW_KEYWORDS = {};
  h.ui.DATASET_INFO = { simple_bus_routes: { label: "Bus Routes", desc: "Route directory." } };
  h.ui.matchBestView = () => "gtfsrt_trip_updates_v1";
  h.ui.getColumnsForView = async () => [
    ...Array.from({ length: 15 }, (_, index) => ({ name: `field_${index}`, type: "VARCHAR" })),
    { name: "scheduled_arrival_time", type: "VARCHAR" },
    { name: "predicted_arrival_time", type: "VARCHAR" },
    { name: "geometry", type: "GEOMETRY" }, { name: "payload", type: "BLOB" }
  ];
  vm.runInContext([
    section("    const PRESET_REPORTS", "    // State"),
    'availableViews = PRESET_REPORTS.map(report => report.sql.match(/FROM data\\.(\\w+)/i)[1]);',
    section("    function findStandardReport(", "    function isOffTopicQuestion(")
  ].join("\n"), h.ui);
  return h;
}

test("catalog discovery accepts ordinary phrasing without swallowing specific data questions", () => {
  const h = setup();
  for (const question of [
    "Show me all databases available for CARTA data", "What datasets are available?",
    "Get me the available CARTA tables", "Can you list all datasets, please?",
    "What data can I query?", "What data do you have?", "List CARTA data sources",
    "Which databases are available?", "Available datasets"
  ]) assert.equal(h.ui.isDatasetDiscoveryQuestion(question), true, question);
  for (const question of [
    "Show all bus stops", "Show all CARTA data", "Count all datasets",
    "List datasets containing ridership", "Show tables with latitude",
    "What fields are in bike stations?", "Get bike stations within 25 meters of Route 4",
    "What databases are available in Azure?", "Show databases; DROP TABLE anything"
  ]) assert.equal(h.ui.isDatasetDiscoveryQuestion(question), false, question);
});

test("the dataset-discovery question lists actual catalog entries locally and clears on sign-out", async () => {
  const h = setup();
  vm.runInContext("availableViews = ['simple_bus_routes', 'new_public_dataset'];", h.ui);
  h.ui.quickSearchInput.value = "old report search";
  h.ui.aiQuestionInput.value = "Show me all databases available for CARTA data";
  await h.ask();
  assert.equal(h.generations.length, 0); assert.equal(h.apiCalls.length, 0); assert.equal(h.queries.length, 0);
  assert.deepEqual(h.state().rows, [
    { Dataset: "Bus Routes", Table: "data.simple_bus_routes", Description: "Route directory." },
    { Dataset: "new_public_dataset", Table: "data.new_public_dataset", Description: "No description available." }
  ]);
  assert.equal(h.state().report.title, "CARTA datasets");
  assert.equal(h.ui.sqlQueryBox.value, ""); assert.equal(h.ui.reportPagination.hidden, true);
  assert.equal(h.ui.exportCsvBtn.disabled, true); assert.equal(h.ui.quickSearchInput.disabled, false);
  assert.equal(h.ui.quickSearchInput.value, "");
  assert.match(h.ui.aiStatusText.textContent, /Dataset list ready/);
  h.filter("Route directory"); assert.match(h.ui.resultsSummary.textContent, /1 of 2/);
  const report = h.run("SELECT id FROM data.simple_bus_routes", "Public routes");
  await new Promise(setImmediate); h.queries[0].resolve(table([{ id: "4" }])); await report;
  assert.equal(h.ui.quickSearchInput.value, "");
  assert.deepEqual(h.state().rows, [{ id: "4" }]);
  await h.ask();
  vm.runInContext('aiAuthorized = false; cancelStaffAi("Signed out.");', h.ui);
  assert.deepEqual(h.state().rows, []); assert.equal(h.state().report, null);
});

test("a late AI report cannot replace a newer dataset list", async () => {
  const h = setup(); h.ui.aiQuestionInput.value = "Compare monthly ridership by mode";
  const old = h.ask(); await new Promise(setImmediate);
  h.ui.aiQuestionInput.value = "What datasets are available?"; await h.ask();
  h.generations[0].resolve({ sql: "SELECT * FROM data.simple_bus_routes" }); await old;
  assert.equal(h.generations.length, 1); assert.equal(h.queries.length, 0);
  assert.equal(h.state().report.title, "CARTA datasets");
});

test("dataset discovery through the AI assistant still requires authorization", async () => {
  const h = setup({ authorized: false }); h.ui.aiQuestionInput.value = "List CARTA datasets";
  await h.ask();
  assert.equal(h.state().report, null); assert.equal(h.generations.length, 0); assert.equal(h.queries.length, 0);
});

test("unqualified standard report requests use exact tested queries without swallowing extra requirements", () => {
  const h = setup();
  for (const title of ["Latest Bus Vehicle Positions", "Clever Vehicle Locations", "Stop Predictions (Clever)", "Trip Updates & Delays (GTFS-RT)", "CARTA Bus Routes", "CARTA Bus Stops", "CARTA Monthly Ridership (NTD)", "Bike Chattanooga Stations"]) {
    assert.equal(h.ui.findStandardReport(`Please show me the ${title}.`).title, title);
  }
  assert.equal(h.ui.findStandardReport("Show CARTA Trip Updates & Delays (GTFS-RT)").title, "Trip Updates & Delays (GTFS-RT)");
  assert.equal(h.ui.findStandardReport("List all trip updates and delays").title, "Trip Updates & Delays (GTFS-RT)");
  for (const question of ["Show trip updates for route 4", "Calculate trip delay minutes", "Count CARTA bus routes", "Show the top 5 bus stops", "Show bus stops on Market", "List CARTA routes sorted by name", "Show bus stops and bike stations"]) {
    assert.equal(h.ui.findStandardReport(question), null, question);
  }
  vm.runInContext("availableViews = ['simple_bus_routes'];", h.ui);
  assert.equal(h.ui.findStandardReport("Show trip updates"), null);
});

test("the screenshot browsing request succeeds without an API key, AI calculation or request", async () => {
  const h = setup();
  h.ui.aiQuestionInput.value = "Show CARTA Trip Updates & Delays (GTFS-RT)";
  const pending = h.ask();
  await new Promise(setImmediate);
  assert.equal(h.generations.length, 0);
  assert.equal(h.apiCalls.length, 0);
  assert.match(h.queries[0].sql, /"scheduled_arrival_time"/);
  assert(!/strptime|1970|delay_minutes|geometry/.test(h.queries[0].sql));
  const row = { scheduled_arrival_time: "19:35:57", predicted_arrival_time: "2026-08-18T19:51:00-04:00" };
  h.queries[0].resolve(table([row]));
  await pending;
  assert.deepEqual(h.state().rows, [row]);
  assert.equal(h.state().report.title, "Trip Updates & Delays (GTFS-RT)");
  assert.match(h.ui.aiStatusText.textContent, /standard report; no AI request/);
  assert.match(h.ui.resultsFreshness.textContent, /no observation timestamp/);
});

test("standard report requests still yield to a newer report", async () => {
  const h = setup(); h.ui.aiQuestionInput.value = "Show trip updates";
  const old = h.ask(); await new Promise(setImmediate);
  const current = h.run("newer report"); await new Promise(setImmediate);
  h.queries[1].resolve(table([{ id: "new" }])); await current;
  h.queries[0].resolve(table([{ id: "old" }])); await old;
  assert.deepEqual(h.state().rows, [{ id: "new" }]);
  assert.equal(h.state().report.title, "newer report");
});

test("samples include late-positioned time fields, complete offsets and nulls, with bounded scalar projection", async () => {
  const h = setup(); const queries = [];
  h.ui.mockConn.query = async sql => {
    queries.push(sql);
    return table([
      { scheduled_arrival_time: null, predicted_arrival_time: null, field_0: "x".repeat(97) },
      { scheduled_arrival_time: "25:10:00", predicted_arrival_time: "2026-08-19T01:15:00-04:00", field_0: "public" }
    ]);
  };
  const samples = await h.ui.getSampleRowForView("gtfsrt_trip_updates_v1");
  assert.match(samples, /"scheduled_arrival_time"=null/);
  assert.match(samples, /25:10:00/);
  assert.match(samples, /2026-08-19T01:15:00-04:00/);
  assert.match(samples, /\[truncated\]/);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /^SELECT LEFT\(CAST\("scheduled_arrival_time"/);
  assert.match(queries[0], /, 97\).*LIMIT 3;/);
  assert(!/SELECT \*|geometry|payload/.test(queries[0]));
  assert.equal(await h.ui.getSampleRowForView("gtfsrt_trip_updates_v1"), samples);
  assert.equal(queries.length, 1, "Bounded samples are cached");
});

test("time semantics remain in the schema context when sample retrieval fails", async () => {
  const h = setup(); h.ui.mockConn.query = async () => { throw Error("No sample"); };
  const prompt = await h.ui.buildGroqSchemaPrompt("Compare trip arrival times");
  assert.match(prompt, /no confirmed service date/i);
  assert.match(prompt, /hours >= 24/);
  assert.match(prompt, /MISSING_TIME_CONTEXT/);
});

test("initial and correction requests preserve schema time guidance and the original question", async () => {
  const h = setup({ actualGenerator: true }); const calls = [];
  h.ui.mockConn.query = async () => table([{ scheduled_arrival_time: "19:35:57", predicted_arrival_time: "2026-08-18T19:51:00-04:00" }]);
  h.ui.mockStaffSession.requestReport = async body => {
    calls.push(body); return { sql: 'SELECT "predicted_arrival_time" FROM data.gtfsrt_trip_updates_v1', model: "openai/gpt-oss-120b" };
  };
  const first = await h.ui.generateSqlWithBackend("Show predicted arrival timestamps");
  await h.ui.generateSqlWithBackend("Show predicted arrival timestamps", "invalid timestamp", null, first.generation);
  for (const call of calls) {
    assert.match(call.schema, /no confirmed service date/i);
    assert.match(call.schema, /2026-08-18T19:51:00-04:00/);
    assert.equal(call.question, "Show predicted arrival timestamps");
  }
  assert.equal(calls[1].error, "invalid timestamp");
  assert.deepEqual(Object.keys(calls[1]).sort(), ["error", "model", "question", "schema"]);
});

test("missing time context becomes an actionable message before SQL execution or another API attempt", async () => {
  const h = setup({ actualGenerator: true });
  h.ui.mockConn.query = async () => table([{ scheduled_arrival_time: "19:35:57", predicted_arrival_time: "2026-08-18T19:51:00-04:00" }]);
  for (const response of ["MISSING_TIME_CONTEXT", "```sql\nMISSING_TIME_CONTEXT\n```", "<think>Missing service day</think>MISSING_TIME_CONTEXT"]) {
    assert.throws(() => h.ui.extractSql(response), /confirmed service date and timezone/);
  }
  h.ui.aiQuestionInput.value = "Calculate arrival delay minutes from trip updates";
  const pending = h.ask(); await new Promise(setImmediate);
  h.apiCalls[0].resolve({ sql: "MISSING_TIME_CONTEXT", model: "openai/gpt-oss-120b" });
  await pending;
  assert.equal(h.apiCalls.length, 1);
  assert.equal(h.queries.length, 0);
  assert.match(h.ui.errorBanner.textContent, /Ask to show trip updates/);
  assert.equal(h.ui.exportCsvBtn.disabled, true);
});
