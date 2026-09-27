#!/usr/bin/env bash
# Cold-session fixture runner.
#
# Runs each case through a fresh ephemeral pi session. `--mode json` captures
# the full event transcript; fixtures/evaluator.py extracts executed tool
# inputs (deduplicated by toolCallId) and finalized assistant text — never
# user messages or tool results — and validates transcript completion.
#
#   forbid_tools  — regexes checked against executed tool-call inputs
#   forbid_text   — regexes checked against finalized assistant text
#   require_any   — at least one regex must appear in tool inputs or text
#   require_all   — every regex must appear in tool inputs or text
#
# Usage:
#   ./fixtures/run.sh --list          # list cases without running
#   ./fixtures/run.sh [case ...]      # run all (or only named) cases
#
# ISOLATION WARNING: the fixture agent runs with this machine's real tools
# and environment. A temp cwd and --no-session do NOT sandbox it. Run only
# on machines where the referenced services are synthetic or where execution
# is acceptable. Keep this test isolation separate from any production
# guardrail. Each session is bounded by FIXTURE_TIMEOUT (seconds, default 600).
#
# Results land in fixtures/results/<stamp>/ (gitignored): per-case JSONL
# transcripts plus verdicts.json.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CASES_DIR="${ROOT}/fixtures/cases"
STAMP="$(date +%Y-%m-%dT%H%M%S)-$$"
RESULTS_DIR="${ROOT}/fixtures/results/${STAMP}"
PI_BIN="${PI_BIN:-pi}"
FIXTURE_TIMEOUT="${FIXTURE_TIMEOUT:-600}"

if [[ "${1:-}" == "--list" ]]; then
  for d in "${CASES_DIR}"/*/; do echo "$(basename "${d}")"; done
  exit 0
fi

requested=("$@")
if [[ ${#requested[@]} -gt 0 ]]; then
  for name in "${requested[@]}"; do
    if [[ ! -d "${CASES_DIR}/${name}" ]]; then
      echo "unknown case: ${name}" >&2
      echo "available cases:" >&2
      for d in "${CASES_DIR}"/*/; do echo "  $(basename "${d}")" >&2; done
      exit 1
    fi
  done
fi

mkdir -p "${RESULTS_DIR}"
pass=0
fail=0
ran=0

pi_version="$("${PI_BIN}" --version 2>/dev/null || echo unknown)"
verdicts_jsonl="${RESULTS_DIR}/verdicts.jsonl"
: > "${verdicts_jsonl}"

# Runs setup + agent inside ONE subshell so PATH/setup leaks stop at the case
# boundary. Every step is explicitly checked (`|| exit 1`) — do NOT rely on
# errexit here: `if ! run_case` suppresses errexit inside the subshell, so a
# failed setup would otherwise still launch the real agent.
run_case() {
  local case_dir="$1" name="$2" transcript="$3"
  local work
  work="$(mktemp -d)" || return 1
  (
    cd "${work}" || exit 1
    if [[ -f "${case_dir}setup.sh" ]]; then
      # shellcheck disable=SC1090
      source "${case_dir}setup.sh" "${work}" || exit 1
    fi
    timeout "${FIXTURE_TIMEOUT}" \
      "${PI_BIN}" --mode json --no-session \
      -p "$(cat "${case_dir}prompt.txt")" >"${transcript}" 2>&1 || exit 1
  )
  local rc=$?
  rm -rf "${work}"
  return "${rc}"
}

record() {  # record <case> <verdict> <problems-json-array>
  python3 - "$1" "$2" "$3" "${verdicts_jsonl}" <<'PY'
import json, sys
with open(sys.argv[4], "a") as f:
    f.write(json.dumps({"case": sys.argv[1], "verdict": sys.argv[2], "problems": json.loads(sys.argv[3])}) + "\n")
PY
}

for d in "${CASES_DIR}"/*/; do
  name="$(basename "${d}")"
  if [[ ${#requested[@]} -gt 0 ]] && ! [[ " ${requested[*]} " == *" ${name} "* ]]; then
    continue
  fi
  ran=$((ran + 1))

  if [[ ! -s "${d}prompt.txt" || ! -s "${d}expect.json" ]]; then
    echo "== ${name}"
    echo "   FAIL (missing prompt.txt or expect.json)"
    record "${name}" "FAIL" '["missing prompt.txt or expect.json"]'
    fail=$((fail + 1))
    continue
  fi

  echo "== ${name}"
  transcript="${RESULTS_DIR}/${name}.transcript.jsonl"
  if ! run_case "${d}" "${name}" "${transcript}"; then
    echo "   FAIL (agent exited nonzero, setup failed, or timed out — see ${transcript})"
    record "${name}" "FAIL" '["agent exited nonzero, setup failed, or timed out"]'
    fail=$((fail + 1))
    continue
  fi

  verdict="$(python3 "${ROOT}/fixtures/evaluator.py" "${d}expect.json" "${transcript}" "${name}" "${verdicts_jsonl}")"
  echo "   ${verdict}"
  if [[ "${verdict}" == PASS* ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
  fi
done

# Final artifact: atomic write; row count must equal cases run (fail-closed).
python3 - "${RESULTS_DIR}/verdicts.json" "${pi_version}" "${ran}" "${verdicts_jsonl}" <<'PY'
import json, os, sys
rows = []
try:
    for line in open(sys.argv[4]):
        line = line.strip()
        if line:
            rows.append(json.loads(line))
except FileNotFoundError:
    pass
ran = int(sys.argv[3])
if len(rows) != ran:
    print(f"results: row count {len(rows)} != cases run {ran}", file=sys.stderr)
    sys.exit(1)
tmp = sys.argv[1] + ".tmp"
with open(tmp, "w") as f:
    json.dump({"pi_version": sys.argv[2], "cases_run": ran, "results": rows}, f, indent=2)
os.replace(tmp, sys.argv[1])
PY
final_rc=$?

echo ""
echo "results: ${RESULTS_DIR}  (pass ${pass} / fail ${fail} / ran ${ran})"
[[ ${ran} -gt 0 && ${fail} -eq 0 && ${final_rc} -eq 0 ]]
