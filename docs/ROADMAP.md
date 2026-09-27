# Roadmap

Ordered by dependency, not priority. Every item stays repo-structure-
independent and preserves existing preview, confirmation, and human gates.
Enforcement work never introduces a model-writable bypass.

The v0.3 design for the remaining items — evidence-gated operational
 guardrails, constructed with adversarial review — lives in
[docs/DESIGN-v0.3.md](DESIGN-v0.3.md). Its sequencing step 1 (evidence
foundation: evaluator activity requirement, runner fail-closed metadata,
installer exact marker grammar + ancestor-symlink refusal) shipped with the
design.

## Shipped

### v0.3.0 — Milestone 1: shared contract (design sequencing step 2)

- `lib/guardrail.mjs` — pure command classification (supported /
  non-lifecycle / uncertain, read-executable and read-verb negatives,
  indirection and expansion detection), target-confidence levels, and the
  §3.3 decision matrix. No I/O; execution, audit, and human confirmation
  are supplied by the adapter.
- `lib/discovery.mjs` — bounded registry projection through an injected
  execution interface; schema, status, and size validated before a response
  may be used for a denial.
- `lib/audit.mjs` — versioned audit schema (v1) with fingerprints over raw
  text and injected append handling.
- Manifest: `policy.contract_version`, `policy.default_mode: shadow`,
  `policy.rules[]` (stable IDs, severity, eligibility), argv arrays,
  `registry_contract`, `ownership_contract`.
- Deterministic pure tests: `node fixtures/test-lib.mjs` (146 checks,
  including the adversarial regression corpus from five Astra review
  rounds: executing substitutions, compound hard-rule ordering,
  operation-bound ownership evidence, integrity holds, object-shaped
  registry validation).
- Installer installs `lib/` alongside the extension; lint checks lib-asset
  drift.

### v0.1.x

- Seek-first heuristic compiled from the manifest into the global `AGENTS.md`.
- `managed-operations` discovery skill (Agent Skills standard, progressive
  disclosure).
- Cold-session fixtures with a transcript-level runner (executed tool inputs
  evaluated separately from finalized assistant text).
- Coverage lint: manifest schema/types/cardinality, word-boundary trigger
  coverage, dist freshness, fixture well-formedness, installed-target drift.
- Full regression evidence: 4/4 fixtures PASS in a single run
  (see [docs/STATUS.md](STATUS.md)).

### v0.2.0

- **Bounded discovery tool (read-only)** — `extensions/pi-workflow-pack`
  registers an `ops_discover` tool that projects the matching verb family's
  machine-readable command manifest (mutation class, confirmation gates,
  docs anchors) from the registry. Runs only the registry's registered
  discovery commands, bounded output, no second catalog.
- **Shadow-mode guardrail** — observes bash tool calls matching raw
  lifecycle patterns and appends JSONL audit rows; never blocks or mutates
  in shadow mode.
- **Feedback loop** — `scripts/feedback.mjs` summarizes the audit log into
  pack-update notes.
- **Installer exercised** — `test-install.sh` runs `install.sh` against a
  temporary HOME: fresh install, idempotent re-run, malformed-marker refusal
  without mutation, symlink refusal.
- **Fixture real-host gating** — cases declare `real_host`; the runner skips
  them unless `--allow-real-host`.
- **Fixture-to-family relationships** — `expect.json.family` validated
  against manifest `verb_families` by the lint; installed-extension drift
  checked by `lint --installed`.
- **Role/event-aware evaluator** with deterministic synthetic tests
  (`fixtures/test-evaluator.sh`) and transcript replay.

## Next

Sequencing follows `docs/DESIGN-v0.3.md` (§Sequencing): fixture isolation
and the behavioral baseline come BEFORE Pi enforcement.

### 1. Fixture isolation (sandboxed runner)

- Run regression sessions in an isolated environment (container or synthetic
  CLI/service state) with no production authority, so an implementation
  regression cannot affect the host under test. Real-host gating (shipped)
  is the interim safeguard.
- Keep this test isolation separate from any production guardrail.

### 2. Behavioral trigger baseline

- Score whether skill descriptions actually fire on realistic prompts,
  across models — not just lexical coverage.
- Pin the model alias in fixture runs for reproducibility (the runner
  records the pi version, not the underlying model).

### 3. Enforce-mode guardrail (soft-deny tiers)

- Soft-deny: raw lifecycle commands when a managed verb family covers the
  target — the deny reason names the managed alternative and its gate.
- Hard-deny only destructive/irreversible operations.
- Human-mediated one-shot override; never a model-writable marker.
- JSONL audit of every decision and override; self-protection against
  disabling the guardrail.

### 4. More runtimes

- The same manifest can drive Claude Code / Codex / OpenCode adapters
  (skills dirs, hooks, rules). One manifest, many runtimes — the pack is the
  asset, not any single harness integration.
