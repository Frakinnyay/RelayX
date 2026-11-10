import { useCallback, useEffect, useRef, useState } from 'react';

/** Calls `fn` now and then every `ms` milliseconds. Errors are surfaced, not thrown. */
export function usePolling<T>(fn: () => Promise<T>, ms = 2000, deps: unknown[] = []): { data: T | undefined; error: string | undefined; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const load = useCallback(async () => {
    try {
      setData(await fnRef.current());
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), ms);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, load, ...deps]);

  return { data, error, reload: () => void load() };
}

export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
