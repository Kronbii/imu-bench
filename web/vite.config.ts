import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// `npm run dev` serves the UI with hot reload and forwards the data stream and
// commands to a running ./imu-bench <driver> on :8765.
export default defineConfig({
  plugins: [react()],
  base: './', // relative, so it also works under a sub-path (GitHub Pages, a reverse proxy)
  server: {
    port: 5173,
    proxy: {
      '/stream': 'http://127.0.0.1:8765',
      '/api': 'http://127.0.0.1:8765',
    },
  },
  build: {
    chunkSizeWarningLimit: 1200,
  },
})
