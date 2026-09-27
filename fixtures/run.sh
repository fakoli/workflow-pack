#!/usr/bin/env bash
# Cold-session fixture runner.
#
# Runs each case through a fresh ephemeral pi session. `--mode json` captures
# the FULL event transcript — executed tool calls AND assistant text — so the
# evaluation can separate what the agent DID from what it SAID.
#
#   forbid_tools  — regexes checked against executed tool-call inputs
#   forbid_text   — regexes checked against assistant text
#   require_any   — at least one regex must appear in tool calls or text
#
# Usage:
#   ./fixtures/run.sh --list          # list cases without running
#   ./fixtures/run.sh [case ...]      # run all (or only named) cases
#
# ISOLATION WARNING: the fixture agent runs with this machine's real tools
# and environment. A temp cwd and --no-session do NOT sandbox it. Run only
# on machines where the referenced services are synthetic or where execution
# is acceptable. Keep this test isolation separate from any production
# guardrail.
#
# Results land in fixtures/results/<stamp>/ (gitignored): per-case JSONL
# transcripts plus verdicts.json.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CASES_DIR="${ROOT}/fixtures/cases"
STAMP="$(date +%Y-%m-%dT%H%M%S)-$$"
RESULTS_DIR="${ROOT}/fixtures/results/${STAMP}"
PI_BIN="${PI_BIN:-pi}"

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

# Runs setup + agent inside ONE subshell so PATH/setup leaks stop at the
# case boundary; setup failure is fatal to the case.
run_case() {
  local case_dir="$1" name="$2" transcript="$3"
  local work
  work="$(mktemp -d)" || return 1
  (
    set -e
    cd "${work}"
    if [[ -f "${case_dir}setup.sh" ]]; then
      # shellcheck disable=SC1090
      source "${case_dir}setup.sh" "${work}"
    fi
    "${PI_BIN}" --mode json --no-session -p "$(cat "${case_dir}prompt.txt")" \
      >"${transcript}" 2>&1
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
    echo "   FAIL (agent exited nonzero — see ${transcript})"
    record "${name}" "FAIL" '["agent exited nonzero"]'
    fail=$((fail + 1))
    continue
  fi

  verdict="$(python3 - "${d}expect.json" "${transcript}" "${name}" "${verdicts_jsonl}" <<'PY'
import json, re, sys

expect = json.load(open(sys.argv[1]))

tool_inputs, texts = [], []

def walk(o):
    if isinstance(o, dict):
        name = o.get("tool") or o.get("toolName") or o.get("name")
        if isinstance(name, str) and name.lower() in (
            "bash", "read", "edit", "write", "grep", "find", "apply_patch",
        ):
            inp = o.get("input") or o.get("arguments") or o.get("args") or {}
            if isinstance(inp, dict):
                tool_inputs.append(json.dumps(inp))
            elif isinstance(inp, str):
                tool_inputs.append(inp)
        for k, v in o.items():
            if k in ("text", "content", "message") and isinstance(v, str):
                texts.append(v)
            else:
                walk(v)
    elif isinstance(o, list):
        for x in o:
            walk(x)

for line in open(sys.argv[2], encoding="utf-8", errors="replace"):
    line = line.strip()
    if not line:
        continue
    try:
        walk(json.loads(line))
    except Exception:
        continue

joined_tools = "\n".join(tool_inputs)
joined_text = "\n".join(texts)
problems = []
for pat in expect.get("forbid_tools", []):
    if re.search(pat, joined_tools):
        problems.append(f"forbidden tool usage: {pat!r}")
for pat in expect.get("forbid_text", []):
    if re.search(pat, joined_text):
        problems.append(f"forbidden pattern in assistant text: {pat!r}")
req = expect.get("require_any", [])
if req and not any(re.search(p, joined_tools + "\n" + joined_text) for p in req):
    problems.append(f"no required evidence in tool calls or text: {req}")
row = {"case": sys.argv[3], "verdict": "PASS" if not problems else "FAIL", "problems": problems}
with open(sys.argv[4], "a") as f:
    f.write(json.dumps(row) + "\n")
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

python3 - "${RESULTS_DIR}/verdicts.json" "${pi_version}" "${ran}" "${verdicts_jsonl}" <<'PY'
import json, sys
rows = []
try:
    for line in open(sys.argv[4]):
        line = line.strip()
        if line:
            rows.append(json.loads(line))
except FileNotFoundError:
    pass
json.dump({"pi_version": sys.argv[2], "cases_run": int(sys.argv[3]), "results": rows},
          open(sys.argv[1], "w"), indent=2)
PY

echo ""
echo "results: ${RESULTS_DIR}  (pass ${pass} / fail ${fail} / ran ${ran})"
[[ ${ran} -gt 0 && ${fail} -eq 0 ]]
