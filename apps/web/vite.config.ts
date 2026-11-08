import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))
const envDir = fileURLToPath(new URL('../../', import.meta.url))

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, 'VITE_')
  const { VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: key } = env
  if (key && !/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error('VITE_SUPABASE_PUBLISHABLE_KEY must be a Supabase publishable key.')
  }
  if (url && !/^https?:\/\/[^/?#]+\/?$/.test(url)) {
    throw new Error('VITE_SUPABASE_URL must be the Supabase project origin.')
  }

  return {
    root, envDir,
    plugins: [react()],
    build: {
      license: { fileName: 'third-party-notices.txt' },
      rollupOptions: {
        input: {
          workspace: fileURLToPath(new URL('index.html', import.meta.url)),
          editor: fileURLToPath(new URL('editor.html', import.meta.url)),
        },
      },
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: { '/api': 'http://127.0.0.1:4000' },
    },
  }
})
