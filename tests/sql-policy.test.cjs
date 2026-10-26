// Uses the application's pinned Wasm parser. These SQL queries are parsed, never executed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const WebWorker = require("web-worker");
const duckdb = require("@duckdb/duckdb-wasm");
const dist = path.dirname(require.resolve("@duckdb/duckdb-wasm"));

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
const views = fs.readFileSync(path.join(root, "datasets.csv"), "utf8").trim().split(/\r?\n/).slice(1).map(line => line.match(/^"([^"]+)"/)[1]);
const presetsSource = source.slice(source.indexOf("    const PRESET_REPORTS"), source.indexOf("    // State"));
const presets = new Function("CARTA_NTD_ID", presetsSource + "\nreturn PRESET_REPORTS;")("40001");
const allowed = [
  ["plain SELECT", "SELECT * FROM data.simple_bus_routes LIMIT 10"],
  ["quoted table", 'SELECT * FROM data."simple_bus_routes"'],
  ["quoted database", 'SELECT * FROM "data"."simple_bus_routes"'],
  ["explicit main schema", "SELECT * FROM data.main.simple_bus_routes"],
  ["comments", "/* a report */ SELECT * FROM data.simple_bus_routes; -- trailing comment"],
  ["keywords and semicolons in values", "SELECT 'DROP; FROM read_csv(''x'')' AS note FROM data.simple_bus_routes LIMIT 1"],
  ["quoted keyword column alias", 'SELECT route_id AS "DROP" FROM data.simple_bus_routes'],
  ["REPLACE function", "SELECT replace(route_id, 'a', 'b') FROM data.simple_bus_routes"],
  ["join", "SELECT r.route_id FROM data.simple_bus_routes r JOIN data.simple_bus_stops s ON r.route_id = s.route_id"],
  ["CTE", "WITH r AS (SELECT * FROM data.simple_bus_routes) SELECT * FROM r"],
  ["multiple CTEs", "WITH r AS (SELECT * FROM data.simple_bus_routes), s AS (SELECT * FROM r) SELECT * FROM s"],
  ["materialized CTE", "WITH r AS MATERIALIZED (SELECT * FROM data.simple_bus_routes) SELECT * FROM r"],
  ["nested subquery", "SELECT * FROM (SELECT * FROM data.simple_bus_routes) r"],
  ["scalar subquery", "SELECT (SELECT COUNT(*) FROM data.simple_bus_routes) AS routes"],
  ["EXISTS", "SELECT * FROM data.simple_bus_routes WHERE EXISTS (SELECT 1 FROM data.simple_bus_stops)"],
  ["IN subquery", "SELECT * FROM data.simple_bus_routes WHERE route_id IN (SELECT route_id FROM data.simple_bus_stops)"],
  ["IN values", "SELECT * FROM data.simple_bus_routes WHERE route_id IN ('1','4')"],
  ["conditional totals", 'SELECT "Mode", SUM(CASE WHEN "NTD ID" = \'40001\' THEN "UPT" ELSE 0 END) FROM data.ntd_monthly_ridership_v1 GROUP BY "Mode"'],
  ["window function", "SELECT route_id, row_number() OVER (ORDER BY route_id) FROM data.simple_bus_routes"],
  ["filtered aggregate", 'SELECT COUNT(*) FILTER (WHERE "UPT" > 0) FROM data.ntd_monthly_ridership_v1'],
  ["date parsing and arithmetic", 'SELECT EXTRACT(YEAR FROM TRY_CAST("Date" || \'-01\' AS DATE)), "UPT" / 2 FROM data.ntd_monthly_ridership_v1'],
  ["UNION", "SELECT route_id FROM data.simple_bus_routes UNION ALL SELECT route_id FROM data.simple_bus_routes"],
  ["constant helper CTE", "WITH n AS (SELECT 1 AS number) SELECT COUNT(*) FROM data.simple_bus_routes CROSS JOIN n"],
  ["ILIKE", "SELECT * FROM data.simple_bus_stops WHERE stop_name ILIKE '%Market%'"],
  ["literal text matching with escaped wildcards", "SELECT * FROM data.simple_bus_stops WHERE stop_name ILIKE '%50$%$_$$%' ESCAPE '$'"],
  ...presets.map(report => ["preset: " + report.title, report.sql])
];
const blocked = [
  ["comment-only source", "SELECT 42 /* FROM data.simple_bus_routes */"],
  ["string-only source", "SELECT 'FROM data.simple_bus_routes'"],
  ["unused CARTA CTE", "WITH r AS (SELECT * FROM data.simple_bus_routes) SELECT 42"],
  ["unknown view", "SELECT * FROM data.not_a_carta_view"],
  ["view prefix", "SELECT * FROM data.simple_bus_routes_extra"],
  ["unqualified view", "SELECT * FROM simple_bus_routes"],
  ["wrong schema", "SELECT * FROM other.simple_bus_routes"],
  ["wrong catalog", "SELECT * FROM other.main.simple_bus_routes"],
  ["local metadata", "SELECT * FROM information_schema.tables"],
  ["external source alone", "SELECT * FROM read_csv('https://example.invalid/data.csv')"],
  ["external join", "SELECT r.* FROM data.simple_bus_routes r CROSS JOIN read_csv('https://example.invalid/data.csv') x"],
  ["external nested source", "SELECT * FROM data.simple_bus_routes WHERE EXISTS (SELECT 1 FROM read_parquet('https://example.invalid/data.parquet'))"],
  ["external unused CTE", "WITH x AS (SELECT * FROM read_json('https://example.invalid/data.json')) SELECT * FROM data.simple_bus_routes"],
  ["external file string", "SELECT * FROM 'https://example.invalid/data.parquet'"],
  ["extra generated source", "SELECT * FROM data.simple_bus_routes CROSS JOIN range(1000000000)"],
  ["dynamic query table", "SELECT * FROM query_table('data.simple_bus_routes')"],
  ["dynamic SQL", "SELECT * FROM data.simple_bus_routes CROSS JOIN query('SELECT 1')"],
  ["serialized SQL execution", "SELECT * FROM data.simple_bus_routes CROSS JOIN json_execute_serialized_sql('{}')"],
  ["environment function", "SELECT getenv('HOME') FROM data.simple_bus_routes"],
  ["file-writing function", "SELECT write_file('path','data') FROM data.simple_bus_routes"],
  ["sequence mutation", "SELECT nextval('sequence') FROM data.simple_bus_routes"],
  ["qualified function", "SELECT data.replace('a','a','b') FROM data.simple_bus_routes"],
  ["literal UNION branch", "SELECT route_id FROM data.simple_bus_routes UNION ALL SELECT 'not data'"],
  ["external UNION branch", "SELECT * FROM data.simple_bus_routes UNION ALL SELECT * FROM read_csv('x')"],
  ["multiple SELECTs", "SELECT * FROM data.simple_bus_routes; SELECT * FROM data.simple_bus_stops"],
  ["DROP", "SELECT * FROM data.simple_bus_routes; DROP TABLE anything"],
  ["COPY", "COPY (SELECT * FROM data.simple_bus_routes) TO 'file.csv'"],
  ["ATTACH", "ATTACH 'another.duckdb' AS other"],
  ["PRAGMA", "PRAGMA version"],
  ["SET", "SET enable_external_access = true"],
  ["recursive CTE", "WITH RECURSIVE r AS (SELECT * FROM data.simple_bus_routes UNION ALL SELECT * FROM r) SELECT * FROM r"],
  ["malformed SQL", "SELECT * FROM"],
  ["non-SQL refusal", "UNSUPPORTED_QUERY"]
];

let worker, db, parserConnection, validateCartaSql, validateCartaSqlAst;
test.before(async () => {
  ({ validateCartaSql, validateCartaSqlAst } = await import("../assets/sql-policy.mjs"));
  const version = JSON.parse(fs.readFileSync(path.join(dist, "..", "package.json"), "utf8")).version;
  assert(source.includes(`@duckdb/duckdb-wasm@${version}/`), "The policy check and app must use the same DuckDB-Wasm version.");
  const bundle = await duckdb.selectBundle({
    mvp: { mainWorker: path.join(dist, "duckdb-node-mvp.worker.cjs"), mainModule: path.join(dist, "duckdb-mvp.wasm") },
    eh: { mainWorker: path.join(dist, "duckdb-node-eh.worker.cjs"), mainModule: path.join(dist, "duckdb-eh.wasm") }
  });
  worker = new WebWorker(pathToFileURL(bundle.mainWorker), { type: "module" });
  db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule);
  await db.open({ path: ":memory:", maximumThreads: 1 });
  parserConnection = await db.connect();
}, { timeout: 20000 });
test.after(async () => {
  try { if (parserConnection) await parserConnection.close(); }
  finally {
    try { if (db) await db.terminate(); }
    finally { worker?.terminate(); }
  }
});
let closes = 0, boundSql = null;
const queryConnection = {
  prepare: async sql => {
    assert.equal(sql, "SELECT json_serialize_sql(CAST(? AS VARCHAR)) AS ast");
    const statement = await parserConnection.prepare(sql);
    return {
      query: async value => { boundSql = value; return statement.query(value); },
      close: async () => { closes++; await statement.close(); }
    };
  }
};
const validate = sql => validateCartaSql(sql, queryConnection, views);

for (const [name, sql] of allowed) test("allows " + name, async () => {
  const before = closes;
  await validate(sql);
  assert.equal(boundSql, sql); assert.equal(closes, before + 1);
});
for (const [name, sql] of blocked) test("blocks " + name, async () => {
  await assert.rejects(validate(sql));
});
test("rejects unrecognized parser structures", () => {
  assert.throws(() => validateCartaSqlAst({ statements: [{ node: { type: "UNKNOWN_NODE" } }] }, views));
});
test("accepts newer CTE serialization alongside the WebAssembly engine's format", async () => {
  const ast = await validate(allowed.find(([name]) => name === "CTE")[1]);
  for (const entry of ast.statements[0].node.cte_map.map) {
    entry.value.query_node = entry.value.query.node;
    delete entry.value.query;
  }
  validateCartaSqlAst(ast, views);
});
test("accepts built-in main.date_part emitted by legacy EXTRACT parsing", async () => {
  const ast = await validate(allowed.find(([name]) => name === "date parsing and arithmetic")[1]);
  const expression = ast.statements[0].node.select_list[0];
  expression.schema = "main";
  delete expression.qualified_name;
  validateCartaSqlAst(ast, views);
});
test("accepts legacy constant type metadata without treating it as a query node", async () => {
  const ast = await validate(allowed.find(([name]) => name === "keywords and semicolons in values")[1]);
  ast.statements[0].node.select_list[0].value = { type: { id: "VARCHAR", type_info: null }, is_null: false, value: "text" };
  validateCartaSqlAst(ast, views);
});
test("parser failure fails closed and releases its statement", async () => {
  let closed = false;
  const failingConnection = { prepare: async () => ({ query: async () => { throw Error("parser unavailable"); }, close: async () => { closed = true; } }) };
  await assert.rejects(validateCartaSql(allowed[0][1], failingConnection, views), /parser unavailable/);
  assert(closed);
});
