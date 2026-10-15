import { describe, expect, it } from 'vitest';
import { resolveMessageDestination } from '../src/features/messages/message-destination';
import { DELIVERED_ROUTES } from '../src/app/delivered-routes';

describe('Desktop message destinations', () => {
  it.each(DELIVERED_ROUTES.filter(path => !path.includes('[')))('keeps delivered %s local with search/fragment', (path) => {
    const href = `${path}?tab=mine#section`;
    expect(resolveMessageDestination(href)).toEqual({ kind: 'local', href });
  });
  it('keeps encyclopedia articles local', () => {
    expect(resolveMessageDestination('/encyclopedia/site-guide#角色生成').kind).toBe('local');
  });
  it.each([
    ['/investigation', { page: 'investigation' }],
    ['/report-appeals', { page: 'report-appeals' }],
    ['/report-appeals?appealId=11a132af-68f6-46d3-befd-a78258d486e0', { page: 'report-appeals', appealId: '11a132af-68f6-46d3-befd-a78258d486e0' }],
    ['/report-appeals?reportCaseId=legacy%20case%26%2F%3F', { page: 'report-appeals', reportCaseId: 'legacy case&/?' }],
  ])('maps producer href %s to fixed request', (href, request) => {
    expect(resolveMessageDestination(href as string)).toEqual({ kind: 'browser', request });
  });
  it.each([
    'https://evil.test/investigation', '//evil.test', '/\\evil.test', '/%69nvestigation', '/foo/../investigation',
    '/investigation?token=x', '/investigation#x', '/report-appeals?appealId=x&appealId=y',
    '/report-appeals?appealId=x&reportCaseId=y', '/report-appeals?returnTo=https://evil.test',
    '/report-appeals?appealId=%FF', '/report-appeals?appealId=%ZZ', '/report-appeals?appealId=', '/report-appeals?appealId=%0A', '/report-appeals?appealId=%20',
    '/report-appeals?appealId=x#x', '/report-appeals/extra', '/admin', '/encyclopedia/[slug]',
    '/investigation\n', '/character-manager%2F', '/report-appeals?appealId=' + 'x'.repeat(2048),
  ])('gives understandable unavailable feedback for %s', (href) => {
    expect(resolveMessageDestination(href)).toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('网页版消息中心') });
  });
});
