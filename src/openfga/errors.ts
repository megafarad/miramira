import { FgaApiValidationError } from '@openfga/sdk';

// OpenFGA returns FgaApiValidationError with code `write_failed_due_to_invalid_input`
// for both duplicate-write and delete-of-missing. The two cases are only
// distinguishable by the human-readable message text. Match on the stable
// substrings the server returns.

const DUPLICATE_MARKER = 'tuple to be written already exist';
const MISSING_MARKER = 'tuple to be deleted did not exist';
// Server message historically inconsistent — older OpenFGA versions emit
// "tuple to be written already exist" (sic) for the delete-of-missing path
// because of shared error formatting. Match both wordings to be safe.
const MISSING_MARKER_LEGACY = 'cannot delete a tuple which does not exist';

export function isDuplicateTupleError(err: unknown): boolean {
  return err instanceof FgaApiValidationError && (err.message ?? '').includes(DUPLICATE_MARKER);
}

export function isMissingTupleError(err: unknown): boolean {
  if (!(err instanceof FgaApiValidationError)) return false;
  const msg = err.message ?? '';
  return msg.includes(MISSING_MARKER) || msg.includes(MISSING_MARKER_LEGACY);
}
