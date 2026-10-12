/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

export default defineConfig(({ command }) => ({
  // GitHub Pages: https://flatty35.github.io/VisualiseurFortuneo/
  // Dev keeps `/` so npm run dev stays on http://localhost:5173/
  base: command === 'build' ? '/VisualiseurFortuneo/' : '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
}))
