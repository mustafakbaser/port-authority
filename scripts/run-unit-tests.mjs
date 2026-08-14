/**
 * Runs the unit tests.
 *
 * A script rather than `node --test <glob>` because neither argument form is portable:
 * a quoted glob needs Node 22's CLI glob support, an unquoted one needs a POSIX shell
 * (so it breaks on Windows CI), and passing the directory is rejected outright. Building
 * the file list here works on every supported Node version and on all three platforms.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

const directory = join('out', 'test', 'unit');
const files = readdirSync(directory)
  .filter((name) => name.endsWith('.test.js'))
  .map((name) => join(directory, name))
  .sort();

if (files.length === 0) {
  console.error(`No compiled unit tests found in ${directory}. Did the build run?`);
  process.exit(1);
}

const stream = run({ files, concurrency: true });
stream.on('test:fail', () => {
  process.exitCode = 1;
});
stream.compose(new spec()).pipe(process.stdout);
