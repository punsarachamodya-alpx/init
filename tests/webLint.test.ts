import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, test } from 'vitest';
import { messages } from '../src/i18n/index.ts';

const root = path.resolve(import.meta.dirname, '..');

async function lint(filePath: string, code: string) {
  const [res] = await new ESLint({ cwd: root }).lintText(code, { filePath: path.join(root, filePath) });
  return res!.messages.filter((m) => m.ruleId === 'no-restricted-syntax');
}

describe('no hardcoded user-facing text in the web app (lint)', () => {
  const wrap = (inner: string) => `export const X = () => (<div>${inner}</div>);\n`;

  test.each([
    ['plain text in an element', wrap('<p>Hello</p>')],
    ['text next to an expression', wrap('<p>Total: {1}</p>')],
    ['Sinhala text', wrap('<p>ආයුබෝවන්</p>')],
    ['a literal placeholder', wrap('<input placeholder="Container number" />')],
    ['a literal title', wrap('<span title="Age" />')],
    ['a literal aria-label', wrap('<button aria-label="Close" />')],
    ['a string literal in braces', wrap("<p>{'Hello'}</p>")],
    ['a template literal with words', wrap('<p>{`Hello ${1}`}</p>')],
    ['a literal aria-description', wrap('<button aria-description="Closes the panel" />')],
    ['a literal after &&', wrap("<p>{1 > 0 && 'Shown'}</p>")],
    ['a conditional with a literal', wrap("<p>{1 > 0 ? 'Yes' : tr('bool.false')}</p>")],
  ])('refused: %s', async (_name, code) => {
    expect((await lint('app/example.tsx', code)).length).toBeGreaterThan(0);
  });

  test.each([
    ['text through the translator', wrap("<p>{tr('board.title')}</p>")],
    ['punctuation and numbers', wrap('<p>· 12 — ({1})</p>')],
    ['an expression attribute', wrap("<input placeholder={tr('manual.reason')} />")],
    ['a literal that is only punctuation or a number', wrap("<p>{' · '}{'12'}</p>")],
    ['a non-text attribute', wrap('<input type="text" name="x" data-testid="y" />')],
  ])('allowed: %s', async (_name, code) => {
    expect(await lint('app/example.tsx', code)).toHaveLength(0);
  });

  test('the database-import rules still apply in app/ (the two rule sets are merged, not replaced)', async () => {
    expect((await lint('app/example.tsx', "const m = await import('../src/db/pool.ts');\nvoid m;\n")).length).toBeGreaterThan(0);
  });
});

describe('only src/intake/confirm.ts writes the ledger from intake, so the layers around it may not reach the ledger (lint)', () => {
  const lintImports = async (filePath: string, code: string) => {
    const [res] = await new ESLint({ cwd: root }).lintText(code, { filePath: path.join(root, filePath) });
    return res!.messages.filter((m) => m.ruleId === '@typescript-eslint/no-restricted-imports');
  };
  const WRITES = [
    ['appendEvent', "import { appendEvent } from '../../src/ledger/ledger.ts';\nvoid appendEvent;\n"],
    ['voidEvent', "import { voidEvent } from '../ledger/ledger.ts';\nvoid voidEvent;\n"],
    ['createContainer', "import * as l from '../ledger/ledger.ts';\nvoid l;\n"],
  ] as const;

  test.each(['app/example.tsx', 'src/web/example.ts', 'src/board/example.ts', 'src/notify/example.ts'])('%s cannot import the ledger writers', async (file) => {
    for (const [, code] of WRITES) expect((await lintImports(file, code)).length).toBeGreaterThan(0);
  });

  test('types from the ledger are fine, and src/intake and src/ledger themselves are unaffected', async () => {
    const typeOnly = "import type { LedgerEvent } from '../ledger/ledger.ts';\nexport type X = LedgerEvent;\n";
    expect(await lintImports('src/notify/example.ts', typeOnly)).toHaveLength(0);
    expect(await lintImports('app/example.tsx', typeOnly.replace('../ledger', '../../src/ledger'))).toHaveLength(0);
    expect(await lintImports('src/intake/example.ts', WRITES[0][1])).toHaveLength(0);
  });

  test('confirmSuggestion (which trusts a caller-supplied suggestion) is not for the web app: use confirmSuggestionById', async () => {
    const bad = "import { confirmSuggestion } from '../../src/intake/index.ts';\nvoid confirmSuggestion;\n";
    const good = "import { confirmSuggestionById } from '../../src/intake/index.ts';\nvoid confirmSuggestionById;\n";
    expect((await lintImports('app/example.tsx', bad)).length).toBeGreaterThan(0);
    expect(await lintImports('app/example.tsx', good)).toHaveLength(0);
  });
});

describe('the locale files', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = path.join(dir, f);
      if (f === 'node_modules' || f === '.next') return [];
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
    });
  const source = [...walk(path.join(root, 'app')), ...walk(path.join(root, 'src'))].map((f) => readFileSync(f, 'utf8')).join('\n');

  test('every key is used somewhere (literally, or through a `prefix.${...}` template)', () => {
    const unused = Object.keys(messages.en).filter((key) => {
      if (source.includes(`'${key}'`) || source.includes(`"${key}"`)) return false;
      const prefixes = [...key.matchAll(/[._]/g)].map((m) => key.slice(0, m.index! + 1));
      return !prefixes.some((p) => source.includes(`\`${p}\${`));
    });
    expect(unused).toEqual([]);
  });
});
