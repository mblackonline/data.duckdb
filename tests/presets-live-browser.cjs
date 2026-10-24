// Optional read-only integration check against the public CDN/catalog/Parquet.
// Usage: node tests/presets-live-browser.cjs <temporary npm prefix with playwright-core>
// Requires installed Chrome and network access. No API key or AI requests are used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createRequire } = require("node:module");

assert(process.argv[2], "Provide a temporary npm prefix containing playwright-core.");
const requireTemp = createRequire(path.join(path.resolve(process.argv[2]), "verify.cjs"));
const { chromium } = requireTemp("playwright-core");
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
    // Test-only access to module state, served from this local test server.
    if (file[0] === "assets/app.js") body += `
      globalThis.presetCheck = {
        get conn() { return conn; }, presets: PRESET_REPORTS,
        get snapshot() { return { report: currentReport, rows: currentRows, columns: currentColumns }; }
      };`;
    response.writeHead(200, { "Content-Type": file[1], "Cache-Control": "no-store" });
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("https://api.groq.com/**", route => route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => globalThis.presetCheck?.conn && document.querySelector("#dbStatusText").textContent.includes("Connected"), null, { timeout: 60000 });
    await page.locator("#rowsPerPage").selectOption("1000");
    const presets = await page.evaluate(() => presetCheck.presets);
    assert.equal(presets.length, 8);
    let tripUpdateCount = 0;
    for (const [index, preset] of presets.entries()) {
      await page.locator(".preset-card").nth(index).click();
      await page.waitForFunction(title => presetCheck.snapshot.report?.title === title || document.querySelector("#resultsMeta").textContent === `${title}: Error`, preset.title, { timeout: 40000 });
      const snapshot = await page.evaluate(() => presetCheck.snapshot);
      assert(snapshot.report, `${preset.title}: ${await page.locator("#errorBanner").textContent()}`);
      assert.equal(await page.locator("#errorBanner").isVisible(), false, preset.title);
      assert.equal(snapshot.report.truncated, false, `${preset.title} must return a complete page`);
      const reference = await page.evaluate(async sql => {
        const table = sql.match(/data\.(\w+)/)[1];
        const schema = await presetCheck.conn.query(`DESCRIBE data.${table}`);
        const count = await presetCheck.conn.query(`SELECT COUNT(*) AS records FROM (${sql.replace(/;\s*$/, "")}) AS report`);
        return {
          columns: schema.toArray().map(row => row.column_name).filter(name => name !== "geometry"),
          count: Number(count.get(0).records)
        };
      }, preset.sql);
      assert.deepEqual(snapshot.columns, reference.columns, `${preset.title} retains all non-geometry fields`);
      assert.equal(snapshot.rows.length, Math.min(1000, reference.count), preset.title);
      assert.equal(snapshot.report.page.hasMore, reference.count > 1000, preset.title);
      if (preset.title === "Trip Updates & Delays (GTFS-RT)") tripUpdateCount = reference.count;
      if (preset.title === "CARTA Bus Routes") {
        const expected = await page.evaluate(async () => {
          const rows = await presetCheck.conn.query('SELECT id, name, color FROM data.simple_bus_routes ORDER BY id');
          return rows.toArray().map(row => row.toJSON());
        });
        assert.deepEqual(snapshot.rows, expected, "Every route ID, name and color is preserved exactly");
      }
      if (preset.title === "CARTA Bus Stops" && snapshot.report.page.hasMore) {
        await page.locator("#nextPageBtn").click();
        await page.waitForFunction(() => presetCheck.snapshot.report?.page.offset === 1000, null, { timeout: 40000 });
        const next = await page.evaluate(() => presetCheck.snapshot);
        assert.equal(next.report.truncated, false);
        assert.equal(next.rows.length, Math.min(1000, reference.count - 1000));
        await page.locator("#previousPageBtn").click();
        await page.waitForFunction(() => presetCheck.snapshot.report?.page.offset === 0, null, { timeout: 40000 });
      }
      console.log(`PASS: ${preset.title}: ${snapshot.rows.length}/${reference.count} rows, ${snapshot.columns.length} columns, no truncation or report error`);
    }
    await page.locator("#tab-ai").click();
    await page.locator("#aiQuestionInput").fill("Show CARTA Trip Updates & Delays (GTFS-RT)");
    await page.locator("#askAiBtn").click();
    await page.getByText("Report ready (standard report; no AI request).", { exact: true }).waitFor();
    const standard = await page.evaluate(() => presetCheck.snapshot);
    assert.equal(standard.rows.length, Math.min(1000, tripUpdateCount));
    assert.equal(standard.report.truncated, false);
    assert.equal(await page.locator("#groqApiKeyInput").inputValue(), "");
    assert(!standard.columns.includes("delay_minutes"));
    console.log("PASS: The exact AI browsing request loads live trip updates using the standard query without an API key");
    assert.deepEqual(errors, [], "No unhandled browser errors");
    console.log("PASS: All eight actual one-click presets load through the pinned browser engine and public catalog; route values and stop paging verified");
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
