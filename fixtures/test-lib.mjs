#!/usr/bin/env node
// Deterministic, no-agent tests for the pure contract modules
// (lib/guardrail.mjs, lib/discovery.mjs, lib/audit.mjs). stdlib-only,
// exits nonzero on any failure. Run: node fixtures/test-lib.mjs
//
// Encodes the design contracts (docs/DESIGN-v0.3.md §3.1–3.3, §3.5) and the
// adversarial regressions from the Milestone 1 Astra review: unsupported
// wrappers/assignments/separators/heredocs are uncertain (never silently
// safe), probes and read verbs are non-lifecycle, wrapper scanning
// terminates, declarations never confer verification, hard-deny requires
// separately approved rules, and integrity holds take precedence.
import assert from "node:assert";
import { classifyCommand, splitSegments, targetConfidence, decide } from "../lib/guardrail.mjs";
import { projectFamily, ownershipAuthority } from "../lib/discovery.mjs";
import { auditRow, appendEvent, fingerprint } from "../lib/audit.mjs";

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    pass++;
  } catch (err) {
    console.log(`FAIL  ${name}: ${err.message}`);
    fail++;
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    pass++;
  } catch (err) {
    console.log(`FAIL  ${name}: ${err.message}`);
    fail++;
  }
}

const policy = {
  rules: [
    { id: "raw-process-kill", failure_class: "raw-process-kill", severity: "reversible", match: { executables: ["kill", "pkill", "killall", "nohup"] } },
    { id: "service-manager-lifecycle", failure_class: "dev-server-restart-drift", severity: "reversible", match: { executables: ["systemctl", "launchctl"], args: ["\\b(start|stop|restart|kill)\\b"] } },
    { id: "container-engine-lifecycle", failure_class: "raw-container-lifecycle", severity: "reversible", match: { executables: ["docker", "podman"], args: ["\\b(kill|restart|stop|rm)\\b"] } },
    { id: "destructive-example", failure_class: "destructive", severity: "destructive", match: { executables: ["dropcache"] } },
  ],
  hard_deny: [],
  alternatives: {
    "raw-process-kill": { command: "taskcli service down --confirm", source: "anvil-serving --command-manifest", gate: "--confirm" },
  },
};
const policyWithApprovedHard = {
  ...policy,
  hard_deny: ["destructive-example"],
  alternatives: { ...policy.alternatives, "destructive-example": { command: "taskcli cache drop --confirm", source: "taskcli --help", gate: "--confirm" } },
};

// -- splitSegments --
check("splitSegments: ; && | split, quotes respected", () => {
  assert.deepEqual(splitSegments('echo "a;b" && kill 1; ls | wc'), ['echo "a;b"', "kill 1", "ls", "wc"]);
});
check("splitSegments: newline and lone & are separators", () => {
  assert.deepEqual(splitSegments("echo ok\nkill 1"), ["echo ok", "kill 1"]);
  assert.deepEqual(splitSegments("echo ok & kill 1"), ["echo ok", "kill 1"]);
});

// -- classification: lifecycle positives (supported complete forms) --
check("kill -9 123 → lifecycle, raw-process-kill", () => {
  const c = classifyCommand("kill -9 123", policy);
  assert.equal(c.kind, "lifecycle");
  assert.deepEqual(c.ruleIds, ["raw-process-kill"]);
});
check("systemctl restart foo.service → lifecycle with explicit target", () => {
  const c = classifyCommand("systemctl restart foo.service", policy);
  assert.equal(c.kind, "lifecycle");
  assert.deepEqual(c.explicitTargets, ["foo.service"]);
});
check("sudo pkill -f node → lifecycle (passthrough prefix)", () => {
  assert.equal(classifyCommand("sudo pkill -f node", policy).kind, "lifecycle");
});
check("env kill 1 → lifecycle (passthrough prefix)", () => {
  assert.equal(classifyCommand("env kill 1", policy).kind, "lifecycle");
});
check("sudo sudo kill 1 → lifecycle (wrapper scan terminates)", () => {
  const c = classifyCommand("sudo sudo kill 1", policy);
  assert.equal(c.kind, "lifecycle");
});
check("docker restart web → lifecycle with explicit target", () => {
  const c = classifyCommand("docker restart web", policy);
  assert.deepEqual(c.explicitTargets, ["web"]);
});
check("docker rm -f web → lifecycle (operation position match)", () => {
  const c = classifyCommand("docker rm -f web", policy);
  assert.equal(c.kind, "lifecycle");
  assert.deepEqual(c.explicitTargets, ["web"]);
});
check("systemctl kill foo → lifecycle (kill is a lifecycle verb)", () => {
  assert.equal(classifyCommand("systemctl kill foo", policy).kind, "lifecycle");
});
check("nohup npm run dev & → lifecycle (rule executable)", () => {
  assert.equal(classifyCommand("nohup npm run dev &", policy).kind, "lifecycle");
});
check("kill -s 9 123 → lifecycle (real signal)", () => {
  assert.equal(classifyCommand("kill -s 9 123", policy).kind, "lifecycle");
});
check("compound: echo ok && kill 1 → lifecycle", () => {
  assert.equal(classifyCommand("echo ok && kill 1", policy).kind, "lifecycle");
});
check("multiline: echo ok\\nkill 1 → lifecycle (newline separator)", () => {
  const c = classifyCommand("echo ok\nkill 1", policy);
  assert.equal(c.kind, "lifecycle");
});
check("comment line then kill → lifecycle (comment segment skipped)", () => {
  const c = classifyCommand("# comment\nkill 1", policy);
  assert.equal(c.kind, "lifecycle");
});

// -- classification: non-lifecycle negatives --
check('echo "kill -9 1" → non-lifecycle (argument to echo)', () => {
  assert.equal(classifyCommand('echo "kill -9 1"', policy).kind, "non-lifecycle");
});
check("grep kill file.txt → non-lifecycle", () => {
  assert.equal(classifyCommand("grep kill file.txt", policy).kind, "non-lifecycle");
});
check("kill -0 1 → non-lifecycle (signal-0 probe sends nothing)", () => {
  const c = classifyCommand("kill -0 1", policy);
  assert.equal(c.kind, "non-lifecycle");
  assert.match(c.notes.join(" "), /probe/);
});
check("kill -s 0 123 → non-lifecycle (signal-0 probe)", () => {
  assert.equal(classifyCommand("kill -s 0 123", policy).kind, "non-lifecycle");
});
check("kill --help → non-lifecycle (help probe)", () => {
  assert.equal(classifyCommand("kill --help", policy).kind, "non-lifecycle");
});
check("systemctl status restart.service → non-lifecycle (read verb; no substring match)", () => {
  const c = classifyCommand("systemctl status restart.service", policy);
  assert.equal(c.kind, "non-lifecycle");
  assert.equal(c.ruleIds.length, 0, "restart inside a unit name must not match the operation position");
});
check("docker inspect stop → non-lifecycle (read verb)", () => {
  assert.equal(classifyCommand("docker inspect stop", policy).kind, "non-lifecycle");
});
check("echo ok # ; kill 1 → non-lifecycle (comment truncation)", () => {
  assert.equal(classifyCommand("echo ok # ; kill 1", policy).kind, "non-lifecycle");
});
check('echo "a # b" → non-lifecycle (quoted # is literal)', () => {
  assert.equal(classifyCommand('echo "a # b"', policy).kind, "non-lifecycle");
});
check('echo "kill $(x)" → uncertain, lifecycleInside FALSE (substituted command is x, not kill)', () => {
  const c = classifyCommand('echo "kill $(x)"', policy);
  assert.equal(c.kind, "uncertain");
  assert.equal(c.lifecycleInside, false, "the substituted command is x, not kill — literal kill is outside the substitution");
});
check('echo "$(kill 1)" → uncertain, lifecycleInside TRUE (substitution contents execute kill)', () => {
  const c = classifyCommand('echo "$(kill 1)"', policy);
  assert.equal(c.kind, "uncertain");
  assert.equal(c.lifecycleInside, true);
});
check('echo \'kill 1\' "$(date)" → uncertain, lifecycleInside FALSE (only date executes)', () => {
  const c = classifyCommand('echo \'kill 1\' "$(date)"', policy);
  assert.equal(c.kind, "uncertain");
  assert.equal(c.lifecycleInside, false, "kill 1 is single-quoted literal text; only date executes");
});
check("echo $(date) → uncertain, no lifecycleInside (harmless substitution)", () => {
  const c = classifyCommand("echo $(date)", policy);
  assert.equal(c.kind, "uncertain");
  assert.equal(c.lifecycleInside, false);
});
check("echo `kill 1` → uncertain (backticks execute inside double quotes too)", () => {
  const c = classifyCommand('echo "`kill 1`"', policy);
  assert.equal(c.kind, "uncertain");
  assert.equal(c.lifecycleInside, true);
});
check("echo 'kill 1' → non-lifecycle (single quotes are literal)", () => {
  assert.equal(classifyCommand("echo 'kill 1'", policy).kind, "non-lifecycle");
});
check("cat <(kill 1) → uncertain (process substitution executes)", () => {
  const c = classifyCommand("cat <(kill 1)", policy);
  assert.equal(c.kind, "uncertain");
  assert.equal(c.lifecycleInside, true);
});
check("kill -0 $(kill 1) → uncertain (substitution executes even in a probe)", () => {
  const c = classifyCommand("kill -0 $(kill 1)", policy);
  assert.equal(c.kind, "uncertain");
  assert.equal(c.lifecycleInside, true);
});
check("systemctl status $(kill 1) → uncertain (substitution executes in a read verb)", () => {
  const c = classifyCommand("systemctl status $(kill 1)", policy);
  assert.equal(c.kind, "uncertain");
  assert.equal(c.lifecycleInside, true);
});
check("echo ok > /tmp/x → uncertain (redirect writes)", () => {
  assert.equal(classifyCommand("echo ok > /tmp/x", policy).kind, "uncertain");
});
check("redirects without whitespace are still redirects (integrity hold applies)", () => {
  for (const cmd of ["echo x>installed-policy.json", "echo 'x'>installed-policy.json", "echo x 1>installed-policy.json", "cat /dev/null>installed-policy.json"]) {
    const c = classifyCommand(cmd, policy);
    assert.notEqual(c.kind, "lifecycle", cmd);
    const enforce = decide({ classification: c, confidence: "unknown", mode: "enforce", policy, integrity: true });
    assert.equal(enforce.action, "integrity-hold", `${cmd} must integrity-hold under detected tampering`);
  }
});
check("single-quoted backslash is literal: echo '\\'; kill 1 → lifecycle", () => {
  const c = classifyCommand("echo '\\'; kill 1", policy);
  assert.equal(c.kind, "lifecycle", "the single-quoted backslash closes the quote; kill 1 is a separate command");
});
check("echo '\\' \"$(kill 1)\" → uncertain with lifecycleInside (substitution executes)", () => {
  const c = classifyCommand("echo '\\' \"$(kill 1)\"", policy);
  assert.equal(c.kind, "uncertain");
  assert.equal(c.lifecycleInside, true);
});
check("systemctl restart foo.service bar → uncertain (unrecognized operand never dropped)", () => {
  const c = classifyCommand("systemctl restart foo.service bar", policy);
  assert.equal(c.kind, "uncertain");
  assert.equal(c.multiTarget, true);
});
check("compound with multiple matched rules: single-operation evidence is never verified", () => {
  const c = classifyCommand("systemctl restart foo.service; kill 123", policy);
  assert.equal(c.ruleIds.length, 2);
  assert.equal(
    targetConfidence({ classification: c, verifiedTarget: { target: "foo.service", ruleId: "service-manager-lifecycle", operation: "restart", evidence: "x" } }),
    "candidate",
    "evidence binds one operation; the kill's unresolved PID is not covered"
  );
});
check("pkill -s/-n select sessions/newest, not signal 0: real mutations", () => {
  for (const cmd of ["pkill -s 0 node", "pkill -n 0"]) {
    const c = classifyCommand(cmd, policy);
    assert.equal(c.kind, "lifecycle", `${cmd} sends the default signal`);
  }
  const probe = classifyCommand("pkill -0 node", policy);
  assert.equal(probe.kind, "non-lifecycle", "pkill -0 IS a signal-zero probe");
});
check("executing substitution without a top-level executable still executes", () => {
  const c = classifyCommand("$(kill 1)$(date)", policy);
  assert.equal(c.kind, "uncertain");
  assert.equal(c.lifecycleInside, true, "the substitution runs kill even with no top-level executable");
});
check("leading whitespace inside a substitution does not hide the command", () => {
  const c = classifyCommand("echo $( kill 1)", policy);
  assert.equal(c.lifecycleInside, true);
});
check("multiple commands inside one substitution: each command position checked", () => {
  const c = classifyCommand("echo $(true; kill 1)", policy);
  assert.equal(c.lifecycleInside, true, "kill 1 is the second command in the substitution");
});
check("nested-quote comment ambiguity never erases a later mutation", () => {
  const c = classifyCommand('echo "$(echo " #")"; kill 1', policy);
  assert.equal(c.kind, "uncertain");
  assert.ok(c.ruleIds.includes("raw-process-kill"), "the kill mutation must be recognized, not erased");
});
check("backtick substitutions are separate commands", () => {
  const c = classifyCommand("echo `true``kill 1`", policy);
  assert.equal(c.lifecycleInside, true, "backtick contents must not concatenate");
});
check("unsupported compounds never verify with one binding", () => {
  const vt = { target: "1", ruleId: "raw-process-kill", operation: "kill", evidence: "pid 1 resolved", resolved: true };
  for (const cmd of ["kill 1; kill 2 3", "kill 1; kill 2 > log", "kill 1; kill $(pgrep node)"]) {
    const c = classifyCommand(cmd, policy);
    assert.equal(
      targetConfidence({ classification: c, verifiedTarget: vt }),
      "candidate",
      `${cmd}: unresolved additional coverage must downgrade to candidate`
    );
  }
});
check("kill -- ends flags: negative PIDs are operands", () => {
  const c = classifyCommand("kill -- -123 -456", policy);
  assert.equal(c.kind, "uncertain");
  assert.equal(c.multiTarget, true, "two negative PIDs after -- are two targets");
});
check("read/probe operations inside substitutions are not mutations", () => {
  for (const cmd of ["echo $(systemctl status foo.service)", "echo $(kill -0 1)"]) {
    const c = classifyCommand(cmd, policy);
    assert.equal(c.lifecycleInside, false, `${cmd} runs a read/probe, not a mutation`);
  }
});
check("read-verb redirect stays uncertain without an invented mutation", () => {
  const c = classifyCommand("systemctl status foo.service 2>/dev/null", policy);
  assert.equal(c.kind, "uncertain");
  assert.equal(c.operationCount, 0, "a read verb with a redirect is not a lifecycle mutation");
  const shadow = decide({ classification: c, confidence: "stale", mode: "shadow", policy });
  assert.equal(shadow.action, "log-uncertainty", "no ownership hold without a recognized mutation");
});
check("nested/unsupported mutations never verify with one binding (complete-form cap)", () => {
  const vt = { target: "1", ruleId: "raw-process-kill", operation: "kill", evidence: "pid 1 resolved", resolved: true };
  for (const cmd of ["kill 1; echo $(kill 2)", "kill 1; $(kill 2)", 'kill 1; sh -c "kill 2"', "kill 1; FOO=x kill 2"]) {
    const c = classifyCommand(cmd, policy);
    assert.equal(
      targetConfidence({ classification: c, verifiedTarget: vt }),
      "candidate",
      `${cmd}: nested/unsupported structure caps below verified`
    );
  }
  // a completely supported single form still verifies
  const simple = classifyCommand("kill 1", policy);
  assert.equal(targetConfidence({ classification: simple, verifiedTarget: vt }), "verified");
});
check("expansion/glob operands are never invented explicit targets", () => {
  const vt = { target: "{a,b}.service", ruleId: "service-manager-lifecycle", operation: "restart", evidence: "x", resolved: true };
  for (const cmd of ["systemctl restart {a,b}.service", "systemctl restart *.service", "systemctl restart foo\\.service"]) {
    const c = classifyCommand(cmd, policy);
    assert.equal(c.kind, "uncertain", `${cmd}: expansion/glob/escape is unsupported`);
    assert.equal(c.explicitTargets.length, 0, `${cmd}: no invented target identity`);
    assert.equal(targetConfidence({ classification: c, verifiedTarget: vt }), "candidate", "bound evidence on an unsupported form caps at candidate, never verified");
  }
});
check("concatenated executable word is not a confident read-only classification", () => {
  const c = classifyCommand('echo"/custom" arg', policy);
  assert.equal(c.kind, "uncertain", "the complete word is echo\"/custom\", not echo");
});
check("read-verb semantics are per executable (pkill status is a mutation)", () => {
  const redirect = classifyCommand("pkill status >log", policy);
  assert.equal(redirect.operationCount, 1, "pkill status is a recognized mutation, not a read verb");
  for (const cmd of ["echo $(pkill status)", "echo $(killall status)"]) {
    const c = classifyCommand(cmd, policy);
    assert.equal(c.lifecycleInside, true, `${cmd} runs a mutation`);
  }
  const read = classifyCommand("systemctl status foo.service", policy);
  assert.equal(read.kind, "non-lifecycle", "systemctl status IS a read verb");
});
check("quoted separator inside a substitution is argument text, not a command separator", () => {
  const c = classifyCommand('echo $(echo "x; kill 1")', policy);
  assert.equal(c.lifecycleInside, false, "the shell executes echo; kill 1 is quoted argument text");
});
check("multiline quoting: quoted # spanning lines is not a comment", () => {
  const c = classifyCommand("echo '\n#'; kill 1", policy);
  assert.equal(c.kind, "lifecycle", "the quoted # spans lines; kill 1 executes");
});
check("redirect/multi-target branches retain recognized mutations (stale authority holds)", () => {
  for (const cmd of ["kill 1 > log", "systemctl restart foo.service 2>/dev/null", "systemctl restart foo.service bar"]) {
    const c = classifyCommand(cmd, policy);
    assert.notEqual(c.kind, "non-lifecycle", cmd);
    const shadow = decide({ classification: c, confidence: "stale", mode: "shadow", policy });
    assert.equal(shadow.action, "log-degradation", `${cmd} with stale authority must log degradation, not generic uncertainty`);
    const enforce = decide({ classification: c, confidence: "stale", mode: "enforce", policy });
    assert.equal(enforce.action, "ownership-hold", `${cmd} with stale authority must hold`);
  }
});
check("single-binding evidence never verifies multiple mutations or targets", () => {
  for (const cmd of ["kill 1; kill 2", "kill 1 2", "systemctl restart foo.service; systemctl stop foo.service"]) {
    const c = classifyCommand(cmd, policy);
    const conf = targetConfidence({ classification: c, verifiedTarget: { target: "1", ruleId: "raw-process-kill", operation: "kill", evidence: "pid 1 resolved", resolved: true } });
    assert.notEqual(conf, "verified", `${cmd}: one binding cannot verify multiple mutations/targets`);
  }
  // lifecycle compounds with a single binding are candidate, never verified
  const compound = classifyCommand("systemctl restart foo.service; systemctl stop foo.service", policy);
  assert.equal(
    targetConfidence({ classification: compound, verifiedTarget: { target: "foo.service", ruleId: "service-manager-lifecycle", operation: "restart", evidence: "x" } }),
    "candidate"
  );
});
check("adjacent substitutions preserve boundaries: echo $(true)$(kill 1) → lifecycleInside", () => {
  const c = classifyCommand("echo $(true)$(kill 1)", policy);
  assert.equal(c.kind, "uncertain");
  assert.equal(c.lifecycleInside, true, "adjacent substitution bodies must not concatenate into one word");
});
check("trailing literal after a substitution is not executing content", () => {
  const c = classifyCommand('echo "$(date) kill 1"', policy);
  assert.equal(c.lifecycleInside, false, "kill 1 is literal text outside the substitution");
});
check("probe with harmless substitution is not a mutation: kill -0 $(date)", () => {
  const c = classifyCommand("kill -0 $(date)", policy);
  assert.equal(c.lifecycleInside, false, "signal 0 sends nothing; the substitution is harmless");
});
check("read verb with harmless substitution is not a mutation: systemctl status $(date)", () => {
  const c = classifyCommand("systemctl status $(date)", policy);
  assert.equal(c.lifecycleInside, false);
});
check("substitution whose content echoes a quoted kill is not a mutation", () => {
  const c = classifyCommand('echo $(echo "kill 1")', policy);
  assert.equal(c.lifecycleInside, false, "the substitution runs echo, not kill");
});
check("operation binding records the verb (restart vs kill)", () => {
  const c = classifyCommand("systemctl restart foo.service", policy);
  assert.deepEqual(c.operations, ["restart"]);
  const k = classifyCommand("kill -9 123", policy);
  assert.deepEqual(k.operations, ["kill"]);
});
check("kill 1 2 → uncertain multi-target (never partially verified)", () => {
  const c = classifyCommand("kill 1 2", policy);
  assert.equal(c.kind, "uncertain");
  assert.equal(c.multiTarget, true);
});
check("systemctl restart foo.service; systemctl stop bar: two targets, one binding → candidate, never verified", () => {
  const c = classifyCommand("systemctl restart foo.service; systemctl stop bar", policy);
  assert.equal(c.kind, "lifecycle");
  assert.equal(c.explicitTargets.length, 2);
  assert.equal(
    targetConfidence({ classification: c, verifiedTarget: { target: "foo.service", ruleId: "service-manager-lifecycle", operation: "restart", evidence: "x" } }),
    "candidate",
    "one binding cannot cover two affected targets"
  );
});
check('echo \\" # comment then kill → lifecycle (escaped quote is literal, comment ends, kill executes)', () => {
  const c = classifyCommand('echo \\" # comment\nkill 1', policy);
  assert.equal(c.kind, "lifecycle");
});
check("git status && npm test → uncertain, never lifecycle (ordinary work)", () => {
  const c = classifyCommand("git status && npm test", policy);
  assert.equal(c.kind, "uncertain");
  assert.equal(c.ruleIds.length, 0);
});
check("docker ps → non-lifecycle (read verb)", () => {
  assert.equal(classifyCommand("docker ps", policy).kind, "non-lifecycle");
});
check("systemctl is-active foo → non-lifecycle (read verb)", () => {
  assert.equal(classifyCommand("systemctl is-active foo", policy).kind, "non-lifecycle");
});
check("pkill -0 node → non-lifecycle (signal 0 sends nothing)", () => {
  assert.equal(classifyCommand("pkill -0 node", policy).kind, "non-lifecycle");
});
check("kill -s 9 123 → lifecycle (real signal)", () => {
  assert.equal(classifyCommand("kill -s 9 123", policy).kind, "lifecycle");
});
check("kill -s 0 123 → non-lifecycle (signal-0 probe)", () => {
  assert.equal(classifyCommand("kill -s 0 123", policy).kind, "non-lifecycle");
});
check("systemctl restart a.service b.service → uncertain (unsupported multi-target form)", () => {
  const c = classifyCommand("systemctl restart a.service b.service", policy);
  assert.equal(c.kind, "uncertain");
  assert.equal(c.multiTarget, true);
});
check("systemctl status foo.service → non-lifecycle", () => {
  assert.equal(classifyCommand("systemctl status foo.service", policy).kind, "non-lifecycle");
});

// -- classification: uncertain (never silently safe) --
check("node server.js → uncertain (unknown executable is not confidently safe)", () => {
  assert.equal(classifyCommand("node server.js", policy).kind, "uncertain");
});
check("sh -c 'kill -9 1' → uncertain with lifecycleInside", () => {
  const c = classifyCommand("sh -c 'kill -9 1'", policy);
  assert.equal(c.kind, "uncertain");
  assert.equal(c.lifecycleInside, true);
});
check("kill $(pgrep node) → uncertain (expansion; target unresolvable)", () => {
  const c = classifyCommand("kill $(pgrep node)", policy);
  assert.equal(c.kind, "uncertain");
  assert.equal(c.lifecycleInside, true, "lifecycle + uncertain structure is a recognized mutation with unresolved structure");
});
check('kill "$(pgrep x)" → uncertain (quoted expansion still unresolves the target)', () => {
  const c = classifyCommand('kill "$(pgrep x)"', policy);
  assert.equal(c.kind, "uncertain");
});
check("kill ${PID} → uncertain", () => {
  assert.equal(classifyCommand("kill ${PID}", policy).kind, "uncertain");
});
check("eval \"$CMD\" → uncertain", () => {
  assert.equal(classifyCommand('eval "$CMD"', policy).kind, "uncertain");
});
check("bash heredoc containing kill → uncertain with lifecycleInside", () => {
  const c = classifyCommand("bash <<EOF\nkill -9 1\nEOF", policy);
  assert.equal(c.kind, "uncertain");
  assert.equal(c.lifecycleInside, true);
});
check("cat heredoc containing kill → uncertain (heredoc body is stdin, never confidently classified)", () => {
  const c = classifyCommand("cat <<EOF\nkill -9 1\nEOF", policy);
  assert.equal(c.kind, "uncertain");
  assert.equal(c.lifecycleInside, true);
});
check("cat heredoc without lifecycle → uncertain, no lifecycleInside", () => {
  const c = classifyCommand("cat <<EOF\nhello\nEOF", policy);
  assert.equal(c.kind, "uncertain");
  assert.equal(c.lifecycleInside, false);
});
check("sudo -u root systemctl stop x → uncertain (unresolvable passthrough flag)", () => {
  const c = classifyCommand("sudo -u root systemctl stop x", policy);
  assert.equal(c.kind, "uncertain");
});
check("FOO=bar kill 1 → uncertain (assignment prefix)", () => {
  assert.equal(classifyCommand("FOO=bar kill 1", policy).kind, "uncertain");
});
check("xargs kill < list → uncertain with lifecycleInside", () => {
  const c = classifyCommand("xargs kill < list", policy);
  assert.equal(c.kind, "uncertain");
  assert.equal(c.lifecycleInside, true);
});
check("launchctl bootout system/foo → uncertain (unsupported form)", () => {
  assert.equal(classifyCommand("launchctl bootout system/foo", policy).kind, "uncertain");
});
check("echo $(kill 1) → uncertain (unquoted substitution IS executed)", () => {
  const c = classifyCommand("echo $(kill 1)", policy);
  assert.equal(c.kind, "uncertain");
});
check("sh -c \"systemctl restart x\" # comment → uncertain with lifecycleInside", () => {
  const c = classifyCommand('sh -c "systemctl restart x" # comment', policy);
  assert.equal(c.kind, "uncertain");
  assert.equal(c.lifecycleInside, true);
});

// -- targetConfidence (design §3.2: verified requires BOUND evidence) --
check("systemctl with unit → candidate (lexical evidence only)", () => {
  const c = classifyCommand("systemctl restart foo.service", policy);
  assert.equal(targetConfidence({ classification: c }), "candidate");
});
check("kill with bare PID → unknown", () => {
  const c = classifyCommand("kill -9 123", policy);
  assert.equal(targetConfidence({ classification: c }), "unknown");
});
check("bound evidence object (target + ruleId + evidence) → verified", () => {
  const c = classifyCommand("systemctl restart foo.service", policy);
  assert.equal(
    targetConfidence({ classification: c, verifiedTarget: { target: "foo.service", ruleId: "service-manager-lifecycle", operation: "restart", evidence: "pi-web-status resolved anvil-pi-web.service" } }),
    "verified"
  );
});
check("evidence missing the ruleId binding (operation mismatch) → candidate, never verified", () => {
  const c = classifyCommand("systemctl restart foo.service", policy);
  assert.equal(targetConfidence({ classification: c, verifiedTarget: { target: "foo.service", ruleId: "container-engine-lifecycle", operation: "restart", evidence: "x" } }), "candidate");
  assert.equal(targetConfidence({ classification: c, verifiedTarget: { target: "foo.service", ruleId: "service-manager-lifecycle", evidence: "status-only" } }), "candidate");
});
check("bare PID requires an explicit resolution binding (resolved: true)", () => {
  const c = classifyCommand("kill -9 123", policy);
  assert.equal(c.explicitTargets.length, 0);
  assert.equal(targetConfidence({ classification: c, verifiedTarget: { target: "web-server", ruleId: "raw-process-kill", operation: "kill", evidence: "pgrep resolved pid 123 to web-server" } }), "unknown");
  assert.equal(targetConfidence({ classification: c, verifiedTarget: { target: "web-server", ruleId: "raw-process-kill", operation: "kill", evidence: "pgrep resolved pid 123 to web-server", resolved: true } }), "verified");
});
check("unrelated target name in evidence object → candidate, never verified", () => {
  const c = classifyCommand("systemctl restart foo.service", policy);
  assert.equal(targetConfidence({ classification: c, verifiedTarget: { target: "other.service", operation: "restart", evidence: "x" } }), "candidate");
});
check("string verifiedTarget (legacy) → candidate, never verified", () => {
  const c = classifyCommand("systemctl restart foo.service", policy);
  assert.equal(targetConfidence({ classification: c, verifiedTarget: "foo.service" }), "candidate");
});
check("evidence-free object → candidate", () => {
  const c = classifyCommand("systemctl restart foo.service", policy);
  assert.equal(targetConfidence({ classification: c, verifiedTarget: { target: "foo.service" } }), "candidate");
});

// -- decide matrix (design §3.3) --
check("non-lifecycle → allow in both modes; read-only diagnosis always available", () => {
  const c = classifyCommand("ls -la", policy);
  assert.equal(decide({ classification: c, confidence: "unknown", mode: "shadow", policy }).action, "allow");
  assert.equal(decide({ classification: c, confidence: "unknown", mode: "enforce", policy }).action, "allow");
});
check("uncertain without lifecycle inside: shadow logs, enforce allows without claiming protection", () => {
  const c = classifyCommand("bash -c 'echo hi'", policy);
  assert.equal(decide({ classification: c, confidence: "unknown", mode: "shadow", policy }).action, "log-uncertainty");
  const d = decide({ classification: c, confidence: "unknown", mode: "enforce", policy });
  assert.equal(d.action, "allow");
  assert.equal(d.protectionClaimed, false);
});
check("uncertain with indirected lifecycle: enforce → ownership-hold", () => {
  const c = classifyCommand("sh -c 'kill -9 1'", policy);
  assert.equal(decide({ classification: c, confidence: "unknown", mode: "shadow", policy }).action, "log-uncertainty");
  assert.equal(decide({ classification: c, confidence: "unknown", mode: "enforce", policy }).action, "ownership-hold");
});
check("lifecycle + unresolved ownership: shadow logs, enforce holds", () => {
  const c = classifyCommand("kill -9 123", policy);
  assert.equal(decide({ classification: c, confidence: "unknown", mode: "shadow", policy }).reasonCode, "unresolved-ownership");
  assert.equal(decide({ classification: c, confidence: "candidate", mode: "enforce", policy }).action, "ownership-hold");
});
check("lifecycle + stale authority: enforce holds, never silently downgrades", () => {
  const c = classifyCommand("systemctl restart foo.service", policy);
  assert.equal(decide({ classification: c, confidence: "stale", mode: "shadow", policy }).action, "log-degradation");
  assert.equal(decide({ classification: c, confidence: "stale", mode: "enforce", policy }).action, "ownership-hold");
});
check("stale authority precedes uncertainty for recognized mutations (kill ${PID})", () => {
  const c = classifyCommand("kill ${PID}", policy);
  assert.equal(c.kind, "uncertain");
  assert.equal(c.lifecycleInside, true);
  assert.equal(decide({ classification: c, confidence: "stale", mode: "enforce", policy }).action, "ownership-hold");
  assert.equal(decide({ classification: c, confidence: "stale", mode: "shadow", policy }).action, "log-degradation");
});
check("lifecycle + verified + reversible + sourced alternative: shadow proposes, enforce soft-denies", () => {
  const c = classifyCommand("kill -9 123", policy);
  assert.equal(decide({ classification: c, confidence: "verified", mode: "shadow", policy }).action, "log-proposed-soft-deny");
  const enforce = decide({ classification: c, confidence: "verified", mode: "enforce", policy });
  assert.equal(enforce.action, "soft-deny");
  assert.equal(enforce.alternative.command, "taskcli service down --confirm");
  assert.equal(enforce.alternative.source, "anvil-serving --command-manifest");
});
check("lifecycle + verified + NO sourced alternative → missing-precondition hold, never a silent soft-deny", () => {
  const c = classifyCommand("systemctl restart foo.service", policy);
  const shadow = decide({ classification: c, confidence: "verified", mode: "shadow", policy });
  assert.equal(shadow.action, "log-uncertainty");
  assert.equal(shadow.reasonCode, "no-sourced-alternative");
  assert.equal(shadow.protectionClaimed, false);
  const enforce = decide({ classification: c, confidence: "verified", mode: "enforce", policy });
  assert.equal(enforce.action, "ownership-hold");
  assert.equal(enforce.reasonCode, "no-sourced-alternative");
});
check("destructive + approved in policy.hard_deny → hard-deny, no alternative, no in-session override path", () => {
  const c = classifyCommand("dropcache now", policyWithApprovedHard);
  assert.equal(decide({ classification: c, confidence: "verified", mode: "shadow", policy: policyWithApprovedHard }).action, "log-proposed-hard-deny");
  const enforce = decide({ classification: c, confidence: "verified", mode: "enforce", policy: policyWithApprovedHard });
  assert.equal(enforce.action, "hard-deny");
  assert.equal(enforce.alternative, null);
});
check("compound hard-rule ordering: strongest decision regardless of order (kill 1; dropcache now)", () => {
  // both orders must produce hard-deny: severity and approval are evaluated
  // per rule, and the strongest applicable decision wins
  for (const cmd of ["kill 1; dropcache now", "dropcache now; kill 1"]) {
    const c = classifyCommand(cmd, policyWithApprovedHard);
    assert.equal(c.destructive, true, cmd);
    const enforce = decide({ classification: c, confidence: "verified", mode: "enforce", policy: policyWithApprovedHard });
    assert.equal(enforce.action, "hard-deny", `${cmd} must hard-deny (order-independent)`);
  }
});
check("approved reversible rule cannot combine with an unapproved destructive rule into hard-deny", () => {
  // kill (reversible, alternative sourced) + dropcache (destructive, NOT approved)
  const c = classifyCommand("kill 1; dropcache now", policy);
  const enforce = decide({ classification: c, confidence: "verified", mode: "enforce", policy });
  assert.notEqual(enforce.action, "hard-deny");
  assert.equal(enforce.action, "ownership-hold", "unapproved destructive rule holds");
  assert.equal(enforce.reasonCode, "unapproved-destructive-rule");
});
check("alternative truthy placeholder is NOT a sourced alternative → hold, never soft-deny", () => {
  const c = classifyCommand("kill -9 123", policy);
  for (const bad of [true, 42, { not: "an alternative" }, "taskcli service down --confirm"]) {
    const d = decide({ classification: c, confidence: "verified", mode: "enforce", policy: { ...policy, alternatives: { "raw-process-kill": bad } } });
    assert.equal(d.action, "ownership-hold", `alternative ${JSON.stringify(bad)} must not produce soft-deny`);
    assert.equal(d.reasonCode, "no-sourced-alternative");
  }
});
check("integrity holds detected tampering regardless of lifecycle recognition", () => {
  // rm/node/echo-redirect are not lifecycle executables — the adapter's
  // explicit integrity finding must still hold the operation
  for (const cmd of ["rm installed-guardrail.mjs", "node disable-guardrail.js", "echo disabled > installed-policy.json"]) {
    const c = classifyCommand(cmd, policy);
    assert.notEqual(c.kind, "lifecycle");
    const enforce = decide({ classification: c, confidence: "unknown", mode: "enforce", policy, integrity: true });
    assert.equal(enforce.action, "integrity-hold", `${cmd} must integrity-hold under detected tampering`);
    const shadow = decide({ classification: c, confidence: "unknown", mode: "shadow", policy, integrity: true });
    assert.equal(shadow.action, "log-proposed-refusal");
  }
});
check("integrity + uncertain indirection without lifecycle: still holds (adapter detected tampering)", () => {
  // the integrity input means the adapter detected tampering for THIS
  // operation — recognition is not an additional prerequisite
  const c = classifyCommand("bash -c 'echo hi'", policy);
  const d = decide({ classification: c, confidence: "unknown", mode: "enforce", policy, integrity: true });
  assert.equal(d.action, "integrity-hold");
});

// -- discovery.projectFamily (injected execution interface) --
const family = {
  name: "anvil-serving",
  manifest_argv: ["anvil-serving", "--command-manifest"],
  registry_contract: { format: "json", expected_fields: ["commands"] },
};
await checkAsync("projectFamily: valid registry response → ok", async () => {
  const execFile = async () => ({ stdout: JSON.stringify({ commands: [] }) });
  const r = await projectFamily({ family, execFile });
  assert.equal(r.ok, true);
  assert.deepEqual(r.manifest.commands, []);
});
await checkAsync("projectFamily: nonzero exit → rejected", async () => {
  const execFile = async () => { throw new Error("exit 1"); };
  const r = await projectFamily({ family, execFile });
  assert.equal(r.ok, false);
  assert.match(r.reason, /failed/);
});
await checkAsync("projectFamily: oversized response → rejected as truncated (byte length)", async () => {
  const execFile = async () => ({ stdout: "x".repeat(100) });
  const r = await projectFamily({ family, execFile, maxBytes: 10 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /truncated/);
});
await checkAsync("projectFamily: multi-byte response measured in bytes", async () => {
  const execFile = async () => ({ stdout: "é".repeat(40) }); // 80 bytes, 40 chars
  const r = await projectFamily({ family, execFile, maxBytes: 60 });
  assert.equal(r.ok, false, "40 chars pass a .length check but exceed 60 bytes");
});
await checkAsync("projectFamily: missing expected field → rejected", async () => {
  const execFile = async () => ({ stdout: JSON.stringify({ nope: 1 }) });
  const r = await projectFamily({ family, execFile });
  assert.equal(r.ok, false);
  assert.match(r.reason, /missing expected fields/);
});
await checkAsync("projectFamily: commands:null → rejected (array required)", async () => {
  const execFile = async () => ({ stdout: JSON.stringify({ commands: null }) });
  const r = await projectFamily({ family, execFile });
  assert.equal(r.ok, false);
});
await checkAsync("projectFamily: commands:'bogus' → rejected", async () => {
  const execFile = async () => ({ stdout: JSON.stringify({ commands: "bogus" }) });
  const r = await projectFamily({ family, execFile });
  assert.equal(r.ok, false);
});
await checkAsync("projectFamily: JSON null root → rejected, never thrown", async () => {
  const execFile = async () => ({ stdout: "null" });
  const r = await projectFamily({ family, execFile });
  assert.equal(r.ok, false);
  assert.match(r.reason, /root/);
});
await checkAsync("projectFamily: JSON number root → rejected, never thrown", async () => {
  const execFile = async () => ({ stdout: "1" });
  const r = await projectFamily({ family, execFile });
  assert.equal(r.ok, false);
});
await checkAsync("projectFamily: entry with unsupported value type → rejected", async () => {
  const execFile = async () => ({ stdout: JSON.stringify({ commands: [{ name: "x", argv: ["a"], requires_confirmation: "yes" }] }) });
  const r = await projectFamily({ family, execFile });
  assert.equal(r.ok, false);
  assert.match(r.reason, /non-boolean requires_confirmation/);
});
await checkAsync("projectFamily: missing family name → structured failure, never thrown", async () => {
  const execFile = async () => ({ stdout: "{}" });
  const r = await projectFamily({ family: { manifest_argv: ["a", "b"] }, execFile });
  assert.equal(r.ok, false);
  assert.equal(r.family, null);
});
await checkAsync("projectFamily: unsupported format → rejected", async () => {
  const execFile = async () => ({ stdout: "{}" });
  const r = await projectFamily({ family: { ...family, registry_contract: { format: "yaml" } }, execFile });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unsupported registry_contract format/);
});
await checkAsync("projectFamily: object-shaped registry with malformed gate → rejected", async () => {
  const execFile = async () => ({ stdout: JSON.stringify({ commands: { stop: { argv: "shell text", requires_confirmation: "yes" } } }) });
  const r = await projectFamily({ family, execFile });
  assert.equal(r.ok, false);
  assert.match(r.reason, /non-boolean requires_confirmation/);
});
await checkAsync("projectFamily: object-shaped registry with valid entries → ok", async () => {
  const execFile = async () => ({ stdout: JSON.stringify({ commands: { stop: { argv: ["stop"], requires_confirmation: true } } }) });
  const r = await projectFamily({ family, execFile });
  assert.equal(r.ok, true);
});
await checkAsync("projectFamily: malformed expected_fields (string) → structured failure, never throws", async () => {
  const execFile = async () => ({ stdout: "{}" });
  const r = await projectFamily({ family: { ...family, registry_contract: { format: "json", expected_fields: "commands" } }, execFile });
  assert.equal(r.ok, false);
  assert.match(r.reason, /expected_fields/);
});
await checkAsync("projectFamily: shell-string manifest_argv → rejected (argument array required)", async () => {
  const execFile = async () => ({ stdout: "{}" });
  const r = await projectFamily({ family: { ...family, manifest_argv: undefined }, execFile });
  assert.equal(r.ok, false);
});

// -- ownershipAuthority (declaration ≠ verification) --
check("ownershipAuthority: declared contract → resolvable, at most candidate", () => {
  const a = ownershipAuthority({ ...family, ownership_contract: { targets: ["example.service"], resolution: "read-only status command" } });
  assert.equal(a.resolvable, true);
  assert.equal(a.confidence, "candidate", "a declaration is a resolution lead, never verified evidence");
});
check("ownershipAuthority: missing contract → unknown", () => {
  const a = ownershipAuthority({ name: "x" });
  assert.equal(a.resolvable, false);
  assert.equal(a.confidence, "unknown");
});

// -- audit --
check("auditRow: versioned schema, fingerprint over raw text, no raw payload", () => {
  const row = auditRow({ mode: "shadow", tool: "bash", command: "kill -9 1", action: "logged" });
  assert.equal(row.schemaVersion, 1);
  assert.equal(row.fingerprint, fingerprint("kill -9 1"));
  assert.match(row.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(JSON.stringify(row).includes("kill -9 1"), false, "raw command must not appear in the row");
});
check("auditRow: preserves evidence-bound correlation fields", () => {
  const row = auditRow({ tool: "bash", command: "ls", targetRef: "anvil-pi-web.service", discoveryDigest: "abc123", gateRef: "workbench pi-web-down --confirm" });
  assert.equal(row.targetRef, "anvil-pi-web.service");
  assert.equal(row.discoveryDigest, "abc123");
  assert.equal(row.gateRef, "workbench pi-web-down --confirm");
});
check("auditRow: stable fingerprint; caller-supplied ts is deterministic", () => {
  const row = auditRow({ ts: "2026-01-01T00:00:00.000Z", tool: "bash", command: "ls" });
  assert.equal(row.ts, "2026-01-01T00:00:00.000Z");
  assert.equal(fingerprint("abc"), fingerprint("abc"));
});
await checkAsync("appendEvent: writes one JSON line via injected appendFile", async () => {
  const lines = [];
  const appendFile = async (p, data) => lines.push(data);
  const mkdir = async () => {};
  const r = await appendEvent("/tmp/sink.jsonl", { mode: "shadow", tool: "bash", command: "ls" }, { appendFile, mkdir, stateDir: "/tmp" });
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(lines[0]).tool, "bash");
});
await checkAsync("appendEvent: failure reported, never thrown", async () => {
  const appendFile = async () => { throw new Error("EACCES"); };
  const r = await appendEvent("/tmp/sink.jsonl", { tool: "bash", command: "ls" }, { appendFile });
  assert.equal(r.ok, false);
  assert.match(r.reason, /EACCES/);
});

console.log(`\nlib tests: pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
