// Domain error classes. Caught and shaped into `{ error }` responses by
// plugins/errorHandler.ts. Routes and services should `throw` these directly;
// they should not assemble HTTP responses.

export class AuthError extends Error {
  override readonly name = 'AuthError';
  constructor(message: string) {
    super(message);
  }
}

export class ValidationError extends Error {
  override readonly name = 'ValidationError';
  constructor(message: string) {
    super(message);
  }
}

export class NotFoundError extends Error {
  override readonly name = 'NotFoundError';
  constructor(message: string) {
    super(message);
  }
}

export class ConflictError extends Error {
  override readonly name = 'ConflictError';
  constructor(message: string) {
    super(message);
  }
}

export class ForbiddenError extends Error {
  override readonly name = 'ForbiddenError';
  constructor(message: string) {
    super(message);
  }
}
