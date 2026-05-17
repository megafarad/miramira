import type { PageResult } from '../schemas/envelopes.js';

// Given a row set fetched as `limit + 1`, return the first `limit` rows plus
// the nextCursor (the last *kept* row's id) if the extra row was present.
// Otherwise return all rows with nextCursor = null.
export function paginate<T>(rows: T[], limit: number, cursorOf: (row: T) => string): PageResult<T> {
  if (rows.length > limit) {
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    if (!last) return { items, nextCursor: null };
    return { items, nextCursor: cursorOf(last) };
  }
  return { items: rows, nextCursor: null };
}
