# Shared-contract implementation closeout and retrospective

Date: 2026-09-27. Scope: DESIGN-v0.3 sequencing step 2, not the entire v0.3
roadmap. Runtime defaults remain shadow-only. No enforcement promotion,
human override, sandbox qualification, or new model sessions are part of
this closeout.

## Delivered

The final open round-18 finding was a missing positional-value check:
`launchctl kill TERM\r system/web` could verify despite an unsupported
signal spelling. The grammar now checks the first operand, byte-exactly,
before exposing the second operand as the target. Invalid spellings retain
mutation recognition, expose no target, and cannot verify. Supported
spelling controls (`TERM`, `SIGTERM`, `15`, `0`) preserve target binding.

This is signal **spelling** validation, not a claim that every syntactically
valid name or number is accepted by every platform. No native launchctl
execution was performed. Unsupported spellings are uncertain; downstream
confidence and decision rules were not weakened.

The closeout also adds:

- `fixtures/test-shell-boundaries.mjs`: an independent Bash argv oracle for
  the late-run lexical defects, using the actual manifest policy rather
  than a hand-reconstructed policy. Every command in its fixed corpus is an
  inert shell function; the child environment has no usable tool PATH or
  inherited startup variables. It is not a sandbox for arbitrary inputs.
- `fixtures/check-contract.sh`: one fail-fast command for the complete
  deterministic gate, including installation and drift lint in a temporary
  HOME. No test pipeline may hide an upstream nonzero exit.
- Corrected roadmap/design status: implementation evidence is not an
  independent final review verdict or permission to enable enforcement.

## Verification

Run `./fixtures/check-contract.sh` from a clean checkout. It builds generated
assets, checks syntax and diff whitespace, then runs:

| Gate | Result |
|---|---:|
| Pure library regression suite | 181 passed |
| Independent fixed-corpus Bash argv oracle | 35 passed |
| Temporary-HOME installer suite | 47 passed |
| Synthetic transcript evaluator suite | 6 passed |
| Temporary-HOME installed drift lint | clean |

The original checkout additionally ran four optional historical transcript
replays (10 total evaluator checks). Those untracked local artifacts are not
present in a clean worktree, so this gate reports six synthetic checks; it
does not claim the four optional replays ran here.

The oracle checks physical-line boundaries, escaped-blank comment rules,
quote/continuation exposure of command-bearing options, CR/VT/FF/NBSP word
identity, positional signal spelling, compound operation counts, exact
binding, and shadow/enforce decision outputs. It executes no real kill,
service, container, pager, or hook command.

The last independent review was round 18 against `3853b5b`, with one MEDIUM
positional-signal finding. That finding is addressed and regressed here.
There is **no round-19 model PASS claim**. Parent review and deterministic
checks close the implementation work; draft PR review remains the human
acceptance gate. Live adapter/enforcement acceptance is still deferred.

## Why the run had so many failures

### 1. Example-by-example patching replaced a grammar audit

Eighteen review rounds repeatedly found the same classes of defects in new
positions. Quotes, escapes, comments, line splitting, executable extraction,
read options, and target parsing used separate assumptions. Fixing one
scanner did not repair its siblings. Examples:

- `7bb770a` added operand expansion checks; `cec29ef` subsequently had to add
  extglob handling and correct launchctl target positions.
- `a127547` added escape handling; `3773bea` then repaired single-quoted
  backslash semantics; `ab8b9b0` addressed continuations.
- `0406196` finally removed destructive physical-line trim/filter processing
  and consolidated comment handling. `3853b5b` replaced JS whitespace
  assumptions consistently across recognition.

The error was not that the reviewer kept inventing new requirements.
Most findings violated the already-written complete-form and exact-target
contract. The implementation kept fixing examples rather than their class.

### 2. Option grammars were copied or guessed

kill, pkill, killall, Docker verbs, and launchctl do not share argument
semantics. Boolean options were mistaken for value-taking options and vice
versa; signal selectors were treated like process selectors; the first
launchctl operand was mistaken for the service. Several tables admitted
options not supported by the corresponding executable. Review instructions
occasionally repeated these mistaken assumptions instead of checking them.

Future grammar changes need a per-executable/per-verb table of operand
positions, option arities, value rules, and positive/negative examples, with
unsupported forms deliberately excluded. Do not copy a neighboring table
and wait for a reviewer to discover the differences.

### 3. Passing tests were oversold

The retained regression suites passed because they pinned known examples,
not because shell semantics were independently established. Specific test
mistakes weakened the evidence:

- A compound test constructed `compound` but checked `c` instead.
- A launchctl negative-binding test used a nonexistent rule ID, so it failed
  verification for the wrong reason.
- Repeated test insertion replaced an existing `check(...)` header and
  orphaned its body.
- A refusal test initially treated an expected nonzero installer exit as a
  failure of the test.
- The parent's final positive-control probe omitted `launchctl` from its
  policy, producing a false regression alarm. The canonical-policy oracle
  avoids that mismatch.
- Test output was often piped through grep/tail without `pipefail`; matching
  summary output is not proof that the test process exited successfully.
- The evaluator's reported total depended on optional, untracked historical
  transcripts. The original checkout ran 10 checks, but a clean worktree
  runs six; carrying the old total into the closeout initially overstated
  reproducible evidence. The final gate output exposed the difference.

Tests must assert operation count, exact target, applicable rule,
confidence, and decision—not only classification kind. The new Bash oracle
provides independently interpreted argv for the fixed corpus; it is still
bounded evidence, not exhaustive shell verification.

### 4. Orchestration amplified the delay

Many progress messages arrived after later rounds had already fixed their
findings. Old suite counts and commit references distinguish those messages
from current review evidence. Repeatedly explaining or querying old run IDs
added noise; an unavailable run record does not prove why a notification was
late or whether an underlying process had existed at that moment.

One xhigh worker terminated with exit 143 after roughly 32.8 minutes and
15 turns, leaving a partial change. Its recorded metadata does not establish
whether timeout, cancellation, or another source sent SIGTERM. Earlier
claims that it was a turn/time budget failure were speculation. The same
session was resumed, its diff was inspected, and missing tests were added.

The large forked conversation also carried every previous failed attempt
into implementation handoffs. Narrow fresh task packets would have reduced
context overhead and ambiguity. Reviewer recommendations should not become
fresh implementation instructions without checking the actual code.

### 5. Completion and change-control discipline slipped

The parent repeatedly committed/pushed fixes to main before independent
acceptance, marked the milestone under “Shipped” prematurely, and changed
the active installed assets while using installed lint as a test. These
were avoidable workflow errors, not required by the product.

This closeout uses a dedicated worktree, an isolated install gate, and a
draft PR. It preserves the original checkout's uncommitted worker changes
rather than deleting them. The roadmap no longer implies that deterministic
shared-library tests qualify the live adapter.

## Changes to the workflow

1. Pin the revision, scope, canonical policy, and acceptance matrix once.
   Correlate terminal results with that revision; don't reopen completed
   findings because an older progress message arrived late.
2. After a second finding in one class, audit that class across all call
   sites. Choose a documented narrow grammar, not a sequence of regex patches.
3. Convert decisive reviewer probes into semantic tests, using an inert
   independent oracle where interpretation matters. Include positive
   controls so over-rejection cannot silently satisfy every negative test.
4. Run the complete fail-fast gate once after the final changes, with live
   assets untouched. Report actual exit codes and evidence scope.
5. Freeze the diff for review, publish a draft PR, and distinguish
   implementation completion from human acceptance and deployment.

## Remaining work and limitations

DESIGN-v0.3 steps 3–7 remain: independent fixture isolation, locked-model
behavioral baselines, Pi enforcement and trusted-human overrides,
evidence-backed destructive rules, and additional runtimes. They were not
silently completed by this parser work. Unsupported nested execution remains
best-effort, as documented in §3.1; same-UID code is not a security boundary.
The live extension remains the legacy shadow observer. Do not promote
shared-library results into a claim of deployed enforcement safety.
