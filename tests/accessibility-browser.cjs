// Optional real-browser check. Usage: node tests/accessibility-browser.cjs <temporary npm prefix> [browser.exe] [--baseline]
// The temporary prefix needs playwright-core and @axe-core/playwright. All remote requests are mocked or blocked.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createRequire } = require("node:module");

assert(process.argv[2], "Provide a temporary npm prefix containing browser test dependencies.");
const prefix = path.resolve(process.argv[2]);
const requireTemp = createRequire(path.join(prefix, "verify.cjs"));
const { chromium } = requireTemp("playwright-core");
const AxeBuilder = requireTemp("@axe-core/playwright").default;
const root = path.join(__dirname, "..");
const staticFiles = new Map([
  ["/", { type: "text/html; charset=utf-8", body: fs.readFileSync(path.join(root, "index.html")) }],
  ["/assets/styles.css", { type: "text/css; charset=utf-8", body: fs.readFileSync(path.join(root, "assets", "styles.css")) }],
  ["/assets/app.js", { type: "text/javascript; charset=utf-8", body: fs.readFileSync(path.join(root, "assets", "app.js")) }],
  ["/mock-worker.js", { type: "text/javascript; charset=utf-8", body: "" }]
]);
const baseline = process.argv.includes("--baseline");
const executablePath = process.argv.slice(3).find(value => /\.exe$/i.test(value)) || [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
].find(value => fs.existsSync(value));
assert(executablePath, "Provide the path to an installed Chromium browser.");

// This fixture tests UI behavior; real SQL parsing and execution are covered by the separate policy/Wasm checks.
const fixtureModule = `
  const makeRows = count => Array.from({length: count}, (_, index) => ({
    Route: index === 0 ? 'Market Street' : 'Route ' + index,
    Description: 'Public transit route details '.repeat(18), Longitude: -85.3097
  }));
  let rows = makeRows(40);
  globalThis.fixtureSetRows = count => { rows = makeRows(count); };
  function table(values) { return {
    schema: {fields: Object.keys(values[0] || rows[0]).map(name => ({name}))},
    numRows: values.length, get: index => values[index], toArray: () => values
  }; }
  function connection() { return {
    query: async sql => {
      if (sql.includes('duckdb_views()')) return table([{view_name: 'simple_bus_routes'}]);
      if (sql.startsWith('DESCRIBE')) return table(Object.keys(rows[0]).map(column_name => ({column_name, column_type: 'VARCHAR'})));
      return table([rows[0]]);
    },
    prepare: async statement => ({
      query: async value => statement.includes('json_deserialize_sql')
        ? table([{sql: JSON.parse(value).fixtureSql.replace(/;\\s*$/, '')}])
        : table([{ast: JSON.stringify({fixtureSql: value, statements: [{node: {
          type: 'SELECT_NODE', from_table: {type: 'BASE_TABLE', schema_name: 'data', table_name: 'simple_bus_routes'}, modifiers: []
        }}]})}]), close: async () => {}
    }),
    send: async sql => {
      if (globalThis.fixtureHold) await new Promise(resolve => {globalThis.fixtureFinish = resolve;});
      if (globalThis.fixtureFail) throw Error('Fixture report unavailable.');
      const page = sql.match(/LIMIT (\\d+) OFFSET (\\d+)$/);
      const values = page ? rows.slice(Number(page[2]), Number(page[2]) + Number(page[1])) : rows;
      return {schema: table(rows).schema, open: async () => {}, cancel: async () => {}, async *[Symbol.asyncIterator]() {yield table(values);}};
    }, cancelSent: async () => true, close: async () => {}
  }; }
  export const getJsDelivrBundles = () => ({});
  export const selectBundle = async () => ({mainWorker: location.origin + '/mock-worker.js', mainModule: 'mock.wasm'});
  export class VoidLogger {log() {}}
  export class ConsoleLogger {log() {}}
  export class AsyncDuckDB {
    async instantiate() {} async open() {} async connect() {return connection();} detach() {}
  }
`;

async function main() {
  const server = http.createServer((request, response) => {
    const file = staticFiles.get(new URL(request.url, "http://localhost").pathname);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    response.writeHead(file ? 200 : 404, { "Content-Type": file?.type || "text/plain; charset=utf-8" });
    response.end(file ? file.body : "Not found");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser, releaseAiResponse;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    console.log("Browser:", await browser.version());
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let aiResponseGate = null, aiRequests = 0;
    await context.route("**/*", async route => {
      const url = route.request().url();
      if (url.startsWith(origin + "/")) return route.continue();
      if (url.startsWith("https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@")) return route.fulfill({ contentType: "text/javascript", body: fixtureModule });
      if (url === "https://api.groq.com/openai/v1/chat/completions") {
        const headers = { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "authorization,content-type", "Access-Control-Allow-Methods": "POST,OPTIONS" };
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        aiRequests++;
        if (aiResponseGate) await aiResponseGate;
        return route.fulfill({ contentType: "application/json", headers, body: JSON.stringify({ choices: [{ message: { content: "SELECT * FROM data.simple_bus_routes" } }] }) });
      }
      return route.abort();
    });
    const cssLoaded = page.waitForResponse(`${origin}/assets/styles.css`);
    const jsLoaded = page.waitForResponse(`${origin}/assets/app.js`);
    await page.goto(origin);
    const [cssResponse, jsResponse] = await Promise.all([cssLoaded, jsLoaded]);
    assert.equal(cssResponse.status(), 200);
    assert.match(cssResponse.headers()["content-type"], /^text\/css/);
    assert.equal(jsResponse.status(), 200);
    assert.match(jsResponse.headers()["content-type"], /^text\/javascript/);
    console.log("PASS: external stylesheet and JavaScript module load with correct content types");
    await page.getByText("Connected (1 CARTA datasets ready)", { exact: true }).waitFor();
    const audit = async label => {
      await page.evaluate(async () => {
        await new Promise(requestAnimationFrame);
        await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})));
      });
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      const violations = result.violations.map(item => ({ id: item.id, impact: item.impact, targets: item.nodes.map(node => node.target) }));
      if (baseline) console.log(label, JSON.stringify(violations));
      else assert.deepEqual(violations, [], label);
    };
    if (baseline) {
      for (const panel of ["presets", "builder", "ai"]) {
        await page.locator(`[data-tab="panel-${panel}"]`).click();
        await audit(panel);
      }
      return;
    }

    const focusedId = () => page.evaluate(() => document.activeElement.id);
    const tabTo = async locator => {
      for (let attempt = 0; attempt < 45; attempt++) {
        if (await locator.evaluate(element => element === document.activeElement)) return;
        await page.keyboard.press("Tab");
      }
      assert.fail("Keyboard Tab could not reach the requested control.");
    };
    const selected = async id => {
      assert.equal(await focusedId(), id);
      assert.equal(await page.locator(`#${id}`).getAttribute("aria-selected"), "true");
      assert.equal(await page.locator('[role="tab"][tabindex="0"]').count(), 1);
      assert.equal(await page.getByRole("tabpanel").count(), 1);
    };
    await page.keyboard.press("Tab"); await selected("tab-presets");
    await page.keyboard.press("ArrowRight"); await selected("tab-builder");
    await page.keyboard.press("Tab"); assert.equal(await focusedId(), "panel-builder");
    await page.keyboard.press("Tab"); assert.equal(await focusedId(), "builderDataset");
    await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Shift+Tab");
    await selected("tab-builder");
    await page.keyboard.press("End"); await selected("tab-ai");
    assert(await page.getByRole("textbox", { name: "Your question", exact: true }).isVisible());
    assert(!await page.locator("#reconnectBtn").isVisible());
    await audit("AI tab");
    await page.keyboard.press("Home"); await selected("tab-presets");
    await page.keyboard.press("ArrowLeft"); await selected("tab-ai");
    await page.keyboard.press("ArrowRight"); await selected("tab-presets");
    console.log("PASS: tabs expose selected states, wrap arrow keys, support Home/End and preserve Tab order");

    assert.equal(await page.locator(".preset-card").count(), 8);
    assert.equal(await page.locator(".preset-card-tag").count(), 0);
    assert.equal(await page.locator("#reportDetails").evaluate(element => element.open), false);
    assert.equal(await page.locator("#downloadHelp").evaluate(element => element.open), false);
    assert.equal(await page.locator("#stopReportBtn").isVisible(), false);
    const routes = page.getByRole("button", { name: "Bus routes", exact: true });
    await tabTo(routes);
    const focusStyle = await routes.evaluate(element => ({ visible: element.matches(":focus-visible"), width: getComputedStyle(element).outlineWidth, style: getComputedStyle(element).outlineStyle }));
    assert(focusStyle.visible && focusStyle.style === "solid" && parseFloat(focusStyle.width) >= 3);
    await page.evaluate(() => { globalThis.fixtureHold = true; });
    await page.keyboard.press("Enter");
    await page.locator("#resultsSummary").filter({ hasText: "Loading report..." }).waitFor();
    assert.equal(await page.locator("#resultsTitle").textContent(), "Bus routes");
    assert.equal(await page.locator("#stopReportBtn").isVisible(), true);
    assert.equal(await page.locator("#resultsSummary").getAttribute("role"), "status");
    assert.equal(await page.locator("#resultsSummary").getAttribute("aria-atomic"), "true");
    await page.waitForFunction(() => typeof globalThis.fixtureFinish === "function");
    await page.evaluate(() => { globalThis.fixtureHold = false; globalThis.fixtureFinish(); });
    await page.locator("#resultsSummary").filter({ hasText: /^40 results$/ }).waitFor();
    assert.equal(await page.locator("#reportPagination").isVisible(), false);
    assert.equal(await page.locator("#stopReportBtn").isVisible(), false);
    assert.equal(await page.locator("#resultsFreshnessSummary").textContent(), "Source update time unavailable.");
    assert.equal(await page.locator("#resultsMeta").isVisible(), false);
    assert.equal(await page.locator("#csvExportHelp").isVisible(), false);
    await page.screenshot({ path: path.join(prefix, "simplified-reports-desktop.png"), fullPage: true });
    assert(await routes.evaluate(element => element === document.activeElement), "Report completion must preserve focus");
    assert.equal(await page.locator("th[scope=col]").count(), 3);
    const quickFilter = page.getByRole("textbox", { name: "Search this page", exact: true });
    await tabTo(quickFilter);
    await page.keyboard.type("Market");
    await page.locator("#resultsSummary").filter({ hasText: /^1 of 40 rows shown$/ }).waitFor();
    await page.keyboard.press("Tab"); assert.equal(await focusedId(), "exportCsvBtn");
    await page.locator(".sql-details summary").focus();
    await page.keyboard.press("Enter"); await page.keyboard.press("Tab");
    assert(await page.getByRole("textbox", { name: "Report SQL", exact: true }).evaluate(element => element === document.activeElement));
    const resultTree = await page.locator(".results-card").ariaSnapshot();
    assert.match(resultTree, /textbox "Search this page"/);
    assert.match(resultTree, /textbox "Report SQL"/);
    assert.match(resultTree, /region "Report results"/);
    assert.match(resultTree, /table "Loaded report rows"/);
    await audit("Loaded and filtered report");
    console.log("PASS: keyboard report/filter/SQL workflow, focus ring, live counts and accessible table structure");

    await page.evaluate(() => { globalThis.fixtureFail = true; });
    await page.keyboard.press("Tab"); assert.equal(await focusedId(), "runCustomSqlBtn");
    await page.keyboard.press("Enter");
    await page.getByRole("alert").filter({ hasText: "Fixture report unavailable." }).waitFor();
    assert.equal(await focusedId(), "runCustomSqlBtn");
    await audit("Report error");
    await page.evaluate(() => { globalThis.fixtureFail = false; });
    await page.keyboard.press("Enter");
    await page.locator("#resultsSummary").filter({ hasText: /^1 of 40 rows shown$/ }).waitFor();
    assert.equal(await page.getByRole("alert").textContent(), "");
    await page.setViewportSize({ width: 320, height: 900 });
    await page.locator("#tableContainer").focus(); assert.equal(await focusedId(), "tableContainer");
    assert(await page.locator("#tableContainer").evaluate(element => element.scrollWidth > element.clientWidth));
    const before = await page.locator("#tableContainer").evaluate(element => element.scrollLeft);
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(value => document.getElementById("tableContainer").scrollLeft > value, before);
    console.log("PASS: errors expose alert semantics, recovery preserves focus, results scroll with the keyboard");

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator("#tab-builder").click(); await audit("Builder tab");
    for (const width of [640, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const panel of ["presets", "builder", "ai"]) {
        await page.locator(`#tab-${panel}`).click();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Page overflows at ${width}px in ${panel}`);
      }
      await audit(`${width}px layout`);
    }
    await page.screenshot({ path: path.join(prefix, "accessibility-320px.png"), fullPage: true });
    console.log("PASS: no detected axe WCAG A/AA violations in tested states; page reflows at 640px and 320px");

    await page.setViewportSize({ width: 1280, height: 1000 });
    const settings = page.locator("#aiSettings");
    const question = page.getByRole("textbox", { name: "Your question", exact: true });
    const create = page.getByRole("button", { name: "Create report", exact: true });
    assert.equal(await settings.evaluate(element => element.open), true);
    assert.equal(await page.locator("#aiPrivacyDetails").evaluate(element => element.open), false);
    assert.equal(await page.locator("#panel-ai .chip").count(), 3);
    assert((await question.boundingBox()).y < (await settings.boundingBox()).y);
    await page.getByRole("button", { name: "Ridership by mode", exact: true }).click();
    assert((await question.inputValue()).includes("2024"));
    assert(await question.evaluate(element => element === document.activeElement));
    assert.equal(aiRequests, 0, "Examples must not submit requests");
    await create.click();
    assert.equal(await focusedId(), "groqApiKeyInput");
    assert.equal(aiRequests, 0);
    assert.equal(await settings.evaluate(element => element.open), true);
    await question.fill("Show CARTA Bus Routes");
    await create.click();
    await page.getByText("Report ready (standard report; no AI request).", { exact: true }).waitFor();
    assert.equal(aiRequests, 0, "Exact standard browsing requests do not need an AI call or key");
    assert.equal(await page.getByLabel("API key for Groq (AI provider)", { exact: true }).inputValue(), "");
    await page.getByLabel("API key for Groq (AI provider)", { exact: true }).fill("gsk_browser_fixture_only");
    await page.getByRole("button", { name: "Remember on this device", exact: true }).click();
    await page.reload();
    await page.getByText("Connected (1 CARTA datasets ready)", { exact: true }).waitFor();
    await page.locator("#tab-ai").click();
    assert.equal(await settings.evaluate(element => element.open), false);
    assert.equal(await page.locator("#aiKeySummary").textContent(), "Key entered");
    assert(!await page.getByLabel("API key for Groq (AI provider)", { exact: true }).isVisible());
    await page.locator("#aiSettings > summary").focus();
    await page.keyboard.press("Enter");
    assert(await page.getByLabel("API key for Groq (AI provider)", { exact: true }).isVisible());
    await page.keyboard.press("Enter");
    assert.equal(await settings.evaluate(element => element.open), false);
    await page.locator("#aiPrivacyDetails > summary").focus();
    await page.keyboard.press("Enter");
    assert(await page.getByText(/Your question, selected table schemas/).isVisible());
    await page.keyboard.press("Enter");
    assert(await page.locator("#aiPrivacyWarning").isVisible());
    await question.fill("List CARTA routes sorted by name");
    await page.keyboard.press("Shift+Enter");
    assert((await question.inputValue()).includes("\n"));
    await question.dispatchEvent("keydown", { key: "Enter", isComposing: true });
    assert.equal(aiRequests, 0, "Newlines and IME composition must not submit requests");
    await page.evaluate(() => { globalThis.fixtureHold = true; globalThis.fixtureFinish = null; });
    aiResponseGate = new Promise(resolve => { releaseAiResponse = resolve; });
    const requestStarted = page.waitForRequest("https://api.groq.com/openai/v1/chat/completions");
    await page.keyboard.press("Enter");
    await requestStarted;
    assert.equal(await page.locator("#aiStatusText").textContent(), "Preparing report...");
    releaseAiResponse();
    await page.getByText("Loading results...", { exact: true }).waitFor();
    await page.waitForFunction(() => typeof globalThis.fixtureFinish === "function");
    await page.evaluate(() => { globalThis.fixtureHold = false; globalThis.fixtureFinish(); });
    await page.getByText("Report ready.", { exact: true }).waitFor();
    assert.equal(aiRequests, 1);
    assert.equal(await page.locator("#resultsTitle").textContent(), "AI report");
    assert.equal(await page.locator("#resultsMeta").isVisible(), false);
    await page.locator("#reportDetails > summary").click();
    assert.match(await page.locator("#resultsMeta").textContent(), /List CARTA routes sorted by name/);
    await page.locator("#reportDetails > summary").click();
    await page.locator("#downloadHelp > summary").click();
    assert.equal(await page.locator("#csvExportHelp").isVisible(), true);
    await page.locator("#downloadHelp > summary").click();
    assert.equal(await settings.evaluate(element => element.open), false);
    await audit("Simplified AI panel, remembered key and ready report");
    await page.locator("#panel-ai").screenshot({ path: path.join(prefix, "ai-screen-desktop.png") });
    await page.locator("#aiSettings > summary").click();
    await page.getByRole("button", { name: "Forget key", exact: true }).click();
    assert.equal(await settings.evaluate(element => element.open), true);
    assert.equal(await page.locator("#aiKeySummary").textContent(), "Key needed");
    assert.equal(await page.getByLabel("API key for Groq (AI provider)", { exact: true }).inputValue(), "");
    await page.locator("#panel-ai").screenshot({ path: path.join(prefix, "ai-screen-setup.png") });
    await page.setViewportSize({ width: 320, height: 1000 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await audit("Simplified AI panel, key setup at 320px");
    await page.locator("#aiSettings > summary").click();
    await page.locator("#panel-ai").screenshot({ path: path.join(prefix, "ai-screen-mobile.png") });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.evaluate(() => globalThis.fixtureSetRows(6505));
    await page.locator("#tab-builder").click();
    await page.getByRole("button", { name: "Run Report", exact: true }).click();
    await page.locator("#resultsSummary").filter({ hasText: /^100 rows on this page$/ }).waitFor();
    assert.equal(await page.locator("#reportPagination").isVisible(), true);
    assert(await page.locator("#reportPagination").evaluate(element => Boolean(document.querySelector("#tableContainer").compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)));
    await page.getByLabel("Rows per page", { exact: true }).selectOption("1000");
    await page.locator("#resultsSummary").filter({ hasText: /^1,000 rows on this page$/ }).waitFor();
    for (let number = 2; number <= 7; number++) {
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await page.locator("#pageStatus").filter({ hasText: `Page ${number} ·` }).waitFor();
    }
    assert.equal(await page.locator("tbody tr").count(), 505);
    assert.match(await page.locator("#pageStatus").textContent(), /6,001.*6,505.*end of results/);
    assert(await page.getByRole("button", { name: "Next", exact: true }).isDisabled());
    assert.equal(await focusedId(), "previousPageBtn");
    await page.keyboard.press("Enter");
    await page.locator("#pageStatus").filter({ hasText: "Page 6 ·" }).waitFor();
    assert.equal(await page.locator("tbody tr").count(), 1000);
    await page.getByLabel("Rows per page", { exact: true }).focus();
    await page.getByLabel("Rows per page", { exact: true }).selectOption("50");
    await page.locator("#resultsSummary").filter({ hasText: /^50 rows on this page$/ }).waitFor();
    assert.equal(await focusedId(), "rowsPerPage");
    await quickFilter.fill("Route 6504");
    await page.locator("#resultsSummary").filter({ hasText: /^0 of 50 rows shown on this page$/ }).waitFor();
    assert(!await page.getByRole("button", { name: "Next", exact: true }).isDisabled());
    assert.equal(await page.getByRole("button", { name: /Download.*CSV/ }).count(), 1);
    assert.equal(await page.locator("#exportCsvBtn").textContent(), "Download report (CSV)");
    await quickFilter.fill("");
    await audit("Paged report beyond 5000 rows and page-size controls");
    console.log("PASS: builder browses 6,505 rows, last-page focus is preserved, page size resets, page search and one report-download control are clear");
    await page.evaluate(() => { globalThis.showSaveFilePicker = undefined; });
    const fullExport = page.getByRole("button", { name: "Download report (CSV)", exact: true });
    await quickFilter.fill("not present");
    await fullExport.focus();
    const download = page.waitForEvent("download");
    await page.keyboard.press("Enter");
    await download;
    await page.locator("#csvExportStatus").filter({ hasText: /^CSV download ready: 6,505 rows\.$/ }).waitFor();
    assert.equal(await focusedId(), "exportCsvBtn");
    assert.equal(await page.locator("#csvExportStatus").getAttribute("role"), "status");
    assert.equal(await page.locator("#csvExportStatus").getAttribute("aria-atomic"), "true");
    assert.match(await fullExport.getAttribute("aria-describedby"), /fullCsvHelp/);
    await audit("Full CSV completion");
    await page.evaluate(() => { globalThis.fixtureFail = true; });
    await page.keyboard.press("Enter");
    await page.locator("#csvExportStatus").filter({ hasText: /Export failed.*Fixture report unavailable/ }).waitFor();
    assert.equal(await focusedId(), "exportCsvBtn");
    const exportErrorStyle = await page.locator("#csvExportStatus").evaluate(element => ({ color: getComputedStyle(element).color, weight: getComputedStyle(element).fontWeight }));
    assert.equal(exportErrorStyle.color, "rgb(185, 28, 28)");
    assert.equal(exportErrorStyle.weight, "700");
    assert.equal(await page.locator("#exportCsvBtn").isDisabled(), false, "An export failure preserves the displayed page");
    await audit("Full CSV failure");
    await page.setViewportSize({ width: 320, height: 900 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.locator(".results-card").screenshot({ path: path.join(prefix, "full-csv-mobile.png") });
    console.log("PASS: full CSV is keyboard accessible, preserves focus, announces completion/failure and keeps readable error contrast and mobile layout");
    assert.deepEqual(errors, []);
    console.log("PASS: question-first AI panel, disclosure keyboard access, remembered/missing key states, reviewed examples, textarea shortcuts and progress");
    console.log("Manual screen-reader speech and browser zoom checks remain separate verification.");
  } finally {
    if (releaseAiResponse) releaseAiResponse();
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
