import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
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
  // Every runtime dependency stays external: better-sqlite3 is native, and
  // Express pulls in depd, whose dynamic require() breaks in an ESM bundle.
  external: Object.keys(runtimeDependencies),
  banner: {
    js: '// GremlinOFA Storage Backend - Bundled with esbuild\n',
  },
});

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
// instead of shipping a deploy without it.
const copiedFiles = ['.env.example', 'gremlinofa-storage.service', 'gremlinofa-storage.initd'];
for (const file of copiedFiles) {
  copyFileSync(file, join(distDir, file));
}

console.log('Build complete:');
console.log('  dist/index.js       - Main application bundle (+ source map)');
console.log('  dist/package.json   - Runtime dependencies');
for (const file of copiedFiles) {
  console.log(`  dist/${file}`);
}
