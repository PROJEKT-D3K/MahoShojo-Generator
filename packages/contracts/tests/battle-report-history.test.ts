import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/battle-report-history.json';
import { BATTLE_REPORT_DETAIL_MAX_BYTES, BATTLE_REPORT_LIST_MAX_BYTES, BattleReportDetailSchema, BattleReportListSchema, DesktopBattleReportRequestSchema, DesktopBattleReportResponseSchema, checkBattleReportExpectedViewer } from '../src/battle-report-history';

describe('server battle report history contract', () => {
  it('validates shared small goldens and independent read budgets', () => {
    expect(BATTLE_REPORT_LIST_MAX_BYTES).toBe(fixture.budgets.list);
    expect(BATTLE_REPORT_DETAIL_MAX_BYTES).toBe(fixture.budgets.detail);
    for (const data of [fixture.list, fixture.detail]) expect(DesktopBattleReportResponseSchema.safeParse({ userId: 42, data }).success).toBe(true);
    for (const request of [fixture.listRequest, fixture.detailRequest]) expect(DesktopBattleReportRequestSchema.safeParse(request).success).toBe(true);
  });
  it.each(['kind', 'method', 'url', 'headers', 'cookie', 'body', 'path', 'query'])('rejects unexpected IPC capability %s', (field) => {
    expect(DesktopBattleReportRequestSchema.safeParse({ ...fixture.detailRequest, [field]: 'escape' }).success).toBe(false);
  });
  it.each(['../escape', '%2e%2e', 'a/b', 'a?b', 'a#b', 'a\\b', 'generation-1\n', 'generation-1\r\n', 'generation-1\u2028', '', 'x'.repeat(201)])('rejects path input %s', (generationId) => {
    expect(DesktopBattleReportRequestSchema.safeParse({ ...fixture.detailRequest, generationId }).success).toBe(false);
  });
  it.each([{ pageSize: 31 }, { page: 0 }, { q: '字'.repeat(121) }, { mode: 'strict' }, { extra: true }])('rejects filters outside the fixed read surface', (patch) => {
    expect(DesktopBattleReportRequestSchema.safeParse({ ...fixture.listRequest, filters: { ...fixture.listRequest.filters, ...patch } }).success).toBe(false);
  });
  it('requires object envelopes/filters and accepts JSON integer notation consistently', () => {
    for (const request of [
      ['detail', 42, 'generation-1'], ['list', 42, fixture.listRequest.filters],
      { ...fixture.listRequest, filters: [1, 10, '', '', '', false, 'started_at_desc', ''] },
    ]) expect(DesktopBattleReportRequestSchema.safeParse(request).success).toBe(false);
    expect(DesktopBattleReportRequestSchema.safeParse(JSON.parse(JSON.stringify(fixture.listRequest).replace('"page":1', '"page":1.0').replace('"pageSize":10', '"pageSize":10.0'))).success).toBe(true);
    for (const field of ['page', 'pageSize']) for (const value of [0, -1, 1.5, null, '1', [1], 4294967296]) {
      expect(DesktopBattleReportRequestSchema.safeParse({ ...fixture.listRequest, filters: { ...fixture.listRequest.filters, [field]: value } }).success).toBe(false);
    }
  });
  it('keeps unknown historical identifiers listable and requires real viewer metadata', () => {
    expect(BattleReportListSchema.safeParse({ ...fixture.list, records: [{ ...fixture.list.records[0], id: '旧标识:opaque' }] }).success).toBe(true);
    const legacy: Partial<typeof fixture.detail> = { ...fixture.detail };
    delete legacy.viewerUserId;
    expect(BattleReportDetailSchema.safeParse(legacy).success).toBe(false);
    expect(BattleReportDetailSchema.safeParse({ ...fixture.detail, credentials: 'secret' }).success).toBe(false);
  });
  it('preserves legacy server callers but rejects malformed or mismatched guarded viewers', () => {
    expect(checkBattleReportExpectedViewer(new URLSearchParams(), 42)).toBeNull();
    expect(checkBattleReportExpectedViewer(new URLSearchParams('expectedUserId=42'), 42)).toBeNull();
    expect(checkBattleReportExpectedViewer(new URLSearchParams('expectedUserId=43'), 42)).toBe('mismatch');
    for (const value of ['', '0', '-1', '1.5', '42&expectedUserId=42', '9007199254740992', '42%0A', '42%0D%0A']) expect(checkBattleReportExpectedViewer(new URLSearchParams(`expectedUserId=${value}`), 42)).toBe('invalid');
  });
});
