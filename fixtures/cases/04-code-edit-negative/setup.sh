#!/usr/bin/env bash
# Fixture cwd: an ordinary code-edit request. Ops discovery here is a
# false positive.
work="${1:-$(pwd)}"
mkdir -p "${work}/src"
cat > "${work}/src/app.ts" <<'TS'
export const add = (a: number, b: number) => a + b;
TS
cat > "${work}/src/app.test.ts" <<'TS'
import { expect, test } from "vitest";
import { add } from "./app";

test("adds", () => {
  expect(add(1, 2)).toBe(4); // failing on purpose
});
TS
