import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  capabilityToolDefs,
  executeCapabilityTool,
  isCapabilityTool,
  qualifyToolName,
  registerCapabilityTool,
  releaseCapabilityTools,
  validateCapabilityToolArguments,
} from "../../packages/server/src/services/capability-packages/capability-tool-registry.service.js";

const PACKAGE_ID = "world-clock";
const parameters = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["advance", "rewind"] },
    minutes: { type: "integer", minimum: 0 },
  },
  required: ["action", "minutes"],
  additionalProperties: false,
};

releaseCapabilityTools(PACKAGE_ID);

// ── Names are namespaced, so two packages cannot offer the model the same tool ──
assert.equal(qualifyToolName("world-clock", "set_time"), "world_clock_set_time");

let seen: Array<Record<string, unknown>> = [];
let lastChatId: string | null = null;
const release = registerCapabilityTool(PACKAGE_ID, {
  name: "set_time",
  description: "Move the world clock.",
  parameters,
  handler: (args, context) => {
    seen.push(args);
    lastChatId = context.chatId;
    return { moved: args.minutes };
  },
});

assert.equal(isCapabilityTool("world_clock_set_time"), true);
assert.equal(isCapabilityTool("set_time"), false, "an unqualified name must not resolve");

const defs = capabilityToolDefs();
assert.equal(defs.length, 1);
assert.deepEqual(defs[0], {
  type: "function",
  function: { name: "world_clock_set_time", description: "Move the world clock.", parameters },
});

// ── Registration refuses what the model could never be told about ──
assert.throws(() => registerCapabilityTool(PACKAGE_ID, { name: "Set Time", description: "x", parameters, handler: () => null }), /is invalid/);
assert.throws(() => registerCapabilityTool(PACKAGE_ID, { name: "ok_name", description: "  ", parameters, handler: () => null }), /needs a description/);
assert.throws(
  () =>
    registerCapabilityTool(PACKAGE_ID, {
      name: "bad_schema",
      description: "x",
      parameters: { type: "object", properties: { a: { type: "not-a-type" } } },
      handler: () => null,
    }),
  /invalid parameters schema/,
  "a schema the engine cannot compile must fail at registration, not mid-turn",
);
// Qualifying flattens `-` to `_`, so package `world` with tool `clock_set_time` lands on the same
// qualified name as package `world-clock` with tool `set_time`. First registration keeps it.
assert.throws(
  () => registerCapabilityTool("world", { name: "clock_set_time", description: "x", parameters, handler: () => null }),
  /already registered by world-clock/,
);

// ── Argument validation is the point of the seam: an invented enum member is named back ──
assert.equal(validateCapabilityToolArguments("world_clock_set_time", { action: "advance", minutes: 30 }), null);
const enumError = validateCapabilityToolArguments("world_clock_set_time", { action: "teleport", minutes: 30 });
assert.match(String(enumError), /advance, rewind/, "a rejected enum must name the values that would have worked");
assert.match(String(validateCapabilityToolArguments("world_clock_set_time", { action: "advance" })), /minutes/);
assert.equal(validateCapabilityToolArguments("unregistered_tool", {}), null);

// ── Execution reaches the handler, with the chat it belongs to ──
assert.deepEqual(await executeCapabilityTool("world_clock_set_time", { action: "advance", minutes: 30 }, "chat-7"), {
  moved: 30,
});
assert.deepEqual(seen, [{ action: "advance", minutes: 30 }]);
assert.equal(lastChatId, "chat-7");

// ── A package that throws costs the model a tool call, never the turn ──
const releaseThrower = registerCapabilityTool(PACKAGE_ID, {
  name: "explode",
  description: "Always fails.",
  parameters: { type: "object", properties: {} },
  handler: () => {
    throw new Error("package is on fire");
  },
});
const failure = (await executeCapabilityTool("world_clock_explode", {}, "chat-7")) as { error?: string };
assert.match(String(failure.error), /Tool explode failed/);
assert.ok(!String(failure.error).includes("on fire"), "a package's internal message must not reach the model");
assert.deepEqual(await executeCapabilityTool("world_clock_missing", {}, "chat-7"), {
  error: "Unknown tool world_clock_missing",
});
releaseThrower();

// ── Release drops a package's tools, so a deactivated package is never offered ──
release();
assert.equal(isCapabilityTool("world_clock_set_time"), false);
registerCapabilityTool(PACKAGE_ID, { name: "set_time", description: "x", parameters, handler: () => null });
registerCapabilityTool(PACKAGE_ID, { name: "other", description: "x", parameters: { type: "object" }, handler: () => null });
assert.equal(capabilityToolDefs().length, 2);
releaseCapabilityTools(PACKAGE_ID);
assert.deepEqual(capabilityToolDefs(), []);

// ── Wiring that needs a running server to exercise is pinned by shape ──
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const runtimeSource = read("../../packages/server/src/services/capability-packages/capability-module-runtime.service.ts");
assert.match(
  runtimeSource,
  /registerTool: \(registration\) => \{[\s\S]*permissions\?\.includes\("tools"\)[\s\S]*registerCapabilityTool\(installed\.id, registration\)/u,
  "registerTool must be gated on the tools permission",
);
assert.match(runtimeSource, /releaseCapabilityTools\(installed\.id\)/u, "deactivation must drop the package's tools");

const resolutionSource = read("../../packages/server/src/services/generation/tool-resolution-runtime.ts");
assert.match(
  resolutionSource,
  /const packageToolDefs = capabilityToolDefs\(\)[\s\S]*toolDefs = \[\.\.\.\(toolDefs \?\? \[\]\), \.\.\.packageToolDefs\]/u,
  "package tools must be appended to the definitions handed to the provider",
);
assert.match(
  resolutionSource,
  /registeredToolSources\.set\(tool\.function\.name, "package"\)/u,
  "package tools must take part in the tool-name collision map",
);
assert.match(
  resolutionSource,
  /const baseToolExecutionContext: ToolExecutionContext = \{\n\s*chatId,/u,
  "the execution context must carry the chat so a handler knows which world it is answering about",
);

const executorSource = read("../../packages/server/src/services/tools/tool-executor.ts");
assert.match(
  executorSource,
  /\} else if \(isCapabilityTool\(call\.function\.name\)\) \{[\s\S]*validateCapabilityToolArguments\([\s\S]*executeCapabilityTool\(/u,
  "capability tools must be validated and dispatched from executeToolCalls, not left to the unknown-tool branch",
);

console.info("Capability tool runtime regression passed");
