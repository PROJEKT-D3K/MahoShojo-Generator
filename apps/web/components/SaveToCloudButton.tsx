import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import SaveCardModal from './CharManager/SaveCardModal';
import DataCardsModal from './CharManager/DataCardsModal';
import RecycleBinModal from './CharManager/RecycleBinModal';
import { useAuth } from '@/lib/useAuth';
import { authStorage, dataCardApi, type AuthData } from '@/lib/auth';
import { captureAuthIdentity } from '@/lib/auth-identity';
import { useUnsavedPageGuard } from '@mahoshojo/ui-web/client';
import { CloudCardActionButtons, ReplaceCardModal } from '@mahoshojo/ui-web/cloud-save';
import { quickCheck } from '@/lib/sensitive-word-filter';
import type { OnlineDataCardType, OwnedDataCardReplacementTarget } from '@mahoshojo/contracts/data-cards';

interface SaveToCloudButtonProps {
  data: any;
  getData?: () => Promise<any>;
  /** Dynamic-only providers can identify the result independently of callback identity. */
  sourceKey?: string | number;
  cardType?: OnlineDataCardType;
  buttonText?: string;
  defaultName?: string;
  defaultDescription?: string;
  defaultIsPublic?: number;
  className?: string;
  style?: React.CSSProperties;
  presentation?: 'generation-result';
  operationGuard?: { isBlocked: () => boolean; onBusyChange: (busy: boolean) => void };
}

// 检测是否为情景文件
const isScenarioData = (data: any): boolean => {
  if (!data) return false;
  if (data?.templateId === '通用情景' && typeof data?.content === 'string') {
    return true;
  }
  return Boolean(data && data.title && data.elements && (data.scenario_type || data.elements.events));
};

export default function SaveToCloudButton(props: SaveToCloudButtonProps) {
  return props.operationGuard ? <SaveToCloudButtonView {...props} /> : <InternallyGuardedSaveToCloudButton {...props} />;
}
function InternallyGuardedSaveToCloudButton(props: SaveToCloudButtonProps) {
  const pending = useRef(false);
  useUnsavedPageGuard(() => pending.current, '正在处理云端数据卡，请等待响应后再离开', () => false);
  return <SaveToCloudButtonView {...props} operationGuard={{ isBlocked: () => pending.current, onBusyChange: (value) => { pending.current = value; } }} />;
}
function SaveToCloudButtonView({
  data,
  getData,
  sourceKey,
  cardType,
  buttonText = "保存到云端",
  defaultName,
  defaultDescription,
  defaultIsPublic = 0,
  className = "generate-button",
  style = {},
  presentation,
  operationGuard,
}: SaveToCloudButtonProps) {
  const router = useRouter();
  const { isAuthenticated, user, authSource } = useAuth();
  const identity = captureAuthIdentity();
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [cardName, setCardName] = useState('');
  const [cardDescription, setCardDescription] = useState('');
  const [isPublic, setIsPublic] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isOperating, setIsOperating] = useState(false);
  const [preparedData, setPreparedData] = useState<any>(null);
  const [cardsRefresh, setCardsRefresh] = useState(0);
  const [userCapacity, setUserCapacity] = useState<number | undefined>(undefined);
  const [userUsedSlots, setUserUsedSlots] = useState<number | undefined>(undefined);
  const [showDataCardsForReplace, setShowDataCardsForReplace] = useState(false);
  const [showRecycleBin, setShowRecycleBin] = useState(false);
  const [replaceCurrentPage, setReplaceCurrentPage] = useState(1);
  const [replacementTarget, setReplacementTarget] = useState<OwnedDataCardReplacementTarget | null>(null);
  const [replacementOpen, setReplacementOpen] = useState(false);
  const [replacementError, setReplacementError] = useState<string | null>(null);
  const [replacementUncertain, setReplacementUncertain] = useState(false);
  const [replacementConflict, setReplacementConflict] = useState(false);
  const replacementUnknown = useRef(false);
  const replacementSelection = useRef<{ data: unknown; expectedAuth: AuthData | null; context: string } | null>(null);


  const [uncertain, setUncertain] = useState(false);
  const [checkedOwnCards, setCheckedOwnCards] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  const guardRef = useRef(operationGuard); guardRef.current = operationGuard;
  const releaseGuard = useRef<(() => void) | null>(null);
  const busyTicket = useRef<object | null>(null);
  const setOperationBusy = useCallback((value: boolean): (() => void) | undefined => {
    if (busy.current === value) return;
    busy.current = value;
    // A stale operation still releases its ticket; the current controls must observe that release.
    if (mounted.current) setIsOperating(value);
    if (value) {
      const ticket = {}; busyTicket.current = ticket;
      const guard = guardRef.current; releaseGuard.current = guard ? () => guard.onBusyChange(false) : null; guard?.onBusyChange(true);
      return () => { if (busyTicket.current === ticket) setOperationBusy(false); };
    }
    busyTicket.current = null;
    const release = releaseGuard.current; releaseGuard.current = null; release?.();
  }, []);
  const isOperationBlocked = () => !identity.isCurrent() || busy.current || Boolean(guardRef.current?.isBlocked());
  const operation = useRef(0);
  const capacityOperation = useRef(0);
  // Compare source content, not callbacks: callers often recreate getData on every render.
  let source = '';
  try { source = JSON.stringify([sourceKey, data, cardType, defaultName, defaultDescription, defaultIsPublic]); }
  catch { source = 'invalid-data'; }
  // Even an A → logout → A transition with identical credentials revokes the old intent.
  const context = `${user?.id ?? ''}:${identity.epoch}:${isAuthenticated}:${authSource ?? ''}:${source}`;
  const latestContext = useRef(context);
  latestContext.current = context;
  const isContextCurrent = (ownerContext: string) => identity.isCurrent() && ownerContext === latestContext.current;
  const draftContext = useRef<string | null>(null);
  const uncertainRef = useRef(false);

  useEffect(() => {
    operation.current += 1;
    capacityOperation.current += 1;
    if (!guardRef.current) setOperationBusy(false);
    draftContext.current = null;
    uncertainRef.current = false;
    setPreparedData(null);
    setShowSaveModal(false);
    setIsPreparing(false);
    setIsSaving(false);
    setSaveError(null);
    setUncertain(false);
    setCheckedOwnCards(false);
    setUserCapacity(undefined);
    setUserUsedSlots(undefined);
    setShowDataCardsForReplace(false); setShowRecycleBin(false);
    setReplacementTarget(null); setReplacementOpen(false); setReplacementError(null);
    setReplacementUncertain(false); setReplacementConflict(false);
    replacementUnknown.current = false; replacementSelection.current = null;
  }, [context, setOperationBusy]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operation.current += 1; const release = releaseGuard.current; releaseGuard.current = null; release?.(); };
  }, []);

  const navigateToArrested = () => router.push('/arrested');

  const loadUserDataCards = async () => {
    const ownerContext = context;
    const request = ++capacityOperation.current;
    setCardsRefresh((value) => value + 1);
    setUserCapacity(undefined);
    setUserUsedSlots(undefined);
    const capacityInfo = await dataCardApi.getUserCapacity().catch(() => null);
    if (!mounted.current || !isContextCurrent(ownerContext) || request !== capacityOperation.current) return;
    if (capacityInfo) {
      setUserCapacity(capacityInfo.capacity);
      setUserUsedSlots(capacityInfo.usedSlots);
    }
  };

  const resolveData = async (): Promise<any | null> => {
    if (isOperationBlocked()) return null;
    const releaseOperation = setOperationBusy(true);
    const token = ++operation.current;
    const ownerContext = context;
    setIsPreparing(true);
    setPreparedData(null);
    try {
      const next = getData ? await getData() : data;
      if (!mounted.current || token !== operation.current || !isContextCurrent(ownerContext)) return null;
      if (!next) return null;
      // Freeze the complete wire data; subsequent source mutations must not alter a draft.
      const snapshot = JSON.parse(JSON.stringify(next));
      setPreparedData(snapshot);
      draftContext.current = ownerContext;
      return snapshot;
    } catch (error) {
      if (!mounted.current || token !== operation.current || !isContextCurrent(ownerContext)) return null;
      throw error;
    } finally {
      releaseOperation?.();
      if (token === operation.current && mounted.current) setIsPreparing(false);
    }
  };

  const handleSaveClick = async () => {
    if (isOperationBlocked()) return;
    if (replacementUnknown.current) { setReplacementOpen(true); return; }
    if (!isAuthenticated) {
      alert('请先登录后再保存到云端');
      return;
    }
    // Closing a rejected/uncertain draft must not silently reset its retry decision.
    if (draftContext.current === context && preparedData) {
      setShowSaveModal(true);
      void loadUserDataCards();
      return;
    }
    const ownerContext = context;
    const preparation = operation.current + 1;
    let resolvedData;
    try { resolvedData = await resolveData(); }
    catch (error) {
      if (isContextCurrent(ownerContext) && mounted.current) alert(error instanceof Error ? error.message : '准备保存数据失败。');
      return;
    }
    if (!mounted.current || preparation !== operation.current || !isContextCurrent(ownerContext)) return;
    if (!resolvedData) { alert('没有可保存的数据。'); return; }
    const type = cardType ?? (isScenarioData(resolvedData) ? 'scenario' : 'character');
    const inferredName = type === 'character'
      ? (resolvedData?.codename || resolvedData?.name || '')
      : (resolvedData?.title || resolvedData?.name || (type === 'history' ? '叙事历史' : type === 'questionnaire' ? '问卷' : ''));
    const inferredDescription = type === 'history' ? '叙事历史数据卡' : type === 'scenario' ? '情景数据卡' : type === 'questionnaire' ? '问卷数据卡' : '角色数据卡';
    setCardName(defaultName?.trim() ? defaultName : inferredName);
    setCardDescription(defaultDescription?.trim() ? defaultDescription : inferredDescription);
    setIsPublic(defaultIsPublic);
    setSaveError(null);
    setShowSaveModal(true);
    void loadUserDataCards();
  };

  const handleReplaceFromDataCards = async (card: any) => {
    if (isOperationBlocked() || uncertainRef.current || replacementUnknown.current || !isAuthenticated || !user?.id || draftContext.current !== context || !preparedData) return;
    const type = cardType ?? (isScenarioData(preparedData) ? 'scenario' : 'character');
    if (card.type !== type) { alert('请选择与当前内容类型相同的数据卡'); return; }
    const releaseOperation = setOperationBusy(true); setIsPreparing(true);
    const token = ++operation.current;
    const ownerContext = context;
    const isCurrent = () => mounted.current && token === operation.current && isContextCurrent(ownerContext);
    try {
      const expectedAuth = await authStorage.getAuth();
      if (!isCurrent()) return;
      const result = await dataCardApi.readOwnedReplacementTarget(card.id, { expectedUserId: user.id, expectedAuth, isCurrent });
      if (!isCurrent()) return;
      if (!result.success || !result.target || result.target.type !== type) { alert(result.error || '目标卡片类型已变化，请重新选择'); return; }
      replacementSelection.current = { data: JSON.parse(JSON.stringify(preparedData)), expectedAuth, context: ownerContext };
      setReplacementTarget(result.target); setReplacementConflict(false); setReplacementError(null);
      setShowDataCardsForReplace(false); setReplacementOpen(true);
    } catch (error) { if (isCurrent()) alert(error instanceof Error ? error.message : '读取替换目标失败'); }
    finally { releaseOperation?.(); if (isCurrent()) setIsPreparing(false); }
  };

  const handleConfirmReplacement = async () => {
    const selection = replacementSelection.current;
    if (isOperationBlocked() || uncertainRef.current || replacementUnknown.current || replacementConflict || !replacementOpen || !replacementTarget || !selection || selection.context !== context || !user?.id) return;
    const releaseOperation = setOperationBusy(true); setIsSaving(true); setReplacementError(null);
    const token = ++operation.current;
    const ownerContext = context;
    const isCurrent = () => mounted.current && token === operation.current && isContextCurrent(ownerContext);
    const target = replacementTarget;
    let sent = false;
    try {
      const checked = await quickCheck(`${target.name} ${target.description || ''} ${JSON.stringify(selection.data)}`);
      if (!isCurrent()) return;
      if (checked.hasSensitiveWords) { navigateToArrested(); return; }
      sent = true;
      const result = await dataCardApi.replaceOwnedCard(target, selection.data, { expectedUserId: user.id, expectedAuth: selection.expectedAuth, isCurrent });
      if (!isCurrent()) return;
      if (result.success) {
        alert(result.pendingReview ? '更新已提交审核，审核通过后生效' : '已替换成功');
        setReplacementOpen(false); setReplacementTarget(null); replacementSelection.current = null;
        void loadUserDataCards();
      } else {
        setReplacementError(result.error || '替换被拒绝，输入已保留');
        setReplacementConflict(result.conflict === true);
        if (result.uncertain) { replacementUnknown.current = true; setReplacementUncertain(true); setCheckedOwnCards(false); }
        if (result.error === 'SENSITIVE_WORD_DETECTED') navigateToArrested();
      }
    } catch (error) {
      if (!isCurrent()) return;
      if (sent) { replacementUnknown.current = true; setReplacementUncertain(true); setCheckedOwnCards(false); setReplacementError('替换结果不确定，请检查我的云端卡及待审版本；不会自动重发。'); }
      else setReplacementError(error instanceof Error ? error.message : '准备替换失败，输入已保留');
    } finally { releaseOperation?.(); if (isCurrent()) setIsSaving(false); }
  };

  const handleSave = async () => {
    if (isOperationBlocked() || uncertainRef.current || replacementUnknown.current || draftContext.current !== context) return;
    if (!cardName.trim() || cardName.length > 20 || cardDescription.length > 300) {
      setSaveError(!cardName.trim() ? '请输入数据卡名称' : '名称最多 20 字符，描述最多 300 字符');
      return;
    }
    if (!isAuthenticated || !user?.id || !preparedData) {
      setSaveError('登录状态或保存数据已改变，请重新打开保存窗口。');
      return;
    }
    const releaseOperation = setOperationBusy(true);
    const token = ++operation.current;
    const ownerContext = context;
    const isCurrent = () => mounted.current && token === operation.current && isContextCurrent(ownerContext);
    const submission = {
      userId: user.id,
      name: cardName,
      description: cardDescription,
      isPublic,
      data: JSON.parse(JSON.stringify(preparedData)),
      type: cardType ?? (isScenarioData(preparedData) ? 'scenario' : 'character'),
    };
    setIsSaving(true);
    setSaveError(null);
    let sent = false;
    try {
      const expectedAuth = await authStorage.getAuth();
      if (!isCurrent()) return;
      const textToCheck = `${submission.name} ${submission.description} ${JSON.stringify(submission.data)}`;
      const sensitiveWordResult = await quickCheck(textToCheck);
      if (!isCurrent()) return;
      if (sensitiveWordResult.hasSensitiveWords) { navigateToArrested(); return; }
      sent = true;
      const result = await dataCardApi.createCard(
        submission.type, submission.name, submission.description, submission.data, submission.isPublic,
        { expectedUserId: submission.userId, expectedAuth, isCurrent },
      );
      const currentAuth = await authStorage.getAuth();
      if (!isCurrent()) return;
      if (JSON.stringify(currentAuth) !== JSON.stringify(expectedAuth)) {
        setSaveError('登录状态已改变。请检查原账号的云端卡，确认本次保存结果。');
        uncertainRef.current = true;
        setUncertain(true);
        return;
      }
      if (result.success && typeof result.id === 'string' && result.id.trim()) {
        alert(`数据卡保存成功！${submission.isPublic === 1 ? '（公开）' : '（私有）'}`);
        setShowSaveModal(false);
        setPreparedData(null);
        draftContext.current = null;
        setCardName('');
        setCardDescription('');
        setIsPublic(0);
        void loadUserDataCards();
      } else if (result.uncertain || result.success) {
        uncertainRef.current = true;
        setUncertain(true);
        setCheckedOwnCards(false);
        setSaveError('保存结果不确定，数据卡可能已创建。请先检查“我的云端卡”，再决定是否再次新建。');
      } else {
        if (result.error === 'SENSITIVE_WORD_DETECTED' || result.redirect === '/arrested') {
          navigateToArrested();
          return;
        }
        setSaveError(result.error || '保存被拒绝，输入已保留。');
      }
    } catch (error) {
      if (!isCurrent()) return;
      if (sent) {
        uncertainRef.current = true;
        setUncertain(true);
        setCheckedOwnCards(false);
        setSaveError('保存结果不确定，数据卡可能已创建。请先检查“我的云端卡”，再决定是否再次新建。');
      } else {
        setSaveError(error instanceof Error ? error.message : '准备保存失败，输入已保留。');
      }
    } finally {
      releaseOperation?.();
      if (isCurrent()) setIsSaving(false);
    }
  };

  const effectiveData = draftContext.current === context ? preparedData : data;
  const canOperate = Boolean(data || getData);

  const handleReplaceClick = () => {
    if (isOperationBlocked()) return;
    if (uncertainRef.current) { setShowSaveModal(true); return; }
    if (replacementUnknown.current) { setReplacementOpen(true); return; }
    if (!isAuthenticated) {
      alert('请先登录后再替换到云端');
      return;
    }
    void (async () => {
      const ownerContext = context;
      const preparation = operation.current + 1;
      let hadResolveError = false;
      const resolvedData = await resolveData().catch((error) => {
        hadResolveError = true;
        console.error("准备替换数据失败:", error);
        alert(error instanceof Error ? error.message : '准备替换数据失败。');
        return null;
      });
      if (!mounted.current || !isContextCurrent(ownerContext) || preparation !== operation.current) return;
      if (!resolvedData) {
        if (!hadResolveError) {
          alert('没有可替换的数据。');
        }
        return;
      }
      setShowDataCardsForReplace(true);
      setReplaceCurrentPage(1);
      void loadUserDataCards();
    })();
  };

  return (
    <>
      {presentation === 'generation-result' ? <CloudCardActionButtons
        onSave={() => void handleSaveClick()}
        onReplace={handleReplaceClick}
        saveLabel={isPreparing ? '准备中...' : buttonText}
        saveDisabled={!canOperate || isOperating || isPreparing || isSaving || Boolean(operationGuard?.isBlocked())}
        replaceDisabled={!canOperate || isOperating || isPreparing || isSaving || Boolean(operationGuard?.isBlocked())}
      /> : <>
        <button
          onClick={() => void handleSaveClick()}
          className={className}
          style={style}
          disabled={!canOperate || isOperating || isPreparing || isSaving || Boolean(operationGuard?.isBlocked())} // 如果没有数据且无法动态准备，则禁用
        >
          {isPreparing ? '准备中...' : buttonText}
        </button>
        <button
          onClick={handleReplaceClick}
          className={`${className} ml-2`}
          style={{ ...style, backgroundColor: '#f59e0b', backgroundImage: 'linear-gradient(to right, #f59e0b, #f97316)' }}
          disabled={!canOperate || isOperating || isPreparing || isSaving || Boolean(operationGuard?.isBlocked())}
        >
          替换已有
        </button>
      </>}

      <SaveCardModal
        isOpen={showSaveModal}
        onClose={() => { if (!busy.current) setShowSaveModal(false); }}
        onSave={handleSave}
        data={effectiveData}
        name={cardName}
        description={cardDescription}
        isPublic={isPublic}
        onNameChange={setCardName}
        onDescriptionChange={setCardDescription}
        onPublicChange={setIsPublic}
        error={saveError}
        isSaving={isSaving}
        submitDisabled={uncertain}
        supplementaryContent={uncertain ? (
          <div className="mt-3 text-sm">
            <a href="/character-manager" target="_blank" rel="noopener noreferrer" className="underline" onClick={() => setCheckedOwnCards(true)}>检查我的云端卡</a>
            <button type="button" disabled={!checkedOwnCards || isSaving} className="ml-3 underline disabled:opacity-50" onClick={() => {
              if (!checkedOwnCards || busy.current) return;
              if (!window.confirm('已检查我的云端卡？再次新建可能产生重复数据卡，是否继续？')) return;
              uncertainRef.current = false;
              setUncertain(false);
              setSaveError(null);
            }}>已检查，允许再次新建</button>
          </div>
        ) : undefined}
        usedSlots={userUsedSlots}
        userCapacity={userCapacity}
      />

      <ReplaceCardModal isOpen={replacementOpen} target={replacementTarget ? { ...replacementTarget, reviewStatus: replacementTarget.reviewStatus ?? undefined } : null}
        onClose={() => { if (!busy.current) setReplacementOpen(false); }} onConfirm={() => void handleConfirmReplacement()}
        isSaving={isSaving} submitDisabled={replacementUncertain || replacementConflict} error={replacementError}
        supplementaryContent={replacementUncertain ? <div className="space-y-2">
          <a href="/character-manager" target="_blank" rel="noopener noreferrer" onClick={() => setCheckedOwnCards(true)}>检查我的云端卡及待审版本</a>
          <button disabled={!checkedOwnCards || isSaving} onClick={() => {
            if (!checkedOwnCards || busy.current || !window.confirm('已检查我的云端卡及待审版本？请重新选择目标并确认新的替换，是否继续？')) return;
            replacementUnknown.current = false; setReplacementUncertain(false); setReplacementOpen(false); setReplacementTarget(null);
            replacementSelection.current = null; setShowDataCardsForReplace(true); setCardsRefresh((value) => value + 1);
          }}>我已检查，重新选择目标</button>
        </div> : replacementConflict ? <button onClick={() => { if (!busy.current) { setReplacementOpen(false); setReplacementTarget(null); replacementSelection.current = null; setShowDataCardsForReplace(true); setCardsRefresh((value) => value + 1); } }}>重新选择替换目标</button> : undefined} />
      <DataCardsModal
        isOpen={showDataCardsForReplace}
        busy={isSaving}
        onClose={() => {
          if (isSaving) return;
          operation.current++; setOperationBusy(false); setIsPreparing(false);
          setShowDataCardsForReplace(false);
        }}
        dataCards={[]}
        summaryOwnerId={user?.id}
        metadataGuard={operationGuard ? { isBlocked: isOperationBlocked, onBusyChange: setOperationBusy } : undefined}
        onMetadataSaved={() => void loadUserDataCards()}
        refreshKey={cardsRefresh}

        currentPage={replaceCurrentPage}
        cardsPerPage={8}
        onPageChange={setReplaceCurrentPage}

        onLoadCard={() => {}}

        onReplaceCard={handleReplaceFromDataCards}
        onOpenRecycleBin={() => { setShowDataCardsForReplace(false); setShowRecycleBin(true); }}
        userCapacity={userCapacity}
        userUsedSlots={userUsedSlots}
        title="替换已有数据卡"
        emptyText="暂无数据卡"
        defaultFilters={cardType ? { type: cardType } : undefined}
        allowedTypes={cardType ? [cardType] : undefined}
        hideEditData={true}
        allowHistoryReplace={cardType === 'history'}
        showHotHint={false}
      />
      <RecycleBinModal isOpen={showRecycleBin} onClose={() => setShowRecycleBin(false)} refreshKey={cardsRefresh}
        operationGuard={{ isBlocked: isOperationBlocked, onBusyChange: setOperationBusy }} onChanged={() => void loadUserDataCards()} />
    </>
  );
}
