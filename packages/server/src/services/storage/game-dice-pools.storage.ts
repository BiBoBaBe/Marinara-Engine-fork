// ──────────────────────────────────────────────
// Game: dice-pool row storage
//
// One row per (chat, message, swipe), holding the queue a turn was PROMPTED with and
// what that turn spent out of it. Reads are always chat-scoped, so a lookup never
// crosses a chat even when a message id is reused by an import.
// ──────────────────────────────────────────────

import { and, desc, eq } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import { gameDicePools } from "../../db/schema/index.js";
import { newId, now } from "../../utils/id-generator.js";

export interface GameDicePoolRow {
  id: string;
  chatId: string;
  messageId: string;
  swipeIndex: number;
  pool: string;
  consumed: string;
  createdAt: string;
}

export interface SaveGameDicePoolInput {
  chatId: string;
  messageId: string;
  swipeIndex: number;
  pool: string;
  consumed: string;
}

export function createGameDicePoolsStorage(db: DB) {
  return {
    /** The row this exact (message, swipe) already wrote, when it has one. */
    async getForTurn(chatId: string, messageId: string, swipeIndex: number): Promise<GameDicePoolRow | null> {
      const rows = (await db
        .select()
        .from(gameDicePools)
        .where(
          and(
            eq(gameDicePools.chatId, chatId),
            eq(gameDicePools.messageId, messageId),
            eq(gameDicePools.swipeIndex, swipeIndex),
          ),
        )) as GameDicePoolRow[];
      return rows[0] ?? null;
    },

    /**
     * The earliest row any swipe of this message wrote.
     *
     * A regenerate re-reads the pool the first telling of that turn was dealt, which is
     * what closes reroll-until-lucky: an alternative telling faces the same luck rather
     * than a queue that has moved on.
     */
    async getEarliestForMessage(chatId: string, messageId: string): Promise<GameDicePoolRow | null> {
      const rows = (await db
        .select()
        .from(gameDicePools)
        .where(and(eq(gameDicePools.chatId, chatId), eq(gameDicePools.messageId, messageId)))) as GameDicePoolRow[];
      return [...rows].sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0] ?? null;
    },

    /** The most recent row in the chat — the queue a brand new turn refills from. */
    async getLatestForChat(chatId: string): Promise<GameDicePoolRow | null> {
      const rows = (await db
        .select()
        .from(gameDicePools)
        .where(eq(gameDicePools.chatId, chatId))
        .orderBy(desc(gameDicePools.createdAt))
        .limit(1)) as GameDicePoolRow[];
      return rows[0] ?? null;
    },

    /**
     * Write this turn's row, replacing the one it already had.
     *
     * Replace rather than append, because a continuation updates its own row IN PLACE:
     * two rows for one (message, swipe) would mean two different accounts of what that
     * turn spent, and the later reader could not tell which one the prompt was built from.
     */
    async save(input: SaveGameDicePoolInput): Promise<GameDicePoolRow> {
      const existing = await this.getForTurn(input.chatId, input.messageId, input.swipeIndex);
      if (existing) {
        await db
          .delete(gameDicePools)
          .where(and(eq(gameDicePools.chatId, input.chatId), eq(gameDicePools.id, existing.id)));
      }
      const row: GameDicePoolRow = {
        id: existing?.id ?? newId(),
        chatId: input.chatId,
        messageId: input.messageId,
        swipeIndex: input.swipeIndex,
        pool: input.pool,
        consumed: input.consumed,
        // The original row's timestamp is kept so a continuation's in-place update does
        // not reorder the chat's rows under `getLatestForChat`.
        createdAt: existing?.createdAt ?? now(),
      };
      await db.insert(gameDicePools).values(row);
      return row;
    },
  };
}
