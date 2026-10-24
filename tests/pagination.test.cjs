const test = require("node:test");
const assert = require("node:assert/strict");
const { harness } = require("./report-state.test.cjs");

function table(rows, fields = ["id"]) {
  return { schema: { fields: fields.map(name => ({ name })) }, numRows: rows.length, get: index => rows[index] };
}

async function respond(h, rows, call = null) {
  await new Promise(setImmediate);
  call ||= h.queries.at(-1);
  const match = call.sql.match(/LIMIT (\d+) OFFSET (\d+)$/);
  assert(match, "The execution query must request one page and one lookahead row");
  const [, count, offset] = match.map(Number);
  call.resolve(table(rows.slice(offset, offset + count), Object.keys(rows[0] || { id: 0 })));
}

async function open(h, rows, sql = "SELECT * FROM data.simple_bus_stops") {
  const pending = h.runPage(sql);
  await respond(h, rows); await pending;
}

test("browsing passes 5000 rows while retaining only the current page", async () => {
  const h = harness(); h.ui.rowsPerPage.value = "1000";
  const rows = Array.from({ length: 6505 }, (_, id) => ({ id }));
  await open(h, rows);
  const seen = [];
  do {
    const state = h.state();
    assert(state.rows.length <= 1000);
    seen.push(...state.rows.map(row => Number(row.id)));
    if (!state.report.page.hasMore) break;
    const pending = h.next(); await respond(h, rows); await pending;
  } while (true);
  assert.deepEqual(seen, rows.map(row => row.id));
  assert.equal(h.state().rows.length, 505);
  assert.equal(h.state().report.page.offset, 6000);
  assert.match(h.ui.pageStatus.textContent, /Page 7.*6,001.*6,505.*end of results/);
  assert(h.ui.nextPageBtn.disabled);
  const previous = h.previous(); await respond(h, rows); await previous;
  assert.equal(h.state().report.page.offset, 5000);
  assert.equal(h.state().rows[0].id, "5000");
});

test("page-size changes restart at the first page without adding a report LIMIT", async () => {
  const h = harness();
  const rows = Array.from({ length: 1205 }, (_, id) => ({ id }));
  await open(h, rows);
  assert.equal(h.state().rows.length, 100);
  const next = h.next(); await respond(h, rows); await next;
  assert.equal(h.state().report.page.offset, 100);
  const resized = h.changePageSize(500); await respond(h, rows); await resized;
  assert.equal(h.state().rows.length, 500);
  assert.equal(h.state().report.page.offset, 0);
  assert.deepEqual(h.state().report.page.previous, []);
  assert.equal(h.ui.sqlQueryBox.value, "SELECT * FROM data.simple_bus_stops");
});

test("empty, exact-size, and one-extra-row pages expose correct navigation", async () => {
  for (const count of [0, 100, 101]) {
    const h = harness();
    await open(h, Array.from({ length: count }, (_, id) => ({ id })));
    assert.equal(h.state().rows.length, Math.min(count, 100));
    assert.equal(h.state().report.page.hasMore, count > 100);
    assert(h.ui.previousPageBtn.disabled);
    assert.equal(h.ui.nextPageBtn.disabled, count <= 100);
  }
});

test("page search does not restrict the default report download", async () => {
  const h = harness(); const link = { click() {} };
  h.ui.document.createElement = () => link;
  const rows = Array.from({ length: 150 }, (_, id) => ({ id }));
  await open(h, rows);
  h.filter("149");
  assert.match(h.ui.resultsMeta.textContent, /0 displayed \/ 100 loaded rows on page 1/);
  assert.match(h.ui.resultsScope.textContent, /includes all rows matched by the report SQL/);
  const download = h.export();
  await new Promise(setImmediate);
  assert(!/LIMIT \d+ OFFSET \d+$/.test(h.queries.at(-1).sql));
  h.queries.at(-1).resolve(table(rows));
  await download;
  const text = await h.downloads[0].text();
  assert.equal(text.trimEnd().split("\r\n").length, 151);
  assert(text.endsWith("\r\n149\r\n"));
  assert.match(link.download, /_full\.csv$/);
  assert.equal(h.state().rows.length, 100);
  const next = h.next(); await respond(h, rows); await next;
  assert.match(h.ui.resultsMeta.textContent, /1 displayed \/ 50 loaded rows on page 2/);
});

test("size-limited pages resume at the first unreturned row", async () => {
  const h = harness();
  const rows = Array.from({ length: 80 }, (_, id) => ({ id, text: "x".repeat(100000) }));
  await open(h, rows);
  const first = h.state().rows;
  assert(first.length > 0 && first.length < 80);
  assert(h.state().report.truncated);
  assert(h.state().report.page.hasMore);
  const next = h.next(); await respond(h, rows); await next;
  assert.equal(h.state().report.page.offset, first.length);
  assert.deepEqual([...first, ...h.state().rows].map(row => Number(row.id)), rows.map(row => row.id));
});

test("a stale page cannot replace a newer report", async () => {
  const h = harness();
  const rows = Array.from({ length: 250 }, (_, id) => ({ id }));
  await open(h, rows);
  let focusCalls = 0;
  h.ui.document.body = {};
  h.ui.document.activeElement = h.ui.nextPageBtn;
  h.ui.nextPageBtn.focus = () => { focusCalls++; };
  h.ui.previousPageBtn.focus = () => { focusCalls++; };
  const old = h.next(); await new Promise(setImmediate);
  const oldCall = h.queries.at(-1);
  const current = h.runPage("SELECT * FROM data.simple_bus_routes", "New report");
  h.ui.document.activeElement = h.ui.document.body;
  await respond(h, [{ id: "new" }]); await current;
  await respond(h, rows, oldCall); await old;
  assert.equal(h.state().report.title, "New report");
  assert.deepEqual(h.state().rows, [{ id: "new" }]);
  assert.equal(h.state().report.page.offset, 0);
  assert.equal(focusCalls, 0);
});

test("page failures invalidate old exports and navigation", async () => {
  const h = harness();
  await open(h, Array.from({ length: 250 }, (_, id) => ({ id })));
  const next = h.next(); await new Promise(setImmediate);
  h.queries.at(-1).reject(Error("next-page source failure")); await next;
  assert.deepEqual(h.state().rows, []);
  assert.equal(h.state().report, null);
  assert(h.ui.previousPageBtn.disabled && h.ui.nextPageBtn.disabled && h.ui.exportCsvBtn.disabled);
  assert.match(h.ui.errorBanner.textContent, /next-page source failure/);
});

test("rejected SQL and invalid page offsets never reach report execution", async () => {
  const h = harness();
  h.ui.validateCartaSql = () => { throw Error("policy rejection"); };
  await assert.rejects(h.runPage("blocked"), /policy rejection/);
  assert.equal(h.queries.length, 0);
  const valid = harness();
  await assert.rejects(valid.runPage("SELECT * FROM data.simple_bus_stops", "Invalid", { size: 100, offset: -1, previous: [] }), /Invalid report page/);
  assert.equal(valid.queries.length, 0);
});

test("Stop cancels a page stalled during SQL normalization", async () => {
  const h = harness(); let finish;
  h.ui.normalizeReportSql = () => new Promise(resolve => { finish = resolve; });
  const pending = h.runPage("SELECT * FROM data.simple_bus_stops");
  await new Promise(setImmediate); h.stop(); await pending;
  assert.equal(h.resources().terminated, 1);
  assert(h.ui.nextPageBtn.disabled && h.ui.rowsPerPage.disabled);
  assert.equal(h.queries.length, 0);
  finish({ sql: "SELECT * FROM data.simple_bus_stops", ordered: true });
});
