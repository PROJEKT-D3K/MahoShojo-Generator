import { DataCardRefSchema, OpaqueKeySchema, type DataCardRef } from '@mahoshojo/contracts/arena-room';
import { OnlineDataCardTypeSchema } from '@mahoshojo/contracts/data-cards';
import { createArenaRoomSourceProjector } from '@mahoshojo/multiplayer-core';
import { ARENA_ROOM_PRESET_CATALOG } from '@mahoshojo/multiplayer-core/preset-catalog';
import { isBuiltinWebPackageRef } from '@mahoshojo/web-package';
import { mapPublicDataCardRowToDetailsCard, type CardLibraryHost, type CardLibrarySelectionContext } from '@mahoshojo/ui-web/card-library';
import type { ArenaMemberReferenceRequest } from '@mahoshojo/ui-web/arena-room';
import type { InvokeFn } from '../../platform/cloud-bridge';
import { withReadAbort } from '../../platform/abortable-read';
import { requestCardLibraryRoute } from '../../platform/card-library-bridge';
import { parseArenaJson } from './input';

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** Context identifies a cloud selection; body metadata, local and cached copies cannot grant that identity. */
export function desktopMemberSelectionId(context: CardLibrarySelectionContext): string {
  const id = text(context?.cloudCardId);
  if (context?.storageLocation !== 'cloud' || !OpaqueKeySchema.safeParse(id).success || context.cloudCardId !== id || context.selectionId !== `cloud:${id}`) {
    throw new Error('多人提案只能选择当前在线公开数据卡，请重新打开公开库');
  }
  return id;
}

/** Only consume a fresh fixed public endpoint response. Online tokens are observations, never exact-version fences. */
export function parseDesktopMemberPublicCard(value: unknown, kind: DataCardRef['kind'], expectedId?: string) {
  const row = record(value), id = text(row?.id), type = OnlineDataCardTypeSchema.safeParse(row?.type);
  if (!row || !id || row.id !== id || (expectedId !== undefined && id !== expectedId)) throw new Error('公开数据卡身份不匹配，请重新选择');
  if (!type.success || (kind !== 'material' && type.data !== kind)) throw new Error('公开数据卡类型不匹配');
  if (!(row.is_public === true || row.is_public === 1) || row.review_status !== 'approved' || row.deleted_at != null
    || (row.storageLocation !== undefined && row.storageLocation !== 'cloud')) throw new Error('数据卡已撤回或尚未公开通过审核');
  const versionToken = text(row.updated_at) || text(row.updatedAt);
  if (!versionToken) throw new Error('公开数据卡缺少版本观察值，请刷新后重试');
  const ref = DataCardRefSchema.parse({ id, kind, versionToken });
  return { ref, row, name: text(row.name) || id };
}

export async function readDesktopMemberPublicCard(online: Pick<CardLibraryHost['online'], 'fetchPublicCardById'>, id: string, kind: DataCardRef['kind'], signal: AbortSignal) {
  signal.throwIfAborted();
  if (!OpaqueKeySchema.safeParse(id).success || id !== id.trim()) throw new Error('公开数据卡身份无效');
  const result = await online.fetchPublicCardById(id, signal);
  signal.throwIfAborted();
  const body = record(result.data);
  if (!result.ok || body?.success !== true) throw new Error(result.status === 404 ? '该公开数据卡不存在或已撤回' : '公开数据卡暂时无法读取，请重试');
  return parseDesktopMemberPublicCard(body.card, kind, id);
}

export async function readDesktopMemberRandomCharacter(invoke: InvokeFn, online: Pick<CardLibraryHost['online'], 'fetchPublicCardById'>, signal: AbortSignal, isCurrent: () => boolean = () => true) {
  signal.throwIfAborted();
  if (!isCurrent()) throw new Error('房间来源作用域已改变');
  const result = await withReadAbort(requestCardLibraryRoute(invoke, { routeId: 'random-public-card.query', query: { type: 'character' } }), signal);
  signal.throwIfAborted();
  if (!isCurrent()) throw new Error('房间来源作用域已改变');
  const body = record(result.body);
  if (result.status < 200 || result.status >= 300 || body?.success !== true) throw new Error(result.status === 404 ? '暂时没有可随机匹配的公开角色' : '无法获取随机公开角色，请重试');
  const picked = parseDesktopMemberPublicCard(body.card, 'character');
  return readDesktopMemberPublicCard(online, picked.ref.id, 'character', signal);
}

const digestProjector = createArenaRoomSourceProjector({
  sha256Hex: async (value) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  },
  isBuiltinWebPackageRef,
});

export function desktopMemberPresetHref(kind: 'character' | 'scenario', id: string): string {
  if (!ARENA_ROOM_PRESET_CATALOG.some(item => item.kind === kind && item.id === id)) throw new Error('该预设不在房间策展目录内');
  return `/${kind === 'character' ? 'presets' : 'scenario-presets'}/${encodeURIComponent(id)}`;
}

export async function loadDesktopMemberReferenceDetails(request: ArenaMemberReferenceRequest, online: Pick<CardLibraryHost['online'], 'fetchPublicCardById'>, signal: AbortSignal) {
  if (request.source === 'data-card') {
    const { row, name } = await readDesktopMemberPublicCard(online, request.id, request.kind, signal);
    return { card: mapPublicDataCardRowToDetailsCard(row, { id: request.id, name, author: '未知' }), source: { kind: 'public' as const } };
  }
  if (request.source !== 'preset') throw new Error('该来源不提供可公开读取的引用详情');
  const entry = ARENA_ROOM_PRESET_CATALOG.find(item => item.kind === request.kind && item.id === request.id);
  if (!entry) throw new Error('该预设不在房间策展目录内');
  if (request.versionToken !== undefined && request.versionToken !== entry.versionToken) throw new Error('引用的预设版本与客户端目录不一致，请同步房间配置后重试');
  // The Room catalog also retains published legacy presets outside the current picker grid.
  // Only bundled, allowlisted asset paths are read here, never a cloud HTTP URL.
  const response = await fetch(desktopMemberPresetHref(entry.kind, entry.id), { signal, credentials: 'omit', redirect: 'error' });
  if (!response.ok) throw new Error('预设内容暂时无法读取');
  const data = await response.text();
  const digest = await digestProjector.computeArenaRoomContentDigest(parseArenaJson(data));
  signal.throwIfAborted();
  if (digest !== entry.versionToken) throw new Error('预设正文与目录摘要不一致，未显示未验证正文');
  return { card: { id: entry.id, name: entry.displayName, description: '房间内置预设（随客户端发布）', type: entry.kind, data, isPublic: true, author: '系统' }, source: { kind: 'preset' as const } };
}

/** Keep the existing online library UX, with no local/private/deck/import or cache capability. */
export function createDesktopMemberPublicLibraryHost(host: CardLibraryHost): CardLibraryHost {
  const unavailable = async (): Promise<never> => { throw new Error('多人提案仅支持在线公开来源'); };
  const { uploadLocalRecord: _upload, ...online } = host.online;
  return {
    auth: host.auth, platform: host.platform, slots: {},
    online: { ...online, fetchSummaryPage: unavailable, getDeckCards: unavailable,
      loadFullCard: (card, source, signal) => {
        if (source !== 'public') return unavailable();
        const id = text(record(card)?.id);
        return readDesktopMemberPublicCard(online, id, 'material', signal).then(result => result.row);
      } },
    // CardLibraryHost requires a local port, but this workspace never exposes device storage.
    local: { repository: { get: unavailable, list: unavailable, put: unavailable, putIfAbsent: unavailable, delete: unavailable, restore: unavailable } },
  };
}
