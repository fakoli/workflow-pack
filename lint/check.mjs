#!/usr/bin/env node
// Coverage lint: manifest <-> skills <-> compiled artifacts <-> fixtures <->
// installed targets. Exit 0 clean, exit 1 with findings. CI-able. stdlib-only.
//
//   node lint/check.mjs              # repo checks
//   node lint/check.mjs --installed  # also check installed harness targets
import { readFileSync, existsSync, readdirSync } from "node:fs";
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

// 1. manifest schema: field presence, types, cardinality
for (const field of ["schema", "name", "version", "seek_first", "skills", "verb_families"]) {
  if (manifest[field] === undefined) bad(`manifest missing field: ${field}`);
}
if (manifest.schema !== "workflow-pack/v1") {
  bad(`manifest schema is ${manifest.schema}, expected workflow-pack/v1`);
}
for (const [field, v] of [["name", manifest.name], ["version", manifest.version], ["seek_first", manifest.seek_first]]) {
  if (v !== undefined && (typeof v !== "string" || v.length === 0)) {
    bad(`manifest ${field} must be a non-empty string`);
  }
}
if (manifest.skills !== undefined && !Array.isArray(manifest.skills)) {
  bad("manifest skills must be an array");
}
if (Array.isArray(manifest.skills)) {
  if (manifest.skills.length === 0) bad("manifest skills[] is empty");
  for (const s of manifest.skills) {
    for (const f of ["name", "path", "install"]) {
      if (typeof s?.[f] !== "string" || !s[f]) bad(`manifest skill entry missing string field: ${f}`);
    }
  }
}
if (manifest.verb_families !== undefined && !Array.isArray(manifest.verb_families)) {
  bad("manifest verb_families must be an array");
}
if (Array.isArray(manifest.verb_families)) {
  if (manifest.verb_families.length === 0) bad("manifest verb_families[] is empty");
  for (const fam of manifest.verb_families) {
    if (typeof fam?.name !== "string" || !fam.name) bad("verb_family missing string name");
    if (!Array.isArray(fam?.triggers) || fam.triggers.length === 0) {
      bad(`verb_family ${fam?.name ?? "?"}: triggers must be a non-empty array`);
    } else if (fam.triggers.some((t) => typeof t !== "string" || !t)) {
      bad(`verb_family ${fam?.name ?? "?"}: triggers must all be non-empty strings`);
    }
    if (typeof fam?.discovery !== "string" || !fam.discovery) {
      bad(`verb_family ${fam?.name ?? "?"}: missing discovery command`);
    }
  }
}
if (!findings.length) {
  ok(`manifest ${manifest.name}@${manifest.version}: schema, types, cardinality`);
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
// skill description, matched on word boundaries (so "start" is not satisfied
// by "restart"). This is the failure class that caused the original incident.
for (const family of manifest.verb_families || []) {
  const triggers = family.triggers || [];
  const missing = triggers.filter((t) => {
    const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    return !descriptions.some((d) => re.test(d));
  });
  if (missing.length) {
    for (const t of missing) {
      bad(`trigger coverage: "${t}" (${family.name}) not covered by any skill description`);
    }
  } else {
    ok(`trigger coverage: ${family.name} (${triggers.length} trigger phrases, word-boundary matched)`);
  }
}

// 4. compiled artifact freshness: exact match against a fresh compile
const distPath = join(root, "dist/AGENTS-seek-first.md");
const beginMark = "<!-- workflow-pack:seek-first begin";
const endMark = "<!-- workflow-pack:seek-first end -->";
const expectedBlock = `${beginMark} (generated; edit pack/workflow-pack.v1.json) -->\n${manifest.seek_first}\n${endMark}\n`;
if (!existsSync(distPath)) {
  bad("dist/AGENTS-seek-first.md missing — run: node scripts/build.mjs");
} else {
  const dist = readFileSync(distPath, "utf8");
  if (dist !== expectedBlock) {
    bad("dist/AGENTS-seek-first.md is stale or malformed — run: node scripts/build.mjs");
  } else {
    ok("dist artifact exactly matches a fresh compile of the manifest");
  }
}

// 5. fixtures referenced by the pack are well-formed
const casesDir = join(root, "fixtures/cases");
if (!existsSync(casesDir)) {
  bad("fixtures/cases missing — no regression coverage");
} else {
  const cases = readdirSync(casesDir).filter((d) => !d.startsWith("."));
  if (cases.length === 0) bad("fixtures/cases is empty — no regression coverage");
  for (const c of cases) {
    const prompt = join(casesDir, c, "prompt.txt");
    const expectFile = join(casesDir, c, "expect.json");
    if (!existsSync(prompt) || !readFileSync(prompt, "utf8").trim()) {
      bad(`fixture ${c}: missing or empty prompt.txt`);
      continue;
    }
    if (!existsSync(expectFile)) {
      bad(`fixture ${c}: missing expect.json`);
      continue;
    }
    try {
      const expect = JSON.parse(readFileSync(expectFile, "utf8"));
      let hasTeeth = false;
      for (const key of ["forbid_tools", "forbid_text", "require_any", "require_all"]) {
        const arr = expect[key];
        if (arr === undefined) continue;
        if (!Array.isArray(arr) || arr.some((p) => typeof p !== "string" || !p)) {
          bad(`fixture ${c}: ${key} must be an array of non-empty strings`);
          continue;
        }
        for (const pat of arr) {
          try {
            // eslint-disable-next-line no-new -- compile check only
            new RegExp(pat);
          } catch {
            bad(`fixture ${c}: ${key} pattern does not compile: ${pat}`);
          }
        }
      }
      hasTeeth =
        (expect.forbid_tools?.length ?? 0) +
          (expect.forbid_text?.length ?? 0) +
          (expect.require_any?.length ?? 0) +
          (expect.require_all?.length ?? 0) >
        0;
      if (hasTeeth) ok(`fixture ${c}: well-formed`);
      else bad(`fixture ${c}: expect.json has no forbid/require patterns`);
      // fixture-to-family relationship: a declared family must exist in the
      // manifest's verb_families
      if (expect.family !== undefined) {
        const fams = (manifest.verb_families || []).map((f) => f.name);
        if (!fams.includes(expect.family)) {
          bad(`fixture ${c}: family "${expect.family}" not declared in manifest verb_families`);
        } else {
          ok(`fixture ${c}: family "${expect.family}" declared in manifest`);
        }
      }
    } catch (e) {
      bad(`fixture ${c}: expect.json does not parse (${e.message})`);
    }
  }
}

// 6. installed harness targets (opt-in)
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
  for (const ext of manifest.extensions || []) {
    const installed = ext.install?.replace("~", homedir());
    if (!installed) continue;
    if (!existsSync(join(installed, "index.ts"))) {
      bad(`installed extension missing: ${installed} — run: ./install.sh`);
    } else if (
      readFileSync(join(installed, "index.ts"), "utf8") !==
      readFileSync(join(root, ext.path, "index.ts"), "utf8")
    ) {
      bad(`installed extension drifts from repo: ${installed} — run: ./install.sh`);
    } else {
      ok(`installed extension matches repo: ${installed}`);
    }
    // shared runtime assets declared in the manifest (repo-root sources)
    for (const asset of ext.assets || []) {
      const repoAsset = join(root, asset);
      if (!existsSync(repoAsset)) {
        bad(`declared asset missing from repo: ${repoAsset}`);
        continue;
      }
      for (const f of readdirSync(repoAsset)) {
        const inst = join(installed, asset.replace(/^.*\//, ""), f);
        if (!existsSync(inst)) {
          bad(`installed lib asset missing: ${inst} — run: ./install.sh`);
        } else if (readFileSync(inst, "utf8") !== readFileSync(join(repoAsset, f), "utf8")) {
          bad(`installed lib asset drifts from repo: ${inst} — run: ./install.sh`);
        } else {
          ok(`installed lib asset matches repo: ${asset}/${f}`);
        }
      }
    }
  }
  const agents = join(homedir(), ".pi/agent/AGENTS.md");
  if (!existsSync(agents)) {
    bad(`global AGENTS.md missing: ${agents}`);
  } else {
    const text = readFileSync(agents, "utf8");
    if (!text.includes(manifest.seek_first)) {
      bad(`seek-first line not installed in ${agents} — run: ./install.sh`);
    } else {
      const begins = text.split(beginMark).length - 1;
      const ends = text.split(endMark).length - 1;
      if (begins !== 1 || ends !== 1) {
        bad(`marker structure malformed in ${agents} (begin=${begins}, end=${ends}) — fix manually`);
      } else if (text.indexOf(endMark) < text.indexOf(beginMark)) {
        bad(`end marker precedes begin marker in ${agents}`);
      } else {
        // the installed span itself must contain the generated block —
        // seek_first located outside the markers is drift
        const span = text.slice(text.indexOf(beginMark), text.indexOf(endMark) + endMark.length);
        if (!span.includes(manifest.seek_first)) {
          bad(`seek-first text not inside the marker span in ${agents} — run: ./install.sh`);
        } else {
          ok(`seek-first block installed with valid marker structure in ${agents}`);
        }
      }
    }
  }
}

console.log("");
if (findings.length) {
  console.log(`lint: ${findings.length} finding(s)`);
  process.exit(1);
}
console.log("lint: clean");
