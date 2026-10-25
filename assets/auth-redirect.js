msalRedirectBridge.broadcastResponseToMainFrame().catch(() => {
  document.getElementById("authReturnStatus").textContent = "Sign-in could not complete. Close this window and try signing in again.";
});
