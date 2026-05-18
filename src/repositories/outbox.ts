import { and, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { newId } from '../lib/ids.js';
import { outboxEvents, type OutboxEvent } from '../db/schema.js';

// Discriminated union of outbox payloads the OpenFGA worker knows how to
// translate. Extend as new aggregate types are added.
export type OutboxPayload =
  | { kind: 'tenant.created'; tenantId: string; parentId: string | null }
  | { kind: 'tenant.parent_changed'; tenantId: string; parentId: string | null }
  | {
      kind: 'role_binding.created';
      bindingId: string;
      principalId: string;
      roleId: string;
      tenantId: string;
    }
  | { kind: 'role_binding.revoked'; bindingId: string }
  | { kind: 'role.scope_added'; roleId: string; scopeId: string }
  | { kind: 'role.scope_removed'; roleId: string; scopeId: string };

export interface EnqueueInput {
  aggregateType: string;
  aggregateId: string;
  payload: OutboxPayload;
}

export interface OutboxRepo {
  enqueue(tx: DbOrTx, input: EnqueueInput): Promise<OutboxEvent>;
  claimBatch(limit: number): Promise<OutboxEvent[]>;
  ackProcessed(ids: string[]): Promise<void>;
  recordFailure(id: string, error: string, nextRetryAt: Date): Promise<void>;
  /**
   * Retire an event to dead-letter state: sets dead_at = now() and records
   * the final error. Dead events are skipped by claimBatch / listPending.
   * Revive by clearing dead_at and resetting attempts + next_retry_at.
   */
  markDead(id: string, finalError: string): Promise<void>;
  listPending(): Promise<OutboxEvent[]>;
  /** Dead-letter rows. Operators query this to see what needs intervention. */
  listDead(): Promise<OutboxEvent[]>;
  /** Count of pending (unprocessed, not dead) events. Used by the metrics gauge. */
  countPending(): Promise<number>;
  /** Count of dead-letter events. Used by the metrics gauge. */
  countDead(): Promise<number>;
  /**
   * Earliest `next_retry_at` among pending events, or null if the queue is
   * empty. The metrics layer derives `oldest_pending_age_ms` from this.
   */
  oldestPendingAt(): Promise<Date | null>;
}

export class OutboxRepository implements OutboxRepo {
  constructor(private readonly db: DbOrTx) {}

  /**
   * Enqueue an event. Callers MUST pass a transactional handle so the event
   * row is committed atomically with the business write. The worker picks up
   * unprocessed rows whose `next_retry_at <= now()`.
   */
  async enqueue(tx: DbOrTx, input: EnqueueInput): Promise<OutboxEvent> {
    const [row] = await tx
      .insert(outboxEvents)
      .values({
        id: newId(),
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        eventType: input.payload.kind,
        payload: input.payload,
      })
      .returning();
    if (!row) throw new Error('outbox insert returned no row');
    return row;
  }

  /**
   * Claim up to `limit` unprocessed events whose `next_retry_at <= now()`.
   * Uses FOR UPDATE SKIP LOCKED so multiple workers can run safely.
   * Bumps `attempts` and clears `last_error` on the claimed rows.
   */
  async claimBatch(limit: number): Promise<OutboxEvent[]> {
    const rows = await this.db.execute<OutboxEvent>(sql`
      WITH claimed AS (
        SELECT id
        FROM ${outboxEvents}
        WHERE processed_at IS NULL
          AND dead_at IS NULL
          AND next_retry_at <= now()
        ORDER BY next_retry_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE ${outboxEvents} oe
      SET attempts = oe.attempts + 1,
          last_error = NULL,
          updated_at = now()
      FROM claimed
      WHERE oe.id = claimed.id
      RETURNING oe.id, oe.aggregate_type AS "aggregateType", oe.aggregate_id AS "aggregateId",
                oe.event_type AS "eventType", oe.payload, oe.created_at AS "createdAt",
                oe.processed_at AS "processedAt", oe.attempts, oe.last_error AS "lastError",
                oe.next_retry_at AS "nextRetryAt", oe.dead_at AS "deadAt",
                oe.updated_at AS "updatedAt"
    `);
    return [...rows];
  }

  async ackProcessed(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(outboxEvents)
      .set({ processedAt: sql`now()`, updatedAt: sql`now()` })
      .where(inArray(outboxEvents.id, ids));
  }

  async recordFailure(id: string, error: string, nextRetryAt: Date): Promise<void> {
    await this.db
      .update(outboxEvents)
      .set({ lastError: error, nextRetryAt, updatedAt: sql`now()` })
      .where(eq(outboxEvents.id, id));
  }

  async markDead(id: string, finalError: string): Promise<void> {
    await this.db
      .update(outboxEvents)
      .set({ lastError: finalError, deadAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(outboxEvents.id, id));
  }

  async listPending(): Promise<OutboxEvent[]> {
    return this.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          isNull(outboxEvents.processedAt),
          isNull(outboxEvents.deadAt),
          lte(outboxEvents.nextRetryAt, sql`now()`),
        ),
      );
  }

  async listDead(): Promise<OutboxEvent[]> {
    return this.db.select().from(outboxEvents).where(isNotNull(outboxEvents.deadAt));
  }

  async countPending(): Promise<number> {
    const rows = await this.db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n
      FROM ${outboxEvents}
      WHERE processed_at IS NULL AND dead_at IS NULL
    `);
    return parseCount(rows[0]?.n);
  }

  async countDead(): Promise<number> {
    const rows = await this.db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n
      FROM ${outboxEvents}
      WHERE dead_at IS NOT NULL
    `);
    return parseCount(rows[0]?.n);
  }

  async oldestPendingAt(): Promise<Date | null> {
    // postgres-js returns timestamptz as a string when the query is raw SQL
    // (the Drizzle column-type metadata that auto-parses to Date doesn't
    // apply here). Coerce so callers get a Date regardless of driver path.
    const rows = await this.db.execute<{ t: string | Date | null }>(sql`
      SELECT min(next_retry_at) AS t
      FROM ${outboxEvents}
      WHERE processed_at IS NULL AND dead_at IS NULL
    `);
    const raw = rows[0]?.t ?? null;
    if (raw === null) return null;
    return raw instanceof Date ? raw : new Date(raw);
  }
}

// count(*) comes back as a Postgres bigint, which postgres-js exposes as a
// string to avoid JS Number truncation. Our queue won't approach 2^53 rows.
function parseCount(value: string | undefined): number {
  if (value === undefined) return 0;
  return Number(value);
}

export type { OutboxEvent } from '../db/schema.js';
