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
| GET | Returns `{"authorized":true}` after access checks, without reading the provider key or using quota storage. |
| POST | Accepts JSON containing `question`, `schema` and `model`; returns `sql`, the actual `model` used and a `reportId`. |
| Other methods | Return 405. |

Supported models are `openai/gpt-oss-120b` and `openai/gpt-oss-20b`. The server
constructs the prompt and provider request; unknown fields are rejected.
Question and schema content, including any supplied samples, is sent to Groq.
Treat returned SQL as untrusted and retain browser-side validation.

For one SQL correction, repeat the original question, schema and preferred model
exactly, adding `reportId` and the DuckDB `error`. Keep the preferred model even
if the original request used fallback. Corrections belong to the same user,
expire after 15 minutes and can be claimed only once, including failed attempts.
Schema and error text are limited to 200,000 and 16,000 characters respectively.

The backend tries the other model after provider HTTP 400, 404 or 429. The browser
must not add another fallback loop. API responses use `Cache-Control: no-store`
and provide no cross-origin allowance. Errors contain generic messages rather
than provider bodies or credentials.

## Limits and storage

Defaults are configured in [`netlify/ai-settings.json`](../netlify/ai-settings.json):

| Limit | Default |
| --- | --- |
| Questions per user | 200 per UTC day |
| Provider attempts per user | 20 per UTC minute |
| Request body | 256 KiB |
| Question length | 8,000 characters |
| Provider output | 4,096 tokens |
| Provider timeout | 45 seconds across model attempts in one request |
| Whole request timeout | 55 seconds |

Accepted initial submissions consume daily quota even if generation later fails.
Fallback and correction do not consume another daily question; every provider
attempt consumes minute quota. A quota response is 429 with `Retry-After`.
Provider and hosting limits may apply separately.

Usage records and correction permits use the site-wide `carta-ai-usage-v1`
Netlify Blobs store. Conditional writes claim quota slots and correction permits.
User identifiers are hashed. Stored records contain markers, context hashes and
expiry times, without questions, schemas, SQL, raw user IDs, tokens or keys.
Storage failures deny AI requests.

Records persist across deployments and are shared across deploy contexts.
Correction expiry does not delete records; automatic cleanup is not implemented.
Use a separate project for isolated testing. Local Netlify Dev storage is
separate from deployed storage.

## Verification

Run in **PowerShell on Windows**, from the repository root after `npm ci`:

```powershell
node --test --test-reporter=spec tests/protected-api.test.mjs
```

These tests use fixture tokens and mocked provider/storage responses. Use the
[deployment checks](netlify-hosting.md#5-verify) to verify a live environment.

## References

- [jose token verification](https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md)
- [Netlify Blobs](https://docs.netlify.com/build/data-and-storage/netlify-blobs/)
