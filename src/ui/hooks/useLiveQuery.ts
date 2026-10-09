import { useEffect, useState } from 'react'
import type { Observable } from 'dexie'

/** Minimal live query helper for Dexie promises/observables. */
export function useAsyncData<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    // Keep previous data visible while refreshing (avoids flash → blank)
    setLoading(true)
    loader()
      .then((v) => {
        if (!cancelled) {
          setData(v)
          setError(null)
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])

  return {
    data,
    error,
    loading,
    reload: () => setTick((t) => t + 1),
  }
}

export type { Observable }
