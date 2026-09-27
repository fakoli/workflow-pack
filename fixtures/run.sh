#!/usr/bin/env bash
# Cold-session fixture runner: replays the triggering incident (and positive /
# negative controls) through fresh ephemeral pi sessions and evaluates each
# transcript against its expect.json.
#
# Usage:
#   ./fixtures/run.sh --list          # list cases without running
#   ./fixtures/run.sh [case ...]      # run all (or only named) cases
#
# Each case dir contains prompt.txt, expect.json, and optional setup.sh.
# Results land in fixtures/results/<timestamp>/. Evaluation is heuristic
# (pattern matching over the transcript); review transcripts for flakiness.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CASES_DIR="${ROOT}/fixtures/cases"
RESULTS_DIR="${ROOT}/fixtures/results/$(date +%Y-%m-%dT%H%M%S)"
PI_BIN="${PI_BIN:-pi}"

if [[ "${1:-}" == "--list" ]]; then
  for d in "${CASES_DIR}"/*/; do
    echo "$(basename "${d}")"
  done
  exit 0
fi

mkdir -p "${RESULTS_DIR}"
only=("$@")
pass=0
fail=0

for d in "${CASES_DIR}"/*/; do
  name="$(basename "${d}")"
  if [[ ${#only[@]} -gt 0 ]] && ! [[ " ${only[*]} " == *" ${name} "* ]]; then
    continue
  fi

  work="$(mktemp -d)"
  if [[ -f "${d}setup.sh" ]]; then
    pushd "${work}" >/dev/null
    # shellcheck disable=SC1090
    source "${d}setup.sh" "${work}"
    popd >/dev/null
  fi

  echo "== ${name}"
  transcript="${RESULTS_DIR}/${name}.transcript.txt"
  run_cmd=("${PI_BIN}" --no-session -p "$(cat "${d}prompt.txt")")
  if command -v timeout >/dev/null 2>&1; then
    run_cmd=(timeout 600 "${run_cmd[@]}")
  fi
  if ! (cd "${work}" && "${run_cmd[@]}") >"${transcript}" 2>&1; then
    echo "   FAIL (agent exited nonzero — see ${transcript})"
    fail=$((fail + 1))
    continue
  fi

  verdict="$(python3 - "${d}expect.json" "${transcript}" <<'PY'
import json, re, sys
expect = json.load(open(sys.argv[1]))
text = open(sys.argv[2], encoding="utf-8", errors="replace").read()
problems = []
for pat in expect.get("forbid", []):
    if re.search(pat, text):
        problems.append(f"forbidden pattern present: {pat!r}")
req = expect.get("require_any", [])
if req and not any(re.search(p, text) for p in req):
    problems.append(f"none of the required patterns present: {req}")
print("PASS" if not problems else "FAIL: " + "; ".join(problems))
PY
)"
  echo "   ${verdict}"
  if [[ "${verdict}" == PASS* ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
  fi
done

echo ""
echo "results: ${RESULTS_DIR}  (pass ${pass} / fail ${fail})"
[[ ${fail} -eq 0 ]]
