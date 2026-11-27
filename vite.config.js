import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// v49 — identificação da versão publicada (aparece no menu do app). Na Vercel,
// VERCEL_GIT_COMMIT_SHA é o commit que gerou o build.
const commit = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || 'local'

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSAO__: JSON.stringify(commit),
    __APP_BUILD__: JSON.stringify(new Date().toISOString()),
  },
})
