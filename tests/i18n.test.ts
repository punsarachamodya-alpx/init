import { describe, expect, test } from 'vitest';
import { EVENT_TYPES } from '../src/domain/statusChain.ts';
import { LOCALES, messages, t } from '../src/i18n/index.ts';

describe('locales', () => {
  test('en, si and ta carry exactly the same keys', () => {
    const en = Object.keys(messages.en).sort();
    for (const l of LOCALES) expect(Object.keys(messages[l]).sort(), l).toEqual(en);
  });

  test('no message is empty, and the same placeholders appear in every language', () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, text] of Object.entries(messages.en)) {
      for (const l of LOCALES) {
        const m = messages[l][key]!;
        expect(m.trim().length, `${l} ${key}`).toBeGreaterThan(0);
        expect(vars(m), `${l} ${key}`).toEqual(vars(text));
      }
    }
  });

  test('every status of the chain has a label in every language, and Sinhala and Tamil differ from English', () => {
    for (const type of EVENT_TYPES) {
      for (const l of LOCALES) expect(t(l, `status.${type}`).length).toBeGreaterThan(0);
      expect(t('si', `status.${type}`)).not.toBe(t('en', `status.${type}`));
      expect(t('ta', `status.${type}`)).not.toBe(t('en', `status.${type}`));
    }
  });

  test('a missing variable is an error, not a visible {placeholder}', () => {
    expect(() => t('en', 'notify.haulier_assigned.text', {})).toThrow(/missing variable "container"/);
    expect(t('en', 'notify.haulier_assigned.text', { container: 'ZZZU1234564' })).toContain('ZZZU1234564');
  });
});
