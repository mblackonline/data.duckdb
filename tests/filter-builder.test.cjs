const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "assets/app.js"), "utf8");
const builderSource = source.slice(source.indexOf("    async function populateDatasetDropdown()"), source.indexOf('    runCustomSqlBtn.addEventListener("click"'));

class Control {
  constructor() { this.options = []; this.listeners = {}; this.value = ""; this.disabled = false; this.textContent = ""; }
  set innerHTML(value) {
    this.options = [];
    this.value = "";
    for (const match of value.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)) this.appendChild({ value: match[1], textContent: match[2] });
  }
  appendChild(option) { if (!this.options.length) this.value = option.value; this.options.push(option); }
  addEventListener(event, callback) { this.listeners[event] = callback; }
  focus() { this.focused = true; }
}

function harness(columns = [
  { name: "fee", type: "VARCHAR" }, { name: "capacity", type: "INTEGER" },
  { name: "date", type: "DATE" }, { name: "active", type: "BOOLEAN" },
  { name: "geometry", type: "STRUCT(x DOUBLE, y DOUBLE)" }
]) {
  const queries = [], reports = [];
  const context = {
    Set, Number, Error, schemaCache: { stations: columns }, availableViews: ["stations", "other"], DATASET_INFO: {},
    document: { createElement: () => ({ value: "", textContent: "" }) },
    conn: { query: async sql => { queries.push(sql); return { get: () => ({ valid: true }) }; } },
    executePagedQuery: async (sql, label) => { reports.push({ sql, label }); }
  };
  for (const name of ["builderDataset", "builderColumn", "builderOperator", "builderValue", "builderHelp", "builderError", "builderSortCol", "builderSortDir", "runBuilderBtn"]) context[name] = new Control();
  context.builderDataset.value = "stations";
  context.builderSortDir.value = "ASC";
  vm.createContext(context);
  vm.runInContext(builderSource, context);
  return {
    ui: context, queries, reports,
    async load(view = "stations") { context.builderDataset.value = view; await context.loadColumnsForDataset(view); },
    choose(name) { context.builderColumn.value = name; context.builderColumn.listeners.change(); },
    condition(value) { context.builderOperator.value = value; context.builderOperator.listeners.change(); },
    value(value) { context.builderValue.value = value; context.builderValue.listeners.input(); },
    run: () => context.runBuilderBtn.listeners.click(),
    conditions: () => context.builderOperator.options.map(option => option.value)
  };
}

module.exports = { harness };

if (require.main === module) {

test("reports omit WKT and native geometry payloads while preserving every other column", async () => {
  for (const type of ["VARCHAR", "GEOMETRY"]) {
    const h = harness([
      { name: "id", type: "VARCHAR" }, { name: 'display"name', type: "VARCHAR" },
      { name: "geometry", type }, { name: "capacity", type: "INTEGER" }
    ]);
    await h.load(); await h.run();
    assert.equal(h.reports[0].sql, 'SELECT "id", "display""name", "capacity" FROM data."stations";');
  }
});
test("numeric-looking text stays quoted, including leading zeros and spaces", async () => {
  const h = harness(); await h.load(); h.choose("fee"); h.condition("="); h.value(" 001 "); await h.run();
  assert.match(h.reports[0].sql, /WHERE "fee" = ' 001 '/);
  assert.equal(h.queries.length, 0);
});

test("original fee > 1 scenario is unavailable and rejected with guidance if forced", async () => {
  const h = harness(); await h.load(); h.choose("fee");
  assert(!h.conditions().includes(">")); assert(h.conditions().includes("ILIKE_CONTAINS"));
  assert.match(h.ui.builderHelp.textContent, /contains text/);
  h.condition(">"); h.value("1"); await h.run();
  assert.equal(h.reports.length, 0); assert.equal(h.queries.length, 0);
  assert.match(h.ui.builderError.textContent, /contains text/);
  assert(h.ui.builderOperator.focused);
});

test("numeric conditions come from schema and keep exact decimal and large integer thresholds", async () => {
  const h = harness(); await h.load(); h.choose("capacity");
  assert(!h.conditions().includes("ILIKE_CONTAINS")); assert(h.conditions().includes(">="));
  h.condition(">"); h.value("1.5"); await h.run();
  assert.match(h.reports[0].sql, /"capacity" > 1\.5/);
  h.value("9007199254740993"); await h.run();
  assert.match(h.reports[1].sql, /"capacity" > 9007199254740993/);
});

for (const value of ["", " ", "Market", "1,000", "0x10", "Infinity", "NaN", "1e999", "1 OR true", "1; SELECT 1"]) {
  test(`invalid numeric input ${JSON.stringify(value)} never runs a report`, async () => {
    const h = harness(); await h.load(); h.choose("capacity"); h.condition(">"); h.value(value); await h.run();
    assert.equal(h.reports.length, 0); assert.equal(h.queries.length, 0);
    assert.match(h.ui.builderError.textContent, /Enter/);
  });
}

test("blank text input requires an explicit condition rather than silently omitting the filter", async () => {
  const h = harness(); await h.load(); h.choose("fee"); h.condition("="); h.value(""); await h.run();
  assert.match(h.ui.builderError.textContent, /Enter a filter value/); assert.equal(h.reports.length, 0);
  h.condition("EMPTY_TEXT"); assert(h.ui.builderValue.disabled); await h.run();
  assert.equal(h.ui.builderError.textContent, ""); assert.match(h.reports[0].sql, /"fee" = ''/);
});

test("null checks ignore the disabled value and work for every field type", async () => {
  const h = harness(); await h.load();
  for (const name of ["fee", "capacity", "date", "active", "geometry"]) {
    h.choose(name);
    for (const condition of ["IS NULL", "IS NOT NULL"]) {
      h.condition(condition); h.value("ignored"); assert(h.ui.builderValue.disabled); await h.run();
      assert(h.reports.at(-1).sql.includes(`"${name}" ${condition}`));
    }
  }
  assert.equal(h.queries.length, 0);
});

test("dates use a checked typed value and reject invalid calendar dates before report execution", async () => {
  const h = harness(); await h.load(); h.choose("date"); h.condition(">="); h.value("2026-10-25"); await h.run();
  assert.match(h.queries[0], /TRY_CAST\('2026-10-25' AS DATE\)/);
  assert.match(h.reports[0].sql, /"date" >= CAST\('2026-10-25' AS DATE\)/);
  h.ui.conn.query = async () => ({ get: () => ({ valid: false }) });
  h.value("2026-02-30"); await h.run();
  assert.equal(h.reports.length, 1); assert.match(h.ui.builderError.textContent, /Enter a valid date or time/);
});

test("boolean values accept only true or false", async () => {
  const h = harness(); await h.load(); h.choose("active"); h.condition("=");
  h.value("yes"); await h.run(); assert.equal(h.reports.length, 0); assert.match(h.ui.builderError.textContent, /true or false/);
  h.value("TRUE"); await h.run(); assert.match(h.reports[0].sql, /CAST\('TRUE' AS BOOLEAN\)/);
});

test("unsupported types expose only null checks and do not accept injected type names", async () => {
  const h = harness([{ name: "value", type: "VARCHAR); SELECT 1; --" }]); await h.load(); h.choose("value");
  assert.deepEqual(h.conditions(), ["IS NULL", "IS NOT NULL"]);
  h.condition("="); h.value("1"); await h.run(); assert.equal(h.reports.length, 0); assert.equal(h.queries.length, 0);
});

test("field changes reset values, update conditions, and disable unused controls", async () => {
  const h = harness(); await h.load();
  assert(h.ui.builderOperator.disabled); assert(h.ui.builderValue.disabled);
  h.choose("capacity"); h.condition(">"); h.value("123"); h.choose("fee");
  assert.equal(h.ui.builderValue.value, ""); assert.equal(h.ui.builderOperator.value, "ILIKE_CONTAINS");
  assert.equal(h.ui.builderValue.disabled, false);
  h.choose(""); assert(h.ui.builderValue.disabled); await h.run();
  assert.equal(h.reports[0].sql, 'SELECT "fee", "capacity", "date", "active" FROM data."stations";');
});

test("identifier quotes, apostrophes, and LIKE wildcard characters remain literal", async () => {
  const h = harness([{ name: 'a"b', type: "VARCHAR" }]); await h.load(); h.choose('a"b');
  h.condition("ILIKE_CONTAINS"); h.value("O'Brien 50%_$"); await h.run();
  assert.equal(h.reports[0].sql, `SELECT "a""b" FROM data."stations" WHERE "a""b" ILIKE '%O''Brien 50$%$_$$%' ESCAPE '$';`);
  h.condition("="); await h.run(); assert.match(h.reports[1].sql, /'O''Brien 50%_\$'/);
  h.condition("ILIKE_STARTS"); h.value("A_"); await h.run(); assert.match(h.reports[2].sql, /ILIKE 'A\$_%' ESCAPE '\$'/);
});

test("invalid sort columns, directions, datasets, and filter columns cannot run SQL", async () => {
  const cases = [
    h => { h.ui.builderSortCol.value = "absent"; },
    h => { h.ui.builderSortDir.value = "ASC; SELECT 1"; },
    h => { h.ui.builderDataset.value = "absent"; },
    h => { h.ui.builderColumn.value = "absent"; }
  ];
  for (const change of cases) {
    const h = harness(); await h.load(); change(h); await h.run();
    assert.equal(h.reports.length, 0); assert(h.ui.builderError.textContent);
  }
});

test("an older dataset schema cannot replace the currently selected dataset", async () => {
  const h = harness(); let finish;
  h.ui.schemaCache = {};
  h.ui.conn.query = () => new Promise(resolve => { finish = resolve; });
  const first = h.load(); assert(h.ui.runBuilderBtn.disabled);
  h.ui.schemaCache.other = [{ name: "other_number", type: "DOUBLE" }];
  await h.load("other"); h.choose("other_number");
  finish({ toArray: () => [{ column_name: "fee", column_type: "VARCHAR" }] }); await first;
  assert.deepEqual(h.ui.builderColumn.options.map(o => o.value), ["", "other_number"]);
  assert(h.conditions().includes(">")); assert.equal(h.ui.runBuilderBtn.disabled, false);
});

test("failed schema loads stay disabled and can be retried", async () => {
  const h = harness(); h.ui.conn.query = async () => { throw Error("raw internal detail"); };
  await h.load("other"); assert(h.ui.runBuilderBtn.disabled); assert.match(h.ui.builderError.textContent, /Could not load/);
  await h.run(); assert.equal(h.reports.length, 0);
  h.ui.schemaCache.other = [{ name: "number", type: "INTEGER" }]; await h.load("other");
  assert.equal(h.ui.runBuilderBtn.disabled, false); assert.equal(h.ui.builderError.textContent, "");
});

test("editing during value validation prevents an outdated report and outdated errors", async () => {
  for (const valid of [true, false]) {
    const h = harness(); await h.load(); h.choose("date"); h.condition("="); h.value("2026-10-25");
    let finish; h.ui.conn.query = () => new Promise(resolve => { finish = resolve; });
    const pending = h.run(); h.choose("fee");
    finish({ get: () => ({ valid }) }); await pending;
    assert.equal(h.reports.length, 0); assert.equal(h.ui.builderError.textContent, "");
  }
});
}
