# Meteoracle — Data Flow: Live vs Stale

_Auto-generated. Last updated by monitor patch (May 2026)._

```mermaid
flowchart TD
    subgraph TICK["🕐 Every Monitor Tick"]
        A([monitorPositions]) --> B[syncAllMeteoraPositions]
        B --> C{sync ok?}
        C -- no --> Z([skip tick])
        C -- yes --> D[fetchCachedRowsForLivePositions\nSupabase REST · lp_positions]
        D --> E[mergeDbAndLiveLpPositions]
        E --> F[checkPosition loop]
    end

    subgraph LIVE["🟢 LIVE — On-Chain per Position"]
        F --> G[fetchPositionState\nMeteora DLMM SDK]
        G --> G1[getPositionsByUserAndLbPair\n→ externallyClosed?]
        G --> G2[getActiveBin\n→ currentPriceSol LIVE]
        G --> G3[getPosition\n→ inRange LIVE]
        G --> G4[totalXAmount + totalYAmount\n→ claimableFeesSol LIVE]
    end

    subgraph STALE["🟡 STALE — From Last Sync / DB"]
        F --> H[position.pnl_usd\nposition.pnl_pct\nposition.position_value_usd]
        F --> I[metadata.sol_price_usd\n→ USD conversion]
        H --> J[resolveMeteoraPnlPct\n→ pnlPct derived]
        I --> K[derivedClaimableFeesUsd\n= liveSOL × stale USD price]
    end

    subgraph WRITE["✏️ DB Write — lp_positions PATCH"]
        G2 --> W[current_price ✅ live]
        G3 --> W2[in_range ✅ live]
        G4 --> W3[claimable_fees_sol ✅ live]
        J --> W4[pnl_pct ⚠️ stale]
        H --> W5[pnl_usd ⚠️ stale]
        K --> W6[claimable_fees_usd ⚠️ stale USD]
    end

    subgraph EXTERNAL["🔴 externallyClosed Path"]
        G1 -- position gone --> EC1[snapshot from metadata\npnl_usd · pnl_pct · fees · age]
        EC1 --> EC2[status=closed\nclose_reason=external_close_detected\nexternal_close_detected_at stamped]
    end

    subgraph DAMM["🔵 DAMM Edge Path"]
        F --> DA[fetchDammPositionState\nSupabase only — 100% stale]
        DA --> DA2[pnl_pct from DB row\nor metadata fallback]
    end
```

## Legend

| Symbol | Meaning |
|---|---|
| ✅ live | Fetched from chain / Meteora SDK on every tick |
| ⚠️ stale | Read from last `syncAllMeteoraPositions` DB write — can be 1 tick old |
| 🔴 externallyClosed | Position vanished on-chain; snapshot written from last known metadata |
| 🔵 DAMM | `fetchDammPositionState` is DB-only — no live on-chain call |

## Key Findings

- **`currentPriceSol`** — always live (DLMM SDK `getActiveBin`)
- **`inRange`** — always live (DLMM SDK `getPosition`)
- **`claimableFeesSol`** — always live (DLMM SDK `totalXAmount + totalYAmount`)
- **`pnl_usd` / `pnl_pct`** — sourced from last sync write; USD-stale by up to 1 tick
- **`claimable_fees_usd`** — live SOL qty × stale `sol_price_usd`; USD value drifts between syncs
- **`position_value_usd`** — fully stale; not recomputed at tick time
- **DAMM `pnl_pct`** — 100% stale (DB read only, no on-chain call)
- **`externallyClosed` snapshot** — patched (commit `419a1749`): now writes last-known PnL/fees/age before closing row
