# Roadmap

Ordered by dependency, not priority. Every item stays repo-structure-
independent and preserves existing preview, confirmation, and human gates.
Enforcement work never introduces a model-writable bypass.

## Shipped (v0.1.0)

- Seek-first heuristic compiled from the manifest into the global `AGENTS.md`.
- `managed-operations` discovery skill (Agent Skills standard, progressive
  disclosure).
- Cold-session fixtures with a transcript-level runner (executed tool calls
  evaluated separately from assistant text).
- Coverage lint: manifest schema/types/cardinality, word-boundary trigger
  coverage, dist freshness, fixture well-formedness, installed-target drift.

## Next

### 1. Bounded discovery tool (read-only)

A harness extension projecting the owning product's command manifest as a
small tool/context packet instead of a free-text catalog:

- Input: task, optional resource, requested evidence category.
- Output: a few relevant operations/documents, stable IDs, owner,
  applicability, provenance, installed version, and unresolved questions.
- Source: the product's existing machine-readable registry (for example
  `anvil-serving --command-manifest`), never a second hand-maintained catalog.
- Exact matching, aliases, and lexical search first; embeddings later.
- Traceable retrieval: record what was considered, selected, and omitted.

### 2. Shadow-mode guardrail

- Observe raw lifecycle commands first; log decisions without blocking.
- Then soft-deny: raw lifecycle commands when a managed verb family covers
  the target — the deny reason names the managed alternative and its gate.
- Hard-deny only destructive/irreversible operations.
- Human-mediated one-shot override; never a model-writable marker.
- JSONL audit of every decision and override; self-protection against
  disabling the guardrail.

### 3. Feedback loop

- Detected improvisation events and guardrail denials → failure memory.
- Periodically compile them into pack updates, new trigger phrases, and new
  lint rules. Treat the pack as a feedback loop, not a static config.

### 4. Fixture isolation

- Run regression sessions in an isolated environment (container or synthetic
  CLI/service state) with no production authority, so an implementation
  regression cannot affect the host under test.
- Keep this test isolation separate from any production guardrail.

### 5. Coverage-lint expansion

- Declare family-to-skill and fixture-to-manifest relationships and lint
  them.
- Deterministic lint failure tests.
- Behavioral trigger evaluation (does the description fire on realistic
  prompts?) as a scored eval across models, not just lexical coverage.

### 6. More runtimes

- The same manifest can drive Claude Code / Codex / OpenCode adapters
  (skills dirs, hooks, rules). One manifest, many runtimes — the pack is the
  asset, not any single harness integration.
