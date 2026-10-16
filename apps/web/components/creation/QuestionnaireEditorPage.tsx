'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildEditableQuestionnaire, importEditableQuestionnaire, createEmptyQuestion, type EditableQuestion } from '@mahoshojo/domain/questionnaire-editor';
import { QuestionnaireEditorPageView, QuestionnaireEditorGuide, QuestionnaireTransferWorkspace, QuestionnaireQuestionsEditor, QuestionnaireMetadataEditor, readQuestionnaireJsonFile } from '@mahoshojo/ui-web/questionnaire-editor';
import { downloadBlob } from '@/lib/client/blobUrl';
import Link from 'next/link';
import SaveToCloudButton from '@/components/SaveToCloudButton';
import Footer from '@/components/Footer';
import { ErrorMessage } from '@/components/ErrorMessage';
import DataCardsModal from '@/components/CharManager/DataCardsModal';
import RecycleBinModal from '@/components/CharManager/RecycleBinModal';
import { TokenIndicator } from '@/components/shared/TokenIndicator';
import { JsonSizeIndicator } from '@/components/shared/JsonSizeIndicator';
import {
  DEFAULT_QUESTIONNAIRE_LOGO_BY_KIND,
  MAX_QUESTIONNAIRE_IMPORT_BYTES,
} from '@/lib/questionnaires';
import { dataCardApi } from '@/lib/auth';
import { useAuth } from '@/lib/useAuth';
import { config } from '@/lib/config';
import { useDataCardSummaryPage } from '@/lib/use-data-card-summary-page';
import { useUnsavedPageGuard } from '@mahoshojo/ui-web/client';
import { exceedsUtf8ByteLimit } from '@/lib/data-card-size';

export const QuestionnaireEditorPage: React.FC = () => {
  const importIntent = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; importIntent.current += 1; }; }, []);
  const { isAuthenticated, user, identityEpoch } = useAuth();
  const [extensions, setExtensions] = useState<Record<string, unknown>>({});
  const [kind, setKind] = useState<'magical-girl' | 'canshou'>('magical-girl');
  const [questionnaireId, setQuestionnaireId] = useState('magical-girl-custom');
  const [title, setTitle] = useState('未命名问卷');
  const [description, setDescription] = useState('');
  const [loreMarkdown, setLoreMarkdown] = useState('');
  const [logoUrl, setLogoUrl] = useState(DEFAULT_QUESTIONNAIRE_LOGO_BY_KIND['magical-girl']);
  const [version, setVersion] = useState('');
  const [questions, setQuestions] = useState<EditableQuestion[]>([createEmptyQuestion(0, 'magical-girl', 'initial-1')]);
  const [importText, setImportText] = useState('');
  const [originalSource, setOriginalSource] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(true);
  const [showDataCardsModal, setShowDataCardsModal] = useState(false);
  const [showRecycleBinModal, setShowRecycleBinModal] = useState(false);
  const [cardsRefresh, setCardsRefresh] = useState(0);
  const cloudScope = `${user?.id ?? ''}:${identityEpoch}`;
  const cloudScopeRef = useRef(cloudScope);
  const cloudOperationBusy = useRef(false);
  const cloudWritePending = useRef(false);
  const [hasPendingCloudWrite, setPendingCloudWrite] = useState(false);
  if (cloudScopeRef.current !== cloudScope) { cloudScopeRef.current = cloudScope; cloudOperationBusy.current = false; }
  const [cloudBusyState, setCloudBusy] = useState({ scope: cloudScope, busy: false });
  const cloudBusy = hasPendingCloudWrite || (cloudBusyState.scope === cloudScope && cloudBusyState.busy);
  const cloudOperationGuard = useMemo(() => ({ isBlocked: () => cloudScopeRef.current !== cloudScope || cloudOperationBusy.current || cloudWritePending.current,
    onBusyChange: (value: boolean) => { if (cloudScopeRef.current === cloudScope) { cloudOperationBusy.current = value; setCloudBusy({ scope: cloudScope, busy: value }); } },
    // SaveToCloudButton owns one write ticket and releases this original notification at settlement.
    // Picker reads/metadata retain their existing scope-local busy lifecycle.
    onWritePendingChange: (value: boolean) => { cloudWritePending.current = value; if (mounted.current) setPendingCloudWrite(value); },
  }), [cloudScope]);
  useUnsavedPageGuard(() => cloudOperationBusy.current || cloudWritePending.current, '正在处理云端数据卡，请等待响应后再离开', () => false);
  const runCloudOperation = async (handler: () => Promise<void>) => {
    if (cloudOperationGuard.isBlocked()) return;
    cloudOperationGuard.onBusyChange(true);
    try { await handler(); } finally { cloudOperationGuard.onBusyChange(false); }
  };
  const [userCapacity, setUserCapacity] = useState<number | null>(null);
  const [userUsedSlots, setUserUsedSlots] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const cardsPerPage = 12;

  const questionnaireSummary = useDataCardSummaryPage('my', user?.id ?? null, isAuthenticated, {
    limit: 1, types: ['questionnaire'], includeLegacyQuestionnaires: true,
  });
  const { reload: refreshQuestionnaireSummary } = questionnaireSummary;
  const privateQuestionnaireCount = questionnaireSummary.stats?.private ?? '—';
  const publicQuestionnaireCount = questionnaireSummary.stats?.public ?? '—';
  const pendingQuestionnaireCount = questionnaireSummary.stats?.pending ?? '—';
  const defaultModalFilters = useMemo(
    () => ({ type: 'questionnaire' as const, visibility: 'private' as const }),
    []
  );

  const loadUserQuestionnaireCards = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      setCardsRefresh((value) => value + 1);
      refreshQuestionnaireSummary();
      const capacityInfo = await dataCardApi.getUserCapacity();
      if (capacityInfo !== null) {
        setUserCapacity(capacityInfo.capacity);
        setUserUsedSlots(capacityInfo.usedSlots);
      }
    } catch (error) {
      console.error('加载问卷数据卡失败:', error);
    }
  }, [isAuthenticated, refreshQuestionnaireSummary]);

  useEffect(() => {
    if (isAuthenticated) {
      loadUserQuestionnaireCards();
    } else {
      setUserCapacity(null);
      setUserUsedSlots(0);
      setShowDataCardsModal(false);
      setShowRecycleBinModal(false);
    }
  }, [isAuthenticated, loadUserQuestionnaireCards]);

  const flashMessage = (message: string) => {
    setActionMessage(message);
    setTimeout(() => setActionMessage(null), 2400);
  };

  const { questionnaireData, jsonError } = useMemo(() => buildEditableQuestionnaire({ questions, questionnaireId, kind, title, description, loreMarkdown, logoUrl, version, extensions }), [questions, questionnaireId, kind, title, description, loreMarkdown, logoUrl, version, extensions]);

  const jsonPreview = useMemo(() => JSON.stringify(questionnaireData, null, 2), [questionnaireData]);

  const handleImport = (rawText?: string) => {
    importIntent.current += 1;
    const sourceText = typeof rawText === 'string' ? rawText : importText;
    if (!sourceText.trim()) {
      setEditorError('请先粘贴或上传问卷 JSON');
      return false;
    }
    // parse 前预算：逐码点计 UTF-8 字节、超限即停（与问卷选择导入同一上限）。
    if (exceedsUtf8ByteLimit(sourceText, MAX_QUESTIONNAIRE_IMPORT_BYTES)) {
      setEditorError(`问卷 JSON 超过大小上限（${MAX_QUESTIONNAIRE_IMPORT_BYTES / 1024 / 1024} MiB）。`);
      return false;
    }
    try {
      const imported = importEditableQuestionnaire(sourceText, kind);
      setEditorError(null);
      setImportText(sourceText);
      setKind(imported.kind);
      setQuestionnaireId(imported.questionnaireId);
      setTitle(imported.title);
      setDescription(imported.description);
      setLoreMarkdown(imported.loreMarkdown);
      setLogoUrl(imported.logoUrl);
      setVersion(imported.version);
      setExtensions(imported.extensions);
      setQuestions(imported.questions);
      setOriginalSource(sourceText);
      flashMessage('✅ 已导入问卷并应用');
      return true;
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : '问卷 JSON 解析失败');
      return false;
    }
  };

  const handleImportFile = async (file: File | null) => {
    if (!file) return;
    const intent = ++importIntent.current;
    // `File.size` 不读内容即可拿到字节数：先于 file.text() 拦截超大输入。
    if (file.size > MAX_QUESTIONNAIRE_IMPORT_BYTES) {
      setEditorError(`问卷文件超过大小上限（${MAX_QUESTIONNAIRE_IMPORT_BYTES / 1024 / 1024} MiB）。`);
      return;
    }
    try {
      const text = await readQuestionnaireJsonFile(file);
      if (!mounted.current || intent !== importIntent.current) return;
      setImportText(text);
      handleImport(text);
    } catch (error) {
      if (mounted.current && intent === importIntent.current) setEditorError(error instanceof Error ? error.message : '读取文件失败');
    }
  };

  const handleImportInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    void handleImportFile(file);
    event.target.value = '';
  };

  const handlePasteFromClipboard = async () => {
    const intent = ++importIntent.current;
    try {
      const text = await navigator.clipboard.readText();
      if (!mounted.current || intent !== importIntent.current) return;
      if (!text.trim()) {
        setEditorError('剪贴板内容为空');
        return;
      }
      setImportText(text);
      handleImport(text);
    } catch (error) {
      if (mounted.current && intent === importIntent.current) setEditorError(error instanceof Error ? error.message : '读取剪贴板失败');
    }
  };

  const handleCopyJson = async () => {
    if (jsonError) {
      setEditorError(jsonError);
      return;
    }
    try {
      await navigator.clipboard.writeText(jsonPreview);
      flashMessage('✅ 已复制到剪贴板');
    } catch {
      setEditorError('复制失败，请手动选择文本');
    }
  };

  const handleDownloadJson = () => {
    if (jsonError) {
      setEditorError(jsonError);
      return;
    }
    const blob = new Blob([jsonPreview], { type: 'application/json' });
    const safeName = (title || 'questionnaire').replace(/[^a-z0-9\u4e00-\u9fa5]/gi, '_');
    downloadBlob(blob, `${safeName}.json`);
    flashMessage('✅ 已生成下载文件');
  };

  const handleOpenQuestionnaireLibrary = () => {
    if (!isAuthenticated) {
      setEditorError('请先登录后再访问云端问卷库');
      return;
    }
    loadUserQuestionnaireCards();
    setShowDataCardsModal(true);
  };

  const handleLoadQuestionnaireCard = async (card: any) => {
    const intent = ++importIntent.current;
    try {
      if (!mounted.current || intent !== importIntent.current) return;
      const raw = typeof card?.data === 'string' ? card.data : JSON.stringify(card?.data ?? {}, null, 2);
      if (!handleImport(raw)) return;
      setShowDataCardsModal(false);
      flashMessage(`✅ 已载入云端问卷：${card?.name || '未命名问卷'}`);
    } catch (error) {
      if (mounted.current && intent === importIntent.current) setEditorError(error instanceof Error ? error.message : '加载问卷数据卡失败');
    }
  };

  return (
    <>
      <QuestionnaireEditorPageView footer={<Footer />} renderLink={(props) => <Link {...props} />}>
            {actionMessage && (
              <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                {actionMessage}
              </div>
            )}
            <QuestionnaireEditorGuide />
            <QuestionnaireTransferWorkspace
              importText={importText}
              onImportTextChange={(text) => { importIntent.current += 1; setImportText(text); }}
              onImportFileChange={handleImportInputChange}
              onApplyPaste={() => { handleImport(); }}
              onPasteFromClipboard={handlePasteFromClipboard}
              onClearPaste={() => { importIntent.current += 1; setImportText(''); }}
              jsonPreview={jsonPreview}
              previewExpanded={showPreview}
              onPreviewExpandedChange={setShowPreview}
              onCopyJson={handleCopyJson}
              onDownloadJson={handleDownloadJson}
              onDownloadSource={originalSource !== null ? () => downloadBlob(new Blob([originalSource], { type: 'application/json' }), '问卷原始来源.json') : undefined}
            />

            <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-700">云端问卷库</h3>
                  <p className="mt-1 text-xs text-slate-500">浏览、管理你的问卷卡，并载入当前编辑器。</p>
                </div>
                <button
                  type="button"
                  onClick={handleOpenQuestionnaireLibrary}
                  disabled={!isAuthenticated}
                  className={`rounded-lg border px-4 py-2 text-sm transition ${
                    isAuthenticated
                      ? 'border-pink-200 bg-pink-50 text-pink-700 hover:border-pink-300 hover:bg-pink-100'
                      : 'border-slate-200 bg-slate-100 text-slate-400 cursor-not-allowed'
                  }`}
                >
                  打开问卷库
                </button>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-3 text-xs text-slate-600 md:grid-cols-3">
                <div className="rounded-lg border border-white/70 bg-white p-3">
                  <div className="text-slate-400">已保存问卷</div>
                  <div className="mt-1 text-base font-semibold text-slate-700">{questionnaireSummary.status === 'success' ? questionnaireSummary.total : '—'}</div>
                </div>
                <div className="rounded-lg border border-white/70 bg-white p-3">
                  <div className="text-slate-400">私有 / 公开</div>
                  <div className="mt-1 text-base font-semibold text-slate-700">
                    {privateQuestionnaireCount} / {publicQuestionnaireCount}
                  </div>
                </div>
                <div className="rounded-lg border border-white/70 bg-white p-3">
                  <div className="text-slate-400">待审核</div>
                  <div className="mt-1 text-base font-semibold text-slate-700">{pendingQuestionnaireCount}</div>
                </div>
              </div>
              {!isAuthenticated && (
                <p className="mt-3 text-xs text-rose-500">尚未登录，无法访问云端问卷库。</p>
              )}
              <p className="mt-2 text-xs text-slate-400">提示：默认展示私有问卷，可在筛选中切换公开状态。替换当前问卷请使用下方“替换已有”。</p>
              <p className="mt-2 text-xs text-slate-500">历史误分类问卷暂不支持一步原位覆写；载入仅导入本地编辑稿，不修改云端类型。请先导出备份，或另存为新问卷。</p>
            </div>

            <QuestionnaireMetadataEditor value={{ questions, questionnaireId, kind, title, description, loreMarkdown, logoUrl, version, extensions }}
              onChange={(patch) => {
                importIntent.current += 1; setActionMessage(null);
                if (patch.kind !== undefined) setKind(patch.kind);
                if (patch.questionnaireId !== undefined) setQuestionnaireId(patch.questionnaireId);
                if (patch.title !== undefined) setTitle(patch.title);
                if (patch.description !== undefined) setDescription(patch.description);
                if (patch.loreMarkdown !== undefined) setLoreMarkdown(patch.loreMarkdown);
                if (patch.logoUrl !== undefined) setLogoUrl(patch.logoUrl);
                if (patch.version !== undefined) setVersion(patch.version);
              }} renderLoreStats={(text) => <TokenIndicator text={text} />} />

            <QuestionnaireQuestionsEditor questions={questions} setQuestions={(update) => { importIntent.current += 1; setActionMessage(null); setQuestions(update); }} kind={kind} />

            <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
              <SaveToCloudButton
                data={questionnaireData}
                operationGuard={cloudOperationGuard}
                getData={async () => {
                  if (jsonError) throw new Error(jsonError);
                  return questionnaireData;
                }}
                cardType="questionnaire"
                buttonText="保存为云端问卷"
                className="generate-button mb-0 w-full text-sm md:w-auto md:px-6 md:py-2"
              />
              <Link href="/" className="footer-link text-sm">返回首页</Link>
            </div>
            <JsonSizeIndicator
              data={questionnaireData}
              warningText="⚠️ 接近云端 300KB 上限，保存/替换可能失败，请先精简数据。"
            />

            {(editorError || jsonError) && <ErrorMessage message={editorError || jsonError || '问卷格式错误'} />}
            <p className="mt-4 text-xs text-slate-400">提示：原生许可由管理员评估标记；自建问卷默认非原生。</p>
      </QuestionnaireEditorPageView>
      <DataCardsModal
        isOpen={showDataCardsModal}
        onClose={() => {
          importIntent.current += 1;
          setShowDataCardsModal(false);
        }}
        dataCards={[]}
        summaryOwnerId={user?.id}
        busy={cloudBusy}
        metadataGuard={cloudOperationGuard}
        onMetadataSaved={() => void loadUserQuestionnaireCards()}
        refreshKey={cardsRefresh}

        currentPage={currentPage}
        cardsPerPage={cardsPerPage}
        onPageChange={setCurrentPage}

        onLoadCard={(card) => runCloudOperation(() => handleLoadQuestionnaireCard(card))}

        userCapacity={userCapacity ?? undefined}
        userUsedSlots={userUsedSlots}
        onOpenRecycleBin={() => {
          importIntent.current += 1;
          setShowDataCardsModal(false);
          setShowRecycleBinModal(true);
        }}
        title="我的问卷库"
        emptyText="暂无问卷数据卡"
        defaultFilters={defaultModalFilters}
        allowedTypes={['questionnaire']}
        hideRoleTypeFilter={true}
        showHotHint={false}
      />
      <RecycleBinModal
        isOpen={showRecycleBinModal}
        onClose={() => setShowRecycleBinModal(false)}
        type="questionnaire"
        refreshKey={cardsRefresh}
        operationGuard={cloudOperationGuard}
        onChanged={() => void loadUserQuestionnaireCards()}
        limit={config.RECYCLE_BIN_LIMIT}
      />
    </>
  );
};
