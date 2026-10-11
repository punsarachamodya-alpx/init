// ISO 6346 container number validation: 4 letters (owner code + category), 6 digits,
// 1 check digit. Reference implementation: scripts/check-iso6346.mjs (tests assert parity).

export class InvalidContainerNoError extends Error {
  constructor(public readonly input: unknown) {
    super(`Invalid ISO 6346 container number: ${JSON.stringify(input)}`);
    this.name = 'InvalidContainerNoError';
  }
}

const LETTER_VALUES: Readonly<Record<string, number>> = (() => {
  const values: Record<string, number> = {};
  let v = 10;
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (v % 11 === 0) v++; // letter values skip multiples of 11
    values[ch] = v++;
  }
  return values;
})();

/** Check digit for the first ten characters (4 letters + 6 digits). */
export function checkDigit(first10: string): number {
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = first10[i] ?? '';
    const val = /[A-Z]/.test(ch) ? LETTER_VALUES[ch] : Number(ch);
    sum += (val ?? NaN) * 2 ** i;
  }
  return (sum % 11) % 10;
}

export function normalizeContainerNo(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, '');
}

export function isValidContainerNo(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const s = normalizeContainerNo(raw);
  return /^[A-Z]{4}\d{7}$/.test(s) && checkDigit(s.slice(0, 10)) === Number(s[10]);
}

/** Normalise and validate; throws InvalidContainerNoError. Use before saving any container number. */
export function parseContainerNo(raw: unknown): string {
  if (!isValidContainerNo(raw)) throw new InvalidContainerNoError(raw);
  return normalizeContainerNo(raw as string);
}
