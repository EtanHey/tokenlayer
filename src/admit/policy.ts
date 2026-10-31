// Fleet canon #5; tests bind these values to the vendored canon and TLA config.
export const CLAUDE_POLICY = {
  leads: { green: 5, slow: 2, stop: 1 },
  workerCaps: { judgment: 2, cheap: 2, mechanical: 4 },
  judgmentSlots: 7,
  workerSharePct: 20,
  brake: { stopUsedPct: 95, projectionPct: 100, minElapsedPct: 10 },
} as const;
