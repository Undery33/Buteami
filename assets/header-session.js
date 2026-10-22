import { accountRequest, isAccountTransportAllowed } from "./auth.js";

export function setupHeaderSession(doc = document, win = window, fetcher = globalThis.fetch) {
  const login = doc.querySelector("#header-login");
  const session = doc.querySelector("#header-session");
  const user = doc.querySelector("#header-user");
  const logout = doc.querySelector("#header-logout");
  const status = doc.querySelector("#header-status");
  if (!login || !session || !user || !logout || !status) return;

  let revision = 0;
  let lookupController;
  let logoutController;
  let loggingOut = false;

  function showGuest() {
    login.hidden = false;
    session.hidden = true;
    user.textContent = "";
    user.removeAttribute("title");
  }

  async function refreshSession() {
    if (loggingOut) return;
    const current = ++revision;
    lookupController?.abort();
    showGuest();
    if (!isAccountTransportAllowed(win.location)) return;
    const request = lookupController = new AbortController();
    try {
      const response = await fetcher("/api/auth/me", {
        credentials: "same-origin", cache: "no-store", signal: request.signal,
      });
      if (!response.ok) return;
      const data = await response.json();
      if (current !== revision || request.signal.aborted || loggingOut) return;
      if (!data?.user || typeof data.user.username !== "string" || !data.user.username.trim()) return;
      const name = typeof data.user.fullName === "string" && data.user.fullName.trim() ? data.user.fullName : data.user.username;
      user.textContent = name;
      user.title = `${name}님`;
      login.hidden = true;
      session.hidden = false;
    } catch { /* Keep the existing login link available when session lookup fails. */ }
  }

  logout.addEventListener("click", async () => {
    if (loggingOut || !isAccountTransportAllowed(win.location)) return;
    const current = ++revision;
    lookupController?.abort();
    loggingOut = true;
    logout.disabled = true;
    status.hidden = true;
    status.textContent = "";
    const request = logoutController = new AbortController();
    try {
      await accountRequest("logout", {}, fetcher, request.signal);
      if (current !== revision || request.signal.aborted) return;
      showGuest();
      login.focus();
    } catch {
      if (current !== revision || request.signal.aborted) return;
      status.textContent = "로그아웃을 완료하지 못했습니다. 다시 시도해주세요.";
      status.hidden = false;
    } finally {
      if (current === revision) {
        loggingOut = false;
        logout.disabled = false;
      }
    }
  });

  win.addEventListener("pagehide", () => {
    revision++;
    lookupController?.abort();
    logoutController?.abort();
    loggingOut = false;
    logout.disabled = false;
    status.hidden = true;
    status.textContent = "";
    showGuest();
  });
  win.addEventListener("pageshow", (event) => { if (event.persisted) refreshSession(); });
  doc.addEventListener("visibilitychange", () => { if (doc.visibilityState === "visible") refreshSession(); });
  refreshSession();
}

if (typeof document !== "undefined") setupHeaderSession();
