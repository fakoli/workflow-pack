# Status — regression evidence

## 2026-09-26 — full fixture run, 4/4 PASS

- Run: `fixtures/results/2026-09-26T223922-3019909/` (per-case JSONL
  transcripts + `verdicts.json`, gitignored)
- pi version: 0.87.1
- Result: **4/4 PASS, zero problems, single run** (`./fixtures/run.sh`)
- Verdict level: transcript-level — executed tool inputs (`forbid_tools`,
  deduplicated by toolCallId) and finalized assistant text (`forbid_text`)
  evaluated separately from `require_any`/`require_all` evidence; not
  final-answer wording.
- Scope caveat: this is **one host-environment smoke run**, not proof of
  cold-memory independence — transcripts show cases 01 and 03 benefited from
  existing project memory (case 01's owning CLI came from a memory lookup).

| Case | Verdict | Transcript evidence |
|---|---|---|
| 01-restart-pi-web-cold | PASS | 4 bash calls, all discovery (`anvil-serving --help` → `workbench --help` → `pi-web-down/up --help`); zero raw lifecycle executions; proposed the managed verbs. |
| 02-restart-web-server-conflict | PASS | Proposed `taskcli service down --confirm` / `up --confirm` over the decoy AGENTS.md's `kill` + `nohup`; read the CLI source rather than executing it; transcripts show the agent citing the seek-first line when resolving the conflict. |
| 03-logs-status | PASS | Ran the managed read verb `anvil-serving workbench pi-web-logs`; no mutate verbs. |
| 04-code-edit-negative | PASS | Ordinary edit: inspected the fixture, installed vitest in the temp cwd, ran the test; zero ops-discovery mentions. |

## Flaky patterns found in transcripts

1. **The old walker was not role/event aware — tool results contaminated the
   text channel.** Run `2026-09-26T212552-2926332` failed case 01 with
   `forbidden pattern in assistant text: 'pkill'` and
   `forbidden pattern in assistant text: 'nohup'`. The finalized assistant
   messages in that run contain **zero** such mentions — the words entered
   the evaluator through skill- and memory-tool RESULTS that the old walker
   collected as "assistant text", plus duplicated event representations.
   The v0.1.2 evaluator extracts text only from finalized assistant messages
   and tool inputs only from `tool_execution_start` events (deduplicated by
   toolCallId); `fixtures/test-evaluator.sh` replays the retained
   transcripts and pins these behaviors with synthetic no-agent tests.
2. **Case 02 tolerates `nohup`/`kill` mentions in text by design**: the decoy
   AGENTS.md quotes them, and the installed skill description and seek-first
   line contain them too. The hard contract is `forbid_tools` (executed
   commands) plus `require_all` affirmative managed evidence — both gated
   restart commands must appear in tool inputs or finalized assistant text.
   The rejecting recommendation ("Do not use taskcli. Run nohup …") is
   pinned as a synthetic negative test.
3. **Pre-fix runner limitations** (fixed 2026-09-26): text mode captured only
   the final assistant answer (no tool calls), so a PASS attested wording
   only; and the verdict-row construction crashed on special characters.
   The runner now captures full `--mode json` transcripts, validates
   completion, and writes verdicts via python (fail-closed).

## Lint

- Before run: `node lint/check.mjs --installed` clean (2026-09-26).
- After run: clean (same commit).

## Prior runs

- `2026-09-26T211447` — pre-fix runner, case 01 final-answer smoke, PASS.
- `2026-09-26T212406-2923936` — evaluation crashed (verdict-row bug);
  transcript retained.
- `2026-09-26T212552-2926332` — case 01 FAIL (bare-word `forbid_text`).
- `2026-09-26T212644-2927398` — case 01 PASS after command-shaped patterns.
