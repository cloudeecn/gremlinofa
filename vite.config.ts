import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  // Development mode when running `npm run dev`
  const isDev = command === 'serve';
  // Base path: /dev/ for dev server (proxied by nginx), / for production build
  const base = isDev ? '/dev/' : '/';

  return {
    base,
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
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        includeAssets: ['favicon.ico'],
        workbox: {
          // Prevent service worker from caching /dev/* paths
          // This allows the dev server to work alongside prod PWA
          navigateFallbackDenylist: [/^\/dev/, /^\/storage/],
          maximumFileSizeToCacheInBytes: 10485760,
        },
        manifest: {
          name: 'Gremlin Of The Friday Afternoon',
          short_name: 'GremlinOFA',
          description: 'AI chatbot supporting multiple providers with project-based organization',
          theme_color: '#ffffff',
          background_color: '#ffffff',
          display: 'standalone',
          start_url: '/',
          icons: [
            {
              src: '/icons/gremlin-icon.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
          ],
        },
      }),
    ],
  };
});
