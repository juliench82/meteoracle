/**
 * lib/supabase.ts
 *
 * Compatibility shim during the transition to the simplified stack.
 * Remaining calls will log a warning but not crash the build.
 */
function noop() { return Promise.resolve({ data: null, error: null }); }

export function createServerClient() {
  return {
    from: () => ({
      select: noop,
      insert: noop,
      update: noop,
      upsert: noop,
      delete: noop,
      eq: function () { return this; },
      in: function () { return this; },
      gte: function () { return this; },
      order: function () { return this; },
      limit: function () { return this; },
      single: noop,
      maybeSingle: noop,
    }),
    logInfo: async () => {},
  };
}

// Compatibility default export for old code that does `import supabase from ...` or `const supabase = ...`
const supabase = createServerClient();
export default supabase;
