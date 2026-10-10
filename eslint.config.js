import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'dist', 'coverage', '.next', 'scripts/**'] },
  ...tseslint.configs.recommended,
);
