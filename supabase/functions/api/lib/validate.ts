import { HttpError } from "./http.ts";

/**
 * Minimal stand-in for Nest's ValidationPipe (whitelist + forbidNonWhitelisted):
 * the same 400 shape, `message` as an array of sentences, unknown keys refused.
 */
export type Rule =
  | { type: "string"; min?: number; max?: number; optional?: boolean; email?: boolean }
  | { type: "boolean"; optional?: boolean };

export function validate<T>(body: unknown, rules: Record<string, Rule>): T {
  const errors: string[] = [];
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!(key in rules)) errors.push(`property ${key} should not exist`);
  }
  for (const [key, rule] of Object.entries(rules)) {
    const v = input[key];
    if (v === undefined || v === null) {
      if (!rule.optional) errors.push(`${key} should not be empty`);
      continue;
    }
    if (rule.type === "boolean") {
      if (typeof v !== "boolean") errors.push(`${key} must be a boolean value`);
      continue;
    }
    if (typeof v !== "string") { errors.push(`${key} must be a string`); continue; }
    if (rule.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) errors.push(`${key} must be an email`);
    if (rule.min !== undefined && v.length < rule.min) errors.push(`${key} must be longer than or equal to ${rule.min} characters`);
    if (rule.max !== undefined && v.length > rule.max) errors.push(`${key} must be shorter than or equal to ${rule.max} characters`);
  }
  if (errors.length) throw Object.assign(new HttpError(400, errors.join(", ")), { details: errors });
  return input as T;
}
