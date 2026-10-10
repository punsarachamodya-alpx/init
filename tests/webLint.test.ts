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
    ['a literal title', wrap('<span title="Age">x</span>')],
    ['a literal aria-label', wrap('<button aria-label="Close">x</button>')],
  ])('refused: %s', async (_name, code) => {
    expect((await lint('app/example.tsx', code)).length).toBeGreaterThan(0);
  });

  test.each([
    ['text through the translator', wrap("<p>{tr('board.title')}</p>")],
    ['punctuation and numbers', wrap('<p>· 12 — ({1})</p>')],
    ['an expression attribute', wrap("<input placeholder={tr('manual.reason')} />")],
    ['a non-text attribute', wrap('<input type="text" name="x" data-testid="y" />')],
  ])('allowed: %s', async (_name, code) => {
    expect(await lint('app/example.tsx', code)).toHaveLength(0);
  });

  test('the database-import rules still apply in app/ (the two rule sets are merged, not replaced)', async () => {
    expect((await lint('app/example.tsx', "const m = await import('../src/db/pool.ts');\nvoid m;\n")).length).toBeGreaterThan(0);
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
