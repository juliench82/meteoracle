/**
 * lib/supabase.ts
 *
 * Compatibility shim during the transition to the simplified stack (local-state + local-logger).
 * Old Supabase calls are turned into no-ops with a warning so the build stays green
 * while we migrate the remaining references.
 */
const warnOnce = (msg: string) => {
  if (!(globalThis as any).__supabaseWarned) {
    (globalThis as any).__supabaseWarned = new Set();
  }
  const set = (globalThis as any).__supabaseWarned as Set<string>;
  if (!set.has(msg)) {
    set.add(msg);
    console.warn(`[supabase-shim] ${msg} — using local-state instead`);
  }
};

function createChain() {
  const chain: any = {
    select: () => { warnOnce('supabase.from().select() called'); return chain; },
    insert: () => { warnOnce('supabase insert'); return chain; },
    update: () => { warnOnce('supabase update'); return chain; },
    upsert: () => { warnOnce('supabase upsert'); return chain; },
    delete: () => { warnOnce('supabase delete'); return chain; },
    eq: () => chain,
    in: () => chain,
    gte: () => chain,
    order: () => chain,
    limit: () => chain,
    single: async () => { warnOnce('supabase single()'); return { data: null, error: null }; },
    maybeSingle: async () => ({ data: null, error: null }),
  };
  return chain;
}

export function createServerClient() {
  return {
    from: (table: string) => {
      warnOnce(`supabase.from('${table}')`);
      return createChain();
    },
    logInfo: async (table: string, payload: any) => {
      // Route legacy logInfo calls to local logger if possible
      try {
        const { logInfo } = await import('./log');
        logInfo(payload?.event || 'legacy_supabase_log', payload?.payload || payload);
      } catch {
        console.log('[legacy supabase log]', table, payload);
      }
    },
  };
}

// Default export for code that does `import supabase from ...`
const supabase = createServerClient();
export default supabase;
