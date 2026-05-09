import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  // Vite by default loads .env from the directory of this config file
  // (client/). The RoamReady monorepo uses a single master .env at the
  // project root, so point envDir up one level. This is what makes
  // import.meta.env.VITE_SENTRY_DSN_CLIENT (and any other VITE_*) actually
  // resolve at build/dev time. Only VITE_-prefixed keys are exposed to the
  // client bundle — Vite enforces this regardless of envDir.
  envDir: '../',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: true,
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
