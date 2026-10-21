import { formFields, validateAccountForm } from "./auth-validation.js";

const form = document.querySelector("#account-form");
const kind = form.dataset.form;
const inputs = formFields[kind].map((key) => document.getElementById(key));
const summary = document.querySelector("#form-summary");
const result = document.querySelector("#form-result");
const touched = new Set();
const toggles = [...document.querySelectorAll("[data-password]")];

function values() {
  return Object.fromEntries(inputs.map((input) => [input.id, input.value]));
}
function showError(input, message) {
  const error = document.getElementById(`${input.id}-error`);
  error.textContent = message || "";
  error.hidden = !message;
  if (message) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}
function hidePasswords() {
  toggles.forEach((button) => {
    const input = document.getElementById(button.dataset.password);
    input.type = "password";
    button.textContent = "보기";
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-label", `${input.labels[0].textContent} 표시`);
  });
}
function resetPreview() {
  form.reset();
  hidePasswords();
  touched.clear();
  inputs.forEach((input) => showError(input));
  summary.hidden = true;
  summary.textContent = "";
  result.hidden = true;
  form.hidden = false;
}

// Attach the submit guard before enabling any field. No request or persistence occurs.
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const errors = validateAccountForm(kind, values());
  inputs.forEach((input) => {
    touched.add(input.id);
    showError(input, errors[input.id]);
  });
  const invalid = inputs.find((input) => errors[input.id]);
  if (invalid) {
    summary.textContent = `입력한 정보를 확인해주세요. 수정할 항목이 ${Object.keys(errors).length}개 있습니다.`;
    summary.hidden = false;
    invalid.focus();
    return;
  }
  resetPreview();
  form.hidden = true;
  result.hidden = false;
  result.focus();
});
inputs.forEach((input) => {
  input.addEventListener("blur", () => {
    touched.add(input.id);
    showError(input, validateAccountForm(kind, values())[input.id]);
  });
  input.addEventListener("input", () => {
    const errors = validateAccountForm(kind, values());
    if (touched.has(input.id)) showError(input, errors[input.id]);
    if (input.id === "password" && touched.has("confirmPassword")) {
      showError(
        document.getElementById("confirmPassword"),
        errors.confirmPassword,
      );
    }
    // Avoid leaving an out-of-date error count while the user corrects fields.
    summary.hidden = true;
  });
});
toggles.forEach((button) =>
  button.addEventListener("click", () => {
    const input = document.getElementById(button.dataset.password);
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    button.textContent = visible ? "숨기기" : "보기";
    button.setAttribute("aria-pressed", String(visible));
    button.setAttribute(
      "aria-label",
      `${input.labels[0].textContent} ${visible ? "숨기기" : "표시"}`,
    );
  }),
);
document.querySelector("#try-again").addEventListener("click", () => {
  resetPreview();
  inputs[0].focus();
});
// Clear preview values on navigation, including back/forward cache restoration.
window.addEventListener("pagehide", resetPreview);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) resetPreview();
});
form.querySelector("fieldset").disabled = false;

// Build metadata only; never include form data in this request.
fetch("../version.json", { cache: "no-store" })
  .then((response) => (response.ok ? response.json() : null))
  .then((version) => {
    if (!version || !/^[a-f0-9]{40}$/.test(version.commit)) return;
    const link = document.createElement("a");
    link.href = `https://github.com/Undery33/Buteami/commit/${version.commit}`;
    link.textContent = `배포 버전 · ${version.commit.slice(0, 7)} ↗`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute(
      "aria-label",
      `배포 커밋 ${version.commit.slice(0, 7)} 확인 (새 탭)`,
    );
    document.querySelector("#release-info").replaceChildren(link);
  })
  .catch(() => {
    /* Preserve the preview label if build metadata is unavailable. */
  });
