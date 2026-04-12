#!/bin/bash
# Cleans stale Next.js build cache and rebuilds before starting.
# Used by PM2 dashboard process to prevent stale cache bugs.
set -e
cd "$(dirname "$0")"
echo "[dashboard] cleaning .next cache..."
rm -rf .next
echo "[dashboard] building..."
npm run build
echo "[dashboard] starting..."
exec npm run start
