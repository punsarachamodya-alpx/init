import { describe, expect, test } from 'vitest';
import { checkDigit as referenceCheckDigit, isValidContainerNo as referenceIsValid } from '../scripts/check-iso6346.mjs';
import {
  InvalidContainerNoError,
  checkDigit,
  isValidContainerNo,
  normalizeContainerNo,
  parseContainerNo,
} from '../src/domain/iso6346.ts';

const VALID = ['ZZZU1234564', 'ZZZU2345670', 'ZZZU3456787']; // synthetic fixtures

describe('ISO 6346 validation', () => {
  test.each(VALID)('%s is valid', (no) => {
    expect(isValidContainerNo(no)).toBe(true);
    expect(parseContainerNo(no)).toBe(no);
  });

  test('wrong check digit is rejected (message fixture ZZZU9999999)', () => {
    expect(isValidContainerNo('ZZZU9999999')).toBe(false);
    expect(() => parseContainerNo('ZZZU9999999')).toThrow(InvalidContainerNoError);
  });

  test.each(['ZZZU123456', 'ZZZU12345645', 'ZZZ1234564', '1234ZZZU564', '', 'ZZZUABCDEFG', 'ZZZT1234564'])(
    'malformed or bad-digit value %j is rejected',
    (no) => {
      expect(isValidContainerNo(no)).toBe(false);
      expect(() => parseContainerNo(no)).toThrow(InvalidContainerNoError);
    },
  );

  test('input is normalised: case, spaces and hyphens', () => {
    expect(normalizeContainerNo(' zzzu 123456-4 ')).toBe('ZZZU1234564');
    expect(parseContainerNo('zzzu 123456-4')).toBe('ZZZU1234564');
  });

  test('non-string input is rejected, not coerced', () => {
    expect(isValidContainerNo(undefined as unknown as string)).toBe(false);
    expect(isValidContainerNo(1234567890 as unknown as string)).toBe(false);
  });

  test('matches the reference script over generated prefixes', () => {
    let seed = 42;
    const next = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32);
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (let i = 0; i < 2000; i++) {
      let prefix = '';
      for (let j = 0; j < 4; j++) prefix += letters[next() % 26];
      for (let j = 0; j < 6; j++) prefix += String(next() % 10);
      expect(checkDigit(prefix)).toBe(referenceCheckDigit(prefix));
      const full = `${prefix}${checkDigit(prefix)}`;
      expect(isValidContainerNo(full)).toBe(referenceIsValid(full));
      expect(isValidContainerNo(full)).toBe(true);
      const bad = `${prefix}${(checkDigit(prefix) + 1) % 10}`;
      expect(isValidContainerNo(bad)).toBe(referenceIsValid(bad));
      expect(isValidContainerNo(bad)).toBe(false);
    }
  });
});
