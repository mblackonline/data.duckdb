const test = require("node:test");
const assert = require("node:assert/strict");
const { harness } = require("./report-state.test.cjs");
const { readCsv } = require("./csv-export.test.cjs");

const tick = () => new Promise(setImmediate);
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("Expected asynchronous export state was not reached");
}
function gate() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function table(rows, columns = Object.keys(rows[0] || { id: 0 })) {
  return { schema: { fields: columns.map(name => ({ name })) }, numRows: rows.length, get: index => rows[index] };
}
function stream(count, makeRow = index => ({ id: index }), columns = Object.keys(makeRow(0)), batchSize = 128) {
  return {
    schema: { fields: columns.map(name => ({ name })) }, open: async () => {}, cancel: async () => {},
    async *[Symbol.asyncIterator]() {
      for (let start = 0; start < count; start += batchSize) {
        yield { numRows: Math.min(batchSize, count - start), get: index => makeRow(start + index) };
      }
    }
  };
}
async function open(h, sql = "SELECT id FROM data.simple_bus_routes", rows = [{ id: 100 }]) {
  const pending = h.runPage(sql, "Loaded report");
  await tick();
  h.queries.at(-1).resolve(table(rows));
  await pending;
}
function disk(h, overrides = {}) {
  const writes = [];
  const writer = {
    closed: 0, aborted: 0,
    async write(chunk) { writes.push(Buffer.from(chunk)); },
    async close() { this.closed++; }, async abort() { this.aborted++; }, ...overrides
  };
  h.ui.showSaveFilePicker = async () => ({ createWritable: async () => writer });
  return { writer, writes };
}
async function respond(h, reader) {
  await tick();
  const query = h.queries.at(-1);
  assert(!/LIMIT \d+ OFFSET \d+$/.test(query.sql), "Full export must not use the page query");
  query.resolve(reader);
}

test("full CSV exports every matching row beyond page, row and cell caps, without changing the page or applying search", async () => {
  const h = harness();
  const sql = "SELECT * FROM data.simple_bus_routes ORDER BY id DESC LIMIT 6505; -- explicit request";
  await open(h, sql);
  h.filter("not on this page");
  h.ui.sqlQueryBox.value = "unexecuted editor changes";
  const before = h.state();
  const link = { click() {} };
  h.ui.document.createElement = () => link;
  const pending = h.export();
  await respond(h, stream(6505, index => ({ id: 6504 - index, text: "=1+2", identifier: "00123", negative: -85.3, unicode: "Café 😀", cr: "a\rb", lf: "a\nb", quotes: 'a,"b"', blank: null })));
  assert.match(h.queries.at(-1).sql, /LIMIT 6505; -- explicit request/);
  await pending;
  assert.equal(h.downloads.length, 1);
  const bytes = Buffer.from(await h.downloads[0].arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
  const csv = readCsv(bytes);
  assert.equal(csv.length, 6506);
  assert.deepEqual(csv[1], ["6504", "\t=1+2", "00123", "-85.3", "Café 😀", "a\rb", "a\nb", 'a,"b"', ""]);
  assert.equal(csv.at(-1)[0], "0");
  assert.deepEqual(h.state().rows, before.rows);
  assert.deepEqual(h.state().report, before.report);
  assert.match(link.download, /_full\.csv$/);
  assert.match(h.ui.csvExportStatus.textContent, /6,505 rows.*Page search was not applied/);
  assert.equal(h.ui.exportCsvBtn.disabled, false);
  assert.equal(h.state().pendingQueries, 0);
});

test("an empty matching result produces a header-only full CSV with protected headers", async () => {
  const h = harness(); await open(h, undefined, []);
  assert.equal(h.ui.exportCsvBtn.disabled, false);
  const pending = h.export();
  await respond(h, stream(0, () => ({ "=header": 0 }), ["=header"]));
  await pending;
  assert.deepEqual(readCsv(Buffer.from(await h.downloads[0].arrayBuffer())), [["\t=header"]]);
  assert.match(h.ui.csvExportStatus.textContent, /0 rows/);
});

test("direct file writes apply backpressure and stream over 20 MiB without retaining exported rows", async () => {
  const h = harness(); await open(h);
  const blocked = gate();
  let writing = false, bytes = 0, largest = 0, calls = 0, fetched = 0;
  const { writer } = disk(h, { async write(chunk) {
    assert.equal(writing, false, "File writes must be sequential");
    writing = true; calls++; bytes += chunk.byteLength; largest = Math.max(largest, chunk.byteLength);
    if (calls === 1) await blocked.promise;
    writing = false;
  } });
  const pending = h.export();
  await respond(h, stream(300, index => { fetched++; return { id: index, text: "x".repeat(90000) }; }, ["id", "text"]));
  await tick();
  assert.equal(calls, 1);
  assert(fetched <= 3, "A blocked writer must stop fetching rows");
  blocked.resolve(); await pending;
  assert(bytes > 20 * 1024 * 1024);
  assert(largest <= 256 * 1024);
  assert.equal(writer.closed, 1); assert.equal(writer.aborted, 0);
  assert.equal(h.downloads.length, 0);
  assert.deepEqual(h.state().rows, [{ id: "100" }]);
  assert.match(h.ui.csvExportStatus.textContent, /^Saved.*300 rows/);
});

test("fallback downloads fail completely above the byte budget, retaining the current page", async () => {
  const h = harness(); await open(h);
  const pending = h.export();
  await respond(h, stream(300, index => ({ id: index, text: "x".repeat(90000) }), ["id", "text"]));
  await pending;
  assert.equal(h.downloads.length, 0);
  assert.match(h.ui.csvExportStatus.textContent, /20 MiB/);
  assert.equal(h.connections.at(-1).cancelled, true);
  assert.deepEqual(h.state().rows, [{ id: "100" }]);
  assert.equal(h.ui.exportCsvBtn.disabled, false);
});

test("column, cell, header and encoded-row limits abort the entire CSV rather than publishing a prefix", async () => {
  const wide = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`c${i}`, i]));
  const largeRow = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`c${i}`, '"'.repeat(40000)]));
  for (const [row, pattern] of [[wide, /columns/], [{ text: "x".repeat(100001) }, /cell/], [{ ["x".repeat(100001)]: 1 }, /cell/], [largeRow, /row/]]) {
    const h = harness(); await open(h);
    const { writer } = disk(h);
    const pending = h.export();
    await respond(h, stream(1, () => row)); await pending; await tick();
    assert.equal(writer.closed, 0); assert.equal(writer.aborted, 1);
    assert.match(h.ui.csvExportStatus.textContent, pattern);
    assert.equal(h.downloads.length, 0);
  }
});

test("SQL policy is rechecked at export execution and rejection never submits a data query", async () => {
  const h = harness(); await open(h);
  const { writer } = disk(h);
  h.ui.validateCartaSql = async () => { throw Error("Policy rejected export"); };
  await h.export(); await tick();
  assert.equal(h.queries.length, 1);
  assert.equal(writer.closed, 0); assert.equal(writer.aborted, 1);
  assert.match(h.ui.csvExportStatus.textContent, /Policy rejected export/);
});

test("picker cancellation preserves the loaded page and never starts a database export", async () => {
  const h = harness(); await open(h);
  h.ui.showSaveFilePicker = async () => { const error = Error("Canceled"); error.name = "AbortError"; throw error; };
  await h.export();
  assert.equal(h.queries.length, 1);
  assert.match(h.ui.csvExportStatus.textContent, /Export canceled/);
  assert.equal(h.resources().terminated, 0);
  assert.equal(h.ui.exportCsvBtn.disabled, false);
});

test("Stop aborts a stalled file write, publishes no CSV, and offers recovery", async () => {
  const h = harness(); await open(h);
  const blocked = gate(); let writes = 0;
  const { writer } = disk(h, { async write() { writes++; await blocked.promise; } });
  const pending = h.export();
  await respond(h, stream(5)); await until(() => writes === 1);
  assert.equal(writes, 1);
  h.stop(); await pending; await tick();
  assert.equal(writer.aborted, 1); assert.equal(writer.closed, 0);
  assert.equal(h.resources().terminated, 1);
  assert.equal(h.ui.reconnectBtn.hidden, false);
  assert.equal(h.ui.exportCsvBtn.disabled, true);
  blocked.resolve(); await tick(); await tick();
  assert.equal(writer.closed, 0); assert.equal(writes, 1);
  assert.doesNotMatch(h.ui.csvExportStatus.textContent, /^Saved/);
});

test("a new report cancels an export without letting late progress or completion overwrite the new state", async () => {
  const h = harness(); await open(h);
  const blocked = gate();
  const { writer } = disk(h, { async write() { await blocked.promise; } });
  const pending = h.export(); await respond(h, stream(5)); await tick();
  await open(h, "SELECT id FROM data.simple_bus_routes WHERE id=4", [{ id: 4 }]);
  const canceled = h.ui.csvExportStatus.textContent;
  blocked.resolve(); await pending; await tick();
  assert.equal(writer.aborted, 1); assert.equal(writer.closed, 0);
  assert.deepEqual(h.state().rows, [{ id: "4" }]);
  assert.equal(h.ui.csvExportStatus.textContent, canceled);
  assert.equal(h.ui.exportCsvBtn.disabled, false);
});

test("a late picker result after Stop never opens a writer or executes SQL", async () => {
  const h = harness(); await open(h);
  const blocked = gate(); let opened = 0;
  h.ui.showSaveFilePicker = () => blocked.promise;
  const pending = h.export();
  h.stop(); await pending;
  blocked.resolve({ createWritable: async () => { opened++; } });
  await tick();
  assert.equal(opened, 0); assert.equal(h.queries.length, 1);
});

test("filesystem write, close, and database cleanup failures never claim a successful save", async () => {
  for (const stage of ["write", "close", "cleanup"]) {
    const h = harness(); await open(h);
    const { writer } = disk(h, stage === "cleanup" ? {} : { async [stage]() { throw Error(`${stage} failed`); } });
    const pending = h.export();
    await tick();
    if (stage === "cleanup") h.connections.at(-1).close = async () => { throw Error("cleanup failed"); };
    h.queries.at(-1).resolve(stream(5));
    await pending; await tick();
    assert.equal(writer.closed, 0); assert.equal(writer.aborted, 1);
    assert.match(h.ui.csvExportStatus.textContent, new RegExp(`${stage} failed`));
    assert.doesNotMatch(h.ui.csvExportStatus.textContent, /^Saved/);
  }
});

test("the watchdog covers a stalled writer creation and aborts a writer that arrives after timeout", async () => {
  const h = harness(); await open(h);
  const blocked = gate();
  const { writer } = disk(h);
  h.ui.showSaveFilePicker = async () => ({ createWritable: () => blocked.promise });
  h.ui.setTimeout = (fn, ms) => setTimeout(fn, ms === 30000 ? 10 : ms);
  await h.export();
  assert.equal(h.resources().terminated, 1);
  blocked.resolve(writer); await tick();
  assert.equal(writer.aborted, 1); assert.equal(writer.closed, 0);
  assert.equal(h.queries.length, 1);
  assert.match(h.ui.csvExportStatus.textContent, /Export stopped/);
});

test("a stalled final commit is aborted by the watchdog and never reported as a confirmed save", async () => {
  const h = harness(); await open(h);
  const blocked = gate(); let closing = false;
  const { writer } = disk(h, { async close() { closing = true; await blocked.promise; } });
  h.ui.setTimeout = (fn, ms) => setTimeout(fn, ms === 30000 ? 50 : ms);
  const pending = h.export(); await respond(h, stream(1));
  await until(() => closing); await pending; await tick();
  assert.equal(writer.aborted, 1);
  assert.match(h.ui.csvExportStatus.textContent, /saving could not be confirmed/);
  blocked.resolve(); await tick();
  assert.doesNotMatch(h.ui.csvExportStatus.textContent, /^Saved/);
  assert.equal(h.ui.exportCsvBtn.disabled, true);
});

test("starting a new report clears a completed export's old status", async () => {
  const h = harness(); await open(h);
  const pending = h.export(); await respond(h, stream(1)); await pending;
  assert.match(h.ui.csvExportStatus.textContent, /^Download ready for/);
  await open(h, "SELECT id FROM data.simple_bus_routes WHERE id=2", [{ id: 2 }]);
  assert.equal(h.ui.csvExportStatus.textContent, "");
});

test("export completion restores a lost button focus while preserving focus moved by the user", async () => {
  for (const moved of [false, true]) {
    const h = harness(); await open(h);
    h.ui.document.body = {};
    h.ui.document.activeElement = h.ui.exportCsvBtn;
    h.ui.exportCsvBtn.focus = () => { h.ui.document.activeElement = h.ui.exportCsvBtn; };
    const pending = h.export();
    const target = moved ? h.ui.quickSearchInput : h.ui.document.body;
    h.ui.document.activeElement = target;
    await respond(h, stream(1)); await pending;
    assert.equal(h.ui.document.activeElement, moved ? target : h.ui.exportCsvBtn);
  }
});

test("a query error after an already-written batch aborts the file and preserves displayed results", async () => {
  const h = harness(); await open(h);
  const { writer, writes } = disk(h);
  const pending = h.export();
  await respond(h, { schema: { fields: [{ name: "id" }] }, open: async () => {}, cancel: async () => {}, async *[Symbol.asyncIterator]() {
    yield { numRows: 50000, get: index => ({ id: index }) };
    throw Error("Source disconnected");
  } });
  await pending; await tick();
  assert(writes.length > 0);
  assert.equal(writer.aborted, 1); assert.equal(writer.closed, 0);
  assert.match(h.ui.csvExportStatus.textContent, /Source disconnected/);
  assert.deepEqual(h.state().rows, [{ id: "100" }]);
});
