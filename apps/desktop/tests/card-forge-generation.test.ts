import { withFixtureStreamReceipt } from './helpers/stream-receipt-fixture';
import { describe, expect, it, vi } from 'vitest';
import { GAME_CARD_GENERATION_CONFIG } from '@mahoshojo/ai-core/game-card-generation';
import { buildStructuredJsonInstructionFromZodSchema } from '@mahoshojo/ai-core/structured-json';
import type { AiExecutionRequest } from '@mahoshojo/contracts/ai-execution';
import type { AiStreamEvent } from '@mahoshojo/ai-core/stream-events';
import { STREAM_DIRECT_AI_COMMAND, CANCEL_DIRECT_AI_COMMAND } from '../src/platform/direct-ai-bridge';
import { executeForgeGeneration, normalizeForgeGenerationInput } from '../src/features/card-forge/generation';
import type { DesktopDirectGenerationIntent } from '../src/features/generation/executor';
const face = { cardName: '蔷薇', cardType: 'character', rarity: 'epic', cost: 3, element: 'dark', attack: 2, defense: 1, hp: 3, effects: [{ type: '被动', description: '效果' }], traits: [], flavorText: '', powerLevel: 'A', description: '', themeColor: '#ef4444' };
const input = { sourceCardJson: '{"name":"蔷薇","unknown":{"kept":true}}', customInstructions: ' 偏控制 ' };
const intent: DesktopDirectGenerationIntent = { requestId: 'forge-1', mode: 'direct-local', modelId: 'frozen', generationMode: 'non-stream' };
function nativeHarness(text: string, gate?: Promise<void>, finishReason: 'stop' | 'length' = 'stop') {
  let sent: AiExecutionRequest | undefined;
  const invoke = vi.fn(withFixtureStreamReceipt(async (command: string, args?: Record<string, unknown>) => {
    if (command === CANCEL_DIRECT_AI_COMMAND) return true;
    if (command !== STREAM_DIRECT_AI_COMMAND) throw new Error(command);
    sent = args!.request as AiExecutionRequest;
    const channel = args!.onEvent as { onmessage(event: AiStreamEvent): void };
    const identity = { requestId: sent.requestId, contractVersion: 1 as const, mode: sent.mode };
    channel.onmessage({ type: 'started', ...identity, sequence: 0 });
    channel.onmessage({ type: 'text-delta', ...identity, sequence: 1, delta: text });
    if (gate) await gate;
    channel.onmessage({ type: 'result', ...identity, sequence: 2, result: { ...identity, status: 'completed', finishReason, output: { text } } });
  }));
  return { invoke, options: { invoke, profileId: 'profile', createChannel: () => ({}) }, request: () => sent! };
}

describe('forge Direct generation', () => {
  it('uses the existing shared prompt and exact schema with a frozen target', async () => {
    const native = nativeHarness(JSON.stringify(face));
    const result = await executeForgeGeneration(native.options, input, intent, new AbortController().signal);
    expect(result).toMatchObject({ status: 'completed', cardKind: 'game-card', card: face });
    expect(native.request()).toMatchObject({ modelId: 'frozen', mode: 'direct-local', responseFormat: 'text', temperature: 0.7 });
    expect(native.request().messages).toEqual([
      { role: 'system', content: `${GAME_CARD_GENERATION_CONFIG.systemPrompt}\n\n${buildStructuredJsonInstructionFromZodSchema(GAME_CARD_GENERATION_CONFIG.schema)}` },
      { role: 'user', content: GAME_CARD_GENERATION_CONFIG.promptBuilder(normalizeForgeGenerationInput(input)) },
    ]);
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });
  it.each(['null', '[]', '{}', '{bad', '{"__proto__":{}}', JSON.stringify(face), '{"faceData":{}}', '{"documentType":"maho-shojo-game-card-forge"}'])('rejects unsafe or forge source %s without dispatch', async sourceCardJson => {
    const native = nativeHarness('{}');
    expect(() => executeForgeGeneration(native.options, { sourceCardJson }, intent, new AbortController().signal)).toThrow();
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it('bounds raw source and instructions before parsing, preserving unknown source fields', () => {
    expect(() => normalizeForgeGenerationInput({ sourceCardJson: ' '.repeat(1024 * 1024 + 1) })).toThrow('1 MiB');
    expect(() => normalizeForgeGenerationInput({ ...input, customInstructions: '中'.repeat(6000) })).toThrow('16 KiB');
    expect(normalizeForgeGenerationInput({ ...input, sourceCardJson: '\ufeff' + input.sourceCardJson })).toEqual({ ...input, customInstructions: '偏控制' });
  });
  it('does not accept a schema-valid but truncated response', async () => {
    const native = nativeHarness(JSON.stringify(face), undefined, 'length');
    expect(await executeForgeGeneration(native.options, input, intent, new AbortController().signal)).toMatchObject({ status: 'invalid-output', rawText: JSON.stringify(face) });
  });
  it('rejects invalid output and unsupported hosted or markdown modes', async () => {
    const native = nativeHarness('{"cardName":"broken"}');
    expect(await executeForgeGeneration(native.options, input, intent, new AbortController().signal)).toMatchObject({ status: 'invalid-output' });
    native.invoke.mockClear();
    expect(await executeForgeGeneration(native.options, input, { ...intent, mode: 'hosted-json' } as unknown as DesktopDirectGenerationIntent, new AbortController().signal)).toMatchObject({ status: 'failed' });
    expect(await executeForgeGeneration(native.options, input, { ...intent, generationMode: 'stream' }, new AbortController().signal)).toMatchObject({ status: 'failed' });
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
