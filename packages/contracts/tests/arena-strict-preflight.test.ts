import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/arena-strict-preflight.json';
import {
  DesktopStrictPreflightRequestSchema,
  DesktopStrictPreflightResponseSchema,
  STRICT_PREFLIGHT_MAX_BYTES,
  STRICT_PREFLIGHT_VERSION,
} from '../src/arena-strict-preflight';

const objectAt = (root: unknown, path: string): Record<string, unknown> => path.split('/').filter(Boolean)
  .reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], root) as Record<string, unknown>;
const patch = (root: unknown, path: string, value: unknown): unknown => {
  const result: unknown = structuredClone(root);
  const keys = path.split('/').filter(Boolean);
  const key = keys.pop()!;
  objectAt(result, keys.join('/'))[key] = value;
  return result;
};
const without = (root: unknown, path: string, field: string): unknown => {
  const result: unknown = structuredClone(root);
  delete objectAt(result, path)[field];
  return result;
};

describe('account-bound advisory Strict preflight contract', () => {
  it('validates the shared Native/renderer golden and explicit version/budget', () => {
    expect(STRICT_PREFLIGHT_MAX_BYTES).toBe(fixture.maxBytes);
    expect(STRICT_PREFLIGHT_VERSION).toBe(fixture.response.preflightVersion);
    expect(fixture.path).toBe('/api/arena/strict-preflight');
    expect(DesktopStrictPreflightRequestSchema.parse(fixture.request)).toEqual(fixture.request);
    expect(DesktopStrictPreflightResponseSchema.parse(fixture.response)).toEqual(fixture.response);
  });
  it.each(['url', 'path', 'method', 'headers', 'cookie', 'credentials', 'apiKey', 'secretRef', 'endpoint', 'baseUrl', 'authorization', 'extra'])('rejects %s injection at every request object boundary', (field) => {
    for (const path of ['', 'body', 'body/settings', 'body/combatants/0']) {
      expect(DesktopStrictPreflightRequestSchema.safeParse(patch(fixture.request, `${path}/${field}`, 'escape')).success).toBe(false);
    }
    const provider = patch(fixture.request, 'body/customProvider', { providerId: 'test', modelId: 'test', [field]: 'escape' });
    expect(DesktopStrictPreflightRequestSchema.safeParse(provider).success).toBe(false);
  });
  it('rejects nested viewer injection and positional arrays in every object', () => {
    expect(DesktopStrictPreflightRequestSchema.safeParse(patch(fixture.request, 'body/expectedUserId', 43)).success).toBe(false);
    expect(DesktopStrictPreflightRequestSchema.safeParse(Object.values(fixture.request)).success).toBe(false);
    for (const path of ['body', 'body/settings', 'body/combatants/0']) {
      expect(DesktopStrictPreflightRequestSchema.safeParse(patch(fixture.request, path, Object.values(objectAt(fixture.request, path)))).success).toBe(false);
    }
    expect(DesktopStrictPreflightRequestSchema.safeParse(patch(fixture.request, 'body/customProvider', ['test', 'test'])).success).toBe(false);
    expect(DesktopStrictPreflightRequestSchema.safeParse(patch(fixture.request, 'body/customProvider', null)).success).toBe(false);
    expect(DesktopStrictPreflightRequestSchema.safeParse(patch(fixture.request, 'body/customProvider', { providerId: 'system', modelId: 'test' })).success).toBe(true);
  });
  it('requires nullable request keys to be present', () => {
    for (const [path, key] of [['body', 'scenarioFileName'], ['body/combatants/0', 'filename'], ['body/combatants/0', 'sourceDataCardId'], ['body/combatants/0', 'characterGuidance']]) {
      expect(DesktopStrictPreflightRequestSchema.safeParse(without(fixture.request, path, key)).success).toBe(false);
      expect(DesktopStrictPreflightRequestSchema.safeParse(patch(fixture.request, `${path}/${key}`, null)).success).toBe(true);
    }
  });
  it('matches JS safe integer and bounded count semantics', () => {
    for (const path of ['expectedUserId', 'body/auxScenarioCount', 'body/materialCount', 'body/adjudicationEventCount']) {
      for (const value of [-1, 7.5, Number.MAX_SAFE_INTEGER + 1, '7', null, [7]]) {
        expect(DesktopStrictPreflightRequestSchema.safeParse(patch(fixture.request, path, value)).success).toBe(false);
      }
      expect(DesktopStrictPreflightRequestSchema.safeParse(patch(fixture.request, path, JSON.parse('7.0'))).success).toBe(true);
    }
    expect(DesktopStrictPreflightRequestSchema.safeParse(patch(fixture.request, 'expectedUserId', 0)).success).toBe(false);
    expect(DesktopStrictPreflightRequestSchema.safeParse(patch(fixture.request, 'expectedUserId', Number.MAX_SAFE_INTEGER)).success).toBe(true);
    for (const path of ['body/auxScenarioCount', 'body/materialCount', 'body/adjudicationEventCount']) {
      expect(DesktopStrictPreflightRequestSchema.safeParse(patch(fixture.request, path, 256)).success).toBe(true);
      expect(DesktopStrictPreflightRequestSchema.safeParse(patch(fixture.request, path, 257)).success).toBe(false);
    }
  });
  it('uses UTF-16 limits and ECMAScript trim for identifiers', () => {
    for (const [path, max] of [['body/language', 64], ['body/settings/userGuidance', 200], ['body/combatants/0/characterGuidance', 2000], ['body/combatants/0/sourceDataCardId', 256]] as const) {
      expect(DesktopStrictPreflightRequestSchema.safeParse(patch(fixture.request, path, '😀'.repeat(max / 2))).success).toBe(true);
      expect(DesktopStrictPreflightRequestSchema.safeParse(patch(fixture.request, path, `${'😀'.repeat(max / 2)}x`)).success).toBe(false);
    }
    const parsed = DesktopStrictPreflightRequestSchema.parse(patch(fixture.request, 'body/combatants/0/sourceDataCardId', '\uFEFF  card-a \uFEFF'));
    expect(parsed.body.combatants[0].sourceDataCardId).toBe('card-a');
    expect(DesktopStrictPreflightRequestSchema.safeParse(patch(fixture.request, 'body/combatants/0/sourceDataCardId', '\uFEFF \t')).success).toBe(false);
    expect(DesktopStrictPreflightRequestSchema.parse(patch(fixture.request, 'body/combatants/0/sourceDataCardId', '\u0085')).body.combatants[0].sourceDataCardId).toBe('\u0085');
  });
  it('bounds request lists and rejects invalid enum values', () => {
    for (const [path, value] of [
      ['body/combatants', Array.from({ length: 33 }, () => fixture.request.body.combatants[0])],
      ['body/questionnaireLoreIds', Array.from({ length: 21 }, () => 'id')],
      ['body/battleMode', 'strict'], ['body/storyLength', 'huge'], ['body/language', ''],
    ] as const) expect(DesktopStrictPreflightRequestSchema.safeParse(patch(fixture.request, path, value)).success).toBe(false);
  });
  it('requires current server version, viewer metadata and a coherent decision', () => {
    for (const field of ['success', 'preflightVersion', 'viewerUserId', 'range', 'daily', 'pair', 'reasons']) {
      expect(DesktopStrictPreflightResponseSchema.safeParse(without(fixture.response, '', field)).success).toBe(false);
    }
    for (const [path, value] of [['success', false], ['preflightVersion', 'old'], ['viewerUserId', 0], ['willCount', false], ['reasons', ['blocked']]] as const) {
      expect(DesktopStrictPreflightResponseSchema.safeParse(patch(fixture.response, path, value)).success).toBe(false);
    }
    expect(DesktopStrictPreflightResponseSchema.safeParse({ ...fixture.response, willCount: false, reasons: ['额度未知'] }).success).toBe(true);
  });
  it('requires explicit nullable response fields and object-only nested records', () => {
    for (const [path, fields] of [['daily', ['used', 'exceeded', 'sinceIso']], ['pair', ['used', 'exceeded', 'recentDeduped', 'recentAppliedAtIso', 'nextEligibleAtIso']]] as const) {
      for (const field of fields) {
        expect(DesktopStrictPreflightResponseSchema.safeParse(without(fixture.response, path, field)).success).toBe(false);
        expect(DesktopStrictPreflightResponseSchema.safeParse(patch(fixture.response, `${path}/${field}`, null)).success).toBe(true);
      }
    }
    expect(DesktopStrictPreflightResponseSchema.safeParse(patch(fixture.response, 'range', null)).success).toBe(true);
    expect(DesktopStrictPreflightResponseSchema.safeParse(Object.values(fixture.response)).success).toBe(false);
    for (const path of ['range', 'daily', 'pair']) {
      expect(DesktopStrictPreflightResponseSchema.safeParse(patch(fixture.response, path, Object.values(objectAt(fixture.response, path)))).success).toBe(false);
    }
  });
  it('rejects unknown output fields, invalid numbers and oversized reason/date text', () => {
    for (const path of ['', 'range', 'daily', 'pair']) {
      expect(DesktopStrictPreflightResponseSchema.safeParse(patch(fixture.response, `${path}/privateMetadata`, 'secret')).success).toBe(false);
    }
    for (const [path, value] of [
      ['daily/limit', 1.5], ['daily/used', Number.MAX_SAFE_INTEGER + 1], ['pair/windowMinutes', -1],
      ['range/aGames', 7.5], ['range/absDiff', -1], ['range/aRating', Number.MAX_SAFE_INTEGER + 1],
      ['range/bRating', -Number.MAX_SAFE_INTEGER - 1], ['daily/sinceIso', '😀'.repeat(65)],
    ] as const) expect(DesktopStrictPreflightResponseSchema.safeParse(patch(fixture.response, path, value)).success).toBe(false);
    for (const reasons of [[''], ['😀'.repeat(101)], Array.from({ length: 65 }, () => 'blocked')]) {
      expect(DesktopStrictPreflightResponseSchema.safeParse({ ...fixture.response, willCount: false, reasons }).success).toBe(false);
    }
  });
});
