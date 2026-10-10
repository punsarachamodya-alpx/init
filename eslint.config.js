import tseslint from 'typescript-eslint';

// Application code reaches the database only through withActor (src/db/withActor.ts): it signs the actor
// token, checks the database accepts it and cleans the connection. The raw pool, token signing, secrets and
// `pg` itself are for src/db, tests and scripts only. Type-only imports are fine.
const RAW_DB = {
  patterns: [
    { group: ['pg', 'pg-pool', 'pg-boss'], allowTypeImports: true, message: 'Use withActor (src/db/withActor.ts), not a database driver or queue client.' },
    { group: ['**/db/pool*'], allowTypeImports: true, message: 'Use withActor (src/db/withActor.ts), not the raw pool.' },
    { group: ['**/db/withCompany*'], allowTypeImports: true, message: 'Use withActor; withCompany/runScoped are bootstrap internals of src/db.' },
    { group: ['**/db/actorToken*'], allowTypeImports: true, message: 'Only src/db may sign actor tokens.' },
    { group: ['**/db/config*'], allowTypeImports: true, message: 'Secrets and connection settings are for src/db only.' },
  ],
};

// No hardcoded user-facing text in the web app: strings live in /locales (en, si, ta) and come through t().
// JSX text with letters and literal text attributes are refused; punctuation, numbers and {expressions} are fine.
const NO_JSX_LITERALS = [
  { selector: 'JSXText[value=/\\p{L}/u]', message: 'Hardcoded text in JSX: add a key to /locales and use tr(...).' },
  { selector: 'JSXAttribute[name.name=/^(title|alt|placeholder|aria-label|label)$/] > Literal[value=/\\p{L}/u]', message: 'Hardcoded text in a JSX attribute: use tr(...).' },
];

const DB_SYNTAX = [
  {
    selector: "ImportExpression[source.value=/\\/db\\/(pool|withCompany|actorToken|config)|^pg(-pool|-boss)?$/]",
    message: 'Do not import the raw database layer dynamically; use withActor.',
  },
  {
    selector: "ExportNamedDeclaration[source.value=/\\/db\\/(pool|withCompany|actorToken|config)|^pg(-pool|-boss)?$/]",
    message: 'Do not re-export the raw database layer.',
  },
];

export default tseslint.config(
  { ignores: ['node_modules', 'dist', 'coverage', '.next', 'test-results', 'playwright-report', 'scripts/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    ignores: ['src/db/**', 'tests/**', 'e2e/**', 'scripts/**', 'eslint.config.js', 'vitest.config.ts', 'playwright.config.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', RAW_DB],
      'no-restricted-syntax': ['error', ...DB_SYNTAX],
    },
  },  {
    files: ['app/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': ['error', ...DB_SYNTAX, ...NO_JSX_LITERALS] },
  },
);
