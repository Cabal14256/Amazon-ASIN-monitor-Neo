import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const isEngine = (id) =>
  /\/(?:echarts|zrender)\//.test(id.replaceAll('\\', '/'));
// Inspect the real production consumer's Rollup graph, not a synthetic entry.
const result = await build({
  root: webRoot,
  configFile: join(webRoot, 'vite.config.ts'),
  logLevel: 'silent',
  build: { write: false },
});
const chunks = (Array.isArray(result) ? result : [result])
  .flatMap((item) => item.output)
  .filter((item) => item.type === 'chunk');
const modules = (chunk) => Object.keys(chunk.modules);
assert.equal(
  chunks.some((chunk) =>
    modules(chunk).some((id) =>
      id.replaceAll('\\', '/').endsWith('/pages/dev/chart-preview.tsx'),
    ),
  ),
  false,
  'DEV specimens leaked into production',
);
const homeChunks = chunks.filter((chunk) =>
  modules(chunk).some((id) =>
    id.replaceAll('\\', '/').endsWith('/pages/home/country-status-chart.tsx'),
  ),
);
assert.ok(
  homeChunks.length > 0,
  'The real Home consumer is missing from production',
);
const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
const staticChunks = new Set();
const visit = (chunk) => {
  if (staticChunks.has(chunk.fileName)) return;
  staticChunks.add(chunk.fileName);
  chunk.imports.forEach((name) => {
    if (byName.has(name)) visit(byName.get(name));
  });
};
chunks.filter((chunk) => chunk.isEntry).forEach(visit);
// Home is itself a lazy route: checking bootstrap alone could miss an engine
// imported eagerly by that route before a drawable response exists.
homeChunks.forEach(visit);
const engineChunks = chunks.filter((chunk) => modules(chunk).some(isEngine));
assert.ok(
  engineChunks.length > 0,
  'The production Home chart engine is missing',
);
assert.equal(
  engineChunks.some((chunk) => staticChunks.has(chunk.fileName)),
  false,
  'ECharts became an eager bootstrap or Home dependency',
);
assert.ok(
  chunks.some((chunk) =>
    chunk.dynamicImports.some((name) =>
      engineChunks.some((engine) => engine.fileName === name),
    ),
  ),
  'Missing dynamic chart engine import',
);
const evidence = {
  production: {
    chunks: chunks.length,
    homeConsumerChunks: homeChunks.map((chunk) => chunk.fileName),
    echartsModules: engineChunks.reduce(
      (sum, chunk) => sum + modules(chunk).filter(isEngine).length,
      0,
    ),
    eagerEchartsModules: 0,
  },
  chunks: chunks
    .filter(
      (chunk) =>
        chunk.isEntry ||
        homeChunks.includes(chunk) ||
        engineChunks.includes(chunk),
    )
    .map((chunk) => ({
      file: chunk.fileName,
      entry: chunk.isEntry,
      dynamic: chunk.isDynamicEntry,
      bytes: Buffer.byteLength(chunk.code),
      gzipBytes: gzipSync(chunk.code).length,
      imports: chunk.imports,
      dynamicImports: chunk.dynamicImports,
      engineModules: modules(chunk).filter(isEngine).length,
    })),
};
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
