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

## Web explorer

Browse CARTA data with One-Click Reports, the Visual Filter Builder, or the AI
Report Assistant. Queries run in your browser using DuckDB.

Open the [hosted explorer](https://carta-open-data-explorer-poc.netlify.app/).

AI reporting requires Microsoft sign-in and staff authorization. Other reports
remain public.

The authorized assistant also accepts dataset-discovery questions such as
"What datasets are available?" It lists names, table references and descriptions
from the connected catalog locally, without sending an AI generation request.

The explorer uses the catalog at upstream commit
[`6452b5028cc570c4c4079d8d3fa8bf46002f4b02`](https://github.com/gocarta/data.duckdb/commit/6452b5028cc570c4c4079d8d3fa8bf46002f4b02),
configured by `REMOTE_DUCKDB_URL` in `assets/app.js`. This pins the dataset
definitions and catalog format; records in the referenced S3 files can still
refresh daily. See [updating the catalog pin](docs/netlify-hosting.md#updating-the-catalog-pin)
when a newer catalog is needed.

To deploy for your organization, follow the [Entra setup](docs/entra-setup-runbook.md)
and [Netlify deployment](docs/netlify-hosting.md) runbooks using your own tenant,
application registrations, hosting project and Groq API key.

Download report (CSV) exports the full matching report, preserving SQL limits.
Search this page affects only the displayed page. See Download help for export
limits and Excel guidance.

## Development checks

Use Node.js 22.12 or later and npm. The CSV checks also require
Python 3 (`python` on PATH). SQL-policy checks use the project's pinned Wasm parser.
Run these commands from the repository root on Windows, macOS or Linux:

```sh
npm ci
npm run test:browser:install
```

Browser checks use Playwright's managed Chromium, with the matching version
selected by the lockfile. No system Chrome installation, browser executable path,
or temporary dependency folder is required. On Linux, the browser also needs the
system libraries listed in [Playwright's browser setup](https://playwright.dev/docs/browsers#install-system-dependencies).
Browser installation needs network access; repeat it after upgrading Playwright.

| Command | Checks | Network access |
| --- | --- | --- |
| `npm test` | Existing regression suite | None after setup |
| `npm run test:browser` | Accessibility/UI and Microsoft session-cache fixtures | None after setup; external requests are mocked or blocked |
| `npm run test:wasm` | Filter builder and query limits in the pinned Wasm engine | None after setup |
| `npm run test:browser:live` | Public reports, timestamp calculations and full CSV exports | Public CDN, catalog and dataset access |

None of these checks requests a live AI report. The session checks simulate
interactive Microsoft sign-in/out; verify the real popup separately when changing
authentication behavior. Individual checks can also be run with
`node tests/<check-name>.cjs`, without dependency-path arguments.
Test dependencies are development-only and are not copied into the published site.

## Background
Both data availability and access are important.  CARTA publishes all its open datasets using [datablob](https://pypi.org/project/datablob) in numerous file formats, including parquet.  After making data available, we wanted to drive down the friction in accessing and analyzing the data, so we created data.duckdb.  A single DuckDB database that points to all our open datasets.  It enables people to easily query, filter, and join all our open datasets.

## Example
Here's an example of using data.duckdb to query across multiple tables.  In this example we get all the Bike Chattanooga stations within 25 meters of Route 4.  
<img width="428" height="292" alt="image" src="https://github.com/user-attachments/assets/93371098-fdee-4381-ae78-43d1628c9963" />

## Download
You can directly download the database here:  
https://gocarta.s3.us-east-2.amazonaws.com/public/duckdb/data.duckdb

## Rebuilding the catalog

Run `run.ps1` (Windows) or `run.sh` (Linux) from the repository root with other
catalog connections closed. Rebuilds validate the replacement and retain backups
in `.data.duckdb-build-*` folders. These folders are not automatically removed.
