import en from '../../locales/en.json' with { type: 'json' };
import si from '../../locales/si.json' with { type: 'json' };
import ta from '../../locales/ta.json' with { type: 'json' };

export const LOCALES = ['en', 'si', 'ta'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

/** Every key in /locales/en.json; the other locales must carry exactly the same keys (checked at compile time and by a test). */
export type MessageKey = keyof typeof en;

// Assigning si/ta to the English shape makes a missing key a type error.
const MESSAGES: Record<Locale, Record<MessageKey, string>> = { en, si, ta };

export const isLocale = (v: unknown): v is Locale => typeof v === 'string' && (LOCALES as readonly string[]).includes(v);

/** Translate a key, filling `{name}` placeholders. A missing variable is a bug, so it throws rather than printing `{name}`. */
export function t(locale: Locale, key: MessageKey, vars: Record<string, string | number> = {}): string {
  return MESSAGES[locale][key].replace(/\{(\w+)\}/g, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`missing variable "${name}" for message ${key}`);
    return String(v);
  });
}

/** The raw message tables, for tests and tooling. */
export const messages: Readonly<Record<Locale, Readonly<Record<string, string>>>> = MESSAGES;
