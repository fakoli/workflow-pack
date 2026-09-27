#!/usr/bin/env node
// Compile pack/workflow-pack.v1.json into installable artifacts.
// dist/ is generated — never hand-edit.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(
  readFileSync(join(root, "pack/workflow-pack.v1.json"), "utf8"),
);

if (manifest.schema !== "workflow-pack/v1") {
  console.error(`build: unsupported schema ${manifest.schema}`);
  process.exit(1);
}

const begin =
  "<!-- workflow-pack:seek-first begin (generated; edit pack/workflow-pack.v1.json) -->";
const end = "<!-- workflow-pack:seek-first end -->";
const block = `${begin}\n${manifest.seek_first}\n${end}\n`;

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist/AGENTS-seek-first.md"), block);
console.log("build: wrote dist/AGENTS-seek-first.md");
