import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimePackages, imRuntimePackages } from './runtime-externals.mjs';
import { readCindyBuildVersion, readCindyBuildRegion } from './build-version.mjs';
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await build({ entryPoints: [path.join(app, 'src/lite-resident.ts'), path.join(app, 'src/lite-executor.ts')],
  outdir: path.join(app, 'dist'), splitting: true, chunkNames: 'lite-chunk-[hash]',
  platform: 'node', target: 'node22', format: 'esm', bundle: true, sourcemap: true,
  define: { __CINDY_APP_VERSION__: JSON.stringify(readCindyBuildVersion()), __CINDY_APP_REGION__: JSON.stringify(readCindyBuildRegion()) },
  loader: { '.md': 'text' }, external: [...runtimePackages, ...imRuntimePackages, 'react/jsx-runtime'],
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
