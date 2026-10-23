import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AiExecutionErrorCodeSchema,
  AiExecutionRequestSchema,
  type AiExecutionCompletedResult,
} from '@mahoshojo/contracts/ai-execution';
import { ARENA_CANONICAL_RESOURCE_LIMITS } from '@mahoshojo/contracts/arena-capabilities';
import fixtureData from '@mahoshojo/contracts/fixtures/gemini-generate-content-stream.json';
import { z } from 'zod/v3';
import { createArenaStreamProjector } from '../src/arena-generation';
import { FREE_GENERATION_SCHEMAS } from '../src/free-generation';
import { createMagicTeaPartyStreamPreview, parseMagicTeaPartyJsonl } from '../src/magic-tea-party';
import { AiStreamEventSchema, ArenaAiStreamEventSchema, collectAiStreamResult } from '../src/stream-events';
import { parseStructuredJsonWithSchema } from '../src/structured-json';

const fixture = fixtureData as {
  cases: Array<{ name: string; request: unknown; upstreamEvents: unknown[]; events: unknown[] }>;
  failureCases: Array<{ name: string; upstreamEvents: unknown[]; expectedCode: string }>;
};

const assertBusinessOutput = (name: string, result: AiExecutionCompletedResult) => {
  const text = result.output.text!;
  expect(JSON.stringify(result)).not.toContain('synthetic-opaque');
  expect(JSON.stringify(result)).not.toContain('synthetic-unselected');
  if (result.output.reasoning) expect(text).not.toContain(result.output.reasoning);
  if (name === 'json') {
    expect(parseStructuredJsonWithSchema(text, z.object({ answer: z.string() })).data).toEqual({ answer: '魔法' });
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 7 });
    expect(result.usage?.totalTokens).toBeUndefined();
    expect(result.usage?.reasoningTokens).toBeUndefined();
  }
  if (name === 'card-json') {
    expect(parseStructuredJsonWithSchema(text, FREE_GENERATION_SCHEMAS['magical-girl']).data).toMatchObject({ codename: '焰汐' });
    expect(result.output.reasoning).toBe('检查字段。');
  }
  if (name === 'incomplete-card-json') {
    expect(JSON.parse(text)).toEqual({ codename: '未完成' });
    expect(() => parseStructuredJsonWithSchema(text, FREE_GENERATION_SCHEMAS['magical-girl'])).toThrow();
  }
  if (name === 'reasoning-and-cache') {
    expect(result.output.reasoning).toBe('先检查，再回答。');
    // Input already includes cache; reported output and total are not recomputed from thoughts.
    expect(result.usage).toEqual({ inputTokens: 17, outputTokens: 12, reasoningTokens: 7, cachedInputTokens: 0, totalTokens: 41 });
  }
  if (name === 'unicode' || name === 'empty-usage') expect(result.usage).toBeUndefined();
  if (name === 'tea-text') {
    const updates: Array<{ content: string }> = [];
    createMagicTeaPartyStreamPreview({ outputFormat: 'markdown', onUpdate: update => updates.push(update) }).applySafeText(text, 'done');
    expect(updates.at(-1)?.content).toBe(text);
    expect(text).toContain('魔法少女🪄');
  }
  if (name === 'arena-story') {
    const projector = createArenaStreamProjector({ expectsMeta: true });
    const markdown = [...projector.push(text), ...projector.finish().markdown].join('');
    expect(markdown).toBe('# 分支新章\n\n魔法少女向北出发。\n');
    expect(projector.result().metaEvent).toMatchObject({ type: 'meta', data: { parseOk: true, meta: { report: { headline: '分支新章', winner: '甲' } } } });
    expect(markdown).not.toContain(result.output.reasoning!);
  }
  if (name === 'tea-jsonl') {
    const parsed = parseMagicTeaPartyJsonl(text);
    expect(parsed.segments).toContainEqual({ type: 'narration', text: '茶香升起。' });
    expect(parsed.segments).toContainEqual({ type: 'dialogue', speakerId: 'r1', speakerName: '巡夜人', text: '请进🪄' });
    expect(parsed.choices).toEqual([{ id: 'c1', text: '坐下喝茶' }, { id: 'c2', text: '望向窗外' }]);
    expect(JSON.stringify(parsed)).not.toContain('检查说话人。');
  }
};

describe('GenerateContent native projection uses existing consumers', () => {
  it.each(fixture.cases)('$name consumes only normalized shared events', async testCase => {
    const request = AiExecutionRequestSchema.parse(testCase.request);
    const schema = request.requestKind === 'arena' ? ArenaAiStreamEventSchema : AiStreamEventSchema;
    const events = testCase.events.map(event => schema.parse(event));
    const result = await collectAiStreamResult(request, events);
    expect(result).toEqual((events.at(-1) as { result: unknown }).result);
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('Expected completed fixture result');
    assertBusinessOutput(testCase.name, result);
  });

  it('names native failure expectations with existing normalized error codes', () => {
    for (const testCase of fixture.failureCases) {
      expect(AiExecutionErrorCodeSchema.parse(testCase.expectedCode)).toBe(testCase.expectedCode);
      expect(testCase.upstreamEvents.length).toBeGreaterThan(0);
    }
  });

  it('keeps the existing Arena/story resource domain distinct from ordinary card output', async () => {
    const testCase = fixture.cases.find(({ name }) => name === 'arena-story')!;
    const request = AiExecutionRequestSchema.parse(testCase.request);
    expect(request.requestKind).toBe('arena');
    // These are normalized envelope policy checks, not an additional Gemini parser.
    const identity = { requestId: request.requestId, contractVersion: request.contractVersion, mode: request.mode };
    const normalized = (size: number) => {
      const text = 'x'.repeat(size);
      const chunks = text.match(/[\s\S]{1,60000}/g)!;
      return [
        { ...identity, type: 'started', sequence: 0 },
        ...chunks.map((delta, index) => ({ ...identity, type: 'text-delta', sequence: index + 1, delta })),
        { ...identity, type: 'result', sequence: chunks.length + 1,
          result: { ...identity, status: 'completed', output: { text }, finishReason: 'stop' } },
      ];
    };
    const largerThanOrdinary = normalized(1_000_001);
    expect((await collectAiStreamResult(request, largerThanOrdinary)).status).toBe('completed');
    const ordinary = { ...request, requestKind: undefined, arenaInputJson: undefined };
    await expect(collectAiStreamResult(ordinary, largerThanOrdinary)).rejects.toMatchObject({ code: 'limit-exceeded' });
    await expect(collectAiStreamResult(request, normalized(ARENA_CANONICAL_RESOURCE_LIMITS.outputContentBytes + 1)))
      .rejects.toMatchObject({ code: 'limit-exceeded' });
  });
});

const nativeDirectory = process.env.MAHO_NATIVE_EVENT_FIXTURE_DIR;
it.skipIf(!nativeDirectory)('consumes actual Rust GenerateContent loopback output through local schema and tea consumers', async () => {
  for (const testCase of fixture.cases) {
    const request = AiExecutionRequestSchema.parse(testCase.request);
    const produced = JSON.parse(readFileSync(join(nativeDirectory!, `gemini-${testCase.name}.json`), 'utf8')) as unknown[];
    const actual = await collectAiStreamResult(request, produced);
    expect(actual).toEqual(await collectAiStreamResult(request, testCase.events));
    if (actual.status !== 'completed') throw new Error(`Expected completed native result: ${testCase.name}`);
    assertBusinessOutput(testCase.name, actual);
  }
});

it.skipIf(!nativeDirectory)('consumes actual Rust GenerateContent failures with one safe terminal event', async () => {
  for (const testCase of fixture.failureCases) {
    const packet = JSON.parse(readFileSync(join(nativeDirectory!, `gemini-failure-${testCase.name}.json`), 'utf8')) as {
      request: Record<string, unknown>; events: unknown[]; expectedCode: string;
    };
    const input = { ...packet.request };
    // Rust's test-context snapshot serializes these absent options as null, not renderer DTOs.
    for (const field of ['modelId', 'maxOutputTokens', 'temperature', 'responseFormat']) {
      if (input[field] === null) delete input[field];
    }
    const events = packet.events.map(event => AiStreamEventSchema.parse(event));
    const result = await collectAiStreamResult(AiExecutionRequestSchema.parse(input), events);
    expect(packet.expectedCode).toBe(testCase.expectedCode);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.code).toBe(testCase.expectedCode);
    expect(events.filter(event => event.type === 'result')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('synthetic-secret');
    expect(JSON.stringify(events)).not.toContain('synthetic-opaque');
  }
});
