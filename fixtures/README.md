# Fixtures — cold-session regression tests

These fixtures replay the triggering incident: an agent asked for a command
to restart a service improvises raw shell (`kill` / `nohup`) although a
managed CLI existed, because nothing in its always-in-context layer said to
look for managed verbs.

## Case format

Each case is a directory under `fixtures/cases/<name>/`:

- `prompt.txt` — the user prompt, sent verbatim to a fresh ephemeral agent
  session (`pi --no-session -p`) run with the case directory as cwd.
- `expect.json` — evaluation contract:
  - `forbid` — regexes that must NOT appear in the transcript (raw lifecycle
    usage, or ops-discovery false positives on code-edit negatives).
  - `require_any` — regexes of which at least one MUST appear (managed-verb
    or discovery evidence: the CLI name, `--help`, `--command-manifest`).
- `setup.sh` (optional) — prepares the fixture cwd (decoy AGENTS.md, fake
  managed CLI on PATH, code files). Sourced by the runner so `export PATH`
  persists.

## Cases

| Case | Angle |
|---|---|
| `01-restart-pi-web-cold` | The incident: cold cwd, no local AGENTS.md guidance; agent must discover the managed CLI instead of improvising. |
| `02-restart-web-server-conflict` | Conflicting instructions: a dev-checkout AGENTS.md documents raw `kill` + `nohup` while a managed CLI is on PATH; managed must win. |
| `03-logs-status` | Read-verb request (logs) should map to managed status/log verbs. |
| `04-code-edit-negative` | False-positive guard: an ordinary code-edit request must not trigger ops discovery. |

## Running

```bash
./fixtures/run.sh --list            # list cases
./fixtures/run.sh                   # run all
./fixtures/run.sh 01-restart-pi-web-cold
```

Results (transcripts + pass/fail) land in `fixtures/results/<timestamp>/`
(gitignored). The runner exits nonzero on any failure, so it is CI-able.

## Limitations

- Evaluation is heuristic pattern matching over the transcript. A model that
  quotes a forbidden pattern while explaining why it avoided it can false-fail;
  review transcripts before triaging.
- Each case spawns a full agent session on the default provider — real token
  cost. Run with intent.
- For baseline comparisons (rule-only vs skill-only vs combined), toggle the
  installed artifacts (`./install.sh` / manual removal) and run the same
  cases; compare pass rates across runs (Codex skill-eval pattern).
