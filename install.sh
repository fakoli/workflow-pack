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
BEGIN_LINE_EXACT="<!-- workflow-pack:seek-first begin (generated; edit pack/workflow-pack.v1.json) -->"
END_MARKER_EXACT="<!-- workflow-pack:seek-first end -->"

# Refuse when any ancestor directory of <path> is a symlink: a symlinked
# ancestor is an escape hatch that redirects writes outside the declared
# install target.
refuse_symlink_ancestors() {
  local p="${1%/}"
  while [[ "${p}" != "/" && "${p}" != "." && -n "${p}" ]]; do
    if [[ -L "${p}" ]]; then
      echo "install: refuse: ${p} is a symlink" >&2
      exit 1
    fi
    p="$(dirname "${p}")"
  done
}

node "${ROOT}/scripts/build.mjs"

# -- preflight: marker structure with EXACT grammar (refuse to mutate on
# malformed input; a suffixed end marker like "... end BROKEN -->" is
# rejected here, not discovered after skills are already replaced) --
if [[ -L "${AGENTS_MD}" ]]; then
  echo "install: refuse: ${AGENTS_MD} is a symlink" >&2
  exit 1
fi
refuse_symlink_ancestors "${AGENTS_MD}"
if [[ -e "${AGENTS_MD}" ]]; then
  python3 - "${AGENTS_MD}" "${BEGIN_LINE_EXACT}" "${END_MARKER_EXACT}" <<'PY'
import sys
path, bm, em = sys.argv[1:4]
text = open(path).read()
lines = text.splitlines()
# exact full-line grammar: count lines that equal the markers exactly, not
# prefix matches — a hand-edited or suffixed variant is malformed
begins = sum(1 for l in lines if l == bm)
ends = sum(1 for l in lines if l == em)
if begins != ends or begins > 1:
    sys.exit(f"install: malformed marker structure in {path} (exact begin lines={begins}, exact end lines={ends}); expected exactly one '{bm}' and one '{em}'; fix manually — refusing to mutate")
if begins == 1 and lines.index(em) < lines.index(bm):
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
  refuse_symlink_ancestors "${dst}"
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
  const assets = (s.assets || []).join(',');
  console.log(s.path + '|' + s.install + '|' + assets);
}
" "${MANIFEST}")"

while IFS= read -r entry; do
  src="${entry%%|*}"
  rest="${entry#*|}"
  dst="${rest%%|*}"
  assets="${rest#*|}"
  dst="${dst/#\~/${HOME}}"
  [[ -f "${ROOT}/${src}/index.ts" ]] || { echo "install: missing extension source ${src}/index.ts" >&2; exit 1; }
  refuse_symlink_ancestors "${dst}"
  if [[ -L "${dst}" || -L "${dst}/index.ts" ]]; then
    echo "install: refuse: ${dst} is a symlink" >&2
    exit 1
  fi
  if [[ -e "${dst}/index.ts" ]]; then
    mkdir -p "${BACKUP_DIR}/extensions/$(basename "${dst}")"
    cp -a "${dst}/index.ts" "${BACKUP_DIR}/extensions/$(basename "${dst}")/index.ts"
  fi
  # preflight declared shared assets (repo-root sources), independent of index.ts
  if [[ -n "${assets}" ]]; then
    IFS=',' read -ra ASSET_LIST <<< "${assets}"
    for asset in "${ASSET_LIST[@]}"; do
      [[ -d "${ROOT}/${asset}" ]] || { echo "install: missing declared asset ${asset}" >&2; exit 1; }
      adst="${dst}/$(basename "${asset}")"
      refuse_symlink_ancestors "${adst}"
      if [[ -L "${adst}" ]]; then
        echo "install: refuse: ${adst} is a symlink" >&2
        exit 1
      fi
      if [[ -e "${adst}" && ! -d "${adst}" ]]; then
        echo "install: refuse: ${adst} exists and is not a directory" >&2
        exit 1
      fi
      if [[ -d "${adst}" ]]; then
        mkdir -p "${BACKUP_DIR}/extensions/$(basename "${dst}")"
        cp -a "${adst}" "${BACKUP_DIR}/extensions/$(basename "${dst}")/$(basename "${asset}")"
      fi
    done
  fi
done <<< "${ext_entries}"
if [[ -e "${AGENTS_MD}" ]]; then
  cp -a "${AGENTS_MD}" "${BACKUP_DIR}/AGENTS.md"
fi

# -- mutation tracking and rollback trap: installed BEFORE the first
# mutation (fresh AGENTS.md creation). Every replaced path that had a
# preflight backup is restored from it (recorded as path|backup pairs);
# paths created fresh (no backup) are removed. Surviving backups are always
# reported so manual recovery stays possible. --
MUTATED=()   # path|backup pairs written during this run
CREATED=()   # paths created fresh (no prior version to restore)

rollback_mutations() {
  local rc=$?
  if [[ ${rc} -eq 0 ]]; then
    trap - EXIT
    return 0
  fi
  local restored=0 failed=0 pair path bak
  for pair in "${MUTATED[@]}"; do
    path="${pair%%|*}"
    bak="${pair#*|}"
    if [[ -e "${bak}" ]]; then
      if mkdir -p "$(dirname "${path}")"; then
        # a directory backup must REPLACE the destination tree, not copy
        # inside it; the removal is guarded so a failure cannot abort the
        # remaining recovery under set -e
        if [[ -d "${bak}" && -d "${path}" ]]; then
          rm -rf "${path}" || {
            failed=$((failed + 1))
            echo "install: rollback could not remove ${path}; backup at ${bak}" >&2
            continue
          }
        fi
        if cp -a "${bak}" "${path}"; then
          restored=$((restored + 1))
        else
          failed=$((failed + 1))
          echo "install: rollback FAILED for ${path}; backup at ${bak}" >&2
        fi
      else
        failed=$((failed + 1))
        echo "install: rollback FAILED for ${path}; backup at ${bak}" >&2
      fi
    fi
  done
  for path in "${CREATED[@]}"; do
    if ! rm -rf "${path}"; then
      echo "install: rollback could not remove created path ${path}" >&2
    fi
  done
  echo "install: FAILED (exit ${rc}) after partial mutation; rolled back ${restored} replaced path(s), removed ${#CREATED[@]} created path(s)" >&2
  echo "install: preflight backups retained at ${BACKUP_DIR} for manual recovery" >&2
  exit "${rc}"
}
trap rollback_mutations EXIT

# -- compute the complete AGENTS.md replacement BEFORE mutating anything --
if [[ ! -e "${AGENTS_MD}" ]]; then
  mkdir -p "$(dirname "${AGENTS_MD}")"
  : > "${AGENTS_MD}"
  CREATED+=("${AGENTS_MD}")
fi
block="$(cat "${ROOT}/dist/AGENTS-seek-first.md")"
tmp_md="${AGENTS_MD}.tmp.$$"
if grep -q "${BEGIN_LINE_PREFIX}" "${AGENTS_MD}"; then
  python3 - "${AGENTS_MD}" "${tmp_md}" "${ROOT}/dist/AGENTS-seek-first.md" "${BEGIN_LINE_PREFIX}" "${END_MARKER_EXACT}" "${BEGIN_LINE_EXACT}" <<'PY'
import re, sys
path, tmp, block_path, bm, em, exact = sys.argv[1:7]
text = open(path).read()
block = open(block_path).read().rstrip("\n")
# replace the EXACT validated LINE SPAN: marker-like text anywhere else
# (inline mentions, malformed openers) is rejected — replacement never
# starts inside an example line and never terminates at inline end-marker
# text
lines = text.split("\n")
opener_idx = None
end_idx = None
for i, line in enumerate(lines):
    if bm in line and line != exact:
        sys.exit("install: malformed workflow-pack marker text; refusing to replace — fix or remove it manually")
    if em in line and line.strip() != em:
        sys.exit("install: inline workflow-pack end-marker text; refusing to replace — fix or remove it manually")
    if line == exact and opener_idx is None:
        opener_idx = i
    if line == em and end_idx is None and opener_idx is not None:
        end_idx = i
if opener_idx is None or end_idx is None or end_idx < opener_idx:
    sys.exit("install: exact marker span not found; refusing to write")
new_lines = lines[:opener_idx] + block.split("\n") + lines[end_idx + 1:]
open(tmp, "w").write("\n".join(new_lines))
PY
  compute_mode="replace"
else
  { cat "${AGENTS_MD}"; printf '\n%s\n' "${block}"; } > "${tmp_md}"
  compute_mode="append"
  # the append path validates marker text too: it is only for files with NO
  # markers at all — any opener/closer mention (including an orphan or
  # malformed closer) is malformed, never silently appended to
  python3 - "${AGENTS_MD}" "${BEGIN_LINE_PREFIX}" "${END_MARKER_EXACT}" "${BEGIN_LINE_EXACT}" <<'PY'
import sys
path, bm, em, exact = sys.argv[1:5]
for line in open(path).read().split("\n"):
    if bm in line or em in line:
        sys.exit("install: malformed workflow-pack marker text; refusing to append — fix or remove it manually")
PY
fi

# -- mutate phase: track completed writes and roll back on failure --

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
  if [[ -e "${BACKUP_DIR}/skills/${name}/SKILL.md" ]]; then
    MUTATED+=("${dst}/SKILL.md|${BACKUP_DIR}/skills/${name}/SKILL.md")
  else
    CREATED+=("${dst}/SKILL.md")
  fi
  echo "install: skill ${name} -> ${dst}/SKILL.md"
done <<< "${skill_entries}"

# -- mutate: extensions (atomic same-directory replacement for index.ts;
# staged replacement for shared assets — the rm/mv window is documented and
# the preflight backup enables restoration) --
while IFS= read -r entry; do
  src="${entry%%|*}"
  rest="${entry#*|}"
  dst="${rest%%|*}"
  assets="${rest#*|}"
  dst="${dst/#\~/${HOME}}"
  name="$(basename "${dst}")"
  mkdir -p "${dst}"
  tmp="${dst}/index.ts.tmp.$$"
  cp "${ROOT}/${src}/index.ts" "${tmp}"
  mv "${tmp}" "${dst}/index.ts"
  if [[ -e "${BACKUP_DIR}/extensions/${name}/index.ts" ]]; then
    MUTATED+=("${dst}/index.ts|${BACKUP_DIR}/extensions/${name}/index.ts")
  else
    CREATED+=("${dst}/index.ts")
  fi
  if [[ -n "${assets}" ]]; then
    IFS=',' read -ra ASSET_LIST <<< "${assets}"
    for asset in "${ASSET_LIST[@]}"; do
      adst="${dst}/$(basename "${asset}")"
      stage="${adst}.tmp.$$"
      old="${adst}.old.$$"
      rm -rf "${stage}"
      cp -a "${ROOT}/${asset}" "${stage}" || {
        echo "install: asset staging failed for ${adst}; earlier writes in this run will be rolled back" >&2
        exit 1
      }
      # rename the previous asset aside, swap, then discard: on swap failure
      # the previous asset is restored (recovery over atomicity)
      if [[ -d "${adst}" ]]; then
        mv "${adst}" "${old}"
      fi
      if mv "${stage}" "${adst}"; then
        # register the completed replacement BEFORE fallible cleanup so the
        # EXIT trap always knows the asset was replaced
        if [[ -d "${BACKUP_DIR}/extensions/${name}/$(basename "${asset}")" ]]; then
          MUTATED+=("${adst}|${BACKUP_DIR}/extensions/${name}/$(basename "${asset}")")
        else
          CREATED+=("${adst}")
        fi
        rm -rf "${old}" || echo "install: could not remove staged backup ${old}" >&2
      else
        if [[ -d "${old}" ]]; then
          if mv "${old}" "${adst}"; then
            echo "install: asset replacement failed for ${adst}; previous restored" >&2
          else
            echo "install: asset replacement failed for ${adst}; restoration FAILED; previous asset at ${old}" >&2
          fi
        else
          echo "install: asset replacement failed for ${adst}; no previous asset to restore" >&2
        fi
        exit 1
      fi
    done
  fi
  echo "install: extension ${name} -> ${dst}/index.ts"
done <<< "${ext_entries}"

# -- mutate: AGENTS.md (the replacement was already computed and validated) --
mv "${tmp_md}" "${AGENTS_MD}"
if [[ -e "${BACKUP_DIR}/AGENTS.md" ]]; then
  MUTATED+=("${AGENTS_MD}|${BACKUP_DIR}/AGENTS.md")
else
  CREATED+=("${AGENTS_MD}")
fi
if [[ "${compute_mode}" == "replace" ]]; then
  echo "install: seek-first block replaced in ${AGENTS_MD}"
else
  echo "install: seek-first block appended to ${AGENTS_MD}"
fi

echo "install: backups at ${BACKUP_DIR} (mode 0700)"
echo "done. verify with: node ${ROOT}/lint/check.mjs --installed"
