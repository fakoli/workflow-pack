#!/usr/bin/env bash
# Install workflow-pack artifacts into harness dirs. Idempotent, fail-closed.
#   - compiles dist/ from the manifest
#   - installs every skill declared in the manifest (declared path -> install)
#   - upserts the seek-first block into ~/.pi/agent/AGENTS.md
#
# Safety: validates the EXACT marker grammar and computes the complete
# AGENTS.md replacement BEFORE mutating any installed target; refuses
# symlinked targets; writes unique private backups (never overwrites a
# same-day original); replaces files atomically in the same directory; fails
# WITHOUT mutation on malformed or duplicate seek-first markers.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${ROOT}/pack/workflow-pack.v1.json"
AGENTS_MD="${HOME}/.pi/agent/AGENTS.md"
STAMP="$(date +%Y-%m-%dT%H%M%S)-$$"
BACKUP_DIR="${ROOT}/.backups/${STAMP}"
BEGIN_LINE_PREFIX="<!-- workflow-pack:seek-first begin"
END_MARKER_EXACT="<!-- workflow-pack:seek-first end -->"

node "${ROOT}/scripts/build.mjs"

# -- preflight: marker structure with EXACT grammar (refuse to mutate on
# malformed input; a suffixed end marker like "... end BROKEN -->" is
# rejected here, not discovered after skills are already replaced) --
if [[ -L "${AGENTS_MD}" ]]; then
  echo "install: refuse: ${AGENTS_MD} is a symlink" >&2
  exit 1
fi
if [[ -e "${AGENTS_MD}" ]]; then
  python3 - "${AGENTS_MD}" "${BEGIN_LINE_PREFIX}" "${END_MARKER_EXACT}" <<'PY'
import sys
path, bm, em = sys.argv[1:4]
text = open(path).read()
begins = text.count(bm)
ends = text.count(em)
if begins != ends or begins > 1:
    sys.exit(f"install: malformed marker structure in {path} (begin={begins}, end={ends}); fix manually — refusing to mutate")
if begins == 1 and text.index(em) < text.index(bm):
    sys.exit(f"install: end marker precedes begin marker in {path}; refusing to mutate")
PY
fi

# -- preflight: declared skills (iterate the manifest, not skills[0]) --
skill_entries="$(node -e "
const m = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
if (!Array.isArray(m.skills) || m.skills.length === 0) {
  console.error('install: manifest declares no skills'); process.exit(1);
}
for (const s of m.skills) {
  if (!s.name || !s.path || !s.install) {
    console.error('install: skill entry missing name/path/install'); process.exit(1);
  }
  console.log(s.path + '|' + s.install);
}
" "${MANIFEST}")"

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"
while IFS= read -r entry; do
  src="${entry%%|*}"
  dst="${entry#*|}"
  dst="${dst/#\~/${HOME}}"
  [[ -f "${ROOT}/${src}" ]] || { echo "install: missing skill source ${src}" >&2; exit 1; }
  if [[ -L "${dst}" || -L "${dst}/SKILL.md" ]]; then
    echo "install: refuse: ${dst} is a symlink" >&2
    exit 1
  fi
  if [[ -e "${dst}/SKILL.md" ]]; then
    mkdir -p "${BACKUP_DIR}/skills/$(basename "${dst}")"
    cp -a "${dst}/SKILL.md" "${BACKUP_DIR}/skills/$(basename "${dst}")/SKILL.md"
  fi
done <<< "${skill_entries}"
# -- preflight: declared extensions (iterate the manifest) --
ext_entries="$(node -e "
const m = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
for (const s of (m.extensions || [])) {
  if (!s.name || !s.path || !s.install) {
    console.error('install: extension entry missing name/path/install'); process.exit(1);
  }
  console.log(s.path + '|' + s.install);
}
" "${MANIFEST}")"

while IFS= read -r entry; do
  src="${entry%%|*}"
  dst="${entry#*|}"
  dst="${dst/#\~/${HOME}}"
  [[ -f "${ROOT}/${src}/index.ts" ]] || { echo "install: missing extension source ${src}/index.ts" >&2; exit 1; }
  if [[ -L "${dst}" || -L "${dst}/index.ts" ]]; then
    echo "install: refuse: ${dst} is a symlink" >&2
    exit 1
  fi
  if [[ -e "${dst}/index.ts" ]]; then
    mkdir -p "${BACKUP_DIR}/extensions/$(basename "${dst}")"
    cp -a "${dst}/index.ts" "${BACKUP_DIR}/extensions/$(basename "${dst}")/index.ts"
  fi
done <<< "${ext_entries}"
if [[ -e "${AGENTS_MD}" ]]; then
  cp -a "${AGENTS_MD}" "${BACKUP_DIR}/AGENTS.md"
fi

# -- compute the complete AGENTS.md replacement BEFORE mutating anything --
if [[ ! -e "${AGENTS_MD}" ]]; then
  mkdir -p "$(dirname "${AGENTS_MD}")"
  : > "${AGENTS_MD}"
fi
block="$(cat "${ROOT}/dist/AGENTS-seek-first.md")"
tmp_md="${AGENTS_MD}.tmp.$$"
if grep -q "${BEGIN_LINE_PREFIX}" "${AGENTS_MD}"; then
  python3 - "${AGENTS_MD}" "${tmp_md}" "${ROOT}/dist/AGENTS-seek-first.md" "${BEGIN_LINE_PREFIX}" "${END_MARKER_EXACT}" <<'PY'
import re, sys
path, tmp, block_path, bm, em = sys.argv[1:6]
text = open(path).read()
block = open(block_path).read().rstrip("\n")
pattern = re.compile(rf"<!-- {re.escape(bm.removeprefix('<!-- '))}[^\n]*-->.*?{re.escape(em)}", re.S)
new, n = pattern.subn(block, text, count=1)
if n != 1:
    sys.exit("install: marker span replace failed; refusing to write")
open(tmp, "w").write(new)
PY
  compute_mode="replace"
else
  { cat "${AGENTS_MD}"; printf '\n%s\n' "${block}"; } > "${tmp_md}"
  compute_mode="append"
fi

# -- mutate: skills (atomic same-directory replacement) --
while IFS= read -r entry; do
  src="${entry%%|*}"
  dst="${entry#*|}"
  dst="${dst/#\~/${HOME}}"
  name="$(basename "${dst}")"
  mkdir -p "${dst}"
  tmp="${dst}/SKILL.md.tmp.$$"
  cp "${ROOT}/${src}" "${tmp}"
  mv "${tmp}" "${dst}/SKILL.md"
  echo "install: skill ${name} -> ${dst}/SKILL.md"
done <<< "${skill_entries}"

# -- mutate: extensions (atomic same-directory replacement) --
while IFS= read -r entry; do
  src="${entry%%|*}"
  dst="${entry#*|}"
  dst="${dst/#\~/${HOME}}"
  name="$(basename "${dst}")"
  mkdir -p "${dst}"
  tmp="${dst}/index.ts.tmp.$$"
  cp "${ROOT}/${src}/index.ts" "${tmp}"
  mv "${tmp}" "${dst}/index.ts"
  echo "install: extension ${name} -> ${dst}/index.ts"
done <<< "${ext_entries}"

# -- mutate: AGENTS.md (the replacement was already computed and validated) --
mv "${tmp_md}" "${AGENTS_MD}"
if [[ "${compute_mode}" == "replace" ]]; then
  echo "install: seek-first block replaced in ${AGENTS_MD}"
else
  echo "install: seek-first block appended to ${AGENTS_MD}"
fi

echo "install: backups at ${BACKUP_DIR} (mode 0700)"
echo "done. verify with: node ${ROOT}/lint/check.mjs --installed"
