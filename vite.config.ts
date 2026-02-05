import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  // Development mode when running `npm run dev`
  const isDev = command === 'serve';
  // Base path: /dev/ for dev server (proxied by nginx), / for production build
  // Can be overridden with VITE_BASE_PATH env var (e.g., for GitHub Pages subdirectory)
  const base = process.env.VITE_BASE_PATH || (isDev ? '/dev/' : '/');

  return {
    base,
    resolve: {
      alias: {
        // Redirect Node.js smithy package to browser version for @anthropic-ai/bedrock-sdk
        '@smithy/eventstream-serde-node': '@smithy/eventstream-serde-browser',
      },
    },
    build: {
      sourcemap: true,
    },
    server: {
      host: '127.0.0.1',
      port: 5199,
      allowedHosts: true,
      // HMR configuration for nginx reverse proxy
      hmr: isDev
        ? {
            // WebSocket path for HMR through nginx proxy
            path: '/dev/',
          }
        : undefined,
    },
    optimizeDeps: {
      exclude: ['@jitl/quickjs-ng-wasmfile-release-sync'], // Replace with the actual package name
    },
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        includeAssets: ['favicon.ico', 'assets/*'],
        // Use static public/manifest.json for both dev and prod
        manifest: false,
        workbox: {
          // Prevent service worker from caching /dev/* paths
          // This allows the dev server to work alongside prod PWA
          navigateFallbackDenylist: [/\/dev\//, /\/storage\//, /\/src\//],
          maximumFileSizeToCacheInBytes: 10485760,
        },
      }),
    ],
  };
});
