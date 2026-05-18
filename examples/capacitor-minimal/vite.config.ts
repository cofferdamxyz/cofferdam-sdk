import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Capacitor expects the build output in `dist/` (default) and serves index.html
// at the root. No special config is needed for Capacitor — `cap sync` reads
// the bundle from `dist/` and copies it into the iOS / Android native shells.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
  },
})
