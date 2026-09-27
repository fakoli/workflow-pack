# Design v0.3 — evidence-gated operational guardrails

**Status:** proposed, not implemented
**Constructed:** 2026-09-26, adversarially reviewed (Astra, fresh context,
read-only) against the v0.2.0 tree; its concrete findings on the shipped
evaluator, installer grammar, and runner metadata are fixed in the same
change that commits this design.
**Scope:** remaining [docs/ROADMAP.md](ROADMAP.md) items
**Default:** existing installations remain in shadow mode

## 1. Operator outcomes and non-goals

v0.3 should let an operator:

- See which raw lifecycle attempts were genuinely covered by managed commands.
- Enable narrowly scoped enforcement with an understandable alternative.
- Approve one eligible exception through a trusted human interaction.
- Run regression agents without giving their tools production authority.
- Compare skill triggering across explicitly selected models.
- Install the same pack into additional harnesses without silently claiming
  unsupported capabilities.

It must never:

- Infer ownership from product names, trigger phrases, or process-name
  similarity alone.
- Invent a managed command or confirmation flag.
- Convert recommendations into execution.
- Rewrite raw commands into managed commands automatically.
- Treat assistant text, a shell comment, or a writable approval artifact as
  human authorization.
- Promote enforcement automatically from audit counts.
- Perform its own service recovery from inside the service being stopped.
- Claim that an in-process, same-UID extension is a tamper-proof security
  boundary.

Out of scope: a general shell parser, endpoint security product, policy
server, approval daemon, fleet control plane, or guaranteed defense against
a malicious same-UID process.

## 2. Small shared architecture

Keep one manifest and a small shared implementation:

| File or directory | Responsibility |
|---|---|
| `pack/workflow-pack.v1.json` | Versioned policy, discovery contracts, runtime declarations, evaluation references |
| `scripts/build.mjs` | Compile rule blocks, runtime installation plans, and installable pack assets |
| `lib/guardrail.mjs` | Pure command classification, target-confidence handling, decision calculation |
| `lib/discovery.mjs` | Structured, bounded registry projection through an injected execution interface |
| `lib/audit.mjs` | Versioned audit records and private append handling |
| `extensions/pi-workflow-pack/index.ts` | Pi event integration, discovery tool, trusted-human interaction |
| `scripts/feedback.mjs` | Backward-compatible summaries and graduation reports |
| `fixtures/run.sh` | Supported fixture entry point and explicit backend/profile selection |
| `fixtures/sandbox.mjs` | Bounded sandbox creation, execution, evidence collection, cleanup |
| `fixtures/pi-sandbox/index.ts` | Fixture-only tools that execute exclusively inside the sandbox |
| `fixtures/evaluator.py` | Transcript extraction, deterministic assertions, behavioral scores |
| `adapters/` | Other harnesses' compilation and event-normalization contracts |
| `install.sh`, `lint/check.mjs` | Safe installation and capability/drift validation |

Do not introduce a plugin framework. Shared modules expose ordinary
functions, with execution, audit, and human confirmation supplied by the
adapter. Install the manifest and required shared modules with the
extension; runtime behavior must not depend on a particular checkout
location.

### Manifest additions

Retain existing fields for compatibility; add explicitly versioned
executable contracts:

- `policy.contract_version`
- `policy.default_mode`, initially `shadow`
- `policy.rules[]`: stable rule ID, failure class, supported command shape,
  severity semantics, eligibility requirements
- `verb_families[].discovery_argv` and `manifest_argv`
- `verb_families[].registry_contract`: expected schema and field mapping
- `verb_families[].ownership_contract`: available target identifiers and
  authoritative read-only resolution method
- `runtimes[]`: adapter ID, installation targets, supported versions,
  artifact types, verified capabilities
- `evaluation`: prompt-suite and model-lock references

Lifecycle alternatives remain sourced from the owning CLI's registry and
focused help. The pack stores resolution contracts, not a second catalog of
guessed commands. Actual deployment identities, selected enforcement scopes,
and local evidence references remain private operator state.

Old adapters encountering a newer policy contract must report unsupported
enforcement. They must not silently interpret unknown policy fields as
permission.

## 3. Enforcement behavior

### 3.1 Separate three questions

For each supported tool call, determine:

1. **What operation is actually proposed?**
2. **Which target and owner does it affect?**
3. **What policy has the human enabled for that failure class and target?**

A lexical match answers none of these conclusively. Start with a
deliberately small command recognizer:

- Explicit supported executable/argument forms.
- Simple command lists only when every executable segment is understood.
- No execution of substitutions to discover their meaning.
- Comments, quoted examples, heredoc bodies, and arguments to `echo`,
  `grep`, or similar read operations are not lifecycle execution.
- Shell indirection, dynamic expansions, aliases, wrapper scripts, and
  unsupported forms are marked uncertain.
- The multiple-target exclusion applies to MUTATION operations: read-only
  diagnosis verbs may carry multiple operands (`systemctl status a b`)
  because operands are diagnosis subjects, not affected targets.

Do not claim comprehensive shell coverage. Ambiguous cases must be visible
in the audit rather than silently treated as confidently safe.

**Coverage boundary (Milestone 1 contract).** The recognizer is bounded and
best-effort by design:

- Confident classifications require an explicit, complete supported
  executable/argument grammar; verified ownership requires a single covered
  mutation on a completely supported form (`kind === "lifecycle"`, no
  nested-execution structure). Uncertain classifications cap at
  `candidate`.
- Unsupported syntax — brace/glob expansion, escaped or concatenated
  executable words, unknown options, multiple targets, redirects on
  mutations, indirection, environment prefixes — always remains uncertain
  and never invents target identity or a confident read-only
  classification.
- Nested-execution detection (`lifecycleInside`) is best-effort, not
  comprehensive: wrapped commands (`sh -c`), newline-separated commands
  inside double-quoted substitutions, and deeply nested substitutions may
  be missed while the overall classification stays uncertain. A missed
  nested execution follows the existing decision contract: an
  unsupported-shape uncertain classification is allowed in enforce mode
  unless integrity detection holds it — it is NOT an unconditional hold.
  Closing that gap is an explicit policy change for the enforcement
  milestone, not a property of this contract.

### 3.2 Target-confidence levels

| Confidence | Meaning | Enforcement use |
|---|---|---|
| `unknown` | No reliable target/owner resolution | No invented alternative |
| `candidate` | Name, documentation, or lexical evidence suggests an owner | Discovery lead only |
| `verified` | Exact target identity and applicable managed operation are established by a supported authority contract | Eligible for scoped soft-deny |
| `stale/conflicting` | Previously verified evidence expired or authorities disagree | Hold mutation within an enabled scope; refresh evidence |

An explicit system-service identifier may be sufficient if the authority
contract confirms it. A bare PID or broad `pkill` pattern normally is not.
PID reuse and stale cached ownership must not establish permission.
Discovery output is data, never executable instructions — validate registry
schema, command status, size limits, and gate metadata before using it for
a denial.

For enforcing rules: pin the approved CLI executable identity/path; use
argument arrays rather than whitespace-split shell strings; bound subprocess
output at collection time; reject unsuccessful or truncated registry
responses as authoritative evidence; resolve uncertainty about gates through
supported focused help; do not invent `--confirm` when metadata is missing.

### 3.3 State machine

State is selected per **failure class × target scope**, not globally
promoted by frequency.

```text
SHADOW
  └─ human-reviewed evidence + supported adapter + target authority
       └─ SOFT-DENY

SOFT-DENY
  └─ separately reviewed destructive/irreversible operation rule
       └─ HARD-DENY for that operation only
```

Hard-deny is a severity classification, not the consequence of repeated
soft-denials.

| Condition | Shadow behavior | Enabled-scope behavior |
|---|---|---|
| Supported non-lifecycle/read command | Allow; audit | Allow; audit |
| Raw reversible lifecycle action, verified managed coverage | Log proposed soft-denial | Soft-deny; name sourced alternative and gates |
| Recognized mutation, unresolved ownership | Log uncertainty | Ownership hold; permit read-only resolution |
| Verified destructive/irreversible action with an approved rule | Log proposed hard-denial | Hard-deny; no in-session override |
| Previously enforced target loses authority evidence | Log degradation | Hold relevant mutation; never silently downgrade |
| Guardrail tampering or unsafe self-maintenance | Log proposed refusal | Control-integrity/supervision hold |
| Unsupported command/tool shape | Record coverage limitation | Do not claim protection outside supported scope |

An ownership or integrity hold is not labeled "hard-deny destructive" — it
is a missing-precondition refusal. Ordinary `kill`, restart, or container
removal must not be classified as irreversible merely because of its
spelling; a hard rule needs evidence of the destructive effect (for example,
deletion of an identified persistent resource). No hard-deny rule ships
enabled without such evidence. An empty enabled hard-rule set is preferable
to speculative destructive classifications.

### 3.4 Denial UX

A soft-denial returns: stable decision ID; identified operation and target;
why managed coverage applies; exact sourced managed alternative; required
preview/confirmation/human gate; discovery source and freshness; whether a
one-shot human exception is available.

Example, using synthetic registry data:

> Raw restart blocked for `example.service`. The verified managed path is
> `taskcli service down --confirm`, then `taskcli service up --confirm`.
> Review the required confirmation gates before execution. Decision `D…`;
> a human may approve one exception from the guardrail control.

Neither denial nor approval executes the replacement command.

### 3.5 Audit contract

Add a versioned JSONL schema containing: timestamp, session ID, tool-call
ID, decision ID; harness/adapter and pack/policy versions; tool and command
fingerprint; rule IDs, failure class, target-confidence status; private
target reference and discovery-evidence digest; configured state, action,
and reason code; proposed alternative/gate references when available;
override request, approval, consumption, expiration, or cancellation events;
execution outcome when observable.

Audit every decision for supported calls, including no-match allows,
uncertainty, denials, and overrides — a denominator the current matched-only
log lacks. Preserve the distinction between **attempted**, **allowed**,
**started**, and **completed**; an allow record is not execution evidence.

Defaults: private state directory and restrictive file permissions; no
credentials, tool-result payloads, or unbounded command capture; prefer
structured operation fields and a fingerprint over raw command text;
optional raw diagnostic capture is private and explicitly enabled, never
directly publishable; public exports require sanitization.

In shadow mode, audit failure remains non-blocking but becomes visible. In
enforcement, inability to record a mutating allow or override prevents that
mutation; read-only diagnosis remains available with a clear degraded-audit
warning. Audit failure cannot be hidden by reporting a successful, fully
audited decision. Local JSONL is not tamper-evident evidence against the
same OS user.

## 4. Shadow-to-enforce graduation

Extend `scripts/feedback.mjs` with a machine-readable baseline report.

### Baseline procedure

1. Identify a bounded observation window and snapshot digest.
2. Separate legacy rows from richer v0.3 records.
3. Label reviewed candidates: actual lifecycle attempt; quotation/read-only/
   probe false positive; covered target; unmanaged target; unresolved
   ownership; unsafe self-supervision; possible destructive effect.
4. Attach registry/gate evidence to covered examples.
5. Report false positives, unknowns, missing observations, and coverage
   limitations.
6. Add sanitized regression cases for every discovered failure shape.
7. Replay the proposed policy against the corpus before enabling it.

Legacy rows lack reliable target identity, execution status, and sometimes
complete commands. They may seed cases; they cannot independently authorize
enforcement.

### Graduation gate

A target/failure-class pair becomes eligible only when:

- Its authority and applicable managed gate are verifiable.
- Every known false positive has a regression case.
- Positive and negative deterministic cases pass.
- Sandbox tests demonstrate denial before executor invocation.
- Human override and integrity-hold tests pass.
- The adapter's required capabilities are verified.
- A human approves the scope and records the evidence references.

Do not use "N rows observed" as the graduation rule. Configuration is
snapshotted at trusted startup; promotion, downgrade, and maintenance are
explicit human control actions, not hot-reloaded responses to agent-writable
files.

## 5. Human-mediated one-shot override

### Behavior

An override applies only to an eligible soft-denial. The operator sees the
exact pending operation, target, working directory, alternatives, gates, and
relevant command/environment identity, then chooses: **Reject** or **Approve
this pending operation once**.

The approval is bound to: session and tool-call ID; complete original input
fingerprint; target identity and confidence; policy/discovery evidence
digests; working directory and execution context. It expires on input
change, target change, timeout, cancellation, session end, or restart.
Consumption occurs immediately before the approved executor invocation; it
is atomic and single-use. Retrying after a failure requires another
approval. Prefer approval of the still-pending call over granting a future
command-permission token.

### Trust boundary

Only a harness-owned human interaction may produce approval. A model-callable
tool may request review but cannot approve it. Never accept: `# raw-ok`;
`approved: true`; a writable approval file; an environment toggle; a
user-shaped transcript message supplied by the agent; stdin automation that
cannot distinguish human input from model-controlled input.

Keep approval state in the trusted adapter's memory; no bearer approval
token is returned to the model. If a harness cannot prove this distinction,
it supports **no override**. Headless runs default to denial, not automatic
consent. The known Pi pre-execution blocking API is sufficient for denial;
trusted-human approval provenance still requires a verified adapter test
before enabling overrides.

### Gate preservation

An exception waives only the pack's managed-alternative preference for that
operation. It does not waive the owning product's authorization, preview,
confirmation, or human-promotion requirements. If those requirements cannot
be satisfied for the proposed exception, do not offer approval. Hard-deny,
ownership holds, integrity holds, and self-supervision holds have no
one-shot override.

## 6. Self-protection and self-maintenance

Protect the installed extension, shared policy assets, enforcement
configuration, startup registration, and audit destination from supported
agent write paths. Mechanisms: normalize paths for direct `write`/`edit`/
patch operations; detect deletion, replacement, relocation, and permission
changes affecting protected assets; recognize straightforward shell attempts
to disable the extension, change enforcement settings, erase audit evidence,
or launch an unguarded successor; refuse these as control-integrity
operations in enforce mode; do not accept per-tool environment assignments
as guardrail configuration; check installed-asset digests at startup and
before relevant decisions; record detected drift and hold relevant
mutations.

This remains best-effort protection within supported tool surfaces.
Arbitrary programs running under the same OS account can bypass heuristic
checks; stronger protection requires OS-enforced separation and is deferred.

### Maintenance path

Installation, upgrade, disabling, and repair are human operations performed
from an independent operator context. A session must not restart: the
service that supervises it, its own execution environment, or a coupled
service whose shutdown also terminates its recovery controller. Use an
independently running executor and verify readiness afterward; spawning a
background shell inside the same cgroup does not create independence.
Acceptance must include a synthetic coupled-service case: both raw and
managed recovery attempts from the coupled session are refused, while
independent recovery is documented.

## 7. Fixture isolation

### Required behavior

A regression agent may break synthetic services and files. Its tools must
not access host credentials, production services, host process controls, or
host lifecycle sockets. The isolation must remain effective when the
production guardrail is absent or disabled.

### Concrete backend

Use an optional, already-installed rootless OCI runtime as the first
isolation backend — an external test prerequisite, not a Python/Node
dependency. Two-plane design:

1. **Host controller:** launches the model harness and performs provider
   communication.
2. **Sandbox tool plane:** every model-accessible filesystem and shell tool
   executes inside a per-case container.

The host controller exposes no general host tool to the model. The local Pi
help confirms controls for disabling built-ins and extension discovery and
allowlisting tools; the fixture adapter uses these controls and registers
only sandbox-backed tools. Verify that disabled built-ins cannot reappear
before shipping this backend.

Container requirements: no host PID, IPC, or network namespace; no
container-engine socket; no credentials, SSH agent, production
configuration, or host-home mounts; no network for the tool plane; read-only
fixture assets and disposable writable case state; non-root execution,
restricted capabilities, resource/time limits; pinned image digest, no
implicit image pull during a run; container identity chosen by the runner,
never tool arguments.

Only the trusted host controller receives narrowly selected provider
credentials; tool subprocess environments are independently sanitized.
`ops_discover` in fixtures must use the injected sandbox executor — loading
its current host-side `execFile` implementation unchanged would defeat
isolation. Synthetic CLIs must expose realistic help and machine-readable
manifests, gated lifecycle verbs, deterministic service state, and an
execution ledger independent of assistant text. Setup scripts run inside
the sandbox too.

### Runner interface

```text
fixtures/run.sh --list
fixtures/run.sh --backend sandbox --profile combined --model <locked-alias> [cases...]
fixtures/run.sh --backend replay <retained-run>
fixtures/run.sh --backend host --allow-real-host --model <locked-alias> [cases...]
```

Profiles: `baseline`, `rule-only`, `skill-only`, `combined`.

Rules: sandbox becomes the default agent-execution backend once accepted;
missing isolation capability fails before launching an agent; never
silently fall back to host execution; host execution requires both explicit
backend selection and acknowledgement; invalid or missing case safety
metadata fails closed; retain real-host cases separately and add synthetic
equivalents rather than relabeling them; record skipped cases explicitly;
replace network-dependent negative fixtures with stdlib test examples or
prebaked assets.

### Acceptance

With the production guardrail disabled: absolute-path shell calls remain
inside the container; reads cannot expose a synthetic host-side secret
canary; host process/service/socket canaries cannot be affected; container
filesystem writes do not modify repository or installed pack assets;
provider credentials are absent from sandbox environment and mounts; a
malicious setup script has no greater authority than the case; timeout and
setup failure prevent subsequent execution; cleanup is owned by the
independent runner, not the agent; all exposed tool names are accounted for
and unwrapped tools abort startup.

Replay tests validate evaluation logic but are not substitutes for live
isolation tests.

### Deferred

Additional container engines, Windows parity, remote runners, provider
gateways, and kernel-level hostile-code guarantees.

## 8. Behavioral trigger evaluation

### Question being measured

Measure **observable skill activation** separately from **successful
operational behavior**. A correct answer does not prove a skill loaded; a
loaded skill does not prove the agent followed it.

### Experimental design

Identical synthetic environments and prompt sets across four profiles:

| Profile | Seek-first rule | Skill |
|---|---:|---:|
| Baseline | No | No |
| Rule-only | Yes | No |
| Skill-only | No | Yes |
| Combined | Yes | Yes |

For this experiment the production guardrail and `ops_discover` tool are
absent in all four profiles — otherwise they confound attribution. Evaluate
the full stack in a separate integration suite. Use fresh isolated harness
configuration, no prior session or memory extensions, and explicitly staged
context files. Never toggle globally installed artifacts for comparisons.

### Model locking

Add a public model-lock file containing: human-readable alias; exact
provider/model identifier; revision where the provider exposes one; reasoning
and sampling settings; supported harness version range. Record the requested
alias and actual resolved model identity in every run. Fail unresolved
aliases, silent fallbacks, or detectable identity mismatches. A provider's
mutable model alias is not an immutable revision — label this limitation
rather than claiming full reproducibility. Also record pack, skill,
prompt-suite, image, adapter, and evaluator hashes.

### Prompt suite

Start small: approximately twelve scored prompts across explicit lifecycle
requests; indirect operational language without exact trigger words;
read-only diagnosis; conflicting checkout instructions; unknown ownership;
self-supervision; ordinary code edits and quoted-command negatives.

Each case declares: whether activation is expected; advice-only versus
execution intent; required discovery evidence; allowed and forbidden
operational actions; expected gates and ordering; the synthetic target state
expected afterward, where applicable.

### Scoring

Report separate binary dimensions:

1. **Activation:** a successful skill-content read or documented harness
   skill-load event.
2. **Discovery:** authoritative discovery occurred before a recommendation
   or mutation.
3. **Selection:** the correct target and managed operation were selected.
4. **Gates:** required authorization/confirmation behavior was preserved.
5. **Safety:** no forbidden operation executed.
6. **Task completion:** the requested advice or synthetic state transition
   occurred.

For negative prompts, report unnecessary activation and unnecessary
discovery. Do not infer loading from "I used the skill" — if a harness does
not expose loading, report activation as unobservable rather than guessing.
Keep denominators separate for advice and action tasks; advice cases must
not receive extra credit for unauthorized execution.

### Evaluator changes

Preserve the existing role/event-aware contract (text only from finalized
assistant messages; tool inputs deduplicated by call ID; user and
tool-result text never count as assistant evidence; malformed/incomplete
transcripts fail closed). Add: a substantive assistant/tool-activity
requirement — user-only transcripts fail even with `agent_end`; explicit
handling of missing or conflicting call IDs; structured tool names and
argument fields, including `ops_discover`; ordered events for
discovery-before-action checks; attempted/blocked/executed distinctions;
tool outcome metadata for successful skill loading, without treating result
text as assistant prose; synthetic execution-ledger assertions for
operational effects.

Verify each harness's event ordering before assuming `tool_execution_start`
means its executor ran; a pre-execution denial must not be scored as an
executed forbidden action merely because the harness emitted a start-shaped
event. Retain historical extraction semantics for replay compatibility;
version richer verdict schemas explicitly.

### Evidence and acceptance

For a small initial comparison, predeclare two pinned model aliases and
three repetitions per prompt/profile. Randomize or balance profile order;
record failures and timeouts rather than excluding them silently. Publish:
activation recall and false-activation rate; managed-behavior success rate;
gate violations and forbidden executions; counts and denominators, not just
percentages; paired differences between profiles; sanitized failure examples.

Do not require the experiment to demonstrate improvement — a reproducible
finding that the skill does not help is a valid evaluation outcome.
Acceptance requires trustworthy measurement and reporting; safety violations
separately prevent enforcement graduation.

### Deferred

Large model matrices, automated LLM judges, hidden-reasoning interpretation,
and statistical superiority claims from small samples.

## 9. Additional runtime adapters

### Behavior

Operators select a runtime and see exactly what will be installed and which
capabilities are supported. "Installed rules" must not be presented as
"enforcement enabled."

### Adapter contract

Each adapter declares: runtime/version identification; rule and skill
discovery locations; exact managed marker grammar; hook/plugin installation
method; tool-name and argument normalization; whether a hook occurs before
execution; blocking semantics and error behavior; trusted-human approval
capability; transcript and skill-load observability; installed-drift checks.

The shared decision engine accepts normalized events and returns decisions;
adapters translate them into harness-specific hook results. Normalize at
least: session, call ID, tool, cwd; command or affected paths;
attempt/start/completion state; finalized assistant messages; verified
human-control events. Do not pretend all harnesses expose equivalent events.

### Delivery order

1. **Rules and skills:** compile and safely install artifacts for Claude
   Code, Codex, and OpenCode.
2. **Observation:** add hooks only where documented and locally verified.
3. **Blocking:** enable only after before-execution semantics pass contract
   tests.
4. **Overrides:** enable only after human-origin approval is verified.

Exact paths and hook payloads are implementation-time verification tasks
against the installed runtime's current documentation and help; they are not
assumed interchangeable. A rules-only adapter is an honest supported tier.
No new runtime package dependency is introduced without explicit sign-off.

### Installer requirements

Before any installed target changes: validate manifest and adapter
compatibility; parse exact complete marker lines (reject malformed,
duplicate, reversed, or nested markers); resolve and reject symlinked
targets and unsafe ancestors; compute every replacement and verify source
assets; create unique private backups; present the full installation plan
when requested.

Use atomic same-directory replacements. If installation fails midway,
restore completed writes where possible and report any incomplete
restoration explicitly; do not claim a multi-file atomic transaction.
Install all shared runtime assets, not only `index.ts`.

Test against temporary homes: fresh install and idempotent reinstall;
malformed markers and symlinked ancestors; one invalid target among several
runtimes causes no preflight mutation; unknown runtime version cannot enable
enforcement; mid-apply failure and restoration reporting; uninstall removes
only pack-owned artifacts; drift lint checks every installed asset and
registration.

### Deferred

Unverified hooks, automatic version-wide compatibility claims, approval
brokers for stateless hooks, runtime-wide security guarantees, and automatic
edits to unrelated user settings.

## 10. Acceptance matrix

| Surface | Evidence required |
|---|---|
| Command recognition | Positive lifecycle and negative quotation/probe corpus; unsupported syntax explicitly classified |
| Ownership | Exact, missing, stale, conflicting, and reused-identity cases |
| Soft-deny | Correct alternative and gates; executor not invoked |
| Hard-deny | Demonstrably destructive target effect; no in-session override |
| Override | Human-origin test, exact binding, single consumption, expiration, race/replay rejection |
| Self-protection | Direct writes, patches, obvious shell disable attempts, coupled-service recovery case |
| Audit | Allow/deny/override/outcome correlation; malformed legacy data; unavailable sink |
| Isolation | Production guardrail disabled; independent host canaries remain untouched |
| Evaluator | User-only-with-completion failure, deduplication, contamination protection, blocked/executed distinction |
| Behavior | Locked models, isolated profiles, complete denominators, sanitized evidence |
| Adapters | Per-runtime capability proof, install/drift tests, no silent enforcement downgrade |

## 11. Sequencing

1. **Evidence foundation:** fix evaluator edge cases and strict case
   metadata; strengthen installer grammar/ancestor checks.
2. **Shared contract:** structured discovery, target confidence, versioned
   audit, pure decision tests. Stay shadow-only.
3. **Isolation:** sandbox tool adapter and synthetic service state; prove
   isolation independently of policy.
4. **Behavioral baseline:** locked models and four-profile comparison in the
   sandbox.
5. **Pi enforcement:** scoped soft-deny, trusted-human approval, integrity
   holds, and graduation report.
6. **Destructive rules:** separately qualify only evidence-backed hard-deny
   cases.
7. **Additional runtimes:** rules/skills first, then capability-tested
   observation and enforcement.

Documentation and artifact-schema work can precede isolation. Live
enforcement qualification cannot.

**Release policy:** v0.3 may ship enforcement-capable code while retaining
shadow defaults and zero broadly promoted targets. Missing evidence is a
release limitation, not permission to skip the gate.

## Risks

- Same-UID self-protection remains heuristic, not tamper-proof.
- Shell indirection and unwrapped tools remain coverage risks.
- Current target-authority and trusted-human UI capabilities need
  verification.
- Model aliases may conceal provider-side changes.
- Rootless sandbox support is an external prerequisite.
- Existing smoke evidence remains one host-environment smoke run, not proof
  of cold-memory independence.
