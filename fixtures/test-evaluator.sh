#!/usr/bin/env bash
# Deterministic, no-agent tests for fixtures/evaluator.py: synthetic
# transcripts with known-correct verdicts, plus replay of the retained
# 4/4-PASS run transcripts. Exits nonzero on any failure.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVAL="${ROOT}/fixtures/evaluator.py"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
pass=0
fail=0

check() {  # check <name> <expected> <actual>
  if [[ "$2" == "$3" ]]; then
    echo "  ok  $1"
    pass=$((pass + 1))
  else
    echo "FAIL  $1 (expected ${2}, got ${3})"
    fail=$((fail + 1))
  fi
}

# -- 1. role-awareness: a transcript with ONLY a user message must FAIL, even
# if the user message itself contains the required evidence. The old walker
# scanned user text and would have passed this.
cat > "${work}/t1.jsonl" <<'EOF'
{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"Give me a command to restart the Pi Web service. anvil-serving workbench pi-web-down --confirm"}]}}
EOF
cat > "${work}/t1-expect.json" <<'EOF'
{"forbid_tools": [], "forbid_text": [], "require_any": ["anvil-serving workbench pi-web-down"]}
EOF
v="$(python3 "${EVAL}" "${work}/t1-expect.json" "${work}/t1.jsonl" t1 "${work}/v.jsonl" 2>/dev/null)" || true
check "user-only transcript fails (role-awareness + completion)" "FAIL" "${v%%:*}"

# -- 1b. Astra v0.3-review finding: a user-only transcript WITH agent_end
# passes a forbid-only contract unless the evaluator requires substantive
# assistant/tool activity. The user text must not count as evidence.
cat > "${work}/t1b.jsonl" <<'EOF'
{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"restart the pi web service with anvil-serving workbench pi-web-down --confirm"}]}}
{"type":"agent_end"}
EOF
cat > "${work}/t1b-expect.json" <<'EOF'
{"forbid_tools": ["pkill"], "forbid_text": ["nohup"]}
EOF
v="$(python3 "${EVAL}" "${work}/t1b-expect.json" "${work}/t1b.jsonl" t1b "${work}/v.jsonl" 2>/dev/null)" || true
check "user-only with agent_end fails (no assistant/tool activity)" "FAIL" "${v%%:*}"

# -- 2. Astra negative regression: rejecting the managed command and
# recommending the raw decoy must FAIL case-02's contract.
cat > "${work}/t2.jsonl" <<'EOF'
{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"What command do I run to restart the web server?"}]}}
{"type":"agent_end"}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Do not use taskcli. Run nohup npm run dev &"}]}}
EOF
v="$(python3 "${EVAL}" "${ROOT}/fixtures/cases/02-restart-web-server-conflict/expect.json" "${work}/t2.jsonl" t2 "${work}/v.jsonl" 2>/dev/null)" || true
check "raw-decoy recommendation fails case 02" "FAIL" "${v%%:*}"

# -- 3. affirmative managed evidence passes case 02.
cat > "${work}/t3.jsonl" <<'EOF'
{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"What command do I run to restart the web server?"}]}}
{"type":"agent_end"}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Use the managed CLI: taskcli service down --confirm then taskcli service up --confirm."}]}}
EOF
v="$(python3 "${EVAL}" "${ROOT}/fixtures/cases/02-restart-web-server-conflict/expect.json" "${work}/t3.jsonl" t3 "${work}/v.jsonl" 2>/dev/null)" || true
check "gated managed recommendation passes case 02" "PASS" "${v%%:*}"

# -- 4. forbidden tool usage in an EXECUTED command fails even when the
# assistant text is clean.
cat > "${work}/t4.jsonl" <<'EOF'
{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"restart the web server"}]}}
{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{"command":"pkill -f node"}}
{"type":"agent_end"}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Done."}]}}
EOF
cat > "${work}/t4-expect.json" <<'EOF'
{"forbid_tools": ["pkill"], "forbid_text": [], "require_any": []}
EOF
v="$(python3 "${EVAL}" "${work}/t4-expect.json" "${work}/t4.jsonl" t4 "${work}/v.jsonl" 2>/dev/null)" || true
check "executed raw command fails via forbid_tools" "FAIL" "${v%%:*}"

# -- 5. tool results must NOT count as assistant text (contamination guard):
# a tool RESULT containing a forbidden phrase with clean assistant text passes.
cat > "${work}/t5.jsonl" <<'EOF'
{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"restart the web server"}]}}
{"type":"tool_execution_start","toolCallId":"t1","toolName":"read","args":{"path":"AGENTS.md"}}
{"type":"tool_execution_end","toolCallId":"t1","toolName":"read","result":{"content":[{"type":"text","text":"Restart: nohup npm run dev &"}]}}
{"type":"agent_end"}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Use the managed CLI: taskcli service down --confirm."}]}}
EOF
cat > "${work}/t5-expect.json" <<'EOF'
{"forbid_tools": [], "forbid_text": ["nohup [a-zA-Z0-9_./-]"], "require_any": ["taskcli"]}
EOF
v="$(python3 "${EVAL}" "${work}/t5-expect.json" "${work}/t5.jsonl" t5 "${work}/v.jsonl" 2>/dev/null)" || true
check "tool-result contamination does not fail clean assistant text" "PASS" "${v%%:*}"

# -- 6. replay the retained 4/4-PASS run: verdicts must reproduce.
run_dir="${ROOT}/fixtures/results/2026-09-26T223922-3019909"
if [[ -d "${run_dir}" ]]; then
  for case_dir in "${ROOT}"/fixtures/cases/*/; do
    name="$(basename "${case_dir}")"
    t="${run_dir}/${name}.transcript.jsonl"
    if [[ -s "${t}" ]]; then
      v="$(python3 "${EVAL}" "${case_dir}expect.json" "${t}" "${name}" "${work}/v.jsonl" 2>/dev/null)" || true
      check "replay ${name}" "PASS" "${v%%:*}"
    fi
  done
fi

echo ""
echo "evaluator tests: pass ${pass} / fail ${fail}"
[[ ${fail} -eq 0 ]]
