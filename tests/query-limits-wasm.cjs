// Optional real-worker smoke test. The argument is a temporary npm prefix containing
// @duckdb/duckdb-wasm and web-worker, with no additional application dependencies.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const { harness } = require("./report-state.test.cjs");

if (!process.argv[2]) throw Error("Usage: node tests/query-limits-wasm.cjs <temporary npm prefix>");
const prefix = path.resolve(process.argv[2]);
const requireTemp = createRequire(path.join(prefix, "verify.cjs"));
const WebWorkerClass = requireTemp("web-worker");
const pkg = path.join(prefix, "node_modules", "@duckdb", "duckdb-wasm");
const duckdb = require(path.join(pkg, "dist", "duckdb-node.cjs"));
const source = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const engines = [];

async function engine() {
  // Module loading avoids the adapter's classic importScripts Windows-path handling.
  const worker = new WebWorkerClass(pathToFileURL(path.join(pkg, "dist", "duckdb-node-mvp.worker.cjs")), { type: "module" });
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  engines.push({ db, worker });
  await db.instantiate(path.join(pkg, "dist", "duckdb-mvp.wasm"));
  await db.open({ path: ":memory:", maximumThreads: 1, query: { queryPollingInterval: 10, castBigIntToDouble: true, castDecimalToDouble: true, castTimestampToDate: true } });
  const conn = await db.connect();
  await conn.query("SET memory_limit='256MB'");
  await conn.query("CREATE SCHEMA data; CREATE TABLE data.simple_bus_routes AS SELECT i AS route_id FROM range(10000) t(i);");
  const h = harness();
  Object.assign(h.ui, { actualDb: db, actualConn: conn, actualWorker: worker });
  vm.runInContext("db=actualDb;conn=actualConn;duckdbWorker=actualWorker;availableViews=['simple_bus_routes'];", h.ui);
  vm.runInContext(source.slice(source.indexOf("    async function validateCartaSql("), source.indexOf("    async function callGroqChat(")), h.ui);
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

    // Accelerate the same deadline callback so the smoke test does not wait 30 seconds.
    h.ui.setTimeout = (fn, ms) => setTimeout(fn, ms === 30000 ? 200 : ms);
    await h.run("SELECT SUM(a.route_id::DOUBLE * b.route_id::DOUBLE * c.route_id::DOUBLE) AS total FROM data.simple_bus_routes a CROSS JOIN data.simple_bus_routes b CROSS JOIN data.simple_bus_routes c", "Expensive join");
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
  } finally {
    clearTimeout(deadline);
    for (const { worker, db } of engines) {
      worker.terminate();
      try { db.detach(); } catch {}
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
