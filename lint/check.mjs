#!/usr/bin/env node
// Coverage lint: manifest <-> skills <-> compiled artifacts <-> installed targets.
// Exit 0 clean, exit 1 with findings. CI-able. stdlib-only.
//
//   node lint/check.mjs              # repo checks
//   node lint/check.mjs --installed  # also check installed harness targets
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const checkInstalled = process.argv.includes("--installed");
const findings = [];
const ok = (msg) => console.log(`  ok  ${msg}`);
const bad = (msg) => {
  findings.push(msg);
  console.log(`FAIL  ${msg}`);
};

const manifest = JSON.parse(
  readFileSync(join(root, "pack/workflow-pack.v1.json"), "utf8"),
);

// 1. manifest schema fields
for (const field of ["schema", "name", "version", "seek_first", "skills", "verb_families"]) {
  if (manifest[field] === undefined) bad(`manifest missing field: ${field}`);
}
if (manifest.schema !== "workflow-pack/v1") {
  bad(`manifest schema is ${manifest.schema}, expected workflow-pack/v1`);
}
if (!findings.length) {
  ok(`manifest ${manifest.name}@${manifest.version}: schema fields present`);
}

// 2. skill files exist and carry triggerable frontmatter
const descriptions = [];
for (const skill of manifest.skills || []) {
  const p = join(root, skill.path);
  if (!existsSync(p)) {
    bad(`skill file missing: ${skill.path}`);
    continue;
  }
  const text = readFileSync(p, "utf8");
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) {
    bad(`skill ${skill.name}: no frontmatter block`);
    continue;
  }
  const name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const desc = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name || name !== skill.name) {
    bad(`skill ${skill.path}: frontmatter name "${name}" != manifest name "${skill.name}"`);
  }
  if (!desc || desc.length < 80) {
    bad(`skill ${skill.name}: description missing or too short to trigger on`);
  }
  if (name && desc) {
    descriptions.push(desc.toLowerCase());
    ok(`skill ${skill.name}: frontmatter present`);
  }
}

// 3. trigger coverage: every verb_family trigger phrase must appear in some
// skill description — this is the failure class that caused the original
// incident (a skill whose description never covered service lifecycle).
for (const family of manifest.verb_families || []) {
  const triggers = family.triggers || [];
  const missing = triggers.filter((t) =>
    descriptions.some((d) => d.includes(t.toLowerCase())) ? false : true,
  );
  if (missing.length) {
    for (const t of missing) {
      bad(`trigger coverage: "${t}" (${family.name}) not covered by any skill description`);
    }
  } else {
    ok(`trigger coverage: ${family.name} (${triggers.length} trigger phrases)`);
  }
}

// 4. compiled artifact freshness
const distPath = join(root, "dist/AGENTS-seek-first.md");
if (!existsSync(distPath)) {
  bad("dist/AGENTS-seek-first.md missing — run: node scripts/build.mjs");
} else {
  const dist = readFileSync(distPath, "utf8");
  if (!dist.includes(manifest.seek_first)) {
    bad("dist/AGENTS-seek-first.md is stale — run: node scripts/build.mjs");
  } else {
    ok("dist artifact matches manifest seek_first");
  }
}

// 5. installed harness targets (opt-in)
if (checkInstalled) {
  for (const skill of manifest.skills || []) {
    const installed = skill.install?.replace("~", homedir());
    if (!installed) continue;
    if (!existsSync(join(installed, "SKILL.md"))) {
      bad(`installed skill missing: ${installed} — run: ./install.sh`);
    } else if (
      readFileSync(join(installed, "SKILL.md"), "utf8") !==
      readFileSync(join(root, skill.path), "utf8")
    ) {
      bad(`installed skill drifts from repo: ${installed} — run: ./install.sh`);
    } else {
      ok(`installed skill matches repo: ${installed}`);
    }
  }
  const agents = join(homedir(), ".pi/agent/AGENTS.md");
  if (!existsSync(agents)) {
    bad(`global AGENTS.md missing: ${agents}`);
  } else if (!readFileSync(agents, "utf8").includes(manifest.seek_first)) {
    bad(`seek-first line not installed in ${agents} — run: ./install.sh`);
  } else {
    ok(`seek-first line installed in ${agents}`);
  }
}

console.log("");
if (findings.length) {
  console.log(`lint: ${findings.length} finding(s)`);
  process.exit(1);
}
console.log("lint: clean");
