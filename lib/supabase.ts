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
    select: (...args: any[]) => { warnOnce('supabase.from().select()'); return chain; },
    insert: (...args: any[]) => { warnOnce('supabase insert'); return chain; },
    update: (...args: any[]) => { warnOnce('supabase update'); return chain; },
    upsert: (...args: any[]) => { warnOnce('supabase upsert'); return chain; },
    delete: (...args: any[]) => { warnOnce('supabase delete'); return chain; },
    eq: (...args: any[]) => chain,
    in: (...args: any[]) => chain,
    gte: (...args: any[]) => chain,
    order: (...args: any[]) => chain,
    limit: (...args: any[]) => chain,
    single: async (...args: any[]) => { warnOnce('supabase single()'); return { data: null, error: null }; },
    maybeSingle: async (...args: any[]) => ({ data: null, error: null }),
    then: (onFulfilled?: any, onRejected?: any) => Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected),
  };
  return chain;
}

export function createServerClient() {
  const client: any = {
    from: (table: string) => {
      warnOnce(`supabase.from('${table}')`);
      return createChain();
    },
    logInfo: async (table: string, payload: any) => {
      try {
        const { logInfo } = await import('./log');
        logInfo(payload?.event || 'legacy_supabase_log', payload?.payload || payload);
      } catch {
        console.log('[legacy supabase log]', table, payload);
      }
    },
  };

  // Make the client itself chainable / thenable for old code patterns
  client.then = (onFulfilled?: any, onRejected?: any) => Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);

  return client;
}

// Default export for code that does `import supabase from ...` or uses bare `supabase`
const supabase = createServerClient();
export default supabase;
export { supabase };
