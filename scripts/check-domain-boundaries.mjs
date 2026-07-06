#!/usr/bin/env node
/**
 * DDD fitness function (Phase 0). Fails if industry-specific literals leak into
 * core domain code — the domains must stay industry-agnostic (industry lives in
 * data/config only). Add each extracted core domain dir to CORE_DIRS as it lands
 * (events → billing → membership → booking → order → resource).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CORE_DIRS = ["src/events", "src/billing", "src/membership", "src/resource", "src/booking", "src/order", "src/analytics", "src/notification"]; // grows as domains are extracted
const FORBIDDEN = /\b(cleaning|restaurant|rental|vehicle|beach|court|massage|yacht|coworking|desk|healthcare)\b/i;

function walk(dir) {
  let files = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) files = files.concat(walk(p));
    // `.acl.ts` = Anti-Corruption Layers — the legitimate boundary translators
    // that DO name legacy/industry tables. Everything else must stay agnostic.
    else if (/\.ts$/.test(p) && !/\.spec\.ts$/.test(p) && !/\.acl\.ts$/.test(p)) files.push(p);
  }
  return files;
}

const violations = [];
for (const dir of CORE_DIRS) {
  let files = [];
  try { files = walk(dir); } catch { continue; }
  for (const file of files) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      // ignore comments — they may legitimately give examples
      const code = line.replace(/\/\/.*$/, "");
      if (FORBIDDEN.test(code)) violations.push(`${file}:${i + 1}  ${line.trim()}`);
    });
  }
}

if (violations.length) {
  console.error("✗ Domain boundary violations — industry literals in core code:\n");
  violations.forEach((v) => console.error("  " + v));
  console.error("\nCore domains must be industry-agnostic. Move industry specifics into resource metadata / config.");
  process.exit(1);
}
console.log(`✓ Domain boundaries clean (${CORE_DIRS.join(", ")}).`);
