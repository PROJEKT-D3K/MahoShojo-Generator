'use client';

import { useCallback, useRef } from 'react';
import { getCombatantCardLibrarySelectionId } from '@mahoshojo/domain/arena-file-parser';
import type { CardLibrarySelectionContext } from '@mahoshojo/ui-web/card-library';

import {
  appendAdjudicationEventsFromSource,
  buildAdjudicationSourceKey,
  getCombatantAdjudicationSourceKey,
  prepareAdjudicationEventImport,
  removeAdjudicationEventsForKeys,
} from '@/lib/arena/adjudication-events';
import { buildArenaMaterialState } from '@/lib/arena/materials';
import {
  canAddArenaReferenceItems,
  MAX_ARENA_REFERENCE_ITEMS,
} from '@/lib/arena/resource-budget';
import { stripLocalCardTransportMeta } from '@mahoshojo/local-library/digest';
import {
  mapDataCardRuntimeSourceInfo,
  mapPublicDataCardRowToBattleSelectionPayload,
} from '@/lib/data-card-read-mappers';
import { generateRandomCanshou, generateRandomMagicalGirl } from '@/lib/random-character-generator';
import { verifyArenaContentOrigin as verifyOrigin } from '@/lib/arena/verify-origin';

import { useBattleStore } from '../stores/useBattleStore';
import {
  AuxiliaryScenarioState,
  BattleStoreState,
  CombatantData,
  isCombatantLimitReached,
  MAX_COMBATANTS,
  RandomCombatantPlaceholder,
} from '../types';
import {
  getCombatantDisplayName,
  inferCombatantType,
} from '../utils/characterValidator';
import { parseCombatantsFromText } from '../utils/fileParser';
import { resolveArenaDataCardTemplate } from '../utils/data-card-template';
import { ScenarioSchema } from '../utils/schemas';

// 追踪正在处理中的卡片，防止重复点击
const loadingCards = new Set<string>();

const createClientId = (prefix: string): string => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const hasArenaReferenceCapacity = (): boolean => canAddArenaReferenceItems(useBattleStore.getState());
const arenaReferenceLimitMessage = `参考项（辅助情景、素材和问卷）合计最多 ${MAX_ARENA_REFERENCE_ITEMS} 项。`;

export const materializeRandomCombatants = (
  placeholders: readonly RandomCombatantPlaceholder[],
): CombatantData[] => placeholders.map((placeholder) => {
  const data = placeholder.type === 'random-magical-girl'
    ? generateRandomMagicalGirl()
    : generateRandomCanshou();
  return {
    type: data.codename ? 'magical-girl' : 'canshou',
    data,
    filename: `${placeholder.filename} - ${data.codename || data.name}`,
    // 本地随机生成器不持有签名能力，不得自行授予原生标记。
    isValid: false,
    isPreset: false,
    isNonStandard: false,
    teamId: placeholder.teamId,
  };
});

export const useBattleActions = () => {
  const pendingLibrarySelections = useRef(new Map<string, symbol>());
  const useBattleSelector = <T,>(selector: (state: BattleStoreState) => T) => useBattleStore(selector);
  const combatants = useBattleSelector((state) => state.combatants);
  const auxScenarios = useBattleSelector((state) => state.auxScenarios);
  const materials = useBattleSelector((state) => state.materials);
  const isGenerating = useBattleSelector((state) => state.isGenerating);
  const setError = useBattleSelector((state) => state.setError);
  const addCombatant = useBattleSelector((state) => state.addCombatant);
  const setCombatants = useBattleSelector((state) => state.setCombatants);
  const setScenario = useBattleSelector((state) => state.setScenario);
  const addAuxScenario = useBattleSelector((state) => state.addAuxScenario);
  const removeAuxScenario = useBattleSelector((state) => state.removeAuxScenario);
  const moveAuxScenario = useBattleSelector((state) => state.moveAuxScenario);
  const clearAuxScenarios = useBattleSelector((state) => state.clearAuxScenarios);
  const setAuxScenarios = useBattleSelector((state) => state.setAuxScenarios);
  const addMaterial = useBattleSelector((state) => state.addMaterial);
  const removeMaterial = useBattleSelector((state) => state.removeMaterial);
  const moveMaterial = useBattleSelector((state) => state.moveMaterial);
  const clearMaterials = useBattleSelector((state) => state.clearMaterials);
  const setMaterials = useBattleSelector((state) => state.setMaterials);
  const appendAdjudicationEventsToStore = useBattleSelector((state) => state.appendAdjudicationEvents);
  const scenario = useBattleSelector((state) => state.scenario);

  const buildAuxScenario = useCallback(
    async (input: {
      id?: string;
      rawScenario: any;
      fileName: string;
      adjudicationSourceKey?: string;
      sourceDataCardId?: string;
      sourceDataCardName?: string;
      sourceDataCardUpdatedAt?: string;
      sourceIsPublic?: boolean;
      sourceAuthor?: string;
      isPreset?: boolean;
    }): Promise<AuxiliaryScenarioState> => {
      const parsed = ScenarioSchema.safeParse(input.rawScenario);
      if (!parsed.success) {
        throw new Error(parsed.error.issues[0]?.message || '情景文件缺少必需字段');
      }

      const isNative = await verifyOrigin(parsed.data);
      const adjudicationSourceKey =
        input.adjudicationSourceKey ??
        buildAdjudicationSourceKey({
          sourceDataCardId: input.sourceDataCardId,
          sourceFileName: input.fileName,
          sourceLabel: input.sourceDataCardName || input.fileName,
        });
      return {
        id: input.id || createClientId('aux-scenario'),
        content: parsed.data,
        fileName: input.fileName,
        isNative,
        isPreset: input.isPreset === true,
        ...(adjudicationSourceKey ? { adjudicationSourceKey } : {}),
        sourceDataCardId: input.sourceDataCardId,
        sourceDataCardUpdatedAt: input.sourceDataCardUpdatedAt,
        sourceDataCardName: input.sourceDataCardName,
        sourceIsPublic: input.sourceIsPublic,
        sourceAuthor: input.sourceAuthor,
      };
    },
    []
  );

  const appendAdjudicationEvents = useCallback(
    (events: unknown, label: string, sourceKey?: string | null) => {
      const prepared = prepareAdjudicationEventImport(events, label, sourceKey);
      if (prepared.status === 'legacy') {
        setError(`⚠️ 文件 "${label}" 包含旧版随机事件，已被忽略。`);
        return;
      }
      if (prepared.status !== 'ready') return;
      appendAdjudicationEventsToStore(prepared.events, prepared.sourceKey);
    },
    [appendAdjudicationEventsToStore, setError]
  );

  const importFromText = useCallback(
    async (text: string) => {
      const results = await parseCombatantsFromText(text, {
        existingCount: combatants.length,
        onWarn: setError,
        onError: setError,
        onAdjudicationEvents: appendAdjudicationEvents,
        verifyOrigin,
      });

      // 检查同名角色并过滤
      const existingFilenames = new Set(
        combatants.filter((c): c is CombatantData => 'filename' in c).map((c) => c.filename)
      );
      const duplicates: string[] = [];
      const uniqueResults = results.filter((result) => {
        if (existingFilenames.has(result.filename)) {
          duplicates.push(result.filename);
          return false;
        }
        return true;
      });

      // 添加唯一的角色
      uniqueResults.forEach((result) =>
        addCombatant({
          ...result,
          adjudicationSourceKey: buildAdjudicationSourceKey({
            sourceFileName: result.filename,
            sourceLabel: result.filename,
          }) ?? undefined,
        })
      );

      // 显示重复角色的警告信息
      if (duplicates.length > 0) {
        setError(`❌ 已忽略 ${duplicates.length} 个同名角色: ${duplicates.join(', ')}`);
      } else {
        setError(null);
      }

      return uniqueResults;
    },
    [addCombatant, appendAdjudicationEvents, combatants, setError]
  );

  const handleFileUpload = useCallback(
    async (files: FileList | null) => {
      if (!files || isGenerating) return [];
      const texts = await Promise.all(Array.from(files).map((file) => file.text()));
      return importFromText(texts.join('\n'));
    },
    [importFromText, isGenerating]
  );

  const handlePaste = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return [];
      return importFromText(trimmed);
    },
    [importFromText]
  );

  const handleAddRandomPlaceholder = useCallback(
    (type: 'random-magical-girl' | 'random-canshou') => {
      if (isGenerating) return;
      if (isCombatantLimitReached(combatants.length, MAX_COMBATANTS)) {
        setError(`最多只能选择 ${MAX_COMBATANTS} 位参战者。`);
        return;
      }
      const placeholder: RandomCombatantPlaceholder = {
        type,
        id: `${type}-${Date.now()}`,
        filename: type === 'random-magical-girl' ? '随机魔法少女' : '随机残兽',
      };
      addCombatant(placeholder);
    },
    [addCombatant, combatants.length, isGenerating, setError]
  );

  const handleSelectDataCard = useCallback(
    async (cardData: any) => {
      const {
        sourceDataCardId,
        sourceDataCardName,
        sourceDataCardDescription,
        sourceDataCardCreatedAt,
        sourceDataCardUpdatedAt,
        sourceIsPublic,
        sourceAuthor,
        sourceDataCardLikeCount,
        sourceDataCardFavoriteCount,
        sourceDataCardUsageCount,
      } = mapDataCardRuntimeSourceInfo(cardData);

      // _cardType 是在线选卡的传输元数据，最终仍需从正文中移除；但在清理前
      // 读取它，让正文无法识别的 scenario 不会掉入参战角色分支。
      const declaredCardType = cardData?._cardType;
      const cleanedCardData = stripLocalCardTransportMeta(cardData);
      const resolvedName = getCombatantDisplayName(cleanedCardData);
      const inferredTemplate = resolveArenaDataCardTemplate(cleanedCardData, declaredCardType);
      const targetFilename = `${sourceDataCardName || resolvedName}.json`;
      const adjudicationSourceKey = buildAdjudicationSourceKey({
        sourceDataCardId,
        sourceFileName: targetFilename,
        sourceLabel: sourceDataCardName || resolvedName,
      });

      // 检查是否已在加载中或已存在（防止重复点击）
      if (loadingCards.has(targetFilename)) {
        return; // 直接忽略，不显示错误信息
      }

      // 立即标记为正在加载，防止并发请求
      loadingCards.add(targetFilename);

      try {
        if (inferredTemplate === 'scenario' || inferredTemplate === 'general-scenario') {
          if (useBattleStore.getState().battleMode !== 'scenario') {
            setError('❌ 情景数据卡只能在情景模式下使用。');
            return;
          }

          const isNative = await verifyOrigin(cleanedCardData);
          setScenario({
            content: cleanedCardData,
            fileName: `${sourceDataCardName || resolvedName}.json`,
            isNative,
            isPreset: false,
            ...(adjudicationSourceKey ? { adjudicationSourceKey } : {}),
            sourceDataCardId,
            sourceDataCardDescription,
            sourceDataCardCreatedAt,
            sourceDataCardUpdatedAt,
            sourceDataCardName,
            sourceIsPublic,
            sourceAuthor,
            sourceDataCardUsageCount,
            sourceDataCardLikeCount,
            sourceDataCardFavoriteCount,
          });
          appendAdjudicationEvents(cleanedCardData.adjudicationEvents, resolvedName, adjudicationSourceKey);
          setError(null);
          return;
        }

        if (isCombatantLimitReached(combatants.length, MAX_COMBATANTS)) {
          setError(`❌ 最多只能添加 ${MAX_COMBATANTS} 位角色。`);
          return;
        }
        if (combatants.some((c) => 'filename' in c && c.filename === targetFilename)) {
          setError(`❌ 已添加同名角色: ${resolvedName}`);
          return;
        }

        const type = inferCombatantType(cleanedCardData);
        const isValid = await verifyOrigin(cleanedCardData);

        addCombatant({
          type,
          data: cleanedCardData,
          filename: targetFilename,
          isValid,
          isPreset: false,
          isNonStandard: false,
          ...(adjudicationSourceKey ? { adjudicationSourceKey } : {}),
          sourceDataCardId,
          sourceDataCardDescription,
          sourceDataCardCreatedAt,
          sourceDataCardUpdatedAt,
          sourceDataCardName,
          sourceIsPublic,
          sourceAuthor,
          sourceDataCardUsageCount,
          sourceDataCardLikeCount,
          sourceDataCardFavoriteCount,
        });
        appendAdjudicationEvents(cleanedCardData.adjudicationEvents, resolvedName, adjudicationSourceKey);
        setError(null);
      } finally {
        // 无论成功还是失败，都要移除加载标记
        loadingCards.delete(targetFilename);
      }
    },
    [addCombatant, appendAdjudicationEvents, combatants, setError, setScenario]
  );

  const handleRandomMatch = useCallback(
    async (type: 'character' | 'scenario') => {
      if (type === 'character' && isCombatantLimitReached(combatants.length, MAX_COMBATANTS)) {
        setError(`最多只能选择 ${MAX_COMBATANTS} 位参战者。`);
        return;
      }
      useBattleStore.getState().setIsMatching(type);
      setError(`正在从数据库中随机寻找一位公开的${type === 'character' ? '角色' : '情景'}...`);
      try {
        const response = await fetch(`/api/random-public-card?type=${type}`);
        const result = await response.json();
        if (!response.ok || !result.success) {
          throw new Error(result.error || '无法获取随机数据');
        }
        const payload = mapPublicDataCardRowToBattleSelectionPayload(result.card);
        await handleSelectDataCard(payload);
      } catch (error) {
        setError(`❌ 随机匹配失败: ${error instanceof Error ? error.message : '未知错误'}`);
      } finally {
        useBattleStore.getState().setIsMatching(null);
      }
    },
    [combatants.length, handleSelectDataCard, setError]
  );

  const handleToggleAuxScenarioDataCard = useCallback(
    async (cardData: any, nextSelected: boolean) => {
      if (useBattleStore.getState().battleMode !== 'scenario') {
        setError('❌ 仅在情景模式下可添加辅助情景。');
        return;
      }
      if (!useBattleStore.getState().scenario.content) {
        setError('❌ 请先选择主情景，再添加辅助情景。');
        return;
      }

      const {
        sourceDataCardId,
        sourceDataCardName,
        sourceDataCardUpdatedAt,
        sourceIsPublic,
        sourceAuthor,
      } = mapDataCardRuntimeSourceInfo(cardData);

      const declaredCardType = cardData?._cardType;
      const cleanedCardData = stripLocalCardTransportMeta(cardData);
      const inferredTemplate = resolveArenaDataCardTemplate(cleanedCardData, declaredCardType);
      if (inferredTemplate !== 'scenario' && inferredTemplate !== 'general-scenario') {
        setError('❌ 请选择“情景”类型的数据卡。');
        return;
      }

      const auxId = sourceDataCardId ? `aux-scenario-card-${sourceDataCardId}` : createClientId('aux-scenario');

      if (!nextSelected) {
        // 多选模式中取消：优先按 sourceDataCardId 匹配，否则按 id 匹配
        setAuxScenarios(
          useBattleStore
            .getState()
            .auxScenarios.filter((item) =>
              sourceDataCardId ? item.sourceDataCardId !== sourceDataCardId : item.id !== auxId
            )
        );
        setError(null);
        return;
      }

      if (!hasArenaReferenceCapacity()) {
        setError(`❌ ${arenaReferenceLimitMessage}`);
        return;
      }
      if (sourceDataCardId && useBattleStore.getState().auxScenarios.some((item) => item.sourceDataCardId === sourceDataCardId)) {
        return;
      }

      // 检查是否已在加载中（防止重复点击）
      if (loadingCards.has(auxId)) {
        return;
      }
      loadingCards.add(auxId);

      try {
        const resolvedName = getCombatantDisplayName(cleanedCardData);
        const built = await buildAuxScenario({
          id: auxId,
          rawScenario: cleanedCardData,
          fileName: `${sourceDataCardName || resolvedName}.json`,
          sourceDataCardId,
          sourceDataCardName,
          sourceDataCardUpdatedAt,
          sourceIsPublic,
          sourceAuthor,
        });
        addAuxScenario(built);
        appendAdjudicationEvents(cleanedCardData.adjudicationEvents, resolvedName, built.adjudicationSourceKey);
        setError(null);
      } catch (error) {
        setError(`❌ 添加辅助情景失败: ${error instanceof Error ? error.message : '未知错误'}`);
      } finally {
        loadingCards.delete(auxId);
      }
    },
    [addAuxScenario, appendAdjudicationEvents, buildAuxScenario, setAuxScenarios, setError]
  );

  const handleToggleCombatantDataCard = useCallback(
    async (cardData: unknown, nextSelected: boolean, context: CardLibrarySelectionContext): Promise<void | false> => {
      const selectionId = context.rowSelectionId ?? context.selectionId;
      if (context.signal?.aborted || !/^(cloud|local|cache):.+$/.test(selectionId)) return false;
      const isSelected = (item: unknown) => getCombatantCardLibrarySelectionId(item) === selectionId;

      // 撤选只依赖展示行身份；失效缓存或账号切换后不再读取正文和云端 ID。
      if (!nextSelected) {
        pendingLibrarySelections.current.delete(selectionId);
        let removed = false;
        useBattleStore.setState((state) => {
          if (context.signal?.aborted || state.isGenerating) return state;
          const removedItems = state.combatants.filter(isSelected);
          if (removedItems.length === 0) return state;
          removed = true;
          return {
            combatants: state.combatants.filter((item) => !isSelected(item)),
            adjudicationEvents: removeAdjudicationEventsForKeys(
              state.adjudicationEvents,
              removedItems.map(getCombatantAdjudicationSourceKey),
            ),
            error: null,
          };
        });
        return removed ? undefined : false;
      }

      if (pendingLibrarySelections.current.has(selectionId)
        || useBattleStore.getState().isGenerating
        || useBattleStore.getState().combatants.some(isSelected)) return false;
      const token = Symbol();
      pendingLibrarySelections.current.set(selectionId, token);
      const releasePending = () => {
        if (pendingLibrarySelections.current.get(selectionId) === token) pendingLibrarySelections.current.delete(selectionId);
      };
      context.signal?.addEventListener('abort', releasePending, { once: true });
      const isCurrent = () => !context.signal?.aborted && pendingLibrarySelections.current.get(selectionId) === token;

      try {
        if (!context.rawSourceData) throw new Error('数据卡缺少原始正文，请重新选择。');
        // 正文与展示元数据分离，保留原卡中同名的 _cardId 等用户扩展字段。
        const data = JSON.parse(JSON.stringify(context.rawSourceData)) as Record<string, unknown>;
        const metadata = mapDataCardRuntimeSourceInfo({
          ...(cardData as Record<string, unknown>),
          _storageLocation: context.storageLocation,
          _cardId: context.storageLocation === 'cloud' ? context.cloudCardId : '',
          _updatedAt: context.storageLocation === 'cloud' ? context.cloudCardUpdatedAt : undefined,
        });
        const resolvedName = getCombatantDisplayName(data);
        const inferredTemplate = resolveArenaDataCardTemplate(data, 'character');
        if (inferredTemplate === 'scenario' || inferredTemplate === 'general-scenario') {
          throw new Error('请选择“角色”类型的数据卡。');
        }
        if (context.storageLocation === 'cloud'
          && (!context.cloudCardId || context.selectionId !== `cloud:${context.cloudCardId}`)) {
          throw new Error('线上数据卡来源无效，请重新选择。');
        }
        const isValid = await verifyOrigin(data);
        if (!isCurrent()) return false;
        const adjudicationSourceKey = `library:${selectionId}`;
        const prepared = prepareAdjudicationEventImport(data.adjudicationEvents, resolvedName, adjudicationSourceKey);
        const combatant: CombatantData = {
          type: inferCombatantType(data),
          data,
          filename: `${metadata.sourceDataCardName || resolvedName}.json`,
          isValid,
          isPreset: false,
          isNonStandard: false,
          cardLibrarySelectionId: selectionId,
          adjudicationSourceKey,
          sourceDataCardName: metadata.sourceDataCardName,
          sourceDataCardDescription: metadata.sourceDataCardDescription,
          ...(context.storageLocation === 'cloud' ? {
            sourceDataCardId: context.cloudCardId,
            sourceDataCardUpdatedAt: context.cloudCardUpdatedAt,
            sourceDataCardCreatedAt: metadata.sourceDataCardCreatedAt,
            sourceIsPublic: metadata.sourceIsPublic,
            sourceAuthor: metadata.sourceAuthor,
            sourceDataCardUsageCount: metadata.sourceDataCardUsageCount,
            sourceDataCardLikeCount: metadata.sourceDataCardLikeCount,
            sourceDataCardFavoriteCount: metadata.sourceDataCardFavoriteCount,
          } : {}),
        };
        let committed = false;
        // 名单和事件在同一次更新中提交；异步校验结束后按最新名单判重/限额。
        useBattleStore.setState((state) => {
          if (!isCurrent() || state.isGenerating || state.combatants.some(isSelected)) return state;
          if (isCombatantLimitReached(state.combatants.length, MAX_COMBATANTS)) {
            return { error: `❌ 最多只能添加 ${MAX_COMBATANTS} 位角色。` };
          }
          committed = true;
          return {
            combatants: [...state.combatants, combatant],
            adjudicationEvents: prepared.status === 'ready'
              ? appendAdjudicationEventsFromSource(state.adjudicationEvents, prepared.events, prepared.sourceKey)
              : state.adjudicationEvents,
            error: prepared.status === 'legacy' ? `⚠️ 文件 "${resolvedName}" 包含旧版随机事件，已被忽略。` : null,
          };
        });
        if (!isCurrent()) {
          if (committed) {
            useBattleStore.setState((state) => ({
              combatants: state.combatants.filter((item) => item !== combatant),
              adjudicationEvents: removeAdjudicationEventsForKeys(state.adjudicationEvents, [adjudicationSourceKey]),
            }));
          }
          return false;
        }
        return committed ? undefined : false;
      } catch (error) {
        if (!isCurrent()) return false;
        setError(`❌ 添加角色失败: ${error instanceof Error ? error.message : '未知错误'}`);
        throw error;
      } finally {
        context.signal?.removeEventListener('abort', releasePending);
        releasePending();
      }
    },
    [setError]
  );

  const handleRandomMatchAuxScenario = useCallback(async () => {
    if (!useBattleStore.getState().scenario.content) {
      setError('❌ 请先选择主情景，再添加辅助情景。');
      return;
    }
    if (!hasArenaReferenceCapacity()) {
      setError(arenaReferenceLimitMessage);
      return;
    }
    useBattleStore.getState().setIsMatching('scenario');
    setError('正在从数据库中随机寻找一份公开的辅助情景...');
    try {
      const response = await fetch('/api/random-public-card?type=scenario');
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error || '无法获取随机数据');
      }
      const payload = mapPublicDataCardRowToBattleSelectionPayload(result.card);
      await handleToggleAuxScenarioDataCard(payload, true);
    } catch (error) {
      setError(`❌ 随机匹配失败: ${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      useBattleStore.getState().setIsMatching(null);
    }
  }, [handleToggleAuxScenarioDataCard, setError]);

  const handleScenarioUpload = useCallback(
    async (file: File) => {
      const text = await file.text();
      const json = JSON.parse(text);
      const parsed = ScenarioSchema.safeParse(json);
      if (!parsed.success) {
        throw new Error(parsed.error.issues[0]?.message || '情景文件缺少必需字段');
      }
      const isNative = await verifyOrigin(parsed.data);
      const scenarioLabel = (parsed.data as any)?.title || (parsed.data as any)?.name || file.name;
      const adjudicationSourceKey = buildAdjudicationSourceKey({
        sourceFileName: file.name,
        sourceLabel: scenarioLabel,
      });
      setScenario({
        content: parsed.data,
        fileName: file.name,
        isNative,
        isPreset: false,
        ...(adjudicationSourceKey ? { adjudicationSourceKey } : {}),
      });
      appendAdjudicationEvents((parsed.data as any).adjudicationEvents, scenarioLabel, adjudicationSourceKey);
      setError(null);
    },
    [appendAdjudicationEvents, setError, setScenario]
  );

  const handleAuxScenarioUpload = useCallback(
    async (file: File) => {
      if (useBattleStore.getState().battleMode !== 'scenario') {
        throw new Error('仅在情景模式下可添加辅助情景。');
      }
      if (!useBattleStore.getState().scenario.content) {
        throw new Error('请先选择主情景，再添加辅助情景。');
      }
      if (!hasArenaReferenceCapacity()) {
        throw new Error(arenaReferenceLimitMessage);
      }

      const text = await file.text();
      const json = JSON.parse(text);
      const built = await buildAuxScenario({
        rawScenario: json,
        fileName: file.name,
      });
      addAuxScenario(built);
      appendAdjudicationEvents((json as any).adjudicationEvents, file.name, built.adjudicationSourceKey);
      setError(null);
    },
    [addAuxScenario, appendAdjudicationEvents, buildAuxScenario, setError]
  );

  const handleScenarioPaste = useCallback(
    async (text: string, options?: { fileName?: string; isPreset?: boolean }) => {
      const parsed = ScenarioSchema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        throw new Error(parsed.error.issues[0]?.message || '情景文件缺少必需字段');
      }
      const isNative = await verifyOrigin(parsed.data);
      const scenarioLabel = (parsed.data as any)?.title || (parsed.data as any)?.name || '粘贴的情景';
      const scenarioFileName = options?.fileName || scenarioLabel;
      const adjudicationSourceKey = buildAdjudicationSourceKey({
        sourceFileName: scenarioFileName,
        sourceLabel: scenarioLabel,
      });
      setScenario({
        content: parsed.data,
        fileName: scenarioFileName,
        isNative,
        isPreset: options?.isPreset === true,
        ...(adjudicationSourceKey ? { adjudicationSourceKey } : {}),
      });
      appendAdjudicationEvents((parsed.data as any).adjudicationEvents, scenarioLabel, adjudicationSourceKey);
      setError(null);
    },
    [appendAdjudicationEvents, setError, setScenario]
  );

  const handleAuxScenarioPaste = useCallback(
    async (text: string, options?: { fileName?: string; isPreset?: boolean }) => {
      if (useBattleStore.getState().battleMode !== 'scenario') {
        throw new Error('仅在情景模式下可添加辅助情景。');
      }
      if (!useBattleStore.getState().scenario.content) {
        throw new Error('请先选择主情景，再添加辅助情景。');
      }
      if (!hasArenaReferenceCapacity()) {
        throw new Error(arenaReferenceLimitMessage);
      }

      const parsed = ScenarioSchema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        throw new Error(parsed.error.issues[0]?.message || '情景文件缺少必需字段');
      }

      const scenarioLabel = (parsed.data as any)?.title || (parsed.data as any)?.name || `辅助情景 ${useBattleStore.getState().auxScenarios.length + 1}`;
      const scenarioFileName =
        options?.fileName || (scenarioLabel ? `${scenarioLabel}.json` : '粘贴的辅助情景.json');
      const built = await buildAuxScenario({
        rawScenario: parsed.data,
        fileName: scenarioFileName,
        isPreset: options?.isPreset === true,
      });
      addAuxScenario(built);
      appendAdjudicationEvents((parsed.data as any).adjudicationEvents, scenarioLabel, built.adjudicationSourceKey);
      setError(null);
    },
    [addAuxScenario, appendAdjudicationEvents, buildAuxScenario, setError]
  );

  const handleMaterialUpload = useCallback(
    async (files: FileList | null) => {
      if (!files || isGenerating) return;
      const errors: string[] = [];
      for (const file of Array.from(files)) {
        try {
          if (!hasArenaReferenceCapacity()) {
            errors.push(`${file.name}: ${arenaReferenceLimitMessage}`);
            continue;
          }
          const json = JSON.parse(await file.text());
          const isNative = await verifyOrigin(json).catch(() => false);
          addMaterial(buildArenaMaterialState({ payload: json, fileName: file.name, isNative }));
        } catch (error) {
          errors.push(`${file.name}: ${error instanceof Error ? error.message : '解析失败'}`);
        }
      }
      if (errors.length > 0) {
        setError(`❌ ${errors.join('；')}`);
      } else {
        setError(null);
      }
    },
    [addMaterial, isGenerating, setError]
  );

  const handleMaterialPaste = useCallback(
    async (text: string, options?: { fileName?: string }) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (!hasArenaReferenceCapacity()) {
        throw new Error(arenaReferenceLimitMessage);
      }
      const json = JSON.parse(trimmed);
      const isNative = await verifyOrigin(json).catch(() => false);
      addMaterial(buildArenaMaterialState({ payload: json, fileName: options?.fileName ?? '粘贴素材.json', isNative }));
      setError(null);
    },
    [addMaterial, setError]
  );

  const handleToggleMaterialDataCard = useCallback(
    async (cardData: any, nextSelected: boolean) => {
      const {
        sourceDataCardId,
        sourceDataCardName,
        sourceDataCardUpdatedAt,
      } = mapDataCardRuntimeSourceInfo(cardData);
      const materialId = sourceDataCardId ? `material-card-${sourceDataCardId}` : createClientId('material-card');

      if (!nextSelected) {
        setMaterials(
          useBattleStore
            .getState()
            .materials.filter((item) =>
              sourceDataCardId ? item.sourceDataCardId !== sourceDataCardId : item.id !== materialId
            )
        );
        setError(null);
        return;
      }

      if (!hasArenaReferenceCapacity()) {
        setError(`❌ ${arenaReferenceLimitMessage}`);
        return;
      }
      if (sourceDataCardId && useBattleStore.getState().materials.some((item) => item.sourceDataCardId === sourceDataCardId)) {
        return;
      }
      if (loadingCards.has(materialId)) return;
      loadingCards.add(materialId);

      try {
        const cleanedCardData = stripLocalCardTransportMeta(cardData);
        const isNative = await verifyOrigin(cleanedCardData).catch(() => false);
        const material = buildArenaMaterialState({
          payload: cardData,
          id: materialId,
          sourceDataCardName,
          sourceDataCardId,
          sourceDataCardUpdatedAt,
          isNative,
        });
        addMaterial(material);
        setError(null);
      } catch (error) {
        setError(`❌ 添加素材失败: ${error instanceof Error ? error.message : '未知错误'}`);
      } finally {
        loadingCards.delete(materialId);
      }
    },
    [addMaterial, setError, setMaterials]
  );

  const handleResolveRandomPlaceholders = useCallback(async () => {
    const placeholders = combatants.filter((item): item is RandomCombatantPlaceholder => 'id' in item);
    if (placeholders.length === 0) return;
    setError('正在生成随机角色...');
    const newCombatantData = materializeRandomCombatants(placeholders);
    const existing = combatants.filter((item): item is CombatantData => !('id' in item));
    setCombatants([...existing, ...newCombatantData]);
    setError(null);
  }, [combatants, setCombatants, setError]);

  const handleClearRoster = useCallback(() => {
    useBattleStore.getState().clearCombatants();
    setError(null);
  }, [setError]);

  return {
    handleFileUpload,
    handlePaste,
    handleAddRandomPlaceholder,
    handleRandomMatch,
    handleScenarioUpload,
    handleScenarioPaste,
    handleAuxScenarioUpload,
    handleAuxScenarioPaste,
    handleMaterialUpload,
    handleMaterialPaste,
    handleToggleMaterialDataCard,
    handleToggleAuxScenarioDataCard,
    handleToggleCombatantDataCard,
    handleRandomMatchAuxScenario,
    handleSelectDataCard,
    handleResolveRandomPlaceholders,
    handleClearRoster,
    auxScenarios,
    materials,
    removeAuxScenario,
    moveAuxScenario,
    clearAuxScenarios,
    removeMaterial,
    moveMaterial,
    clearMaterials,
    scenario,
  };
};
