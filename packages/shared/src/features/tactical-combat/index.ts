// ──────────────────────────────────────────────
// Tactical Combat — public API
// ──────────────────────────────────────────────
// Curated surface consumed by the server endpoints (Phase B) and the client
// TacticalCombatUI (Phase C). Internal helpers used only by ai.ts stay in
// engine.ts and are intentionally not re-exported here.

export * from "./types.js";

export {
  createTacticalCombat,
  getUnit,
  getMovementRange,
  getTargetsInRange,
  forecastAttack,
  applyAction,
  isTerminal,
  buildTacticalSummary,
} from "./engine.js";

export { runEnemyPhase } from "./ai.js";

export { summarizeTacticalBattlefield } from "./battlefield-summary.js";

export { deriveMovement, elementMultiplier, DIFFICULTY_DAMAGE_MULT } from "./math.js";
export { CLASS_PROFILES, deriveClass, normalizeClass, type ClassProfile } from "./classes.js";
export {
  TACTICAL_BATTLEFIELD_GENERATOR_VERSION,
  generateTacticalBattlefield,
  gridDimensions,
  validateTacticalBattlefieldBrief,
  type GenerateTacticalBattlefieldResult,
  type TacticalBattlefieldBriefValidation,
} from "./grid-gen.js";
