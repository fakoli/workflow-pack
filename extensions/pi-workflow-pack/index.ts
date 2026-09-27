/**
 * pi-workflow-pack — bounded discovery + shadow-mode guardrail.
 *
 * Two capabilities, both read-only by default:
 *
 * 1. `ops_discover` custom tool — projects the owning product's
 *    machine-readable command manifest (mutation class, confirmation gates,
 *    docs anchors) for the verb family matching an operational task. Reads
 *    the existing registry; never a second catalog. Runs ONLY the manifest's
 *    registered discovery commands, with a timeout and bounded output.
 *
 * 2. Shadow-mode guardrail: observes bash tool calls matching raw lifecycle
 *    patterns (kill/pkill/nohup/systemctl restart/...) and appends a JSONL
 *    audit row. NEVER blocks and NEVER mutates input in shadow mode —
 *    enforcement is out of scope until the roadmap's soft-deny/hard-deny
 *    tiers ship with human-mediated override.
 *
 * Configuration (environment):
 *   WORKFLOW_PACK_MANIFEST — path to workflow-pack.v1.json
 *                            (default: ~/code/workflow-pack/pack/workflow-pack.v1.json)
 *   WORKFLOW_PACK_AUDIT    — audit JSONL path
 *                            (default: ~/.local/state/workflow-pack/audit.jsonl)
 *   WORKFLOW_PACK_MODE     — "shadow" (default) | "off"
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const MAX_OUTPUT_CHARS = 6000;
const DISCOVERY_TIMEOUT_MS = 10_000;
const AUDIT_COMMAND_MAX = 500;

const RAW_LIFECYCLE_PATTERNS: Array<[string, RegExp]> = [
  ["kill", /\bkill\b/],
  ["pkill", /\bpkill\b/],
  ["nohup", /\bnohup\b/],
  ["killall", /\bkillall\b/],
  ["systemctl-lifecycle", /\bsystemctl\s+(start|stop|restart|kill|reload)\b/],
  ["docker-lifecycle", /\bdocker\s+(kill|restart|stop|rm)\b/],
  ["launchctl-lifecycle", /\blaunchctl\s+(unload|bootout|remove)\b/],
];

function manifestPath(): string {
  return (
    process.env.WORKFLOW_PACK_MANIFEST ||
    join(homedir(), "code/workflow-pack/pack/workflow-pack.v1.json")
  );
}

function auditPath(): string {
  return (
    process.env.WORKFLOW_PACK_AUDIT ||
    join(homedir(), ".local/state/workflow-pack/audit.jsonl")
  );
}

interface VerbFamily {
  name: string;
  discovery?: string;
  manifest?: string;
  triggers?: string[];
  examples?: string[];
}

function loadManifest(): { manifest?: any; error?: string } {
  const p = manifestPath();
  if (!existsSync(p)) {
    return { error: `workflow-pack manifest not found at ${p} (set WORKFLOW_PACK_MANIFEST)` };
  }
  try {
    return { manifest: JSON.parse(readFileSync(p, "utf8")) };
  } catch (e) {
    return { error: `workflow-pack manifest does not parse: ${e}` };
  }
}

function matchFamilies(manifest: any, task: string, cli?: string): VerbFamily[] {
  const families: VerbFamily[] = Array.isArray(manifest.verb_families) ? manifest.verb_families : [];
  if (cli) {
    const exact = families.filter((f) => f.name === cli);
    if (exact.length) return exact;
  }
  const words = task.toLowerCase();
  const scored = families
    .map((f) => {
      const hits = (f.triggers || []).filter((t) => words.includes(t.toLowerCase())).length;
      return { f, hits };
    })
    .filter(({ hits }) => hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 3);
  return scored.map(({ f }) => f);
}

function runDiscovery(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    const [file, ...args] = cmd.split(/\s+/);
    execFile(file, args, { timeout: DISCOVERY_TIMEOUT_MS }, (err, stdout, stderr) => {
      const out = `${stdout || ""}${stderr ? `\n${stderr}` : ""}`.trim();
      if (err && !out) {
        resolve(`(discovery command failed: ${err.message})`);
        return;
      }
      resolve(out.slice(0, MAX_OUTPUT_CHARS) || "(no output)");
    });
  });
}

function audit(command: string, matched: string[]): void {
  if ((process.env.WORKFLOW_PACK_MODE || "shadow") === "off") return;
  const row = {
    ts: new Date().toISOString(),
    mode: "shadow",
    tool: "bash",
    command: command.slice(0, AUDIT_COMMAND_MAX),
    matched,
    action: "logged",
  };
  try {
    const p = auditPath();
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(row) + "\n");
  } catch {
    // audit is best-effort in shadow mode; never break the tool call
  }
}

export default function (pi: ExtensionAPI) {
  // -- shadow-mode guardrail: observe + log, never block --
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const command = String(event.input?.command || "");
    if (!command) return;
    const matched = RAW_LIFECYCLE_PATTERNS.filter(([, re]) => re.test(command)).map(([name]) => name);
    if (matched.length) audit(command, matched);
    // shadow mode: no block, no mutation
    return;
  });

  // -- bounded discovery tool (read-only) --
  pi.registerTool({
    name: "ops_discover",
    label: "Ops discover",
    description:
      "Bounded read-only discovery of managed operational commands. Given an operational task, projects the matching verb family's machine-readable command manifest (mutation class, confirmation gates, docs anchors) from the workflow-pack registry. Runs only the registry's registered discovery commands. Use before proposing or running any start/stop/restart/deploy/logs command.",
    parameters: Type.Object({
      task: Type.String({ description: "The operational need, e.g. 'restart the web server'" }),
      cli: Type.Optional(Type.String({ description: "Optional product CLI name hint, e.g. anvil-serving" })),
    }),
    async execute(_toolCallId, params) {
      const { manifest, error } = loadManifest();
      if (error) {
        return {
          content: [{ type: "text", text: `ops_discover: ${error}` }],
          details: {},
        };
      }
      const families = matchFamilies(manifest, params.task, params.cli);
      if (!families.length) {
        return {
          content: [{
            type: "text",
            text: `ops_discover: no verb family in the manifest matches task "${params.task}". Look for repo docs or the owning product's --help; do not improvise raw lifecycle commands.`,
          }],
          details: {},
        };
      }
      const parts: string[] = [];
      for (const fam of families) {
        const cmd = fam.manifest || fam.discovery;
        if (!cmd) continue;
        const out = await runDiscovery(cmd);
        parts.push(
          [
            `## family: ${fam.name}`,
            fam.manifest ? `manifest command: \`${fam.manifest}\`` : `discovery command: \`${fam.discovery}\``,
            fam.examples?.length ? `examples: ${fam.examples.map((e) => `\`${e}\``).join(", ")}` : "",
            "",
            "```",
            out,
            "```",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
      parts.push(
        "Map the task to an existing verb above. Check each verb's mutation class and confirmation gate; never improvise kill/pkill/nohup/raw Docker when a managed verb covers the target.",
      );
      return { content: [{ type: "text", text: parts.join("\n\n") }], details: {} };
    },
  });
}
