export class ApiError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}
export function check(condition, code, status = 409) { if (!condition) throw new ApiError(code, status); }
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function key(value, code = 'INVALID_ID') {
  check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value), code, 400);
  return value;
}
