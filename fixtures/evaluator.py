#!/usr/bin/env python3
"""Role/event-aware transcript evaluator for workflow-pack fixtures.

Usage: evaluator.py <expect.json> <transcript.jsonl> <case-name> <verdicts-jsonl>

Extraction contract (role/event aware):
  - executed tool inputs come ONLY from `tool_execution_start` events,
    deduplicated by toolCallId;
  - assistant text comes ONLY from finalized assistant messages
    (`message_end` with role=assistant) — never user messages, tool results,
    or streaming `message_update` deltas;
  - transcript completion is validated (agent_end + user message present);
  - malformed events are counted and reported.

Verdict contract (expect.json):
  forbid_tools  — regexes checked against executed tool-call inputs
  forbid_text   — regexes checked against finalized assistant text
  require_any   — at least one regex must appear in tool inputs or text
  require_all   — every regex must appear in tool inputs or text

Always writes exactly one verdict row (even on evaluator error) and exits
nonzero on evaluator error, so the runner is fail-closed.
"""
import json
import re
import sys

TOOL_NAMES = ("bash", "read", "edit", "write", "grep", "find", "apply_patch")


def content_text(content):
    out = []
    if isinstance(content, str):
        out.append(content)
    elif isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
                out.append(block["text"])
    return "\n".join(out)


def extract(transcript):
    tool_inputs, texts = [], []
    seen_calls = set()
    saw_agent_end = saw_user = False
    malformed = 0
    with open(transcript, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except Exception:
                malformed += 1
                continue
            if not isinstance(ev, dict):
                malformed += 1
                continue
            t = ev.get("type")
            if t == "tool_execution_start":
                cid = ev.get("toolCallId")
                if isinstance(cid, str):
                    if cid in seen_calls:
                        continue
                    seen_calls.add(cid)
                name = ev.get("toolName") or ""
                if name.lower() in TOOL_NAMES:
                    tool_inputs.append(json.dumps(ev.get("args") or {}))
            elif t == "message_end":
                msg = ev.get("message")
                if not isinstance(msg, dict):
                    continue
                role = msg.get("role")
                if role == "assistant":
                    txt = content_text(msg.get("content"))
                    if txt:
                        texts.append(txt)
                elif role == "user":
                    saw_user = True
            elif t == "agent_end":
                saw_agent_end = True
    return tool_inputs, texts, saw_agent_end, saw_user, malformed


def main():
    expect_path, transcript, case, verdicts_jsonl = sys.argv[1:5]

    def record(verdict, problems):
        with open(verdicts_jsonl, "a") as f:
            f.write(json.dumps({"case": case, "verdict": verdict, "problems": problems}) + "\n")

    try:
        with open(expect_path) as f:
            expect = json.load(f)
        tool_inputs, texts, saw_agent_end, saw_user, malformed = extract(transcript)
        joined_tools = "\n".join(tool_inputs)
        joined_text = "\n".join(texts)
        joined = joined_tools + "\n" + joined_text
        problems = []
        if not saw_agent_end:
            problems.append("transcript incomplete: no agent_end event")
        if not saw_user:
            problems.append("transcript incomplete: no user message")
        if not tool_inputs and not texts:
            problems.append("transcript has no assistant or tool activity")
        if malformed:
            problems.append(f"{malformed} malformed event(s) skipped")
        for pat in expect.get("forbid_tools", []):
            if re.search(pat, joined_tools):
                problems.append(f"forbidden tool usage: {pat!r}")
        for pat in expect.get("forbid_text", []):
            if re.search(pat, joined_text):
                problems.append(f"forbidden pattern in assistant text: {pat!r}")
        req = expect.get("require_any", [])
        if req and not any(re.search(p, joined) for p in req):
            problems.append(f"no required evidence in tool calls or text: {req}")
        missing = [p for p in expect.get("require_all", []) if not re.search(p, joined)]
        if missing:
            problems.append(f"required evidence missing: {missing}")
        verdict = "PASS" if not problems else "FAIL"
        record(verdict, problems)
        print("PASS" if not problems else "FAIL: " + "; ".join(problems))
    except Exception as e:  # fail-closed: always record a row
        record("FAIL", [f"evaluator error: {e}"])
        print("FAIL: evaluator error: " + str(e))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
