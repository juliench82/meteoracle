#!/bin/bash

# scripts/test-rich-zap.sh
#
# Convenience wrapper for testing RICH-SOL with the Zap path.
# Hardcodes the correct pool and mint so you don't have to copy-paste long addresses.
#
# Usage examples:
#   bash scripts/test-rich-zap.sh --simulate
#   bash scripts/test-rich-zap.sh --skip-jupiter --use-balance 10% --simulate

POOL="BGRTiYMPfpfYANXxbAsgTW7KMPt6DTjahEytAZDvFwi3"
MINT="5hiLgyybrAYPpUwNFa38agfZ8iEtnahWKAPixcfspump"

cd "$(dirname "$0")/.." || exit 1

echo "=== Testing RICH-SOL (Zap Path) ==="
echo "Pool: $POOL"
echo "Mint: $MINT"
echo ""

npx tsx scripts/test-dlmm-zap.ts \
  --pool "$POOL" \
  --mint "$MINT" \
  "$@"
