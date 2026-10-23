import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AiExecutionErrorCodeSchema, AiExecutionRequestSchema } from '@mahoshojo/contracts/ai-execution';
import fixtureData from '@mahoshojo/contracts/fixtures/anthropic-messages-stream.json';
import { z } from 'zod/v3';
import { AiStreamEventSchema, collectAiStreamResult } from '../src/stream-events';
import { parseStructuredJsonWithSchema } from '../src/structured-json';

const fixture = fixtureData as {
  cases: Array<{ name: string; request: unknown; upstreamEvents: Array<{ type: string }>; events: unknown[] }>;
  failureCases: Array<{ name: string; upstreamEvents: unknown[]; expectedCode: string }>;
};

describe('Messages native projection uses the existing text consumer', () => {
  it.each(fixture.cases)('$name consumes normalized events from the shared native fixture', async (testCase) => {
    const request = AiExecutionRequestSchema.parse(testCase.request);
    const events = testCase.events.map((event) => AiStreamEventSchema.parse(event));
    const result = await collectAiStreamResult(request, events);
    expect(result.status).toBe('completed');
    expect(testCase.upstreamEvents.at(-1)?.type).toBe('message_stop');
    expect(result).toEqual((events.at(-1) as { result: unknown }).result);
    if (result.status !== 'completed') throw new Error('Expected completed fixture result');
    expect(JSON.stringify(result)).not.toContain('synthetic-opaque');
    expect(result.usage?.totalTokens).toBeUndefined();
    expect(result.usage?.reasoningTokens).toBeUndefined();
    if (testCase.name === 'json') {
      expect(parseStructuredJsonWithSchema(result.output.text!, z.object({ answer: z.string() })).data).toEqual({ answer: '魔法' });
    }
    if (['unicode', 'empty-usage'].includes(testCase.name)) expect(result.usage).toBeUndefined();
    if (testCase.name === 'reasoning-and-cache') {
      expect(result.output.reasoning).toBe('先检查，再回答。');
      // Preserve provider input_tokens, not a fabricated input + cache-read + cache-write total.
      expect(result.usage).toEqual({ inputTokens: 17, outputTokens: 12, cachedInputTokens: 6 });
    }
    if (testCase.name === 'stop-sequence') {
      expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
      expect(result.finishReason).toBe('stop');
    }
  });

  it('names native failure expectations with existing normalized error codes', () => {
    for (const testCase of fixture.failureCases) {
      expect(AiExecutionErrorCodeSchema.parse(testCase.expectedCode)).toBe(testCase.expectedCode);
      expect(testCase.upstreamEvents.length).toBeGreaterThan(0);
    }
  });
});

const nativeDirectory = process.env.MAHO_NATIVE_EVENT_FIXTURE_DIR;
it.skipIf(!nativeDirectory)('consumes actual Rust Messages loopback results without a second protocol parser', async () => {
  for (const testCase of fixture.cases) {
    const request = AiExecutionRequestSchema.parse(testCase.request);
    const produced = JSON.parse(readFileSync(join(nativeDirectory!, `anthropic-${testCase.name}.json`), 'utf8')) as unknown[];
    const actual = await collectAiStreamResult(request, produced);
    const expected = await collectAiStreamResult(request, testCase.events);
    expect(actual).toEqual(expected);
  }
});

it.skipIf(!nativeDirectory)('consumes actual Rust Messages failures with one safe terminal event', async () => {
  // Transport closes after its first terminal result. A later duplicate stop is
  // rejected by the reducer unit test, not read from an already closed body.
  for (const testCase of fixture.failureCases.filter(({ name }) => name !== 'duplicate-message-stop')) {
    const packet = JSON.parse(readFileSync(join(nativeDirectory!, `anthropic-failure-${testCase.name}.json`), 'utf8')) as {
      request: Record<string, unknown>; events: unknown[]; expectedCode: string;
    };
    const input = { ...packet.request };
    // This test-context snapshot is not a native-to-renderer request DTO.
    for (const field of ['modelId', 'maxOutputTokens', 'temperature', 'responseFormat']) {
      if (input[field] === null) delete input[field];
    }
    const request = AiExecutionRequestSchema.parse(input);
    const events = packet.events.map((event) => AiStreamEventSchema.parse(event));
    const result = await collectAiStreamResult(request, events);
    expect(packet.expectedCode).toBe(testCase.expectedCode);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.code).toBe(testCase.expectedCode);
    expect(events.filter((event) => event.type === 'result')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('synthetic-secret');
    expect(JSON.stringify(events)).not.toContain('synthetic-opaque');
  }
});
