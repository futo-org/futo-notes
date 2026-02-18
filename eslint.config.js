import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      'dist/*',
      'node_modules/*',
      'apps/mobile/android/*',
      'apps/mobile/ios/*',
      'apps/desktop/dist-electron/*',
      'apps/desktop/release/*',
      'apps/server/dist/*',
    ],
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
