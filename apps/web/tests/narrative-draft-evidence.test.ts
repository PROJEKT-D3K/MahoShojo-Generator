import { describe, expect, it } from 'vitest';
import {
  buildNarrativeDraftArchive, canAutomaticallyRetainNarrativeDraft, createNarrativeDraftCandidate,
  NARRATIVE_DRAFT_FAILURE_CODES, parseNarrativeDraftArchive,
} from '@mahoshojo/domain/narrative-drafts';
import { createHostedNarrativeDraftEvidence } from '@/lib/arena/narrative-draft-evidence';

const block = (id: number, event: string, payload: unknown) => `id: ${id}-0\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
const openedEvidence = () => {
  const evidence = createHostedNarrativeDraftEvidence();
  evidence.onRequestIdentity('draft-request');
  evidence.observeResponse(new Response('', { headers: {
    'Content-Type': 'text/event-stream', 'X-Mahoshojo-Generation-Request-Id': 'draft-request', 'X-Mahoshojo-Generation-Id': 'generation',
  } }));
  return evidence;
};
const evidenceFor = (markdown: string, content: Record<string, unknown> = {}, event: 'markdown' | 'snapshot' = 'markdown', code = 'AI_UPSTREAM_REQUEST_FAILED') => {
  const evidence = openedEvidence();
  evidence.observeBlock(block(1, event, { [event === 'markdown' ? 'chunk' : 'markdown']: markdown, ...content }));
  evidence.observeBlock(block(2, 'error', { status: 'failed', ok: false, code, error: 'upstream unavailable' }));
  evidence.onTerminalBoundary({ kind: 'terminal', bufferedTail: '', rejectedEvent: false });
  return evidence.resolve(markdown);
};
const candidateFor = (markdown: string, event: 'markdown' | 'snapshot' = 'markdown', content: Record<string, unknown> = {}) => {
  const evidence = evidenceFor(markdown, content, event);
  return evidence && createNarrativeDraftCandidate({
    ...evidence, acceptedText: markdown, source: 'hosted', createdAt: '2026-01-01T00:00:00Z',
    current: true, cancelled: false, completed: false, reportFormat: 'markdown', generationMode: 'stream',
  });
};

describe('Hosted草稿传输证据不冒充正文质量证明', () => {
  it.each(NARRATIVE_DRAFT_FAILURE_CODES)('通用%s及诊断文案不阻止已收到的短正文', code => {
    expect(evidenceFor('她回来了。', {}, 'markdown', code)).toEqual({
      requestId: 'draft-request', completion: { kind: 'server-failed', code },
    });
    expect(canAutomaticallyRetainNarrativeDraft(candidateFor('她回来了。')!)).toBe(true);
  });
  it.each(['markdown', 'snapshot'] as const)('%s的明确拒绝/错误不因后续通用上游失败恢复资格', event => {
    for (const content of [
      { refusal: '无法完成请求' }, { refusal: true }, { error: { code: 'provider-refused' } },
      { type: 'error' }, { status: 'refused' }, { finishReason: 'content-filter' }, { finish_reason: 'content_filter' },
    ]) expect(evidenceFor('非空文本', { ...(event === 'snapshot' ? { status: 'failed' } : {}), ...content }, event)).toBeNull();
  });
  it.each([false, true])('服务端failed快照是传输状态，短正文保留资格（仅补状态=%s）', emptySnapshot => {
    const markdown = '她回来了。';
    const evidence = openedEvidence();
    if (emptySnapshot) evidence.observeBlock(block(1, 'markdown', { chunk: markdown }));
    // Shapes emitted by createTerminalFallbackSubscription / enqueueTerminalSnapshot.
    evidence.observeBlock(block(2, 'snapshot', {
      status: 'failed', markdown: emptySnapshot ? '' : markdown, reasoning: '',
      lastEventId: null, updatedAt: '2026-01-01T00:00:00Z', terminalResultRef: null,
    }));
    evidence.observeBlock(block(3, 'error', { ok: false, status: 'failed', code: 'AI_STREAM_INCOMPLETE', message: '连接提前结束' }));
    evidence.onTerminalBoundary({ kind: 'terminal', bufferedTail: '', rejectedEvent: false });
    const resolved = evidence.resolve(markdown);
    expect(resolved).toEqual({ requestId: 'draft-request', completion: { kind: 'server-failed', code: 'AI_STREAM_INCOMPLETE' } });
    const draft = resolved && createNarrativeDraftCandidate({
      ...resolved, acceptedText: markdown, source: 'hosted', createdAt: '2026-01-01T00:00:00Z',
      current: true, cancelled: false, completed: false, reportFormat: 'markdown', generationMode: 'stream',
    });
    expect(draft?.markdown).toBe(markdown);
    expect(canAutomaticallyRetainNarrativeDraft(draft!)).toBe(true);
  });
  it('明确结构化拒绝不会在无终态断开时变成unconfirmed候选', () => {
    const evidence = createHostedNarrativeDraftEvidence();
    evidence.onRequestIdentity('draft-request');
    evidence.observeResponse(new Response('', { headers: {
      'Content-Type': 'text/event-stream', 'X-Mahoshojo-Generation-Request-Id': 'draft-request', 'X-Mahoshojo-Generation-Id': 'generation',
    } }));
    evidence.observeBlock(block(1, 'markdown', { chunk: '非空文本', refusal: '无法完成请求' }));
    evidence.onTerminalBoundary({ kind: 'interrupted', bufferedTail: '', rejectedEvent: false });
    expect(evidence.resolve('非空文本')).toBeNull();
  });
  it('纯文本拒绝保留原候选供手动出口，不自动写入；故事引用保持资格', () => {
    const markdown = '# 回复\n抱歉，我无法帮助你完成这个请求。';
    const candidate = candidateFor(markdown)!;
    expect(candidate.markdown).toBe(markdown);
    expect(canAutomaticallyRetainNarrativeDraft(candidate)).toBe(false);
    expect(canAutomaticallyRetainNarrativeDraft(candidateFor(markdown, 'snapshot', { status: 'failed' })!)).toBe(false);
    const archive = buildNarrativeDraftArchive([candidate]);
    expect(parseNarrativeDraftArchive(archive)).toEqual(archive);
    const story = '# 故事\n“抱歉，我无法帮助你。”少女说道。';
    expect(canAutomaticallyRetainNarrativeDraft(candidateFor(story)!)).toBe(true);
    expect(evidenceFor(story, { refusal: null, error: null })).not.toBeNull();
  });
});
