#!/usr/bin/env node
// Independent, bounded Bash argv oracle for regressions from review rounds
// 13–18. Only the fixed corpus below is interpreted. Every command in it is
// a shell function that prints argv; no lifecycle executable is invoked.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { classifyCommand, targetConfidence, decide } from "../lib/guardrail.mjs";

const { policy } = JSON.parse(readFileSync(new URL("../pack/workflow-pack.v1.json", import.meta.url), "utf8"));
const prelude = `
record() { builtin printf '%s\\0' "$@"; builtin printf '\\0'; }
echo() { record echo "$@"; }
kill() { record kill "$@"; }
systemctl() { record systemctl "$@"; }
launchctl() { record launchctl "$@"; }
rg() { record rg "$@"; }
man() { record man "$@"; }
command_not_found_handle() { record UNKNOWN "$@"; }
`;
function argvTrace(command) {
  const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", prelude + command], {
    encoding: "utf8", timeout: 2000, maxBuffer: 65536,
    // No inherited startup script, exported functions, credentials or tool PATH.
    env: { PATH: "/nonexistent", LC_ALL: "C" },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result.stdout.split("\0\0").filter(Boolean).map((row) => row.split("\0"));
}
const serviceBinding = {
  target: "example.service", operation: "restart", ruleId: "service-manager-lifecycle",
  evidence: "synthetic exact service binding", resolved: true,
};
const killBinding = {
  target: "1", operation: "kill", ruleId: "raw-process-kill",
  evidence: "synthetic PID resolution", resolved: true,
};
let passed = 0;
function check(label, fn) {
  try { fn(); passed++; }
  catch (error) { throw new Error(label, { cause: error }); }
}
function held(c, binding) {
  const confidence = targetConfidence({ classification: c, verifiedTarget: binding });
  assert.notEqual(confidence, "verified");
  assert.equal(decide({ classification: c, confidence, mode: "enforce", policy }).action, "ownership-hold");
  assert.equal(decide({ classification: c, confidence, mode: "shadow", policy }).action, "log-uncertainty");
}

// Physical boundaries and comment eligibility: compare actual inert Bash
// execution against recognition, then check single-binding coverage caps.
for (const command of [
  "echo foo \\ \nkill 1", "echo foo \\\t\nkill 1", "echo foo \\\n\nkill 1",
  "echo foo\\ #literal; kill 1", "echo foo\\\t#literal; kill 1",
]) {
  for (const prefix of ["", "systemctl restart example.service; "]) {
    const input = prefix + command;
    check(`boundary ${JSON.stringify(input)}`, () => {
      const trace = argvTrace(input);
      const mutations = trace.filter(([exec]) => exec === "kill" || exec === "systemctl");
      assert.equal(mutations.length, prefix ? 2 : 1);
      const c = classifyCommand(input, policy);
      assert.equal(c.kind, "lifecycle");
      assert.equal(c.operationCount, mutations.length);
      if (prefix) held(c, serviceBinding);
    });
  }
}

// Independent evidence that quote/continuation syntax exposes --pre/-P as
// separate argv items. These commands only invoke inert rg/man functions.
for (const [command, executable, option] of [
  [String.raw`rg foo\" --pre hook pattern file`, "rg", "--pre"],
  [String.raw`rg -F '\' --pre hook pattern file`, "rg", "--pre"],
  ["rg -F foo \\\n--pre hook pattern file", "rg", "--pre"],
  [String.raw`man '\' -P hook ls`, "man", "-P"],
  ["man ls \\\n-P hook", "man", "-P"],
]) {
  check(`option ${JSON.stringify(command)}`, () => {
    const trace = argvTrace(command);
    assert.equal(trace[0][0], executable);
    assert(trace[0].includes(option));
    assert.equal(classifyCommand(command, policy).kind, "uncertain");
    held(classifyCommand(`kill 1; ${command}`, policy), killBinding);
  });
}

for (const byte of ["\r", "\v", "\f", "\u00a0"]) {
  check(`executable ${JSON.stringify(byte)}`, () => {
    assert.deepEqual(argvTrace(`echo${byte} harmless`), [["UNKNOWN", `echo${byte}`, "harmless"]]);
    assert.equal(classifyCommand(`echo${byte} harmless`, policy).kind, "uncertain");
    held(classifyCommand(`kill 1; echo${byte} harmless`, policy), killBinding);
  });
  check(`verb ${JSON.stringify(byte)}`, () => {
    assert.deepEqual(argvTrace(`systemctl restart${byte} example.service`), [["systemctl", `restart${byte}`, "example.service"]]);
    const c = classifyCommand(`systemctl restart${byte} example.service`, policy);
    assert.equal(c.kind, "uncertain");
    assert.deepEqual(c.explicitTargets, []);
  });
  check(`target ${JSON.stringify(byte)}`, () => {
    const target = `example.service${byte}`;
    assert.deepEqual(argvTrace(`systemctl restart ${target}`), [["systemctl", "restart", target]]);
    const c = classifyCommand(`systemctl restart ${target}`, policy);
    assert.deepEqual(c.explicitTargets, [target]);
    held(c, serviceBinding);
    assert.equal(targetConfidence({ classification: c, verifiedTarget: { ...serviceBinding, target } }), "verified");
  });
  check(`signal ${JSON.stringify(byte)}`, () => {
    assert.deepEqual(argvTrace(`launchctl kill TERM${byte} system/web`), [["launchctl", "kill", `TERM${byte}`, "system/web"]]);
    const c = classifyCommand(`launchctl kill TERM${byte} system/web`, policy);
    assert.equal(c.kind, "uncertain");
    assert.equal(c.operationCount, 1);
    assert.deepEqual(c.explicitTargets, []);
    held(c, { ...serviceBinding, operation: "kill", target: "system/web" });
  });
}
for (const signal of ["TERM", "SIGTERM", "15", "0"]) {
  check(`supported signal spelling ${signal}`, () => {
    assert.deepEqual(argvTrace(`launchctl kill ${signal} system/web`), [["launchctl", "kill", signal, "system/web"]]);
    const c = classifyCommand(`launchctl kill ${signal} system/web`, policy);
    assert.equal(c.kind, "lifecycle");
    assert.deepEqual(c.explicitTargets, ["system/web"]);
    assert.equal(targetConfidence({ classification: c, verifiedTarget: {
      ...serviceBinding, operation: "kill", target: "system/web",
    } }), "verified");
  });
}
console.log(`shell boundary oracle: pass ${passed} / fail 0 (fixed corpus; inert functions only)`);
