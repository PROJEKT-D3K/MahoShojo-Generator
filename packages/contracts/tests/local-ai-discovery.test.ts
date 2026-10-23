import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LocalAiDiscoveryRequestSchema, LocalAiDiscoveryResponseSchema } from '../src/local-ai-discovery';
const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/local-ai-discovery.json', import.meta.url), 'utf8'));
describe('local discovery strict wire contract', () => {
  it('round trips shared Native/TS request and response fixtures', () => {
    for (const value of fixture.requests) expect(LocalAiDiscoveryRequestSchema.parse(value)).toEqual(value);
    for (const value of fixture.responses) expect(LocalAiDiscoveryResponseSchema.parse(value)).toEqual(value);
  });
  it('rejects raw authority, unknown properties and mutated model IDs', () => {
    for (const value of fixture.invalidRequests) expect(LocalAiDiscoveryRequestSchema.safeParse(value).success).toBe(false);
    for (const value of fixture.invalidResponses) expect(LocalAiDiscoveryResponseSchema.safeParse(value).success).toBe(false);
  });
  it('bounds model count and UTF16 IDs without truncation', () => {
    const value = fixture.responses[0];
    expect(LocalAiDiscoveryResponseSchema.safeParse({ ...value, service: { ...value.service, models: Array(257).fill(value.service.models[0]) } }).success).toBe(false);
    expect(LocalAiDiscoveryResponseSchema.safeParse({ ...value, service: { ...value.service, models: [{ ...value.service.models[0], id: '😀'.repeat(101) }] } }).success).toBe(false);
  });
});
