import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'dist', 'coverage', '.next', 'scripts/**'] },
  ...tseslint.configs.recommended,
  {
    // Application code reaches the database only through withActor / withCompany (src/db), which set the
    // signed actor context and clean the connection. Raw pool access is for src/db and tests.
    files: ['src/**/*.ts'],
    ignores: ['src/db/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportSpecifier[imported.name='getAppPool']",
          message: 'Do not use the raw application pool here: use withActor (src/db/withActor.ts).',
        },
      ],
    },
  },
);
