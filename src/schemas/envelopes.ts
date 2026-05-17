import { z } from 'zod';

// Standard {data: T} success envelope used by every route. Generic so each
// route can declare the inner shape.
export const Envelope = <T extends z.ZodTypeAny>(data: T): z.ZodObject<{ data: T }> =>
  z.object({ data });

// Standard {error: string} failure envelope. Emitted by errorHandler for
// every non-2xx response.
export const ErrorResponse = z.object({ error: z.string() });

// Empty body — used to annotate 204 responses in OpenAPI.
export const EmptyResponse = z.void();

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

// Pagination query params. Append to list endpoints' querystring schemas.
// `limit` clamps page size; `cursor` is the opaque last-id of the previous
// page (callers should treat it as opaque).
export const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  cursor: z.string().uuid().optional(),
});

export type PaginationOpts = z.infer<typeof PaginationQuery>;

// Sibling-style page envelope: { data: T[], pageInfo: { nextCursor, hasMore } }.
// `nextCursor` is null on the last page; `hasMore` mirrors `nextCursor !== null`
// for clients that prefer a boolean check.
export const Page = <T extends z.ZodTypeAny>(
  data: T,
): z.ZodObject<{
  data: z.ZodArray<T>;
  pageInfo: z.ZodObject<{ nextCursor: z.ZodNullable<z.ZodString>; hasMore: z.ZodBoolean }>;
}> =>
  z.object({
    data: z.array(data),
    pageInfo: z.object({
      nextCursor: z.string().nullable(),
      hasMore: z.boolean(),
    }),
  });

// Repository/service result shape for paginated reads. Mirrors `Page<T>` on
// the wire side.
export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
}
