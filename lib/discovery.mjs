// Structured, bounded registry projection through an injected execution
// interface (docs/DESIGN-v0.3.md §3.2). The adapter supplies execFile; this
// module never spawns a process itself. Discovery output is DATA, never
// executable instructions: schema, status, gate metadata, and size are
// validated before a response may be used for a denial.

const SUPPORTED_FORMATS = new Set(["json", "text"]);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Run one family's manifest_argv through the injected execFile and validate
 * the response against the family's registry_contract.
 *
 * execFile: (file, args, opts) => Promise<{ stdout, stderr }> — rejects on
 *   nonzero exit (Node's child_process.execFile shape).
 *
 * Returns { ok: true, family, manifest } or { ok: false, family, reason }.
 * Never throws: malformed input yields a structured failure.
 */
export async function projectFamily({ family, execFile, timeoutMs = 10000, maxBytes = 6000 }) {
  if (!family || typeof family !== "object" || !family.name) {
    return { ok: false, family: null, reason: "family missing name" };
  }
  const fail = (reason) => ({ ok: false, family: family.name, reason });
  if (!Array.isArray(family.manifest_argv) || family.manifest_argv.length === 0) {
    return fail("family missing manifest_argv (argument array required, not a shell string)");
  }
  if (family.manifest_argv.some((a) => typeof a !== "string" || a.length === 0)) {
    return fail("manifest_argv must be an array of non-empty strings");
  }
  const contract = family.registry_contract || {};
  if (contract.format !== undefined && !SUPPORTED_FORMATS.has(contract.format)) {
    return fail(`unsupported registry_contract format: ${String(contract.format)}`);
  }
  if (contract.expected_fields !== undefined) {
    if (!Array.isArray(contract.expected_fields) || contract.expected_fields.some((f) => typeof f !== "string" || f.length === 0)) {
      return fail("registry_contract.expected_fields must be an array of non-empty strings");
    }
  }
  if (typeof execFile !== "function") return fail("no injected execution interface");

  let stdout;
  try {
    const result = await execFile(file0(family), family.manifest_argv.slice(1), {
      timeout: timeoutMs,
      maxBuffer: maxBytes,
    });
    stdout = String(result.stdout || "");
  } catch (err) {
    const detail = err && err.message ? err.message.slice(0, 120) : "unknown error";
    return fail(`registry command failed: ${detail}`);
  }

  // byte length, not character count: a multi-byte response can exceed a
  // byte budget while passing a .length check
  if (Buffer.byteLength(stdout, "utf8") > maxBytes) {
    return fail(`registry response truncated (exceeds ${maxBytes} bytes)`);
  }

  if (contract.format === "json" || (contract.format === undefined && looksLikeJson(stdout))) {
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return fail("registry response is not valid JSON");
    }
    if (!isPlainObject(parsed)) {
      return fail("registry response root must be a JSON object");
    }
    const missing = (contract.expected_fields || []).filter((f) => !(f in parsed));
    if (missing.length > 0) {
      return fail(`registry response missing expected fields: ${missing.join(", ")}`);
    }
    for (const field of contract.expected_fields || []) {
      const v = parsed[field];
      const entries = Array.isArray(v)
        ? v
        : isPlainObject(v)
          ? Object.values(v) // object-shaped registry: validate each value
          : null;
      if (entries === null) {
        if (v !== undefined) return fail(`registry field ${field} must be an object or array of entries`);
        continue;
      }
      if (!entries.every(isPlainObject)) {
        return fail(`registry field ${field} must contain only objects`);
      }
      for (const entry of entries) {
        if (entry.requires_confirmation !== undefined && typeof entry.requires_confirmation !== "boolean") {
          return fail(`registry field ${field} has non-boolean requires_confirmation`);
        }
        if (entry.argv !== undefined && !Array.isArray(entry.argv)) {
          return fail(`registry field ${field} has non-array argv`);
        }
        const bad = Object.entries(entry).find(([, val]) => {
          if (val === null) return false;
          if (Array.isArray(val)) return !val.every((x) => typeof x === "string");
          const t = typeof val;
          return t !== "string" && t !== "boolean" && t !== "number";
        });
        if (bad) {
          return fail(`registry field ${field} has an entry with unsupported value type at key ${bad[0]}`);
        }
      }
    }
    return { ok: true, family: family.name, manifest: parsed };
  }

  // text format: bounded, non-empty
  if (stdout.trim().length === 0) return fail("registry response is empty");
  return { ok: true, family: family.name, manifest: stdout };
}

function file0(family) {
  return family.manifest_argv[0];
}

function looksLikeJson(s) {
  const t = s.trim();
  return t.startsWith("{") || t.startsWith("[");
}

/**
 * Report whether a family DECLARES an ownership resolution method. A
 * declaration alone is NOT verified evidence (design §3.2): it yields at
 * most `candidate`. `verified` requires adapter-supplied evidence bound to
 * the exact target and operation (see guardrail.targetConfidence).
 */
export function ownershipAuthority(family) {
  const contract = family && family.ownership_contract;
  if (!contract || !contract.resolution || !Array.isArray(contract.targets) || contract.targets.length === 0) {
    return { resolvable: false, confidence: "unknown", reason: "family declares no ownership contract" };
  }
  return {
    resolvable: true,
    confidence: "candidate",
    targets: contract.targets,
    method: contract.resolution,
    note: "declaration is a resolution lead; verified requires adapter-supplied evidence bound to the exact target",
  };
}
