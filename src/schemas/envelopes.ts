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
