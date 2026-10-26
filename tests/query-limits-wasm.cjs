// Optional real-worker smoke test using the project's pinned development dependencies.
// Usage: node tests/query-limits-wasm.cjs
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { harness } = require("./report-state.test.cjs");

const WebWorkerClass = require("web-worker");
const duckdb = require("@duckdb/duckdb-wasm");
const dist = path.dirname(require.resolve("@duckdb/duckdb-wasm"));
const source = fs.readFileSync(path.join(__dirname, "..", "assets", "app.js"), "utf8");
const engines = [];

async function engine() {
  // Module loading avoids the adapter's classic importScripts Windows-path handling.
  const worker = new WebWorkerClass(pathToFileURL(path.join(dist, "duckdb-node-mvp.worker.cjs")), { type: "module" });
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  engines.push({ db, worker });
  await db.instantiate(path.join(dist, "duckdb-mvp.wasm"));
  await db.open({ path: ":memory:", maximumThreads: 1, query: { queryPollingInterval: 10, castBigIntToDouble: true, castDecimalToDouble: true, castTimestampToDate: true } });
  const conn = await db.connect();
  await conn.query("SET memory_limit='256MB'");
  await conn.query("CREATE SCHEMA data; CREATE TABLE data.simple_bus_routes AS SELECT i AS route_id FROM range(10000) t(i);");
  const h = harness();
  Object.assign(h.ui, { actualDb: db, actualConn: conn, actualWorker: worker });
  vm.runInContext("db=actualDb;conn=actualConn;duckdbWorker=actualWorker;availableViews=['simple_bus_routes'];", h.ui);
  vm.runInContext(source.slice(source.indexOf("    async function validateCartaSql("), source.indexOf("    async function generateSqlWithBackend(")), h.ui);
  return { h, db, worker };
}

async function main() {
  const deadline = setTimeout(() => {
    for (const { worker } of engines) worker.terminate();
    console.error("WebAssembly smoke test exceeded its safety deadline");
    process.exitCode = 1;
  }, 20000);
  try {
    let current = await engine();
    const { h, db } = current;
    console.log("WebAssembly engine:", await db.getVersion());
    // Exercise the real paging/normalization path, not just SQL validation.
    for (const comparison of [
      "9007199254740993 = 9007199254740992",
      "1.0000000000000001 = 1.0000000000000000"
    ]) {
      await h.runPage(`SELECT route_id FROM data.simple_bus_routes WHERE ${comparison} LIMIT 1`, "Exact comparison");
      assert.deepEqual(h.state().rows, [], `Distinct SQL numbers must remain distinct: ${comparison}`);
    }
    await h.runPage(`SELECT CAST(9007199254740993 AS VARCHAR) AS big_integer,
      CAST(1.0000000000000001 AS VARCHAR) AS precise_decimal
      FROM data.simple_bus_routes LIMIT 1`, "Exact numeric literals");
    assert.deepEqual(h.state().rows, [{ big_integer: "9007199254740993", precise_decimal: "1.0000000000000001" }]);
    await h.export();
    assert.match(await h.downloads.at(-1).text(), /9007199254740993,1\.0000000000000001/);
    console.log("PASS: Paging and full CSV preserve exact large-integer and decimal SQL literals and comparisons");

    await h.run("SELECT route_id FROM data.simple_bus_routes ORDER BY route_id", "Rows");
    assert.equal(h.state().rows.length, 5000);
    assert.equal(h.state().report.truncated, true);
    assert.equal(h.state().rows[4999].route_id, "4999");
    console.log("PASS: 10,000-row stream capped at 5,000 and cleanup completed");

    await h.run("SELECT COUNT(*) AS records, SUM(route_id) AS total FROM data.simple_bus_routes", "Total");
    assert.deepEqual(h.state().rows, [{ records: "10000", total: "49995000" }]);
    console.log("PASS: COUNT and SUM use all 10,000 source rows");

    await h.run("SELECT route_id % 6000 AS grp, COUNT(*) AS records, SUM(route_id) AS total FROM data.simple_bus_routes GROUP BY grp ORDER BY grp", "Grouped");
    assert.equal(h.state().rows.length, 5000);
    assert.equal(h.state().report.truncated, true);
    assert.deepEqual(h.state().rows[0], { grp: "0", records: "2", total: "6000" });
    console.log("PASS: 6,000-group result is marked partial, with complete totals for returned groups");

    h.ui.rowsPerPage.value = "1000";
    await h.runPage("SELECT route_id FROM data.simple_bus_routes ORDER BY route_id; -- trailing comment", "Paged rows");
    const seen = [];
    do {
      assert(h.state().rows.length <= 1000);
      seen.push(...h.state().rows.map(row => Number(row.route_id)));
      if (!h.state().report.page.hasMore) break;
      await h.next();
    } while (true);
    assert.deepEqual(seen, Array.from({ length: 10000 }, (_, index) => index));
    assert.equal(h.ui.nextPageBtn.disabled, true);
    await h.previous();
    assert.equal(h.state().rows[0].route_id, "8000");
    console.log("PASS: All 10,000 rows are browsable in bounded pages, with working Previous/Next");

    await h.runPage("WITH selected AS (SELECT * FROM data.simple_bus_routes) SELECT route_id FROM selected ORDER BY route_id DESC LIMIT 23 OFFSET 5; -- keep this limit", "Explicit limit");
    assert.equal(h.state().rows.length, 23);
    assert.equal(h.state().rows[0].route_id, "9994");
    assert.equal(h.state().rows[22].route_id, "9972");
    assert.equal(h.state().report.page.hasMore, false);
    console.log("PASS: Canonical paging preserves CTEs, requested ordering, explicit LIMIT/OFFSET and trailing comments");

    await h.runPage("SELECT -route_id AS reverse_id FROM data.simple_bus_routes", "Default ordering");
    assert.equal(h.state().rows[0].reverse_id, "-9999");
    await h.next();
    assert.equal(h.state().rows[0].reverse_id, "-8999");
    console.log("PASS: Unordered reports use deterministic output-column sorting for paging");

    await h.runPage("SELECT COUNT(*) AS records, SUM(route_id) AS total FROM data.simple_bus_routes", "Paged total");
    assert.deepEqual(h.state().rows, [{ records: "10000", total: "49995000" }]);
    await h.runPage("SELECT route_id % 6000 AS grp, COUNT(*) AS records, SUM(route_id) AS total FROM data.simple_bus_routes GROUP BY grp ORDER BY grp", "Paged groups");
    let records = 0, total = 0, groups = 0;
    do {
      for (const row of h.state().rows) { groups++; records += Number(row.records); total += Number(row.total); }
      if (!h.state().report.page.hasMore) break;
      await h.next();
    } while (true);
    assert.deepEqual({ groups, records, total }, { groups: 6000, records: 10000, total: 49995000 });
    console.log("PASS: Paged aggregations preserve complete totals across all 6,000 groups");

    // Accelerate the same deadline callback so the smoke test does not wait 30 seconds.
    h.ui.setTimeout = (fn, ms) => setTimeout(fn, ms === 30000 ? 200 : ms);
    await h.runPage("SELECT SUM(a.route_id::DOUBLE * b.route_id::DOUBLE * c.route_id::DOUBLE) AS total FROM data.simple_bus_routes a CROSS JOIN data.simple_bus_routes b CROSS JOIN data.simple_bus_routes c", "Expensive join");
    assert.match(h.ui.errorBanner.textContent, /30 seconds/);
    assert.equal(h.ui.reconnectBtn.hidden, false);
    assert.equal(h.state().pendingQueries, 0);
    assert.deepEqual(h.state().rows, []);
    h.reconnect();
    assert.equal(h.resources().reloaded, 1);
    console.log("PASS: Accelerated deadline terminates an expensive join and exposes Reconnect");

    current = await engine();
    await current.h.run("SELECT COUNT(*) AS records FROM data.simple_bus_routes", "Recovered");
    assert.deepEqual(current.h.state().rows, [{ records: "10000" }]);
    console.log("PASS: A fresh worker runs reports after forced-stop recovery");

    // Reproduce the oversized route geometry from the public directory without
    // requiring remote data. Future extra payload columns must not leak into presets.
    const fixtureConn = await current.db.connect();
    try {
      await fixtureConn.query(`CREATE OR REPLACE TABLE data.simple_bus_routes AS
        SELECT id, name, color, repeat('g', 400001) AS geometry, repeat('x', 400001) AS extra_payload
        FROM (VALUES ('04', 'Market Street', '#123456'), ('001', 'North Shore', '#abcdef')) t(id, name, color)`);
    } finally { await fixtureConn.close(); }
    await assert.rejects(current.h.runPage("SELECT * FROM data.simple_bus_routes"), /row is too large/);
    assert.equal(current.h.ui.exportCsvBtn.disabled, true);
    const presetsSource = source.slice(source.indexOf("    const PRESET_REPORTS"), source.indexOf("    // State"));
    const presets = new Function("CARTA_NTD_ID", presetsSource + "\nreturn PRESET_REPORTS;")("40001");
    const routes = presets.find(report => report.title === "CARTA Bus Routes");
    await current.h.runPage(routes.sql, routes.title);
    assert.deepEqual(current.h.state().columns, ["id", "name", "color"]);
    assert.deepEqual(current.h.state().rows, [
      { id: "001", name: "North Shore", color: "#abcdef" },
      { id: "04", name: "Market Street", color: "#123456" }
    ]);
    assert.equal(current.h.state().report.truncated, false);
    assert.equal(current.h.state().report.page.hasMore, false);
    await current.h.export();
    const csv = await current.h.downloads.at(-1).text();
    assert.match(csv, /^id,name,color\r\n/);
    assert(csv.includes("Market Street"));
    assert(!csv.includes("geometry") && !csv.includes("extra_payload"));
    console.log("PASS: Route preset and CSV retain complete IDs/names/colors despite oversized geometry and extra source fields; raw SQL safeguard remains active");
  } finally {
    clearTimeout(deadline);
    for (const { worker, db } of engines) {
      worker.terminate();
      try { db.detach(); } catch {}
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
