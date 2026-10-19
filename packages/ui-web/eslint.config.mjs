import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import jsxA11yPlugin from 'eslint-plugin-jsx-a11y';

export default [
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      'jsx-a11y': jsxA11yPlugin,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      // 用 TS 感知的版本而不是 base 规则：base `no-unused-vars` 不理解类型签名，会把
      // `(href: string, event: MouseEvent) => void` 里的形参名报成未使用变量。共享 UI 大量使用
      // 「回调类型」表达注入契约（NavigateHandler 就是其中之一），因此这条替换是必需的而非可选的。
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // VIS-A11Y-001：a11y 推荐规则集整体先行 warn——与 Next 侧 eslint-config-next
      // 内置的 jsx-a11y 口径对齐，存量命中随接触收口后再逐级收紧。
      ...Object.fromEntries(
        Object.entries(jsxA11yPlugin.flatConfigs.recommended.rules).map(([rule, setting]) => [rule, setting === 'off' ? 'off' : 'warn']),
      ),
    },
  },
];