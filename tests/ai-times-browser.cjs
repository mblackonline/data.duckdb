// Real Chrome/DuckDB timestamp integration, using an isolated in-memory fixture.
// Usage: node tests/ai-times-browser.cjs <temporary playwright-core prefix> [--live-ai]
// The optional live mode requires GROQ_API_KEY in this process's environment.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createRequire } = require("node:module");
const fixtureSql = require("./fixtures/trip-times.cjs");
assert(process.argv[2], "Provide a temporary prefix containing playwright-core.");
const { chromium } = createRequire(path.join(path.resolve(process.argv[2]), "verify.cjs"))("playwright-core");
const live = process.argv.includes("--live-ai");
if (live) assert(process.env.GROQ_API_KEY, "Set GROQ_API_KEY locally before using --live-ai; never paste a key into chat.");
const root = path.join(__dirname, "..");
const files = new Map([
  ["/", ["index.html", "text/html"]],
  ["/assets/styles.css", ["assets/styles.css", "text/css"]],
  ["/assets/app.js", ["assets/app.js", "text/javascript"]]
]);
const expectedMinutes = { dst_fallback: 10, extended_clock: 2, fractional: 1.5, invalid: null, midnight: 3, missing: null, negative: -1, normal: 2, same_instant: 0 };
function minutesByTrip(rows) { return Object.fromEntries(rows.map(row => [row.trip_id, row.elapsed_minutes === "" ? null : Number(row.elapsed_minutes)])); }

async function main() {
  const server = http.createServer((request, response) => {
    const file = files.get(new URL(request.url, "http://localhost").pathname);
    if (!file) { response.writeHead(404); response.end(); return; }
    let body = fs.readFileSync(path.join(root, file[0]), "utf8");
    if (file[0] === "assets/app.js") body += `
      globalThis.aiCheck = {
        get conn() { return conn; },
        query: executePagedQuery, context: buildGroqSchemaPrompt, elapsedSql: TRIP_ELAPSED_SQL,
        setup: async sql => {
          await conn.query("DETACH data"); await conn.query("CREATE SCHEMA data");
          await conn.query(sql); availableViews = ['gtfsrt_trip_updates_v1'];
          for (const key of Object.keys(schemaCache)) delete schemaCache[key];
          for (const key of Object.keys(sampleCache)) delete sampleCache[key];
        },
        get snapshot() { return { report: currentReport, rows: currentRows, columns: currentColumns }; }
      };`;
    response.writeHead(200, { "Content-Type": file[1], "Cache-Control": "no-store" }); response.end(body);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const page = await browser.newPage(); const errors = []; let apiCalls = 0;
    page.on("pageerror", error => errors.push(error.message));
    await page.route("https://api.groq.com/**", route => {
      if (route.request().method() !== "OPTIONS") apiCalls++;
      return live ? route.continue() : route.abort();
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => globalThis.aiCheck?.conn && document.querySelector("#dbStatusText").textContent.includes("Connected"), null, { timeout: 60000 });
    await page.evaluate(sql => aiCheck.setup(sql), fixtureSql);
    const run = sql => page.evaluate(async sql => { await aiCheck.query(sql); return aiCheck.snapshot; }, sql);
    await assert.rejects(run(`SELECT CAST('1970-01-01 ' || predicted_arrival_time AS TIMESTAMP) FROM data.gtfsrt_trip_updates_v1 WHERE trip_id = 'normal'`), /invalid timestamp/i);
    await assert.rejects(run(`SELECT strptime(predicted_arrival_time, '%Y-%m-%dT%H:%M:%S%z') - strptime(scheduled_arrival_time, '%H:%M:%S') FROM data.gtfsrt_trip_updates_v1 WHERE trip_id = 'normal'`), /TIMESTAMP WITH TIME ZONE, TIMESTAMP/);
    console.log("PASS: Reproduced both screenshot errors in the actual browser engine");
    // Execute the exact example supplied in the application's AI context.
    const computed = await run(await page.evaluate(() => aiCheck.elapsedSql));
    assert.deepEqual(minutesByTrip(computed.rows), expectedMinutes);
    const clockRows = await run(`SELECT trip_id,
      TRY_CAST(split_part(scheduled_arrival_time, ':', 1) AS DOUBLE) * 3600 +
      TRY_CAST(split_part(scheduled_arrival_time, ':', 2) AS DOUBLE) * 60 +
      TRY_CAST(split_part(scheduled_arrival_time, ':', 3) AS DOUBLE) AS service_clock_seconds
      FROM data.gtfsrt_trip_updates_v1 ORDER BY trip_id`);
    const clocks = Object.fromEntries(clockRows.rows.map(row => [row.trip_id, row.service_clock_seconds]));
    assert.equal(Number(clocks.extended_clock), 90600); assert.equal(Number(clocks.normal), 70557);
    assert.equal(clocks.invalid, ""); assert.equal(clocks.missing, "");
    console.log("PASS: Exact minute values verified for offsets, DST, midnight, fractions and negatives; invalid/missing values remain NULL; 25-hour clocks remain durations");
    const context = await page.evaluate(() => aiCheck.context("Calculate arrival delay minutes from trip updates"));
    assert(context.includes('"scheduled_arrival_time"="19:35:57"'));
    assert(context.includes('"predicted_arrival_time"="2026-08-18T19:51:00-04:00"'));
    assert.match(context, /no confirmed service date/i);
    console.log("PASS: Real schema context includes both clock and full dated timestamp samples plus missing-service-date guidance");
    await page.locator("#tab-ai").click();
    const question = page.locator("#aiQuestionInput"); const create = page.locator("#askAiBtn");
    await question.fill("Show CARTA Trip Updates & Delays (GTFS-RT)"); await create.click();
    await page.getByText("Report ready (standard report; no AI request).", { exact: true }).waitFor();
    const snapshot = await page.evaluate(() => aiCheck.snapshot);
    assert.equal(snapshot.rows.length, 9); assert.equal(snapshot.report.truncated, false);
    assert.equal(snapshot.rows.find(row => row.trip_id === "extended_clock").scheduled_arrival_time, "25:10:00");
    assert(!snapshot.columns.includes("delay_minutes")); assert.equal(apiCalls, 0);
    console.log("PASS: Exact screenshot browsing request returns every fixture record without an API key or invented delay calculation");
    if (live) {
      await page.locator("#groqApiKeyInput").fill(process.env.GROQ_API_KEY);
      for (const model of ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]) {
        await page.locator("#aiSettings").evaluate(element => { element.open = true; });
        await page.locator("#groqModelSelect").selectOption(model);
        await question.fill('Using gtfsrt_trip_updates_v1, list trip_id and calculate elapsed minutes between predicted_arrival_time and predicted_departure_time. Call the result elapsed_minutes. Include every row ordered by trip_id. Invalid or missing inputs must produce NULL.');
        await create.click(); await page.waitForFunction(() => !document.querySelector("#askAiBtn").disabled, null, { timeout: 90000 });
        const result = await page.evaluate(() => aiCheck.snapshot);
        assert(result.report, `Live ${model} calculation failed: ${await page.locator("#errorBanner").textContent()}`);
        assert.deepEqual(minutesByTrip(result.rows), expectedMinutes, model);
        const usedModel = await page.locator("#groqModelSelect").inputValue();
        assert.equal(usedModel, model, "Fallback success must not count as verification of the requested model");
        await question.fill("Calculate arrival delay minutes between scheduled_arrival_time and predicted_arrival_time in gtfsrt_trip_updates_v1.");
        await create.click(); await page.waitForFunction(() => !document.querySelector("#askAiBtn").disabled, null, { timeout: 90000 });
        assert.match(await page.locator("#errorBanner").textContent(), /confirmed service date and timezone/);
        assert.equal((await page.evaluate(() => aiCheck.snapshot)).report, null);
        console.log(`PASS: Live ${model} returned exact known elapsed minutes and declined an unsupported schedule-delay calculation`);
      }
    } else { console.log("NOT RUN: Live model generation; use --live-ai with a locally configured GROQ_API_KEY."); }
    assert.deepEqual(errors, [], "No unhandled browser errors");
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
