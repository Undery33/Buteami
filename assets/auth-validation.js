// UI-only constraints. The future authentication API remains the source of truth.
export const formFields = {
  login: ["username", "password"],
  "find-id": ["fullName", "email"],
  "reset-password": ["username", "email"],
  signup: ["fullName", "username", "email", "password", "confirmPassword"],
};

export function validateAccountForm(kind, values) {
  if (!Object.hasOwn(formFields, kind)) throw new Error("Unknown account form");
  const errors = {};
  for (const key of formFields[kind]) {
    const value = String(values[key] ?? "");
    const trimmed = value.trim();
    if (key === "fullName" && (!trimmed || trimmed.length > 50)) {
      errors[key] = "이름을 1~50자로 입력해주세요.";
    }
    if (key === "username" && !/^[A-Za-z0-9_]{4,20}$/.test(trimmed)) {
      errors[key] = "아이디는 영문, 숫자, 밑줄(_) 4~20자로 입력해주세요.";
    }
    if (
      key === "email" &&
      (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) || trimmed.length > 254)
    ) {
      errors[key] = "올바른 이메일 주소를 입력해주세요.";
    }
    if (key === "password") {
      if (!trimmed) errors[key] = "비밀번호를 입력해주세요.";
      else if (value.length > 128 || (kind === "signup" && value.length < 12)) {
        errors[key] =
          kind === "signup"
            ? "비밀번호를 12~128자로 입력해주세요."
            : "비밀번호는 128자 이내로 입력해주세요.";
      }
    }
    if (key === "confirmPassword") {
      if (!value) errors[key] = "비밀번호를 한 번 더 입력해주세요.";
      else if (value !== values.password)
        errors[key] = "비밀번호가 일치하지 않습니다.";
    }
  }
  return errors;
}
