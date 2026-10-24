// Actual pinned engine, public data and real browser-owned filesystem streams.
// Usage: node tests/full-csv-browser.cjs <temporary playwright-core prefix>
// The save dialog is replaced with an isolated OPFS handle; no user files are touched.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createRequire } = require("node:module");
const { readCsv } = require("./csv-export.test.cjs");
assert(process.argv[2], "Provide a temporary prefix containing playwright-core.");
const prefix = path.resolve(process.argv[2]);
const { chromium } = createRequire(path.join(prefix, "verify.cjs"))("playwright-core");
const root = path.join(__dirname, "..");
const files = new Map([
  ["/", ["index.html", "text/html"]],
  ["/assets/styles.css", ["assets/styles.css", "text/css"]],
  ["/assets/app.js", ["assets/app.js", "text/javascript"]]
]);

async function main() {
  const server = http.createServer((request, response) => {
    const file = files.get(new URL(request.url, "http://localhost").pathname);
    if (!file) { response.writeHead(404); response.end(); return; }
    let body = fs.readFileSync(path.join(root, file[0]), "utf8");
    if (file[0] === "assets/app.js") body += `
      globalThis.csvCheck = {
        get conn() { return conn; }, query: executePagedQuery,
        get snapshot() { return { report: currentReport, rows: currentRows }; },
        setup: async () => {
          await conn.query("DETACH data; CREATE SCHEMA data");
          await conn.query(\`CREATE TABLE data.simple_bus_routes AS SELECT i AS id,
            '=1+2' AS formula, '00123' AS identifier, 'Café 😀' AS unicode,
            -85.3097 AS longitude FROM range(10000) t(i)\`);
          availableViews = ['simple_bus_routes'];
        }
      };`;
    response.writeHead(200, { "Content-Type": file[1], "Cache-Control": "no-store" }); response.end(body);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.setDefaultTimeout(40000);
    const errors = []; let apiCalls = 0;
    page.on("pageerror", error => errors.push(error.message));
    await page.route("https://api.groq.com/**", route => { apiCalls++; return route.abort(); });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => globalThis.csvCheck?.conn && document.querySelector("#dbStatusText").textContent.includes("Connected"), null, { timeout: 60000 });
    console.log("Browser:", await browser.version());
    await page.evaluate(async () => {
      const directory = await navigator.storage.getDirectory();
      globalThis.csvDestination = await directory.getFileHandle("export.csv", { create: true });
      globalThis.csvWrites = [];
      globalThis.showSaveFilePicker = async options => {
        globalThis.csvPickerOptions = options;
        return { createWritable: async () => {
          const native = await csvDestination.createWritable();
          return {
            write: async chunk => {
              csvWrites.push(chunk.byteLength);
              if (globalThis.csvHoldWrite) await new Promise(resolve => { globalThis.csvReleaseWrite = resolve; });
              return native.write(chunk);
            },
            close: () => native.close(),
            abort: async () => { await native.abort(); globalThis.csvAborted = true; }
          };
        } };
      };
    });
    const run = sql => page.evaluate(sql => csvCheck.query(sql, "CSV integration report"), sql);
    const finish = async () => {
      await page.waitForFunction(() => !document.querySelector("#exportCsvBtn").disabled);
      const status = await page.locator("#csvExportStatus").textContent();
      assert.match(status, /^(Saved|Download ready for)/);
      return status;
    };
    const exportDisk = async () => { await page.locator("#exportCsvBtn").click(); return finish(); };
    const diskCsv = async () => readCsv(await page.evaluate(async () => (await csvDestination.getFile()).text()));

    await run('SELECT "id", "name", "latitude", "longitude", "route_ids" FROM data.simple_bus_stops ORDER BY "id"');
    const count = await page.evaluate(async () => Number((await csvCheck.conn.query("SELECT count(*) AS n FROM data.simple_bus_stops")).get(0).n));
    await exportDisk();
    const live = await diskCsv();
    assert.equal(live.length, count + 1);
    assert.deepEqual(live[0], ["id", "name", "latitude", "longitude", "route_ids"]);
    assert.equal((await page.evaluate(() => csvCheck.snapshot)).rows.length, 100);
    console.log(`PASS: Public bus-stop full CSV exports ${count} matching records while retaining the 100-row page`);

    await page.evaluate(() => csvCheck.setup());
    await run("SELECT * FROM data.simple_bus_routes ORDER BY id");
    await page.locator("#nextPageBtn").click();
    await page.waitForFunction(() => csvCheck.snapshot.report?.page.offset === 100);
    await page.locator("#quickSearchInput").fill("not present");
    await page.locator("#sqlQueryBox").evaluate(element => { element.value = "unexecuted editor changes"; });
    await exportDisk();
    const csv = await diskCsv();
    assert.equal(csv.length, 10001);
    assert.deepEqual(csv[1], ["0", "\t=1+2", "00123", "Café 😀", "-85.3097"]);
    assert.equal(csv.at(-1)[0], "9999");
    const snapshot = await page.evaluate(() => csvCheck.snapshot);
    assert.equal(snapshot.rows.length, 100); assert.equal(snapshot.report.page.offset, 100);
    assert.equal(await page.locator("tbody tr").count(), 0);
    assert.match(await page.evaluate(() => csvPickerOptions.suggestedName), /_full\.csv$/);
    console.log("PASS: Real native writer exports all 10,000 safe rows, ignoring page search and unexecuted edits while preserving page 2");

    await run("WITH selected AS (SELECT * FROM data.simple_bus_routes) SELECT id FROM selected ORDER BY id DESC LIMIT 23 OFFSET 5; -- requested scope");
    await exportDisk();
    const limited = await diskCsv();
    assert.equal(limited.length, 24); assert.equal(limited[1][0], "9994"); assert.equal(limited.at(-1)[0], "9972");
    await run("SELECT id % 6000 AS grp, COUNT(*) AS records, SUM(id) AS total FROM data.simple_bus_routes GROUP BY grp ORDER BY grp");
    await exportDisk();
    const groups = (await diskCsv()).slice(1);
    assert.equal(groups.length, 6000);
    assert.equal(groups.reduce((n, row) => n + Number(row[1]), 0), 10000);
    assert.equal(groups.reduce((n, row) => n + Number(row[2]), 0), 49995000);
    console.log("PASS: Canonical full export preserves CTEs, comments, explicit LIMIT/OFFSET and complete totals across 6,000 groups");

    await page.evaluate(() => csvCheck.conn.query("CREATE OR REPLACE TABLE data.simple_bus_routes AS SELECT i AS id, repeat('x', 90000) AS payload FROM range(300) t(i)"));
    await run("SELECT id, payload FROM data.simple_bus_routes ORDER BY id");
    await page.evaluate(() => { globalThis.csvWrites = []; });
    await exportDisk();
    assert(await page.evaluate(async () => (await csvDestination.getFile()).size > 20 * 1024 * 1024));
    assert(await page.evaluate(() => Math.max(...csvWrites) <= 256 * 1024));
    assert.match(await page.locator("#csvExportStatus").textContent(), /300 rows/);
    await page.evaluate(() => { globalThis.showSaveFilePicker = undefined; });
    await page.locator("#exportCsvBtn").click();
    await page.waitForFunction(() => !document.querySelector("#exportCsvBtn").disabled);
    assert.match(await page.locator("#csvExportStatus").textContent(), /Export failed.*20 MiB/);
    console.log("PASS: Native full export streams 27 MB in bounded chunks; the same report fails clearly above the fallback budget");

    await run("SELECT id FROM data.simple_bus_routes WHERE id < 0");
    await page.evaluate(() => {
      globalThis.showSaveFilePicker = async () => ({ createWritable: () => csvDestination.createWritable() });
    });
    await exportDisk(); assert.deepEqual(await diskCsv(), [["id"]]);
    await run("SELECT id FROM data.simple_bus_routes WHERE id < 3 ORDER BY id");
    await page.evaluate(() => { globalThis.showSaveFilePicker = undefined; });
    const downloaded = page.waitForEvent("download");
    await page.locator("#exportCsvBtn").click();
    const download = await downloaded; await finish();
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    assert.deepEqual(readCsv(Buffer.concat(chunks)), [["id"], ["0"], ["1"], ["2"]]);
    assert.match(download.suggestedFilename(), /_full\.csv$/);
    console.log("PASS: Header-only exports and real Blob fallback downloads contain exactly the full SQL result");

    // Restore a native writer, seed a known file and cancel during a held write.
    await page.evaluate(async () => {
      const seed = await csvDestination.createWritable(); await seed.write("ORIGINAL FILE"); await seed.close();
      globalThis.csvAborted = false;
      globalThis.csvHoldWrite = true;
      globalThis.showSaveFilePicker = async () => ({ createWritable: async () => {
        const native = await csvDestination.createWritable();
        return {
          write: async chunk => { await new Promise(resolve => { globalThis.csvReleaseWrite = resolve; }); return native.write(chunk); },
          close: () => native.close(), abort: async () => { await native.abort(); globalThis.csvAborted = true; }
        };
      } });
    });
    await page.locator("#exportCsvBtn").click();
    await page.waitForFunction(() => typeof globalThis.csvReleaseWrite === "function");
    await page.locator("#stopReportBtn").click();
    await page.waitForFunction(() => globalThis.csvAborted === true);
    assert.equal(await page.evaluate(async () => (await csvDestination.getFile()).text()), "ORIGINAL FILE");
    await page.evaluate(() => csvReleaseWrite());
    await page.locator("#reconnectBtn").waitFor();
    assert.match(await page.locator("#csvExportStatus").textContent(), /Export stopped/);
    assert.deepEqual(errors, []); assert.equal(apiCalls, 0);
    console.log("PASS: Stop aborts an actual native file stream, preserves the previous file, and exposes Reconnect without unhandled errors or AI requests");
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
