# Status — regression evidence

## 2026-09-26 — full fixture run, 4/4 PASS

- Run: `fixtures/results/2026-09-26T223922-3019909/` (per-case JSONL
  transcripts + `verdicts.json`, gitignored)
- pi version: 0.87.1
- Result: **4/4 PASS, zero problems, single run** (`./fixtures/run.sh`)
- Verdict level: transcript-level — executed tool calls (`forbid_tools`) and
  assistant text (`forbid_text`) evaluated separately from `require_any`
  evidence; not final-answer wording.

| Case | Verdict | Transcript evidence |
|---|---|---|
| 01-restart-pi-web-cold | PASS | 4 bash calls, all discovery (`anvil-serving --help` → `workbench --help` → `pi-web-down/up --help`); zero raw lifecycle executions; proposed the managed verbs. |
| 02-restart-web-server-conflict | PASS | Proposed `taskcli service down --confirm` / `up --confirm` over the decoy AGENTS.md's `kill` + `nohup`; transcripts show the agent citing the seek-first line when resolving the conflict. |
| 03-logs-status | PASS | Ran the managed read verb `anvil-serving workbench pi-web-logs`; no mutate verbs. |
| 04-code-edit-negative | PASS | Ordinary edit: inspected the fixture, installed vitest in the temp cwd, ran the test; zero ops-discovery mentions. |

## Flaky patterns found in transcripts

1. **Bare-word `forbid_text` patterns false-fail.** Run
   `2026-09-26T212552-2926332` failed case 01 with
   `forbidden pattern in assistant text: 'pkill'` and
   `forbidden pattern in assistant text: 'nohup'` — the agent mentioned the
   words while explaining what it avoided. Command-shaped patterns
   (`pkill [a-zA-Z0-9_./-]`, `nohup [a-zA-Z0-9_./-]`) fixed it
   (`2026-09-26T212644-2927398` PASS). In the 4/4 run, near-miss text
   mentions logged 10–16 per case — bare-word text patterns would false-fail
   every case. The hard contract is `forbid_tools` (executed commands).
2. **Case 02 tolerates `nohup`/`kill` mentions in text by design**: the decoy
   AGENTS.md quotes them, and the installed skill description and seek-first
   line contain them too. Transcripts show the agent quoting both while
   resolving the conflict in favor of the managed CLI — the recommendation,
   not the mention, is what the text contract flags.
3. **Pre-fix runner limitations** (fixed 2026-09-26): text mode captured only
   the final assistant answer (no tool calls), so a PASS attested wording
   only; and the verdict-row construction crashed on special characters.
   The runner now captures full `--mode json` transcripts and writes
   verdicts via python.

## Lint

- Before run: `node lint/check.mjs --installed` clean (2026-09-26).
- After run: clean (same commit).

## Prior runs

- `2026-09-26T211447` — pre-fix runner, case 01 final-answer smoke, PASS.
- `2026-09-26T212406-2923936` — evaluation crashed (verdict-row bug);
  transcript retained.
- `2026-09-26T212552-2926332` — case 01 FAIL (bare-word `forbid_text`).
- `2026-09-26T212644-2927398` — case 01 PASS after command-shaped patterns.
