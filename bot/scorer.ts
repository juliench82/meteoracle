// Legacy scorer stub (no longer used by simplified deep-checker; evil-panda scoring inlined)
export type ScoreBreakdown = {
  total: number;
  volMcScore: number;
  rugScore: number;
  holderScore: number;
  freshnessScore: number;
  feeEfficiencyScore: number;
  volumeTvlScore: number;
  curveBonus: number;
};

export function scoreCandidateWithBreakdown(metrics: any, strategy?: any): ScoreBreakdown {
  return {
    total: 0,
    volMcScore: 0,
    rugScore: 0,
    holderScore: 0,
    freshnessScore: 0,
    feeEfficiencyScore: 0,
    volumeTvlScore: 0,
    curveBonus: 0,
  };
}

export function getMomentumRegainBreakdown(metrics: any) {
  return { total: 0 };
}
