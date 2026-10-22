import { PublicError } from './security.js';

export function validateInput(kind, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new PublicError(400, '입력한 정보를 확인해주세요.');
  const text = key => typeof data[key] === 'string' ? data[key].trim() : '';
  const result = { username: text('username'), fullName: text('fullName'), email: text('email').toLowerCase(), birthday: text('birthday'),
    password: typeof data.password === 'string' ? data.password : '' };
  const invalid = () => { throw new PublicError(400, '입력한 정보를 확인해주세요.'); };
  if (['signup', 'login', 'reset-password'].includes(kind) && !/^[A-Za-z0-9_]{4,20}$/.test(result.username)) invalid();
  if (['signup', 'find-id', 'reset-password'].includes(kind) && (!result.fullName || result.fullName.length > 50 || /[\x00-\x1f]/.test(result.fullName))) invalid();
  if (['signup', 'find-id', 'reset-password'].includes(kind) &&
      (result.email.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(result.email))) invalid();
  if (['signup', 'login', 'reset-password'].includes(kind) && (!result.password.trim() || result.password.length > 128 ||
      (kind !== 'login' && (result.password.length < 6 || data.confirmPassword !== result.password)))) invalid();
  if (kind === 'signup') {
    const date = new Date(`${result.birthday}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(result.birthday) || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== result.birthday ||
        result.birthday < '1900-01-01' || result.birthday > new Date().toISOString().slice(0, 10)) invalid();
  }
  return result;
}
