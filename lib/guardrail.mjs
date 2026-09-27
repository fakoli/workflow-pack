// Pure command classification, target-confidence handling, and decision
// calculation for the workflow-pack guardrail (docs/DESIGN-v0.3.md §3).
//
// This module is PURE: no I/O, no subprocess execution, no filesystem
// access. Execution, audit, and human confirmation are supplied by the
// adapter (design §2). Everything here is deterministic and unit-testable.
//
// Deliberate limits (design §3.1): this is a small command recognizer, not
// a shell parser. Only explicitly supported COMPLETE forms classify as
// `lifecycle`; anything else — indirection, expansions, escapes, redirects,
// heredocs, assignments, unknown executables — classifies as `uncertain`
// and must be visible in the audit rather than silently treated as
// confidently safe. Shell semantics honored conservatively: double quotes
// do NOT suppress command substitution; only single quotes are literal.

/**
 * Split a shell command string into top-level segments on `;`, `&&`, `||`,
 * `|`, `|&`, a single `&` (background), and newlines, respecting single and
 * double quotes and backslash escapes. Never executes anything.
 */
export function splitSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    // single quotes are fully literal: backslash has no escape semantics
    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&") {
      if (ch !== ";" && command[i + 1] === ch) i++;
      else if (ch === "|" && command[i + 1] === "&") i++;
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Truncate a segment at an unquoted, unescaped `#` (shell: a comment runs
 * to the end of the line). Single and double quotes are tracked; a
 * backslash escapes the next character.
 */
function stripComment(segment) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    // single quotes are fully literal: backslash has no escape semantics
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(segment[i - 1]))) {
      return segment.slice(0, i).trim();
    }
  }
  return segment.trim();
}

// Executables whose arguments are never lifecycle execution (design §3.1:
// "arguments to echo, grep, or similar read operations are not lifecycle
// execution"). Conservative read-only set.
const READ_EXECUTABLES = new Set([
  "echo", "printf", "grep", "rg", "cat", "ls", "head", "tail", "wc",
  "which", "type", "man", "help", "true", "false", "pwd", "date",
]);

// Prefix executables that do not change the underlying operation when they
// appear WITHOUT flags. A passthrough flag cannot be confidently resolved
// (e.g. `sudo -u root ...`) and classifies as uncertain.
const PASSTHROUGH_EXECUTABLES = new Set(["sudo", "doas", "nice", "env", "command", "exec"]);

// Indirection executables: the real operation is hidden behind a nested
// command string. Always uncertain. (nohup is NOT here: it is a lifecycle
// rule executable in its own right.)
const INDIRECTION_EXECUTABLES = new Set(["sh", "bash", "zsh", "dash", "eval", "xargs"]);

// Structures that EXECUTE their content in the current shell: command
// substitution, backticks, parameter expansion in an executing position,
// and process substitution. Double quotes do NOT suppress the first two.
const EXECUTING_MARKERS = ["$(", "`", "${", "<("];

const LIFECYCLE_MENTION = /\b(kill|pkill|killall|nohup|systemctl|docker|podman|launchctl|reboot|shutdown)\b/;

// Lifecycle executables the recognizer knows (anything else is uncertain).
const KNOWN_LIFECYCLE_EXECUTABLES = new Set([
  "kill", "pkill", "killall", "nohup", "systemctl", "docker", "podman", "launchctl",
]);

// Recognized READ verbs of lifecycle executables: read-only diagnosis.
const LIFECYCLE_READ_VERBS = new Set([
  "status", "list", "show", "inspect", "ps", "logs", "info",
  "is-active", "is-enabled", "version",
]);

function firstToken(segment) {
  const m = segment.match(/^([A-Za-z_][A-Za-z0-9_\-./]*)/);
  return m ? m[1] : null;
}

function basename(exec) {
  const idx = exec.lastIndexOf("/");
  return idx >= 0 ? exec.slice(idx + 1) : exec;
}

/**
 * Detect substitutions that the shell will EXECUTE: command substitution,
 * backticks, parameter expansion, and process substitution. Single-quoted
 * spans are literal; double-quoted spans still execute $(...) and backticks.
 */
function hasExecutingSubstitution(text) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    // single quotes are fully literal: backslash has no escape semantics
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "$" || ch === "`") return true; // executes inside double quotes
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "$" || ch === "`") return true;
    if (ch === "<" && text[i + 1] === "(") return true; // process substitution
  }
  return false;
}

/**
 * The text a shell will actually execute/interpret: everything outside
 * single-quoted spans. Used to separate literal mentions from executing
 * content (a substitution's CONTENTS are what execute).
 */
function executingText(text) {
  let quote = null;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue; // single-quoted: literal, excluded
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else out += ch; // double-quoted content still executes substitutions
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Detect an unquoted output-redirection operator (`>`, `>>`, `n>`, `&>`),
 * independent of surrounding whitespace. A redirect writes — never a pure
 * read.
 */
function hasRedirect(text) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === ">") return true;
  }
  return false;
}

/** Any expansion marker anywhere (quoted or not): target unresolvable. */
function hasExpansionAnywhere(text) {
  return EXECUTING_MARKERS.some((m) => text.includes(m)) || /\$[A-Za-z_{]/.test(text);
}

function matchesRule(executable, firstArg, rule) {
  if (!rule.match || !Array.isArray(rule.match.executables)) return false;
  if (!rule.match.executables.includes(executable)) return false;
  if (rule.match.args) {
    // match the OPERATION POSITION: the first non-flag argument token, not
    // an arbitrary substring of the argument text
    if (!firstArg || firstArg.startsWith("-")) return false;
    return rule.match.args.some((re) => {
      try {
        return new RegExp(`^(?:${re})$`).test(firstArg);
      } catch {
        return false;
      }
    });
  }
  return true;
}

/**
 * Extract explicit target identifiers from a lifecycle segment. A bare PID
 * or a broad pkill pattern is NOT an explicit target (design §3.2). Returns
 * { targets: [...], multiTarget: bool }.
 */
function extractExplicitTargets(executable, restArgs) {
  // every non-flag operand after the verb is an affected target; more than
  // one is an unsupported form (never drop unresolved portions)
  const tokens = restArgs.split(/\s+/).filter((t) => t.length > 0);
  if (executable === "systemctl" || executable === "launchctl" || executable === "docker" || executable === "podman") {
    // rest starts with the verb: drop it, then keep non-flag operands
    const operands = tokens.slice(1).filter((t) => !t.startsWith("-"));
    return { targets: operands.slice(0, 1), multiTarget: operands.length > 1 };
  }
  if (executable === "nohup") {
    // nohup takes a COMMAND, not PIDs — its operands are not targets
    return { targets: [], multiTarget: false };
  }
  // kill/pkill/killall: rest starts with flags/operands (no verb). Skip flag
  // tokens and the values of value-taking flags (-s/-n/--signal); a bare PID
  // is NOT an explicit target (it does not identify the owner); multiple
  // remaining operands are an unsupported form for verification purposes
  const operands = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("-")) {
      if ((t === "-s" || t === "-n" || t === "--signal") && tokens[i + 1] && !tokens[i + 1].startsWith("-")) i++;
      continue;
    }
    operands.push(t);
  }
  return { targets: [], multiTarget: operands.length > 1 };
}

/**
 * Extract the CONTENTS of executing substitutions ($( ... ), backticks,
 * <( ... )) — those contents are what the shell executes. Literal
 * single-quoted text is excluded.
 */
function substitutionContents(text) {
  let quote = null;
  let out = "";
  let depth = 0;
  let backtick = false;
  const subs = [];
  const closeSub = () => {
    depth--;
    subs.push(out);
    out = ""; // preserve boundaries between adjacent substitutions
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (backtick) {
        if (ch === "`") backtick = false;
        else out += ch;
        continue;
      }
      if (depth > 0) {
        if (ch === "(") depth++;
        else if (ch === ")") closeSub();
        else out += ch;
        continue;
      }
      if ((ch === "$" || ch === "<") && text[i + 1] === "(") {
        depth = 1;
        i++;
        continue;
      }
      if (ch === "`") {
        backtick = true;
        continue;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (backtick) {
      if (ch === "`") backtick = false;
      else out += ch;
      continue;
    }
    if (depth > 0) {
      if (ch === "(") depth++;
      else if (ch === ")") closeSub();
      else out += ch;
      continue;
    }
    if ((ch === "$" || ch === "<") && text[i + 1] === "(") {
      depth = 1;
      i++;
      continue;
    }
    if (ch === "`") {
      backtick = true;
      continue;
    }
  }
  if (out.length > 0) subs.push(out);
  return subs;
}

function isProbeOrHelp(exec, firstArg, nextArg) {
  if (firstArg === "--help" || firstArg === "-h" || firstArg === "--version") return true;
  // signal 0 sends nothing: a permission probe (kill -0, pkill -0, killall -0)
  if ((exec === "kill" || exec === "pkill" || exec === "killall") && firstArg === "-0") return true;
  if ((exec === "kill" || exec === "pkill" || exec === "killall") && (firstArg === "-s" || firstArg === "-n") && nextArg === "0") return true;
  return false;
}

/**
 * Classify one command string against policy rules.
 *
 * Returns:
 *   kind                 'lifecycle' | 'non-lifecycle' | 'uncertain'
 *   executables          top-level executables understood per segment
 *   ruleIds              policy rules matched (lifecycle only)
 *   failureClass         failure class of the first matched rule
 *   destructive          true when ANY matched rule carries severity 'destructive'
 *   explicitTargets      explicit target identifiers when the grammar has them
 *   lifecycleInside      true when an uncertain command hides lifecycle execution
 *   notes                human-readable classification notes
 */
export function classifyCommand(command, policy) {
  const rules = (policy && Array.isArray(policy.rules)) ? policy.rules : [];
  const notes = [];
  const trimmed = String(command).trim();

  if (trimmed.length === 0) {
    return empty("empty input");
  }

  // strip unquoted comments in a SINGLE pass with quote state carried
  // across lines: a quote opened on one line can close on a later line, and
  // a quoted `#` is never a comment
  {
    let quote = null;
    let escaped = false;
    let lineStart = true;
    let out = "";
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (quote === "'") {
        out += ch;
        if (ch === "'") quote = null;
        continue;
      }
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escaped = true;
        continue;
      }
      if (quote) {
        out += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        out += ch;
        continue;
      }
      if (ch === "#" && (lineStart || /\s/.test(out[out.length - 1] || ""))) {
        // comment: skip to the end of this physical line
        const nl = trimmed.indexOf("\n", i);
        i = nl === -1 ? trimmed.length : nl;
        out += "\n";
        lineStart = true;
        continue;
      }
      if (ch === "\n") lineStart = true;
      else lineStart = false;
      out += ch;
    }
    const kept = out.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
    if (kept.length === 0) {
      return empty("comment-only input");
    }
    var commentFree = kept.join("\n");
  }
  const segments = splitSegments(commentFree);
  const executables = [];
  const ruleIds = [];
  let failureClass = null;
  let destructive = false;
  const explicitTargets = [];
  const operations = [];
  let operationCount = 0;
  let multiTarget = false;
  let sawLifecycle = false;
  let sawUncertain = false;
  let lifecycleInside = false;
  let sawHeredoc = false;

  for (const segment of segments) {
    let cursor = 0;
    let exec = null;
    let rest = "";

    // scan the segment with a monotonically advancing cursor
    while (true) {
      const step = nextToken(segment, cursor);
      if (step.token === null) break;
      if (step.raw) {
        sawUncertain = true;
        notes.push(`unparsed character ${JSON.stringify(step.token)} in segment`);
        break;
      }
      const tok = step.token;
      if (tok.includes("=") && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
        // environment assignment prefix: unsupported wrapper form
        sawUncertain = true;
        notes.push(`assignment prefix ${tok.split("=")[0]}=...`);
        break;
      }
      const name = basename(tok);
      if (PASSTHROUGH_EXECUTABLES.has(name)) {
        cursor = step.cursor;
        const peek = nextToken(segment, cursor);
        if (peek.token && peek.token.startsWith("-")) {
          // flags/values of passthrough wrappers cannot be confidently
          // resolved (e.g. `sudo -u root ...`) — uncertain, never safe
          sawUncertain = true;
          notes.push(`unresolvable ${name} flag ${peek.token}`);
          break;
        }
        continue; // consume the passthrough and scan the next token
      }
      cursor = step.cursor;
      exec = name;
      break;
    }

    if (!exec) {
      continue; // assignment/flag/unparsed: already flagged above
    }
    executables.push(exec);
    rest = segment.slice(cursor).trim();
    const firstArg = rest.split(/\s+/)[0] || "";
    const nextArg = rest.split(/\s+/)[1] || "";

    // heredoc structure: the body that follows is stdin, not a parsed
    // command — never confidently classified
    if (/(^|\s)<<|^<</.test(rest)) {
      sawHeredoc = true;
      sawUncertain = true;
      notes.push("heredoc structure: body is stdin, not a parsed command");
      continue;
    }

    // an executing substitution runs BEFORE any shortcut: double quotes do
    // not suppress command substitution, and process substitution executes
    if (hasExecutingSubstitution(segment)) {
      // only the substitution CONTENTS execute — literal single-quoted text
      // does not. A lifecycle word matters only in the COMMAND position of a
      // substitution (an argument to echo is not an execution).
      const subs = substitutionContents(segment);
      if (subs.some((s) => LIFECYCLE_MENTION.test(s.split(/\s+/)[0] || ""))) lifecycleInside = true;
      // a lifecycle executable with an executing substitution is a
      // recognized mutation with an unresolvable target — unless the
      // operation is a probe or read verb (signal 0 sends nothing)
      if (KNOWN_LIFECYCLE_EXECUTABLES.has(exec) && !isProbeOrHelp(exec, firstArg, nextArg) && !LIFECYCLE_READ_VERBS.has(firstArg)) {
        sawLifecycle = true;
      }
      notes.push("executing substitution present: unsupported structure");
      sawUncertain = true;
      continue;
    }

    // a redirect writes — never a pure read; unsupported for classification
    if (hasRedirect(segment)) {
      // a recognized lifecycle executable with a redirect is a recognized
      // mutation with unsupported syntax — never a generic uncertainty
      if (KNOWN_LIFECYCLE_EXECUTABLES.has(exec)) sawLifecycle = true;
      sawUncertain = true;
      notes.push("redirect present: unsupported structure");
      continue;
    }

    if (INDIRECTION_EXECUTABLES.has(exec)) {
      // indirection: uncertain; flag when a lifecycle executable is visible
      // inside the nested string
      if (LIFECYCLE_MENTION.test(rest)) lifecycleInside = true;
      notes.push(`indirection via ${exec}`);
      sawUncertain = true;
      continue;
    }

    if (READ_EXECUTABLES.has(exec)) {
      notes.push(`${exec} is a read/no-op executable; its arguments are not lifecycle execution`);
      continue;
    }

    if (KNOWN_LIFECYCLE_EXECUTABLES.has(exec) && isProbeOrHelp(exec, firstArg, nextArg)) {
      // probe/help check BEFORE rule matching: signal 0 sends nothing,
      // --help mutates nothing
      notes.push(`${exec} ${firstArg} is a probe/help invocation; it sends no signal and mutates nothing`);
      continue;
    }

    const matched = rules.filter((r) => matchesRule(exec, firstArg, r));
    if (matched.length > 0) {
      const t = extractExplicitTargets(exec, rest);
      if (t.multiTarget) {
        // unsupported multi-target / unrecognized-operand form: uncertain,
        // never partially verified — but the recognized mutation is retained
        notes.push(`${exec} with multiple targets: unsupported form`);
        sawLifecycle = true;
        sawUncertain = true;
        multiTarget = true;
        continue;
      }
      sawLifecycle = true;
      operationCount++;
      // the operation verb: the subcommand for multi-verb executables, the
      // executable itself for kill-family tools
      operations.push(exec === "systemctl" || exec === "launchctl" || exec === "docker" || exec === "podman" ? firstArg : exec);
      for (const r of matched) if (!ruleIds.includes(r.id)) ruleIds.push(r.id);
      if (!failureClass && matched[0].failure_class) failureClass = matched[0].failure_class;
      if (matched.some((r) => r.severity === "destructive")) destructive = true;
      if (t.targets[0] && !explicitTargets.includes(t.targets[0])) explicitTargets.push(t.targets[0]);
      continue;
    }

    if (KNOWN_LIFECYCLE_EXECUTABLES.has(exec)) {
      // recognized READ verb of a lifecycle executable, or unsupported form
      if (LIFECYCLE_READ_VERBS.has(firstArg)) {
        notes.push(`${exec} ${firstArg} is a read-only diagnosis verb`);
        continue;
      }
      notes.push(`${exec} in unsupported form`);
      sawUncertain = true;
      continue;
    }

    // unknown executable: not confidently safe — visible as uncertain
    notes.push(`executable ${exec} is not covered by any rule`);
    sawUncertain = true;
  }

  // a heredoc body that mentions lifecycle executables would execute them
  // through the interpreter reading stdin
  if (sawHeredoc && commentFree.split("\n").some((s) => LIFECYCLE_MENTION.test(s))) {
    lifecycleInside = true;
  }
  // a lifecycle segment combined with any uncertain structure (indirection,
  // expansion, unsupported form) is a recognized mutation with unresolved
  // structure — never confidently safe
  if (sawLifecycle && sawUncertain) {
    lifecycleInside = true;
  }

  if (sawLifecycle && !sawUncertain) {
    return { kind: "lifecycle", executables, ruleIds, failureClass, destructive, explicitTargets, operations, operationCount, multiTarget, lifecycleInside, notes };
  }
  if (sawUncertain) {
    return { kind: "uncertain", executables, ruleIds, failureClass, destructive, explicitTargets, operations, operationCount, multiTarget, lifecycleInside, notes };
  }
  return { kind: "non-lifecycle", executables, ruleIds, failureClass: null, destructive: false, explicitTargets: [], operations: [], operationCount: 0, multiTarget: false, lifecycleInside: false, notes };

  function empty(note) {
    notes.push(note);
    return { kind: "non-lifecycle", executables: [], ruleIds: [], failureClass: null, destructive: false, explicitTargets: [], operations: [], operationCount: 0, multiTarget: false, lifecycleInside: false, notes };
  }
}

function nextToken(text, cursor) {
  while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
  if (cursor >= text.length) return { token: null, cursor };
  const m = text.slice(cursor).match(/^[A-Za-z_][A-Za-z0-9_\-./=]*/);
  if (!m) return { token: text[cursor], cursor: cursor + 1, raw: true };
  return { token: m[0], cursor: cursor + m[0].length };
}

/**
 * Target confidence per design §3.2. `verified` requires adapter-supplied
 * evidence BOUND to the exact operation and every affected target:
 *   { target, ruleId, evidence, resolved? }
 * - ruleId must be one of the classification's matched rules (binds the
 *   applicable managed operation).
 * - target must match an explicitTarget; when the grammar carries no
 *   explicit target (bare PID / broad pattern), `resolved: true` is
 *   required — an explicit adapter resolution binding, not merely any
 *   target string.
 * Anything else yields at most `candidate`; no explicit target yields
 * `unknown`.
 */
export function targetConfidence({ classification, verifiedTarget }) {
  const vt = verifiedTarget;
  const bound =
    vt &&
    typeof vt === "object" &&
    typeof vt.target === "string" && vt.target.length > 0 &&
    typeof vt.ruleId === "string" && classification.ruleIds.includes(vt.ruleId) &&
    typeof vt.operation === "string" && classification.operations.includes(vt.operation) &&
    typeof vt.evidence === "string" && vt.evidence.length > 0;
  if (!bound) {
    if (classification.explicitTargets.length > 0) return "candidate";
    return "unknown";
  }
  // evidence binds ONE operation on ONE target: a compound with multiple
  // mutations or affected targets needs per-operation evidence — partial
  // verification is never verified
  if (classification.operationCount > 1 || classification.explicitTargets.length > 1) return "candidate";
  if (classification.explicitTargets.length > 0) {
    return vt.target === classification.explicitTargets[0] ? "verified" : "candidate";
  }
  // no explicit target in the grammar (bare PID / broad pattern): require an
  // explicit adapter resolution binding
  if (vt.resolved === true) return "verified";
  return "unknown";
}

/**
 * Decision calculation per design §3.3. Pure: returns the action and reason;
 * the adapter executes (or declines to execute) the decision.
 *
 * mode: 'shadow' | 'enforce'
 * confidence: 'unknown' | 'candidate' | 'verified' | 'stale'
 * integrity: true when the adapter detected tampering or unsafe
 *   self-maintenance for THIS operation
 *
 * Precedence: recognized read-only diagnosis → integrity → stale
 * degradation → uncertainty → verified coverage. Destructive severity and
 * approval are evaluated PER RULE: hard-deny requires a destructive rule
 * that is separately approved in policy.hard_deny; an unapproved destructive
 * rule holds rather than soft-denying through it. Soft-deny requires a
 * VALIDATED alternative contract { command, source, gate } for every matched
 * rule; without one the decision is a missing-precondition hold.
 */
export function decide({ classification, confidence, mode, policy, integrity }) {
  const shadow = mode !== "enforce";
  const { kind, destructive, ruleIds, lifecycleInside } = classification;
  const recognizedMutation = kind === "lifecycle" || lifecycleInside || ruleIds.length > 0;
  const hardRules = (policy && Array.isArray(policy.hard_deny)) ? policy.hard_deny : [];

  if (kind === "non-lifecycle") {
    // recognized read-only diagnosis: always available, even under integrity
    return { action: "allow", reasonCode: "non-lifecycle", ruleIds: [], alternative: null, protectionClaimed: false };
  }

  if (integrity) {
    // adapter-detected tampering or unsafe self-maintenance for THIS
    // operation: hold regardless of lifecycle recognition
    return shadow
      ? { action: "log-proposed-refusal", reasonCode: "control-integrity", ruleIds, alternative: null, protectionClaimed: true }
      : { action: "integrity-hold", reasonCode: "control-integrity", ruleIds, alternative: null, protectionClaimed: true };
  }

  if (confidence === "stale" && recognizedMutation) {
    return shadow
      ? { action: "log-degradation", reasonCode: "stale-authority", ruleIds, alternative: null, protectionClaimed: false }
      : { action: "ownership-hold", reasonCode: "stale-authority", ruleIds, alternative: null, protectionClaimed: false };
  }

  if (kind === "uncertain") {
    if (lifecycleInside) {
      return shadow
        ? { action: "log-uncertainty", reasonCode: "indirected-lifecycle", ruleIds: [], alternative: null, protectionClaimed: false }
        : { action: "ownership-hold", reasonCode: "indirected-lifecycle", ruleIds: [], alternative: null, protectionClaimed: false };
    }
    return shadow
      ? { action: "log-uncertainty", reasonCode: "unsupported-shape", ruleIds: [], alternative: null, protectionClaimed: false }
      : { action: "allow", reasonCode: "unsupported-shape", ruleIds: [], alternative: null, protectionClaimed: false };
  }

  // kind === 'lifecycle'
  if (confidence !== "verified") {
    return shadow
      ? { action: "log-uncertainty", reasonCode: "unresolved-ownership", ruleIds, alternative: null, protectionClaimed: false }
      : { action: "ownership-hold", reasonCode: "unresolved-ownership", ruleIds, alternative: null, protectionClaimed: false };
  }

  // verified target authority: evaluate severity and approval PER RULE and
  // preserve the strongest applicable decision
  const rules = (policy && Array.isArray(policy.rules)) ? policy.rules : [];
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  let anyUnapprovedDestructive = false;
  const sourcedAlternatives = [];
  for (const id of ruleIds) {
    const rule = ruleById.get(id);
    const alt = policy && policy.alternatives && policy.alternatives[id];
    const altValid = isValidAlternative(alt);
    if (rule && rule.severity === "destructive") {
      if (hardRules.includes(id) && altValid) {
        // separately approved destructive rule → hard-deny (strongest)
        return shadow
          ? { action: "log-proposed-hard-deny", reasonCode: "destructive-rule", ruleIds, alternative: null, protectionClaimed: true }
          : { action: "hard-deny", reasonCode: "destructive-rule", ruleIds, alternative: null, protectionClaimed: true };
      }
      if (!hardRules.includes(id)) {
        anyUnapprovedDestructive = true;
      }
    }
    if (altValid) sourcedAlternatives.push(alt);
  }
  if (anyUnapprovedDestructive) {
    // a destructive rule without separate approval holds rather than
    // soft-denying through it
    return shadow
      ? { action: "log-uncertainty", reasonCode: "unapproved-destructive-rule", ruleIds, alternative: null, protectionClaimed: false }
      : { action: "ownership-hold", reasonCode: "unapproved-destructive-rule", ruleIds, alternative: null, protectionClaimed: false };
  }
  if (sourcedAlternatives.length < ruleIds.length) {
    // every matched rule needs a sourced alternative for scoped soft-deny
    return shadow
      ? { action: "log-uncertainty", reasonCode: "no-sourced-alternative", ruleIds, alternative: null, protectionClaimed: false }
      : { action: "ownership-hold", reasonCode: "no-sourced-alternative", ruleIds, alternative: null, protectionClaimed: false };
  }
  return shadow
    ? { action: "log-proposed-soft-deny", reasonCode: "managed-coverage", ruleIds, alternative: sourcedAlternatives[0], protectionClaimed: true }
    : { action: "soft-deny", reasonCode: "managed-coverage", ruleIds, alternative: sourcedAlternatives[0], protectionClaimed: true };
}

/**
 * A validated alternative contract carries the exact managed command, its
 * source binding, and the known gate status — never a bare string or a
 * truthy placeholder.
 */
function isValidAlternative(alt) {
  return (
    alt &&
    typeof alt === "object" &&
    typeof alt.command === "string" && alt.command.length > 0 &&
    typeof alt.source === "string" && alt.source.length > 0 &&
    typeof alt.gate === "string"
  );
}
