import { createRemoteJWKSet, jwtVerify } from "jose";
import defaults from "../ai-settings.json" with { type: "json" };
import { messagesFor } from "./report-prompt.mjs";

const MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    Object.assign(this, { status, code });
  }
}

function reply(status, body, extra = {}) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra }
  });
}

// Read the actual bytes, not just the caller's Content-Length declaration.
async function readBounded(source, maximum, signal) {
  if (!source.body) return "";
  const reader = source.body.getReader();
  const chunks = [];
  let length = 0;
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        cancel();
        throw new ApiError(413, "BODY_TOO_LARGE", "The request or response exceeds its size limit.");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function parseInput(text, settings) {
  let input;
  try { input = JSON.parse(text); } catch { throw new ApiError(400, "INVALID_REQUEST", "Send a valid JSON request."); }
  if (!input || Array.isArray(input) || typeof input !== "object" ||
      Object.keys(input).some(key => !["question", "schema", "model", "error"].includes(key)) ||
      typeof input.question !== "string" || !input.question.trim() || input.question.length > settings.questionCharacters ||
      typeof input.schema !== "string" || !input.schema.trim() || input.schema.length > 200000 ||
      !MODELS.includes(input.model) ||
      (input.error !== undefined && (typeof input.error !== "string" || !input.error.trim() || input.error.length > 16000))) {
    throw new ApiError(400, "INVALID_REQUEST", "Check the question, schema, approved model and optional correction fields.");
  }
  return input;
}

export function createReportHandler({
  env = process.env,
  settings = defaults,
  fetchProvider = globalThis.fetch,
  keySet,
  now = Date.now
} = {}) {
  // Cache only Microsoft's public signing keys, never authorization decisions.
  let remoteKeys, remoteTenant;
  return async function report(request) {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(settings.requestTimeoutMs)]);
    try {
      if (!["GET", "POST"].includes(request.method)) {
        return reply(405, { error: "METHOD_NOT_ALLOWED", message: "Use GET or POST." }, { Allow: "GET, POST" });
      }
      const tenant = env.ENTRA_TENANT_ID;
      const audience = env.ENTRA_API_CLIENT_ID;
      const client = env.ENTRA_WEB_CLIENT_ID;
      if (![tenant, audience, client].every(value => typeof value === "string" && GUID.test(value))) {
        throw new ApiError(503, "NOT_CONFIGURED", "AI reporting is not configured.");
      }
      const bearer = request.headers.get("authorization") || "";
      if (!/^Bearer [A-Za-z0-9_.-]+$/i.test(bearer) || bearer.length > 16384) {
        throw new ApiError(401, "SIGN_IN_REQUIRED", "Sign in with Microsoft to use AI reporting.");
      }
      if (!keySet && remoteTenant !== tenant) {
        remoteKeys = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`), { timeoutDuration: 5000 });
        remoteTenant = tenant;
      }
      let claims;
      try {
        ({ payload: claims } = await jwtVerify(bearer.slice(7), keySet || remoteKeys, {
          algorithms: ["RS256"], issuer: `https://login.microsoftonline.com/${tenant}/v2.0`, audience,
          requiredClaims: ["exp", "nbf", "iat", "sub"], currentDate: new Date(now())
        }));
      } catch (error) {
        if (error.code === "ERR_JWKS_TIMEOUT" || error instanceof TypeError) {
          throw new ApiError(503, "AUTH_UNAVAILABLE", "Microsoft sign-in verification is temporarily unavailable.");
        }
        throw new ApiError(401, "INVALID_TOKEN", "Your sign-in is invalid or expired. Sign in again.");
      }
      if (claims.ver !== "2.0" || claims.tid !== tenant || claims.azp !== client ||
          !GUID.test(claims.oid || "") || typeof claims.sub !== "string" || !claims.sub ||
          !Number.isFinite(claims.iat) || claims.iat > Math.floor(now() / 1000) || claims.idtyp === "app" ||
          typeof claims.scp !== "string" || !claims.scp.split(/\s+/).includes("Reports.Generate") ||
          !Array.isArray(claims.roles) || !claims.roles.includes("AI.ReportUser")) {
        throw new ApiError(403, "NOT_AUTHORIZED", "AI reporting is not enabled for this account.");
      }
      signal.throwIfAborted();
      if (request.method === "GET") return reply(200, { authorized: true });
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "") ||
          ![null, "identity"].includes(request.headers.get("content-encoding"))) {
        throw new ApiError(415, "CONTENT_TYPE", "Send an uncompressed application/json request.");
      }
      if (Number(request.headers.get("content-length")) > settings.requestBytes) {
        throw new ApiError(413, "BODY_TOO_LARGE", "The AI request is too large.");
      }
      const input = parseInput(await readBounded(request, settings.requestBytes, signal), settings);
      // Read the shared key only after validating authentication and authorization.
      const apiKey = env.GROQ_API_KEY;
      if (typeof apiKey !== "string" || !apiKey.trim() || /\s/.test(apiKey)) {
        throw new ApiError(503, "NOT_CONFIGURED", "AI reporting is not configured.");
      }
      const providerSignal = AbortSignal.any([signal, AbortSignal.timeout(settings.providerTimeoutMs)]);
      const candidates = [input.model, ...MODELS.filter(model => model !== input.model)];
      for (let index = 0; index < candidates.length; index++) {
        providerSignal.throwIfAborted();
        let upstream;
        try {
          upstream = await fetchProvider(GROQ_URL, {
            method: "POST", redirect: "error", signal: providerSignal,
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model: candidates[index], temperature: 0, max_completion_tokens: settings.outputTokens, messages: messagesFor(input) })
          });
        } catch {
          if (providerSignal.aborted) throw new ApiError(504, "AI_TIMEOUT", "AI reporting timed out. Try again later.");
          throw new ApiError(502, "PROVIDER_UNAVAILABLE", "The AI provider is temporarily unavailable.");
        }
        if (!upstream.ok) {
          await upstream.body?.cancel();
          if (index === 0 && [400, 404, 429].includes(upstream.status)) continue;
          throw new ApiError(502, "PROVIDER_UNAVAILABLE", "The AI provider could not complete this report. Try again later.");
        }
        let data;
        try { data = JSON.parse(await readBounded(upstream, 262144, providerSignal)); }
        catch {
          if (providerSignal.aborted) throw new ApiError(504, "AI_TIMEOUT", "AI reporting timed out. Try again later.");
          throw new ApiError(502, "INVALID_PROVIDER_RESPONSE", "The AI provider returned an invalid response.");
        }
        const sql = data?.choices?.[0]?.message?.content;
        if (typeof sql !== "string" || !sql.trim() || sql.length > 50000 || data.choices[0].finish_reason !== "stop") {
          throw new ApiError(502, "INCOMPLETE_RESPONSE", "The AI provider did not return a complete report query.");
        }
        providerSignal.throwIfAborted();
        signal.throwIfAborted();
        return reply(200, { sql, model: candidates[index] });
      }
    } catch (error) {
      if (error instanceof ApiError) {
        return reply(error.status, { error: error.code, message: error.message }, {
          ...(error.status === 401 ? { "WWW-Authenticate": "Bearer" } : {})
        });
      }
      if (signal.aborted || error.name === "TimeoutError" || error.name === "AbortError") {
        return reply(504, { error: "AI_TIMEOUT", message: "AI reporting timed out. Try again later." });
      }
      // Do not log or echo tokens, prompts, provider bodies or errors.
      return reply(503, { error: "AI_UNAVAILABLE", message: "AI reporting is temporarily unavailable." });
    }
  };
}
