import { describe, expect, it } from 'vitest';
import { arenaModes, arenaDeliveries, arenaParityPayload } from '../../../fixtures/arena-generation/input';
import { assembleArenaGenerationPrompt, type ArenaPromptAdjudicationResult } from '@mahoshojo/ai-core/arena-generation';
import { buildArenaGenerationPrompt } from '../src/arena-generation/prompt';

describe('Arena Hosted and pure-core prompt parity', () => {
  for (const mode of arenaModes) for (const delivery of arenaDeliveries) {
    it(`${mode}/${delivery}`, async () => {
      const result = await buildArenaGenerationPrompt({ actorKey: 'anonymous:fixture', random: () => 0, payload: arenaParityPayload(mode, delivery) });
      expect(result.prompt).toContain('雨城的约定');
      expect(result.prompt).toContain('旧约定仍有效');
      expect(result.prompt).not.toContain('excluded-signature');
      const { __arenaServerContextV1: _context, adjudicationResults, ...payload } = arenaParityPayload(mode, delivery);
      void _context;
      expect(assembleArenaGenerationPrompt({
        payload,
        outputContract: delivery === 'non-stream' ? 'structured-report' : 'stream-markdown',
        reporterInfo: { name: '蓝星单推人', publication: '兽扑' },
        adjudicationResults: adjudicationResults as ArenaPromptAdjudicationResult[],
      })).toEqual(result);
    });
  }
});

it('keeps delivery-specific guidance truncation in Hosted, including boundary whitespace', async () => {
  const guidance = `${'字'.repeat(199)} 尾部完整保留`;
  for (const delivery of arenaDeliveries) {
    const payload = { ...arenaParityPayload('classic', delivery), userGuidance: `  ${guidance}  ` };
    const result = await buildArenaGenerationPrompt({ actorKey: 'fixture', payload, random: () => 0 });
    expect(result.metadata.userGuidance).toBe(delivery === 'non-stream' ? guidance.slice(0, 200) : guidance);
  }
});
