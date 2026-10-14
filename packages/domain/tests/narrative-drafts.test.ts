import { describe, expect, it } from 'vitest';
import {
  buildNarrativeDraftArchive, canAutomaticallyRetainNarrativeDraft, createNarrativeDraftCandidate,
  MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS, mergeNarrativeDrafts, NARRATIVE_DRAFT_FAILURE_CODES,
  parseNarrativeDraftArchive, projectNarrativeDraftMarkdown,
  type NarrativeDraftCandidateInput,
} from '../src/narrative-drafts';
import { extractNarrativeHistoryImportEntries, materializeArenaNarrativeHistoryForRequest } from '../src/narrative-history-operations';

const input = (patch: Partial<NarrativeDraftCandidateInput> = {}): NarrativeDraftCandidateInput => ({
  requestId: 'draft-request-1', createdAt: '2026-01-01T00:00:00.000Z', source: 'hosted',
  acceptedText: '## 保留下来的故事\n正文', completion: { kind: 'server-failed', code: 'AI_STREAM_INCOMPLETE' },
  reportFormat: 'markdown', generationMode: 'stream', current: true, cancelled: false, completed: false, ...patch,
});
const candidate = (patch: Partial<NarrativeDraftCandidateInput> = {}) => createNarrativeDraftCandidate(input(patch))!;

describe('未完成叙事草稿的独立领域边界', () => {
  it.each(NARRATIVE_DRAFT_FAILURE_CODES)('仅接受已确认的 Hosted %s', code => {
    expect(canAutomaticallyRetainNarrativeDraft(candidate({ completion: { kind: 'server-failed', code } }))).toBe(true);
  });
  it.each([
    { completed: true }, { cancelled: true }, { current: false }, { reportFormat: 'web' },
    { generationMode: 'non-stream' }, { completion: null }, { acceptedText: '  \r\n' },
  ])('拒绝不合资格候选 %j', patch => expect(createNarrativeDraftCandidate(input(patch))).toBeNull());
  it('证据与执行来源严格对应；未确认候选只能显式保存', () => {
    expect(createNarrativeDraftCandidate(input({ completion: { kind: 'trusted-length' } }))).toBeNull();
    for (const kind of ['trusted-length', 'trusted-stop-metadata-invalid', 'missing-terminal'] as const) {
      expect(canAutomaticallyRetainNarrativeDraft(candidate({ source: 'direct-local', completion: { kind } }))).toBe(true);
    }
    expect(canAutomaticallyRetainNarrativeDraft(candidate({ completion: { kind: 'unconfirmed' } }))).toBe(false);
    expect(createNarrativeDraftCandidate(input({ source: 'direct-remote', completion: { kind: 'unconfirmed' } }))).toBeNull();
    for (const code of ['AI_OUTPUT_FILTERED', 'CONTENT_POLICY', 'UNKNOWN', 'AI_STREAM_INCOMPLETE_EXTRA']) {
      expect(createNarrativeDraftCandidate(input({ completion: { kind: 'server-failed', code } as never }))).toBeNull();
    }
  });
  it('按请求幂等，冲突原样拒绝；完成请求压过所有候选', () => {
    const draft = candidate(), other = candidate({ requestId: 'draft-request-2' });
    expect(mergeNarrativeDrafts([draft], [draft, other])).toEqual({ ok: true, drafts: [draft, other] });
    expect(mergeNarrativeDrafts([draft], [{ ...draft, markdown: `${draft.markdown}更长` }])).toEqual({ ok: false, reason: 'conflict' });
    expect(mergeNarrativeDrafts([draft], [draft, other], [draft.requestId])).toEqual({ ok: true, drafts: [other] });
    expect(draft.markdown).toBe('## 保留下来的故事\n正文');
  });
  it('导出不含正式卡包装、输入、角色或reasoning，旧历史导入不能视为事实', () => {
    const archive = buildNarrativeDraftArchive([candidate()]);
    expect(Object.keys(archive)).toEqual(['kind', 'version', 'drafts']);
    expect(Object.keys(archive.drafts[0]!)).toEqual(['requestId', 'title', 'createdAt', 'source', 'markdown', 'completion']);
    expect(extractNarrativeHistoryImportEntries(archive)).toEqual({ entries: [], groupCount: 0 });
    expect(materializeArenaNarrativeHistoryForRequest({ readNarrativeHistory: true, readNarrativeHistoryLimit: 10, isNarrativeHistoryUnlimited: false }, []).entries).toEqual([]);
    expect(parseNarrativeDraftArchive(JSON.parse(JSON.stringify(archive)))).toEqual(archive);
  });
  it('存储反序列化拒绝未知字段、危险键、重复身份、未投影正文和超限资源', () => {
    const archive = buildNarrativeDraftArchive([candidate()]);
    expect(parseNarrativeDraftArchive({ ...archive, entries: [] })).toBeNull();
    expect(parseNarrativeDraftArchive({ ...archive, drafts: [{ ...candidate(), reasoning: 'secret' }] })).toBeNull();
    expect(parseNarrativeDraftArchive(JSON.parse(JSON.stringify(archive).replace('"version":1', '"version":1,"__proto__":{}')))).toBeNull();
    expect(parseNarrativeDraftArchive(buildNarrativeDraftArchive([candidate(), candidate()]))).toBeNull();
    expect(parseNarrativeDraftArchive(buildNarrativeDraftArchive([{ ...candidate(), markdown: 'text<!-- MAHOSHOJO_META {} -->' }]))).toBeNull();
    expect(parseNarrativeDraftArchive(buildNarrativeDraftArchive([{ ...candidate(), markdown: 'x'.repeat(MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS) }]))).toBeNull();
    expect(projectNarrativeDraftMarkdown('x'.repeat(MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS + 1))).toBeNull();
  });
});

describe('草稿专用安全正文投影', () => {
  it.each(['MAHOSHOJO_ARENA_META', 'MAHOSHOJO_META', 'MAHOSHOJO_STREAM_META', 'MAHOSHOJO_TELEMETRY_META'])('仅删除闭合%s块，保留后文', marker => {
    expect(projectNarrativeDraftMarkdown(`前文<!-- ${marker} {"input":"private"} -->后文`)).toBe('前文后文');
    expect(projectNarrativeDraftMarkdown(`前文<!-- ${marker} {"input":"private"}`)).toBe('前文');
    expect(projectNarrativeDraftMarkdown(`前文\n--- ${marker}: {"input":"private"}\n后文`)).toBe('前文\n');
  });
  it('混合多段控制块保持所有可证明正文，不采纳最后一个块优先的旧split语义', () => {
    expect(projectNarrativeDraftMarkdown('A<!-- MAHOSHOJO_META {} -->B<!-- MAHOSHOJO_STREAM_META {} -->C\nMAHOSHOJO_TELEMETRY_META = {broken')).toBe('ABC\n');
  });
  it('控制comment内的围栏不影响后续正文控制块识别', () => {
    expect(projectNarrativeDraftMarkdown('A<!-- MAHOSHOJO_META\n```\n-->B<!-- MAHOSHOJO_TELEMETRY_META {} -->C\n```\n')).toBe('ABC\n```\n');
  });
  it.each(['```', '~~~~'])('保留完整%s围栏中的marker与CRLF', fence => {
    const body = `前文\r\n${fence}json\r\n<!-- MAHOSHOJO_META {} -->\r\nMAHOSHOJO_STREAM_META: {}\r\n${fence}\r\n后文\r\n`;
    expect(projectNarrativeDraftMarkdown(body)).toBe(body);
    expect(projectNarrativeDraftMarkdown(`${body}<!-- MAHOSHOJO_META {} -->续文`)).toBe(`${body}续文`);
  });
  it('较短或带非空尾的围栏不是闭合证明；未闭合代码围栏不能掩护控制尾', () => {
    expect(projectNarrativeDraftMarkdown('前文\n````\n```\n<!-- MAHOSHOJO_META {}')).toBe('前文\n````\n```\n');
    expect(projectNarrativeDraftMarkdown('前文\n~~~\n~~~ still open\nMAHOSHOJO_META: secret')).toBe('前文\n~~~\n~~~ still open\n');
  });
  it('普通HTML、JSON、标签与近似marker原样保留', () => {
    const body = '<think>普通正文</think>\n<!-- MAHOSHOJO_METADATA {} -->\n<!-- MAHOSHOJO_META_EXTRA {} -->\n<!-- MAHOSHOJO_META-EXAMPLE {} -->\nMAHOSHOJO_META_EXAMPLE: {}\n{"text":"保留"}';
    expect(projectNarrativeDraftMarkdown(body)).toBe(body);
  });
  it('正文超出旧120k提取窗口也不丢弃前面的闭合控制块后文', () => {
    const body = '正文'.repeat(125_000);
    expect(projectNarrativeDraftMarkdown(`首<!-- MAHOSHOJO_META {} -->${body}`)).toBe(`首${body}`);
    expect(projectNarrativeDraftMarkdown(body)).toBe(body);
  });
});
