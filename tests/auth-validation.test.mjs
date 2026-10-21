import test from "node:test";
import assert from "node:assert/strict";
import { formFields, validateAccountForm } from "../assets/auth-validation.js";
const valid = {
  fullName: "테스트 사용자",
  username: "demo_user",
  email: "demo@example.com",
  password: "preview-pass-2026",
  confirmPassword: "preview-pass-2026",
};

test("all four flows accept their valid preview inputs without mutating them", () => {
  for (const kind of Object.keys(formFields)) {
    const input = Object.freeze({ ...valid });
    assert.deepEqual(validateAccountForm(kind, input), {});
  }
});
test("empty and whitespace fields are rejected before a result can be shown", () => {
  for (const [kind, keys] of Object.entries(formFields)) {
    assert.equal(
      Object.keys(validateAccountForm(kind, {})).length,
      keys.length,
    );
    assert.ok(
      validateAccountForm(
        kind,
        Object.fromEntries(keys.map((k) => [k, "   "])),
      )[keys[0]],
    );
  }
});
test("registration password boundaries and confirmation preserve exact input", () => {
  for (const length of [12, 128])
    assert.deepEqual(
      validateAccountForm("signup", {
        ...valid,
        password: "a".repeat(length),
        confirmPassword: "a".repeat(length),
      }),
      {},
    );
  for (const length of [11, 129])
    assert.ok(
      validateAccountForm("signup", {
        ...valid,
        password: "a".repeat(length),
        confirmPassword: "a".repeat(length),
      }).password,
    );
  assert.ok(
    validateAccountForm("signup", {
      ...valid,
      confirmPassword: valid.password + " ",
    }).confirmPassword,
  );
  assert.ok(
    validateAccountForm("signup", {
      ...valid,
      password: " ".repeat(12),
      confirmPassword: " ".repeat(12),
    }).password,
  );
});
test("login does not impose new registration length on an existing password", () => {
  assert.deepEqual(
    validateAccountForm("login", { ...valid, password: "oldpass" }),
    {},
  );
});
test("invalid email and identifier shapes fail, valid boundaries pass", () => {
  for (const email of [
    "demo",
    "demo@",
    "a b@example.com",
    "a@@example.com",
    "a@example",
  ])
    assert.ok(validateAccountForm("find-id", { ...valid, email }).email);
  for (const username of [
    "abc",
    "a".repeat(21),
    "한글아이디",
    "user name",
    "<script>",
  ])
    assert.ok(validateAccountForm("login", { ...valid, username }).username);
  for (const username of ["abcd", "a".repeat(20)])
    assert.deepEqual(validateAccountForm("login", { ...valid, username }), {});
});
test("unsupported routes fail closed and messages never echo submitted values", () => {
  assert.throws(() => validateAccountForm("unknown", valid));
  assert.throws(() => validateAccountForm("__proto__", valid));
  assert.ok(
    !JSON.stringify(
      validateAccountForm("signup", {
        ...valid,
        email: "<script>alert(1)</script>",
      }),
    ).includes("<script>"),
  );
});
