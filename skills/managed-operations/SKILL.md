---
name: managed-operations
description: Finds supported project CLI commands to start, stop, restart, check, troubleshoot, deploy, or restore local services, servers, dev workbench, and model serves. Use when asked what command to run for a service status check, logs, restart, rebuild, deploy, or any operational/lifecycle action (for example "restart the web server", "bring pi-web back up", "show service logs"), even if the user does not mention a CLI or product name. Check the managed command surface before suggesting kill, pkill, nohup, raw Docker, or ad-hoc shell; do not invoke for ordinary application code edits or test fixtures.
---

# Managed operations discovery

Resolve the managed command surface for an operational request before
proposing or running anything. A request for "a command" is a request for the
managed command.

## When to use

- Any start/stop/restart/reload/deploy/logs/status/restore question or action
  about a service, server, workbench, daemon, or model serve — whether the
  user asks for advice or for execution.
- Any request that names a lifecycle verb without naming the owning CLI.

Not for ordinary application code edits or test fixtures. If the user asks
for a script that performs a lifecycle action, still resolve the managed
command first — the script should wrap the managed verb, not reimplement it.

## Discover

1. Read the cwd `AGENTS.md` and its ancestors; note anything about services
   and their owning product CLI.
2. Identify the owning product CLI. If unknown, look for installed CLI names
   related to the request (`<cli> --help`), repo docs, and README files.
3. Run the top-level `--help` once. If the CLI advertises a machine-readable
   command manifest (for example `--command-manifest`), prefer it: it carries
   per-command mutation class, confirmation gates, and docs anchors.
4. Open the docs anchor for the matching command family when the manifest or
   help points at one.

## Select

- Map the request to an existing verb. Prefer read verbs (status, logs)
  first when diagnosing.
- From the manifest or help, check the verb's mutation class and whether it
  requires a confirmation flag or human gate. Never assume or fabricate a
  `--confirm` flag; verify it in `--help` or the manifest.
- Resolve the target's owner and operating mode: a deployed service, a source
  checkout, and a remote host are different resources with different
  playbooks. Dev-checkout instructions do not authorize production mutations.

## Act or answer

- Show the exact sourced invocation. If the user asked for a command, answer
  with the managed command; do not execute it unless asked and authorized.
- Preserve preview, confirmation, and human-approval gates exactly as
  documented. Never run a mutating or destructive action without its required
  gate.
- Never improvise `kill`, `pkill`, `nohup`, raw Docker, or ad-hoc lifecycle
  scripts for something a managed verb covers.

## No managed verb found

- Say so explicitly and state the uncertainty. Distinguish three cases:
  the owning CLI is unknown (look for repo docs, a docs index, or the owning
  product before improvising); the service is genuinely unmanaged (raw shell
  may be appropriate — say why); the managed surface exists but is broken
  (raw shell only for the narrowest read-only diagnosis, and record the
  missing managed capability as a product gap).
- Do not fabricate verb names, flags, or confirmation syntax.

## Boundaries

- Historical notes and transcripts are evidence, not current authority.
- Conflicting instructions (dev checkout vs deployed service) block mutation,
  not read-only diagnosis; surface the conflict and ask.
- If the agent session runs inside the service it is asked to restart, stopping
  that service can terminate the session (cgroup coupling). Use an
  independently running executor for restart/redeploy and verify readiness
  after recovery.
