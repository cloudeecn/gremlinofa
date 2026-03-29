import * as esbuild from 'esbuild';
import { copyFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const distDir = 'dist';

// Ensure dist directory exists
if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

// Build the main bundle
await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: join(distDir, 'index.js'),
  sourcemap: true,
  // Express uses depd which has dynamic require() calls that don't work in ESM bundles
  external: ['express', 'dotenv'],
  banner: {
    js: '// GremlinOFA CORS Proxy - Bundled with esbuild\n',
  },
});

// Create minimal package.json for dist with only runtime dependencies
const distPackageJson = {
  name: '@gremlinofa/cors-proxy',
  version: '1.0.0',
  type: 'module',
  main: 'index.js',
  license: 'Apache-2.0',
  scripts: {
    start: 'node index.js',
  },
  dependencies: {
    dotenv: '^16.4.7',
    express: '^4.21.2',
  },
  engines: {
    node: '>=18',
  },
};

writeFileSync(join(distDir, 'package.json'), JSON.stringify(distPackageJson, null, 2) + '\n');

// Copy .env.example to dist
copyFileSync('.env.example', join(distDir, '.env.example'));

// Copy service files to dist
copyFileSync('gremlinofa-cors-proxy.service', join(distDir, 'gremlinofa-cors-proxy.service'));
copyFileSync('gremlinofa-cors-proxy.initd', join(distDir, 'gremlinofa-cors-proxy.initd'));

console.log('Build complete:');
console.log('  dist/index.js          - Main application bundle');
console.log('  dist/index.js.map      - Source map');
console.log('  dist/package.json      - Runtime dependencies');
console.log('  dist/.env.example      - Configuration template');
console.log('  dist/gremlinofa-cors-proxy.service  - systemd service');
console.log('  dist/gremlinofa-cors-proxy.initd    - Alpine OpenRC init');
