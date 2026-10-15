import fixture from '../fixtures/desktop-message-browser.json';
import { describe, expect, it } from 'vitest';
import { DesktopOpenCloudMessagePageRequestSchema as schema } from '../src/desktop-ipc';
describe('fixed message browser request', () => {
  it.each(fixture)('normalizes server-compatible reference $request.appealId', ({ request, expected }) => {
    const parsed = schema.safeParse(request);
    if (expected === null) expect(parsed.success).toBe(false);
    else { expect(parsed.success).toBe(true); if (parsed.success) expect(parsed.data).toEqual(expected); }
  });
  it.each([{ page: 'investigation' }, { page: 'report-appeals' }, { page: 'report-appeals', appealId: 'legacy id&/?' }, { page: 'report-appeals', reportCaseId: 'case-1' }])('accepts %j', request => {
    expect(schema.parse(request)).toEqual(request);
  });
  it.each([[], ['investigation'], null, {}, { page: 'other' }, { page: 'investigation', appealId: 'x' }, { page: 'report-appeals', appealId: null }, { page: 'report-appeals', appealId: 'x', reportCaseId: 'y' }, { page: 'report-appeals', appealId: '' }, { page: 'report-appeals', appealId: 'x\ny' }])('rejects %j', request => {
    expect(schema.safeParse(request).success).toBe(false);
  });
  it.each(['url', 'origin', 'token', 'returnTo', 'query', 'userId'])('rejects injected %s', key => {
    expect(schema.safeParse({ page: 'report-appeals', [key]: 'untrusted' }).success).toBe(false);
  });
});
