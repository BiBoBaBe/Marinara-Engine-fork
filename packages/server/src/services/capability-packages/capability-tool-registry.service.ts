// ──────────────────────────────────────────────
// Capability tool registry — gives the `tools` permission its mechanism.
//
// A package can already contribute TEXT to a turn's prompt. This is the return path: a tool the model
// may call, whose parameters are a JSON schema the package builds, and whose handler runs in the
// package. The model writes its prose as normal and calls the tool alongside it, so a package gets
// structured, provider-validated arguments instead of parsing them back out of the reply.
//
// Tool calling rather than a response format on purpose: a response format would swallow the whole
// reply, and the prose has to keep streaming. A tool call arrives beside the prose and costs it
// nothing.
// ──────────────────────────────────────────────

import { logger } from "../../lib/logger.js";
import { createToolArgumentsValidator, type ToolArgumentsValidator } from "../tools/tool-arguments-validator.js";
import { withDeadline } from "./capability-prompt-context.service.js";

/** What the model is told it may call, and what happens when it does. */
export interface CapabilityToolRegistration {
  /** Snake-case, namespaced by the Engine to `<packageId>_<name>` so two packages cannot collide. */
  name: string;
  /** One line, rendered to the model. This is what decides whether the tool ever gets called. */
  description: string;
  /** JSON Schema for the arguments. Enums here are what keep an answer inside the world. */
  parameters: Record<string, unknown>;
  /**
   * Runs when the model calls it. Whatever it returns is shown to the model as the tool's result,
   * so a short confirmation is usually right and an object is fine.
   *
   * A throw is caught and reported to the model as a failure: a package must never be able to cost
   * somebody their turn.
   */
  handler: (args: Record<string, unknown>, context: CapabilityToolCall) => unknown | Promise<unknown>;
}

/** Where the call came from, so a handler can tell one chat from another. */
export interface CapabilityToolCall {
  chatId: string;
  packageId: string;
  toolName: string;
}

interface Registered extends CapabilityToolRegistration {
  packageId: string;
  qualifiedName: string;
  validateArguments: ToolArgumentsValidator;
}

const byQualifiedName = new Map<string, Registered>();

const NAME = /^[a-z][a-z0-9_]*$/;

// Every definition below is serialised into each turn's provider request and counted by context
// fitting, so an unbounded package could crowd out the conversation or overflow the request in every
// chat it is active in. These are deliberately generous: they bound the damage, they are not a budget
// a reasonable package needs to think about.
const MAX_TOOLS_PER_PACKAGE = 16;
const MAX_TOOLS_TOTAL = 64;
const MAX_DESCRIPTION_LENGTH = 512;
const MAX_SCHEMA_BYTES = 8 * 1024;

/** How long a package's handler has before the turn stops waiting on it. */
const HANDLER_TIMEOUT_MS = 10_000;

/** `civitas_report_scene` from package `civitas` and tool `report_scene`. */
export function qualifyToolName(packageId: string, name: string): string {
  return `${packageId.replace(/-/g, "_")}_${name}`;
}

/** Register (or replace) one tool for a package. Returns a releaser for deactivation. */
export function registerCapabilityTool(packageId: string, registration: CapabilityToolRegistration): () => void {
  const name = registration.name.trim();
  if (!NAME.test(name) || name.length > 48) {
    throw new Error(`Capability tool name ${registration.name} is invalid`);
  }
  if (!registration.description.trim()) {
    throw new Error(`Capability tool ${name} needs a description`);
  }
  if (registration.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(
      `Capability tool ${name} description exceeds ${MAX_DESCRIPTION_LENGTH} characters; it is sent to the model on every turn`,
    );
  }
  let schemaBytes: number;
  try {
    schemaBytes = Buffer.byteLength(JSON.stringify(registration.parameters) ?? "", "utf8");
  } catch {
    throw new Error(`Capability tool ${name} has a parameters schema that cannot be serialised`);
  }
  if (schemaBytes > MAX_SCHEMA_BYTES) {
    throw new Error(`Capability tool ${name} parameters schema exceeds ${MAX_SCHEMA_BYTES} bytes`);
  }
  const qualifiedName = qualifyToolName(packageId, name);
  const existing = byQualifiedName.get(qualifiedName);
  if (existing && existing.packageId !== packageId) {
    throw new Error(`Capability tool ${qualifiedName} is already registered by ${existing.packageId}`);
  }
  if (!existing) {
    const ownedByPackage = [...byQualifiedName.values()].filter((tool) => tool.packageId === packageId).length;
    if (ownedByPackage >= MAX_TOOLS_PER_PACKAGE) {
      throw new Error(`Capability package ${packageId} may register at most ${MAX_TOOLS_PER_PACKAGE} tools`);
    }
    if (byQualifiedName.size >= MAX_TOOLS_TOTAL) {
      throw new Error(`At most ${MAX_TOOLS_TOTAL} capability tools may be registered across all packages`);
    }
  }
  // Compile here rather than on first call: a schema the Engine cannot compile should fail the
  // package at activation, where a developer sees it, not silently mid-turn.
  let validateArguments: ToolArgumentsValidator;
  try {
    validateArguments = createToolArgumentsValidator(registration.parameters);
  } catch (error) {
    throw new Error(
      `Capability tool ${qualifiedName} has an invalid parameters schema: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const registered: Registered = {
    ...registration,
    name,
    packageId,
    qualifiedName,
    validateArguments,
  };
  byQualifiedName.set(qualifiedName, registered);
  return () => {
    // Identity, not package id: re-registering the same name replaces the entry, and the releaser
    // from the superseded registration must not delete its replacement.
    if (byQualifiedName.get(qualifiedName) === registered) byQualifiedName.delete(qualifiedName);
  };
}

/** Drops every tool a package registered, for deactivation or removal. */
export function releaseCapabilityTools(packageId: string): void {
  for (const [qualifiedName, tool] of byQualifiedName) {
    if (tool.packageId === packageId) byQualifiedName.delete(qualifiedName);
  }
}

/** The definitions to hand a provider, in the shape the rest of the tool path already uses. */
export function capabilityToolDefs(): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return [...byQualifiedName.values()].map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.qualifiedName,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export function isCapabilityTool(name: string): boolean {
  return byQualifiedName.has(name);
}

/**
 * Checks a call's arguments against the schema the package registered. Returns null when they are
 * fine, or a message naming the allowed values when an enum was missed.
 */
export function validateCapabilityToolArguments(name: string, args: Record<string, unknown>): string | null {
  const tool = byQualifiedName.get(name);
  return tool ? tool.validateArguments(args) : null;
}

/**
 * Runs a package's tool. Never throws: a package that fails is reported to the model as a failed
 * tool call, which it can retry or narrate around, rather than costing the turn.
 */
export async function executeCapabilityTool(
  name: string,
  args: Record<string, unknown>,
  chatId: string,
): Promise<unknown> {
  const tool = byQualifiedName.get(name);
  if (!tool) return { error: `Unknown tool ${name}` };
  try {
    // A handler that never settles would hold the turn open forever, so the wait is bounded. The
    // handler itself keeps running; the turn simply stops depending on it.
    const result = await withDeadline(
      tool.handler(args, {
        chatId,
        packageId: tool.packageId,
        toolName: tool.name,
      }),
      `Capability tool ${name}`,
      HANDLER_TIMEOUT_MS,
    );
    return result ?? { ok: true };
  } catch (error) {
    logger.warn(error, "[capability/tools] Package %s failed handling %s", tool.packageId, name);
    return { error: `Tool ${tool.name} failed` };
  }
}
