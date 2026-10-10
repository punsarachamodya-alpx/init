import tseslint from 'typescript-eslint';

// Application code reaches the database only through withActor (src/db/withActor.ts): it signs the actor
// token, checks the database accepts it and cleans the connection. The raw pool, token signing, secrets and
// `pg` itself are for src/db, tests and scripts only. Type-only imports are fine.
const RAW_DB = {
  patterns: [
    { group: ['pg'], allowTypeImports: true, message: 'Use withActor (src/db/withActor.ts), not the pg driver.' },
    { group: ['**/db/pool*'], allowTypeImports: true, message: 'Use withActor (src/db/withActor.ts), not the raw pool.' },
    { group: ['**/db/withCompany*'], allowTypeImports: true, message: 'Use withActor; withCompany/runScoped are bootstrap internals of src/db.' },
    { group: ['**/db/actorToken*'], allowTypeImports: true, message: 'Only src/db may sign actor tokens.' },
    { group: ['**/db/config*'], allowTypeImports: true, message: 'Secrets and connection settings are for src/db only.' },
  ],
};

export default tseslint.config(
  { ignores: ['node_modules', 'dist', 'coverage', '.next', 'scripts/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    ignores: ['src/db/**', 'tests/**', 'scripts/**', 'eslint.config.js', 'vitest.config.ts', 'playwright.config.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', RAW_DB],
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportExpression[source.value=/\\/db\\/(pool|withCompany|actorToken|config)|^pg$/]",
          message: 'Do not import the raw database layer dynamically; use withActor.',
        },
        {
          selector: "ExportNamedDeclaration[source.value=/\\/db\\/(pool|withCompany|actorToken|config)|^pg$/]",
          message: 'Do not re-export the raw database layer.',
        },
      ],
    },
  },
);
