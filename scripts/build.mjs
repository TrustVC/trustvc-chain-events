import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Banner for __filename/__dirname CJS shims — does NOT import fileURLToPath or
// dirname from node builtins to avoid duplicate-identifier collisions when the
// bundled code also imports those same names.
const banner = {
  js: [
    "import { createRequire } from 'node:module';",
    "const require = createRequire(import.meta.url);",
    "const __filename = new URL(import.meta.url).pathname;",
    "const __dirname = __filename.substring(0, __filename.lastIndexOf('/'));",
  ].join('\n'),
};

// pino must be external so @opentelemetry/instrumentation-pino can hook it at runtime.
// @opentelemetry/* must be external so the global SDK registry set up by
// instrumentation.js (loaded via --import) is shared with the main bundle.
const sharedExternal = ['pino-pretty', 'pino', '@opentelemetry/*'];

const sharedConfig = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: sharedExternal,
  banner,
};

await Promise.all([
  // OTel bootstrap — loaded via --import before the main entry point.
  build({
    ...sharedConfig,
    entryPoints: [join(__dirname, '../src/telemetry/instrumentation.ts')],
    outfile: join(__dirname, '../dist/telemetry/instrumentation.js'),
  }),
  // Main entry point
  build({
    ...sharedConfig,
    entryPoints: [join(__dirname, '../src/index.ts')],
    outfile: join(__dirname, '../dist/index.js'),
  }),
  // Chain worker — must be a separate file so child_process.fork() can load it
  build({
    ...sharedConfig,
    entryPoints: [join(__dirname, '../src/workers/chain-worker.ts')],
    outfile: join(__dirname, '../dist/workers/chain-worker.js'),
  }),
]);

console.log('Build complete');
