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
  // empty segments are KEPT: a trailing or doubled separator (kill 1 &&,
  // kill 1 ;; echo hi) is malformed list syntax — classifyCommand marks it
  // uncertain instead of silently flattening it away
  return segments.map((s) => s.trim());
}

/**
 * Truncate a segment at an unquoted, unescaped `#` (shell: a comment runs
 * to the end of the line). Single and double quotes are tracked; a
 * backslash escapes the next character.
 */
function stripComment(segment) {
  let quote = null;
  let escaped = false;
  let subDepth = 0;
  let sawSubOpen = false; // nested quote state inside $(...) is ambiguous
  // for a single-flag scanner: once a substitution opener has been seen,
  // a # is kept (never stripped) so a separately executing mutation after
  // the substitution cannot be erased
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
      // command substitution inside double quotes still executes
      if (ch === "$" && segment[i + 1] === "(") sawSubOpen = true;
      if (ch === quote) quote = null;
      continue;
    }
    if (subDepth > 0) {
      if (ch === "(") subDepth++;
      else if (ch === ")") subDepth--;
      continue;
    }
    if ((ch === "$" || ch === "<") && segment[i + 1] === "(") {
      subDepth = 1;
      sawSubOpen = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && !sawSubOpen && (i === 0 || /\s/.test(segment[i - 1]))) {
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

// POSITIVE per-executable supported short-option sets for read tools:
// only these clusters are read-only forms; anything else (including
// command-bearing -P/-H pagers) is uncertain. Long options other than
// --help are unsupported.
const READ_SUPPORTED_SHORTS = new Map([
  ["date", /^[uRh]+$/],
  ["man", /^h+$/],
  ["rg", /^[nilFcvwh]+$/],
  ["grep", /^[nilFcvwhE]+$/],
  ["ls", /^[laRhtrSdFA]+$/],
]);

// Prefix executables that do not change the underlying operation when they
// appear WITHOUT flags. A passthrough flag cannot be confidently resolved
// (e.g. `sudo -u root ...`) and classifies as uncertain.
const PASSTHROUGH_EXECUTABLES = new Set(["sudo", "doas", "nice", "env", "command", "exec"]);

// Known long options on lifecycle executables (explicitly supported); any
// other long option means the form is unsupported (uncertain).
const KNOWN_LONG_OPTIONS = new Set([
  "--signal", "--help", "--version", "--no-pager", "--quiet",
  "--parent", "--older", "--newest", "--ns", "--nslist",
]);

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

// Per-executable read verbs: a verb is a read-only diagnosis operation
// only for the executables that actually support it.
const READ_VERBS_BY_EXEC = new Map([
  ["systemctl", new Set(["status", "show", "is-active", "is-enabled", "cat"])],
  ["docker", new Set(["ps", "logs", "inspect", "info", "version", "stats"])],
  ["podman", new Set(["ps", "logs", "inspect", "info", "version", "stats"])],
  ["launchctl", new Set(["list", "print", "info"])],
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
    // input redirection also writes nothing but restructures the command —
    // never confidently classified (a heredoc << is handled separately)
    if (ch === "<" && text[i + 1] !== "<") return true;
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
function extractExplicitTargets(executable, restArgs, firstVerb) {
  // every non-flag operand after the verb is an affected target; more than
  // one is an unsupported form (never drop unresolved portions)
  const tokens = restArgs.split(/\s+/).filter((t) => t.length > 0);
  // expansion/glob/escape/quoting/redirect/paren metacharacters mean the
  // shell supplies operands the grammar cannot resolve ({a,b}, *.service,
  // foo\\ escaped, "quoted", ~, 1<input) — never an explicit target
  const unsupported = tokens.some((t) => /[{}*?[\\"'~<>()]/.test(t));
  if (unsupported) return { targets: [], multiTarget: false, unsupported: true };
  if (executable === "nohup") {
    // nohup takes a COMMAND: its operands are command-bearing and the
    // nested form is not explicitly supported — the launch attempt is
    // recognized but the operands are uncertain
    return { targets: [], multiTarget: false, unsupported: true };
  }
  const isKillFamily = executable === "kill" || executable === "pkill" || executable === "killall";
  const verb = isKillFamily ? null : firstVerb;
  const spec = optionSpecFor(executable, verb);
  if (!spec) {
    // no option grammar for this executable: plain literal operands only —
    // any option token means the form is unsupported
    if (tokens.some((t) => t.startsWith("-"))) {
      return { targets: [], multiTarget: false, unsupported: true };
    }
    return { targets: [], multiTarget: tokens.length > 1 };
  }
  // kill-family: rest starts with flags/operands (no verb); multi-verb
  // executables: rest starts with the verb (dropped)
  const args = isKillFamily ? tokens : tokens.slice(1);
  const operands = [];
  let noMoreFlags = false;
  let sawOperand = false;
  const seenOptions = new Set();
  let sawReadOnlyOnly = true;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (!noMoreFlags) {
      if (t === "--") {
        noMoreFlags = true;
        continue;
      }
      if (t.startsWith("-")) {
        // option-position rule: a flag AFTER an operand is an ambiguous
        // position — unsupported (kill 123 -9)
        if (sawOperand) return { targets: [], multiTarget: false, unsupported: true };
        const isShort = t.length === 2 && spec.shorts.test(t.slice(1));
        const isLong = spec.long.has(t);
        if (!isShort && !isLong) {
          return { targets: [], multiTarget: false, unsupported: true };
        }
        // repeated options are ambiguous (kill -9 -9 123) — unsupported
        if (seenOptions.has(t)) return { targets: [], multiTarget: false, unsupported: true };
        seenOptions.add(t);
        if (isShort && !(spec.readOnlyShorts && spec.readOnlyShorts.has(t.slice(1)))) sawReadOnlyOnly = false;
        if (isLong && t !== "--help" && t !== "--version") sawReadOnlyOnly = false;
        // value-taking options consume the next token as their VALUE —
        // a missing value means the form is incomplete (unsupported)
        const takesValue = (t.length === 2 && spec.valueShorts.has(t.slice(1))) || spec.valueLong.has(t);
        if (takesValue) {
          if (!args[i + 1] || args[i + 1].startsWith("-")) {
            return { targets: [], multiTarget: false, unsupported: true };
          }
          // supported value types: a stop timeout must be an integer, a
          // signal a number or name — anything else is unsupported
          if (spec.valueRegex && !spec.valueRegex.test(args[i + 1])) {
            return { targets: [], multiTarget: false, unsupported: true };
          }
          i++;
        }
        continue;
      }
    }
    sawOperand = true;
    operands.push(t);
  }
  if (isKillFamily) {
    // a supported kill form requires a target operand: kill -s 9 with no
    // PID is incomplete — uncertain. When every flag is a read-only
    // diagnosis flag (kill -l, kill -L), the operands are diagnosis
    // subjects (signal-number conversion), not mutation targets
    if (operands.length === 0) {
      if (spec.requireTarget && seenOptions.size > 0 && sawReadOnlyOnly) {
        return { targets: [], multiTarget: false, readOnly: true };
      }
      return { targets: [], multiTarget: false, unsupported: true };
    }
    if (spec.requireTarget && sawReadOnlyOnly && seenOptions.size > 0) {
      return { targets: [], multiTarget: false, readOnly: true };
    }
    // a bare PID is NOT an explicit target (it does not identify the
    // owner); multiple remaining operands are an unsupported form for
    // verification purposes
    return { targets: [], multiTarget: operands.length > 1 };
  }
  // multi-verb executables require a remaining literal target: an option
  // consumed it or it is missing — the form is incomplete (uncertain).
  // launchctl kill requires a signal AND a service target (2 operands)
  const required = spec.requireOperands || 1;
  if (operands.length < required) return { targets: [], multiTarget: false, unsupported: true };
  if (operands.length > Math.max(required, 1)) return { targets: [], multiTarget: true, unsupported: false };
  const targetPosition = spec.targetPosition || 0;
  return { targets: operands.length > targetPosition ? [operands[targetPosition]] : [], multiTarget: false };
}

/**
 * Extract the CONTENTS of executing substitutions ($( ... ), backticks,
 * <( ... )) — those contents are what the shell executes. Literal
 * single-quoted text is excluded.
 */
function subMutatesLifecycle(s) {
  // one substitution may contain several commands (true; kill 1) — check the
  // command position of each; separators inside quotes are argument text,
  // not command separators (echo "x; kill 1" runs echo). An argument to echo
  // is not an execution, and the operation must itself be a mutation (not a
  // read verb or probe).
  for (const part of quoteAwareCommands(s)) {
    const words = part.trim().split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) continue;
    const cmd = basename(words[0]);
    if (!KNOWN_LIFECYCLE_EXECUTABLES.has(cmd)) continue;
    const sArg = words[1] || "";
    const sNext = words[2] || "";
    if (isReadOperation(cmd, sArg)) continue;
    if (isProbeOrHelp(cmd, sArg, sNext)) continue;
    return true;
  }
  return false;
}

// Split a command string on ; & | only OUTSIDE single/double quotes — a
// separator inside quotes is argument text, not a command separator.
function quoteAwareCommands(text) {
  const parts = [];
  let current = "";
  let quote = null;
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|") {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

// Read-verb semantics are PER EXECUTABLE: systemctl/docker/launchctl take
// read subcommands (status, list, ps); for kill-family tools ANY operand is
// a process selection or pattern — never a read operation (pkill status is
// a mutation).
function isReadOperation(exec, arg) {
  if (exec === "kill" || exec === "pkill" || exec === "killall" || exec === "nohup") return false;
  // read verbs are PER EXECUTABLE: docker has no is-active, systemctl has
  // no ps, launchctl has no inspect — an unlisted verb is not a read
  // operation for that executable
  const execVerbs = READ_VERBS_BY_EXEC.get(exec);
  if (execVerbs) return execVerbs.has(arg);
  return LIFECYCLE_READ_VERBS.has(arg);
}

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
  const closeBacktick = () => {
    backtick = false;
    subs.push(out);
    out = ""; // backtick substitutions are separate commands
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      // single-quoted text is literal — but PRESERVE it (quotes included)
      // so downstream quote-aware parsing sees the argument boundaries
      if (depth > 0) out += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (depth > 0) out += ch;
      if (ch === '"') {
        quote = null;
        continue;
      }
      // command substitution inside double quotes still executes
      if ((ch === "$" || ch === "<") && text[i + 1] === "(") {
        depth++;
        i++;
        continue;
      }
      // backtick substitution inside double quotes still executes
      if (ch === "`") {
        if (backtick) closeBacktick();
        else backtick = true;
        continue;
      }
      if (backtick) out += ch;
      continue; // everything else inside dquotes is literal content
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      if (depth > 0) out += ch;
      continue;
    }
    if (backtick) {
      if (ch === "`") closeBacktick();
      else out += ch;
      continue;
    }
    if (depth > 0) {
      if (ch === "(") depth++;
      else if (ch === ")") closeSub();
      else if ((ch === "$" || ch === "<") && text[i + 1] === "(") {
        depth++;
        i++;
      } else out += ch;
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

// Executable-specific option grammars for lifecycle tools: known short
// options (single char), known long options, and which of them take a
// VALUE (the next token is consumed as the option's value, never a target).
// Anything outside the grammar is unsupported.
const LIFECYCLE_OPTION_SPECS = {
  kill: {
    shorts: /^[\dlLhns]$/,
    long: new Set(["--signal", "--help", "--version"]),
    valueShorts: new Set(["s", "n"]),
    valueLong: new Set(["--signal"]),
    valueRegex: /^\d+$|^(SIG)?[A-Z][A-Z0-9]*$/,
    readOnlyShorts: new Set(["l", "L", "h"]),
    requireTarget: true,
  },
  pkill: {
    // pkill has no -l/-L diagnosis options and no -w (installed help);
    // -g/-t/-u consume values (group/terminal/user selection)
    shorts: /^[\dhnfexicgtuos]$/,
    long: new Set(["--signal", "--parent", "--older", "--newest", "--ns", "--nslist", "--help", "--version"]),
    valueShorts: new Set(["s", "g", "t", "u"]), // pkill -n is BOOLEAN (newest process)
    valueLong: new Set(["--signal", "--parent", "--older", "--ns", "--nslist"]), // --newest is boolean
    readOnlyShorts: new Set(["h"]),
    requireTarget: true,
  },
  killall: {
    // killall has no -t and declares no --parent/--newest/--nslist;
    // -n/-o/-u consume values (installed help)
    shorts: /^[\dhnfexicuos]$/,
    long: new Set(["--signal", "--older", "--help", "--version"]),
    valueShorts: new Set(["s", "n", "o", "u"]),
    valueLong: new Set(["--signal", "--older"]),
    readOnlyShorts: new Set(["h"]),
    requireTarget: true,
  },
  // docker/podman option semantics are VERB-specific: kill -s takes a
  // signal, rm has no -t, stop -t takes a timeout
  "docker:kill": {
    shorts: /^[s]$/, // docker kill has no -t
    long: new Set(["--signal", "--help", "--version"]),
    valueShorts: new Set(["s"]),
    valueLong: new Set(["--signal"]),
    valueRegex: /^\d+$|^(SIG)?[A-Z][A-Z0-9]*$/i,
  },
  "docker:rm": {
    shorts: /^[fl]$/,
    long: new Set(["--force", "--help", "--version"]),
    valueShorts: new Set(),
    valueLong: new Set(),
  },
  "docker:stop": {
    shorts: /^[t]$/, // docker stop has no -l
    long: new Set(["--time", "--help", "--version"]),
    valueShorts: new Set(["t"]),
    valueLong: new Set(["--time"]),
    valueRegex: /^\d+$/, // the stop timeout requires an integer
  },
  "docker:*": {
    shorts: /^$/,
    long: new Set(["--help", "--version"]),
    valueShorts: new Set(),
    valueLong: new Set(),
  },
  "podman:kill": {
    shorts: /^[s]$/,
    long: new Set(["--signal", "--help", "--version"]),
    valueShorts: new Set(["s"]),
    valueLong: new Set(["--signal"]),
    valueRegex: /^\d+$|^(SIG)?[A-Z][A-Z0-9]*$/i,
  },
  "podman:rm": {
    shorts: /^[fl]$/,
    long: new Set(["--force", "--help", "--version"]),
    valueShorts: new Set(),
    valueLong: new Set(),
  },
  "podman:stop": {
    shorts: /^[t]$/,
    long: new Set(["--time", "--help", "--version"]),
    valueShorts: new Set(["t"]),
    valueLong: new Set(["--time"]),
    valueRegex: /^\d+$/,
  },
  "podman:*": {
    shorts: /^$/,
    long: new Set(["--help", "--version"]),
    valueShorts: new Set(),
    valueLong: new Set(),
  },
  systemctl: {
    shorts: /^$/,
    long: new Set(["--no-pager", "--quiet", "--help", "--version"]),
    valueShorts: new Set(),
    valueLong: new Set(),
  },
  launchctl: {
    shorts: /^$/,
    long: new Set(["--help", "--version"]),
    valueShorts: new Set(),
    valueLong: new Set(),
  },
  // launchctl kill takes a signal AND a service target: the target is the
  // SECOND operand (the signal is not an affected target)
  "launchctl:kill": {
    shorts: /^$/,
    long: new Set(["--help", "--version"]),
    valueShorts: new Set(),
    valueLong: new Set(),
    requireOperands: 2,
    targetPosition: 1,
  },
};

function optionSpecFor(exec, verb) {
  return LIFECYCLE_OPTION_SPECS[`${exec}:${verb}`] || LIFECYCLE_OPTION_SPECS[`${exec}:*`] || LIFECYCLE_OPTION_SPECS[exec] || null;
}

// Split on whitespace only OUTSIDE single/double quotes — a quoted
// argument stays one token (echo "kill -9 1").
function hasUnquotedParens(token) {
  // unquoted parentheses are unsupported shell syntax in a read operand
  // (rg (a) file); parentheses inside quotes are literal (grep "(a)" file).
  // A backslash escapes only outside single quotes (literal inside them).
  let quote = null;
  let escaped = false;
  for (const ch of token) {
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(" || ch === ")") return true;
  }
  return false;
}

function quoteAwareWhitespaceTokens(text) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const ch of text) {
    // a backslash escapes the next character OUTSIDE single quotes: an
    // escaped quote (foo\") does NOT open a quote span — the following
    // tokens stay separate. Inside single quotes a backslash is LITERAL
    // (no escape semantics), so '\' closes the quote normally.
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
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function isProbeOrHelp(exec, firstArg, nextArg) {
  if (firstArg === "--help" || firstArg === "-h" || firstArg === "--version") return true;
  // signal-0 probe semantics are PER EXECUTABLE: kill -s/-n select the
  // signal, but pkill -s selects SESSIONS and pkill -n the NEWEST process —
  // neither sends signal 0, and pkill/killall default to termination
  if (exec === "kill") {
    if (firstArg === "-0") return true;
    if ((firstArg === "-s" || firstArg === "-n") && nextArg === "0") return true;
  }
  if ((exec === "pkill" || exec === "killall") && firstArg === "-0") return true;
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
    let subDepth = 0;
    let sawSubOpen = false; // nested quote state inside $(...) is ambiguous
    // for a single-flag scanner: once a substitution opener has been seen,
    // a # is kept (never stripped) so a separately executing mutation after
    // the substitution cannot be erased
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
        // command substitution inside double quotes still executes
        if (ch === "$" && trimmed[i + 1] === "(") sawSubOpen = true;
        out += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (subDepth > 0) {
        if (ch === "(") subDepth++;
        else if (ch === ")") subDepth--;
        out += ch;
        continue;
      }
      if ((ch === "$" || ch === "<") && trimmed[i + 1] === "(") {
        subDepth = 1;
        sawSubOpen = true;
        out += ch;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        out += ch;
        continue;
      }
      if (ch === "#" && !sawSubOpen && (lineStart || /\s/.test(out[out.length - 1] || ""))) {
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

  // an empty segment means a trailing or doubled separator (kill 1 &&,
  // kill 1 ;; echo hi, echo hi |) — malformed list syntax, never flattened
  // into valid segments
  for (const segment of segments) {
    if (segment.trim().length === 0) { sawUncertain = true; continue; }
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
      const nextChar = segment[step.cursor];
      if (nextChar && !/\s/.test(nextChar)) {
        // the executable word continues with characters the supported
        // grammar does not cover (echo:custom, echo*, echo[0], echo"x,
        // foo\\bar): the complete word is not a supported executable
        // spelling — uncertain, never a confident classification
        sawUncertain = true;
        notes.push(`executable word ${tok}${nextChar} is not a complete supported spelling`);
        break;
      }
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
      // assignment/flag/unparsed: already flagged above — but an executing
      // substitution still executes even without a top-level executable
      if (hasExecutingSubstitution(segment)) {
        const subs = substitutionContents(segment);
        if (subs.some(subMutatesLifecycle)) lifecycleInside = true;
        notes.push("executing substitution present: unsupported structure");
        sawUncertain = true;
      }
      continue;
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
      // substitution (an argument to echo is not an execution), and the
      // operation must itself be a mutation (not a read verb or probe).
      const subs = substitutionContents(segment);
      if (subs.some(subMutatesLifecycle)) lifecycleInside = true;
      // a lifecycle executable with an executing substitution is a
      // recognized mutation with an unresolvable target — unless the
      // operation is a probe or read verb (signal 0 sends nothing)
      if (KNOWN_LIFECYCLE_EXECUTABLES.has(exec) && !isProbeOrHelp(exec, firstArg, nextArg) && !isReadOperation(exec, firstArg)) {
        sawLifecycle = true;
        operationCount++;
      }
      notes.push("executing substitution present: unsupported structure");
      sawUncertain = true;
      continue;
    }

    // a redirect writes — never a pure read; unsupported for classification
    if (hasRedirect(segment)) {
      // a recognized lifecycle MUTATION with a redirect is a recognized
      // mutation with unsupported syntax — read/probe verbs stay uncertain
      // without inventing a lifecycle mutation
      if (KNOWN_LIFECYCLE_EXECUTABLES.has(exec) && !isReadOperation(exec, firstArg) && !isProbeOrHelp(exec, firstArg, nextArg)) {
        sawLifecycle = true;
        operationCount++;
      }
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
      // POSITIVE read grammars: the entire argument list is validated —
      // only explicitly supported option forms and operand spellings are
      // read-only. Long options other than --help (date --set, rg --pre),
      // dangerous short options (date -s, man -P), quoted/escaped spellings
      // (date "-s", rg \\--pre), and date positional operands (which SET the
      // time) are uncertain, never silently safe.
      // quote-aware tokenization: a quoted argument (echo "kill -9 1") is
      // one token, not option pieces
      const readArgs = quoteAwareWhitespaceTokens(rest);
      const dateOnly = exec === "date";
      // POSITIVE enumeration: only explicitly supported short-option sets
      // per executable; unlisted read executables support only -h/--help
      const supportedShorts = READ_SUPPORTED_SHORTS.get(exec) || /^h+$/;
      let bad = null;
      for (const t of readArgs) {
        // unwrap quoted/escaped spellings before the option grammar: a
        // quoted option (date "-s") is still an option, while quoted
        // arguments (echo "kill 1") remain ordinary operands
        const unwrapped = t.replace(/^["'\\]+|["'\\]+$/g, "");
        if (unwrapped.startsWith("-")) {
          if (unwrapped === "--help" || unwrapped === "-h") continue;
          if (unwrapped.startsWith("--")) { bad = t; break; } // long options unsupported
          if (!supportedShorts.test(unwrapped.slice(1))) { bad = t; break; }
        } else {
          if (dateOnly) { bad = t; break; } // any positional sets the time
          // brace/glob/extglob expansion in an operand can produce the
          // very command-bearing options the option grammar rejects —
          // uncertain (@(--pre), +(--pre), * , {a,b})
          if (/[{}*?[]/.test(unwrapped) || /[+@!]\(/.test(unwrapped) || hasUnquotedParens(t)) { bad = t; break; }
        }
      }
      let quoteCount = 0;
      let inSingle = false;
      let qEscaped = false;
      for (const ch of rest) {
        if (inSingle) {
          // a backslash inside single quotes is literal (no escapes)
          if (ch === "'") { quoteCount++; inSingle = false; }
          continue;
        }
        if (qEscaped) { qEscaped = false; continue; }
        if (ch === "\\") { qEscaped = true; continue; }
        if (ch === "'") { quoteCount++; inSingle = true; continue; }
        if (ch === '"') quoteCount++;
      }
      if (quoteCount % 2 !== 0 || inSingle) bad = bad || rest.trim();
      if (bad) {
        notes.push(`${exec} with unsupported argument ${bad}: unsupported read form`);
        sawUncertain = true;
        continue;
      }
      notes.push(`${exec} is a read/no-op executable; its arguments are not lifecycle execution`);
      continue;
    }

    if (KNOWN_LIFECYCLE_EXECUTABLES.has(exec) && isProbeOrHelp(exec, firstArg, nextArg)) {
      // probe/help check BEFORE rule matching: signal 0 sends nothing,
      // --help mutates nothing. A CLEAN probe carries no further options
      // and every operand spelling is supported: trailing options (pkill
      // -0 --signal 9), quoted option spellings ("--signal"), and
      // metacharacter operands (*.pid) change the operation conservatively
      // — uncertain, never a confident probe
      const probeArgs = rest.split(/\s+/).filter((t) => t.length > 0).slice(1);
      // ANY trailing option — including a repeated first-option token —
      // means the form is not a complete signal-zero probe (kill -s 0 -s 9
      // sends signal 9)
      const hasTrailingOption = probeArgs.some((t) => t.startsWith("-"));
      const badSpelling = probeArgs.some((t) => /[{}*?[\\"'~<>()]/.test(t));
      // a complete signal-zero probe requires at least one operand AFTER
      // the probe flag and its value: kill -0, kill -s 0 (the 0 is the
      // signal value) are incomplete invocations — uncertain. Help/version
      // probes need no operand.
      let probeOperands = probeArgs;
      if ((firstArg === "-s" || firstArg === "-n") && probeArgs.length > 0) probeOperands = probeArgs.slice(1);
      const needsOperand = firstArg === "-0" || firstArg === "-s" || firstArg === "-n";
      if (!hasTrailingOption && !badSpelling && (!needsOperand || probeOperands.length > 0)) {
        notes.push(`${exec} ${firstArg} is a probe/help invocation; it sends no signal and mutates nothing`);
        continue;
      }
      if (!hasTrailingOption && !badSpelling) {
        notes.push(`${exec} probe without an operand: incomplete invocation`);
        sawUncertain = true;
        continue;
      }
      notes.push(`${exec} probe with trailing options/unsupported spellings: unsupported form`);
      sawUncertain = true;
      continue;
    }

    const matched = rules.filter((r) => matchesRule(exec, firstArg, r));
    if (matched.length > 0) {
      const t = extractExplicitTargets(exec, rest, firstArg);
      if (t.readOnly) {
        // every flag is a read-only diagnosis flag (kill -l lists signal
        // names) — not a mutation
        notes.push(`${exec} ${firstArg} is a read-only diagnosis invocation`);
        continue;
      }
      if (t.unsupported) {
        // unsupported options/operands/metacharacters: the grammar cannot
        // resolve the form — uncertain, never an invented target
        notes.push(`${exec} with unsupported operands/options: unsupported form`);
        sawLifecycle = true;
        sawUncertain = true;
        operationCount++;
        operations.push(exec === "systemctl" || exec === "launchctl" || exec === "docker" || exec === "podman" ? firstArg : exec);
        for (const r of matched) if (!ruleIds.includes(r.id)) ruleIds.push(r.id);
        continue;
      }
      if (t.multiTarget) {
        // unsupported multi-target / unrecognized-operand form: uncertain,
        // never partially verified — but the recognized mutation is retained
        notes.push(`${exec} with multiple targets: unsupported form`);
        sawLifecycle = true;
        sawUncertain = true;
        operationCount++;
        operations.push(exec === "systemctl" || exec === "launchctl" || exec === "docker" || exec === "podman" ? firstArg : exec);
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
      if (isReadOperation(exec, firstArg)) {
        // a complete read form: trailing options and unsupported operands
        // are not confidently safe (systemctl status --future-flag,
        // systemctl status *.service → uncertain). A read verb takes no
        // value-taking options (docker ps --time is not a ps option) and
        // needs no target operand.
        const spec = optionSpecFor(exec, firstArg);
        const readTokens = rest.split(/\s+/).filter((t) => t.length > 0).slice(1);
        const bad = readTokens.find((t) =>
          (t.startsWith("-") && !(t === "--help" || t === "-h" || (spec && t.length === 2 && spec.shorts.test(t.slice(1)) && !spec.valueShorts.has(t.slice(1))))) ||
          (!t.startsWith("-") && /[{}*?[\\"'~<>()]/.test(t))
        );
        if (bad) {
          notes.push(`${exec} ${firstArg} with unsupported option/operand ${bad}: unsupported form`);
          sawUncertain = true;
          continue;
        }
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
  // verified requires a COMPLETE supported form: uncertain classifications,
  // nested-execution structure, or unsupported syntax have unresolved
  // coverage — partial verification is never verified
  if (classification.kind !== "lifecycle" || classification.lifecycleInside) return "candidate";
  // evidence binds ONE operation on ONE target: a compound with multiple
  // mutations or affected targets needs per-operation evidence — partial
  // verification is never verified
  if (classification.operationCount > 1 || classification.explicitTargets.length > 1 || classification.multiTarget) return "candidate";
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
