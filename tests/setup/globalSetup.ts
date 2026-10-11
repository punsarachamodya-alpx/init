import { rebuildDatabase } from './rebuild.ts';

/** Rebuild a fresh test database and migrate it as the owner role. */
export default async function setup(): Promise<void> {
  await rebuildDatabase('colombo_test');
}
