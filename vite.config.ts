import { resolve } from 'node:path';
import { defineConfig } from 'vite-plus';
import react from '@vitejs/plugin-react';

// Target browser is passed via the BROWSER env variable.
// Defaults to 'chromium' so plain `vite build` still works during development.
const browser = (process.env.BROWSER ?? 'chromium') as 'chromium' | 'firefox';
const autoInput = { auto: true } as const;
const viteTempInput = { pattern: 'node_modules/.vite-temp/**', base: 'workspace' as const };
const extensionRoot = resolve(__dirname, 'apps/extension');
const chromiumOutput = { pattern: 'extension/chromium/**', base: 'workspace' as const };
const firefoxOutput = { pattern: 'extension/firefox/**', base: 'workspace' as const };
const chromiumPackageOutput = {
  pattern: 'extension/chromium/gramgrab.crx',
  base: 'workspace' as const,
};
const firefoxPackageOutput = {
  pattern: 'extension/firefox/gramgrab.xpi',
  base: 'workspace' as const,
};

export default defineConfig({
  pack: {
    entry: {
      gramgrab: 'apps/cli/src/index.ts',
      'gramgrab-native-host': 'apps/native-host/src/index.ts',
    },
    outDir: 'artifacts',
    clean: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    banner: '#!/usr/bin/env node',
    deps: {
      alwaysBundle: ['effect'],
      onlyBundle: ['effect'],
    },
  },
  run: {
    cache: {
      scripts: false, // Keep caching on explicit tasks so inputs/outputs stay well-defined.
      tasks: false, // Build outputs are loaded directly by browsers; stale task cache is too risky.
    },
    tasks: {
      'build-chromium': {
        command: [
          'BROWSER=chromium vp build',
          'BROWSER=chromium node apps/extension/scripts/postbuild.mjs',
        ],
        input: [autoInput, `!${viteTempInput.pattern}`, `!${chromiumOutput.pattern}`],
        output: [chromiumOutput],
      },
      'build-firefox': {
        command: [
          'BROWSER=firefox vp build',
          'BROWSER=firefox node apps/extension/scripts/postbuild.mjs',
        ],
        input: [autoInput, `!${viteTempInput.pattern}`, `!${firefoxOutput.pattern}`],
        output: [firefoxOutput],
      },
      'build-all': {
        command: ['vp run build-chromium', 'vp run build-firefox'],
      },
      'package-chromium': {
        command: ['vp run build-chromium', 'node apps/extension/scripts/package-chromium.mjs'],
        input: [autoInput, `!${viteTempInput.pattern}`, `!${chromiumOutput.pattern}`],
        output: [chromiumOutput, chromiumPackageOutput],
      },
      'package-firefox': {
        command: ['vp run build-firefox', 'node apps/extension/scripts/package-firefox.mjs'],
        input: [autoInput, `!${viteTempInput.pattern}`, `!${firefoxOutput.pattern}`],
        output: [firefoxOutput, firefoxPackageOutput],
      },
      'package-tools': {
        command: ['vp pack', 'node apps/native-host/scripts/package-tools.mjs'],
        input: [
          'apps/cli/src/**',
          'apps/cli/bin/gramgrab.cmd',
          'apps/native-host/bin/gramgrab-native-host.cmd',
          'apps/native-host/src/**',
          'apps/native-host/manifests/**',
          'apps/native-host/scripts/package-tools.mjs',
          'apps/native-host/scripts/verify-tools.mjs',
          'packages/protocol/src/**',
          'package.json',
          'pnpm-lock.yaml',
          'tsconfig.json',
          'vite.config.ts',
        ],
        output: [{ pattern: 'artifacts/**', base: 'workspace' }],
      },
    },
  },
  lint: {
    plugins: ['oxc', 'typescript', 'unicorn', 'react'],
    categories: {
      correctness: 'warn',
    },
    env: {
      builtin: true,
    },
    ignorePatterns: ['dist', 'node_modules', '.husky', 'extension/**', '.repos'],
    rules: {
      'constructor-super': 'error',
      'for-direction': 'error',
      'getter-return': 'error',
      'no-async-promise-executor': 'error',
      'no-case-declarations': 'error',
      'no-class-assign': 'error',
      'no-compare-neg-zero': 'error',
      'no-cond-assign': 'error',
      'no-const-assign': 'error',
      'no-constant-binary-expression': 'error',
      'no-constant-condition': 'error',
      'no-control-regex': 'error',
      'no-debugger': 'error',
      'no-delete-var': 'error',
      'no-dupe-class-members': 'error',
      'no-dupe-else-if': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-empty': 'error',
      'no-empty-character-class': 'error',
      'no-empty-pattern': 'error',
      'no-empty-static-block': 'error',
      'no-ex-assign': 'error',
      'no-extra-boolean-cast': 'error',
      'no-fallthrough': 'error',
      'no-func-assign': 'error',
      'no-global-assign': 'error',
      'no-import-assign': 'error',
      'no-invalid-regexp': 'error',
      'no-irregular-whitespace': 'error',
      'no-loss-of-precision': 'error',
      'no-misleading-character-class': 'error',
      'no-new-native-nonconstructor': 'error',
      'no-nonoctal-decimal-escape': 'error',
      'no-obj-calls': 'error',
      'no-prototype-builtins': 'error',
      'no-redeclare': 'error',
      'no-regex-spaces': 'error',
      'no-self-assign': 'error',
      'no-setter-return': 'error',
      'no-shadow-restricted-names': 'error',
      'no-sparse-arrays': 'error',
      'no-this-before-super': 'error',
      'no-unassigned-vars': 'error',
      'no-undef': 'error',
      'no-unexpected-multiline': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-unused-labels': 'error',
      'no-unused-private-class-members': 'error',
      'no-unused-vars': 'error',
      'no-useless-assignment': 'error',
      'no-useless-backreference': 'error',
      'no-useless-catch': 'error',
      'no-useless-escape': 'error',
      'no-with': 'error',
      'preserve-caught-error': 'error',
      'require-yield': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-array-constructor': 'error',
      'no-unused-expressions': 'error',
      'typescript/ban-ts-comment': 'error',
      'typescript/no-duplicate-enum-values': 'error',
      'typescript/no-empty-object-type': 'error',
      'typescript/no-explicit-any': 'error',
      'typescript/no-extra-non-null-assertion': 'error',
      'typescript/no-misused-new': 'error',
      'typescript/no-namespace': 'error',
      'typescript/no-non-null-asserted-optional-chain': 'error',
      'typescript/no-require-imports': 'error',
      'typescript/no-this-alias': 'error',
      'typescript/no-unnecessary-type-constraint': 'error',
      'typescript/no-unsafe-declaration-merging': 'error',
      'typescript/no-unsafe-function-type': 'error',
      'typescript/no-wrapper-object-types': 'error',
      'typescript/prefer-as-const': 'error',
      'typescript/prefer-namespace-keyword': 'error',
      'typescript/triple-slash-reference': 'error',
      'vite-plus/prefer-vite-plus-imports': 'error',
    },
    overrides: [
      {
        files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
        rules: {
          'constructor-super': 'off',
          'getter-return': 'off',
          'no-class-assign': 'off',
          'no-const-assign': 'off',
          'no-dupe-class-members': 'off',
          'no-dupe-keys': 'off',
          'no-func-assign': 'off',
          'no-import-assign': 'off',
          'no-new-native-nonconstructor': 'off',
          'no-obj-calls': 'off',
          'no-redeclare': 'off',
          'no-setter-return': 'off',
          'no-this-before-super': 'off',
          'no-undef': 'off',
          'no-unreachable': 'off',
          'no-unsafe-negation': 'off',
          'no-var': 'error',
          'no-with': 'off',
          'prefer-const': 'error',
          'prefer-rest-params': 'error',
          'prefer-spread': 'error',
        },
      },
      {
        files: ['**/*.{ts,tsx}'],
        rules: {
          'no-console': [
            'warn',
            {
              allow: ['warn', 'error'],
            },
          ],
          'no-unused-vars': [
            'error',
            {
              argsIgnorePattern: '^_',
            },
          ],
        },
        env: {
          browser: true,
        },
      },
      {
        files: ['**/*.js', '**/*.mjs'],
        env: {
          node: true,
        },
      },
      {
        files: ['apps/extension/scripts/capture-ig-fixtures.mjs'],
        env: {
          browser: true,
        },
      },
    ],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [
      {
        name: 'vite-plus',
        specifier: 'vite-plus/oxlint-plugin',
      },
    ],
  },
  staged: {
    '{,!(.repos)/**/}*.{ts,tsx,js,mjs}': ['vp lint --fix', 'vp fmt'],
  },
  fmt: {
    singleQuote: true,
    trailingComma: 'es5',
    tabWidth: 2,
    semi: true,
    printWidth: 100,
    bracketSpacing: true,
    arrowParens: 'avoid',
    endOfLine: 'lf',
    sortPackageJson: false,
    ignorePatterns: ['extension/**', '.repos', '.agents', '.claude'],
  },
  plugins: [react()],
  root: resolve(extensionRoot, 'templates'),
  build: {
    outDir: resolve(__dirname, `extension/${browser}`),
    emptyOutDir: true,
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: resolve(extensionRoot, 'templates/popup.html'),
        runner: resolve(extensionRoot, 'templates/runner.html'),
        // background.ts is bundled directly as a JS module entry — no HTML
        // wrapper needed. Both Chromium (service_worker) and Firefox (scripts)
        // reference js/background.js in their respective manifests.
        background: resolve(extensionRoot, 'src/background.ts'),
      },
      output: {
        entryFileNames: 'js/[name].js',
        chunkFileNames: 'js/[name].js',
        assetFileNames: '[ext]/[name].[ext]',
        manualChunks(id) {
          if (id.includes('/src/lib/')) return 'js/bundle';
          return undefined;
        },
      },
      onwarn(warning, warn) {
        if (warning.code === 'CIRCULAR_DEPENDENCY') return;
        warn(warning);
      },
    },
  },
});
