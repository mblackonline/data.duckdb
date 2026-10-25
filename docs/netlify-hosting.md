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
npx --yes netlify-cli deploy --no-build --prod --context production --dir dist --functions netlify/functions
```

This uploads the built frontend and packages the function with its dependencies.
Do not add npm's `--offline` flag to deployment commands. Record the resulting
deploy ID and log link in a separate release record.

## 5. Verify

Test at the primary HTTPS site URL, whose callback is registered in Entra:

- Public reports, pagination and full CSV export work without sign-in.
- AI is hidden while signed out. An authorized user can sign in and generate a
  report; an unassigned user cannot use AI. Sign-out hides AI and cancels pending AI work.
- AI requests go to `/.netlify/functions/report`, without exposing a provider key
  or calling Groq directly from the browser.
- The callback loads without a URL rewrite or `Cross-Origin-Opener-Policy` header.
- `/docs/netlify-hosting.md`, `/.git/config`, `/package.json` and
  `/netlify/lib/report-api.mjs` return 404.

With valid Entra settings, anonymous API GET/POST requests should return 401 and
OPTIONS should return 405. A 503 is a readiness failure. Check function logs and
variable configuration; do not share keys or authenticated request headers.

## 6. Roll back

In Netlify, open **Deploys**, select an available previous working successful
deploy and choose **Publish Deploy**. Repeat verification. If automatic publishing
is enabled, lock it while investigating.

Rollback does not undo Entra changes. Older versions can resume persistent usage
tracking. Check that the older deploy's environment values remain valid; applying
new values requires a new deployment. See [backend data handling](protected-ai-backend.md#request-limits-and-data-handling)
for legacy usage records and cleanup.

## Further reference

- [Backend configuration and limits](protected-ai-backend.md)
- [Netlify CLI deployment options](https://cli.netlify.com/commands/deploy/)
- [Function environment variables and scopes](https://docs.netlify.com/build/functions/environment-variables/)
- [Netlify rollback procedure](https://docs.netlify.com/deploy/manage-deploys/manage-deploys-overview/#rollbacks)
