import { DataCardSummaryPageSchema, type DataCardSummaryQueryInput } from '@mahoshojo/contracts/data-cards';
import { fetchDataCardJson } from '@/lib/auth';
import { fetchJsonWithBoundedRetry } from '@/lib/bounded-fetch';
import { resolveApiErrorMessage } from '@/lib/client/apiError';
import { normalizeQuestionnaireDataCard } from '@/lib/questionnaire-data-card';

const fetchPublicDataCardJson = async (url: string, signal?: AbortSignal): Promise<any> => {
  // 公开正文由服务端 publicOnly/审核状态约束；不为公开读取先启动会话校验。
  // 直接把取消与超时交给有界 GET，避免鉴权 bootstrap 挡在请求 signal 之前。
  const result = await fetchJsonWithBoundedRetry<any>(url, { signal });
  if (!result.ok) {
    throw Object.assign(new Error(resolveApiErrorMessage({
      payload: result.data ?? result.bodyText ?? null,
      fallback: `获取数据卡失败（HTTP ${result.status}）`,
    })), { status: result.status });
  }
  return result.data;
};

export async function getDataCardSummaryPage(source: 'my' | 'favorites', query: DataCardSummaryQueryInput, signal?: AbortSignal) {
  const params = new URLSearchParams({ view: 'summary' });
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '' && (!Array.isArray(value) || value.length)) {
      params.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
  }
  return DataCardSummaryPageSchema.parse(await fetchDataCardJson(
    `${source === 'my' ? '/api/data-cards' : '/api/favorites'}?${params}`, signal,
  ));
}

export async function loadFullDataCard(card: any, source: 'my' | 'public' | 'favorites', signal?: AbortSignal): Promise<any> {
  if (typeof card.data === 'string') return card;
  const path = source === 'my' ? '/api/data-cards' : '/api/public-data-cards';
  // 收藏列表仍须鉴权；从中选中卡片后的正文沿用公开端点，不授予私有卡读取权限。
  const read = source === 'my' ? fetchDataCardJson : fetchPublicDataCardJson;
  const result = await read(`${path}?id=${encodeURIComponent(card.id)}`, signal);
  if (!result.success || !result.card || typeof result.card.data !== 'string') {
    throw new Error(result.error || '数据卡不存在或无权访问');
  }
  const full = { ...card, ...result.card };
  if (card.isLegacyQuestionnaire) {
    const normalized = normalizeQuestionnaireDataCard(full);
    if (!normalized) throw new Error('该旧卡内容不是有效的问卷，请在角色管理中检查原卡');
    return normalized;
  }
  return full;
}
