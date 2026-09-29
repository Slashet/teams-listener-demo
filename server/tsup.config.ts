import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Runtime dependencies are installed in the image; only our own code
  // (including ../shared) is bundled.
  skipNodeModulesBundle: true,
});
