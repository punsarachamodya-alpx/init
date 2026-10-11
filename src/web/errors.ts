import { InvalidContainerNoError } from '../domain/iso6346.ts';
import { ConfirmationError } from '../intake/confirm.ts';
import type { ConfirmationErrorCode } from '../intake/confirm.ts';

/** The codes the UI has a message for (keys `error.<code>` in /locales). Nothing from the database ever reaches the user. */
export type UiErrorCode = ConfirmationErrorCode | 'invalid_container' | 'forbidden' | 'unexpected';

export function uiErrorCode(err: unknown): UiErrorCode {
  if (err instanceof ConfirmationError) return err.code;
  if (err instanceof InvalidContainerNoError) return 'invalid_container';
  const e = err as { code?: unknown; message?: unknown } | null;
  // 42501 = insufficient_privilege (row-level security or a missing grant): the role may not do this.
  if (e && (e.code === '42501' || (typeof e.message === 'string' && /row-level security|permission denied/.test(e.message)))) return 'forbidden';
  return 'unexpected';
}

/** A same-site path only (no scheme, no `//host`), else the fallback. For redirecting back after a form post. */
export function safeReturnTo(value: unknown, fallback = '/'): string {
  return typeof value === 'string' && /^\/(?!\/)[A-Za-z0-9/_\-?=&%.]*$/.test(value) ? value : fallback;
}
