# data.duckdb
> One-Click Database of All CARTA's Open Data 
<img width="467" height="193" alt="image" src="https://github.com/user-attachments/assets/f1e0e671-dad1-4292-a3a4-a5ab38db1e39" />

## Try it Out
You can quickly start querying the data by clicking [here](https://shell.duckdb.org/#queries=v0,ATTACH-'https%3A%2F%2Fgocarta.s3.us%20east%202.amazonaws.com%2Fpublic%2Fduckdb%2Fdata.duckdb'-as-data~,SELECT-*-FROM-duckdb_views()-WHERE-NOT-internal~,SELECT-*-FROM-data.gtfsrt_vehicle_positions_v1-LIMIT-5~)

## Import
You can add this database into your own DuckDB instance with one line by using DuckDB's attach mechanism:
```
ATTACH 'https://gocarta.s3.us-east-2.amazonaws.com/public/duckdb/data.duckdb' as data;
```

## Web explorer development

The browser application uses `index.html` for page structure,
`assets/styles.css` for the stylesheet, and `assets/app.js` for its JavaScript
module. The DuckDB-Wasm dependency is pinned in `assets/app.js`.

From the repository root on your development computer, start a local preview:

```powershell
python -m http.server 8000 --bind 127.0.0.1
```

Open http://127.0.0.1:8000 in your browser. Press Ctrl+C in the terminal to stop
the preview. JavaScript modules should be tested through this HTTP server rather
than opening `index.html` directly as a local file.

Run the report, key-handling, CSV, and SQL-policy regression checks with:

```powershell
node --test --test-reporter=dot tests/report-state.test.cjs tests/pagination.test.cjs tests/ai-report.test.cjs tests/api-key.test.cjs tests/csv-export.test.cjs tests/full-csv.test.cjs tests/sql-policy.test.cjs
```

The optional `tests/accessibility-browser.cjs` and `tests/query-limits-wasm.cjs`
checks accept temporary dependency prefixes as documented at the top of each
script. The browser check serves the real HTML, CSS, and JavaScript files while
mocking external data and AI requests.

The optional `tests/presets-live-browser.cjs` accepts a temporary prefix containing
`playwright-core` and uses installed Chrome to check all eight one-click reports
against the public CDN/catalog/data. It verifies complete pages and non-geometry
columns, route values, and stop paging. Network access is required; no AI key is used.

`tests/ai-times-browser.cjs` uses the same temporary browser prefix and the actual
pinned DuckDB-Wasm engine with a synthetic in-memory trip-update fixture. It
reproduces the timestamp errors, executes the SQL example supplied in the AI
context, and checks known results for offsets, midnight, daylight-saving changes,
invalid/missing values and service-day clocks beyond 24 hours. It also verifies
the standard-report request without an API key. The repository/public catalogs
are not modified. Network access is needed for the engine and initial catalog.

Add `--live-ai` to that command to test actual generation with both approved
models. This optional mode requires `GROQ_API_KEY` configured locally in the
process environment; never commit or paste the key into chat. It sends synthetic
fixture samples/questions to Groq, uses provider quota, and checks exact numeric
results plus refusal to invent a missing service date. Model fallback does not
count as verification of the requested model. Without this flag, provider calls
are blocked and live generation is explicitly reported as not run.

Exact, unqualified requests such as "Show CARTA Trip Updates & Delays (GTFS-RT)"
use the tested standard report without an AI call or key. Requests with additional
filters, calculations or sorting continue through AI generation. AI context now
prioritizes time fields in bounded samples (up to three rows, 24 scalar columns,
96 characters per value) and includes time semantics. Trip-update scheduled
clocks have no confirmed service date, so they cannot independently establish a
reliable delay against dated predictions. The assistant is instructed to explain
that missing context rather than guess a date. The verified elapsed-time SQL
example materializes parsed epochs before arithmetic to avoid a failure observed
with the combined expression in the pinned Wasm engine. Prompt guidance reduces
mistakes but does not guarantee every generated query or result is correct.

Reports use the shared Rows per page control, defaulting to 100. Previous and Next
load another page without accumulating all rows in the page's JavaScript state.
Preset and builder queries have no automatic total-row limit; AI instructions
request a LIMIT only when the question explicitly asks for one. Limits written in
report SQL are preserved. SQL is validated and reconstructed by DuckDB before an
outer page limit/offset is applied, so aggregation still uses the full input.

Queries without an explicit order use output-column ordering. For repeatable
pages, specify a unique ordering in SQL. Each page is a fresh read, so changing
source data or tied sort values can move rows between pages. Very expensive
queries and oversized cells/pages still have resource safeguards and cancellation.
Search applies to the current page. The single Download report (CSV) button
downloads all matching report rows by rerunning the loaded SQL without the page
wrapper or page search. SQL filters, aggregates, ordering,
LIMIT and OFFSET remain effective, and unexecuted SQL editor changes are ignored.
This is a fresh read, so source data may differ from the displayed page.

Full exports stream through the same SQL policy and database watchdog. With
`showSaveFilePicker` available, the browser writes awaited chunks to a chosen file
without accumulating the entire CSV in JavaScript. The file is committed only
after end-of-stream and successful query cleanup. Cancellation or failure aborts
the writable stream; a newly created empty file may remain. A failure during final
commit requires checking the destination because saving could not be confirmed.
Browsers without that picker use a bounded 20 MiB Blob fallback, creating a
download only after complete success. Larger fallback exports fail without a
partial download. Full export has no total row/cell cap, but retains the 100-column,
100,000-character cell, 5 MiB encoded-row and 30-second limits. Chunks target 256 KiB;
a single safe row can exceed that target. The 256 MB engine buffer-manager limit
is not a bound on total browser memory. Stop report terminates the database worker,
aborts the export, and requires Reconnect. Starting another report or page cancels
an export that has not begun final commit. Downloads use a UTF-8 BOM,
formula-text protection and quoting; Excel identifier import still requires Text.

`tests/full-csv-browser.cjs` accepts the temporary browser dependency prefix. It
uses the actual pinned browser engine, public bus-stop data and an isolated
in-memory fixture, plus real browser-owned filesystem writers. It checks full
exports, SQL limits/aggregates, fallback downloads, large streaming and aborted
file preservation. The native save dialog itself still needs a manual check.

One-click table reports select explicit reporting columns. Geometry payloads are
excluded from these presets because they are intended for maps and can exceed
the per-cell display limit. IDs, names, coordinates and other non-geometry fields
are preserved. Geometry remains available in the underlying datasets for custom
queries, subject to the existing output safeguards.

## Background
Both data availability and access are important.  CARTA publishes all its open datasets using [datablob](https://pypi.org/project/datablob) in numerous file formats, including parquet.  After making data available, we wanted to drive down the friction in accessing and analyzing the data, so we created data.duckdb.  A single DuckDB database that points to all our open datasets.  It enables people to easily query, filter, and join all our open datasets.

## Example
Here's an example of using data.duckdb to query across multiple tables.  In this example we get all the Bike Chattanooga stations within 25 meters of Route 4.  
<img width="428" height="292" alt="image" src="https://github.com/user-attachments/assets/93371098-fdee-4381-ae78-43d1628c9963" />

## Download
You can directly download the database here:  
https://gocarta.s3.us-east-2.amazonaws.com/public/duckdb/data.duckdb

## Rebuilding the catalog safely

Run `run.ps1` on Windows or `run.sh` on Linux from the repository root. Run one
generation at a time, with other catalog readers and writers closed.

The generator reads and validates `datasets.csv`, then creates a candidate in a
unique `.data.duckdb-build-*` directory beside the working database. After closing
and checkpointing the candidate, it reopens it read-only, checks the exact view
list, and binds every view against its source. This checks the catalog and source
schemas without claiming that all remote rows have been validated.

Before publishing, it checks that the working catalog has no WAL file and has not
changed during the build. It copies the previous catalog to `previous.duckdb` in
the build directory and verifies the copy by SHA-256. Only then does it atomically
replace `data.duckdb`. A generation, validation, backup, or replacement failure
returns an error and preserves the working catalog. Close other applications if
Windows reports that the catalog is locked.

Build directories, failed candidates, and previous-catalog backups are retained.
Their paths are printed by the generator and ignored by Git for the default
catalog name. No cleanup deletion is performed automatically. Review these files
and obtain explicit confirmation before deleting any of them. To restore an older
catalog, first close catalog connections, then explicitly choose and copy the
desired `previous.duckdb` backup over `data.duckdb`.
