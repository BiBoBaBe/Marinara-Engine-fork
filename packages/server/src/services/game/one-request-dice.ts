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
// The two arms are skeletons in this slice. The branch block fills arm 1 and the
// placeholder grammar fills arm 2; the wrapper, the ledger and the gate are what
// this file ships now, so both arms land into a contract that already holds.
// ──────────────────────────────────────────────

import type { GameDiceTurnNotice } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { logger } from "../../lib/logger.js";
import { rollDieSecurely, type DieRoller } from "./dice-rng.js";
import { loadSkillCheckModifierContext, type SkillCheckModifierContext } from "./skill-check-resolution.service.js";

/** Replacement for a roll the engine refused to read. No bracket, no colon, no brace. */
export const ROLL_UNAVAILABLE_TEXT = "(roll unavailable)";

/**
 * The scan is an opener walk, not a bounded regex. A bounded regex cannot see an
 * over-long body, a body containing `]`, or an opener with no closer, and a span that
 * is never matched cannot be replaced — so the "never leave a raw span" contract
 * would be unenforceable for exactly the cases that need it.
 */
const PLACEHOLDER_OPENER_SOURCE = "\\[\\[roll:";
/** A body longer than this is a rejection reason inside the pass, not a matching precondition. */
export const PLACEHOLDER_BODY_MAX = 64;

/** `[branch: id]` is an ordinary `[name:` head. The other three delimiters are not. */
const BRANCH_OPENER_PATTERN = /\[branch:[^\]\r\n]*\]/gi;
/**
 * `[on success]` has a space between the name and the `]`, so the server's tag-head
 * reader and the client's bracket walk both return null for it and every
 * removable-tag set is skipped before it is ever consulted. Only a literal pattern
 * reaches it. Same for `[/branch]`, which is not a `[name:` or `[name]` head at all.
 */
const BRANCH_HALF_PATTERN = /\[on\s+(?:success|failure)\]/gi;
const BRANCH_CLOSER_PATTERN = /\[\/branch\]/gi;

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
    failed: false,
  };
}

/**
 * Branch arm. Scans for `[branch: id] ... [/branch]` blocks with their matching sparse
 * check tags, resolves in reading order and splices.
 *
 * A no-op in this slice, on purpose. The branch failure contract does not say "strip
 * the delimiters": it says roll the check once, write the RESOLVED record, and keep
 * neither half — and the roller and the record belong to the branch slice. Half of that
 * contract would be worse than none, because a stripped block leaves both outcomes
 * standing as prose. Nothing prompts the model to write a branch block until the prompt
 * slice lands, so the arm has nothing to see before then; a block written anyway falls
 * through to the shipped sparse-tag behaviour.
 */
export async function resolveGameTurnBranches(
  content: string,
  _session: GameTurnChanceSession,
): Promise<GameTurnChanceRewrite> {
  return await Promise.resolve({ content, changed: false });
}

/**
 * Placeholder arm. The opener walk, resolved and spliced in reading order.
 *
 * This slice ships the walk and the refusal, not the grammar: every span it finds is a
 * span it cannot read yet, so every span is refused and replaced with the visible
 * notice. That is deliberate rather than provisional. It means no raw `[[roll:` can
 * reach saved content at any point in the rollout for a downstream stripper to
 * half-eat, and it means nothing is ever substituted with an invented number. The
 * grammar slice replaces the refusal with resolution for the bodies it can read and
 * leaves this exact path for the bodies it cannot.
 */
export async function resolveGameTurnPlaceholders(
  content: string,
  session: GameTurnChanceSession,
): Promise<GameTurnChanceRewrite> {
  const refused = replaceUnreadablePlaceholders(content, session.chatId);
  for (const span of refused.spans) {
    session.ledger.push({ stage: "placeholder", outcome: "unreadable", span });
  }
  return await Promise.resolve({ content: refused.content, changed: refused.changed });
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
 * The fallback rewrite of the failure contract. Strips the branch delimiters at either
 * stage, and sweeps the placeholder spans at the later stage only, so a placeholder
 * inside a package verb's argument still goes away with the verb instead of being
 * rewritten in front of it.
 */
export function applyChanceFallback(
  content: string,
  session: GameTurnChanceSession,
  stage: GameTurnChanceStage,
): GameTurnChanceRewrite {
  let next = content;
  let changed = false;
  const delimiters = stripBranchDelimiters(next);
  if (delimiters.changed) {
    next = delimiters.content;
    changed = true;
    session.ledger.push({ stage, outcome: "unreadable", span: "[branch]" });
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
  const next = content
    .replace(BRANCH_OPENER_PATTERN, "")
    .replace(BRANCH_HALF_PATTERN, "")
    .replace(BRANCH_CLOSER_PATTERN, "");
  return { content: next, changed: next !== content };
}

/**
 * Replace every `[[roll:` span with a visible notice. Never with a number: an invented
 * number is read back as fact on the next turn, which is the one thing the shipped
 * never-invent contract forbids without exception.
 *
 * The span is always bounded, which is what makes the replacement absolute:
 *
 *   1. The first `]]` before the next line break closes it.
 *   2. Any run of `]` straight after that is swallowed too, so `[[roll: 2d6 [x]]]` is
 *      consumed whole and leaves no stray bracket.
 *   3. With no `]]` before the line break, the span ends at the line break or at
 *      `PLACEHOLDER_BODY_MAX` characters past the opener, whichever comes first.
 *
 * The cost of rule 3 is stated rather than hidden: an unterminated opener can take a
 * few words of that line's prose with it. It is only reachable when the model wrote a
 * malformed tag, the raw span is logged verbatim, and the turn notice fires.
 */
export function replaceUnreadablePlaceholders(
  content: string,
  chatId: string,
): GameTurnChanceRewrite & { spans: string[] } {
  const opener = new RegExp(PLACEHOLDER_OPENER_SOURCE, "gi");
  const spans: string[] = [];
  let result = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(content)) !== null) {
    const start = match.index;
    const end = findPlaceholderSpanEnd(content, start + match[0].length);
    const span = content.slice(start, end);
    spans.push(span.slice(0, LOGGED_SPAN_MAX));
    logger.warn(
      "[game/one-request-dice] Refused an unreadable roll placeholder in chat %s: %s",
      chatId,
      span.slice(0, LOGGED_SPAN_MAX),
    );
    result += content.slice(cursor, start) + ROLL_UNAVAILABLE_TEXT;
    cursor = end;
    opener.lastIndex = end;
  }
  if (spans.length === 0) return { content, changed: false, spans };
  result += content.slice(cursor);
  return { content: result, changed: true, spans };
}

function findPlaceholderSpanEnd(content: string, bodyStart: number): number {
  let lineEnd = content.length;
  for (let index = bodyStart; index < content.length; index += 1) {
    const char = content[index];
    if (char === "\n" || char === "\r") {
      lineEnd = index;
      break;
    }
  }
  const closer = content.indexOf("]]", bodyStart);
  if (closer !== -1 && closer < lineEnd) {
    let end = closer + 2;
    while (content[end] === "]") end += 1;
    return end;
  }
  return Math.min(lineEnd, bodyStart + PLACEHOLDER_BODY_MAX);
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
    ...(unreadablePlaceholders > 0 ? { unreadablePlaceholders } : {}),
    ...(branchFailures > 0 ? { branchFailures } : {}),
    ...(session.failed ? { passFailed: true } : {}),
  };
  return Object.keys(notice).length > 0 ? notice : null;
}
