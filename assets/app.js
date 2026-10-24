
    import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev57.0/+esm";

    // URL to attach data.duckdb from GitHub Raw (avoids the S3 .wal 403 error)
    const REMOTE_DUCKDB_URL = "https://raw.githubusercontent.com/gocarta/data.duckdb/main/data.duckdb";
    const GROQ_MODELS = Object.freeze(["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
    // FTA agency identifier, verified against the NTD ID column in the public dataset.
    const CARTA_NTD_ID = "40001";
    const REPORT_TIME_ZONE = "America/New_York";
    const reportTimeFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: REPORT_TIME_ZONE,
      year: "numeric", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short"
    });
    const MAX_RESULT_ROWS = 5000;
    const MAX_RESULT_BYTES = 5 * 1024 * 1024;
    const MAX_RESULT_CELLS = 50000;
    const MAX_RESULT_COLUMNS = 100;
    const MAX_CELL_CHARACTERS = 100000;
    const REPORT_TIMEOUT_MS = 30000;
    const REPORT_PAGE_SIZES = Object.freeze([50, 100, 250, 500, 1000]);

    // Friendly descriptions for CARTA datasets
    const DATASET_INFO = {
      gtfsrt_vehicle_positions_v1: {
        label: "Live Bus Positions (GTFS-RT)",
        tag: "Customer Service",
        desc: "Real-time bus coordinates, vehicle IDs, route IDs, and timestamps."
      },
      clever_vehicle_locations_v1: {
        label: "Clever Vehicle Locations",
        tag: "Operations / Paratransit",
        desc: "Vehicle location history and status reported by Clever Devices."
      },
      clever_predictions_v1: {
        label: "Clever Stop Predictions",
        tag: "Customer Service",
        desc: "Predicted arrival and departure times for upcoming stops."
      },
      gtfsrt_trip_updates_v1: {
        label: "Trip Delays & Updates (GTFS-RT)",
        tag: "Customer Service",
        desc: "Real-time trip delay updates and stop time adjustments."
      },
      simple_bus_routes: {
        label: "Bus Routes Directory",
        tag: "Reference",
        desc: "List of CARTA bus routes, route numbers, and route names."
      },
      simple_bus_stops: {
        label: "Bus Stops Directory",
        tag: "Customer Service",
        desc: "All CARTA bus stop names, IDs, and geographic coordinates."
      },
      scheduled_bus_trips_v1: {
        label: "Scheduled Bus Trips",
        tag: "Scheduling",
        desc: "Scheduled trips across routes and service patterns."
      },
      scheduled_stop_times_v1: {
        label: "Scheduled Stop Times",
        tag: "Scheduling",
        desc: "Scheduled arrival and departure times at individual stops."
      },
      scheduled_service_dates_v1: {
        label: "Scheduled Service Dates",
        tag: "Scheduling",
        desc: "Active calendar service dates for CARTA schedules."
      },
      ntd_monthly_ridership_v1: {
        label: "NTD Monthly Ridership",
        tag: "Management",
        desc: "Monthly ridership totals reported to the National Transit Database."
      },
      bike_chattanooga_stations_v1: {
        label: "Bike Chattanooga Stations",
        tag: "Mobility",
        desc: "Bike share station names, locations, and dock capacity."
      },
      bicycle_repair_stations_v1: {
        label: "Bicycle Repair Stations",
        tag: "Mobility",
        desc: "Public bicycle repair stand locations across Chattanooga."
      },
      hamilton_county_parcels_v1: {
        label: "Hamilton County Parcels",
        tag: "GIS",
        desc: "Property parcel boundaries and attributes in Hamilton County."
      },
      tn_ng911_address_points: {
        label: "TN NG911 Address Points",
        tag: "GIS",
        desc: "Emergency 911 address points and location data."
      }
    };

    // Preset one-click reports
    const PRESET_REPORTS = [
      {
        title: "Latest Bus Vehicle Positions",
        tag: "Customer Service",
        desc: "Browse vehicle positions, newest observation first.",
        sql: 'SELECT * FROM data.gtfsrt_vehicle_positions_v1 ORDER BY NULLIF("timestamp", 0) DESC NULLS LAST;',
        sourceTime: { column: "timestamp", format: "unix-seconds" }
      },
      {
        title: "Clever Vehicle Locations",
        tag: "Operations / Paratransit",
        desc: "Browse Clever vehicle locations, newest timestamp first.",
        sql: 'SELECT * FROM data.clever_vehicle_locations_v1 ORDER BY TRY_CAST("timestamp" AS TIMESTAMPTZ) DESC NULLS LAST;',
        sourceTime: { column: "timestamp", format: "iso" }
      },
      {
        title: "Stop Predictions (Clever)",
        tag: "Customer Service",
        desc: "Show the newest prediction batches first, then the earliest predicted times.",
        sql: `SELECT * FROM data.clever_predictions_v1 ORDER BY try_strptime("tmstmp", '%Y%m%d %H:%M') DESC NULLS LAST, try_strptime("prdtm", '%Y%m%d %H:%M') ASC NULLS LAST;`,
        sourceTime: { column: "tmstmp", format: "clever-local" }
      },
      {
        title: "Trip Updates & Delays (GTFS-RT)",
        tag: "Customer Service",
        desc: "Inspect published trip updates. This dataset does not include an observation timestamp.",
        sql: "SELECT * FROM data.gtfsrt_trip_updates_v1;",
        sourceTime: { unavailable: "Source observation time unavailable: this dataset has no observation timestamp. Predicted arrival and departure times do not establish freshness." }
      },
      {
        title: "CARTA Bus Routes",
        tag: "Reference",
        desc: "Browse CARTA bus routes and route names.",
        sql: "SELECT * FROM data.simple_bus_routes;",
      },
      {
        title: "CARTA Bus Stops",
        tag: "Customer Service",
        desc: "Browse bus stops to look up stop IDs and names for riders.",
        sql: "SELECT * FROM data.simple_bus_stops;",
      },
      {
        title: "CARTA Monthly Ridership (NTD)",
        tag: "Management",
        desc: "View CARTA monthly ridership figures reported to the NTD.",
        sql: `SELECT * FROM data.ntd_monthly_ridership_v1 WHERE "NTD ID" = '${CARTA_NTD_ID}' ORDER BY "Date" DESC;`,
      },
      {
        title: "Bike Chattanooga Stations",
        tag: "Mobility",
        desc: "Browse Bike Chattanooga stations and dock capacities.",
        sql: "SELECT * FROM data.bike_chattanooga_stations_v1;",
      }
    ];

    // State
    let db = null;
    let conn = null;
    let availableViews = [];
    const schemaCache = {}; // viewName -> [{ name, type }]
    let currentRows = [];
    let currentColumns = [];
    let currentReport = null;
    let reportRequestId = 0;
    let activeAiRequestId = null;
    let duckdbWorker = null;
    let currentRequestTitle = "Report";
    const activeQueries = new Set();

    // DOM elements
    const dbStatusDot = document.getElementById("dbStatusDot");
    const dbStatusText = document.getElementById("dbStatusText");
    const presetGrid = document.getElementById("presetGrid");
    const builderDataset = document.getElementById("builderDataset");
    const builderColumn = document.getElementById("builderColumn");
    const builderOperator = document.getElementById("builderOperator");
    const builderValue = document.getElementById("builderValue");
    const builderSortCol = document.getElementById("builderSortCol");
    const builderSortDir = document.getElementById("builderSortDir");
    const runBuilderBtn = document.getElementById("runBuilderBtn");
    const sqlQueryBox = document.getElementById("sqlQueryBox");
    const runCustomSqlBtn = document.getElementById("runCustomSqlBtn");
    const resultsMeta = document.getElementById("resultsMeta");
    const resultsFreshness = document.getElementById("resultsFreshness");
    const resultsScope = document.getElementById("resultsScope");
    const errorBanner = document.getElementById("errorBanner");
    const tableContainer = document.getElementById("tableContainer");
    const exportCsvBtn = document.getElementById("exportCsvBtn");
    const quickSearchInput = document.getElementById("quickSearchInput");
    const stopReportBtn = document.getElementById("stopReportBtn");
    const reconnectBtn = document.getElementById("reconnectBtn");
    const rowsPerPage = document.getElementById("rowsPerPage");
    const previousPageBtn = document.getElementById("previousPageBtn");
    const nextPageBtn = document.getElementById("nextPageBtn");
    const pageStatus = document.getElementById("pageStatus");

    // Plain-English Search DOM elements
    const groqApiKeyInput = document.getElementById("groqApiKeyInput");
    const groqModelSelect = document.getElementById("groqModelSelect");
    const saveGroqKeyBtn = document.getElementById("saveGroqKeyBtn");
    const forgetGroqKeyBtn = document.getElementById("forgetGroqKeyBtn");
    const aiSettings = document.getElementById("aiSettings");
    const aiKeySummary = document.getElementById("aiKeySummary");
    const groqKeyStatus = document.getElementById("groqKeyStatus");
    const aiStatusText = document.getElementById("aiStatusText");
    const aiQuestionInput = document.getElementById("aiQuestionInput");
    const askAiBtn = document.getElementById("askAiBtn");

    // Only explicitly remembered keys are persisted. Storage access can throw even on reads.
    const GROQ_STORAGE_KEY = "carta_groq_api_key";
    let groqStorageWarning = false;

    function updateAiKeySummary() {
      aiKeySummary.textContent = groqStorageWarning
        ? "Review key storage"
        : groqApiKeyInput.value.trim() ? "Key entered" : "Key needed";
      if (groqStorageWarning) aiSettings.open = true;
    }

    function keepGroqKeyInTab(message) {
      try {
        localStorage.removeItem(GROQ_STORAGE_KEY);
        groqStorageWarning = false;
        groqKeyStatus.textContent = message;
      } catch {
        groqStorageWarning = true;
        groqKeyStatus.textContent = "Browser storage could not be cleared. A saved key may remain; clear this site's browser data. You can still use a key in this tab.";
      }
      updateAiKeySummary();
    }

    function loadRememberedGroqKey() {
      groqKeyStatus.textContent = "Enter a key for this tab only, cleared on reload or close.";
      try {
        const saved = localStorage.getItem(GROQ_STORAGE_KEY);
        if (!saved) return;
        let record;
        try { record = JSON.parse(saved); } catch { /* Older versions stored the raw key without consent metadata. */ }
        if (record?.version === 1 && record.remember === true && typeof record.key === "string" && record.key.trim()) {
          groqApiKeyInput.value = record.key.trim();
          groqKeyStatus.textContent = "Remembered key loaded from this browser. Use Forget key to remove it.";
        } else {
          // Preserve legacy raw keys for this tab, but require fresh consent before persisting them.
          if (!saved.trim().startsWith("{") && !saved.trim().startsWith("[")) groqApiKeyInput.value = saved.trim();
          keepGroqKeyInTab(groqApiKeyInput.value
            ? "Previously saved key is now this tab only. Choose Remember on this device to save it again."
            : "Invalid saved key removed. Enter a key for this tab only.");
        }
      } catch {
        groqStorageWarning = true;
        groqKeyStatus.textContent = "Browser storage is unavailable. Enter a key for this tab. A previously saved key may remain; clear this site's browser data to remove it.";
      }
    }

    loadRememberedGroqKey();
    updateAiKeySummary();
    aiSettings.open = !groqApiKeyInput.value.trim() || groqStorageWarning;

    groqApiKeyInput.addEventListener("input", () => {
      keepGroqKeyInTab(groqApiKeyInput.value.trim()
        ? "Key is available in this tab only, cleared on reload or close."
        : "Enter a key for this tab only, cleared on reload or close.");
    });

    saveGroqKeyBtn.addEventListener("click", () => {
      const key = groqApiKeyInput.value.trim();
      if (!key) {
        groqKeyStatus.textContent = "Enter a key before choosing Remember on this device.";
        return;
      }
      try {
        localStorage.setItem(GROQ_STORAGE_KEY, JSON.stringify({ version: 1, remember: true, key }));
        groqStorageWarning = false;
        groqKeyStatus.textContent = "Key remembered on this device across visits. Use Forget key to remove it.";
        updateAiKeySummary();
      } catch {
        keepGroqKeyInTab("Could not remember the key. It is available in this tab only, cleared on reload or close.");
      }
    });

    forgetGroqKeyBtn.addEventListener("click", () => {
      groqApiKeyInput.value = "";
      aiSettings.open = true;
      keepGroqKeyInTab("Key forgotten in this tab and removed from this browser's saved storage.");
      if (activeAiRequestId !== null) {
        if (activeAiRequestId === reportRequestId) {
          beginReportRequest("AI request canceled", "Key forgotten. Choose a public report or enter a new key.");
          resultsMeta.textContent = "AI request canceled after forgetting the key.";
          resultsFreshness.textContent = "No report loaded.";
        }
        activeAiRequestId = null;
        askAiBtn.disabled = !conn;
        if (!activeQueries.size) stopReportBtn.disabled = true;
      }
    });

    // Setup Tabs
    const reportTabs = Array.from(document.querySelectorAll('[role="tab"]'));

    function activateReportTab(tab) {
      for (const candidate of reportTabs) {
        const selected = candidate === tab;
        candidate.setAttribute("aria-selected", String(selected));
        candidate.tabIndex = selected ? 0 : -1;
        candidate.classList.toggle("active", selected);
        const panel = document.getElementById(candidate.getAttribute("aria-controls"));
        panel.hidden = !selected;
        panel.classList.toggle("active", selected);
      }
    }

    reportTabs.forEach((btn, index) => {
      btn.addEventListener("click", () => activateReportTab(btn));
      btn.addEventListener("focus", () => activateReportTab(btn));
      btn.addEventListener("keydown", (event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        let next;
        if (event.key === "ArrowRight") next = (index + 1) % reportTabs.length;
        else if (event.key === "ArrowLeft") next = (index + reportTabs.length - 1) % reportTabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = reportTabs.length - 1;
        else return;
        event.preventDefault();
        reportTabs[next].focus();
      });
    });

    // Render Preset Cards
    function renderPresets() {
      presetGrid.innerHTML = "";
      PRESET_REPORTS.forEach((report) => {
        const btn = document.createElement("button");
        btn.className = "preset-card";
        btn.innerHTML = `
          <div>
            <div class="preset-card-title">${escapeHtml(report.title)}</div>
            <div class="preset-card-desc">${escapeHtml(report.desc)}</div>
          </div>
          <span class="preset-card-tag">${escapeHtml(report.tag)}</span>
        `;
        btn.addEventListener("click", () => {
          // executeQuery displays active-report errors; handle the event's rejected promise.
          executePagedQuery(report.sql, report.title, report.sourceTime).catch(() => {});
        });
        presetGrid.appendChild(btn);
      });
    }

    // Initialize DuckDB-Wasm
    async function initDuckDB() {
      try {
        renderPresets();
        const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
        const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
        const workerUrl = URL.createObjectURL(
          new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
        );
        const worker = new Worker(workerUrl);
        duckdbWorker = worker;
        worker.addEventListener("error", () => {
          if (duckdbWorker === worker) stopReports("The database worker stopped unexpectedly. Reconnect to try again.");
        });
        const logger = new duckdb.VoidLogger();
        db = new duckdb.AsyncDuckDB(logger, worker);
        await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
        URL.revokeObjectURL(workerUrl);

        await db.open({
          path: ":memory:",
          maximumThreads: 1,
          query: {
            queryPollingInterval: 10,
            castBigIntToDouble: true,
            castDecimalToDouble: true,
            castTimestampToDate: true
          }
        });
        conn = await db.connect();
        // A buffer-manager limit supplements streaming and the independent worker watchdog.
        await conn.query("SET memory_limit = '256MB';");

        await conn.query(`ATTACH '${REMOTE_DUCKDB_URL}' AS data (READ_ONLY);`);

        // Get list of views in data
        const viewsResult = await conn.query(`
          SELECT view_name 
          FROM duckdb_views() 
          WHERE database_name = 'data' AND NOT internal 
          ORDER BY view_name;
        `);
        availableViews = viewsResult.toArray().map((r) => r.view_name);

        populateDatasetDropdown();
        dbStatusDot.classList.add("ready");
        dbStatusText.textContent = `Connected (${availableViews.length} CARTA datasets ready)`;
        runBuilderBtn.disabled = false;
        runCustomSqlBtn.disabled = false;
        askAiBtn.disabled = false;
        rowsPerPage.disabled = false;
      } catch (err) {
        dbStatusDot.classList.add("error");
        dbStatusText.textContent = "Connection error";
        showError(`Failed to initialize DuckDB: ${err.message || err}`);
      }
    }

    function populateDatasetDropdown() {
      builderDataset.innerHTML = "";
      availableViews.forEach((viewName) => {
        const info = DATASET_INFO[viewName];
        const opt = document.createElement("option");
        opt.value = viewName;
        opt.textContent = info ? `${info.label} (${viewName})` : viewName;
        builderDataset.appendChild(opt);
      });
      if (availableViews.length > 0) {
        loadColumnsForDataset(availableViews[0]);
      }
    }

    async function getColumnsForView(viewName) {
      if (schemaCache[viewName]) {
        return schemaCache[viewName];
      }
      const res = await conn.query(`DESCRIBE SELECT * FROM data.${viewName};`);
      const cols = res.toArray().map((row) => ({
        name: row.column_name,
        type: row.column_type
      }));
      schemaCache[viewName] = cols;
      return cols;
    }

    async function loadColumnsForDataset(viewName) {
      builderColumn.innerHTML = `<option value="">Loading columns...</option>`;
      builderSortCol.innerHTML = `<option value="">Loading columns...</option>`;
      try {
        const cols = await getColumnsForView(viewName);
        builderColumn.innerHTML = `<option value="">(No column filter)</option>`;
        builderSortCol.innerHTML = `<option value="">(Default order)</option>`;
        cols.forEach((c) => {
          const opt1 = document.createElement("option");
          opt1.value = c.name;
          opt1.textContent = `${c.name} (${c.type})`;
          builderColumn.appendChild(opt1);

          const opt2 = document.createElement("option");
          opt2.value = c.name;
          opt2.textContent = `${c.name} (${c.type})`;
          builderSortCol.appendChild(opt2);
        });
      } catch (err) {
        builderColumn.innerHTML = `<option value="">(Could not load columns)</option>`;
        builderSortCol.innerHTML = `<option value="">(Default order)</option>`;
      }
    }

    builderDataset.addEventListener("change", () => {
      loadColumnsForDataset(builderDataset.value);
    });

    // Build and execute query from Visual Filter Builder
    runBuilderBtn.addEventListener("click", () => {
      const view = builderDataset.value;
      const col = builderColumn.value;
      const op = builderOperator.value;
      const val = builderValue.value.trim();
      const sortCol = builderSortCol.value;
      const sortDir = builderSortDir.value;

      let sql = `SELECT * FROM data."${view}"`;
      if (col) {
        const safeCol = `"${col.replace(/"/g, '""')}"`;
        const safeVal = val.replace(/'/g, "''");
        if (op === "IS NOT NULL") {
          sql += ` WHERE ${safeCol} IS NOT NULL`;
        } else if (val !== "") {
          if (op === "ILIKE_CONTAINS") {
            sql += ` WHERE CAST(${safeCol} AS VARCHAR) ILIKE '%${safeVal}%'`;
          } else if (op === "ILIKE_STARTS") {
            sql += ` WHERE CAST(${safeCol} AS VARCHAR) ILIKE '${safeVal}%'`;
          } else {
            const isNum = !isNaN(Number(val)) && val !== "";
            const rhs = isNum ? val : `'${safeVal}'`;
            sql += ` WHERE ${safeCol} ${op} ${rhs}`;
          }
        }
      }
      if (sortCol) {
        const safeSort = `"${sortCol.replace(/"/g, '""')}"`;
        sql += ` ORDER BY ${safeSort} ${sortDir}`;
      }
      sql += ";";

      const label = DATASET_INFO[view]?.label || view;
      executePagedQuery(sql, label).catch(() => {});
    });

    runCustomSqlBtn.addEventListener("click", () => {
      const sql = sqlQueryBox.value.trim();
      if (sql) {
        executePagedQuery(sql, "Custom SQL Query").catch(() => {});
      }
    });

    // Execute a SQL query and render table
    function reportLimitError(message) {
      const error = new Error(message);
      error.code = "REPORT_LIMIT";
      return error;
    }

    function stopReports(message = "Report stopped. Reconnect to run another report.") {
      ++reportRequestId;
      activeAiRequestId = null;
      const worker = duckdbWorker;
      const bindings = db;
      duckdbWorker = null;
      conn = null;
      db = null;
      if (worker) worker.terminate();
      if (bindings) {
        try { bindings.detach(); } catch { /* The reconnect action must remain available after a worker failure. */ }
      }
      const error = reportLimitError(message);
      for (const operation of activeQueries) {
        clearTimeout(operation.timer);
        operation.reject(error);
      }
      showReportError(currentRequestTitle, error);
      stopReportBtn.disabled = true;
      reconnectBtn.hidden = false;
      runBuilderBtn.disabled = true;
      runCustomSqlBtn.disabled = true;
      askAiBtn.disabled = true;
      for (const button of presetGrid.querySelectorAll("button")) button.disabled = true;
      dbStatusDot.classList.remove("ready");
      dbStatusDot.classList.add("error");
      dbStatusText.textContent = "Stopped. Reconnect to run another report.";
    }

    stopReportBtn.addEventListener("click", () => stopReports());
    reconnectBtn.addEventListener("click", () => globalThis.location.reload());

    async function collectReportRows(reader, requestId, page = null) {
      await reader.open();
      if (requestId !== reportRequestId) return null;
      const columns = reader.schema.fields.map((field) => field.name);
      if (columns.length > MAX_RESULT_COLUMNS) throw reportLimitError("This report has too many columns. Select fewer columns and try again.");
      const encoder = new TextEncoder();
      let bytes = columns.reduce((size, column) => size + encoder.encode(column).byteLength, 0);
      const rows = [];
      const partial = (reason) => {
        if (!rows.length) throw reportLimitError("A result row is too large to display safely. Select fewer columns or narrow the report.");
        return { columns, rows, truncated: true, reason, ...(page ? { hasMore: true } : {}) };
      };
      for await (const batch of reader) {
        if (requestId !== reportRequestId) return null;
        for (let index = 0; index < batch.numRows; index++) {
          if (page && rows.length >= page.size) return { columns, rows, truncated: false, hasMore: true };
          if (rows.length >= MAX_RESULT_ROWS) return partial("row limit");
          if ((rows.length + 1) * columns.length > MAX_RESULT_CELLS) return partial("output size");
          const sourceRow = batch.get(index);
          const row = {};
          let rowBytes = 0;
          for (const column of columns) {
            const value = sourceRow[column];
            if ((typeof value === "string" && value.length > MAX_CELL_CHARACTERS) ||
                (value && typeof value === "object" && (value.byteLength > MAX_CELL_CHARACTERS || value.length > MAX_CELL_CHARACTERS))) return partial("large cell");
            const text = formatCellValue(value);
            if (text.length > MAX_CELL_CHARACTERS) return partial("large cell");
            rowBytes += encoder.encode(text).byteLength;
            if (bytes + rowBytes > MAX_RESULT_BYTES) return partial("output size");
            row[column] = text;
          }
          bytes += rowBytes;
          rows.push(row);
        }
        // Let the main thread process Stop and deadline events between result batches.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return { columns, rows, truncated: false, ...(page ? { hasMore: false } : {}) };
    }

    async function runBoundedReport(sql, requestId, page = null) {
      const bindings = db;
      let reject;
      const stopped = new Promise((resolve, no) => { reject = no; });
      const operation = { reject, timer: null };
      activeQueries.add(operation);
      operation.timer = setTimeout(() => stopReports("Report stopped after 30 seconds. Reconnect, then narrow the query."), REPORT_TIMEOUT_MS);
      const work = (async () => {
        let queryConnection = null;
        let reader = null;
        let complete = false;
        try {
          queryConnection = await bindings.connect();
          if (requestId !== reportRequestId) return null;
          const parsed = await validateCartaSql(sql, queryConnection);
          if (requestId !== reportRequestId) return null;
          let executionSql = sql;
          if (page) {
            if (!Number.isSafeInteger(page.offset) || page.offset < 0 || !Number.isSafeInteger(page.size) || page.size < 1 || page.size > 1000 || !Number.isSafeInteger(page.offset + page.size + 1)) throw reportLimitError("Invalid report page.");
            const normalized = await normalizeReportSql(parsed, queryConnection, sql);
            if (requestId !== reportRequestId) return null;
            executionSql = `SELECT * FROM (${normalized.sql}) AS "carta_page"${normalized.ordered ? "" : " ORDER BY ALL"} LIMIT ${page.size + 1} OFFSET ${page.offset}`;
          }
          reader = await queryConnection.send(executionSql, true);
          const result = await collectReportRows(reader, requestId, page);
          complete = result !== null && !result.truncated && !result.hasMore;
          return result;
        } finally {
          // A hard stop discards this worker. Never await cleanup messages to a dead worker.
          if (db === bindings) {
            try {
              if (queryConnection && !complete) await queryConnection.cancelSent();
              if (reader) await reader.cancel();
            } finally {
              if (queryConnection) await queryConnection.close();
            }
          }
        }
      })();
      try {
        return await Promise.race([work, stopped]);
      } finally {
        clearTimeout(operation.timer);
        activeQueries.delete(operation);
        if (!activeQueries.size && activeAiRequestId === null) stopReportBtn.disabled = true;
      }
    }

    function clearResults() {
      currentRows = [];
      currentColumns = [];
      currentReport = null;
      quickSearchInput.disabled = true;
      exportCsvBtn.disabled = true;
      exportCsvBtn.textContent = "Download this page (CSV)";
      previousPageBtn.disabled = true;
      nextPageBtn.disabled = true;
      rowsPerPage.disabled = true;
      pageStatus.textContent = "No page loaded";
    }

    function beginReportRequest(title, message = "Loading data from CARTA S3...") {
      const requestId = ++reportRequestId;
      currentRequestTitle = title;
      stopReportBtn.disabled = false;
      clearResults();
      hideError();
      sqlQueryBox.value = "";
      aiStatusText.textContent = "";
      resultsMeta.textContent = `Running: ${title}...`;
      resultsFreshness.textContent = "Waiting for query results...";
      resultsScope.textContent = "";
      tableContainer.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
      return requestId;
    }

    function showReportError(title, err) {
      clearResults();
      resultsMeta.textContent = `${title}: Error`;
      resultsFreshness.textContent = "Source freshness unavailable because the report did not complete.";
      resultsScope.textContent = "No results available for this query.";
      tableContainer.innerHTML = `<div class="empty-state">Query could not be completed.</div>`;
      showError(err.message || String(err));
    }

    function executePagedQuery(sql, title = "Query Results", sourceTime = null, requestId = null, page = null) {
      const size = Number(rowsPerPage.value);
      return executeQuery(sql, title, sourceTime, null, requestId, page || {
        size: REPORT_PAGE_SIZES.includes(size) ? size : 100, offset: 0, previous: []
      });
    }

    async function navigateReportPage(direction) {
      const report = currentReport;
      if (!report?.page || (direction === "next" && !report.page.hasMore) || (direction === "previous" && !report.page.previous.length)) return;
      const control = direction === "next" ? nextPageBtn : previousPageBtn;
      const restoreFocus = document.activeElement === control;
      const page = report.page;
      const previous = [...page.previous];
      const offset = direction === "next" ? page.offset + currentRows.length : previous.pop();
      if (direction === "next") previous.push(page.offset);
      const pageRequestId = reportRequestId + 1;
      try {
        await executePagedQuery(report.querySql, report.title, report.sourceTime, null, { size: page.size, offset, previous });
      } catch { /* The shared execution path displays errors and invalidates exports. */ }
      if (pageRequestId !== reportRequestId) return;
      if (restoreFocus && (document.activeElement === document.body || document.activeElement === control)) {
        const other = direction === "next" ? previousPageBtn : nextPageBtn;
        const target = control.disabled ? (other.disabled ? rowsPerPage : other) : control;
        if (!target.disabled) target.focus();
        else if (!reconnectBtn.hidden) reconnectBtn.focus();
      }
    }

    previousPageBtn.addEventListener("click", () => navigateReportPage("previous"));
    nextPageBtn.addEventListener("click", () => navigateReportPage("next"));
    rowsPerPage.addEventListener("change", async () => {
      const report = currentReport;
      if (!report?.page) return;
      const restoreFocus = document.activeElement === rowsPerPage;
      const pageRequestId = reportRequestId + 1;
      try { await executePagedQuery(report.querySql, report.title, report.sourceTime); } catch { /* Shared report error handling. */ }
      if (pageRequestId === reportRequestId && restoreFocus && !rowsPerPage.disabled && (document.activeElement === document.body || document.activeElement === rowsPerPage)) rowsPerPage.focus();
    });

    async function executeQuery(sql, title = "Query Results", sourceTime = null, rowLimit = null, requestId = null, page = null) {
      if (!conn) return;
      if (requestId === null) requestId = beginReportRequest(title);
      if (requestId !== reportRequestId) return;
      clearResults();
      hideError();
      sqlQueryBox.value = sql;
      resultsMeta.textContent = `Running: ${title}...`;
      resultsFreshness.textContent = "Checking source timestamps...";
      resultsScope.textContent = "";
      tableContainer.innerHTML = `<div class="empty-state">Loading data from CARTA S3...</div>`;
      exportCsvBtn.disabled = true;

      const t0 = performance.now();
      try {
        const result = await runBoundedReport(sql, requestId, page);
        if (requestId !== reportRequestId || !result) return;
        const elapsedMs = Math.round(performance.now() - t0);

        currentColumns = result.columns;
        currentRows = result.rows;
        currentReport = { title, elapsedMs, truncated: result.truncated, ...(page ? {
          querySql: sql, sourceTime, page: { ...page, hasMore: result.hasMore }
        } : {}) };
        resultsScope.textContent = page
          ? `${result.truncated ? `Partial page: loaded ${result.rows.length} rows (${result.reason}); use Next to continue. ` : ""}Report SQL defines the matching rows. Browse them a page at a time. Search checks this page only; CSV contains all loaded rows on this page, including rows hidden by search. Source changes or tied sort values may shift rows between pages.`
          : describeResultScope(rowLimit, result);
        resultsFreshness.textContent = `${describeSourceFreshness(currentRows, sourceTime)} Report retrieved: ${reportTimeFormatter.format(new Date())} (${REPORT_TIME_ZONE}).`;
        exportCsvBtn.disabled = currentRows.length === 0;
        exportCsvBtn.textContent = page ? `Download this page (CSV${result.truncated ? ", partial" : ""})` : `Download all ${currentRows.length.toLocaleString()} loaded rows (CSV${result.truncated ? ", partial" : ""})`;
        quickSearchInput.disabled = currentRows.length === 0;
        if (page) {
          const number = page.previous.length + 1;
          pageStatus.textContent = currentRows.length
            ? `Page ${number} · Rows ${(page.offset + 1).toLocaleString()}–${(page.offset + currentRows.length).toLocaleString()} · ${result.hasMore ? "more available" : "end of results"}`
            : `Page ${number} · No rows${page.offset ? "; source data may have changed" : ""}`;
          previousPageBtn.disabled = !page.previous.length;
          nextPageBtn.disabled = !result.hasMore;
        }
        applyQuickFilter();
      } catch (err) {
        if (requestId !== reportRequestId) return;
        showReportError(title, err);
        throw err;
      } finally {
        if (requestId === reportRequestId) rowsPerPage.disabled = !conn;
      }
    }

    function describeResultScope(rowLimit, result = null) {
      const scope = Number.isInteger(rowLimit) && rowLimit > 0
        ? `Limited preview: up to ${rowLimit.toLocaleString()} rows. Additional matching records may exist.`
        : "Query results only; completeness against the full dataset has not been verified.";
      const safety = result?.truncated
        ? `Partial result: output was truncated after ${result.rows.length.toLocaleString()} rows (${result.reason}). This is not a complete result. Narrow the report or select fewer columns.`
        : `Reports load at most ${MAX_RESULT_ROWS.toLocaleString()} rows and also have output-size limits.`;
      return `${safety} ${scope} Search applies to loaded rows only. CSV downloads include all loaded rows, including rows hidden by the search.`;
    }

    function parseSourceTime(value, format) {
      if (value === null || value === undefined || String(value).trim() === "") return null;
      const text = String(value).trim();
      if (format === "clever-local") {
        const match = text.match(/^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2})$/);
        if (!match) return null;
        const localTime = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}`;
        // Use UTC only to validate and order wall-clock values, never to infer their timezone.
        const date = new Date(`${localTime}:00Z`);
        if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 16) !== localTime) return null;
        return { order: date.getTime(), label: `${localTime.replace("T", " ")} (source local time; timezone not supplied)` };
      }
      let milliseconds;
      if (format === "unix-seconds") {
        const seconds = Number(text);
        if (!Number.isFinite(seconds) || seconds <= 0) return null;
        milliseconds = seconds * 1000;
      } else if (format === "iso" && /(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) {
        milliseconds = Date.parse(text);
      } else {
        return null;
      }
      const date = new Date(milliseconds);
      if (!Number.isFinite(date.getTime())) return null;
      return { order: date.getTime(), label: `${reportTimeFormatter.format(date)} (${REPORT_TIME_ZONE})` };
    }

    function describeSourceFreshness(rows, sourceTime) {
      if (!rows.length) return "No records returned; source observation time unavailable.";
      if (sourceTime?.unavailable) return sourceTime.unavailable;
      if (!sourceTime) return "Source observation time not identified for this report.";
      let newest = null;
      let missing = 0;
      for (const row of rows) {
        const timestamp = parseSourceTime(row[sourceTime.column], sourceTime.format);
        if (!timestamp) missing++;
        else if (!newest || timestamp.order > newest.order) newest = timestamp;
      }
      if (!newest) return "Source observation time unavailable: timestamps are missing or invalid.";
      const missingNote = missing ? ` ${missing} of ${rows.length} rows have missing or invalid source timestamps.` : "";
      return `Newest source timestamp in returned rows: ${newest.label}.${missingNote}`;
    }

    function formatCellValue(val) {
      if (val === null || val === undefined) return "";
      if (val instanceof Date) return val.toISOString();
      if (typeof val === "object") {
        try {
          return JSON.stringify(val);
        } catch {
          return String(val);
        }
      }
      return String(val);
    }

    function renderTable(rows) {
      if (rows.length === 0) {
        tableContainer.innerHTML = `<div class="empty-state">No matching records found.</div>`;
        return;
      }

      const thead = `<thead><tr>${currentColumns
        .map((c) => `<th scope="col">${escapeHtml(c)}</th>`)
        .join("")}</tr></thead>`;

      const tbody = `<tbody>${rows
        .map(
          (r) =>
            `<tr>${currentColumns
              .map((c) => `<td title="${escapeHtml(r[c])}">${escapeHtml(r[c])}</td>`)
              .join("")}</tr>`
        )
        .join("")}</tbody>`;

      tableContainer.innerHTML = `<table aria-label="Loaded report rows">${thead}${tbody}</table>`;
    }

    // Quick client-side row search
    function applyQuickFilter() {
      if (!currentReport) return;
      const term = quickSearchInput.value.trim().toLowerCase();
      const filtered = term
        ? currentRows.filter((row) =>
            currentColumns.some((col) => String(row[col]).toLowerCase().includes(term))
          )
        : currentRows;
      if (currentReport) {
        resultsMeta.textContent = `${currentReport.title}: ${filtered.length.toLocaleString()} displayed / ${currentRows.length.toLocaleString()} loaded rows${currentReport.page ? ` on page ${currentReport.page.previous.length + 1}` : ""} (${currentReport.elapsedMs} ms)${currentReport.truncated ? " [Partial result]" : ""}`;
      }
      renderTable(filtered);
    }

    quickSearchInput.addEventListener("input", applyQuickFilter);

    // Export current results to CSV
    exportCsvBtn.addEventListener("click", () => {
      if (!currentReport || exportCsvBtn.disabled || !currentRows.length) return;
      const csvLines = [
        currentColumns.map((col) => csvEscape(col, true)).join(","),
        ...currentRows.map((row) => currentColumns.map((col) => csvEscape(row[col])).join(","))
      ];
      // Excel recognizes UTF-8 reliably when the file starts with its byte-order mark.
      const blob = new Blob(["\uFEFF", csvLines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `carta_report_${new Date().toISOString().slice(0, 10)}${currentReport.page ? `_page_${currentReport.page.previous.length + 1}` : ""}${currentReport.truncated ? "_partial" : ""}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });

    function csvEscape(val, isHeader = false) {
      let str = String(val ?? "");
      // A complete decimal/scientific literal is safe, including negative coordinates and totals.
      // Never exempt headers or arithmetic expressions based on a numeric-looking prefix.
      const plainNumber = !isHeader && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(str);
      const formulaLike = /^[\s\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u206F]*[=+@\-\uFF1D\uFF0B\uFF0D\uFF20]/u.test(str) || /^[\t\r\n]/.test(str);
      const protect = !plainNumber && formulaLike;
      // A quoted tab prefix protects formula-like cells in Excel; it remains part of CSV data.
      if (protect) str = `\t${str}`;
      if (protect || /[",\r\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }

    // =========================================================================
    // PLAIN ENGLISH TO SQL (Schema-Aware Natural Language Translator)
    // =========================================================================
    const VIEW_KEYWORDS = {
      bike_chattanooga_stations_v1: ["bike", "chattanooga", "station", "stations", "dock", "docks", "capacity", "bikes", "bikeshare"],
      bicycle_repair_stations_v1: ["repair", "bicycle repair", "stand", "pump", "tools"],
      clever_vehicle_locations_v1: ["clever", "vehicle location", "vehicle locations", "paratransit", "bus location"],
      clever_predictions_v1: ["prediction", "predictions", "arrival", "arrivals", "departure", "upcoming", "eta"],
      gtfsrt_vehicle_positions_v1: ["gtfsrt", "live bus", "vehicle position", "vehicle positions", "real-time", "realtime", "gps"],
      gtfsrt_trip_updates_v1: ["delay", "delays", "trip update", "trip updates", "late", "adherence"],
      ntd_monthly_ridership_v1: ["ridership", "ntd", "monthly", "passenger", "passengers", "boardings", "upt", "summary"],
      simple_bus_routes: ["route", "routes", "bus route", "bus routes", "line", "lines"],
      simple_bus_stops: ["stop", "stops", "bus stop", "bus stops", "shelter"],
      scheduled_bus_trips_v1: ["scheduled trip", "scheduled trips", "bus trip", "bus trips"],
      scheduled_stop_times_v1: ["stop time", "stop times", "timetable", "scheduled time"],
      scheduled_service_dates_v1: ["service date", "service dates", "calendar", "holiday"],
      hamilton_county_parcels_v1: ["parcel", "parcels", "property", "hamilton", "land", "tax"],
      tn_ng911_address_points: ["address", "addresses", "911", "ng911", "street"]
    };

    // Example prompt chips
    document.querySelectorAll(".chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        aiQuestionInput.value = chip.dataset.prompt;
        aiQuestionInput.focus();
      });
    });

    aiQuestionInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing && !askAiBtn.disabled) {
        e.preventDefault();
        askAiBtn.click();
      }
    });

    function matchBestView(question) {
      const qLower = question.toLowerCase();
      // 1. Exact view name match in prompt
      for (const v of availableViews) {
        if (qLower.includes(v.toLowerCase())) {
          return v;
        }
      }

      // 2. Score against keywords and DATASET_INFO
      let bestView = availableViews.includes("simple_bus_routes")
        ? "simple_bus_routes"
        : availableViews[0];
      let bestScore = -1;

      for (const v of availableViews) {
        let score = 0;
        const kws = VIEW_KEYWORDS[v] || [];
        for (const kw of kws) {
          if (qLower.includes(kw)) {
            score += kw.includes(" ") ? 8 : 4;
          }
        }
        // Disambiguate bike stations vs repair stations
        if (v === "bicycle_repair_stations_v1" && !qLower.includes("repair")) {
          score -= 5;
        }
        const info = DATASET_INFO[v] || {};
        const words = `${v} ${info.label || ""}`.toLowerCase().split(/\W+/);
        for (const w of words) {
          if (w.length >= 4 && w !== "data" && qLower.includes(w)) {
            score += 2;
          }
        }
        if (score > bestScore) {
          bestScore = score;
          bestView = v;
        }
      }
      return bestView;
    }

    const sampleCache = {}; // viewName -> string summary of 1 sample row

    async function getSampleRowForView(viewName) {
      if (sampleCache[viewName] !== undefined) {
        return sampleCache[viewName];
      }
      try {
        const res = await conn.query(`SELECT * FROM data.${viewName} LIMIT 1;`);
        const rows = res.toArray();
        if (!rows.length) {
          sampleCache[viewName] = "";
          return "";
        }
        const row = rows[0];
        const fields = res.schema.fields.map((f) => f.name);
        const pairs = fields.slice(0, 12).map((col) => {
          const val = formatCellValue(row[col]);
          const shortVal = val.length > 32 ? `${val.slice(0, 32)}...` : val;
          return `"${col}"=${JSON.stringify(shortVal)}`;
        });
        sampleCache[viewName] = pairs.join(", ");
        return sampleCache[viewName];
      } catch {
        sampleCache[viewName] = "";
        return "";
      }
    }

    async function buildGroqSchemaPrompt(question) {
      const qLower = question.toLowerCase();
      const primaryView = matchBestView(question);
      const selected = new Set([primaryView]);

      // Add up to 2 additional related views so token usage stays around ~300 tokens/query
      for (const v of availableViews) {
        if (selected.size >= 3) break;
        const kws = VIEW_KEYWORDS[v] || [];
        if (qLower.includes(v.toLowerCase()) || kws.some((kw) => qLower.includes(kw))) {
          selected.add(v);
        }
      }

      const lines = [];
      for (const v of selected) {
        try {
          const cols = await getColumnsForView(v);
          const colStr = cols.map((c) => `"${c.name}" (${c.type})`).join(", ");
          const sampleStr = await getSampleRowForView(v);
          lines.push(`Table data.${v}: ${colStr}`);
          if (sampleStr) {
            lines.push(`  Sample row for data.${v}: ${sampleStr}`);
          }
        } catch {
          lines.push(`Table data.${v}`);
        }
      }
      const otherViews = availableViews.filter((v) => !selected.has(v)).map((v) => `data.${v}`).join(", ");
      if (otherViews) {
        lines.push(`Other available tables: ${otherViews}`);
      }
      return lines.join("\n");
    }

    function extractSql(raw) {
      let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      if (/^UNSUPPORTED_QUERY\b/i.test(cleaned)) {
        return "UNSUPPORTED_QUERY";
      }
      const fenceMatch = cleaned.match(/```(?:sql)?\s*([\s\S]*?)```/i);
      if (fenceMatch) {
        cleaned = fenceMatch[1].trim();
      }
      if (/^UNSUPPORTED_QUERY\b/i.test(cleaned)) {
        return "UNSUPPORTED_QUERY";
      }
      const selectIdx = cleaned.search(/\b(SELECT|WITH)\b/i);
      if (selectIdx > 0) {
        cleaned = cleaned.slice(selectIdx).trim();
      }
      return cleaned;
    }

    function isOffTopicQuestion(question) {
      // Block obvious general chatbot / coding / jailbreak prompts locally (uses 0 Groq tokens)
      const blockedPatterns = /\b(write\s+(?:a|an|me)?\s*(?:python|javascript|java|c\+\+|html|code|script|program|poem|essay|story|song|email|letter|joke|recipe)|meaning\s+of\s+life|ignore\s+(?:all\s+)?previous\s+instructions|system\s+prompt|reverse\s+a\s+sentence|fibonacci|fizzbuzz)\b/i;
      return blockedPatterns.test(question);
    }

    async function validateCartaSql(sql, queryConnection = conn) {
      if (!sql || sql === "UNSUPPORTED_QUERY") {
        throw new Error(
          "Only questions about CARTA datasets (bus routes, stops, vehicle locations, predictions, trip delays, ridership, bike stations, parcels, or addresses) are supported."
        );
      }

      if (typeof sql !== "string" || sql.length > 50000) throw new Error("The SQL query is too long.");
      // Bind SQL as a value. Serialization parses it without binding tables or executing it.
      const statement = await queryConnection.prepare("SELECT json_serialize_sql(CAST(? AS VARCHAR)) AS ast");
      let parsed;
      try {
        const result = await statement.query(sql);
        parsed = JSON.parse(result.toArray()[0].ast);
      } finally {
        await statement.close();
      }
      validateCartaSqlAst(parsed, availableViews);
      return parsed;
    }

    async function normalizeReportSql(parsed, queryConnection) {
      const statement = await queryConnection.prepare("SELECT json_deserialize_sql(CAST(? AS JSON)) AS sql");
      try {
        const result = await statement.query(JSON.stringify(parsed));
        const sql = result.toArray()[0].sql;
        if (typeof sql !== "string" || !sql.trim()) throw reportLimitError("Could not prepare the report page.");
        return {
          sql: sql.trim().replace(/;$/, ""),
          ordered: parsed.statements[0].node.modifiers?.some(modifier => modifier.type === "ORDER_MODIFIER") || false
        };
      } finally { await statement.close(); }
    }

    function validateCartaSqlAst(parsed, views) {
      if (parsed?.error || !Array.isArray(parsed?.statements) || parsed.statements.length !== 1) {
        throw new Error("Run one valid read-only SELECT query on CARTA datasets.");
      }
      const allowedViews = new Set(views.map((view) => view.toLowerCase()));
      const allowedFunctions = new Set([
        "+", "-", "*", "/", "//", "%", "**", "^", "||", "~~", "!~~", "~~*", "!~~*",
        "abs", "round", "ceil", "ceiling", "floor", "sqrt", "pow", "power", "sign",
        "sum", "avg", "count", "count_star", "min", "max", "median", "mode", "stddev", "stddev_pop", "stddev_samp", "variance", "var_pop", "var_samp",
        "first", "last", "any_value", "arg_min", "arg_max", "string_agg", "list", "array_agg", "bool_and", "bool_or", "approx_count_distinct",
        "lower", "upper", "length", "char_length", "trim", "ltrim", "rtrim", "replace", "substring", "substr", "left", "right", "concat", "concat_ws", "starts_with", "ends_with", "contains", "regexp_matches", "regexp_replace", "split_part",
        "nullif", "coalesce", "ifnull", "if", "greatest", "least",
        "date_part", "date_trunc", "date_diff", "date_sub", "date_add", "strftime", "strptime", "try_strptime", "epoch", "epoch_ms", "to_timestamp", "make_date", "make_timestamp", "year", "month", "day", "dayofweek", "dayname", "monthname", "quarter", "week", "last_day", "current_date", "current_timestamp", "now", "timezone",
        "row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile", "lag", "lead", "first_value", "last_value", "nth_value",
        "st_distance", "st_distance_sphere", "st_dwithin", "st_intersects", "st_contains", "st_within", "st_x", "st_y", "st_astext", "st_asgeojson", "st_point", "st_area", "st_length", "st_centroid"
      ]);
      const allowedExpressions = new Set(["CONSTANT", "COLUMN_REF", "STAR", "CAST", "CASE", "COMPARISON", "CONJUNCTION", "OPERATOR", "FUNCTION", "WINDOW", "SUBQUERY", "BETWEEN", "COLLATE", "LAMBDA", "TYPE"]);
      let visited = 0;
      const reject = (message) => { throw new Error(message); };
      const checkSize = () => { if (++visited > 10000) reject("The SQL query is too complex."); };

      function inspectValue(value, scope) {
        checkSize();
        if (!value || typeof value !== "object") return false;
        if (Array.isArray(value)) {
          let readsCarta = false;
          for (const child of value) readsCarta = inspectValue(child, scope) || readsCarta;
          return readsCarta;
        }
        if (typeof value.type === "string" && value.type.endsWith("_NODE")) return inspectQuery(value, scope);
        if (!value.class && ["BASE_TABLE", "SUBQUERY", "JOIN", "CROSS_PRODUCT", "EMPTY", "TABLE_FUNCTION"].includes(value.type)) return inspectTable(value, scope);
        if (value.class && !allowedExpressions.has(value.class)) reject(`Unsupported SQL expression: ${value.class}.`);
        if (value.class === "FUNCTION" || value.class === "WINDOW") {
          const schema = (value.schema || "").toLowerCase();
          const path = value.qualified_name?.path;
          const builtinPath = !path || path.length === 1 || (path.length === 2 && path[0].toLowerCase() === "main");
          // Older parsers qualify EXTRACT's date_part function with the built-in main schema.
          if (!["", "main"].includes(schema) || value.catalog || !builtinPath || !allowedFunctions.has(value.function_name?.toLowerCase())) {
            reject(`Function is not permitted in CARTA reports: ${value.function_name || "unknown"}.`);
          }
        }
        let readsCarta = false;
        for (const child of Object.values(value)) readsCarta = inspectValue(child, scope) || readsCarta;
        return readsCarta;
      }

      function resolveCte(cte) {
        if (cte.resolving) reject("Recursive CTEs are not supported in CARTA reports.");
        if (cte.checked) return cte.readsCarta;
        cte.resolving = true;
        cte.readsCarta = inspectQuery(cte.node, cte.scope);
        cte.resolving = false;
        cte.checked = true;
        return cte.readsCarta;
      }

      function inspectTable(table, scope) {
        checkSize();
        if (!table || typeof table !== "object") reject("Unsupported SQL data source.");
        if (table.type === "BASE_TABLE") {
          if (table.at_clause) reject("Historical table references are not supported.");
          const name = table.table_name?.toLowerCase();
          const schema = (table.schema_name || "").toLowerCase();
          const catalog = (table.catalog_name || "").toLowerCase();
          let readsCarta;
          if (!schema && !catalog && scope.has(name)) readsCarta = resolveCte(scope.get(name));
          else if (allowedViews.has(name) && ((!catalog && schema === "data") || (catalog === "data" && schema === "main"))) readsCarta = true;
          else reject("Every table must be an available CARTA dataset (data.<view>) or a CTE derived from permitted sources.");
          for (const value of Object.values(table)) inspectValue(value, scope);
          return readsCarta;
        }
        if (table.type === "EMPTY") return false;
        if (table.type === "SUBQUERY") {
          let readsCarta = false;
          for (const value of Object.values(table)) readsCarta = inspectValue(value, scope) || readsCarta;
          return readsCarta;
        }
        if (table.type === "JOIN" || table.type === "CROSS_PRODUCT") {
          let readsCarta = inspectTable(table.left, scope);
          readsCarta = inspectTable(table.right, scope) || readsCarta;
          for (const [key, value] of Object.entries(table)) {
            if (key !== "left" && key !== "right") readsCarta = inspectValue(value, scope) || readsCarta;
          }
          return readsCarta;
        }
        reject("Table functions, external files, and this SQL data-source syntax are not permitted.");
      }

      function inspectQuery(node, inheritedScope = new Map()) {
        checkSize();
        if (!node || !["SELECT_NODE", "SET_OPERATION_NODE"].includes(node.type)) reject("Only SELECT queries and non-recursive reporting CTEs are supported.");
        const scope = new Map(inheritedScope);
        const entries = node.cte_map?.map || [];
        if (!Array.isArray(entries)) reject("Unsupported CTE structure.");
        const definitions = [];
        for (const entry of entries) {
          const queryNode = entry.value?.query_node || entry.value?.query?.node;
          if (typeof entry.key !== "string" || !queryNode) reject("Unsupported CTE structure.");
          const cte = { node: queryNode, scope, checked: false, resolving: false };
          scope.set(entry.key.toLowerCase(), cte);
          definitions.push(cte);
        }
        // Inspect even unused CTEs, but count their sources only if the query actually refers to them.
        for (const cte of definitions) resolveCte(cte);
        let readsCarta = false;
        if (node.type === "SET_OPERATION_NODE") {
          const branches = node.children || [node.left, node.right];
          if (!Array.isArray(branches) || branches.length < 2) reject("Unsupported set operation.");
          for (const branch of branches) {
            if (!inspectQuery(branch, scope)) reject("Every UNION, INTERSECT, or EXCEPT branch must query CARTA datasets.");
          }
          readsCarta = true;
        } else {
          readsCarta = inspectTable(node.from_table, scope);
        }
        for (const [key, value] of Object.entries(node)) {
          if (!["cte_map", "from_table", "children", "left", "right"].includes(key)) readsCarta = inspectValue(value, scope) || readsCarta;
        }
        return readsCarta;
      }

      if (!inspectQuery(parsed.statements[0].node)) reject("The query must read a CARTA dataset; comments, literals, and unused CTEs do not count as data sources.");
    }

    async function callGroqChat(apiKey, model, systemPrompt, userPrompt) {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 1024,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ]
        })
      });
      return res;
    }

    async function generateSqlWithGroq(apiKey, question, retryError = "", requestId = null) {
      const isCurrent = () => requestId === null || requestId === reportRequestId;
      const schemaText = await buildGroqSchemaPrompt(question);
      if (!isCurrent()) return null;
      const systemPrompt = `You are a DuckDB SQL expert for Chattanooga Area Regional Transportation Authority (CARTA).
Write a single valid DuckDB SQL query to answer the user's question. Output ONLY the SQL query, with no explanation or markdown.
Rules:
1. Always prefix table names with data. (for example: data.simple_bus_routes).
2. Always wrap column names in double quotes (for example: "Legacy NTD ID", "UZA Name", "UPT").
3. In data.ntd_monthly_ridership_v1 (national NTD dataset):
   - CARTA's "NTD ID" is '${CARTA_NTD_ID}'. For CARTA questions, use WHERE "NTD ID" = '${CARTA_NTD_ID}'. Its separate "Legacy NTD ID" is '4001'; do not confuse these columns.
   - Default to CARTA only. Omit or change this agency filter only when the user explicitly requests another agency or a regional/national comparison. Do not identify CARTA by "Agency" text or "UZA Name", which describe names or geography rather than the exact agency identifier.
   - The "Mode" column uses 2-letter NTD codes: 'MB' (Motor Bus), 'DR' (Demand Response / Paratransit), 'IP' (Inclined Plane). The "3 Mode" column uses 'Bus' or 'Demand Response'.
4. Do not add LIMIT unless the user explicitly requests a fixed number of records or a top/bottom list. The application paginates results separately; it does not need a preview LIMIT. Use a deterministic ORDER BY where practical.
5. STRICT GUARDRAIL: Every query MUST include a FROM data.<table_name> clause referencing one of the tables in Schema. Never output a SELECT with only literal strings/numbers to answer general knowledge, coding, or non-CARTA questions. If the user's request is not about querying the CARTA tables listed in Schema, output the single word: UNSUPPORTED_QUERY

Schema:
${schemaText}`;

      const userPrompt = retryError
        ? `Question: ${question}\nPrevious SQL failed in DuckDB with error: ${retryError}\nFix the DuckDB SQL query using only the exact column names listed in Schema.`
        : question;

      const selectedModel = GROQ_MODELS.includes(groqModelSelect.value)
        ? groqModelSelect.value
        : GROQ_MODELS[0];
      const uniqueCandidates = [...new Set([selectedModel, ...GROQ_MODELS])];

      let lastRes = null;
      let usedModel = uniqueCandidates[0];

      for (const candidate of uniqueCandidates) {
        if (!isCurrent()) return null;
        usedModel = candidate;
        aiStatusText.textContent = "Preparing report...";
        const res = await callGroqChat(apiKey, usedModel, systemPrompt, userPrompt);
        if (!isCurrent()) return null;
        lastRes = res;
        if (res.ok) {
          if (usedModel !== selectedModel) {
            groqModelSelect.value = usedModel;
          }
          const data = await res.json();
          if (!isCurrent()) return null;
          const sql = extractSql(data.choices?.[0]?.message?.content || "");
          return { sql, usedModel };
        }
        if (res.status !== 404 && res.status !== 429 && res.status !== 400) {
          break;
        }
      }

      const errBody = lastRes ? await lastRes.text() : "Unknown error";
      throw new Error(`AI provider error (HTTP ${lastRes?.status}): ${errBody}`);
    }

    askAiBtn.addEventListener("click", async () => {
      const question = aiQuestionInput.value.trim();
      if (!question) return;

      const apiKey = groqApiKeyInput.value.trim();

      askAiBtn.disabled = true;
      const title = `AI Search: "${question}"`;
      const requestId = beginReportRequest(title, "Preparing report...");
      aiStatusText.textContent = "Preparing report...";
      activeAiRequestId = requestId;
      try {
        if (isOffTopicQuestion(question)) {
          aiStatusText.textContent = "Blocked off-topic request (0 API tokens used).";
          throw new Error(
            "Only questions about CARTA datasets (bus routes, stops, vehicle locations, predictions, trip delays, ridership, bike stations, parcels, or addresses) are supported."
          );
        }

        if (!apiKey) {
          aiSettings.open = true;
          groqApiKeyInput.focus();
          throw new Error("Enter an API key in AI settings to create a report.");
        }
        aiSettings.open = groqStorageWarning;

        const generated = await generateSqlWithGroq(apiKey, question, "", requestId);
        if (requestId !== reportRequestId) return;
        let { sql, usedModel } = generated;
        sqlQueryBox.value = sql;
        aiStatusText.textContent = "Loading results...";

        try {
          await executePagedQuery(sql, title, null, requestId);
        } catch (dbErr) {
          if (requestId !== reportRequestId) return;
          if (dbErr.code === "REPORT_LIMIT" || /out of memory|memory limit/i.test(dbErr.message || "")) throw dbErr;
          // 1-step self-correction with DuckDB error feedback
          aiStatusText.textContent = "Adjusting report...";
          const retry = await generateSqlWithGroq(apiKey, question, dbErr.message || String(dbErr), requestId);
          if (requestId !== reportRequestId) return;
          sql = retry.sql;
          usedModel = retry.usedModel;
          sqlQueryBox.value = sql;
          aiStatusText.textContent = "Loading results...";
          await executePagedQuery(sql, title, null, requestId);
        }
        if (requestId === reportRequestId) aiStatusText.textContent = "Report ready.";
      } catch (err) {
        if (requestId !== reportRequestId) return;
        aiStatusText.textContent = "AI report could not be completed.";
        showReportError(title, err);
      } finally {
        if (activeAiRequestId === requestId) {
          activeAiRequestId = null;
          askAiBtn.disabled = false;
          if (!activeQueries.size) stopReportBtn.disabled = true;
          if (requestId === reportRequestId && !activeQueries.size) rowsPerPage.disabled = !conn;
        }
      }
    });

    function showError(msg) {
      errorBanner.textContent = msg;
    }

    function hideError() {
      errorBanner.textContent = "";
    }

    function escapeHtml(str) {
      return String(str ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    initDuckDB();
  
