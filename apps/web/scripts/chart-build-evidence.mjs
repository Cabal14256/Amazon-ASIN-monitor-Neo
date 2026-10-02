import assert from 'node:assert/strict';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const chunks = (result) =>
  (Array.isArray(result) ? result : [result])
    .flatMap((item) => item.output)
    .filter((item) => item.type === 'chunk');
const isEngine = (id) =>
  /\/(?:echarts|zrender)\//.test(id.replaceAll('\\', '/'));
// Inspect actual Rollup module graphs, rather than minified identifier strings.
const production = chunks(
  await build({
    root: webRoot,
    configFile: join(webRoot, 'vite.config.ts'),
    logLevel: 'silent',
    build: { write: false },
  }),
);
assert.equal(
  production.some((chunk) => Object.keys(chunk.modules).some(isEngine)),
  false,
  'DEV specimens or ECharts leaked into production',
);

const temp = await mkdtemp(join(tmpdir(), 'neo-chart-build-'));
const entry = join(temp, 'entry.js');
try {
  await writeFile(
    entry,
    `export { NeoChart } from ${JSON.stringify(
      join(webRoot, 'src/components/charts/neo-chart.tsx').replaceAll(
        '\\',
        '/',
      ),
    )};\n`,
  );
  const consumer = chunks(
    await build({
      root: webRoot,
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        lib: { entry, formats: ['es'], fileName: 'neo-chart-probe' },
        rollupOptions: { external: ['react', 'react/jsx-runtime'] },
      },
    }),
  );
  const byName = new Map(consumer.map((chunk) => [chunk.fileName, chunk]));
  const staticChunks = new Set();
  const visit = (chunk) => {
    if (staticChunks.has(chunk.fileName)) return;
    staticChunks.add(chunk.fileName);
    chunk.imports.forEach((name) => {
      if (byName.has(name)) visit(byName.get(name));
    });
  };
  consumer.filter((chunk) => chunk.isEntry).forEach(visit);
  const engineChunks = consumer.filter((chunk) =>
    Object.keys(chunk.modules).some(isEngine),
  );
  assert.ok(
    engineChunks.length > 0,
    'Consumer probe failed to retain the actual chart engine',
  );
  assert.equal(
    engineChunks.some((chunk) => staticChunks.has(chunk.fileName)),
    false,
    'ECharts became an eager consumer dependency',
  );
  assert.ok(
    consumer.some((chunk) => chunk.dynamicImports.length > 0),
    'Missing dynamic chart import',
  );
  const evidence = {
    production: { chunks: production.length, echartsModules: 0 },
    consumer: consumer.map((chunk) => ({
      file: chunk.fileName,
      entry: chunk.isEntry,
      dynamic: chunk.isDynamicEntry,
      bytes: Buffer.byteLength(chunk.code),
      gzipBytes: gzipSync(chunk.code).length,
      imports: chunk.imports,
      dynamicImports: chunk.dynamicImports,
      engineModules: Object.keys(chunk.modules).filter(isEngine).length,
    })),
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  await unlink(entry);
  await rmdir(temp);
}
