// Versioned audit records for the workflow-pack guardrail
// (docs/DESIGN-v0.3.md §3.5). Private append handling; no credentials, no
// tool-result payloads, structured fingerprints over raw command text.
//
// The adapter injects appendFile; this module stays pure otherwise.

import { createHash } from "node:crypto";

export const AUDIT_SCHEMA_VERSION = 1;

/** Stable short fingerprint of a command string (never the raw text). */
export function fingerprint(text) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
}

/**
 * Normalize one audit event to the versioned schema. Missing fields become
 * explicit nulls so every row has the same shape (a denominator for
 * graduation reports). Never includes credentials or tool-result payloads.
 */
export function auditRow(event) {
  const e = event || {};
  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    ts: e.ts || new Date().toISOString(),
    mode: e.mode || null,                    // 'shadow' | 'enforce'
    sessionId: e.sessionId || null,
    toolCallId: e.toolCallId || null,
    decisionId: e.decisionId || null,
    adapter: e.adapter || null,              // harness/adapter identification
    packVersion: e.packVersion || null,
    policyVersion: e.policyVersion || null,
    tool: e.tool || null,
    fingerprint: e.command !== undefined ? fingerprint(e.command) : null,
    ruleIds: Array.isArray(e.ruleIds) ? e.ruleIds : [],
    failureClass: e.failureClass || null,
    targetConfidence: e.targetConfidence || null,
    state: e.state || null,                  // configured state for the scope
    action: e.action || null,                // allow | soft-deny | hard-deny | ownership-hold | ...
    reasonCode: e.reasonCode || null,
    alternativeRef: e.alternativeRef || null, // reference to the sourced alternative, not a payload
    targetRef: e.targetRef || null,          // private target reference (bounded)
    discoveryDigest: e.discoveryDigest || null, // digest of the discovery evidence used
    gateRef: e.gateRef || null,              // reference to the required confirmation gate
    override: e.override || null,            // request|approved|consumed|expired|cancelled events
    outcome: e.outcome || null,              // attempted|allowed|started|completed|blocked
    notes: typeof e.notes === "string" ? e.notes.slice(0, 200) : null,
  };
}

/**
 * Append one normalized event to the private sink. The adapter injects
 * appendFile (Node fs promise API shape). Returns the row written.
 * Audit failure is the CALLER's policy decision (shadow: visible but
 * non-blocking; enforce: prevents mutating allows) — this module only
 * reports success/failure.
 */
export async function appendEvent(sinkPath, event, { appendFile, mkdir, stateDir }) {
  const row = auditRow(event);
  if (typeof appendFile !== "function") {
    return { ok: false, row, reason: "no injected appendFile" };
  }
  try {
    if (typeof mkdir === "function" && stateDir) {
      // explicit private-directory mode; the caller's umask cannot widen it
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
    }
    // mode 0600 applies at file creation; an ALREADY-permissive sink file is
    // not repaired here — deployment owns the initial sink permissions
    await appendFile(sinkPath, JSON.stringify(row) + "\n", { mode: 0o600 });
    return { ok: true, row };
  } catch (err) {
    return { ok: false, row, reason: err && err.message ? err.message.slice(0, 120) : "append failed" };
  }
}
