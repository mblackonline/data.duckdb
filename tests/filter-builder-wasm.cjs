// Offline integration check using the same DuckDB-Wasm version as the application.
// Usage: node tests/filter-builder-wasm.cjs <temporary npm prefix with @duckdb/duckdb-wasm and web-worker>
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const { harness } = require("./filter-builder.test.cjs");

assert(process.argv[2], "Provide a temporary npm prefix containing Wasm test dependencies.");
const prefix = path.resolve(process.argv[2]);
const requireTemp = createRequire(path.join(prefix, "verify.cjs"));
const WebWorker = requireTemp("web-worker");
const pkg = path.join(prefix, "node_modules/@duckdb/duckdb-wasm");
const duckdb = require(path.join(pkg, "dist/duckdb-node.cjs"));
const source = fs.readFileSync(path.join(__dirname, "../assets/app.js"), "utf8");

async function main() {
  const worker = new WebWorker(pathToFileURL(path.join(pkg, "dist/duckdb-node-mvp.worker.cjs")), { type: "module" });
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  const deadline = setTimeout(() => { worker.terminate(); console.error("Builder Wasm verification timed out."); process.exit(1); }, 30000);
  let conn;
  try {
    await db.instantiate(path.join(pkg, "dist/duckdb-mvp.wasm"));
    await db.open({ path: ":memory:", maximumThreads: 1 });
    conn = await db.connect();
    await conn.query(`CREATE SCHEMA data;
      CREATE TABLE data.stations (id INTEGER, fee VARCHAR, capacity BIGINT, date DATE, active BOOLEAN);
      INSERT INTO data.stations VALUES
        (1, '001', 2, '2026-10-25', true), (2, '1', 1, '2026-10-24', false),
        (3, '', 0, NULL, NULL), (4, NULL, NULL, NULL, NULL),
        (5, 'O''Brien 50%_$', 9007199254740993, '2026-10-25', true);`);
    const h = harness(); h.ui.conn = conn; h.ui.schemaCache = {};
    vm.runInContext(source.slice(source.indexOf("    async function validateCartaSql("), source.indexOf("    async function generateSqlWithBackend(")), h.ui);
    const executions = [];
    h.ui.executePagedQuery = sql => {
      const task = (async () => { await h.ui.validateCartaSql(sql); return (await conn.query(sql)).toArray().map(row => row.id); })();
      executions.push(task); return task;
    };
    await h.load();
    const check = async (column, condition, value, expected) => {
      h.choose(column); h.condition(condition); h.value(value);
      await h.run(); assert.equal(h.ui.builderError.textContent, "");
      assert.deepEqual(await executions.at(-1), expected);
    };
    await check("fee", "=", "001", [1]);
    await check("fee", "ILIKE_CONTAINS", "O'Brien 50%_$", [5]);
    await check("fee", "ILIKE_STARTS", "o'brien", [5]);
    await check("fee", "EMPTY_TEXT", "ignored", [3]);
    await check("fee", "IS NULL", "ignored", [4]);
    await check("capacity", ">", "1.5", [1, 5]);
    await check("capacity", "=", "9007199254740993", [5]);
    await check("date", "=", "2026-10-25", [1, 5]);
    await check("active", "=", "true", [1, 5]);
    for (const [column, condition, value] of [["fee", ">", "1"], ["capacity", ">", "oops"], ["date", "=", "2026-02-30"]]) {
      const before = executions.length;
      h.choose(column); h.condition(condition); h.value(value); await h.run();
      assert(h.ui.builderError.textContent); assert.equal(executions.length, before);
    }
    console.log("PASS: 12 builder scenarios validated with the application's real Wasm engine and SQL policy, using local fixture data.");
  } finally {
    clearTimeout(deadline);
    try { if (conn) await conn.close(); } finally { await db.terminate(); worker.terminate(); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
