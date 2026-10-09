/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

const MS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** Cookie jar + warmup so Morningstar search returns JSON (not HTTP 202 empty). */
function morningstarDevProxy(): Plugin {
  let cookie = ''

  async function warmup(): Promise<string> {
    try {
      const home = await fetch('https://www.morningstar.com/', {
        headers: {
          'User-Agent': MS_UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        },
        redirect: 'follow',
      })
      const set = home.headers.getSetCookie?.() ?? []
      if (set.length) {
        cookie = set.map((c) => c.split(';')[0]).join('; ')
      }
      return `warmup HTTP ${home.status} cookies=${set.length}`
    } catch (e) {
      return `warmup fail: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  return {
    name: 'morningstar-dev-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || ''
        if (!url.startsWith('/api/morningstar')) return next()

        if (url.startsWith('/api/morningstar-warmup')) {
          const msg = await warmup()
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: true, detail: msg }))
          return
        }

        try {
          const u = new URL(url, 'http://localhost')
          if (!u.pathname.startsWith('/api/morningstar')) return next()
          const q = u.searchParams.get('q') || ''
          if (!cookie) await warmup()

          const target = `https://www.morningstar.com/api/v2/search?q=${encodeURIComponent(q)}`
          let r = await fetch(target, {
            headers: {
              'User-Agent': MS_UA,
              Accept: 'application/json,text/plain,*/*',
              'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
              Referer: 'https://www.morningstar.com/',
              ...(cookie ? { Cookie: cookie } : {}),
            },
          })

          // Refresh cookies / retry once on empty 202
          let body = await r.text()
          if ((!body || r.status === 202) && q) {
            await warmup()
            r = await fetch(target, {
              headers: {
                'User-Agent': MS_UA,
                Accept: 'application/json,text/plain,*/*',
                'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
                Referer: 'https://www.morningstar.com/',
                ...(cookie ? { Cookie: cookie } : {}),
              },
            })
            body = await r.text()
          }

          const set = r.headers.getSetCookie?.() ?? []
          if (set.length) {
            cookie = set.map((c) => c.split(';')[0]).join('; ')
          }

          res.statusCode = r.status === 202 && !body ? 502 : r.status
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          if (!body) {
            res.end(
              JSON.stringify({
                results: [],
                error: `Morningstar HTTP ${r.status} empty body`,
              }),
            )
            return
          }
          res.end(body)
        } catch (e) {
          res.statusCode = 502
          res.setHeader('Content-Type', 'application/json')
          res.end(
            JSON.stringify({
              results: [],
              error: e instanceof Error ? e.message : String(e),
            }),
          )
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), morningstarDevProxy()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
