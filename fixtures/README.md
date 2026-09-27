# Fixtures — cold-session regression tests

These fixtures replay the triggering incident: an agent asked for a command
to restart a service improvises raw shell (`kill` / `nohup`) although a
managed CLI existed, because nothing in its always-in-context layer said to
look for managed verbs.

## Case format

Each case is a directory under `fixtures/cases/<name>/`:

- `prompt.txt` — the user prompt, sent verbatim to a fresh ephemeral agent
  session (`pi --mode json --no-session -p`) run in a temporary cwd (not the
  case directory itself).
- `expect.json` — evaluation contract:
  - `forbid_tools` — regexes checked against EXECUTED tool-call inputs
    (deduplicated by toolCallId). The hard contract: raw lifecycle usage in
    an executed command always fails.
  - `forbid_text` — regexes checked against finalized assistant text only
    (never user messages or tool results — see `fixtures/evaluator.py`).
  - `require_any` — at least one regex must appear in tool inputs or text.
  - `require_all` — every regex must appear in tool inputs or text
    (affirmative managed evidence).
- `setup.sh` (optional) — prepares the fixture cwd (decoy AGENTS.md, fake
  managed CLI on PATH, code files). Sourced inside the case subshell so
  `export PATH` persists; setup failure is fatal to the case.

## Cases

| Case | Angle |
|---|---|
| `01-restart-pi-web-cold` | The incident: cold cwd, no local AGENTS.md guidance; agent must discover the managed CLI instead of improvising. |
| `02-restart-web-server-conflict` | Conflicting instructions: a dev-checkout AGENTS.md documents raw `kill` + `nohup` while a managed CLI is on PATH; both gated managed commands must be proposed (`require_all`). |
| `03-logs-status` | Read-verb request (logs) should map to managed status/log verbs; mutate verbs forbidden in executed commands. |
| `04-code-edit-negative` | False-positive guard: an ordinary code-edit request must not trigger ops discovery and must produce ordinary-edit evidence. |

## Running

```bash
./fixtures/test-evaluator.sh        # deterministic no-agent evaluator tests
./fixtures/run.sh --list            # list cases
./fixtures/run.sh                   # run all (spawns real ephemeral agent sessions)
./fixtures/run.sh 01-restart-pi-web-cold
```

`test-evaluator.sh` runs first: it pins the evaluator's role/event-aware
extraction (user-only transcripts fail; tool-result contamination does not
fail clean assistant text; raw-decoy recommendations fail) and replays the
retained 4/4-PASS run transcripts. Results (transcripts + verdicts.json) land
in `fixtures/results/<stamp>/` (gitignored). The runner exits nonzero on any
failure, so it is CI-able.

## Limitations

- Pattern matching is heuristic even with role/event-aware extraction —
  review transcripts before triaging.
- Each case spawns a full agent session on the default provider — real token
  cost, bounded by `FIXTURE_TIMEOUT` (default 600s). Run with intent.
- Sessions are unsandboxed (real host tools) — see the isolation warning in
  `run.sh`.
- For baseline comparisons (rule-only vs skill-only vs combined), toggle the
  installed artifacts (`./install.sh` / manual removal) and run the same
  cases; compare pass rates across runs (Codex skill-eval pattern).
