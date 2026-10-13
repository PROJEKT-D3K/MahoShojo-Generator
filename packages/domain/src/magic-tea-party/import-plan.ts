import { parseSillyTavernJsonl } from './transfer';
import type { MagicTeaPartyMessage, MagicTeaPartySession, MagicTeaPartySummaryCoverage, MagicTeaPartyTachieAsset } from './types';

type RecordValue = Record<string, unknown>;
export type MagicTeaPartyImportPlan = {
  kind: 'session' | 'archive' | 'jsonl';
  entries: Array<{
    session: MagicTeaPartySession;
    messages: MagicTeaPartyMessage[];
    tachieAssets: MagicTeaPartyTachieAsset[];
  }>;
  warnings: string[];
};
export type MagicTeaPartyImportPlanOptions = {
  input: { format: 'json'; value: unknown } | { format: 'jsonl'; text: string };
  createId: () => string;
  now: number;
  titleHint?: string;
  userDisplayName?: string;
  limits?: { maxBytes?: number; maxNodes?: number; maxDepth?: number };
  normalizeSettings: (_knownSettings: RecordValue | null) => MagicTeaPartySession['settings'];
};

const SETTINGS_KEYS = [
  'providerId', 'modelId', 'temperature', 'maxContextMessages', 'contextWindowTokens',
  'responseReserveTokens', 'summaryTriggerRatio', 'summaryMaxTokens', 'summaryMinGapMessages',
  'enableChoices', 'choiceCount', 'outputFormat', 'updateApplyMode', 'language', 'userDisplayName',
  'presetId', 'worldbookPresetId', 'enableSummary', 'readArenaHistory', 'readArenaHistoryLimit',
  'isArenaHistoryUnlimited', 'readCurrentState', 'writeArenaHistory', 'writeCurrentState',
] as const;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function fail(path: string, reason: string): never { throw new Error(`导入数据 ${path}：${reason}`); }
const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const requiredRecord = (value: unknown, path: string): RecordValue => record(value) ?? fail(path, '必须为对象');
const array = (value: unknown, path: string): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : fail(path, '必须为数组');
const string = (value: unknown, path: string): string =>
  typeof value === 'string' ? value : fail(path, '必须为字符串');
const optionalId = (value: unknown, path: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const id = string(value, path);
  return id.trim() ? id : fail(path, 'ID 不能为空');
};

/** Only this projection may become request options; unknown settings remain inert in storage. */
export const pickMagicTeaPartyRequestSettings = (value: unknown): Partial<MagicTeaPartySession['settings']> => {
  const source = record(value);
  const result: RecordValue = {};
  if (!source) return result;
  for (const key of SETTINGS_KEYS) if (own(source, key)) result[key] = source[key];
  const plan = record(source.outputPlan);
  if (plan) {
    const outputPlan: RecordValue = {};
    for (const key of ['choices', 'summary', 'updates']) if (own(plan, key)) outputPlan[key] = plan[key];
    result.outputPlan = outputPlan;
  }
  return result as Partial<MagicTeaPartySession['settings']>;
};

/** Reject non-JSON objects/accessors and dangerous keys before any normalizer or writer sees them. */
const jsonCopier = (limits: MagicTeaPartyImportPlanOptions['limits']) => {
  const maxBytes = limits?.maxBytes ?? Infinity;
  const maxNodes = limits?.maxNodes ?? Infinity;
  const maxDepth = limits?.maxDepth ?? Infinity;
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const encoder = new TextEncoder();
  const countText = (text: string, path: string) => {
    // JSON escaping only grows these strings; charge the serialized representation.
    bytes += encoder.encode(JSON.stringify(text)).byteLength;
    if (bytes > maxBytes) fail(path, '超过宿主导入字节预算');
  };
  const copy = (value: unknown, path = '$'): unknown => {
    const holder: RecordValue = {};
    type Work = { value: unknown; path: string; depth: number; target: RecordValue | unknown[]; key: string | number } | { exit: object };
    const pending: Work[] = [{ value, path, depth: 0, target: holder, key: 'result' }];
    const assign = (target: RecordValue | unknown[], key: string | number, child: unknown) => {
      if (Array.isArray(target)) target[Number(key)] = child;
      else target[String(key)] = child;
    };
    while (pending.length) {
      const work = pending.pop()!;
      if ('exit' in work) { ancestors.delete(work.exit); continue; }
      const { value: item, path: at, depth, target, key } = work;
      if (++nodes > maxNodes || depth > maxDepth) fail(at, 'JSON 结构超过导入预算');
      if (typeof item === 'string') { countText(item, at); assign(target, key, item); }
      else if (typeof item === 'number') {
        if (!Number.isFinite(item)) fail(at, '数值必须有限');
        bytes += String(item).length; assign(target, key, item);
      } else if (item === null || typeof item === 'boolean') {
        bytes += item === null ? 4 : item ? 4 : 5; assign(target, key, item);
      } else {
        if (!item || typeof item !== 'object') fail(at, '必须为 JSON 值');
        if (ancestors.has(item)) fail(at, '不能含循环引用');
        const proto = Object.getPrototypeOf(item);
        if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) fail(at, '必须为普通 JSON 对象');
        if (Object.getOwnPropertySymbols(item).length) fail(at, '不能含 Symbol 字段');
        ancestors.add(item); pending.push({ exit: item });
        bytes += 2;
        if (Array.isArray(item)) {
          const items: unknown[] = [];
          assign(target, key, items);
          if (Object.keys(item).some(field => !/^(0|[1-9]\d*)$/.test(field) || Number(field) >= item.length)) fail(at, '数组不能含额外字段');
          for (let index = item.length - 1; index >= 0; index--) {
            const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
            if (!descriptor || !('value' in descriptor)) fail(`${at}[${index}]`, '不能含空槽或访问器');
            pending.push({ value: descriptor.value, path: `${at}[${index}]`, depth: depth + 1, target: items, key: index });
          }
          bytes += Math.max(0, item.length - 1);
        } else {
          const fields: RecordValue = {};
          const keys = Object.keys(item);
          assign(target, key, fields);
          for (let index = keys.length - 1; index >= 0; index--) {
            const field = keys[index];
            if (FORBIDDEN_KEYS.has(field)) fail(at, '包含不安全的对象键');
            const descriptor = Object.getOwnPropertyDescriptor(item, field)!;
            if (!('value' in descriptor)) fail(`${at}.${field}`, '不能含访问器');
            countText(field, at);
            pending.push({ value: descriptor.value, path: `${at}.${field}`, depth: depth + 1, target: fields, key: field });
          }
          bytes += keys.length + Math.max(0, keys.length - 1);
        }
      }
      if (bytes > maxBytes) fail(at, '超过宿主导入字节预算');
    }
    return holder.result;
  };
  return copy;
};

// Never replace a user extension, including a pre-existing field with the same name.
const retainProvenance = (target: RecordValue, key: string, value: unknown) => {
  if (own(target, 'importMetadata') && !record(target.importMetadata)) fail('importMetadata', '来源元数据位置存在不兼容值');
  const metadata = { ...(record(target.importMetadata) ?? {}) };
  if (own(metadata, key) && JSON.stringify(metadata[key]) !== JSON.stringify(value)) fail(`importMetadata.${key}`, '来源元数据冲突');
  metadata[key] = value;
  target.importMetadata = metadata;
};
const envelopeExtras = (source: RecordValue, keys: string[]): RecordValue =>
  Object.fromEntries(Object.entries(source).filter(([key]) => !keys.includes(key)));
const sessionSchema = (schema: unknown) => schema === 'magic-tea-party.session.v1' || schema === 'magic-tavern.session.v1';
const archiveSchema = (schema: unknown) => schema === 'magic-tea-party.archive.v1' || schema === 'magic-tavern.archive.v1';

const validateOptionalText = (source: RecordValue, keys: string[], path: string) => {
  for (const key of keys) if (source[key] !== undefined) string(source[key], `${path}.${key}`);
};

const validateChoices = (value: unknown, path: string) => {
  for (const [index, item] of array(value, path).entries()) {
    const choice = requiredRecord(item, `${path}[${index}]`);
    string(choice.id, `${path}[${index}].id`);
    string(choice.text, `${path}[${index}].text`);
  }
};
const validateSegments = (value: unknown, path: string) => {
  for (const [index, item] of array(value, path).entries()) {
    const segment = requiredRecord(item, `${path}[${index}]`);
    // Future segment kinds are inert extensions. Only known display shapes are interpreted.
    if (segment.type === 'narration' || segment.type === 'dialogue') {
      string(segment.text, `${path}[${index}].text`);
      if (segment.type === 'dialogue') {
        string(segment.speakerId, `${path}[${index}].speakerId`);
        if (segment.speakerName !== undefined) string(segment.speakerName, `${path}[${index}].speakerName`);
      }
    } else if (segment.type === 'choices') validateChoices(segment.items, `${path}[${index}].items`);
  }
};

const validateSummaryCoverage = (value: unknown, path: string, messages: RecordValue[]): MagicTeaPartySummaryCoverage => {
  const raw = requiredRecord(value, path);
  const keys = ['version', 'sourceMessageCount', 'selectedMessageIds', 'clippedMessageIds', 'omittedMessageCount'];
  if (Object.keys(raw).some(key => !keys.includes(key))) fail(path, '摘要覆盖信息包含未知字段');
  if (raw.version !== 1) fail(`${path}.version`, '摘要覆盖版本无效');
  for (const key of ['sourceMessageCount', 'omittedMessageCount']) {
    if (typeof raw[key] !== 'number' || !Number.isSafeInteger(raw[key]) || raw[key] < 0) fail(`${path}.${key}`, '必须为非负安全整数');
  }
  const ids = (key: string) => {
    if (!Array.isArray(raw[key]) || raw[key].length > 200) fail(`${path}.${key}`, '必须为不超过 200 项的 ID 数组');
    const result = (raw[key] as unknown[]).map((item, index) => {
      const id = optionalId(item, `${path}.${key}[${index}]`);
      return id ?? fail(`${path}.${key}[${index}]`, 'ID 不能为空');
    });
    if (new Set(result).size !== result.length) fail(`${path}.${key}`, 'ID 不能重复');
    return result;
  };
  const selectedMessageIds = ids('selectedMessageIds');
  const clippedMessageIds = ids('clippedMessageIds');
  if (clippedMessageIds.some(id => !selectedMessageIds.includes(id))) fail(`${path}.clippedMessageIds`, '必须为选中消息的子集');
  if (raw.sourceMessageCount !== selectedMessageIds.length + Number(raw.omittedMessageCount)) fail(path, '摘要覆盖计数不一致');
  const messageIds = new Set(messages.map(message => message.id));
  // Coverage records prompt order. Storage may reorder equal-timestamp messages after ID remapping.
  if (selectedMessageIds.some(id => !messageIds.has(id))) fail(`${path}.selectedMessageIds`, '必须引用本会话内的消息');
  return {
    version: 1, sourceMessageCount: raw.sourceMessageCount as number,
    selectedMessageIds, clippedMessageIds, omittedMessageCount: raw.omittedMessageCount as number,
  };
};

/** Pure, complete-batch preflight. Host ports supply only IDs, time and settings normalization. */
export const buildMagicTeaPartyImportPlan = (options: MagicTeaPartyImportPlanOptions): MagicTeaPartyImportPlan => {
  if (!Number.isFinite(options.now)) fail('now', '时间必须有限');
  for (const [key, value] of Object.entries(options.limits ?? {})) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(`limits.${key}`, '预算必须为非负安全整数');
  }
  const copy = jsonCopier(options.limits);
  let kind: MagicTeaPartyImportPlan['kind'];
  let payloads: RecordValue[];
  let archiveExtra: RecordValue = {};
  let warnings: string[] = [];
  if (options.input.format === 'jsonl') {
    if (new TextEncoder().encode(options.input.text).byteLength > (options.limits?.maxBytes ?? Infinity)) fail('$', '超过宿主导入字节预算');
    // Keep the existing parser's line warnings and untouched rawLine, while checking parseable values.
    for (const [index, line] of options.input.text.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      copy(parsed, `line[${index + 1}]`);
    }
    let temporaryId = 0;
    const parsed = parseSillyTavernJsonl({
      text: options.input.text, sessionId: '@jsonl-session', createId: () => `@jsonl-message-${++temporaryId}`,
      now: options.now, userDisplayName: options.userDisplayName,
    });
    warnings = parsed.warnings;
    const messages = parsed.messages.map(message => {
      const raw = JSON.parse(String(record(message.meta?.source)?.rawLine)) as RecordValue;
      const next: RecordValue = { ...message };
      // The existing parser ignores numeric/empty IDs. Missing IDs have no source identity,
      // so no user-provided string can collide with an artificial placeholder.
      if (typeof raw.id === 'string' && raw.id.trim()) next.id = raw.id;
      else delete next.id;
      return next;
    });
    payloads = [{ session: { id: '@jsonl-session' }, messages }];
    kind = 'jsonl';
  } else {
    const payload = requiredRecord(copy(options.input.value), '$');
    if (sessionSchema(payload.schema)) { kind = 'session'; payloads = [payload]; }
    else if (archiveSchema(payload.schema)) {
      kind = 'archive';
      payloads = array(payload.sessions, '$.sessions').map((item, index) => requiredRecord(item, `$.sessions[${index}]`));
      if (!payloads.length) fail('$.sessions', '归档中没有会话数据');
      archiveExtra = envelopeExtras(payload, ['schema', 'exportedAt', 'appVersion', 'sessions']);
    } else return fail('$.schema', '不支持的文件格式，请使用魔法茶会导出的 JSON 或 SillyTavern JSONL');
  }

  const sessionIds = new Map<string, string>();
  const messageIds = new Map<string, string>();
  const assetIds = new Map<string, string>();
  const originals = new Set<string>();
  const collect = (id: string | undefined, map: Map<string, string>, path: string) => {
    if (!id) return;
    if (map.has(id)) fail(path, '同批原始 ID 重复，无法明确重映射');
    map.set(id, ''); originals.add(id);
  };
  const drafts = payloads.map((payload, index) => {
    const path = `sessions[${index}]`;
    if (payload.schema !== undefined && !sessionSchema(payload.schema)) fail(`${path}.schema`, '不是受支持的会话版本');
    const core = requiredRecord(payload.session, `${path}.session`);
    const oldId = optionalId(core.id, `${path}.session.id`);
    validateChoices(core.lastChoices, `${path}.lastChoices`);
    validateOptionalText(core, ['title', 'summary', 'draft', 'branchLabel'], path);
    if (core.summarySections !== undefined) {
      const sections = requiredRecord(core.summarySections, `${path}.summarySections`);
      for (const [key, section] of Object.entries(sections)) string(section, `${path}.summarySections.${key}`);
    }
    collect(oldId, sessionIds, `${path}.session.id`);
    const messages = array(payload.messages, `${path}.messages`).map((item, messageIndex) => {
      const raw = requiredRecord(item, `${path}.messages[${messageIndex}]`);
      collect(optionalId(raw.id, `${path}.messages[${messageIndex}].id`), messageIds, `${path}.messages[${messageIndex}].id`);
      if (raw.role !== 'user' && raw.role !== 'assistant' && raw.role !== 'system') fail(`${path}.messages[${messageIndex}].role`, '角色无效');
      string(raw.content, `${path}.messages[${messageIndex}].content`);
      validateSegments(raw.segments, `${path}.messages[${messageIndex}].segments`);
      validateChoices(raw.choices, `${path}.messages[${messageIndex}].choices`);
      if (oldId && raw.sessionId !== undefined && raw.sessionId !== oldId) fail(`${path}.messages[${messageIndex}].sessionId`, '消息不属于声明的会话');
      return raw;
    });
    const summaryMeta = core.summaryMeta === undefined ? null : requiredRecord(core.summaryMeta, `${path}.summaryMeta`);
    const coverage = summaryMeta?.coverage === undefined ? undefined
      : validateSummaryCoverage(summaryMeta.coverage, `${path}.summaryMeta.coverage`, messages);
    const assets = array(payload.tachieAssets, `${path}.tachieAssets`).map((item, assetIndex) => {
      const raw = requiredRecord(item, `${path}.tachieAssets[${assetIndex}]`);
      collect(optionalId(raw.id, `${path}.tachieAssets[${assetIndex}].id`), assetIds, `${path}.tachieAssets[${assetIndex}].id`);
      if (oldId && raw.sessionId !== undefined && raw.sessionId !== oldId) fail(`${path}.tachieAssets[${assetIndex}].sessionId`, '素材不属于声明的会话');
      return raw;
    });
    const fork = core.forkedFrom === undefined ? null : requiredRecord(core.forkedFrom, `${path}.forkedFrom`);
    if (fork) {
      const parent = optionalId(fork.sessionId, `${path}.forkedFrom.sessionId`);
      const message = optionalId(fork.messageId, `${path}.forkedFrom.messageId`);
      if (!parent || !message) fail(`${path}.forkedFrom`, '分支来源 ID 缺失');
      originals.add(parent); originals.add(message);
    }
    return { payload, core, oldId, messages, assets, path, fork, coverage, id: '', messageNewIds: [] as string[], assetNewIds: [] as string[] };
  });
  const sourceSessions = new Map(drafts.filter(item => item.oldId).map(item => [item.oldId!, item]));
  const visited = new Set<string>();
  for (const draft of drafts) {
    const chain = new Set<string>();
    let cursor: typeof draft | undefined = draft;
    while (cursor?.oldId && !visited.has(cursor.oldId)) {
      if (chain.has(cursor.oldId)) fail(`${draft.path}.forkedFrom`, '内部来源不能形成分支环');
      chain.add(cursor.oldId);
      cursor = typeof cursor.fork?.sessionId === 'string' ? sourceSessions.get(cursor.fork.sessionId) : undefined;
    }
    for (const id of chain) visited.add(id);
  }
  const generated = new Set<string>();
  const createId = () => {
    const id = optionalId(options.createId(), 'createId');
    if (!id || originals.has(id) || generated.has(id)) fail('createId', '新 ID 必须唯一且不能复用来源 ID');
    generated.add(id); return id;
  };
  for (const draft of drafts) {
    draft.id = createId();
    if (draft.oldId) sessionIds.set(draft.oldId, draft.id);
  }
  for (const draft of drafts) {
    draft.messageNewIds = draft.messages.map(raw => {
      const id = createId(); if (typeof raw.id === 'string') messageIds.set(raw.id, id); return id;
    });
    draft.assetNewIds = draft.assets.map(raw => {
      const id = createId(); if (typeof raw.id === 'string') assetIds.set(raw.id, id); return id;
    });
  }
  const messageIndices = new Map<RecordValue[], Map<string, number>>();
  for (const draft of drafts) {
    const indices = new Map<string, number>();
    draft.messages.forEach((message, index) => { if (typeof message.id === 'string') indices.set(message.id, index); });
    messageIndices.set(draft.messages, indices);
  }
  const remap = (value: unknown, map: Map<string, string>, path: string): string | undefined => {
    const old = optionalId(value, path);
    return old ? map.get(old) ?? old : undefined;
  };
  const mapRange = (value: unknown, path: string, messages: RecordValue[]) => {
    if (value === undefined) return undefined;
    const raw = requiredRecord(value, path);
    const from = optionalId(raw.fromMessageId, `${path}.fromMessageId`);
    const to = optionalId(raw.toMessageId, `${path}.toMessageId`);
    if (!from || !to) fail(path, '消息范围端点缺失');
    const start = messageIndices.get(messages)?.get(from) ?? -1;
    const end = messageIndices.get(messages)?.get(to) ?? -1;
    return {
      ...raw, fromMessageId: messageIds.get(from) ?? from, toMessageId: messageIds.get(to) ?? to,
      count: typeof raw.count === 'number' ? raw.count : start >= 0 && end >= start ? end - start + 1 : 0,
    };
  };
  const normalizeDrafts = (value: unknown, path: string, messages: RecordValue[]) => array(value, path).map((item, index) => {
    const raw = requiredRecord(item, `${path}[${index}]`);
    validateOptionalText(raw, ['characterName', 'character', 'name', 'roleId', 'impact', 'currentStateSummary', 'current_state_summary', 'winner'], `${path}[${index}]`);
    if (raw.hasWinner !== undefined && typeof raw.hasWinner !== 'boolean') fail(`${path}[${index}].hasWinner`, '必须为布尔值');
    const readAlias = (keys: string[]) => {
      for (const key of keys) if (typeof raw[key] === 'string' && raw[key].trim()) return raw[key].trim();
      return undefined;
    };
    const characterName = readAlias(['characterName', 'character', 'name']);
    if (!characterName) fail(`${path}[${index}].characterName`, '更新草稿角色名缺失');
    const next: RecordValue = { ...raw, characterName };
    for (const key of ['roleId', 'impact', 'winner']) {
      const text = readAlias([key]); if (text !== undefined) next[key] = text;
    }
    const summary = readAlias(['currentStateSummary', 'current_state_summary']);
    if (summary !== undefined) next.currentStateSummary = summary;
    if (raw.meta !== undefined) {
      const meta = requiredRecord(raw.meta, `${path}[${index}].meta`);
      next.meta = {
        ...meta,
        ...(meta.sessionId !== undefined ? { sessionId: remap(meta.sessionId, sessionIds, `${path}.meta.sessionId`) } : {}),
        ...(meta.messageRange !== undefined ? { messageRange: mapRange(meta.messageRange, `${path}.meta.messageRange`, messages) } : {}),
      };
    }
    return next;
  });
  const normalizeRoles = (value: unknown, path: string, isScenario = false) => array(value, path).map((item, index) => {
    const role = requiredRecord(item, `${path}[${index}]`);
    string(role.id, `${path}[${index}].id`);
    validateOptionalText(role, ['notes'], `${path}[${index}]`);
    string(role[isScenario ? 'title' : 'name'], `${path}[${index}].${isScenario ? 'title' : 'name'}`);
    const card = role.card == null ? {} : requiredRecord(role.card, `${path}[${index}].card`);
    return { ...role, card };
  });

  const entries = drafts.map(draft => {
    const { core, payload, path } = draft;
    const rawSettings = core.settings == null ? null : requiredRecord(core.settings, `${path}.settings`);
    const normalizedSettings = options.normalizeSettings(rawSettings ? pickMagicTeaPartyRequestSettings(rawSettings) as RecordValue : null);
    const settings = { ...rawSettings, ...normalizedSettings };
    if (record(rawSettings?.outputPlan) && record(normalizedSettings.outputPlan)) settings.outputPlan = {
      ...record(rawSettings?.outputPlan), ...normalizedSettings.outputPlan,
    } as MagicTeaPartySession['settings']['outputPlan'];
    const roles = array(payload.roles, `${path}.roles`);
    const aux = array(payload.auxScenarios, `${path}.auxScenarios`);
    const rawScenario = payload.scenario ?? core.scenario;
    const session: RecordValue = {
      ...core, id: draft.id, title: typeof core.title === 'string' && core.title ? core.title : (kind === 'archive' ? '' : options.titleHint?.trim()) || '导入会话',
      titleMeta: { ...record(core.titleMeta), source: 'manual', generatedAt: options.now, reason: 'import' },
      createdAt: options.now, updatedAt: options.now,
      roles: normalizeRoles(roles.length ? roles : core.roles, `${path}.roles`),
      auxScenarios: normalizeRoles(aux.length ? aux : core.auxScenarios, `${path}.auxScenarios`, true),
      playerRoleId: typeof core.playerRoleId === 'string' ? core.playerRoleId : null,
      settings,
    };
    if (rawScenario != null) session.scenario = normalizeRoles([rawScenario], `${path}.scenario`, true)[0];
    else delete session.scenario;
    if (core.summaryMeta !== undefined) {
      const meta = requiredRecord(core.summaryMeta, `${path}.summaryMeta`);
      session.summaryMeta = {
        ...meta, updatedAt: typeof meta.updatedAt === 'number' ? meta.updatedAt : options.now,
        ...(draft.coverage ? { coverage: {
          ...draft.coverage,
          selectedMessageIds: draft.coverage.selectedMessageIds.map(id => messageIds.get(id)!),
          clippedMessageIds: draft.coverage.clippedMessageIds.map(id => messageIds.get(id)!),
        } } : {}),
        ...(meta.fromMessageId !== undefined ? { fromMessageId: remap(meta.fromMessageId, messageIds, `${path}.summaryMeta.fromMessageId`) } : {}),
        ...(meta.toMessageId !== undefined ? { toMessageId: remap(meta.toMessageId, messageIds, `${path}.summaryMeta.toMessageId`) } : {}),
      };
    }
    for (const key of ['protocolShadow', 'updateSnapshot']) if (core[key] !== undefined) {
      const raw = requiredRecord(core[key], `${path}.${key}`);
      const normalized: RecordValue = {
        ...raw, drafts: normalizeDrafts(raw.drafts, `${path}.${key}.drafts`, draft.messages),
        ...(raw.messageRange !== undefined ? { messageRange: mapRange(raw.messageRange, `${path}.${key}.messageRange`, draft.messages) } : {}),
      };
      if (key === 'protocolShadow') normalized.updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : options.now;
      else {
        normalized.id = typeof raw.id === 'string' ? raw.id : createId();
        normalized.createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : options.now;
        normalized.mode = raw.mode === 'confirm' ? 'confirm' : 'auto';
        normalized.rolesBefore = normalizeRoles(raw.rolesBefore, `${path}.${key}.rolesBefore`);
        normalized.rolesAfter = normalizeRoles(raw.rolesAfter, `${path}.${key}.rolesAfter`);
      }
      session[key] = normalized;
    }
    if (draft.fork) {
      const parent = sourceSessions.get(String(draft.fork.sessionId));
      if (parent) {
        if (!parent.messages.some(message => message.id === draft.fork!.messageId)) fail(`${path}.forkedFrom`, '内部来源消息不属于父会话');
        session.forkedFrom = {
          ...draft.fork, sessionId: parent.id, messageId: messageIds.get(String(draft.fork.messageId)),
          createdAt: typeof draft.fork.createdAt === 'number' ? draft.fork.createdAt : options.now,
        };
      } else {
        delete session.forkedFrom;
        retainProvenance(session, 'unresolvedForkedFrom', draft.fork);
        warnings.push('分支来源未包含在导入文件中，已保留为未解析来源。');
      }
    }
    const extras = envelopeExtras(payload, ['schema', 'exportedAt', 'appVersion', 'session', 'roles', 'scenario', 'auxScenarios', 'messages', 'tachieAssets']);
    if (Object.keys(extras).length || Object.keys(archiveExtra).length) retainProvenance(session, 'sourceEnvelope', {
      ...(Object.keys(extras).length ? { session: extras } : {}),
      ...(Object.keys(archiveExtra).length ? { archive: archiveExtra } : {}),
    });
    const messages = draft.messages.map((raw, index) => {
      const message: RecordValue = {
        ...raw, id: draft.messageNewIds[index], sessionId: draft.id,
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : options.now + index,
        status: raw.status === 'blocked' || raw.status === 'error' ? raw.status : 'done',
      };
      const meta = record(raw.meta);
      if (meta?.supersededBySessionId !== undefined) message.meta = {
        ...meta, supersededBySessionId: remap(meta.supersededBySessionId, sessionIds, `${path}.messages[${index}].meta.supersededBySessionId`),
      };
      for (const key of ['sourceMessageId', 'revisionOf', 'tachieId']) if (raw[key] !== undefined) {
        message[key] = remap(raw[key], key === 'tachieId' ? assetIds : messageIds, `${path}.messages[${index}].${key}`);
      }
      return message as MagicTeaPartyMessage;
    });
    const tachieAssets = draft.assets.map((raw, index) => ({
      ...raw, id: draft.assetNewIds[index], sessionId: draft.id,
      ...(raw.anchorMessageId !== undefined ? { anchorMessageId: remap(raw.anchorMessageId, messageIds, `${path}.tachieAssets[${index}].anchorMessageId`) } : {}),
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : options.now,
      lastUsedAt: typeof raw.lastUsedAt === 'number' ? raw.lastUsedAt : options.now,
    }) as MagicTeaPartyTachieAsset);
    return { session: session as MagicTeaPartySession, messages, tachieAssets };
  });
  return { kind, entries, warnings };
};
