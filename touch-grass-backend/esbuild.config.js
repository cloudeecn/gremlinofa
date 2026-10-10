import * as esbuild from 'esbuild';
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const distDir = 'dist';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const runtimeDependencies = pkg.dependencies ?? {};

mkdirSync(distDir, { recursive: true });

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: join(distDir, 'index.js'),
  sourcemap: true,
  external: Object.keys(runtimeDependencies),
  banner: {
    js: '// GremlinOFA Touch Grass Backend - Bundled with esbuild\n',
  },
});

// The bundle serves the web UI assets from <dir of index.js>/static.
// Cleared first so a file deleted from src/static doesn't linger in the deploy.
rmSync(join(distDir, 'static'), { recursive: true, force: true });
cpSync(join('src', 'static'), join(distDir, 'static'), { recursive: true });

const distPackageJson = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  type: 'module',
  main: 'index.js',
  license: pkg.license,
  scripts: {
    start: 'node index.js',
  },
  dependencies: runtimeDependencies,
  engines: pkg.engines,
};
writeFileSync(join(distDir, 'package.json'), JSON.stringify(distPackageJson, null, 2) + '\n');

// copyFileSync throws on a missing file, so a renamed unit file fails the build
// instead of shipping a deploy without it. The README links the API spec.
const copiedFiles = [
  '.env.example',
  'gremlinofa-touch-grass.service',
  'gremlinofa-touch-grass.initd',
  'README.md',
  'touch-grass-api.yaml',
];
for (const file of copiedFiles) {
  copyFileSync(file, join(distDir, file));
}

console.log('Build complete:');
console.log('  dist/index.js       - Main application bundle (+ source map)');
console.log('  dist/static/        - Web UI assets');
console.log('  dist/package.json   - Runtime dependencies');
for (const file of copiedFiles) {
  console.log(`  dist/${file}`);
}
