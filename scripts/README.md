# Scripts

This folder contains various helper, test, and development scripts.

## Important: Build Safety

The entire `scripts/` folder is explicitly excluded in `tsconfig.json`:

```json
"exclude": ["node_modules", "scripts"]
```

This means scripts can never break `npx tsc --noEmit` or the Next.js production build, even if they have loose types, top-level awaits, or experimental code.

## Folder Structure

- `dev/` — Development & experimental scripts (throwaway tests, backtests, one-off debugging).  
  These are committed so that important validation work remains visible in the repo (e.g. proof that the low-level DLMM split path with 1.4M CU and bin array pre-initialization was working before being ported to production).
- `archive/` — Historical or no-longer-active scripts that still have value as reference or proof of testing.
- `utils/` — Small utilities and patches that are required by the build process (must remain at the root level of `scripts/`).

## Root-Level Scripts (Build Critical)

These live at the root of `scripts/` because they are referenced from `package.json`:

- `assert-env-local-only.cjs` — Used in `predev`, `prebuild`, `prestart`
- `patch-dlmm-esm.js` — Used in `postinstall`

## Usage

Most scripts can be run with:

```bash
npx tsx scripts/dev/test-dlmm-direct.ts --help
```

See individual script headers for usage details.

## Policy

- If a script proved something important for production code (especially around safety-critical paths like position opening), it should live in `dev/` or `archive/` with a clear header comment explaining what it validated.
- Do not put production logic here — only tests, experiments, and historical reference.
