// Client feedback only: the API independently validates every field.
export const formFields = {
  login: ["username", "password"],
  "find-id": ["fullName", "email"],
  "request-password-reset": ["username", "email"],
  "reset-password": ["token", "password", "confirmPassword"],
  "verify-email": ["token"],
  "resend-verification": ["username", "email"],
  signup: ["fullName", "username", "birthday", "email", "password", "confirmPassword"],
};

export function validateAccountForm(kind, values, today = new Date()) {
  if (!Object.hasOwn(formFields, kind)) throw new Error("Unknown account form");
  const errors = {};
  for (const key of formFields[kind]) {
    const value = String(values[key] ?? "");
    const trimmed = value.trim();
    if (key === "fullName" && (!trimmed || trimmed.length > 50)) errors[key] = "이름을 1~50자로 입력해주세요.";
    if (key === "username" && !/^[A-Za-z0-9_]{4,20}$/.test(trimmed)) errors[key] = "아이디는 영문, 숫자, 밑줄(_) 4~20자로 입력해주세요.";
    if (key === "email" && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) || trimmed.length > 254)) errors[key] = "올바른 이메일 주소를 입력해주세요.";
    if (key === "birthday") {
      const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;
      const localToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value < "1900-01-01" || value > localToday) errors[key] = "1900년 이후의 올바른 생년월일을 입력해주세요. 미래 날짜는 사용할 수 없습니다.";
    }
    if (key === "password") {
      if (!trimmed) errors[key] = "비밀번호를 입력해주세요.";
      else if (value.length > 128 || (kind !== "login" && value.length < 6)) errors[key] = kind === "login" ? "비밀번호는 128자 이내로 입력해주세요." : "비밀번호를 6~128자로 입력해주세요.";
    }
    if (key === "confirmPassword") {
      if (!value) errors[key] = "비밀번호를 한 번 더 입력해주세요.";
      else if (value !== values.password) errors[key] = "비밀번호가 일치하지 않습니다.";
    }
    if (key === "token" && !/^[A-Za-z0-9_-]{43}$/.test(trimmed)) errors[key] = "이메일에 포함된 인증 코드를 그대로 붙여넣어주세요.";
  }
  return errors;
}
