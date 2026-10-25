
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
    const CSV_CHUNK_BYTES = 256 * 1024;
    const CSV_FALLBACK_MAX_BYTES = 20 * 1024 * 1024;
    const REPORT_LABELS = Object.freeze({
      "Latest Bus Vehicle Positions": "Bus positions",
      "Clever Vehicle Locations": "Clever locations",
      "Stop Predictions (Clever)": "Arrival predictions",
      "Trip Updates & Delays (GTFS-RT)": "Trip updates",
      "CARTA Bus Routes": "Bus routes",
      "CARTA Bus Stops": "Bus stops",
      "CARTA Monthly Ridership (NTD)": "Monthly ridership",
      "Bike Chattanooga Stations": "Bike stations"
    });

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

    // Preset table reports select reporting fields explicitly. Geometry payloads
    // belong in mapping tools and can exceed the browser's per-cell safeguard.
    const PRESET_REPORTS = [
      {
        title: "Latest Bus Vehicle Positions",
        buttonLabel: "View bus positions",
        tag: "Customer Service",
        desc: "Latest reported bus locations.",
        sql: 'SELECT "vehicle_id", "route_id", "trip_id", "trip_start_date", "trip_start_time", "direction_id", "direction", "headsign", "latitude", "longitude", "speed", "bearing", "timestamp", "schedule_relationship" FROM data.gtfsrt_vehicle_positions_v1 ORDER BY NULLIF("timestamp", 0) DESC NULLS LAST;',
        sourceTime: { column: "timestamp", format: "unix-seconds" }
      },
      {
        title: "Clever Vehicle Locations",
        buttonLabel: "View Clever locations",
        tag: "Operations / Paratransit",
        desc: "Vehicle locations from Clever Devices.",
        sql: 'SELECT "vehicle_id", "route", "block_id", "destination", "heading", "latitude", "longitude", "pattern_id", "pattern_distance", "scheduled_start_date", "scheduled_start_time", "speed", "trip_id", "timestamp" FROM data.clever_vehicle_locations_v1 ORDER BY TRY_CAST("timestamp" AS TIMESTAMPTZ) DESC NULLS LAST;',
        sourceTime: { column: "timestamp", format: "iso" }
      },
      {
        title: "Stop Predictions (Clever)",
        buttonLabel: "View arrival predictions",
        tag: "Customer Service",
        desc: "Predicted arrivals at bus stops.",
        sql: `SELECT "tmstmp", "typ", "stpnm", "stpid", "vid", "dstp", "rt", "rtdd", "rtdir", "des", "prdtm", "tablockid", "tatripid", "origtatripno", "dly", "dyn", "prdctdn", "zone", "nbus", "psgld", "stst", "stsd", "flagstop" FROM data.clever_predictions_v1 ORDER BY try_strptime("tmstmp", '%Y%m%d %H:%M') DESC NULLS LAST, try_strptime("prdtm", '%Y%m%d %H:%M') ASC NULLS LAST;`,
        sourceTime: { column: "tmstmp", format: "clever-local" }
      },
      {
        title: "Trip Updates & Delays (GTFS-RT)",
        buttonLabel: "View trip updates",
        tag: "Customer Service",
        desc: "Published trip and stop updates.",
        sql: 'SELECT "service_id", "route_id", "trip_id", "direction_id", "stop_headsign", "trip_start_time", "stop_id", "stop_code", "stop_name", "stop_sequence", "stop_sequence_actual", "schedule_relationship", "vehicle_id", "scheduled_arrival_time", "scheduled_departure_time", "predicted_arrival_time", "predicted_departure_time", "latitude", "longitude" FROM data.gtfsrt_trip_updates_v1;',
        sourceTime: { unavailable: "Source observation time unavailable: this dataset has no observation timestamp. Predicted arrival and departure times do not establish freshness." }
      },
      {
        title: "CARTA Bus Routes",
        buttonLabel: "View bus routes",
        tag: "Reference",
        desc: "Route numbers and names.",
        sql: 'SELECT "id", "name", "color" FROM data.simple_bus_routes ORDER BY "id";',
      },
      {
        title: "CARTA Bus Stops",
        buttonLabel: "View bus stops",
        tag: "Customer Service",
        desc: "Stop names, locations, and routes.",
        sql: 'SELECT "id", "name", "latitude", "longitude", "route_ids" FROM data.simple_bus_stops ORDER BY "id";',
      },
      {
        title: "CARTA Monthly Ridership (NTD)",
        buttonLabel: "View monthly ridership",
        tag: "Management",
        desc: "Monthly ridership and service measures.",
        sql: `SELECT "NTD ID", "Legacy NTD ID", "Agency", "Mode/Type of Service Status", "Reporter Type", "UACE CD", "UZA Name", "Mode", "TOS", "3 Mode", "Date", "UPT", "VOMS", "VRH", "VRM", "Agency Mode TOS Date", "State", "FTA Region" FROM data.ntd_monthly_ridership_v1 WHERE "NTD ID" = '${CARTA_NTD_ID}' ORDER BY "Date" DESC;`,
      },
      {
        title: "Bike Chattanooga Stations",
        buttonLabel: "View bike stations",
        tag: "Mobility",
        desc: "Station locations and bike availability.",
        sql: 'SELECT "station_id", "external_id", "name", "physical_configuration", "latitude", "longitude", "altitude", "address", "post_code", "capacity", "charging_station", "key", "transitcard", "creditcard", "phone", "virtual_station", "groups", "last_updated", "bikes_available", "bikes_disabled", "status", "docks_available", "docks_disabled", "last_reported", "installed", "renting", "returning", "FIT", "BOOST", "ICONIC", "EFIT", "CHLOE", "cross_street" FROM data.bike_chattanooga_stations_v1 ORDER BY "station_id";',
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
    let activeCsvExport = null;
    let staffSession = null;
    let aiAuthorized = false;
    let activeAiController = null;

    // DOM elements
    const dbStatusDot = document.getElementById("dbStatusDot");
    const dbStatusText = document.getElementById("dbStatusText");
    const presetGrid = document.getElementById("presetGrid");
    const builderDataset = document.getElementById("builderDataset");
    const builderColumn = document.getElementById("builderColumn");
    const builderOperator = document.getElementById("builderOperator");
    const builderValue = document.getElementById("builderValue");
    const builderHelp = document.getElementById("builderHelp");
    const builderError = document.getElementById("builderError");
    const builderSortCol = document.getElementById("builderSortCol");
    const builderSortDir = document.getElementById("builderSortDir");
    const runBuilderBtn = document.getElementById("runBuilderBtn");
    const sqlQueryBox = document.getElementById("sqlQueryBox");
    const runCustomSqlBtn = document.getElementById("runCustomSqlBtn");
    const resultsMeta = document.getElementById("resultsMeta");
    const resultsTitle = document.getElementById("resultsTitle");
    const resultsSummary = document.getElementById("resultsSummary");
    const resultsFreshnessSummary = document.getElementById("resultsFreshnessSummary");
    const resultsFreshness = document.getElementById("resultsFreshness");
    const resultsScope = document.getElementById("resultsScope");
    const errorBanner = document.getElementById("errorBanner");
    const tableContainer = document.getElementById("tableContainer");
    const exportCsvBtn = document.getElementById("exportCsvBtn");
    const csvExportStatus = document.getElementById("csvExportStatus");
    const quickSearchInput = document.getElementById("quickSearchInput");
    const stopReportBtn = document.getElementById("stopReportBtn");
    const reconnectBtn = document.getElementById("reconnectBtn");
    const rowsPerPage = document.getElementById("rowsPerPage");
    const previousPageBtn = document.getElementById("previousPageBtn");
    const nextPageBtn = document.getElementById("nextPageBtn");
    const pageStatus = document.getElementById("pageStatus");
    const reportPagination = document.getElementById("reportPagination");

    // Plain-English Search DOM elements
    const groqModelSelect = document.getElementById("groqModelSelect");
    const aiSettings = document.getElementById("aiSettings");
    const aiStatusText = document.getElementById("aiStatusText");
    const aiQuestionInput = document.getElementById("aiQuestionInput");
    const askAiBtn = document.getElementById("askAiBtn");

    const staffSignInBtn = document.getElementById("staffSignInBtn");
    const staffSignOutBtn = document.getElementById("staffSignOutBtn");
    const staffName = document.getElementById("staffName");
    const staffAuthStatus = document.getElementById("staffAuthStatus");
    const legacyKeyStatus = document.getElementById("legacyKeyStatus");

    // Remove only this application's old saved key, without reading or restoring it.
    const GROQ_STORAGE_KEY = "carta_groq_api_key";
    try { localStorage.removeItem(GROQ_STORAGE_KEY); }
    catch { legacyKeyStatus.textContent = "A previously saved personal key could not be cleared. Clear this site's browser data to remove it. Public reporting remains available."; }

    function cancelStaffAi(message) {
      const canceledId = activeAiRequestId ?? (currentRequestTitle.startsWith("AI Search:") ? reportRequestId : null);
      activeAiController?.abort();
      activeAiController = null;
      if (canceledId !== null && canceledId === reportRequestId) {
        beginReportRequest("AI request canceled", message);
        resultsMeta.textContent = message;
        resultsSummary.textContent = "AI request canceled.";
        resultsFreshness.textContent = "No report loaded.";
        for (const operation of activeQueries) {
          if (operation.requestId !== canceledId) continue;
          clearTimeout(operation.timer);
          operation.reject(reportLimitError(message));
          operation.cancel?.().catch(() => {});
        }
      }
      activeAiRequestId = null;
      askAiBtn.disabled = !conn || !aiAuthorized;
      if (!activeQueries.size) stopReportBtn.disabled = true;
    }

    function applyStaffState(state) {
      aiAuthorized = state.authorized === true;
      if (!aiAuthorized) cancelStaffAi("AI request canceled because access changed.");
      const aiTab = document.getElementById("tab-ai");
      if (!aiAuthorized && aiTab.getAttribute("aria-selected") === "true") {
        activateReportTab(reportTabs[0]);
        if (document.getElementById("panel-ai").contains(document.activeElement)) reportTabs[0].focus();
      }
      aiTab.hidden = !aiAuthorized;
      if (!aiAuthorized) document.getElementById("panel-ai").hidden = true;
      if (!state.signedIn) {
        aiQuestionInput.value = "";
        aiStatusText.textContent = "";
      }
      staffName.hidden = !state.signedIn;
      staffName.textContent = state.signedIn ? state.name : "";
      staffSignInBtn.hidden = state.signedIn;
      staffSignInBtn.disabled = state.busy;
      staffSignOutBtn.hidden = !state.signedIn;
      staffSignOutBtn.disabled = state.busy;
      staffAuthStatus.textContent = state.message;
      askAiBtn.disabled = !conn || !aiAuthorized || activeAiRequestId !== null;
    }

    async function initializeStaffSignIn() {
      try {
        const response = await fetch("./assets/staff-config.json", { cache: "no-store" });
        if (!response.ok) throw new Error("Missing sign-in configuration.");
        const config = await response.json();
        const { createStaffSession } = await import("./staff-auth.mjs");
        staffSession = await createStaffSession({ config, onState: applyStaffState });
      } catch {
        staffSignInBtn.disabled = true;
        staffAuthStatus.textContent = "Microsoft sign-in is temporarily unavailable. Public reporting remains available.";
      }
    }
    staffSignInBtn.addEventListener("click", () => staffSession?.signIn());
    staffSignOutBtn.addEventListener("click", () => staffSession?.signOut());

    // Setup Tabs
    const reportTabs = Array.from(document.querySelectorAll('[role="tab"]'));

    function activateReportTab(tab) {
      if (tab.hidden) return;
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

    reportTabs.forEach((btn) => {
      btn.addEventListener("click", () => activateReportTab(btn));
      btn.addEventListener("focus", () => activateReportTab(btn));
      btn.addEventListener("keydown", (event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const visibleTabs = reportTabs.filter(tab => !tab.hidden);
        const index = visibleTabs.indexOf(btn);
        let next;
        if (event.key === "ArrowRight") next = (index + 1) % visibleTabs.length;
        else if (event.key === "ArrowLeft") next = (index + visibleTabs.length - 1) % visibleTabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = visibleTabs.length - 1;
        else return;
        event.preventDefault();
        visibleTabs[next].focus();
      });
    });

    // Render one-click report buttons
    function renderPresets() {
      presetGrid.innerHTML = "";
      PRESET_REPORTS.forEach((report) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "preset-card";
        btn.innerHTML = `
          <span class="preset-card-copy">
            <span class="preset-card-title">${escapeHtml(report.buttonLabel)}</span>
            <span class="preset-card-desc">${escapeHtml(report.desc)}</span>
          </span>
          <svg class="preset-card-arrow" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false">
            <path d="M4 12h15m-6-6 6 6-6 6" />
          </svg>
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

        await populateDatasetDropdown();
        dbStatusDot.classList.add("ready");
        dbStatusText.textContent = `Connected (${availableViews.length} CARTA datasets ready)`;
        runCustomSqlBtn.disabled = false;
        askAiBtn.disabled = !aiAuthorized;
        rowsPerPage.disabled = false;
      } catch (err) {
        dbStatusDot.classList.add("error");
        dbStatusText.textContent = "Connection error";
        showError(`Failed to initialize DuckDB: ${err.message || err}`);
      }
    }

    async function populateDatasetDropdown() {
      builderDataset.innerHTML = "";
      availableViews.forEach((viewName) => {
        const info = DATASET_INFO[viewName];
        const opt = document.createElement("option");
        opt.value = viewName;
        opt.textContent = info ? `${info.label} (${viewName})` : viewName;
        builderDataset.appendChild(opt);
      });
      if (availableViews.length > 0) {
        await loadColumnsForDataset(availableViews[0]);
      }
    }

    async function getColumnsForView(viewName) {
      if (schemaCache[viewName]) {
        return schemaCache[viewName];
      }
      const res = await conn.query(`DESCRIBE SELECT * FROM data."${viewName.replace(/"/g, '""')}";`);
      const cols = res.toArray().map((row) => ({
        name: row.column_name,
        type: row.column_type
      }));
      schemaCache[viewName] = cols;
      return cols;
    }

    // The schema decides which comparisons are meaningful, never the field name or input text.
    const BUILDER_CONDITIONS = {
      ILIKE_CONTAINS: "Contains", "=": "Equals (=)", ILIKE_STARTS: "Starts with",
      ">": "Greater than (>)", "<": "Less than (<)", ">=": "Greater or equal (>=)", "<=": "Less or equal (<=)",
      EMPTY_TEXT: "Is blank text", "IS NULL": "Is missing (null)", "IS NOT NULL": "Is not missing (null)"
    };
    const BUILDER_NO_VALUE = new Set(["IS NULL", "IS NOT NULL", "EMPTY_TEXT"]);
    let builderLoadId = 0;
    let builderEditId = 0;
    let builderReadyView = null;

    function builderFieldRules(column) {
      const type = String(column?.type || "").toUpperCase().trim();
      let kind = "other";
      if (/^(VARCHAR|CHAR|BPCHAR|TEXT|STRING)(\(\d+\))?$/.test(type)) kind = "text";
      else if (/^(U?(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|INT[1248]?|UINT(8|16|32|64|128)|FLOAT|REAL|DOUBLE|DOUBLE PRECISION|DECIMAL\(\d+,\s*\d+\)|NUMERIC\(\d+,\s*\d+\))$/.test(type)) kind = "number";
      else if (/^(BOOLEAN|BOOL)$/.test(type)) kind = "boolean";
      else if (/^(DATE|TIME|TIMETZ|TIME WITH TIME ZONE|TIMESTAMP|TIMESTAMPTZ|TIMESTAMP_(S|MS|NS)|TIMESTAMP WITH TIME ZONE)$/.test(type)) kind = "date";
      const conditions = kind === "text" ? ["ILIKE_CONTAINS", "=", "ILIKE_STARTS", "EMPTY_TEXT"]
        : ["number", "date"].includes(kind) ? ["=", ">", "<", ">=", "<="]
        : kind === "boolean" ? ["="] : [];
      return { kind, type, conditions: [...conditions, "IS NULL", "IS NOT NULL"] };
    }

    function updateBuilderValueState() {
      builderValue.disabled = builderOperator.disabled || BUILDER_NO_VALUE.has(builderOperator.value);
    }

    function updateBuilderConditions() {
      const column = schemaCache[builderReadyView]?.find(c => c.name === builderColumn.value);
      const previous = builderOperator.value;
      builderOperator.innerHTML = "";
      builderOperator.disabled = !column;
      if (column) {
        const rules = builderFieldRules(column);
        for (const condition of rules.conditions) {
          const option = document.createElement("option");
          option.value = condition;
          option.textContent = BUILDER_CONDITIONS[condition];
          builderOperator.appendChild(option);
        }
        if (rules.conditions.includes(previous)) builderOperator.value = previous;
        builderHelp.textContent = rules.kind === "text"
          ? `${column.name} contains text. Use text matching; number comparisons are unavailable. Blank text and missing values have separate conditions.`
          : rules.kind === "number" ? "Enter a number, without commas or units."
          : rules.kind === "boolean" ? "Enter true or false."
          : rules.kind === "date" ? "Enter a date (YYYY-MM-DD), time (HH:MM:SS), or date and time to match this field."
          : "This field supports missing-value checks. Use the SQL editor for other comparisons.";
      } else {
        builderHelp.textContent = "Choose a filter column to see its conditions, or run the dataset without a filter.";
      }
      updateBuilderValueState();
    }

    async function loadColumnsForDataset(viewName) {
      const loadId = ++builderLoadId;
      ++builderEditId;
      builderReadyView = null;
      builderError.textContent = "";
      builderValue.value = "";
      runBuilderBtn.disabled = true;
      builderColumn.disabled = true;
      builderSortCol.disabled = true;
      builderColumn.innerHTML = `<option value="">Loading columns...</option>`;
      builderSortCol.innerHTML = `<option value="">Loading columns...</option>`;
      updateBuilderConditions();
      try {
        const cols = await getColumnsForView(viewName);
        if (loadId !== builderLoadId || viewName !== builderDataset.value) return;
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
        builderReadyView = viewName;
        builderColumn.disabled = false;
        builderSortCol.disabled = false;
        runBuilderBtn.disabled = !conn;
      } catch (err) {
        if (loadId !== builderLoadId || viewName !== builderDataset.value) return;
        builderColumn.innerHTML = `<option value="">(Could not load columns)</option>`;
        builderSortCol.innerHTML = `<option value="">(Default order)</option>`;
        builderError.textContent = "Could not load this dataset's fields. Select the dataset again to retry.";
      }
      updateBuilderConditions();
    }

    builderDataset.addEventListener("change", () => {
      loadColumnsForDataset(builderDataset.value);
    });

    builderColumn.addEventListener("change", () => {
      ++builderEditId;
      builderValue.value = "";
      builderError.textContent = "";
      updateBuilderConditions();
    });
    for (const [control, event] of [[builderOperator, "change"], [builderValue, "input"], [builderSortCol, "change"], [builderSortDir, "change"]]) {
      control.addEventListener(event, () => {
        ++builderEditId;
        builderError.textContent = "";
        updateBuilderValueState();
      });
    }

    function builderValidationError(message, control) {
      return Object.assign(new Error(message), { control });
    }

    async function builderValueSql(column, operator, rawValue) {
      const rules = builderFieldRules(column);
      if (!rules.conditions.includes(operator)) {
        throw builderValidationError(`Choose a condition offered for ${column.name}. ${rules.kind === "text" ? "This field contains text, so number comparisons are unavailable." : ""}`, builderOperator);
      }
      if (BUILDER_NO_VALUE.has(operator)) return null;
      // Keep text exactly as entered, including leading zeros and spaces.
      const value = rules.kind === "text" ? rawValue : rawValue.trim();
      if (!value.trim()) throw builderValidationError("Enter a filter value, or choose a blank-text or missing-value condition when available.", builderValue);
      if (rules.kind === "number" && (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value)))) {
        throw builderValidationError("Enter a valid number, without commas or units.", builderValue);
      }
      if (rules.kind === "boolean" && !/^(true|false)$/i.test(value)) {
        throw builderValidationError("Enter true or false for this field.", builderValue);
      }
      const literal = `'${value.replace(/'/g, "''")}'`;
      if (rules.kind === "text") return literal;
      // Check only the constant, without reading dataset records. Types above are allowlisted.
      // Comparing numeric literals directly avoids rounding a decimal threshold to an integer.
      const expression = rules.kind === "number" ? value : `CAST(${literal} AS ${rules.type})`;
      if (rules.kind !== "number") {
        let checked;
        try { checked = await conn.query(`SELECT TRY_CAST(${literal} AS ${rules.type}) IS NOT NULL AS valid;`); }
        catch { throw builderValidationError("Could not check this value. Try again, or reconnect to the data.", builderValue); }
        if (!checked.get(0).valid) throw builderValidationError(`Enter a valid ${rules.kind === "boolean" ? "true or false value" : "date or time for this field"}.`, builderValue);
      }
      return expression;
    }

    // Build and execute query from Visual Filter Builder
    runBuilderBtn.addEventListener("click", async () => {
      const editId = ++builderEditId;
      builderError.textContent = "";
      const view = builderDataset.value;
      const col = builderColumn.value;
      const op = builderOperator.value;
      const val = builderValue.value;
      const sortCol = builderSortCol.value;
      const sortDir = builderSortDir.value;

      try {
        if (!conn || view !== builderReadyView || !availableViews.includes(view)) {
          throw builderValidationError("Wait for the dataset's fields to load before running a report.", builderDataset);
        }
        const columns = schemaCache[view];
        if (sortCol && !columns.some(c => c.name === sortCol)) throw builderValidationError("Choose a sort column from this dataset.", builderSortCol);
        if (!["ASC", "DESC"].includes(sortDir)) throw builderValidationError("Choose an available sort direction.", builderSortDir);
        let sql = `SELECT * FROM data."${view.replace(/"/g, '""')}"`;
        if (col) {
          const column = columns.find(c => c.name === col);
          if (!column) throw builderValidationError("Choose a filter column from this dataset.", builderColumn);
          const rhs = await builderValueSql(column, op, val);
          const safeCol = `"${col.replace(/"/g, '""')}"`;
          if (["IS NULL", "IS NOT NULL"].includes(op)) sql += ` WHERE ${safeCol} ${op}`;
          else if (op === "EMPTY_TEXT") sql += ` WHERE ${safeCol} = ''`;
          else if (op === "ILIKE_CONTAINS" || op === "ILIKE_STARTS") {
            const pattern = val.replace(/[$%_]/g, "$$$&").replace(/'/g, "''");
            sql += ` WHERE ${safeCol} ILIKE '${op === "ILIKE_CONTAINS" ? "%" : ""}${pattern}%' ESCAPE '$'`;
          } else sql += ` WHERE ${safeCol} ${op} ${rhs}`;
        }
        if (sortCol) {
          const safeSort = `"${sortCol.replace(/"/g, '""')}"`;
          sql += ` ORDER BY ${safeSort} ${sortDir}`;
        }
        sql += ";";

        if (editId !== builderEditId || !conn) return;
        const label = DATASET_INFO[view]?.label || view;
        executePagedQuery(sql, label).catch(() => {});
      } catch (err) {
        if (editId !== builderEditId) return;
        builderError.textContent = err.message;
        err.control?.focus();
      }
    });

    runCustomSqlBtn.addEventListener("click", () => {
      const sql = sqlQueryBox.value.trim();
      if (sql) {
        executePagedQuery(sql, "Custom SQL Query").catch(() => {});
      }
    });

    // Execute a SQL query and render table
    function reportDisplayTitle(title) {
      return title.startsWith('AI Search: "') ? "AI report" : REPORT_LABELS[title] || title;
    }

    function setReportHeading(title, summary) {
      resultsTitle.textContent = reportDisplayTitle(title);
      resultsSummary.textContent = summary;
    }

    function reportLimitError(message) {
      const error = new Error(message);
      error.code = "REPORT_LIMIT";
      return error;
    }

    function stopReports(message = "Report stopped. Reconnect to run another report.") {
      cancelFullCsvExport("Export stopped. Reconnect before trying again.", true);
      ++reportRequestId;
      activeAiController?.abort();
      activeAiController = null;
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

    async function runBoundedReport(sql, requestId, page = null, consume = null) {
      const bindings = db;
      let reject;
      const stopped = new Promise((resolve, no) => { reject = no; });
      const operation = { reject, timer: null, requestId, cancel: null };
      activeQueries.add(operation);
      operation.timer = setTimeout(() => stopReports("Report stopped after 30 seconds. Reconnect, then narrow the query."), REPORT_TIMEOUT_MS);
      const work = (async () => {
        let queryConnection = null;
        let reader = null;
        let complete = false;
        try {
          queryConnection = await bindings.connect();
          operation.cancel = () => queryConnection.cancelSent();
          if (requestId !== reportRequestId) return null;
          const parsed = await validateCartaSql(sql, queryConnection);
          if (requestId !== reportRequestId) return null;
          let executionSql = sql;
          if (page || consume) {
            if (page && (!Number.isSafeInteger(page.offset) || page.offset < 0 || !Number.isSafeInteger(page.size) || page.size < 1 || page.size > 1000 || !Number.isSafeInteger(page.offset + page.size + 1))) throw reportLimitError("Invalid report page.");
            const normalized = await normalizeReportSql(parsed, queryConnection, sql);
            if (requestId !== reportRequestId) return null;
            executionSql = `SELECT * FROM (${normalized.sql}) AS "carta_page"${normalized.ordered ? "" : " ORDER BY ALL"}${page ? ` LIMIT ${page.size + 1} OFFSET ${page.offset}` : ""}`;
          }
          reader = await queryConnection.send(executionSql, true);
          const result = await (consume ? consume(reader) : collectReportRows(reader, requestId, page));
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
      setReportHeading("No report selected", "");
      resultsFreshnessSummary.textContent = "";
      reportPagination.hidden = true;
      quickSearchInput.disabled = true;
      exportCsvBtn.disabled = true;
      previousPageBtn.disabled = true;
      nextPageBtn.disabled = true;
      rowsPerPage.disabled = true;
      pageStatus.textContent = "No page loaded";
    }

    function beginReportRequest(title, message = "Loading data from CARTA S3...") {
      if (activeCsvExport) cancelFullCsvExport("Export canceled because another report or page was requested.");
      else setCsvExportStatus("");
      activeAiController?.abort();
      activeAiController = null;
      activeAiRequestId = null;
      askAiBtn.disabled = !conn || !aiAuthorized;
      const requestId = ++reportRequestId;
      currentRequestTitle = title;
      stopReportBtn.disabled = false;
      clearResults();
      hideError();
      sqlQueryBox.value = "";
      aiStatusText.textContent = "";
      resultsMeta.textContent = `Running: ${title}...`;
      setReportHeading(title, "Loading report...");
      resultsFreshness.textContent = "Waiting for query results...";
      resultsScope.textContent = "";
      tableContainer.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
      return requestId;
    }

    function showReportError(title, err) {
      clearResults();
      resultsMeta.textContent = `${title}: Error`;
      setReportHeading(title, "Report could not be completed.");
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
        const target = reportPagination.hidden ? exportCsvBtn : control.disabled ? (other.disabled ? rowsPerPage : other) : control;
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
      if (pageRequestId === reportRequestId && restoreFocus && !rowsPerPage.disabled && (document.activeElement === document.body || document.activeElement === rowsPerPage)) {
        (reportPagination.hidden ? exportCsvBtn : rowsPerPage).focus();
      }
    });

    async function executeQuery(sql, title = "Query Results", sourceTime = null, rowLimit = null, requestId = null, page = null) {
      if (!conn) return;
      if (requestId === null) requestId = beginReportRequest(title);
      if (requestId !== reportRequestId) return;
      clearResults();
      hideError();
      sqlQueryBox.value = sql;
      resultsMeta.textContent = `Running: ${title}...`;
      setReportHeading(title, "Loading report...");
      resultsFreshness.textContent = "Checking source timestamps...";
      resultsScope.textContent = "";
      tableContainer.innerHTML = `<div class="empty-state">Loading data from CARTA S3...</div>`;

      const t0 = performance.now();
      try {
        const result = await runBoundedReport(sql, requestId, page);
        if (requestId !== reportRequestId || !result) return;
        const elapsedMs = Math.round(performance.now() - t0);

        currentColumns = result.columns;
        currentRows = result.rows;
        currentReport = { title, querySql: sql, sourceTime, elapsedMs, truncated: result.truncated, ...(page ? {
          page: { ...page, hasMore: result.hasMore }
        } : {}) };
        resultsScope.textContent = page
          ? `${result.truncated ? `Partial page: loaded ${result.rows.length} rows (${result.reason}); use Next to continue. ` : ""}Download report (CSV) includes all rows matched by the report SQL, including any SQL limits. Search checks this page only and does not change the download. Source changes or tied sort values may shift rows between reads.`
          : describeResultScope(rowLimit, result);
        resultsFreshness.textContent = `${describeSourceFreshness(currentRows, sourceTime)} Report retrieved: ${reportTimeFormatter.format(new Date())} (${REPORT_TIME_ZONE}).`;
        resultsFreshnessSummary.textContent = describeSourceFreshness(currentRows, sourceTime, true);
        exportCsvBtn.disabled = activeCsvExport !== null;
        quickSearchInput.disabled = currentRows.length === 0;
        if (page) {
          reportPagination.hidden = !page.previous.length && !result.hasMore;
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
      return `${safety} ${scope} Search applies to loaded rows only. Download report (CSV) reruns the report SQL for all matching rows, including SQL limits, without the page search.`;
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

    function describeSourceFreshness(rows, sourceTime, concise = false) {
      if (!rows.length) return concise ? "No results returned." : "No records returned; source observation time unavailable.";
      if (sourceTime?.unavailable) return concise ? "Source update time unavailable." : sourceTime.unavailable;
      if (!sourceTime) return concise ? "Source update time unavailable." : "Source observation time not identified for this report.";
      let newest = null;
      let missing = 0;
      for (const row of rows) {
        const timestamp = parseSourceTime(row[sourceTime.column], sourceTime.format);
        if (!timestamp) missing++;
        else if (!newest || timestamp.order > newest.order) newest = timestamp;
      }
      if (!newest) return concise ? "Source update time unavailable." : "Source observation time unavailable: timestamps are missing or invalid.";
      if (concise) return `Newest source time shown: ${newest.label.replace(` (${REPORT_TIME_ZONE})`, "")}.`;
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
        const paged = currentReport.page && (currentReport.page.hasMore || currentReport.page.previous.length);
        const count = term
          ? `${filtered.length.toLocaleString()} of ${currentRows.length.toLocaleString()} rows shown${paged ? " on this page" : ""}`
          : paged ? `${currentRows.length.toLocaleString()} rows on this page`
          : `${currentRows.length.toLocaleString()} ${currentRows.length === 1 ? "result" : "results"}`;
        setReportHeading(currentReport.title, `${count}${currentReport.truncated ? " · Partial result" : ""}`);
      }
      renderTable(filtered);
    }

    quickSearchInput.addEventListener("input", applyQuickFilter);

    function setCsvExportStatus(message, error = false) {
      csvExportStatus.textContent = message;
      csvExportStatus.className = error ? "panel-subtitle csv-export-error" : "panel-subtitle";
    }

    function abortCsvWriter(operation) {
      if (!operation.writer || operation.aborting) return;
      // Stop must remain responsive even if the filesystem is stalled.
      operation.aborting = true;
      Promise.resolve().then(() => operation.writer.abort()).catch(() => {
        if (activeCsvExport === operation) setCsvExportStatus("Export did not complete. Check the destination file before using it; the browser could not confirm cancellation.", true);
      });
    }

    function cancelFullCsvExport(message, stopped = false) {
      const operation = activeCsvExport;
      if (!operation) return;
      if (operation.committing) {
        setCsvExportStatus("The complete CSV was being finalized. Check the destination; saving could not be confirmed.", true);
        if (stopped) abortCsvWriter(operation);
        return;
      }
      operation.canceled = true;
      setCsvExportStatus(`${message} No completed CSV was saved; a new empty file may remain.`, true);
      abortCsvWriter(operation);
    }

    exportCsvBtn.addEventListener("click", async () => {
      if (!conn || !currentReport || exportCsvBtn.disabled || activeCsvExport) return;
      const report = currentReport;
      const requestId = reportRequestId;
      const restoreFocus = document.activeElement === exportCsvBtn;
      const filename = `carta_report_${new Date().toISOString().slice(0, 10)}_full.csv`;
      const operation = { canceled: false, committing: false, writer: null, timer: null, reject: null };
      const stopped = new Promise((resolve, reject) => { operation.reject = reject; });
      activeCsvExport = operation;
      activeQueries.add(operation);
      exportCsvBtn.disabled = true;
      stopReportBtn.disabled = false;
      setCsvExportStatus("Choose where to save the CSV.");
      const checkActive = () => {
        if (operation.canceled || requestId !== reportRequestId || !conn) {
          const error = new Error("Export canceled.");
          error.code = "CSV_CANCELED";
          throw error;
        }
      };
      const work = (async () => {
        let saved = false;
        try {
          // Invoke the picker before any await to retain the click's user activation.
          const handle = typeof globalThis.showSaveFilePicker === "function"
            ? await globalThis.showSaveFilePicker({ suggestedName: filename, types: [{ description: "CSV report", accept: { "text/csv": [".csv"] } }] })
            : null;
          checkActive();
          operation.timer = setTimeout(() => stopReports("CSV export stopped after 30 seconds. Reconnect, then narrow the report."), REPORT_TIMEOUT_MS);
          if (handle) {
            operation.writer = await handle.createWritable();
            checkActive();
          }
          const chunks = [];
          let bytes = 0;
          const write = async (chunk) => {
            checkActive();
            if (operation.writer) await operation.writer.write(chunk);
            else {
              if (bytes + chunk.byteLength > CSV_FALLBACK_MAX_BYTES) throw reportLimitError("This browser's full CSV download exceeds 20 MiB. Use Chrome or Edge with file saving enabled, or narrow the report. No download was created.");
              chunks.push(chunk);
            }
            bytes += chunk.byteLength;
            checkActive();
          };
          setCsvExportStatus("Preparing CSV...");
          const result = await runBoundedReport(report.querySql, requestId, null, reader => streamFullCsv(reader, write, checkActive));
          checkActive();
          if (!result) throw new Error("Export did not complete.");
          // Publish only after end-of-stream AND successful database cleanup.
          operation.committing = true;
          setCsvExportStatus("Finishing CSV...");
          if (operation.writer) await operation.writer.close();
          else {
            const blob = new Blob(chunks, { type: "text/csv;charset=utf-8;" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = filename;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }
          saved = true;
          if (requestId === reportRequestId) setCsvExportStatus(`${handle ? "CSV saved" : "CSV download ready"}: ${result.count.toLocaleString()} rows.`);
        } finally {
          // Never close a failed/aborted stream and publish a partial CSV.
          if (!saved) abortCsvWriter(operation);
        }
      })();
      try {
        await Promise.race([work, stopped]);
      } catch (error) {
        if (!operation.canceled && requestId === reportRequestId) {
          setCsvExportStatus(error.name === "AbortError"
            ? "Export canceled. No completed CSV was saved; a new empty file may remain."
            : `Export failed. Check the destination before using it; no successful save was confirmed. ${error.message || error}`, true);
        }
      } finally {
        clearTimeout(operation.timer);
        activeQueries.delete(operation);
        if (activeCsvExport === operation) activeCsvExport = null;
        exportCsvBtn.disabled = !conn || !currentReport;
        if (restoreFocus && requestId === reportRequestId && !exportCsvBtn.disabled &&
            (document.activeElement === document.body || document.activeElement === exportCsvBtn)) exportCsvBtn.focus();
        if (!activeQueries.size && activeAiRequestId === null) stopReportBtn.disabled = true;
      }
    });

    async function streamFullCsv(reader, write, checkActive) {
      await reader.open();
      checkActive();
      const columns = reader.schema.fields.map(field => field.name);
      if (!columns.length || columns.length > MAX_RESULT_COLUMNS) throw reportLimitError("This report has too many columns or no columns. Select up to 100 columns and try again.");
      const encoder = new TextEncoder();
      let parts = ["\uFEFF"], chunkBytes = 3, count = 0;
      const flush = async () => {
        if (!parts.length) return;
        await write(encoder.encode(parts.join("")));
        parts = [];
        chunkBytes = 0;
        setCsvExportStatus(`Preparing CSV: ${count.toLocaleString()} rows.`);
        await new Promise(resolve => setTimeout(resolve, 0));
        checkActive();
      };
      const append = async (values, header = false) => {
        const cells = [];
        for (const value of values) {
          if ((typeof value === "string" && value.length > MAX_CELL_CHARACTERS) ||
              (value && typeof value === "object" && (value.byteLength > MAX_CELL_CHARACTERS || value.length > MAX_CELL_CHARACTERS))) throw reportLimitError("A CSV cell is too large. Select fewer fields or narrow the report.");
          const text = formatCellValue(value);
          if (text.length > MAX_CELL_CHARACTERS) throw reportLimitError("A CSV cell is too large. Select fewer fields or narrow the report.");
          cells.push(csvEscape(text, header));
        }
        const line = cells.join(",") + "\r\n";
        const size = encoder.encode(line).byteLength;
        if (size > MAX_RESULT_BYTES) throw reportLimitError("A CSV row is too large. Select fewer fields or narrow the report.");
        if (chunkBytes + size > CSV_CHUNK_BYTES) await flush();
        parts.push(line);
        chunkBytes += size;
      };
      await append(columns, true);
      for await (const batch of reader) {
        checkActive();
        for (let index = 0; index < batch.numRows; index++) {
          const row = batch.get(index);
          await append(columns.map(column => row[column]));
          count++;
          if (chunkBytes >= CSV_CHUNK_BYTES) await flush();
        }
        // Bound chunk metadata as well as bytes when the source emits tiny batches.
        await new Promise(resolve => setTimeout(resolve, 0));
        checkActive();
      }
      await flush();
      return { count, truncated: false };
    }

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

    function findStandardReport(question) {
      // Only exact, unqualified browsing requests use presets. Filters, totals,
      // calculations and other additional words must keep their original meaning.
      const normalize = value => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const requested = normalize(question)
        .replace(/^please /, "")
        .replace(/^(?:show|list|browse|display)(?: me)? (?:all )?(?:the )?/, "")
        .replace(/ please$/, "");
      const aliases = {
        gtfsrt_vehicle_positions_v1: ["bus vehicle positions", "vehicle positions"],
        clever_vehicle_locations_v1: ["clever locations"],
        clever_predictions_v1: ["stop predictions", "clever stop predictions"],
        gtfsrt_trip_updates_v1: ["trip updates", "carta trip updates", "trip updates and delays", "carta trip updates and delays"],
        simple_bus_routes: ["bus routes", "carta routes", "routes"],
        simple_bus_stops: ["bus stops", "carta stops", "stops"],
        ntd_monthly_ridership_v1: ["carta monthly ridership", "ntd monthly ridership"],
        bike_chattanooga_stations_v1: ["bike stations", "bike chattanooga stations"]
      };
      return PRESET_REPORTS.find(report => {
        const view = report.sql.match(/FROM data\.(\w+)/i)[1];
        return availableViews.includes(view) && [report.title, `CARTA ${report.title}`, view, ...(aliases[view] || [])]
          .some(name => normalize(name) === requested);
      }) || null;
    }

    const sampleCache = {}; // viewName -> bounded samples, prioritizing temporal fields
    // Materialize parsed epochs before arithmetic: the pinned Wasm engine can
    // fail on the combined inline expression when input columns contain NULLs.
    const TRIP_ELAPSED_SQL = `WITH parsed AS MATERIALIZED (
  SELECT "trip_id",
    epoch(TRY_CAST("predicted_arrival_time" AS TIMESTAMPTZ)) AS start_seconds,
    epoch(TRY_CAST("predicted_departure_time" AS TIMESTAMPTZ)) AS end_seconds
  FROM data.gtfsrt_trip_updates_v1
)
SELECT "trip_id", (end_seconds - start_seconds) / 60.0 AS elapsed_minutes
FROM parsed ORDER BY "trip_id";`;
    const DATASET_TIME_GUIDANCE = {
      gtfsrt_trip_updates_v1: `scheduled_arrival_time, scheduled_departure_time and trip_start_time are GTFS service-day clock strings, e.g. 19:35:57, potentially with hours >= 24. predicted_arrival_time and predicted_departure_time are full ISO timestamps with offsets, e.g. 2026-08-18T19:51:00-04:00; parse with TRY_CAST(column AS TIMESTAMPTZ), without adding a date. There is no confirmed service date or observation timestamp in this table. service_id is a schedule identifier, not a date. Do not infer the service date from a prediction date, today's date, or 1970-01-01. A reliable scheduled-versus-predicted delay needs a confirmed service date and agency timezone; if asked to calculate that delay from this table alone, output MISSING_TIME_CONTEXT. For a request to show trip updates/delays, return the published fields without calculating a delay.`,
      scheduled_stop_times_v1: "stop_arrival_time, stop_departure_time, trip_start_time and trip_end_time are GTFS service-day clock strings. Hours can exceed 23; do not CAST them AS TIME or parse as calendar timestamps. service_id is not a service date. A calendar comparison requires a confirmed service date and agency timezone, including GTFS daylight-saving rules.",
      gtfsrt_vehicle_positions_v1: "timestamp is Unix epoch seconds; zero means unknown. Use to_timestamp(NULLIF(timestamp, 0)) for an instant. trip_start_date is a service date, not an observation timestamp.",
      clever_vehicle_locations_v1: "timestamp is an ISO timestamp; preserve any supplied timezone offset and use TRY_CAST for malformed values. Scheduled clock fields do not independently establish observation freshness.",
      clever_predictions_v1: "tmstmp is the prediction batch observation time and prdtm is the predicted event time, both local strings in YYYYMMDD HH:MM format. Use try_strptime(column, '%Y%m%d %H:%M'). Predicted times do not establish source freshness.",
      bike_chattanooga_stations_v1: "last_updated and last_reported are Unix epoch seconds; parse with to_timestamp, treating zero as unknown."
    };

    async function getSampleRowForView(viewName) {
      if (sampleCache[viewName] !== undefined) {
        return sampleCache[viewName];
      }
      try {
        const columns = await getColumnsForView(viewName);
        const scalar = columns.filter(column => !/GEOMETRY|BLOB|STRUCT|\[|MAP\(|UNION\(/i.test(column.type));
        const temporal = column => /time|date|tmstmp|prdtm|last_reported|last_updated/i.test(column.name);
        const chosen = [...scalar.filter(temporal), ...scalar.filter(column => !temporal(column))].slice(0, 24);
        if (!chosen.length) return "";
        // Bound values inside DuckDB, before transferring them into JavaScript.
        // Three rows can reveal nulls/format variation without sampling payloads.
        const projection = chosen.map(({ name }) => {
          const quoted = '"' + name.replace(/"/g, '""') + '"';
          return `LEFT(CAST(${quoted} AS VARCHAR), 97) AS ${quoted}`;
        }).join(", ");
        const res = await conn.query(`SELECT ${projection} FROM data.${viewName} LIMIT 3;`);
        const rows = res.toArray();
        if (!rows.length) {
          sampleCache[viewName] = "";
          return "";
        }
        const fields = res.schema.fields.map((f) => f.name);
        sampleCache[viewName] = rows.map((row, index) => `row ${index + 1}: ` + fields.map(col => {
          if (row[col] === null || row[col] === undefined) return `"${col}"=null`;
          const val = formatCellValue(row[col]);
          return `"${col}"=${JSON.stringify(val.length > 96 ? `${val.slice(0, 96)}...[truncated]` : val)}`;
        }).join(", ")).join("\n  ");
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

      // Include up to two related schemas; samples are bounded separately.
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
          if (DATASET_TIME_GUIDANCE[v]) lines.push(`  Time semantics: ${DATASET_TIME_GUIDANCE[v]}`);
          if (v === "gtfsrt_trip_updates_v1") lines.push(`  Verified pattern for requested elapsed minutes between two predicted instants (not scheduled-versus-predicted delay; only use when explicitly requested):\n${TRIP_ELAPSED_SQL}`);
          if (sampleStr) {
            lines.push(`  Sample rows for data.${v}: ${sampleStr}`);
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
      if (/^MISSING_TIME_CONTEXT\b/i.test(cleaned)) {
        throw new Error("A reliable delay calculation needs a confirmed service date and timezone. This trip-update dataset contains scheduled clock times and dated predictions, but no confirmed service date. Ask to show trip updates to view the published times.");
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
        "+", "-", "*", "/", "//", "%", "**", "^", "||", "~~", "!~~", "~~*", "!~~*", "ilike_escape",
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

    async function generateSqlWithBackend(question, retryError = "", requestId = null, generation = null, signal = null) {
      const isCurrent = () => (requestId === null || requestId === reportRequestId) && aiAuthorized && !signal?.aborted;
      if (!isCurrent()) return null;
      const context = generation || {
        question, schema: await buildGroqSchemaPrompt(question),
        model: GROQ_MODELS.includes(groqModelSelect.value) ? groqModelSelect.value : GROQ_MODELS[0]
      };
      if (!isCurrent()) return null;
      const data = await staffSession.requestReport({
        question: context.question, schema: context.schema, model: context.model,
        ...(retryError ? { error: retryError.slice(0, 16000) } : {})
      }, signal);
      if (!isCurrent()) return null;
      if (!data || typeof data.sql !== "string" || !GROQ_MODELS.includes(data.model)) {
        throw new Error("AI reporting returned an invalid response.");
      }
      return { sql: extractSql(data.sql), usedModel: data.model, generation: context };
    }

    askAiBtn.addEventListener("click", async () => {
      if (!aiAuthorized || !staffSession || !conn) return;
      const question = aiQuestionInput.value.trim();
      if (!question) return;
      const title = `AI Search: "${question}"`;
      const requestId = beginReportRequest(title, "Preparing report...");
      aiStatusText.textContent = "Preparing report...";
      activeAiRequestId = requestId;
      const controller = new AbortController();
      activeAiController = controller;
      askAiBtn.disabled = true;
      try {
        if (isOffTopicQuestion(question)) {
          aiStatusText.textContent = "Blocked off-topic request (0 API tokens used).";
          throw new Error(
            "Only questions about CARTA datasets (bus routes, stops, vehicle locations, predictions, trip delays, ridership, bike stations, parcels, or addresses) are supported."
          );
        }

        const standardReport = findStandardReport(question);
        if (standardReport) {
          aiStatusText.textContent = "Loading standard report...";
          await executePagedQuery(standardReport.sql, standardReport.title, standardReport.sourceTime, requestId);
          if (requestId === reportRequestId) aiStatusText.textContent = "Report ready (standard report; no AI request).";
          return;
        }

        const generated = await generateSqlWithBackend(question, "", requestId, null, controller.signal);
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
          const retry = await generateSqlWithBackend(question, dbErr.message || String(dbErr), requestId, generated.generation, controller.signal);
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
          if (activeAiController === controller) activeAiController = null;
          askAiBtn.disabled = !conn || !aiAuthorized;
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
    initializeStaffSignIn();
  
