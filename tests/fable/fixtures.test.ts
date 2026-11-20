import { expect, spyOn, test } from 'bun:test';
import { fakeHub } from './fixtures';

test('new Hub fixtures have fresh quota readings even after a long suite', async () => {
  const now = Date.now() + 6 * 60_000;
  const clock = spyOn(Date, 'now').mockReturnValue(now);
  try {
    const observations = await fakeHub().observations();
    for (const observation of observations) {
      expect(observation.quota?.observed_at).toBe(new Date(now).toISOString());
      expect(observation.model_quotas?.['claude-fable-5-2']?.observed_at).toBe(new Date(now).toISOString());
    }
  } finally { clock.mockRestore(); }
});
