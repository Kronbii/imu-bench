import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// `npm run dev` serves the UI with hot reload and forwards the data stream and
// commands to server/serve.py, which must be running on :8765.
export default defineConfig({
  plugins: [react()],
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
