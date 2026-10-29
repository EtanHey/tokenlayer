// Each sample launches the same trusted harness against one source tree.
/** @param {(side: 'base' | 'candidate') => number | null | undefined} sample */
export function pairedSamples(sample) {
  const samples = { base: [], candidate: [] };
  for (let pair = 0; pair < 5; pair++) {
    for (const side of ['base', 'candidate']) {
      const value = sample(side);
      if (!Number.isFinite(value) || value <= 0) throw Error('missing paired ingest measurement');
      samples[side].push(value);
    }
  }
  const median = xs => [...xs].sort((a, b) => a - b)[2];
  return { baseline: median(samples.base), value: median(samples.candidate), samples };
}
