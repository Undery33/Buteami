import test from "node:test";
import assert from "node:assert/strict";
import { formFields, validateAccountForm } from "../assets/auth-validation.js";
const valid = {
  fullName: "테스트 사용자", username: "demo_user", birthday: "2000-02-29",
  email: "demo@example.com", password: "new-password-2026", confirmPassword: "new-password-2026",
};

test("all account actions accept valid inputs without mutating them", () => {
  for (const kind of Object.keys(formFields)) assert.deepEqual(validateAccountForm(kind, Object.freeze({ ...valid })), {});
});
test("all required empty and whitespace inputs are rejected", () => {
  for (const [kind, keys] of Object.entries(formFields)) {
    assert.equal(Object.keys(validateAccountForm(kind, {})).length, keys.length);
    assert.ok(validateAccountForm(kind, Object.fromEntries(keys.map((key) => [key, "   "])))[keys[0]]);
  }
});
test("signup and reset enforce new password boundaries and preserve exact confirmation", () => {
  for (const kind of ['signup','reset-password']) {
    for (const length of [6, 128]) assert.deepEqual(validateAccountForm(kind, { ...valid, password: 'a'.repeat(length), confirmPassword: 'a'.repeat(length) }), {});
    for (const length of [5, 129]) assert.ok(validateAccountForm(kind, { ...valid, password: 'a'.repeat(length), confirmPassword: 'a'.repeat(length) }).password);
    assert.ok(validateAccountForm(kind, { ...valid, confirmPassword: valid.password + ' ' }).confirmPassword);
    assert.ok(validateAccountForm(kind, { ...valid, password: ' '.repeat(6), confirmPassword: ' '.repeat(6) }).password);
  }
  assert.deepEqual(validateAccountForm('login', { ...valid, password: 'a' }), {});
});
test("birthday rejects impossible, future and out-of-range dates, accepts leap days", () => {
  const today = new Date('2026-10-22T12:00:00');
  for (const birthday of ['2025-02-29','2026-02-30','2026-13-01','2026-10-23','1899-12-31','2000-1-01','invalid']) assert.ok(validateAccountForm('signup', { ...valid, birthday }, today).birthday, birthday);
  for (const birthday of ['1900-01-01','2000-02-29','2026-10-22']) assert.deepEqual(validateAccountForm('signup', { ...valid, birthday }, today), {});
});
test("invalid email and identifier shapes fail without echoing input", () => {
  for (const email of ['demo','demo@','a b@example.com','a@@example.com','a@example']) assert.ok(validateAccountForm('find-id', { ...valid, email }).email);
  for (const username of ['abc','a'.repeat(21),'한글아이디','user name','<script>']) assert.ok(validateAccountForm('login', { ...valid, username }).username);
  for (const username of ['abcd','a'.repeat(20)]) assert.deepEqual(validateAccountForm('login', { ...valid, username }), {});
  assert.throws(() => validateAccountForm('unknown', valid));
  assert.throws(() => validateAccountForm('__proto__', valid));
  assert.ok(!JSON.stringify(validateAccountForm('signup', { ...valid, email: '<script>alert(1)</script>' })).includes('<script>'));
});
