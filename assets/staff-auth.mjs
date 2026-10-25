const ENDPOINT = "/.netlify/functions/report";
const DENIED = "AI reporting is not enabled for this account.";

// MSAL owns OAuth, PKCE and token renewal, with a cache scoped to this browser tab.
export async function createStaffSession({ config, onState, library = globalThis.msal, fetchRequest = globalThis.fetch, origin = globalThis.location.origin }) {
  const redirectUri = `${origin}/auth-redirect.html`;
  if (!library || !config.redirectUris?.includes(redirectUri)) throw new Error("Sign-in is unavailable at this address.");
  const pca = new library.PublicClientApplication({
    auth: { clientId: config.webClientId, authority: `https://login.microsoftonline.com/${config.tenantId}`, redirectUri },
    cache: { cacheLocation: "sessionStorage" },
    system: { loggerOptions: { loggerCallback() {}, piiLoggingEnabled: false }, serverTelemetryEnabled: false }
  });
  await pca.initialize();
  let account = pca.getActiveAccount(), authorized = false, revision = 0, checking = null;
  const publish = (allowed, message = "", busy = false) => {
    authorized = allowed;
    onState({ signedIn: !!account, name: account?.name || "Signed-in user", authorized, message, busy });
  };
  const token = () => pca.acquireTokenSilent({ account, scopes: [config.apiScope], cacheLookupPolicy: library.CacheLookupPolicy.AccessTokenAndRefreshToken });

  async function checkAccess(restoring = false) {
    const attempt = ++revision;
    checking?.abort();
    checking = new AbortController();
    publish(false, "Checking AI access...", true);
    try {
      const result = await token();
      if (attempt !== revision) return;
      const response = await fetchRequest(ENDPOINT, {
        headers: { Authorization: `Bearer ${result.accessToken}` }, cache: "no-store", redirect: "error",
        signal: AbortSignal.any([checking.signal, AbortSignal.timeout(15000)])
      });
      if (attempt !== revision) return;
      if (response.status === 403) { publish(false, DENIED); return; }
      if (!response.ok) { publish(false, "AI access could not be checked. Sign out and sign in again to retry."); return; }
      const data = await response.json();
      if (attempt === revision) publish(data.authorized === true, data.authorized === true ? "" : DENIED);
    } catch (error) {
      if (attempt !== revision) return;
      const network = ["network_error", "no_network_connectivity", "endpoints_resolution_error"].includes(error.errorCode) || error instanceof TypeError;
      publish(false, network ? "AI access could not be checked. Sign out and sign in again to retry."
        : restoring ? "Your sign-in needs attention. Sign out and sign in again." : DENIED);
    }
  }

  publish(false);
  // Restore only the previously selected account. A cached identity never grants AI access:
  // renew its token and recheck the backend without opening a sign-in popup on page load.
  if (account) void checkAccess(true);
  return {
    async signIn() {
      const attempt = ++revision;
      publish(false, "Signing in...", true);
      try {
        // Identity sign-in remains possible without an API role or API consent.
        const result = await pca.loginPopup({ scopes: ["openid", "profile"], prompt: "select_account" });
        if (attempt !== revision) return;
        account = result.account;
        if (!account) throw new Error("Missing account.");
        pca.setActiveAccount(account);
        await checkAccess();
      } catch {
        if (attempt === revision) publish(false, "Sign-in did not complete. Try again.");
      }
    },
    async signOut() {
      ++revision;
      checking?.abort();
      const previous = account;
      account = null;
      pca.setActiveAccount(null);
      publish(false, "Signing out...", true);
      try {
        await pca.logoutPopup({ account: previous, postLogoutRedirectUri: `${origin}/` });
        publish(false);
      } catch {
        await pca.clearCache({ account: previous }).catch(() => {});
        publish(false, "Signed out of this app. Microsoft sign-out did not complete.");
      }
    },
    async requestReport(body, signal) {
      if (!account || !authorized) throw new Error(DENIED);
      const attempt = revision;
      let result;
      try { result = await token(); }
      catch {
        if (attempt === revision) { ++revision; publish(false, "Your sign-in needs attention. Sign out and sign in again."); }
        throw new Error("Sign in again to use AI reporting.");
      }
      if (attempt !== revision) throw new DOMException("AI request canceled.", "AbortError");
      signal?.throwIfAborted();
      const response = await fetchRequest(ENDPOINT, {
        method: "POST", redirect: "error", cache: "no-store",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${result.accessToken}` },
        body: JSON.stringify(body), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)])
      });
      if (attempt !== revision) throw new DOMException("AI request canceled.", "AbortError");
      if (response.status === 401 || response.status === 403) {
        ++revision;
        publish(false, response.status === 403 ? DENIED : "Your sign-in needs attention. Sign out and sign in again.");
        throw new Error(DENIED);
      }
      if (response.status === 429) {
        const seconds = Number(response.headers.get("retry-after"));
        throw new Error(`AI reporting is temporarily rate-limited.${Number.isFinite(seconds) && seconds > 0 ? ` Try again in ${Math.ceil(seconds)} seconds.` : " Try again later."}`);
      }
      if (!response.ok) throw new Error(response.status === 504 ? "AI reporting timed out. Try again later." : "AI reporting is temporarily unavailable. Try again later.");
      return response.json();
    }
  };
}
