import type { GameSetupConfig, InstalledCapabilityPackage } from "@marinara-engine/shared";

export function parseExperienceSeed(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const seed = Number(value);
  return Number.isFinite(seed) ? seed : null;
}

export function buildExperienceSetup(
  experience: InstalledCapabilityPackage | null,
  seedInput: string,
  isNewGame: boolean,
): Pick<GameSetupConfig, "gameExperienceId" | "experienceConfig"> {
  const setup = experience?.manifest.contributions?.gameSurface?.setup;
  if (!isNewGame || !experience || !setup) return {};
  const seed = parseExperienceSeed(seedInput);
  return {
    gameExperienceId: experience.id,
    experienceConfig: { ...setup.config, ...(setup.seed && seed !== null ? { [setup.seed.key]: seed } : {}) },
  };
}
