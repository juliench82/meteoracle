# Scripts

This folder contains various helper and development scripts.

## Folder Structure

- `dev/` — Development and debugging scripts (e.g. low-level DLMM testing, backtesting).  
  **Currently gitignored** because they are causing issues in the npm build / TypeScript compilation. They are kept locally for development only.
- `utils/` — Small one-off utilities and patches required by the build process (these must stay at the root of `scripts/`).
- `archive/` — Old, experimental, or no-longer-maintained scripts. These are gitignored.

## Important Scripts at Root

These must stay at the root level because they are referenced in `package.json`:

- `assert-env-local-only.cjs` — Used in `predev`, `prebuild`, `prestart`
- `patch-dlmm-esm.js` — Used in `postinstall`

## Usage

Scripts in `dev/` can be run directly (e.g. `npx tsx scripts/dev/test-dlmm-direct.ts`), but note that the entire `dev/` folder is currently gitignored.
