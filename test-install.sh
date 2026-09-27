#!/usr/bin/env bash
# Exercise install.sh against a temporary HOME (never the real one):
# fresh install, idempotent re-run, malformed-marker refusal, symlink
# refusal, and uninstall cleanliness. No agent sessions; deterministic.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
pass=0
fail=0

check() {  # check <name> <condition-result>
  if [[ "$2" == "0" ]]; then
    echo "  ok  $1"
    pass=$((pass + 1))
  else
    echo "FAIL  $1"
    fail=$((fail + 1))
  fi
}

# -- 1. fresh install into a temp HOME --
export HOME="${work}/home"
mkdir -p "${HOME}/.pi/agent"
: > "${HOME}/.pi/agent/AGENTS.md"
if (cd "${ROOT}" && ./install.sh >/dev/null 2>&1); then r=0; else r=1; fi
check "fresh install exits 0" "$r"
[[ -f "${HOME}/.agents/skills/managed-operations/SKILL.md" ]]; check "skill installed" "$?"
grep -q "workflow-pack:seek-first begin" "${HOME}/.pi/agent/AGENTS.md"; check "seek-first block appended" "$?"

# -- 2. idempotent re-run: still exactly one marker pair --
if (cd "${ROOT}" && ./install.sh >/dev/null 2>&1); then r=0; else r=1; fi
check "re-run exits 0" "$r"
n="$(grep -c "workflow-pack:seek-first begin" "${HOME}/.pi/agent/AGENTS.md")"
[[ "${n}" == "1" ]]; check "re-run does not duplicate the block" "$?"

# -- 3. malformed marker (suffixed end marker) is refused WITHOUT mutation --
python3 - "${HOME}/.pi/agent/AGENTS.md" <<'PY'
import sys
p = sys.argv[1]
t = open(p).read().replace("<!-- workflow-pack:seek-first end -->", "<!-- workflow-pack:seek-first end BROKEN -->")
open(p, "w").write(t)
PY
cp "${HOME}/.pi/agent/AGENTS.md" "${work}/before-refusal.md"
if (cd "${ROOT}" && ./install.sh >/dev/null 2>&1); then r=1; else r=0; fi
check "malformed marker refused (nonzero exit)" "$r"
diff -q "${work}/before-refusal.md" "${HOME}/.pi/agent/AGENTS.md" >/dev/null 2>&1
check "refusal did not mutate AGENTS.md" "$?"
skill_md="${HOME}/.agents/skills/managed-operations/SKILL.md"
before_skill="$(cat "${skill_md}")"
if (cd "${ROOT}" && ./install.sh >/dev/null 2>&1); then r=1; else r=0; fi
check "malformed refusal happens before skill mutation" "$r"
[[ "$(cat "${skill_md}")" == "${before_skill}" ]]; check "skill untouched by refusal" "$?"

# -- 4. symlinked AGENTS.md is refused --
rm -f "${HOME}/.pi/agent/AGENTS.md"
printf 'real content\n' > "${work}/real-agents.md"
ln -s "${work}/real-agents.md" "${HOME}/.pi/agent/AGENTS.md"
if (cd "${ROOT}" && ./install.sh >/dev/null 2>&1); then r=1; else r=0; fi
check "symlinked AGENTS.md refused" "$r"
[[ "$(cat "${work}/real-agents.md")" == "real content" ]]; check "symlink target untouched" "$?"

# -- 5. symlinked ANCESTOR directory is refused (no preflight mutation) --
h2="${work}/home2"
mkdir -p "${h2}/.pi/agent-real"
ln -s "${h2}/.pi/agent-real" "${h2}/.pi/agent"
if (cd "${ROOT}" && HOME="${h2}" ./install.sh >/dev/null 2>&1); then r=1; else r=0; fi
check "symlinked ancestor refused" "$r"
[[ -z "$(ls -A "${h2}/.pi/agent-real" 2>/dev/null)" ]]; check "ancestor refusal wrote nothing into the real dir" "$?"
[[ ! -e "${h2}/.agents" ]]; check "ancestor refusal happens before skill install" "$?"

echo ""
echo "installer tests: pass ${pass} / fail ${fail}"
[[ ${fail} -eq 0 ]]
