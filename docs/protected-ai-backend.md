# Protected AI backend

Technical reference for `/.netlify/functions/report`. The function authorizes
staff users and requests SQL from Groq; the browser validates and executes the
SQL. Public reports do not require this API.

Implementation: [`report-api.mjs`](../netlify/lib/report-api.mjs) and
[`report-prompt.mjs`](../netlify/lib/report-prompt.mjs).
For deployment instructions, see [the Netlify runbook](netlify-hosting.md).

## Authentication and configuration

Every GET and POST requires a Microsoft v2 delegated API access token in the
`Authorization: Bearer` header. The backend validates its RS256 signature,
tenant, issuer, API audience, lifetime and approved web client. It also requires
the `Reports.Generate` scope, `AI.ReportUser` role and user identity claims.
Administrator status does not bypass these checks. Removing a role may not
remove access until an already issued token expires.

MSAL caches authentication tokens and account information in the current tab's
`sessionStorage`, so refreshing the page can restore the selected account. The
frontend silently acquires an API token and checks backend authorization again
before enabling AI; cached account details never grant access on their own. It
does not launch an interactive sign-in popup on refresh. Expired sessions or
access-check failures leave AI unavailable and require user action. Sign-out
clears the selected account and MSAL cache for that account in the current tab.
The application does not configure MSAL to use `localStorage`. Browser session
restore can preserve tab storage, so shared-device users should explicitly sign
out. This authentication cache does not store questions, reports, usage history,
or the Groq key. See [Microsoft's cache guidance](https://learn.microsoft.com/en-us/entra/msal/javascript/browser/caching).

Configure these server environment variables:

| Variable | Purpose |
| --- | --- |
| `ENTRA_TENANT_ID` | Entra tenant ID |
| `ENTRA_API_CLIENT_ID` | API application ID used as the token audience |
| `ENTRA_WEB_CLIENT_ID` | Permitted web client application ID |
| `GROQ_API_KEY` | Server-side provider key, required for POST only |

Keep the provider key out of source code and browser files. See
[Entra setup](entra-setup-runbook.md) for registrations, role assignment and consent.

## API contract

| Method | Behavior |
| --- | --- |
| GET | Returns `{"authorized":true}` after access checks, without reading the provider key. |
| POST | Accepts JSON containing `question`, `schema`, `model` and an optional correction `error`; returns `sql` and the actual `model` used. |
| Other methods | Return 405. |

Supported models are `openai/gpt-oss-120b` and `openai/gpt-oss-20b`. The server
constructs the prompt and provider request; unknown fields are rejected.
Question and schema content, including any supplied samples, is sent to Groq.
Treat returned SQL as untrusted and retain browser-side validation.

For a SQL correction, repeat the original question, schema and preferred model,
adding the DuckDB `error`. Keep the preferred model even if the original request
used fallback. The browser attempts one automatic correction. The backend
revalidates authorization on every request but stores no correction permits;
authorized API clients can repeat correction requests. There are no report IDs,
single-use claims or correction-expiry checks.
Schema and error text are limited to 200,000 and 16,000 characters respectively.

The backend tries the other model after provider HTTP 400, 404 or 429. The browser
must not add another fallback loop. API responses use `Cache-Control: no-store`
and provide no cross-origin allowance. Errors contain generic messages rather
than provider bodies or credentials.

## Request limits and data handling

Defaults are configured in [`netlify/ai-settings.json`](../netlify/ai-settings.json):

| Limit | Default |
| --- | --- |
| Request body | 256 KiB |
| Question length | 8,000 characters |
| Provider output | 4,096 tokens |
| Provider timeout | 45 seconds across model attempts in one request |
| Whole request timeout | 55 seconds |

The application has no per-user daily or minute quotas and uses no persistent
storage for users, usage counters, user hashes or report corrections. It does not
keep user history in function memory. Requests and identity claims are processed
temporarily, and only Microsoft's public signing keys are cached across requests.
Questions, tokens, provider bodies and SQL are not written to application logs.
Provider and hosting limits still apply independently.

Microsoft retains directory and sign-in information under the tenant's policies.
Netlify and Groq have separate operational records and retention settings. See
the [data-use notice](../about.html).

Deploy the updated frontend and function together, and reload existing browser
tabs; the API no longer accepts the previous report-ID format.

Earlier versions wrote usage records to the `carta-ai-usage-v1` Netlify Blobs store.
This version neither reads nor writes that store, and deployment does not remove
historical records. After deploying, confirm the Netlify project and arrange
explicit removal of that legacy store. Older deployed versions can recreate
records while they continue to receive requests.

## Verification

Run in **PowerShell on Windows**, from the repository root after `npm ci`:

```powershell
node --test --test-reporter=spec tests/protected-api.test.mjs
```

These tests use fixture tokens and mocked provider responses. Use the
[deployment checks](netlify-hosting.md#5-verify) to verify a live environment.

For an offline browser cache check, follow the [development setup](../README.md#development-checks),
then run `node tests/staff-session-browser.cjs`. The check uses the project's
locked Playwright dependency and its managed Chromium, without a browser path.
It uses the installed MSAL library with fake authentication tokens to check
same-tab refresh, a separate tab, backend denial, and cache clearing on sign-out.
External network requests are blocked; it does not test a real Microsoft login.

## References

- [jose token verification](https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md)
