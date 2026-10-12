import { PUBLIC_RANKING_BODY_BUDGETS, PublicRankingRequestSchema, parsePublicRankingResponse, publicRankingPath } from '@mahoshojo/contracts/public-ranking';
import type { PublicRankingReader } from '@mahoshojo/ui-web/ranking';

class PublicRankingHttpError extends Error {
  constructor(readonly status: number) {
    super(status === 429 ? 'HTTP 429：请求过于频繁，请稍后再试' : `HTTP ${status}`);
  }
}

export const readWebRanking: PublicRankingReader = async (request, signal) => {
  const parsedRequest = PublicRankingRequestSchema.safeParse(request);
  if (!parsedRequest.success) throw new Error('排行榜读取参数无效');
  const parsed = parsedRequest.data;
  const response = await fetch(publicRankingPath(parsed), { signal, redirect: 'error', credentials: 'omit' });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new PublicRankingHttpError(response.status);
  }
  const budget = PUBLIC_RANKING_BODY_BUDGETS[parsed.kind];
  if (Number(response.headers.get('content-length')) > budget) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('排行榜响应过大，未加载');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('排行榜响应为空');
  let bytes = 0;
  let json = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > budget) throw new Error('排行榜响应过大，未加载');
      json += decoder.decode(part.value, { stream: true });
    }
    json += decoder.decode();
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw new Error(error instanceof Error && error.message === '排行榜响应过大，未加载' ? error.message : '排行榜响应协议无效');
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  try { return parsePublicRankingResponse(request, { kind: parsed.kind, data: JSON.parse(json) }); }
  catch { throw new Error('排行榜响应协议无效'); }
};
