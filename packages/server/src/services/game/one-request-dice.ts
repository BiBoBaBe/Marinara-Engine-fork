// ──────────────────────────────────────────────
// Game: one-request dice — the chance pass and its wrapper
//
// A Game turn that rolls dice costs two provider requests today: the GM writes a
// draft with roll requests in it, the engine rolls, and the whole prompt goes back
// so the GM can rewrite the narration with the real numbers. With
// `gameOneRequestDice` on, the GM commits its prose first — both halves of a binary
// outcome, or a placeholder where a number goes — the engine rolls after the
// writing is done, and the rewrite request never fires. The model never sees a
// number before it decides what happens, so it cannot steer the outcome.
//
// ONE session per turn, TWO insertion points, for reasons that are load-bearing:
//
//   1. The branch arm runs before spatial extraction and before the package-verb
//      strip, so a discarded half's commands are gone before anything collects them.
//   2. The placeholder arm runs immediately AFTER the verb strip, so a placeholder
//      inside a verb's argument is already gone with the verb and is never rolled.
//      It cannot run at point 1: the verb table is not fetched until after spatial
//      extraction, so a pass placed there has nothing to compare a `[verb:` head
//      against.
//
// The failure contract is absolute and is the point of the wrapper: the pass never
// throws out of this module. On an internal failure the turn is saved with a notice
// and the affected tags are left sparse, no `[[roll:` span survives into saved
// content for a downstream stripper to half-eat, no branch delimiter survives
// either, and no second provider request is ever made. Nothing here invents a die
// result, a modifier, a total or an outcome.
//
// Both arms are real. Arm 1 keeps the half a live roll selects and deletes the other one
// before anything collects a command out of it; arm 2 rolls `[[roll: 2d6+3]]` with the
// session's crypto roller and substitutes the total, adding sheet modifiers by name
// through the same arithmetic a skill check uses. Each arm's grammar and bounded-span
// walk live in a shared module beside the tag it reads; what lives here is the
// chat-shaped half — the sheet, the roll, the ledger, the dice history and the log.
// ──────────────────────────────────────────────

import {
  dropGameBranchBlocks,
  isEngineRollableSkillCheckTag,
  parseRollPlaceholderBody,
  parseSkillCheckTagBody,
  readSkillCheckBranchLabel,
  replaceRollPlaceholdersWithNotice,
  resolveRollPlaceholders,
  scanGameBranchBlocks,
  scanRollPlaceholders,
  scanSkillCheckTagSpans,
  selectGameBranchHalf,
  serializeResolvedSkillCheckTag,
  stripGameBranchDelimiters,
  type DiceRollResult,
  type GameBranchBlock,
  type GameBranchRefusal,
  type GameDiceTurnNotice,
  type GameDicePlaceholderRecord,
  type RollPlaceholderRefusalRecord,
  type RollPlaceholderSheetModifier,
  type RPGAttributes,
  type SkillCheckResult,
  type SkillCheckTagSpan,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { logger } from "../../lib/logger.js";
import { rollDieSecurely, type DieRoller } from "./dice-rng.js";
import { attributeModifier, getGoverningAttribute, mapSheetAttributeName } from "./skill-check.service.js";
import {
  isResolvableSkillCheckRequest,
  loadSkillCheckModifierContext,
  resolveSkillCheckWithContext,
  type SkillCheckModifierContext,
  type SkillCheckRequest,
} from "./skill-check-resolution.service.js";

export { PLACEHOLDER_BODY_MAX, ROLL_UNAVAILABLE_TEXT } from "@marinara-engine/shared";

/** How much of a refused span is worth carrying into a log line. */
const LOGGED_SPAN_MAX = 200;

/** Which arm produced a ledger entry, and which insertion point the wrapper is at. */
export type GameTurnChanceStage = "branch" | "placeholder";

export interface GameTurnChanceLedgerEntry {
  stage: GameTurnChanceStage;
  /** `resolved` is a real recorded roll. `unreadable` is a span the pass refused and replaced. */
  outcome: "resolved" | "unreadable";
  /** The raw span, truncated, for the log line and the turn notice. */
  span?: string;
}

/** What an arm, or the wrapper's fallback, did to the content. */
export interface GameTurnChanceRewrite {
  content: string;
  changed: boolean;
}

export type GameTurnChanceArm = (content: string, session: GameTurnChanceSession) => Promise<GameTurnChanceRewrite>;

/**
 * One object per turn, holding one shared roller, one lazily loaded sheet-modifier
 * context and one ordered ledger. Resolving N checks in one narration must not mean N
 * snapshot reads, and every check in one turn must see the same sheet.
 */
export interface GameTurnChanceSession {
  readonly chatId: string;
  /** The one roller every mechanism in this turn uses. */
  readonly roll: DieRoller;
  /** Loaded at most once per turn, on first use. */
  loadModifierContext(): Promise<SkillCheckModifierContext>;
  /** Everything the pass resolved or refused, in the order it happened. */
  readonly ledger: GameTurnChanceLedgerEntry[];
  /**
   * Rolls this turn's pass threw, for the message extra and the session log. The route
   * pushes them onto the turn's dice results; deliberately WITHOUT the `tool_result`
   * frame that pops a full-screen dice card, because a damage placeholder popping a
   * card would bury the narration and three placeholders would queue three.
   */
  readonly diceRolls: DiceRollResult[];
  /** One audit record per substituted placeholder, in reading order. */
  readonly placeholders: GameDicePlaceholderRecord[];
  /** True once an arm threw and the fallback rewrite took over. */
  failed: boolean;
}

export interface GameTurnChanceSessionOptions {
  db: DB;
  chatId: string;
  /** Substitutable for a lane. Production always uses the crypto roller. */
  roll?: DieRoller;
  /** Substitutable for a lane that must not touch the database. */
  loadModifierContext?: () => Promise<SkillCheckModifierContext>;
}

/** Absent means off. The switch defaults to off at first release. */
export function isOneRequestDiceEnabled(chatMeta: Record<string, unknown> | null | undefined): boolean {
  return chatMeta?.gameOneRequestDice === true;
}

/**
 * The one-request guarantee, in code.
 *
 * While the switch is on this reads as if the narration toggle were off,
 * unconditionally: on a clean turn, on a fallback sparse tag, on a refused
 * placeholder, on a branch failure, and on a thrown pass. Nothing else in this
 * feature adds a provider call, so holding this closed is what makes a rolled turn
 * cost one request.
 *
 * The stored narration setting is read, never written: a player who turns the switch
 * off gets their narration preference back exactly as they left it.
 */
export function shouldNarrateGameDiceOutcome(
  chatMeta: Record<string, unknown> | null | undefined,
  rolledSomething: boolean,
): boolean {
  if (isOneRequestDiceEnabled(chatMeta)) return false;
  return chatMeta?.gameDiceOutcomeNarration !== false && rolledSomething;
}

export function createGameTurnChanceSession(options: GameTurnChanceSessionOptions): GameTurnChanceSession {
  let pending: Promise<SkillCheckModifierContext> | null = null;
  const load = options.loadModifierContext ?? (() => loadSkillCheckModifierContext(options.db, options.chatId));
  return {
    chatId: options.chatId,
    roll: options.roll ?? rollDieSecurely,
    loadModifierContext() {
      pending ??= load();
      return pending;
    },
    ledger: [],
    diceRolls: [],
    placeholders: [],
    failed: false,
  };
}

/** Why the arm would not resolve a block. The block's own reasons, plus the matching ones. */
export type GameBranchArmRefusal =
  | GameBranchRefusal
  /** No check tag claimed this block's label back. */
  | "unmatched-label"
  /** Two blocks, or two check tags, claimed the same label, so the label decides nothing. */
  | "ambiguous-label"
  /** The claimed tag is not a check this engine rolls, is out of bounds, or already carries a result. */
  | "unrollable-check";

/** Plain words for each refusal, so the log says what the model wrote rather than what a flag is called. */
const BRANCH_REFUSAL_REASONS: Record<GameBranchArmRefusal, string> = {
  unterminated: "the block never closed",
  nested: "the block carried another block or a check tag inside it",
  "empty-label": "the block named no label",
  "missing-half": "the block is missing one of its two halves",
  "duplicate-half": "the block wrote the same half twice",
  "unmatched-label": "no check tag claimed the block's label",
  "ambiguous-label": "the label was claimed more than once, so it decides nothing",
  "unrollable-check": "the claimed check is not one this engine rolls",
};

/** What the arm decided about one block, before anything is spliced. */
interface GameBranchPlan {
  block: GameBranchBlock;
  /** The check tag this block's label claimed, when exactly one claimed it back and it is rollable. */
  check: (SkillCheckTagSpan & { request: SkillCheckRequest }) | null;
  /** Null only when a half will be kept. */
  refusal: GameBranchArmRefusal | null;
}

/** One replacement, spliced in reading order so the prose between spans stays byte for byte. */
interface GameBranchEdit {
  start: number;
  end: number;
  replacement: string;
}

/**
 * Match every block to the check tag its label claims, and say what is wrong where it
 * does not work out.
 *
 * Matching is by label, folded, and it has to be exactly one on each side: a label two
 * blocks claim, or two check tags claim, decides nothing, and guessing which pairing the
 * model meant would decide a real outcome on a coin flip the player never sees. A check
 * tag INSIDE a block is never the match — the block is refused for carrying it, and the
 * tag is re-emitted for the shipped resolver to roll — so the two spans can never
 * overlap when the splice runs.
 */
export function planGameTurnBranches(content: string, blocks: GameBranchBlock[]): GameBranchPlan[] {
  const claimedByBlocks = new Map<string, number>();
  for (const block of blocks) {
    if (block.label) claimedByBlocks.set(block.label, (claimedByBlocks.get(block.label) ?? 0) + 1);
  }

  /** A label mapped to `null` was claimed twice, which is the same as not being claimed. */
  const checksByLabel = new Map<string, SkillCheckTagSpan | null>();
  for (const span of scanSkillCheckTagSpans(content)) {
    const label = readSkillCheckBranchLabel(span.body);
    if (!label) continue;
    checksByLabel.set(label, checksByLabel.has(label) ? null : span);
  }

  return blocks.map((block) => {
    const inside = (span: SkillCheckTagSpan) => span.start >= block.start && span.end <= block.end;
    const claimed = block.label ? checksByLabel.get(block.label) : undefined;
    const ambiguous = (claimedByBlocks.get(block.label) ?? 0) > 1 || claimed === null;
    const span = claimed && !inside(claimed) ? claimed : undefined;

    let check: GameBranchPlan["check"] = null;
    let matchRefusal: GameBranchArmRefusal | null = null;
    if (!block.label) {
      matchRefusal = "empty-label";
    } else if (ambiguous) {
      matchRefusal = "ambiguous-label";
    } else if (!span) {
      matchRefusal = "unmatched-label";
    } else {
      const tag = parseSkillCheckTagBody(span.body);
      const request: SkillCheckRequest | null =
        tag && !tag.resolvedResult && isEngineRollableSkillCheckTag(tag)
          ? {
              skill: tag.skill,
              dc: tag.dc,
              advantage: tag.advantage,
              disadvantage: tag.disadvantage,
              preRolledD20: tag.preRolledD20,
            }
          : null;
      if (request && isResolvableSkillCheckRequest(request)) check = { ...span, request };
      else matchRefusal = "unrollable-check";
    }
    return { block, check, refusal: block.refusal ?? matchRefusal };
  });
}

/**
 * Branch arm. Scans for `[branch: id] ... [/branch]` blocks with their matching sparse
 * check tags, resolves in reading order and splices.
 *
 * It runs BEFORE spatial extraction and BEFORE the package-verb strip, and that position
 * is the whole reason the arm exists where it does: the discarded half is gone before
 * anything collects a command out of it, so a `[spatial_move:]` or a package verb the
 * model wrote into the outcome that did not happen never reaches a parser at all. The
 * live rewrite path only holds that invariant by re-parsing both after the rewrite, and
 * re-parsing is exactly what a one-request turn skips.
 *
 * The roll goes through `resolveSkillCheckWithContext` with the session's crypto roller,
 * like every other check in the turn, so the sheet modifier, the advantage handling and
 * the critical flags are the shipped ones rather than a second implementation. A critical
 * folds into the success or failure half by its `success` boolean and is recorded in the
 * tag; it never becomes a third half.
 *
 * The failure contract, per 3.5, and every branch of it ends in the same place: the check
 * is rolled once, the RESOLVED record is written — never a sparse tag, which the client's
 * own fallback would pick up and roll a second time — neither half's prose is kept, the
 * delimiters are stripped, and no second provider request is ever made.
 */
export async function resolveGameTurnBranches(
  content: string,
  session: GameTurnChanceSession,
): Promise<GameTurnChanceRewrite> {
  const blocks = scanGameBranchBlocks(content);
  if (blocks.length === 0) return { content, changed: false };

  const plans = planGameTurnBranches(content, blocks);
  // The sheet is read at most once per turn, and only when a block actually has a check
  // to roll: a turn whose every block is malformed reads no snapshot at all.
  const context = plans.some((plan) => plan.check) ? await session.loadModifierContext() : null;

  const edits: GameBranchEdit[] = [];
  for (const plan of plans) {
    let result: SkillCheckResult | null = null;
    if (plan.check && context) {
      result = resolveSkillCheckWithContext(context, plan.check.request, () => session.roll(20));
      edits.push({
        start: plan.check.start,
        end: plan.check.end,
        replacement: serializeResolvedSkillCheckTag(result),
      });
    }

    const half = plan.refusal === null && result ? selectGameBranchHalf(plan.block, result.success) : null;
    if (half) {
      edits.push({ start: plan.block.start, end: plan.block.end, replacement: half.text });
      session.ledger.push({ stage: "branch", outcome: "resolved", span: plan.block.raw.slice(0, LOGGED_SPAN_MAX) });
      continue;
    }

    // Neither half is kept. Any check tag that sat inside the block is re-emitted,
    // because losing the ask is the one thing a refusal may not do.
    edits.push({
      start: plan.block.start,
      end: plan.block.end,
      replacement: plan.block.innerCheckTags.join(" "),
    });
    session.ledger.push({ stage: "branch", outcome: "unreadable", span: plan.block.raw.slice(0, LOGGED_SPAN_MAX) });
    logger.warn(
      "[game/one-request-dice] Refused a branch block in chat %s: %s (%s)%s",
      session.chatId,
      plan.block.raw.slice(0, LOGGED_SPAN_MAX),
      BRANCH_REFUSAL_REASONS[plan.refusal ?? "unmatched-label"],
      result ? " the check was still rolled and recorded" : "",
    );
  }

  edits.sort((left, right) => left.start - right.start);
  let next = "";
  let cursor = 0;
  for (const edit of edits) {
    // Overlapping spans cannot happen — a claimed check tag inside a block refuses that
    // block instead of matching it — but a splice that silently duplicated prose would be
    // invisible in the saved turn, so the guard is a skip rather than a trust.
    if (edit.start < cursor) continue;
    next += content.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  next += content.slice(cursor);
  // A half marker or a closer with no opener of its own is left over from a block the
  // walk could not bound. Nothing else on either side reaches those two spellings.
  next = stripGameBranchDelimiters(next);
  return { content: next, changed: next !== content };
}

/**
 * Placeholder arm. The opener walk, resolved and spliced in reading order.
 *
 * Every bounded span is either rolled or replaced with the visible notice, so no raw
 * `[[roll:` can reach saved content for a downstream stripper to half-eat, and nothing
 * is ever substituted with a number the engine did not throw.
 *
 * The chat's sheet is read at most once per turn, and only when a placeholder actually
 * names one: resolving N placeholders in one narration must not mean N snapshot reads,
 * and every roll in one turn must see the same sheet.
 */
export async function resolveGameTurnPlaceholders(
  content: string,
  session: GameTurnChanceSession,
): Promise<GameTurnChanceRewrite> {
  const spans = scanRollPlaceholders(content);
  if (spans.length === 0) return { content, changed: false };

  // The sheet is read only when a body actually names one. A turn of pure `2d6+3`
  // damage needs no snapshot at all, and in the default configuration there is no
  // snapshot to read: agents off means no game-state row was ever created.
  const namesSheet = spans.some(
    (span) => span.refusal === null && parseRollPlaceholderBody(span.body)?.sheetName != null,
  );
  const context = namesSheet ? await session.loadModifierContext() : null;
  const pass = resolveRollPlaceholders(content, {
    nextValue: session.roll,
    ...(context ? { resolveSheetName: (name: string) => resolveSheetModifier(context, name) } : {}),
  });

  for (const record of pass.records) {
    session.diceRolls.push({
      notation: record.notation,
      rolls: record.rolls,
      modifier: record.modifier,
      total: record.total,
    });
    session.placeholders.push(record);
    session.ledger.push({ stage: "placeholder", outcome: "resolved", span: record.raw });
  }
  for (const clamp of pass.clamps) {
    // The shipped policy for this path is to clamp rather than refuse, so the player
    // still gets a number. The log is the only place the difference is visible.
    logger.warn(
      "[game/one-request-dice] Clamped placeholder %s to %s in chat %s",
      clamp.requested,
      clamp.thrown,
      session.chatId,
    );
  }
  for (const refusal of pass.refusals) {
    logRefusedPlaceholder(refusal, session.chatId);
    session.ledger.push({ stage: "placeholder", outcome: "unreadable", span: refusal.raw.slice(0, LOGGED_SPAN_MAX) });
  }
  return { content: pass.content, changed: pass.changed };
}

/** Plain words for each refusal, so the log says what the model did rather than what a flag is called. */
const REFUSAL_REASONS: Record<RollPlaceholderRefusalRecord["reason"], string> = {
  unterminated: "the opener never closed before the line ended",
  "over-long": "the body ran past the length cap",
  "closing-bracket": "the body carried a closing bracket",
  notation: "the body is not one NdM term with at most one flat modifier and one sheet name",
  "unresolved-name": "the named sheet modifier does not resolve for this chat",
};

function logRefusedPlaceholder(refusal: RollPlaceholderRefusalRecord, chatId: string): void {
  logger.warn(
    "[game/one-request-dice] Refused a roll placeholder in chat %s: %s (%s)%s",
    chatId,
    refusal.raw.slice(0, LOGGED_SPAN_MAX),
    REFUSAL_REASONS[refusal.reason],
    refusal.name ? ` name=${refusal.name}` : "",
  );
}

/**
 * Resolve one `+NAME` term against the sheet this turn loaded, or refuse it.
 *
 * The two forms are deliberately not the same sum, and this is the only place that
 * difference is written down:
 *
 *   - `+<attribute>` adds `attributeModifier(score)` and nothing else. `1d8+STR` with
 *     STR 14 adds +2.
 *   - `+<skill>` adds the skill bonus PLUS its governing attribute's modifier, which is
 *     exactly what a skill check already does. `2d6+Athletics` with Athletics +3 and
 *     STR 14 adds +5. Anything else would make two numbers in the same turn follow
 *     different arithmetic with nothing telling the player which was which.
 *
 * A name that resolves to neither returns null, and the placeholder becomes the notice.
 * Refused, never defaulted to zero: a check with an unknown skill still has a defined
 * shape, so the check path's fallback is defensible, but a placeholder's name is only a
 * modifier source, and defaulting it would add a number nobody asked for to a sentence
 * the player reads as fact.
 */
export function resolveSheetModifier(
  context: SkillCheckModifierContext,
  name: string,
): RollPlaceholderSheetModifier | null {
  const attribute = mapSheetAttributeName(name);
  if (attribute) {
    const score = readAttributeScore(context, attribute);
    if (score === null) return null;
    return { value: attributeModifier(score), source: "attribute" };
  }

  const skills = context.skills;
  const rawSkillMod = skills ? (skills[name] ?? skills[name.toLowerCase()]) : undefined;
  if (rawSkillMod === undefined || !Number.isFinite(Number(rawSkillMod))) return null;
  const governing = readAttributeScore(context, getGoverningAttribute(name));
  return {
    value: Number(rawSkillMod) + (governing === null ? 0 : attributeModifier(governing)),
    source: "skill",
  };
}

/** The snapshot's engine-shape attributes first, then the player card's sheet, exactly as a check reads them. */
function readAttributeScore(context: SkillCheckModifierContext, attribute: keyof RPGAttributes): number | null {
  if (context.attributes && Number.isFinite(Number(context.attributes[attribute]))) {
    return Number(context.attributes[attribute]);
  }
  const sheet = context.sheetAttributes[attribute];
  return sheet == null ? null : sheet;
}

/**
 * The throw-safe wrapper, and the only way the route calls an arm.
 *
 * An arm that throws does not take the turn with it. The session is marked failed, the
 * error is logged, and this stage's fallback rewrite runs so the content can stand:
 * every `[[roll:` span the scanner still finds becomes a visible notice, and every
 * branch delimiter is stripped. Once a stage has failed the later stage runs its own
 * fallback too rather than its arm, so no raw span can reach saved content by arriving
 * after the failure.
 *
 * The caller must set `contentReplaced` whenever this reports `changed`, including on
 * the fallback rewrite: without it the corrected text is saved but never sent, and the
 * player's streamed view keeps the hole.
 */
export async function runGameTurnChancePass(
  content: string,
  session: GameTurnChanceSession,
  arm: GameTurnChanceArm,
  stage: GameTurnChanceStage,
): Promise<GameTurnChanceRewrite> {
  if (session.failed) return applyChanceFallback(content, session, stage);
  try {
    return await arm(content, session);
  } catch (err) {
    session.failed = true;
    logger.error(err, "[game/one-request-dice] The %s arm failed for chat %s; keeping the turn", stage, session.chatId);
    return applyChanceFallback(content, session, stage);
  }
}

/**
 * The fallback rewrite of the failure contract. Drops the branch blocks at either stage,
 * and sweeps the placeholder spans at the later stage only, so a placeholder inside a
 * package verb's argument still goes away with the verb instead of being rewritten in
 * front of it.
 *
 * The blocks are DROPPED rather than un-delimited, which is the same call 3.5 makes for a
 * block the arm itself refused: a pass that failed rolled nothing, so keeping both halves
 * would save a turn asserting two contradictory outcomes and keeping one would invent the
 * outcome. The check tags inside a dropped block are re-emitted, so the ask survives and
 * the shipped resolver still rolls it.
 */
export function applyChanceFallback(
  content: string,
  session: GameTurnChanceSession,
  stage: GameTurnChanceStage,
): GameTurnChanceRewrite {
  let next = content;
  let changed = false;
  const blocks = dropGameBranchBlocks(next);
  if (blocks.changed) {
    next = blocks.content;
    changed = true;
    for (const block of blocks.blocks) {
      session.ledger.push({ stage, outcome: "unreadable", span: block.slice(0, LOGGED_SPAN_MAX) });
      logger.warn(
        "[game/one-request-dice] Dropped a branch block after the pass failed in chat %s: %s",
        session.chatId,
        block.slice(0, LOGGED_SPAN_MAX),
      );
    }
    if (blocks.blocks.length === 0) {
      session.ledger.push({ stage, outcome: "unreadable", span: "[branch]" });
    }
  }
  if (stage === "placeholder") {
    const placeholders = replaceUnreadablePlaceholders(next, session.chatId);
    if (placeholders.changed) {
      next = placeholders.content;
      changed = true;
      for (const span of placeholders.spans) {
        session.ledger.push({ stage, outcome: "unreadable", span });
      }
    }
  }
  return { content: next, changed };
}

/** Strip `[branch: id]`, `[on success]`, `[on failure]` and `[/branch]`, keeping the prose between them. */
export function stripBranchDelimiters(content: string): GameTurnChanceRewrite {
  const next = stripGameBranchDelimiters(content);
  return { content: next, changed: next !== content };
}

/**
 * Replace every `[[roll:` span with a visible notice, reading none of them. Never with
 * a number: an invented number is read back as fact on the next turn, which is the one
 * thing the shipped never-invent contract forbids without exception.
 *
 * This is the failure path, not the resolution path. The span is always bounded, which
 * is what makes the replacement absolute; the bounding rules live with the scanner in
 * the shared placeholder module, beside the grammar they belong to.
 */
export function replaceUnreadablePlaceholders(
  content: string,
  chatId: string,
): GameTurnChanceRewrite & { spans: string[] } {
  const swept = replaceRollPlaceholdersWithNotice(content);
  const spans = swept.spans.map((span) => span.slice(0, LOGGED_SPAN_MAX));
  for (const span of spans) {
    logger.warn("[game/one-request-dice] Refused an unreadable roll placeholder in chat %s: %s", chatId, span);
  }
  return { content: swept.content, changed: swept.changed, spans };
}

/**
 * The turn notice of the failure contract, for the message extra and the SSE frame.
 * Only truthy fields are written, so a clean turn stores nothing at all and an older
 * transcript reads exactly as it always did.
 */
export function summarizeGameDiceTurn(session: GameTurnChanceSession): GameDiceTurnNotice | null {
  const forms: Array<"branch" | "placeholder"> = [];
  let unreadablePlaceholders = 0;
  let branchFailures = 0;
  for (const entry of session.ledger) {
    if (entry.outcome === "resolved") {
      if (!forms.includes(entry.stage)) forms.push(entry.stage);
    } else if (entry.stage === "placeholder") {
      unreadablePlaceholders += 1;
    } else {
      branchFailures += 1;
    }
  }
  const notice: GameDiceTurnNotice = {
    ...(forms.length > 0 ? { forms } : {}),
    ...(session.placeholders.length > 0 ? { placeholders: [...session.placeholders] } : {}),
    ...(unreadablePlaceholders > 0 ? { unreadablePlaceholders } : {}),
    ...(branchFailures > 0 ? { branchFailures } : {}),
    ...(session.failed ? { passFailed: true } : {}),
  };
  return Object.keys(notice).length > 0 ? notice : null;
}
