import { defineConfig, type Plugin } from 'vitest/config';

// Vite strips 'node:' prefix before checking builtinModules.
// module.isBuiltin('sqlite') === false even though node:sqlite is a valid built-in.
// This plugin intercepts the failing load and provides a CJS bridge.
const nodeSqliteBridge: Plugin = {
  name: 'node-sqlite-bridge',
  enforce: 'pre',
  load(id) {
    if (id === 'node:sqlite' || id === 'sqlite') {
      return `module.exports = require('node:sqlite');`;
    }
  },
};

export default defineConfig({
  plugins: [nodeSqliteBridge],
  test: {
    globals: false,
    include: ['tests/**/*.test.ts'],
  },
});
