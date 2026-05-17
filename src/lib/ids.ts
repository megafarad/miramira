import { v7 as uuidV7 } from 'uuid';

export function newId(): string {
  return uuidV7();
}
