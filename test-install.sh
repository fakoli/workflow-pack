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

# -- 6. staging-failure injection: asset staging fails → rollback restores
# completed writes, backups reported --
rm -rf "${HOME}"; mkdir -p "${HOME}"
(cd "${ROOT}" && ./install.sh >/dev/null 2>&1); check "pre-injection fresh install exits 0" "$?"
before_injection_skill="$(cat "${HOME}/.agents/skills/managed-operations/SKILL.md")"
before_injection_index="$(cat "${HOME}/.pi/agent/extensions/pi-workflow-pack/index.ts")"
chmod 000 "${ROOT}/lib"
if (cd "${ROOT}" && ./install.sh >"${work}/injection.log" 2>&1); then r=1; else r=0; fi
chmod 755 "${ROOT}/lib"
check "staging failure exits nonzero" "$r"
grep -q "rolled back" "${work}/injection.log"; check "failure reports rollback" "$?"
grep -q ".backups/" "${work}/injection.log"; check "failure reports backup location" "$?"
[[ "$(cat "${HOME}/.agents/skills/managed-operations/SKILL.md")" == "${before_injection_skill}" ]]; check "rollback restored skill content" "$?"
[[ "$(cat "${HOME}/.pi/agent/extensions/pi-workflow-pack/index.ts")" == "${before_injection_index}" ]]; check "rollback restored index.ts" "$?"

# -- 7. regular file at the lib destination is refused --
rm -rf "${HOME}"; mkdir -p "${HOME}/.pi/agent/extensions/pi-workflow-pack"
printf 'not a dir\n' > "${HOME}/.pi/agent/extensions/pi-workflow-pack/lib"
if (cd "${ROOT}" && HOME="${HOME}" ./install.sh >/dev/null 2>&1); then r=1; else r=0; fi
check "regular file at lib destination refused" "$r"

# -- 8. lib assets installed on fresh install --
rm -rf "${HOME}"; mkdir -p "${HOME}"
(cd "${ROOT}" && ./install.sh >/dev/null 2>&1); check "fresh install exits 0" "$?"
[[ -f "${HOME}/.pi/agent/extensions/pi-workflow-pack/lib/guardrail.mjs" ]]; check "lib asset installed" "$?"

# -- 6b. restoration of distinguishable content after a completed skill
# replacement: tamper the installed skill, make the extension source
# unreadable, and verify rollback restores the pre-run (tampered) content --
rm -rf "${HOME}"; mkdir -p "${HOME}"
(cd "${ROOT}" && ./install.sh >/dev/null 2>&1); check "pre-restore fresh install exits 0" "$?"
printf 'TAMPERED-MARKER\n' > "${HOME}/.agents/skills/managed-operations/SKILL.md"
chmod 000 "${ROOT}/extensions/pi-workflow-pack/index.ts"
if (cd "${ROOT}" && ./install.sh >"${work}/restore.log" 2>&1); then r=1; else r=0; fi
chmod 644 "${ROOT}/extensions/pi-workflow-pack/index.ts"
check "extension-source failure exits nonzero" "$r"
[[ "$(cat "${HOME}/.agents/skills/managed-operations/SKILL.md")" == "TAMPERED-MARKER" ]]; check "rollback restored distinguishable pre-run content (not repo bytes)" "$?"

# -- 6c. restoration of a REPLACED DIRECTORY TREE with distinguishable
# content: tamper the installed lib, then make the AGENTS.md mv fail via a
# PATH shim AFTER skills/index.ts/lib were replaced — rollback must restore
# the pre-run lib tree (marker file intact) --
rm -rf "${HOME}"; mkdir -p "${HOME}"
(cd "${ROOT}" && ./install.sh >/dev/null 2>&1); check "pre-dir-restore fresh install exits 0" "$?"
printf 'DIR-TAMPER-MARKER\n' > "${HOME}/.pi/agent/extensions/pi-workflow-pack/lib/TAMPERED"
REAL_MV="$(command -v mv)"
shim="${work}/shim"; mkdir -p "${shim}"
cat > "${shim}/mv" <<SHIM
#!/bin/sh
for arg in "\$@"; do
  case "\${arg}" in
    */AGENTS.md.tmp*) exit 1 ;;
  esac
done
exec "${REAL_MV}" "\$@"
SHIM
chmod +x "${shim}/mv"
if (cd "${ROOT}" && PATH="${shim}:${PATH}" ./install.sh >"${work}/dir-restore.log" 2>&1); then r=1; else r=0; fi
check "AGENTS.md mv failure exits nonzero" "$r"
grep -q "rolled back" "${work}/dir-restore.log"; check "recovery summary reported" "$?"
[[ -f "${HOME}/.pi/agent/extensions/pi-workflow-pack/lib/TAMPERED" ]]; check "rollback restored the replaced lib DIRECTORY tree (marker intact)" "$?"
[[ "$(cat "${HOME}/.agents/skills/managed-operations/SKILL.md" 2>/dev/null | head -1)" != "" ]]; check "skill also restored after directory rollback" "$?"

# -- 6d. asset cleanup failure does not lose the replacement registration:
# an rm shim failing on the staged .old backup must not abort the run —
# the swap is registered first, the cleanup warns, and the install succeeds --
rm -rf "${HOME}"; mkdir -p "${HOME}"
(cd "${ROOT}" && ./install.sh >/dev/null 2>&1); check "pre-cleanup fresh install exits 0" "$?"
REAL_RM="$(command -v rm)"
shim2="${work}/shim-rm"; mkdir -p "${shim2}"
cat > "${shim2}/rm" <<SHIMRM
#!/bin/sh
for arg in "\$@"; do
  case "\${arg}" in
    *.old.*) exit 1 ;;
  esac
done
exec "${REAL_RM}" "\$@"
SHIMRM
chmod +x "${shim2}/rm"
if (cd "${ROOT}" && PATH="${shim2}:${PATH}" ./install.sh >"${work}/cleanup.log" 2>&1); then r=0; else r=1; fi
check "cleanup failure does not fail the install (registration precedes cleanup)" "$r"
grep -q "could not remove staged backup" "${work}/cleanup.log"; check "cleanup failure reported" "$?"
[[ -d "${HOME}/.pi/agent/extensions/pi-workflow-pack/lib" ]]; check "lib replaced despite cleanup failure" "$?"

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
