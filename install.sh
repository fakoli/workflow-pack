#!/usr/bin/env bash
# Install workflow-pack artifacts into harness dirs. Idempotent.
#   - compiles dist/ from the manifest
#   - copies skills into ~/.agents/skills/
#   - upserts the seek-first block into ~/.pi/agent/AGENTS.md (backs up first)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_MD="${HOME}/.pi/agent/AGENTS.md"
SKILLS_DIR="${HOME}/.agents/skills"
BACKUP_DIR="${ROOT}/.backups/$(date +%Y-%m-%d)"
BEGIN_MARK="workflow-pack:seek-first begin"
END_MARK="workflow-pack:seek-first end"

node "${ROOT}/scripts/build.mjs"

# -- skill --
name="$(node -e "console.log(JSON.parse(require('fs').readFileSync('${ROOT}/pack/workflow-pack.v1.json','utf8')).skills[0].name)")"
mkdir -p "${SKILLS_DIR}/${name}"
cp "${ROOT}/skills/${name}/SKILL.md" "${SKILLS_DIR}/${name}/SKILL.md"
echo "install: skill -> ${SKILLS_DIR}/${name}/SKILL.md"

# -- seek-first block in global AGENTS.md --
if [[ ! -f "${AGENTS_MD}" ]]; then
  echo "install: ${AGENTS_MD} not found; creating" >&2
  mkdir -p "$(dirname "${AGENTS_MD}")"
  touch "${AGENTS_MD}"
fi
mkdir -p "${BACKUP_DIR}"
cp "${AGENTS_MD}" "${BACKUP_DIR}/AGENTS.md.install.bak"

if grep -q "${BEGIN_MARK}" "${AGENTS_MD}"; then
  python3 - "${AGENTS_MD}" "${ROOT}/dist/AGENTS-seek-first.md" "${BEGIN_MARK}" "${END_MARK}" <<'PY'
import re, sys
path, block_path, bm, em = sys.argv[1:5]
text = open(path).read()
block = open(block_path).read().rstrip("\n")
pattern = re.compile(rf"<!-- {re.escape(bm)}.*?<!-- {re.escape(em)} -->", re.S)
if pattern.search(text):
    open(path, "w").write(pattern.sub(block, text, count=1))
    print("install: seek-first block replaced")
else:
    sys.stderr.write("install: begin mark found without end mark; appending block\n")
    with open(path, "a") as f:
        f.write("\n" + block + "\n")
PY
else
  printf '\n%s\n' "$(cat "${ROOT}/dist/AGENTS-seek-first.md")" >> "${AGENTS_MD}"
  echo "install: seek-first block appended to ${AGENTS_MD}"
fi

echo "install: backup at ${BACKUP_DIR}/AGENTS.md.install.bak"
echo "done. verify with: node ${ROOT}/lint/check.mjs --installed"
