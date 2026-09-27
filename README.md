# workflow-pack

Repo-structure-independent discovery of managed operational commands for
coding agents. One manifest, many runtimes.

Agents improvise `kill` / `nohup` / raw Docker for service lifecycle when the
managed CLI exists but nothing in the agent's always-in-context layer says to
look for it. This pack closes that gap with three layers compiled from — or
checked against — one declarative manifest:

1. **Seek-first line** — a small (~90-word) heuristic compiled into the
   global `AGENTS.md` (always in context, where the failure happened).
2. **Discovery skill** — an Agent-Skills-standard skill (`managed-operations`)
   whose description triggers on operational questions ("what command do I
   run to restart…") and whose body is a decision procedure
   (discover → select → act → no-verb-found), loaded on demand.
3. **Fixtures + lint** — cold-session prompt fixtures that replay the
   triggering incident as a regression test, and a coverage lint that fails
   when skill descriptions stop covering the manifest's trigger phrases.

v0.2.0 adds two read-only harness surfaces over the same manifest: an
**`ops_discover` tool** (bounded projection of the owning product's command
manifest) and a **shadow-mode guardrail** (observes raw lifecycle commands,
appends JSONL audit rows, never blocks), plus a feedback-loop summarizer.

## Why not just write the line by hand?

Hand-written prose is exactly what drifts. The manifest is the single source
of truth: `scripts/build.mjs` compiles the AGENTS.md block from it, and
`lint/check.mjs` fails when skills, compiled artifacts, fixtures, or
installed targets drift. (Compile-step pattern: Agent OS profiles.
Coverage-gate pattern: agent-config linters — which, as far as we could
find, do not check trigger-description coverage against a command-surface
index, the failure class that caused the original incident.)

## Layout

```
pack/workflow-pack.v1.json   the manifest (single source of truth)
lib/guardrail.mjs            pure classification + target confidence + decision matrix
lib/discovery.mjs            registry projection through an injected execution interface
lib/audit.mjs                versioned audit records (schema v1)
skills/managed-operations/   the discovery skill (Agent Skills standard)
extensions/pi-workflow-pack/ pi extension: ops_discover tool + shadow guardrail
scripts/build.mjs            compiles dist/ artifacts from the manifest
scripts/feedback.mjs         summarizes the shadow-guardrail audit log
lint/check.mjs               coverage lint (repo + --installed targets)
install.sh                   idempotent install into harness dirs
fixtures/                    cold-session regression cases + runner + evaluator
fixtures/test-lib.mjs        deterministic pure-contract tests (no agent)
test-install.sh              exercises install.sh against a temp HOME
```

## Prerequisites

- Node.js 20+ (build + lint), bash, python3 (installer + runner).
- [pi](https://github.com/badlogic/pi-mono) for the discovery skill to be
  picked up (Agent Skills standard: `~/.agents/skills/`) and for fixtures.
- On a fresh clone, run `node scripts/build.mjs` before
  `node lint/check.mjs` (the lint checks dist freshness).

## Install

```bash
./install.sh                          # skill -> ~/.agents/skills/, extension -> ~/.pi/agent/extensions/, seek-first -> ~/.pi/agent/AGENTS.md
node lint/check.mjs --installed       # verify installed targets match the repo
./test-install.sh                     # exercise the installer against a temp HOME
```

`install.sh` backs up `~/.pi/agent/AGENTS.md` and any existing skill to
`.backups/<stamp>/` (mode 0700) before writing, refuses symlinked targets,
and upserts a marker-delimited block — re-running is safe, and malformed
marker structures abort without mutation.

## Uninstall

```bash
rm -rf ~/.agents/skills/managed-operations
# then delete the marker-delimited block from ~/.pi/agent/AGENTS.md
# (between the "workflow-pack:seek-first begin/end" comments)
```

## Shadow guardrail + feedback loop

The extension observes bash tool calls matching raw lifecycle patterns
(`kill`, `pkill`, `nohup`, `systemctl start/stop/restart`, `docker
kill/restart/stop`, …) and appends JSONL rows to
`~/.local/state/workflow-pack/audit.jsonl`. **Shadow mode never blocks and
never mutates input** — enforcement (soft-deny tiers with human-approved
override) is roadmap item 1. Summarize observations into pack-update notes:

```bash
node scripts/feedback.mjs
```

## Fixtures

```bash
./fixtures/run.sh --list              # list cases
./fixtures/run.sh                     # run all (spawns real ephemeral agent sessions)
./fixtures/run.sh 01-restart-pi-web-cold
```

See `fixtures/README.md` for the case format and limitations. Each case costs
a full agent session — run with intent. The runner captures the full event
transcript (`--mode json`) and evaluates executed tool calls separately from
assistant text, so a PASS attests what the agent did, not just what it said.
Fixtures run with the host's real tools (no sandbox) — see the isolation
warning in `fixtures/run.sh`.

## Lint

```bash
node lint/check.mjs              # manifest schema/types/cardinality, skill
                                 # frontmatter, word-boundary trigger coverage,
                                 # dist freshness, fixture well-formedness
node lint/check.mjs --installed  # + installed skill/AGENTS.md marker drift
```

Exit 1 with findings; CI-able. This is lexical coverage checking, not
behavioral validation — skill triggering remains model- and
harness-dependent (pi's own docs note models do not always load matching
skills).

## Manifest format (workflow-pack/v1)

- `seek_first` — the always-in-context heuristic, compiled into AGENTS.md.
- `skills[]` — skills shipped in the pack and their install targets.
- `verb_families[]` — per product CLI: discovery command, machine-readable
  manifest command, trigger phrases (must be covered by skill descriptions),
  failure classes, and sourced example invocations.
- `policy` — inert reserved metadata for the enforcement layer (out of scope
  for v0.1; no runtime consumes it yet).

## Status

Regression evidence complete (v0.1.1, 2026-09-26): all four cold-session
fixtures PASS in a single run with transcript-level verdicts — see
[docs/STATUS.md](docs/STATUS.md). Evidence includes executed-tool-call
analysis: the incident case ran only discovery commands and proposed the
managed verbs; the conflict case resolved in favor of the managed CLI,
citing the seek-first line.

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md) for the full ordered roadmap. Headlines:

- **Bounded discovery tool (read-only)** — project the owning product's
  command manifest (mutation class, confirmation gates, docs anchors) as a
  small tool/context packet, over the existing registry rather than a new
  free-text catalog.
- **Shadow-mode guardrail** — observe first; then soft-deny with the managed
  alternative named in the deny reason; hard-deny only destructive
  operations; human-mediated one-shot override (never a model-writable
  marker); JSONL audit.
- **Feedback loop** — improvisation events and denials → failure memory →
  pack and lint updates.
- **Fixture isolation** — sandboxed regression environment with no
  production authority.
- **More runtimes** — the same manifest driving Claude Code / Codex /
  OpenCode adapters.

## Provenance

Designed from a four-model consult (GPT-6 Astra + three web-researched
candidates, 2026-09-26) that converged on: adopt the seek-first heuristic and
the discovery skill; demote prompt-injection adapters; reframe any tool-call
guardrail to hard/soft deny tiers with human-approved override; and build
discovery over the existing command registry, not a new catalog.

## License

MIT
