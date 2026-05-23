#!/bin/bash

# scripts/test-rich-direct.sh
#
# Convenience wrapper for testing RICH-SOL with the direct DLMM path.
# Hardcodes the correct pool and mint so you don't have to copy-paste long addresses.
#
# Usage examples:
#   bash scripts/test-rich-direct.sh --simulate
#   bash scripts/test-rich-direct.sh --skip-jupiter --use-balance 10% --simulate
#   bash scripts/test-rich-direct.sh --amount 0.05 --simulate

POOL="BGRTiYMPfpfYANXxbAsgTW7KMPt6DTjahEytAZDvFwi3"
MINT="5hiLgyybrAYPpUwNFa38agfZ8iEtnahWKAPixcfspump"

cd "$(dirname "$0")/.." || exit 1

echo "=== Testing RICH-SOL (Direct Path) ==="
echo "Pool: $POOL"
echo "Mint: $MINT"
echo ""

npx tsx scripts/test-dlmm-direct.ts \
  --pool "$POOL" \
  --mint "$MINT" \
  --strategy evil-panda \
  "$@"
