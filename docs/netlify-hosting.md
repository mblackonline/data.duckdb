# Netlify deployment runbook

Run commands in **PowerShell on Windows**, from the repository root. Stop if a
command fails. This procedure uses manual deployments, without a Git connection.

## 1. Prepare

Requires Node.js 22.12 or later, npm and access to the intended Netlify project.

```powershell
npm ci
```

For a new environment, complete [Entra setup](entra-setup-runbook.md) in your
organization's chosen tenant. Replace the tenant, application, scope and callback
settings in `assets/staff-config.json` with values for that environment. Use your
own Netlify project and Groq API key. Register the exact callback URLs in both Entra and
that file: `http://localhost:8000/auth-redirect.html` and
`https://<YOUR_SITE_HOSTNAME>/auth-redirect.html`.

Staff AI access requires the `AI.ReportUser` role and `Reports.Generate` consent.
Keep HTML pretty URLs disabled and do not add a `Cross-Origin-Opener-Policy`
header to the callback page.

## 2. Configure Netlify

Create or select the application's Netlify project. Copy its Project ID, then:

```powershell
npx --yes netlify-cli login
$projectId = Read-Host 'Netlify Project ID'
npx --yes netlify-cli link --id $projectId
npx --yes netlify-cli status
```

Confirm the account and project shown. Linking does not deploy anything.

In Netlify's environment variable settings, set these **Production** values:

| Variable | Value |
| --- | --- |
| `ENTRA_TENANT_ID` | Tenant ID matching `assets/staff-config.json` |
| `ENTRA_WEB_CLIENT_ID` | Web client application ID matching that file |
| `ENTRA_API_CLIENT_ID` | API application ID, without `api://` or the scope suffix |
| `GROQ_API_KEY` | Dedicated Groq key, entered directly in Netlify |

Keep the key out of source code and browser files. Mark it as a secret where
available. Restrict variables to **Functions** if the plan supports scopes;
otherwise builds may also receive them. Keep production credentials away from
untrusted builds and previews. Variable changes require a new deployment.

## 3. Check locally

Run the regression command in the [README](../README.md), then check packaging:

```powershell
npx --yes netlify-cli build --offline
```

Expected: the build succeeds and packages the `report` function.
`netlify.toml` publishes only `dist` and packages functions from
`netlify/functions`. **Never publish the repository root.** If the build reports
an unexpected file in `dist`, inspect it before moving or removing it.

Optional browser preview, after building:

```powershell
npx --yes netlify-cli dev --offline
```

Open `http://localhost:8000/`; stop with Ctrl+C. Rebuild after frontend edits.
Offline preview does not load Netlify-hosted variables. Local AI testing needs
its own server environment; public reporting still needs internet access.

## 4. Deploy

For an update, identify the previous working deploy in Netlify before publishing.
Build the reviewed source:

```powershell
node scripts/build-site.cjs
```

After a successful build, **publish to the live site**:

```powershell
npx --yes netlify-cli deploy --no-build --prod --dir dist --functions netlify/functions --skip-functions-cache
```

This uploads the built frontend and packages the function with its dependencies.
The final flag forces fresh function packaging from source, bypassing any local
function manifest cache. Keep using `netlify/functions` as the source directory.
Do not add npm's `--offline` flag to deployment commands. Record the resulting
deploy ID and log link in a separate release record.

## 5. Verify

Test at the primary HTTPS site URL, whose callback is registered in Entra:

- Public reports, pagination and full CSV export work without sign-in.
- AI is hidden while signed out. An authorized user can sign in and generate a
  report; an unassigned user cannot use AI. Sign-out hides AI and cancels pending AI work.
- Refresh the same signed-in tab. AI remains hidden until the restored Microsoft
  session passes a fresh backend authorization check, then becomes available
  without another interactive sign-in. Sign out and refresh again to confirm
  this app stays signed out. Browser session restore may preserve tab storage;
  explicitly sign out on shared devices.
- AI requests go to `/.netlify/functions/report`, without exposing a provider key
  or calling Groq directly from the browser.
- The callback loads without a URL rewrite or `Cross-Origin-Opener-Policy` header.
- Static responses include the policy in [`_headers`](../_headers), including
  Content-Security-Policy, X-Frame-Options, X-Content-Type-Options, Referrer-Policy,
  and Permissions-Policy. The build copies this file into `dist` for Netlify.
- `/docs/netlify-hosting.md`, `/.git/config`, `/package.json` and
  `/netlify/lib/report-api.mjs` return 404.

With valid Entra settings, anonymous API GET/POST requests should return 401 and
OPTIONS should return 405. A 503 is a readiness failure. Check function logs and
variable configuration; do not share keys or authenticated request headers.

The CSP permits the current jsDelivr-hosted DuckDB modules, its Blob worker and
WebAssembly compilation, public catalog/Parquet/extension hosts, and Microsoft
sign-in. Inline styles remain allowed for the existing layout; arbitrary inline
JavaScript and JavaScript `eval` remain blocked. A hash allows only Netlify's
current fixed badge iframe helper. If Netlify changes that helper, the browser
will block the new helper until its contents are reviewed and the hash is
updated. Core reports do not depend on that badge helper. Do not weaken the
policy with `script-src 'unsafe-inline'` to accommodate a provider update.
Same-origin framing is allowed for Microsoft callback compatibility; external
framing is blocked. Keep COOP/COEP absent unless a separately tested sign-in
change requires them. Custom static headers do not apply to function responses;
the API separately returns `Cache-Control: no-store` and `nosniff`.

## 6. Roll back

In Netlify, open **Deploys**, select an available previous working successful
deploy and choose **Publish Deploy**. Repeat verification. If automatic publishing
is enabled, lock it while investigating.

Rollback does not undo Entra changes. Older versions can resume persistent usage
tracking. Check that the older deploy's environment values remain valid; applying
new values requires a new deployment. See [backend data handling](protected-ai-backend.md#request-limits-and-data-handling)
for legacy usage records and cleanup.

## Updating the catalog pin

The explorer attaches a specific upstream GitHub commit, rather than `main`, so
catalog changes are tested before adoption. The current commit is recorded in
the [README](../README.md#web-explorer); the actual URL is `REMOTE_DUCKDB_URL` in
`assets/app.js`.

Daily record refreshes at the existing S3 file URLs need no pin update. Update
the pin when adopting reviewed catalog changes, such as a new dataset or a changed
view definition. Pinning does not prevent changes to the S3 files themselves;
coordinate changes to their paths, column names and types with the publisher.

1. Choose a full commit SHA from `gocarta/data.duckdb` containing the intended
   `data.duckdb`. Keep the previous URL available for rollback.
2. Replace only the commit segment of `REMOTE_DUCKDB_URL` in `assets/app.js`,
   using this URL format, and update the README's commit reference:

   ```text
   https://raw.githubusercontent.com/gocarta/data.duckdb/<FULL_COMMIT_SHA>/data.duckdb
   ```

3. Run the existing checks from the repository root:

   ```powershell
   npm test
   npm run test:browser:live
   ```

   Confirm that the candidate catalog attaches with the application's pinned
   DuckDB engine and that the required reports still work. Investigate failures
   before adopting the pin; a live check can also fail because an underlying S3
   dataset is unavailable or malformed. An incompatible catalog format requires
   a separately reviewed engine update, not an automatic dependency upgrade.
4. Commit and push the reviewed URL and README changes, then follow **4. Deploy**
   and **5. Verify** above. Refresh the site after deployment.
5. If the new catalog causes a regression, restore the previous URL and README
   reference, then rebuild and redeploy, or use **6. Roll back** above.

## Further reference

- [Backend configuration and limits](protected-ai-backend.md)
- [Netlify CLI deployment options](https://cli.netlify.com/commands/deploy/)
- [Function environment variables and scopes](https://docs.netlify.com/build/functions/environment-variables/)
- [Netlify rollback procedure](https://docs.netlify.com/deploy/manage-deploys/manage-deploys-overview/#rollbacks)
