import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// STANDALONE=1 (used by build:standalone) skips PWA output, since the
// single-file nexus-grid.html is opened from file:// where a service
// worker can't register.
const standalone = process.env.STANDALONE === '1'

export default defineConfig({
  // Relative base so the build works whether served from a domain root,
  // a GitHub Pages subpath, or bundled inside the Capacitor APK.
  base: './',
  // The standalone single-file build can't load split chunks over file://,
  // so collapse everything (incl. the lazy online code) into one bundle.
  // The normal web/APK build keeps code-splitting (online stays a lazy chunk).
  build: standalone
    ? { rollupOptions: { output: { inlineDynamicImports: true } } }
    : {},
  plugins: [
    react(),
    VitePWA({
      disable: standalone,
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png'],
      manifest: {
        name: 'NEXUS GRID — Dots & Boxes Evolved',
        short_name: 'Nexus Grid',
        description: 'A futuristic cyberpunk take on Dots and Boxes.',
        theme_color: '#030712',
        background_color: '#030712',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
      },
    }),
  ],
})
