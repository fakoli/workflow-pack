#!/usr/bin/env bash
# Deterministic shared-contract gate. No model sessions or live-home install.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

bash -n install.sh test-install.sh fixtures/test-evaluator.sh fixtures/check-contract.sh
node --check lib/guardrail.mjs
node --check fixtures/test-lib.mjs
node --check fixtures/test-shell-boundaries.mjs
node scripts/build.mjs
node fixtures/test-lib.mjs
node fixtures/test-shell-boundaries.mjs
./test-install.sh
./fixtures/test-evaluator.sh
# Installed-target evidence is scoped to this temporary HOME, not production.
HOME="${work}" ./install.sh
HOME="${work}" node lint/check.mjs --installed
git diff --check
printf '%s\n' 'shared contract gate: PASS (isolated install; no agent sessions)'
