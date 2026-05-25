# Scripts

This folder contains various helper and development scripts.

## Folder Structure

- `dev/` — Actively used development and debugging scripts (e.g. low-level DLMM testing, backtesting).
- `utils/` — Small one-off utilities and patches required by the build process.
- `archive/` — Old, experimental, or no-longer-maintained scripts. These are gitignored.

## Important Scripts at Root

These must stay at the root level because they are referenced in `package.json`:

- `assert-env-local-only.cjs` — Used in `predev`, `prebuild`, `prestart`
- `patch-dlmm-esm.js` — Used in `postinstall`

## Usage

Most scripts are intended to be run directly with `npx tsx scripts/dev/some-script.ts` or similar.
