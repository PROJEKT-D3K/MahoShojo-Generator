import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AiExecutionRequestSchema } from '@mahoshojo/contracts/ai-execution';
import { AiStreamEventSchema, collectAiStreamResult } from '../src/stream-events';
import { parseStructuredJsonWithSchema } from '../src/structured-json';
import { z } from 'zod/v3';
import fixtureData from '@mahoshojo/contracts/fixtures/openai-responses-stream.json';

const fixture = fixtureData as {
  cases: Array<{ name: string; request: unknown; upstreamEvents: Array<{ type: string }>; events: unknown[] }>;
};

describe('Responses native projection uses the existing text consumer', () => {
  it.each(fixture.cases)('$name shares the typed upstream fixture and consumes normalized events', async (testCase) => {
    const request = AiExecutionRequestSchema.parse(testCase.request);
    const events = testCase.events.map((event) => AiStreamEventSchema.parse(event));
    const result = await collectAiStreamResult(request, events);
    expect(result.status).toBe('completed');
    expect(testCase.upstreamEvents.at(-1)?.type).toBe('response.completed');
    expect(result).toEqual((events.at(-1) as { result: unknown }).result);
    if (testCase.name === 'json' && result.status === 'completed') {
      expect(parseStructuredJsonWithSchema(result.output.text!, z.object({ answer: z.string() })).data).toEqual({ answer: '魔法' });
    }
    if (testCase.name === 'unicode' && result.status === 'completed') expect(result.usage).toBeUndefined();
    if (testCase.name.startsWith('reasoning-dual-') && result.status === 'completed') {
      expect(result.output.reasoning).toBe(testCase.name.endsWith('summary-first') ? '摘要视图。' : '完整推理视图。');
    }
    if (testCase.name === 'reasoning-multi-item' && result.status === 'completed') {
      expect(result.output.reasoning).toBe('先检查，再回答。');
      expect(result.usage).toMatchObject({ cachedInputTokens: 5, reasoningTokens: 4 });
      expect(JSON.stringify(result)).not.toContain('synthetic-opaque');
    }
  });
});

const nativeDirectory = process.env.MAHO_NATIVE_EVENT_FIXTURE_DIR;
it.skipIf(!nativeDirectory)('consumes actual Rust Responses loopback results without a second protocol parser', async () => {
  for (const testCase of fixture.cases) {
    const request = AiExecutionRequestSchema.parse(testCase.request);
    const produced = JSON.parse(readFileSync(join(nativeDirectory!, `responses-${testCase.name}.json`), 'utf8')) as unknown[];
    const actual = await collectAiStreamResult(request, produced);
    const expected = await collectAiStreamResult(request, testCase.events);
    expect(actual).toEqual(expected);
  }
});

it.skipIf(!nativeDirectory)('consumes actual Rust failures while keeping streamed partial text visible', async () => {
  for (const name of ['eof', 'done', 'error', 'failed', 'length', 'filter', 'other', 'wrong-status']) {
    const packet = JSON.parse(readFileSync(join(nativeDirectory!, `responses-failure-${name}.json`), 'utf8')) as {
      request: Record<string, unknown>; events: unknown[]; expectedCode: string;
    };
    // This is a Rust test-context snapshot, not a Native-to-renderer request DTO.
    // The receive-only Rust request mirrors absent Option fields as null on serialization.
    const input = { ...packet.request };
    for (const field of ['modelId', 'maxOutputTokens', 'temperature', 'responseFormat']) {
      if (input[field] === null) delete input[field];
    }
    const request = AiExecutionRequestSchema.parse(input);
    const events = packet.events.map((event) => AiStreamEventSchema.parse(event));
    const result = await collectAiStreamResult(request, events);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.code).toBe(packet.expectedCode);
    const partialText = events.flatMap((event) => event.type === 'text-delta' ? [event.delta] : []).join('');
    expect(partialText).toBe('魔法少女・かなé🪄');
    expect(events.filter((event) => event.type === 'result')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('synthetic-responses-key');
  }
});
