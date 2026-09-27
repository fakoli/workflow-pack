#!/usr/bin/env node
// Feedback loop: summarize the shadow-guardrail audit log into pack-update
// notes. Read-only; stdlib-only.
//
//   node scripts/feedback.mjs [audit.jsonl]
//
// The audit log (default ~/.local/state/workflow-pack/audit.jsonl) records
// raw lifecycle commands the guardrail observed in shadow mode. This script
// summarizes them by matched failure class and samples commands, so the
// operator can compile them into pack updates (new trigger phrases, lint
// rules) — the feedback loop from docs/ROADMAP.md item 3.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const auditPath = process.argv[2] || join(homedir(), ".local/state/workflow-pack/audit.jsonl");
if (!existsSync(auditPath)) {
  console.log(`feedback: no audit log at ${auditPath} — nothing observed yet`);
  process.exit(0);
}

const rows = [];
for (const line of readFileSync(auditPath, "utf8").split("\n")) {
  const s = line.trim();
  if (!s) continue;
  try {
    rows.push(JSON.parse(s));
  } catch {
    console.error(`feedback: skipping malformed row`);
  }
}

if (!rows.length) {
  console.log("feedback: audit log is empty");
  process.exit(0);
}

const byMatched = new Map();
for (const r of rows) {
  for (const m of r.matched || []) {
    byMatched.set(m, (byMatched.get(m) || 0) + 1);
  }
}

console.log(`feedback: ${rows.length} observed raw-lifecycle event(s) in ${auditPath}`);
console.log("");
console.log("## By matched pattern");
for (const [m, n] of [...byMatched.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`- ${m}: ${n}`);
}
console.log("");
console.log("## Sample commands (most recent 5)");
for (const r of rows.slice(-5)) {
  console.log(`- [${r.ts}] ${r.command}`);
}
console.log("");
console.log("## Suggested pack updates (manual review)");
console.log("- Consider whether observed commands map to a managed verb family;");
console.log("  if not, add trigger phrases or failure classes to pack/workflow-pack.v1.json.");
console.log("- Repeated raw usage of a covered target is a lint-rule candidate.");
