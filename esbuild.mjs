import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Reports build problems in the format VS Code's problem matcher understands. */
const problemReporter = {
  name: 'problem-reporter',
  setup(build) {
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      }
      console.log(`[${new Date().toISOString()}] build finished with ${result.errors.length} error(s)`);
    });
  },
};

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  // Matches the Electron/Node version shipped with the `engines.vscode` floor.
  target: 'node20',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  treeShaking: true,
  logLevel: 'silent',
  plugins: [problemReporter],
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}
