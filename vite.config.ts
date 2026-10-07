import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3456',
        changeOrigin: true,
        // Vite's default proxy error handler replies with an empty 502
        // (text/plain) when the backend is down, which surfaces in the UI as
        // "Unexpected end of JSON input" / "HTTP 502". Answer with a JSON
        // error instead so every client sees the same thing.
        configure: (proxy) => {
          proxy.on('error', (_err, _req, res) => {
            if ('writeHead' in res && !res.headersSent && !res.writableEnded) {
              res.writeHead(502, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'API server is not running' }))
            }
          })
        },
      },
    },
  },
})
