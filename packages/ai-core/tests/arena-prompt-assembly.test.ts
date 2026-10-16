import { describe, expect, it, vi } from 'vitest';
import { arenaModes, arenaDeliveries, arenaParityPayload } from '../../../fixtures/arena-generation/input';
import { assembleArenaGenerationPrompt, type ArenaPromptAdjudicationResult } from '../src/arena-generation';

describe('pure Arena prompt assembly', () => {
  for (const mode of arenaModes) for (const delivery of arenaDeliveries) {
    it(`preserves the ${mode}/${delivery} payload and keeps randomness host-owned`, () => {
      const { __arenaServerContextV1: _serverContext, adjudicationResults, ...payload } = arenaParityPayload(mode, delivery);
      void _serverContext;
      const before = JSON.stringify(payload);
      const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('random must stay host-owned'); });
      try {
        const result = assembleArenaGenerationPrompt({
          payload,
          outputContract: delivery === 'non-stream' ? 'structured-report' : 'stream-markdown',
          reporterInfo: { name: '蓝星单推人', publication: '兽扑' },
          adjudicationResults: adjudicationResults as ArenaPromptAdjudicationResult[],
        });
        expect(result.metadata.outputContract).toBe(delivery === 'non-stream' ? 'structured-report' : 'stream-markdown');
        expect(JSON.stringify(payload)).toBe(before);
      } finally { random.mockRestore(); }
    });
  }

  it('takes output, reporter and adjudication only from explicit arguments', () => {
    const payload = {
      ...arenaParityPayload('classic', 'non-stream'),
      reporterInfo: { name: 'forged', publication: 'forged' },
      adjudicationResults: [{ description: 'ignored adjudication' }],
      webPackageRef: { id: 'ignored' },
      userGuidance: '边界后空白 ',
    };
    const result = assembleArenaGenerationPrompt({
      payload, outputContract: 'stream-markdown', adjudicationResults: null,
      reporterInfo: { name: '本地记者', publication: '本地新闻' },
    });
    expect(result.metadata.outputContract).toBe('stream-markdown');
    expect(result.metadata.reporterInfo).toEqual({ name: '本地记者', publication: '本地新闻' });
    expect(result.metadata.adjudicationResults).toBeNull();
    expect(result.metadata).not.toHaveProperty('webPackageRef');
    expect(result.prompt).not.toContain('ignored adjudication');
    expect(result.metadata.userGuidance).toBe('边界后空白 ');
  });
});
