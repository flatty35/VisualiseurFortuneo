/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

const MS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const MS_FETCH_MS = 12_000

/** Cookie jar + warmup so Morningstar search returns JSON (not HTTP 202 empty). */
function morningstarDevProxy(): Plugin {
  let cookie = ''
  /** Serialize upstream calls so one hang cannot pile up and freeze Vite. */
  let chain: Promise<void> = Promise.resolve()

  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function msFetch(url: string, init?: RequestInit): Promise<Response> {
    return fetch(url, {
      ...init,
      signal: AbortSignal.timeout(MS_FETCH_MS),
    })
  }

  async function warmup(): Promise<string> {
    try {
      const home = await msFetch('https://www.morningstar.com/', {
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
          const msg = await withLock(() => warmup())
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: true, detail: msg }))
          return
        }

        try {
          const u = new URL(url, 'http://localhost')
          if (!u.pathname.startsWith('/api/morningstar')) return next()
          const q = u.searchParams.get('q') || ''

          const { status, body } = await withLock(async () => {
            if (!cookie) await warmup()

            const target = `https://www.morningstar.com/api/v2/search?q=${encodeURIComponent(q)}`
            const headers: Record<string, string> = {
              'User-Agent': MS_UA,
              Accept: 'application/json,text/plain,*/*',
              'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
              Referer: 'https://www.morningstar.com/',
              ...(cookie ? { Cookie: cookie } : {}),
            }
            let r = await msFetch(target, { headers })
            let text = await r.text()
            // One cookie refresh on empty 202 — still bounded by MS_FETCH_MS each
            if ((!text || r.status === 202) && q) {
              await warmup()
              r = await msFetch(target, {
                headers: {
                  ...headers,
                  ...(cookie ? { Cookie: cookie } : {}),
                },
              })
              text = await r.text()
            }
            const set = r.headers.getSetCookie?.() ?? []
            if (set.length) {
              cookie = set.map((c) => c.split(';')[0]).join('; ')
            }
            return {
              status: r.status === 202 && !text ? 502 : r.status,
              body: text,
            }
          })

          res.statusCode = status
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          if (!body) {
            res.end(
              JSON.stringify({
                results: [],
                error: `Morningstar HTTP ${status} empty body`,
              }),
            )
            return
          }
          res.end(body)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          const timedOut = /aborted|timeout|TimeoutError/i.test(msg)
          res.statusCode = timedOut ? 504 : 502
          res.setHeader('Content-Type', 'application/json')
          res.end(
            JSON.stringify({
              results: [],
              error: timedOut ? `Morningstar timeout (${MS_FETCH_MS}ms)` : msg,
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
