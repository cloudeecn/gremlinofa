import * as esbuild from 'esbuild';
import { copyFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const distDir = 'dist';

if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: join(distDir, 'index.js'),
  sourcemap: true,
  external: ['express', 'dotenv'],
  banner: {
    js: '// GremlinOFA VFS Backend - Bundled with esbuild\n',
  },
});

const distPackageJson = {
  name: '@gremlinofa/vfs-backend',
  version: '1.0.0',
  type: 'module',
  main: 'index.js',
  license: 'Apache-2.0',
  scripts: {
    start: 'node index.js',
  },
  dependencies: {
    dotenv: '^17.2.3',
    express: '^5.2.1',
  },
  engines: {
    node: '>=18',
  },
};

writeFileSync(join(distDir, 'package.json'), JSON.stringify(distPackageJson, null, 2) + '\n');

copyFileSync('.env.example', join(distDir, '.env.example'));
copyFileSync('gremlinofa-vfs.service', join(distDir, 'gremlinofa-vfs.service'));
copyFileSync('gremlinofa-vfs.initd', join(distDir, 'gremlinofa-vfs.initd'));

console.log('Build complete:');
console.log('  dist/index.js          - Main application bundle');
console.log('  dist/index.js.map      - Source map');
console.log('  dist/package.json      - Runtime dependencies');
console.log('  dist/.env.example      - Configuration template');
console.log('  dist/gremlinofa-vfs.service  - systemd service');
console.log('  dist/gremlinofa-vfs.initd    - Alpine OpenRC init');
