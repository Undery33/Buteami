import { formFields, validateAccountForm } from "./auth-validation.js";

const transportMessage = "개인정보 보호를 위해 HTTPS 연결에서만 계정 기능을 사용할 수 있습니다. HTTPS 주소로 다시 접속해주세요.";
const unavailableMessage = "계정 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.";

export function isAccountTransportAllowed(location) {
  if (!location || typeof location.hostname !== "string" || !location.hostname) return false;
  if (location.protocol === "https:") return true;
  return location.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
}

export function apiErrorMessage(status, kind) {
  if ([404, 405, 502, 503].includes(status)) return unavailableMessage;
  if (status === 429) return "요청이 많습니다. 잠시 후 다시 시도해주세요.";
  if (status === 409 && kind === "signup") return "가입 정보를 사용할 수 없습니다. 입력 내용을 확인해주세요.";
  if (status === 423 || (status === 401 && kind === "login")) return "로그인할 수 없습니다. 아이디와 비밀번호를 확인해주세요. 비밀번호 3회 실패로 잠긴 계정은 비밀번호 재설정으로 복구할 수 있습니다.";
  if (status === 400 || status === 422) {
    if (kind === "find-id") return "입력한 회원 정보가 일치하지 않습니다. 이름과 이메일을 확인해주세요.";
    if (kind === "reset-password") return "입력한 회원 정보를 확인해주세요. 이름, 아이디와 이메일이 모두 일치해야 합니다.";
    return "입력 정보를 확인해주세요.";
  }
  if (status === 403) return "요청을 확인할 수 없습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.";
  return "요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.";
}

export async function accountRequest(kind, values, fetcher = globalThis.fetch, signal) {
  if (!Object.hasOwn(formFields, kind) && kind !== "logout") throw new Error("Unknown account action");
  // Check the real browser location before constructing or sending account data.
  // Node has no location; local non-browser tests inject only their fetch stub.
  if (typeof globalThis.location !== "undefined" && !isAccountTransportAllowed(globalThis.location)) throw new Error(transportMessage);
  const response = await fetcher(`/api/auth/${kind}`, {
    method: "POST", credentials: "same-origin", cache: "no-store", signal,
    headers: { "Content-Type": "application/json", "X-Buteami-Request": "1" },
    body: JSON.stringify(values),
  });
  if (!response.ok) throw new Error(apiErrorMessage(response.status, kind));
  const expectedStatus = kind === "signup" ? 201 : 200;
  if (response.status !== expectedStatus) throw new Error("서버 응답을 확인할 수 없습니다. 잠시 후 다시 시도해주세요.");
  // A proxy's HTML error page must never appear as a completed account action.
  let data;
  try { data = await response.json(); }
  catch { throw new Error("서버 응답을 확인할 수 없습니다. 잠시 후 다시 시도해주세요."); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("서버 응답을 확인할 수 없습니다. 잠시 후 다시 시도해주세요.");
  if (kind === "find-id" && (typeof data.username !== "string" || !data.username.trim() || data.username.length > 50)) throw new Error("아이디를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.");
  return data;
}

export function setupAccountPage(doc = document, win = window, fetcher = globalThis.fetch) {
  const form = doc.querySelector("#account-form");
  if (!form || !Object.hasOwn(formFields, form.dataset.form)) return;
  if (!isAccountTransportAllowed(win.location)) {
    form.reset();
    form.hidden = false;
    form.querySelector("fieldset").disabled = true;
    form.addEventListener("submit", (event) => event.preventDefault());
    doc.querySelector("#form-result").hidden = true;
    const summary = doc.querySelector("#form-summary");
    const link = doc.createElement("a");
    const page = form.dataset.form;
    link.href = `https://www.buteami.com/auth/${page}.html`;
    link.textContent = "HTTPS 보안 연결로 계속하기";
    summary.replaceChildren(doc.createTextNode(transportMessage), doc.createElement("br"), link);
    summary.hidden = false;
    summary.focus();
    win.addEventListener("pagehide", () => form.reset());
    return;
  }
  const allInputs = [...form.querySelectorAll("input")];
  const summary = doc.querySelector("#form-summary");
  const result = doc.querySelector("#form-result");
  const fieldset = form.querySelector("fieldset");
  const submit = form.querySelector('[type="submit"]');
  const retry = doc.querySelector("#try-again");
  const logout = doc.querySelector("#logout");
  const toggles = [...doc.querySelectorAll("[data-password]")];
  let touched = new Set();
  let pending = false;
  let sessionLookup = 0;
  let controller;
  const inputs = () => formFields[form.dataset.form].map((key) => doc.getElementById(key));
  const values = () => Object.fromEntries(inputs().map((input) => [input.id, ["password", "confirmPassword"].includes(input.id) ? input.value : input.value.trim()]));
  function showError(input, message) {
    const error = doc.getElementById(`${input.id}-error`);
    error.textContent = message || "";
    error.hidden = !message;
    if (message) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }
  function hidePasswords() {
    toggles.forEach((button) => {
      const input = doc.getElementById(button.dataset.password);
      input.type = "password";
      button.textContent = "보기";
      button.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-label", `${input.labels[0].textContent} 표시`);
    });
  }
  function clearSensitive() {
    allInputs.filter((input) => ["password", "confirmPassword"].includes(input.id)).forEach((input) => { input.value = ""; });
    hidePasswords();
  }
  function setPending(value) {
    pending = value;
    fieldset.disabled = value;
    form.setAttribute("aria-busy", String(value));
    submit.textContent = value ? "처리 중…" : submit.dataset.label;
  }
  function resetForm() {
    form.reset();
    hidePasswords();
    touched = new Set();
    allInputs.forEach((input) => showError(input));
    summary.hidden = true;
    summary.textContent = "";
    result.hidden = true;
    doc.getElementById("result-title").textContent = "";
    doc.getElementById("result-message").textContent = "";
    form.hidden = false;
    if (retry) retry.hidden = false;
    if (logout) logout.hidden = true;
  }
  function showResult(title, message, session = false) {
    clearSensitive();
    doc.getElementById("result-title").textContent = title;
    doc.getElementById("result-message").textContent = message;
    form.hidden = true;
    result.hidden = false;
    if (retry) retry.hidden = session;
    if (logout) logout.hidden = !session;
    result.focus();
  }
  function openHome(data) {
    if (!data.user || typeof data.user.username !== "string" || !data.user.username.trim()) throw new Error("로그인 상태를 확인하지 못했습니다. 페이지를 새로고침해주세요.");
    clearSensitive();
    win.location.replace("/");
  }
  submit.dataset.label = submit.textContent.trim().replace(/→$/, "").trim();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (pending) return;
    sessionLookup += 1;
    const kind = form.dataset.form;
    const data = values();
    const errors = validateAccountForm(kind, data);
    inputs().forEach((input) => { touched.add(input.id); showError(input, errors[input.id]); });
    const invalid = inputs().find((input) => errors[input.id]);
    if (invalid) {
      summary.textContent = `입력한 정보를 확인해주세요. 수정할 항목이 ${Object.keys(errors).length}개 있습니다.`;
      summary.hidden = false;
      invalid.focus();
      return;
    }
    summary.hidden = true;
    setPending(true);
    const requestController = controller = new AbortController();
    try {
      const response = await accountRequest(kind, data, fetcher, requestController.signal);
      if (requestController.signal.aborted) return;
      if (kind === "login") openHome(response);
      else if (kind === "signup" || kind === "reset-password") {
        clearSensitive();
        win.location.replace("/auth/login.html");
      }
      else if (kind === "find-id") showResult("아이디를 확인했어요", `가입한 아이디는 ${response.username}입니다.`);
    } catch (error) {
      if (requestController.signal.aborted) return;
      clearSensitive();
      summary.textContent = error instanceof TypeError ? unavailableMessage : error.message;
      summary.hidden = false;
      summary.focus();
    } finally { if (controller === requestController) setPending(false); }
  });
  allInputs.forEach((input) => {
    input.addEventListener("blur", () => {
      if (input.disabled) return;
      touched.add(input.id);
      showError(input, validateAccountForm(form.dataset.form, values())[input.id]);
    });
    input.addEventListener("input", () => {
      const errors = validateAccountForm(form.dataset.form, values());
      if (touched.has(input.id)) showError(input, errors[input.id]);
      if (input.id === "password" && touched.has("confirmPassword")) showError(doc.getElementById("confirmPassword"), errors.confirmPassword);
      summary.hidden = true;
    });
  });
  toggles.forEach((button) => button.addEventListener("click", () => {
    const input = doc.getElementById(button.dataset.password);
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    button.textContent = visible ? "숨기기" : "보기";
    button.setAttribute("aria-pressed", String(visible));
    button.setAttribute("aria-label", `${input.labels[0].textContent} ${visible ? "숨기기" : "표시"}`);
  }));
  retry?.addEventListener("click", () => { resetForm(); inputs()[0].focus(); });
  logout?.addEventListener("click", async () => {
    if (pending) return;
    pending = true;
    logout.disabled = true;
    try {
      await accountRequest("logout", {}, fetcher);
      resetForm();
      inputs()[0].focus();
    } catch {
      doc.getElementById("result-message").textContent = "로그아웃을 완료하지 못했습니다. 다시 시도해주세요.";
    } finally { pending = false; logout.disabled = false; }
  });
  win.addEventListener("pagehide", () => {
    sessionLookup += 1;
    controller?.abort();
    resetForm();
    setPending(false);
  });
  win.addEventListener("pageshow", (event) => { if (event.persisted) { resetForm(); if (form.dataset.form === "login") checkSession(); } });
  fieldset.disabled = false;
  const currentKeys = formFields[form.dataset.form];
  allInputs.forEach((input) => { input.disabled = !currentKeys.includes(input.id); });
  async function checkSession() {
    if (!isAccountTransportAllowed(win.location)) return;
    const version = ++sessionLookup;
    try {
      const response = await fetcher("/api/auth/me", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      if (version === sessionLookup && !pending) openHome(data);
    } catch { /* An unavailable session endpoint must leave login usable. */ }
  }
  if (form.dataset.form === "login") checkSession();
  fetcher("../version.json", { cache: "no-store" })
    .then((response) => response.ok ? response.json() : null)
    .then((version) => {
      if (!version || !/^[a-f0-9]{40}$/.test(version.commit)) return;
      const link = doc.createElement("a");
      link.href = `https://github.com/Undery33/Buteami/commit/${version.commit}`;
      link.textContent = `배포 버전 · ${version.commit.slice(0, 7)} ↗`;
      link.target = "_blank"; link.rel = "noopener noreferrer";
      link.setAttribute("aria-label", `배포 커밋 ${version.commit.slice(0, 7)} 확인 (새 탭)`);
      doc.querySelector("#release-info").replaceChildren(link);
    }).catch(() => {});
}

if (typeof document !== "undefined") setupAccountPage();
