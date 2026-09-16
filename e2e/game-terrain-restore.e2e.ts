import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { GameCombatStateSnapshot, TacticalCombatState } from "../packages/shared/src/index.js";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const party = [
  {
    id: "terrain-restorer",
    name: "Terrain Restorer",
    hp: 24,
    maxHp: 24,
    attack: 8,
    defense: 5,
    speed: 7,
    level: 1,
    side: "player" as const,
    movementMode: "walk" as const,
  },
];

const enemies = [
  {
    id: "ruin-guard",
    name: "Ruin Guard",
    hp: 18,
    maxHp: 18,
    attack: 6,
    defense: 4,
    speed: 4,
    level: 1,
    side: "enemy" as const,
  },
];

type TerrainRestoreMetadata = Record<string, unknown> & {
  gameCombatStyle?: string;
  gameCombatState?: GameCombatStateSnapshot | null;
  gameTacticalCombatSnapshot?: TacticalCombatState | null;
};

async function readMetadata(request: APIRequestContext, chatId: string): Promise<TerrainRestoreMetadata> {
  const response = await request.get(`/api/chats/${chatId}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  const chat = await response.json();
  return (typeof chat.metadata === "string" ? JSON.parse(chat.metadata) : chat.metadata) as TerrainRestoreMetadata;
}

async function openGame(page: Page, chatId: string, testInfo: TestInfo) {
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    sidebarOpen: false,
    rightPanelOpen: false,
    chatHelpSeenModes: ["game"],
    gameInstantTextReveal: true,
    theme: testInfo.project.name === "desktop-chromium" ? "light" : "dark",
  });
  await page.addInitScript(
    ({ id, version }) => {
      localStorage.setItem("marinara-active-chat-id", id);
      localStorage.setItem("marinara:whats-new:seen-version", version);
    },
    { id: chatId, version },
  );
  await page.goto("/");
}

async function chooseClassicForNextBattle(page: Page, testInfo: TestInfo) {
  if (testInfo.project.name.includes("mobile")) {
    await page.getByRole("button", { name: "Game actions", exact: true }).click();
  }
  await page.getByRole("button", { name: "Chat Settings", exact: true }).filter({ visible: true }).click();
  const section = page.locator('[data-chat-settings-section="combat-style"]');
  await section.locator('[role="button"][aria-expanded]').click();
  await section.getByRole("combobox", { name: "Battle system", exact: true }).selectOption("classic");
  await page.getByRole("button", { name: "Close chat settings", exact: true }).click();
}

for (const legacySnapshot of [false, true]) {
  test(`GameSurface restores ${legacySnapshot ? "legacy" : "current"} pending and accepted tactical terrain without changing the active battle style`, async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(15_000);
    const created = await request.post("/api/game/create", {
      data: {
        name: "Terrain restore browser proof",
        setupConfig: {
          genre: "Fantasy",
          setting: "A broken mountain pass",
          tone: "Adventure",
          difficulty: "normal",
          playerGoals: "Secure the pass",
          gmMode: "standalone",
          rating: "sfw",
          partyCharacterIds: [],
          combatStyle: "tactical",
          tacticalBattlefield: { seed: 0, size: "large" },
        },
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const chatId = (await created.json()).sessionChat.id as string;

    try {
      const messageResponse = await request.post(`/api/chats/${chatId}/messages`, {
        data: { role: "assistant", content: "The ruined gate closes behind the party. [combat: Ruin Guard]" },
      });
      expect(messageResponse.ok(), await messageResponse.text()).toBeTruthy();
      const startMessageId = (await messageResponse.json()).id as string;
      const pendingSnapshot: GameCombatStateSnapshot = {
        party,
        enemies,
        itemEffects: [],
        mechanics: [],
        dialogueCues: [],
        startMessageId,
        ...(legacySnapshot ? {} : { combatStyle: "tactical" as const }),
        sceneEnvironment: "A ruined gate in a broken mountain pass",
        sceneEnvironmentType: "ruins",
        formation: "line",
        battlefield: null,
        battlefieldError: "The GM's terrain request was invalid: Unknown battlefield terrain.",
        styleNotes: {
          environmentType: "ruins",
          atmosphere: "dark",
          timeOfDay: "night",
          weather: "clear",
        },
      };
      const patched = await request.patch(`/api/chats/${chatId}/metadata`, {
        data: {
          gameSessionStatus: "active",
          gameIntroPresented: true,
          gameActiveState: "combat",
          gameImageAutoGenerationEnabled: false,
          gameStoryboardAutoIllustrationsEnabled: false,
          gameCombatStyle: "tactical",
          gameCombatState: pendingSnapshot,
          gameTacticalCombatSnapshot: null,
        },
      });
      expect(patched.ok(), await patched.text()).toBeTruthy();

      const startRequests: unknown[] = [];
      page.on("request", (browserRequest) => {
        if (browserRequest.url().endsWith("/api/game/combat/tactical/start")) {
          startRequests.push(browserRequest.postDataJSON());
        }
      });

      await openGame(page, chatId, testInfo);
      const fallback = page.getByRole("button", { name: "Use generated terrain", exact: true });
      await expect(fallback).toBeVisible({ timeout: 40_000 });
      expect(startRequests).toEqual([]);

      await page.reload();
      await expect(fallback).toBeVisible({ timeout: 40_000 });
      expect(startRequests).toEqual([]);

      await fallback.click();
      const tacticalBattle = page.locator('[data-component="TacticalCombatUI"]');
      await expect(tacticalBattle.getByRole("button", { name: "End Turn", exact: true })).toBeVisible({
        timeout: 40_000,
      });
      await expect.poll(async () => (await readMetadata(request, chatId)).gameTacticalCombatSnapshot).toBeTruthy();
      const acceptedMetadata = await readMetadata(request, chatId);
      const accepted = acceptedMetadata.gameTacticalCombatSnapshot as TacticalCombatState;
      expect(accepted.seed).toBe(0);
      expect([accepted.grid.width, accepted.grid.height]).toEqual([14, 10]);
      expect(accepted.battlefield).toMatchObject({ kind: "generated", generatorVersion: 1, size: "large" });
      await expect
        .poll(async () => (await readMetadata(request, chatId)).gameCombatState?.combatStyle)
        .toBe("tactical");

      await chooseClassicForNextBattle(page, testInfo);
      await expect.poll(async () => (await readMetadata(request, chatId)).gameCombatStyle).toBe("classic");
      await expect(tacticalBattle.getByRole("button", { name: "End Turn", exact: true })).toBeVisible();

      if (legacySnapshot) {
        const saved = (await readMetadata(request, chatId)).gameCombatState!;
        const { combatStyle: _style, ...legacy } = saved;
        // Mimic an older active board whose next-battle setting has changed.
        const response = await request.patch(`/api/chats/${chatId}/metadata`, {
          data: { gameCombatState: legacy },
        });
        expect(response.ok(), await response.text()).toBeTruthy();
      }
      await page.reload();
      await expect(tacticalBattle.getByRole("button", { name: "End Turn", exact: true })).toBeVisible({
        timeout: 40_000,
      });
      await expect(fallback).toHaveCount(0);
      expect(startRequests).toHaveLength(1);
      const restoredMetadata = await readMetadata(request, chatId);
      expect(restoredMetadata.gameTacticalCombatSnapshot).toEqual(accepted);
      await expect
        .poll(async () => (await readMetadata(request, chatId)).gameCombatState)
        .toMatchObject({
          combatStyle: "tactical",
          sceneEnvironmentType: "ruins",
          formation: "line",
          battlefieldError: null,
        });
    } finally {
      await request.delete(`/api/chats/${chatId}?force=true`).catch(() => undefined);
    }
  });
}
