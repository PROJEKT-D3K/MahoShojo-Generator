import { buildMagicTeaPartyImportPlan } from '@mahoshojo/domain/magic-tea-party/import-plan';
import { buildMagicTeaPartySessionExport, stringifySillyTavernJsonl } from '@mahoshojo/domain/magic-tea-party/transfer';
import { DESKTOP_TEA_LIMITS, TeaWriteRequestSchema, type TeaReadResponse, type TeaWriteRequest } from '@mahoshojo/contracts/desktop-magic-tea-party';
import type { MagicTeaPartyMessage } from '@mahoshojo/domain/magic-tea-party/types';
import type { TeaNativePort } from '../../platform/magic-tea-party-native';
import { assertTeaCurrent, desktopTeaSettings, readTeaMessagePages, teaMessageView, teaSessionView, type TeaRecord } from './direct';

// Export input is already validated JSON data; count its actual serialized UTF-8 bytes.
const jsonUtf8ByteLength = (value: unknown): number => {
  const serialized = JSON.stringify(value);
  return typeof serialized === 'string' ? new TextEncoder().encode(serialized).byteLength : Number.POSITIVE_INFINITY;
};
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const rejectMessageMedia = (value: unknown) => {
  const message = object(value); if (!message) return;
  const extra = object(message.extra);
  const originalExtra = object(object(object(message.meta)?.sillyTavern)?.extra);
  const references = [message.tachieId, object(extra?.magic_tea_party)?.tachieId, object(extra?.magic_tavern)?.tachieId,
    object(originalExtra?.magic_tea_party)?.tachieId, object(originalExtra?.magic_tavern)?.tachieId];
  if (references.some(value => typeof value === 'string' && value.length)) {
    throw new Error('此归档含未支持的媒体附件引用；未写入，请保留原件');
  }
};
const rejectMedia = (value: unknown) => {
  const entry = object(value); if (!entry) return;
  if ((entry.schema === 'magic-tea-party.archive.v1' || entry.schema === 'magic-tavern.archive.v1') && Array.isArray(entry.sessions)) {
    for (const session of entry.sessions) rejectMedia(session);
    return;
  }
  const core = object(entry.session);
  for (const source of [entry, core]) if (source?.tachieAssets !== undefined && (!Array.isArray(source.tachieAssets) || source.tachieAssets.length)) {
    throw new Error('此归档含未支持的媒体附件；未写入任何会话，请保留原文件');
  }
  if (Array.isArray(entry.messages)) for (const message of entry.messages) rejectMessageMedia(message);
};
export const prepareDesktopTeaImport = (text: string, format: 'json' | 'jsonl', createId: () => string, now: number): { write: TeaWriteRequest; warnings: string[] } => {
  if (new TextEncoder().encode(text).byteLength > DESKTOP_TEA_LIMITS.writeBytes) throw new Error('导入文件超过 64 MiB，请保留原件并拆分后重试');
  let input: Parameters<typeof buildMagicTeaPartyImportPlan>[0]['input'];
  if (format === 'json') { const value: unknown = JSON.parse(text); rejectMedia(value); input = { format, value }; }
  else {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let value: unknown; try { value = JSON.parse(line); } catch { continue; }
      rejectMessageMedia(value);
    }
    input = { format, text };
  }
  const plan = buildMagicTeaPartyImportPlan({ input, createId, now, normalizeSettings: known => ({ ...desktopTeaSettings(null), ...known }),
    limits: { maxBytes: DESKTOP_TEA_LIMITS.writeBytes, maxNodes: DESKTOP_TEA_LIMITS.envelopeNodes, maxDepth: DESKTOP_TEA_LIMITS.depth } });
  if (plan.entries.some(entry => entry.tachieAssets.length)) throw new Error('此归档含未支持媒体，原件未改变');
  const write = TeaWriteRequestSchema.safeParse({ version: 1, request: { action: 'import', operationId: createId(),
    entries: plan.entries.map(entry => ({ session: entry.session, messages: entry.messages })) } });
  if (!write.success) throw new Error('此归档超出桌面文本存储边界，或含不支持的数据；未写入，请保留原件');
  return { write: write.data, warnings: plan.warnings };
};

const checkExportSize = (value: unknown) => {
  if (jsonUtf8ByteLength(value) > DESKTOP_TEA_LIMITS.writeBytes) throw new Error('此导出超过 64 MiB 文件预算，未生成不完整档案；请使用整库备份保全数据');
};
async function sessionExport(port: TeaNativePort, record: TeaRecord, current: () => boolean, catalog: number) {
  const messages: MagicTeaPartyMessage[] = [];
  let bytes = jsonUtf8ByteLength(record.session);
  for await (const page of readTeaMessagePages(port, record, current, catalog)) {
    for (const row of page.rows) {
      bytes += jsonUtf8ByteLength(row.message) + 1;
      if (bytes > DESKTOP_TEA_LIMITS.writeBytes || messages.length >= DESKTOP_TEA_LIMITS.importMessages) throw new Error('此会话超出文本导入导出预算，请使用整库备份保全；未生成截断档案');
      messages.push(teaMessageView(row.message));
    }
  }
  // Keep inert unknown settings exactly as stored; only UI/model requests use a projection.
  const view = { ...teaSessionView(record.session), settings: record.session.settings };
  const result = buildMagicTeaPartySessionExport({ session: view, messages, tachieAssets: [] });
  checkExportSize(result);
  return { result, view, messages };
}
export async function exportDesktopTea(port: TeaNativePort, sessionId: string | null, format: 'json' | 'jsonl' | 'archive', current: () => boolean): Promise<string> {
  if (format !== 'archive') {
    if (!sessionId) throw new Error('请先选择会话');
    const response = await port.read({ version: 1, request: { action: 'session', sessionId, expectedCatalogRevision: null } });
    assertTeaCurrent(current);
    if (response.result.action !== 'session' || !response.result.record) throw new Error('会话已不存在');
    const exported = await sessionExport(port, response.result.record, current, response.result.catalogRevision);
    const text = format === 'json' ? JSON.stringify(exported.result, null, 2) : stringifySillyTavernJsonl({ messages: exported.messages, userDisplayName: desktopTeaSettings(exported.view.settings).userDisplayName ?? '旅人', playerRoleName: exported.view.roles.find(role => role.id === exported.view.playerRoleId)?.name, roleNameLookup: id => exported.view.roles.find(role => role.id === id)?.name ?? id });
    if (new TextEncoder().encode(text).byteLength > DESKTOP_TEA_LIMITS.writeBytes) throw new Error('格式化后的导出超过 64 MiB，请使用整库备份');
    return text;
  }
  let cursor: Extract<TeaReadResponse['result'], { action: 'list' }>['nextCursor'] = null;
  let catalog: number | null = null;
  const sessions: Awaited<ReturnType<typeof sessionExport>>['result'][] = [];
  let bytes = 0; let messageCount = 0;
  do {
    const response = await port.read({ version: 1, request: { action: 'list', cursor, expectedCatalogRevision: catalog, limit: 50 } });
    assertTeaCurrent(current);
    if (response.result.action !== 'list') throw new Error('目录回执不匹配');
    catalog = response.result.catalogRevision;
    for (const head of response.result.rows) {
      if (sessions.length >= DESKTOP_TEA_LIMITS.importSessions) throw new Error('全部会话超过单档 128 个会话预算，请使用整库备份');
      const read = await port.read({ version: 1, request: { action: 'session', sessionId: head.id, expectedCatalogRevision: catalog } });
      assertTeaCurrent(current);
      if (read.result.action !== 'session' || !read.result.record) throw new Error('导出期间会话已变化，请重新导出');
      const item = (await sessionExport(port, read.result.record, current, catalog)).result;
      messageCount += item.messages.length;
      if (messageCount > DESKTOP_TEA_LIMITS.importMessages) throw new Error('全部会话超过单档 10000 条消息预算，请使用整库备份');
      bytes += jsonUtf8ByteLength(item); if (bytes > DESKTOP_TEA_LIMITS.writeBytes) throw new Error('全部会话超过 64 MiB，请使用整库备份');
      sessions.push(item);
    }
    cursor = response.result.nextCursor;
  } while (cursor);
  const value = { schema: 'magic-tea-party.archive.v1', exportedAt: new Date().toISOString(), sessions };
  const text = JSON.stringify(value, null, 2);
  if (new TextEncoder().encode(text).byteLength > DESKTOP_TEA_LIMITS.writeBytes) throw new Error('完整档案超过 64 MiB，请使用整库备份');
  return text;
}
