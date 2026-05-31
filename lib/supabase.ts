/**
 * lib/supabase.ts
 *
 * Ultra-thin compatibility shim.
 * All real Supabase usage has been removed from hot paths.
 * Remaining calls are no-ops (local-state is authoritative).
 */
function noopChain() {
  const chain: any = new Proxy({}, {
    get: () => () => chain,
  });
  chain.then = (onFulfilled?: any) => Promise.resolve({ data: null, error: null }).then(onFulfilled);
  return chain;
}

export function createServerClient() {
  return {
    from: (_table: string) => noopChain(),
    logInfo: async (table: string, payload: any) => {
      try {
        const { logInfo } = await import('./log');
        logInfo('legacy_supabase_log', { table, ...payload });
      } catch {}
    },
  } as any;
}

const supabase = createServerClient();
export default supabase;
export { supabase };
