import { describe, expect, it } from 'vitest';
import {
  buildNarrativeDraftArchive, canAutomaticallyRetainNarrativeDraft, classifyNarrativeDraftRetention, createNarrativeDraftCandidate,
  hasExplicitNarrativeDraftRejection,
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

describe('自动保留只使用有限的内容风险启发式，不证明叙事语义', () => {
  it.each([
    '风起。', '# 灯\n她回来了。', '# 错误\n少女终于找到了谜底。',
    '她说：“抱歉，我无法帮助你完成这个请求。”随后转身离开。',
    '# 月下\n“我不能提供这样的内容。”少女读完信，笑了。',
    '# A story\n"I cannot help with that request," she said, closing the door.',
    'I cannot help but smile as she opens the door.', '我无法抑制激动，向她跑去。', '400 riders crossed the valley.',
    '```text\nError: request failed\nI cannot assist with that request.\n```\n她擦去了终端上的文字。',
    '她的终端显示 {"error":"request failed"}，而窗外天已亮。',
  ])('短正文、标题和故事中的错误/拒绝引用不失去自动保留资格：%s', acceptedText => {
    const draft = candidate({ acceptedText });
    expect(draft.markdown).toBe(acceptedText);
    expect(classifyNarrativeDraftRetention(draft)).toEqual({ mode: 'automatic' });
  });
  it.each([
    'Error: upstream request failed', 'HTTP 429 Too Many Requests', '502 Bad Gateway', '服务暂时不可用，请稍后重试。',
    '抱歉，我无法为你生成这个故事。', '很抱歉，我不能帮助你完成这个请求。',
    "I'm sorry, but I can't assist with that request.", "Sorry, I can't do that.", 'As an AI language model, I cannot generate that content.',
    '# 未完成的故事\n\n抱歉，我无法完成这个请求。',
    '**Error: rate limit exceeded**', '{"error":{"message":"request failed","code":"rate_limit"}}',
    '{"refusal":"I cannot assist with that request."}',
    '抱歉，我无法满足这个请求。'.repeat(100),
  ])('可疑文本只降级为显式保留，原文和旧档案都不丢失：%s', acceptedText => {
    const draft = candidate({ acceptedText, completion: { kind: 'server-failed', code: 'AI_UPSTREAM_REQUEST_FAILED' } });
    expect(draft.markdown).toBe(acceptedText);
    expect(canAutomaticallyRetainNarrativeDraft(draft)).toBe(false);
    expect(classifyNarrativeDraftRetention(draft)).toEqual({ mode: 'explicit-only', reason: 'suspected-non-narrative' });
    const archive = buildNarrativeDraftArchive([draft]);
    // Explicit save/export and pre-existing archives use structural validation, never the new heuristic.
    expect(parseNarrativeDraftArchive(JSON.parse(JSON.stringify(archive)))).toEqual(archive);
    expect(mergeNarrativeDrafts([], [draft])).toEqual({ ok: true, drafts: [draft] });
  });
  it('未确认传输与正文可疑度是独立维度', () => {
    expect(classifyNarrativeDraftRetention(candidate({ acceptedText: '灯亮了。', completion: { kind: 'unconfirmed' } })))
      .toEqual({ mode: 'explicit-only', reason: 'unconfirmed-completion' });
    for (const kind of ['trusted-length', 'trusted-stop-metadata-invalid', 'missing-terminal'] as const) {
      expect(canAutomaticallyRetainNarrativeDraft(candidate({ source: 'direct-local', completion: { kind }, acceptedText: 'Error: request failed' }))).toBe(false);
    }
  });
  it('结构化拒绝检查只检查内容envelope顶层，不扫描故事字符串或嵌套角色字段', () => {
    for (const signal of [{ refusal: 'refused' }, { error: { code: 'failed' } }, { type: 'refusal' }, { status: 'refused' }, { finishReason: 'content-filter' }]) {
      expect(hasExplicitNarrativeDraftRejection(signal)).toBe(true);
    }
    for (const value of [null, 'refusal', { refusal: null, error: false }, { article: { error: '故事内容' } }, { text: 'I cannot help with that request.' }, { type: { toString: 'not a function' } }]) {
      expect(hasExplicitNarrativeDraftRejection(value)).toBe(false);
    }
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
