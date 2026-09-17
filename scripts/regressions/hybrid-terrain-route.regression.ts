import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-hybrid-terrain-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");

const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");
const { validateTacticalEncounterBlueprint } =
  await import("../../packages/server/src/services/game/tactical-battlefield.service.js");
const { injectGameGmPromptRuntime } =
  await import("../../packages/server/src/services/generation/game-gm-prompt-runtime.js");
const { summarizeTacticalBattlefield } = await import("../../packages/shared/src/index.js");

const db = await getDB();
const app = Fastify();
app.decorate("db", db);
await app.register(gameRoutes, { prefix: "/api/game" });

const setupConfig = {
  genre: "Fantasy",
  setting: "A ruined keep split by a flooded courtyard",
  tone: "Adventurous",
  difficulty: "normal",
  combatStyle: "tactical",
  playerGoals: "Cross the courtyard",
  gmMode: "standalone",
  rating: "sfw",
  partyCharacterIds: [],
  tacticalBattlefield: {
    seed: 0,
    size: "large",
    instructions: "Keep the flooded courtyard central.",
  },
};

const party = [
  { id: "hero", name: "Hero", hp: 20, maxHp: 20, attack: 8, defense: 5, speed: 6, level: 1, movementMode: "fly" },
];
const enemies = [{ id: "guard", name: "Guard", hp: 12, maxHp: 12, attack: 6, defense: 4, speed: 4, level: 1 }];

async function resolvePromptContext(chatMetadata: Record<string, unknown>) {
  const runtime = await injectGameGmPromptRuntime({
    messages: [{ role: "system", content: "placeholder" }],
    chatId: "prompt-style-regression",
    chat: {},
    chatMetadata,
    characterIds: [],
    chars: {
      getById: async () => null,
      getPersona: async () => null,
    },
    chats: {
      getById: async () => null,
      updateMetadata: async () => undefined,
    },
    selectedGameStateSnapshotPromise: Promise.resolve(null),
    mappedMessages: [],
    personaName: "Hero",
    resolvePromptMacros: (value) => value,
  });
  return runtime.gmCtx;
}

try {
  const created = await app.inject({
    method: "POST",
    url: "/api/game/create",
    payload: { name: "Hybrid terrain regression", setupConfig },
  });
  assert.equal(created.statusCode, 200, created.body);
  const session = created.json().sessionChat;
  const metadata = JSON.parse(session.metadata);
  assert.deepEqual(metadata.gameSetupConfig.tacticalBattlefield, setupConfig.tacticalBattlefield);

  const started = await app.inject({
    method: "POST",
    url: "/api/game/combat/tactical/start",
    payload: {
      chatId: session.id,
      party,
      enemies,
      seed: 99,
      environment: "ruins",
      battlefield: {
        size: "small",
        features: [{ terrain: "forest", placement: "center", shape: "patch" }],
      },
    },
  });
  assert.equal(started.statusCode, 200, started.body);
  const state = started.json().state;
  assert.equal(state.seed, 0, "A configured zero seed overrides a request seed");
  assert.equal(state.grid.width, 14, "Configured size overrides the encounter brief");
  assert.equal(state.grid.height, 10);
  assert.equal(state.units[0].movementMode, "fly");
  assert.deepEqual(state.battlefield, {
    kind: "generated",
    generatorVersion: 1,
    size: "large",
    brief: {
      size: "large",
      features: [{ terrain: "forest", placement: "center", shape: "patch" }],
    },
  });
  assert.match(summarizeTacticalBattlefield(state) ?? "", /Accepted features: forest center patch/);
  assert.match(summarizeTacticalBattlefield(state) ?? "", /Resolved terrain:/);

  const activeContext = await resolvePromptContext({
    gameActiveState: "combat",
    gameCombatStyle: "classic",
    gameCombatState: { combatStyle: "tactical" },
    gameTacticalCombatSnapshot: state,
  });
  assert.equal(
    activeContext.combatStyle,
    "tactical",
    "An active encounter's pinned style wins over the next-battle setting",
  );
  assert.match(activeContext.tacticalBattlefieldContext ?? "", /Accepted features: forest center patch/);
  const classicContext = await resolvePromptContext({
    gameActiveState: "combat",
    gameCombatStyle: "tactical",
    gameCombatState: { combatStyle: "classic" },
    gameTacticalCombatSnapshot: state,
  });
  assert.equal(classicContext.combatStyle, "classic");
  assert.equal(
    classicContext.tacticalBattlefieldContext,
    undefined,
    "A pinned classic encounter must ignore retained tactical terrain",
  );
  assert.equal(
    (
      await resolvePromptContext({
        gameActiveState: "combat",
        gameCombatStyle: "classic",
        gameCombatState: {},
        gameTacticalCombatSnapshot: state,
      })
    ).combatStyle,
    "tactical",
    "A legacy active tactical snapshot supplies the missing style pin",
  );
  const explorationContext = await resolvePromptContext({
    gameActiveState: "exploration",
    gameCombatStyle: "classic",
    gameCombatState: { combatStyle: "tactical" },
    gameTacticalCombatSnapshot: state,
  });
  assert.equal(
    explorationContext.combatStyle,
    "classic",
    "Outside combat, the runtime setting continues to select the next battle style",
  );
  assert.equal(
    explorationContext.tacticalBattlefieldContext,
    undefined,
    "Exploration must not receive stale battlefield context",
  );

  const invalidModelMovement = validateTacticalEncounterBlueprint({
    party: [{ movementMode: "swim" }],
    enemies: [],
    battlefield: {},
  });
  assert.equal(invalidModelMovement.ok, false);
  if (!invalidModelMovement.ok) assert.match(invalidModelMovement.error, /movementMode/);

  const invalidTerrainInput = Object.freeze({
    party: [{ movementMode: "walk" }],
    enemies: [],
    battlefield: Object.freeze({
      terrainBrief: { features: [{ terrain: "forest", placement: "center", shape: "barrier" }] },
      terrainBriefError: "model-authored spoof",
    }),
  });
  const invalidTerrainSnapshot = structuredClone(invalidTerrainInput);
  const recoverableTerrain = validateTacticalEncounterBlueprint(invalidTerrainInput);
  assert.deepEqual(invalidTerrainInput, invalidTerrainSnapshot);
  assert.equal(recoverableTerrain.ok, true);
  if (recoverableTerrain.ok) {
    assert.equal(recoverableTerrain.blueprint.battlefield?.terrainBrief, undefined);
    assert.match(recoverableTerrain.blueprint.battlefield?.terrainBriefError ?? "", /barrier features/i);
    assert.notEqual(recoverableTerrain.blueprint.battlefield, invalidTerrainInput.battlefield);
  }
  assert.equal(invalidTerrainInput.battlefield.terrainBriefError, "model-authored spoof");
  assert.equal(invalidTerrainInput.battlefield.terrainBrief.features.length, 1);

  const validTerrainInput = Object.freeze({
    party: [{ movementMode: "walk" }],
    enemies: [],
    battlefield: Object.freeze({
      terrainBrief: { features: [{ terrain: "ruin", placement: "north", shape: "patch" }] },
      terrainBriefError: "model-authored spoof",
    }),
  });
  const validTerrainSnapshot = structuredClone(validTerrainInput);
  const validTerrain = validateTacticalEncounterBlueprint(validTerrainInput);
  assert.deepEqual(validTerrainInput, validTerrainSnapshot);
  assert.equal(validTerrain.ok, true);
  if (validTerrain.ok) {
    assert.deepEqual(validTerrain.blueprint.battlefield?.terrainBrief, {
      features: [{ terrain: "ruin", placement: "north", shape: "patch" }],
    });
    assert.equal(validTerrain.blueprint.battlefield?.terrainBriefError, undefined);
    assert.notEqual(validTerrain.blueprint.battlefield, validTerrainInput.battlefield);
  }
  assert.equal(validTerrainInput.battlefield.terrainBriefError, "model-authored spoof");

  const legacyState = structuredClone(state);
  for (const unit of legacyState.units) delete unit.movementMode;
  const legacyAction = await app.inject({
    method: "POST",
    url: "/api/game/combat/tactical/action",
    payload: {
      chatId: session.id,
      state: legacyState,
      action: { type: "wait", unitId: "hero" },
    },
  });
  assert.equal(legacyAction.statusCode, 200, legacyAction.body);

  const invalidMovementState = structuredClone(state);
  invalidMovementState.units[0].movementMode = "noclip";
  const invalidMovementAction = await app.inject({
    method: "POST",
    url: "/api/game/combat/tactical/action",
    payload: {
      chatId: session.id,
      state: invalidMovementState,
      action: { type: "wait", unitId: "hero" },
    },
  });
  assert.equal(invalidMovementAction.statusCode, 400, invalidMovementAction.body);
  assert.match(invalidMovementAction.json().error, /movementMode/);

  for (const seed of [-1, 1.5, 0x1_0000_0000]) {
    const rejected = await app.inject({
      method: "POST",
      url: "/api/game/create",
      payload: {
        name: "Invalid terrain seed",
        setupConfig: { ...setupConfig, tacticalBattlefield: { ...setupConfig.tacticalBattlefield, seed } },
      },
    });
    assert.equal(rejected.statusCode, 400, rejected.body);
    assert.match(rejected.json().error, /battlefield seed/i);
  }

  const invalidBrief = await app.inject({
    method: "POST",
    url: "/api/game/combat/tactical/start",
    payload: {
      chatId: session.id,
      party,
      enemies,
      battlefield: {
        features: [{ terrain: "forest", placement: "center", shape: "barrier" }],
      },
    },
  });
  assert.equal(invalidBrief.statusCode, 400, invalidBrief.body);
  assert.match(invalidBrief.json().error, /barrier features/i);

  const legacyCreated = await app.inject({
    method: "POST",
    url: "/api/game/create",
    payload: {
      name: "Legacy tactical game",
      setupConfig: { ...setupConfig, tacticalBattlefield: undefined },
    },
  });
  assert.equal(legacyCreated.statusCode, 200, legacyCreated.body);
  const legacyStarted = await app.inject({
    method: "POST",
    url: "/api/game/combat/tactical/start",
    payload: { chatId: legacyCreated.json().sessionChat.id, party, enemies, seed: 0 },
  });
  assert.equal(legacyStarted.statusCode, 200, legacyStarted.body);
  assert.equal(legacyStarted.json().state.seed, 0);
  assert.equal(legacyStarted.json().state.grid.width, 12, "Legacy callers retain unit-count sizing");
} finally {
  await app.close();
  await closeDB();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log("Hybrid tactical terrain route regression checks passed.");
