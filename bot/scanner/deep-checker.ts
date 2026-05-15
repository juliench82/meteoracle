    if (!strategy) {
      rejectionReason = explainNoStrategy(metrics)
      decision = 'REJECTED'
      console.log(`[scanner] ${symbol} — no strategy in ${lane} lane (class=${tokenClass}, quote=${quoteTokenMint}): ${rejectionReason}`)

      // Dedup 6h + insert REJECTED (même si pas de stratégie)
      const dedupCheck = await withTimeout(
        supabase.from('candidates')
          .select('id')
          .eq('token_address', tokenAddress)
          .gte('scanned_at', new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString())
          .limit(1),
        SUPABASE_TIMEOUT_MS, `candidates dedup ${symbol}`
      )
      if (dedupCheck?.data && dedupCheck.data.length > 0) {
        console.log(`[scanner] ${symbol} — already evaluated in last 6h, skipping insert`)
        continue
      }

      const insertResult = await withTimeout(
        supabase.from('candidates').insert({
          token_address:     metrics.address,
          symbol:            metrics.symbol,
          score:             0,
          strategy_matched:  null,
          strategy_id:       null,
          token_class:       tokenClass,
          scanner_lane:      lane,
          pool_address:      metrics.poolAddress,
          mc_at_scan:        metrics.mcUsd,
          volume_24h:        metrics.volume24h,
          volume_1h:         vol1h,
          volume_5m:         vol5m,
          liquidity_usd:     metrics.liquidityUsd,
          fee_tvl_24h_pct:   feeTvl24hPct,
          fee_tvl_1h_pct:    feeTvl1hPct,
          fee_tvl_5mPct:    feeTvl5mPct,
          holder_count:      metrics.holderCount,
          rugcheck_score:    metrics.rugcheckScore,
          top_holder_pct:    metrics.topHolderPct,
          bin_step:          binStep,
          scanned_at:        new Date().toISOString(),
          score_volmc:       0,
          score_holders:     0,
          score_freshness:   0,
          score_fee_efficiency: 0,
          score_volume_tvl:  0,
          score_curve_bonus: 0,
          launchpad_source:  launchpadSource,
          decision:          'REJECTED',
          rejection_reason:  rejectionReason,
        }),
        SUPABASE_TIMEOUT_MS, `candidates insert REJECTED ${symbol}`
      )

      const insertOk = insertResult !== null && !('error' in insertResult && insertResult.error)
      if (!insertOk) {
        const errMsg = insertResult && 'error' in insertResult ? insertResult.error?.message : 'timeout'
        console.error(`[scanner] candidates insert REJECTED failed for ${symbol}:`, errMsg)
      }

      continue
    }