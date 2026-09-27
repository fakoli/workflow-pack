# workflow-pack

Repo-structure-independent discovery of managed operational commands for
coding agents. One manifest, many runtimes.

Agents improvise `kill` / `nohup` / raw Docker for service lifecycle when the
managed CLI exists but nothing in the agent's always-in-context layer says to
look for it. This pack closes that gap with three layers compiled from — or
checked against — one declarative manifest:

1. **Seek-first line** — a ~65-token heuristic compiled into the global
   `AGENTS.md` (always in context, where the failure happened).
2. **Discovery skill** — an Agent-Skills-standard skill (`managed-operations`)
   whose description triggers on operational questions ("what command do I
   run to restart…") and whose body is a decision procedure
   (discover → select → act → no-verb-found), loaded on demand.
3. **Fixtures + lint** — cold-session prompt fixtures that replay the
   triggering incident as a regression test, and a coverage lint that fails
   when skill descriptions stop covering the manifest's trigger phrases.

## Why not just write the line by hand?

Hand-written prose is exactly what drifts. The manifest is the single source
of truth: `scripts/build.mjs` compiles the AGENTS.md block from it, and
`lint/check.mjs` fails when skills, compiled artifacts, or installed targets
drift. (Compile-step pattern: Agent OS profiles. Coverage-gate pattern:
agent-config linters — none of which check trigger-description coverage
against a command-surface index, the exact failure class that caused the
original incident.)

## Layout

```
pack/workflow-pack.v1.json   the manifest (single source of truth)
skills/managed-operations/   the discovery skill (Agent Skills standard)
scripts/build.mjs            compiles dist/ artifacts from the manifest
lint/check.mjs               coverage lint (repo + --installed targets)
install.sh                   idempotent install into harness dirs
fixtures/                    cold-session regression cases + runner
```

## Install

```bash
./install.sh                          # skill -> ~/.agents/skills/, seek-first -> ~/.pi/agent/AGENTS.md
node lint/check.mjs --installed       # verify installed targets match the repo
```

`install.sh` backs up `~/.pi/agent/AGENTS.md` to `.backups/<date>/` before
writing and upserts a marker-delimited block, so re-running is safe.

## Fixtures

```bash
./fixtures/run.sh --list              # list cases
./fixtures/run.sh                     # run all (spawns real ephemeral agent sessions)
./fixtures/run.sh 01-restart-pi-web-cold
```

See `fixtures/README.md` for the case format and limitations. Each case costs
a full agent session — run with intent.

## Lint

```bash
node lint/check.mjs              # manifest schema, skill frontmatter,
                                 # trigger coverage, dist freshness
node lint/check.mjs --installed  # + installed skill/AGENTS.md drift
```

Exit 1 with findings; CI-able.

## Manifest format (workflow-pack/v1)

- `seek_first` — the always-in-context heuristic, compiled into AGENTS.md.
- `skills[]` — skills shipped in the pack and their install targets.
- `verb_families[]` — per product CLI: discovery command, machine-readable
  manifest command, trigger phrases (must be covered by skill descriptions),
  failure classes, and sourced example invocations.
- `policy` — soft/hard deny vocabulary reserved for the enforcement layer
  (out of scope for v0.1).

## Roadmap

- **Bounded discovery tool (read-only)** — a harness extension projecting the
  owning product's command manifest (mutation class, confirmation gates, docs
  anchors) as a small tool/context packet, over the existing registry rather
  than a new free-text catalog.
- **Shadow-mode guardrail** — observe raw lifecycle commands first; then
  soft-deny with the managed alternative named in the deny reason; hard-deny
  only destructive/irreversible operations; human-mediated one-shot override
  (never a model-writable marker); JSONL audit of every decision.
- **Feedback loop** — detected improvisation events → failure memory → pack
  and lint updates.
- **More runtimes** — the same manifest can drive Claude Code / Codex /
  OpenCode adapters (skills dirs, hooks, rules).

## Provenance

Designed from a four-model consult (GPT-6 Astra + three web-researched
candidates, 2026-09-26) that converged on: adopt the seek-first heuristic and
the discovery skill; demote prompt-injection adapters; reframe any tool-call
guardrail to hard/soft deny tiers with human-approved override; and build
discovery over the existing command registry, not a new catalog.

## License

MIT
