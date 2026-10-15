import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Link, useRouter } from '@tanstack/react-router';
import { isTavernMagicalGirlProjection, buildTavernScenarioFragment, convertTavernToGeneralCard, convertTavernToGeneralScenarioCard, convertTavernToCanshouCard, convertTavernToMagicalGirlCard, normalizeTavernCard, TAVERN_CANSHOU_TEMPLATE_ID, type TavernParseResult } from '@mahoshojo/domain/tavern-card';
import { isTavernGeneralCharacter, isTavernGeneralScenario, getTavernMagicalGirlPreview, TavernConversionControls, describeTavernGenerationMode, isTavernStructuredScenario, TavernTemplateSelector, TAVERN_LOCAL_IMPORT_TEMPLATES, TavernPlaceholderFields, useTavernPlaceholderPreference, TavernTabs, TavernTabPanels, TavernLocalExportPanel, TavernHeroBanner, TavernFileInput, TavernCandidateSelector, TavernCardPreview, TavernOriginalExport, TavernLocalProjection, TavernLocalSources, useTavernSourceSelection, readTavernFile, type TavernInputFile } from '@mahoshojo/ui-web/tavern';
import { GeneralScenarioCard } from '@mahoshojo/ui-web/scenario';
import { MagicalGirlCard, resolveMagicalGirlGradient, type CanshouDetails, CanshouCard, GeneralCharacterCard } from '@mahoshojo/ui-web/character-card';
import { ProductFooter } from '@mahoshojo/ui-web/shell';
import { IpcLocalCardRepository } from '../platform/local-card-bridge';
import { exportTavernFile, getDesktopTavernBase, saveDesktopTavernCard } from '../features/tavern/host';
import { useLeaveGuard } from './useLeaveGuard';
import { useExternalLinks } from '../features/external-links/external-links-provider';
import { navigateByProductHref, resolveInternalHrefForHashHistory } from './hash-history-fragment';

import { TavernAiSession } from '../features/tavern/session';
import { buildTavernHostedBody, prepareTavernGenerationInput, validateTavernGeneratedCard, type TavernGenerationInput } from '../features/tavern/generation';
import { DesktopAiProviderPanel } from '../features/ai-config/desktop-ai-provider-panel';
import { useDesktopAiConfig } from '../features/ai-config/use-desktop-ai-config';
import { resolveDesktopAiTarget } from '../features/ai-config/desktop-ai-config';
import { useCooldown } from '@mahoshojo/ui-web/cooldown';
import { useDesktopCloudSession } from '../features/account/use-desktop-cloud-session';
import { GenerationMarkdownPreview } from './generation-markdown-preview';
import { QuestionnaireDraftPanel } from './questionnaire-draft-panel';

const SYSTEM_COOLDOWN_MS = 120_000;
const PRESET_COOLDOWN_MS = 3_000;

function TavernPage({ session }: { session: TavernAiSession }) {
  const ai = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { state: aiState, store: aiStore } = useDesktopAiConfig();
  const target = resolveDesktopAiTarget(aiState.selection, aiState.profiles, aiState.generationOverrides, aiState.modelsByProfileId, aiState.presetsByProviderId);
  const { state: cloudState, store: cloudStore } = useDesktopCloudSession();
  const preset = target.providerTarget?.kind === 'preset';
  const cooldownMs = preset ? PRESET_COOLDOWN_MS : SYSTEM_COOLDOWN_MS;
  const { isCooldown, remainingTime, startCooldown } = useCooldown(`tavernConvertCooldown:${preset ? 'custom' : 'system'}`, cooldownMs);
  const serverCooldown = target.location === 'server' && isCooldown;
  const accountBusy = target.location === 'server' && (!cloudState.bootstrapped || cloudState.verification === 'checking' || cloudState.authFlow.kind !== 'idle');
  const [providerDirty, setProviderDirty] = useState(false);
  const [mode, setMode] = useState<'rules' | 'ai'>(ai.draft.input ? 'ai' : 'rules');
  const [languageExpanded, setLanguageExpanded] = useState(false);
  const [languages, setLanguages] = useState<{ code: string; name: string }[]>([]);
  const requestLock = useRef(false);
  const generating = ai.phase === 'generating' || aiState.generationActive;
  const generationMode = ai.draft.generationMode ?? 'non-stream';
  const hostedStreamUnavailable = generationMode === 'stream' && target.location === 'server';
  const streamUnavailableReason = '酒馆服务器目前仅支持非流式 JSON；流式转换请选择客户端执行。';

  const router = useRouter();
  const idPrefix = useId();
  const { openFixed } = useExternalLinks();
  const repository = useMemo(() => new IpcLocalCardRepository((command, args) => invoke(command, args as never)), []);
  const [tab, setTab] = useState<'import' | 'export'>('import');
  const [exporting, setExporting] = useState(false);
  const exportBusy = useRef(false);
  const onExportBusy = useCallback((value: boolean) => { exportBusy.current = value; setExporting(value); }, []);
  const [result, setResult] = useState<TavernParseResult | null>(null);
  const [basePng, setBasePng] = useState<Uint8Array>();
  const [index, setIndex] = useState(0);
  const [template, setTemplate] = useState<typeof TAVERN_LOCAL_IMPORT_TEMPLATES[number]>(ai.draft.input?.template ?? 'general');
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const { preference, setPreference, isHydrated: placeholderHydrated } = useTavernPlaceholderPreference();
  const sourceSelection = useTavernSourceSelection();
  const busy = useRef(false);
  const guard = useLeaveGuard(() => busy.current || exportBusy.current || requestLock.current || aiStore.isPreparingGeneration() || session.isBusy() || session.hasUnsavedDraft() || providerDirty,
    '生成、导出尚未完成，或草稿/AI 配置未保存。请等待、取消或导出后再离开。', undefined, () => {
      if (busy.current || exportBusy.current || ai.saving) return false;
      if (!window.confirm('确认终止当前操作并离开？未保存的内容和 AI 配置可能丢失。')) return false;
      aiStore.cancelPreparingGeneration(); session.cancel(); return true;
    });
  const blocked = generating || reading || saving || ai.pendingRestore || !guard.ready;
  const clearAiOutput = () => { session.clearOutput(); session.updateDraft({ ...session.getSnapshot().draft, input: null }); };
  const confirmChange = (clear = true, unmountProvider = false) => {
    if (busy.current || requestLock.current || session.isBusy() || aiStore.isPreparingGeneration()) return false;
    if (unmountProvider && providerDirty && !window.confirm('AI 连接配置或 API Key 尚未保存。切换会关闭配置面板，确认放弃未保存的配置？')) return false;
    if ((session.hasUnsavedResult() || session.hasUnsavedDraft() || ai.rawText) && !window.confirm('更改转换输入会清除当前 AI 结果与原始输出。请先下载或保存需要保留的内容。确认继续？')) return false;
    if (clear) clearAiOutput(); return true;
  };
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/languages.json', { signal: controller.signal, credentials: 'omit', redirect: 'error' })
      .then(response => response.ok ? response.json() : [])
      .then(value => { if (!controller.signal.aborted && Array.isArray(value)) setLanguages(value); }).catch(() => undefined);
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const stop = () => { aiStore.cancelPreparingGeneration(); session.cancel(); };
    window.addEventListener('pagehide', stop);
    return () => { window.removeEventListener('pagehide', stop); stop(); };
  }, [aiStore, session]);
  useEffect(() => {
    const input = session.getSnapshot().draft.input;
    if (!input) return;
    let disposed = false;
    const bytes = new TextEncoder().encode(JSON.stringify(input.raw));
    setReading(true); busy.current = true;
    void readTavernFile({ name: 'restored.json', size: bytes.length, arrayBuffer: async () => bytes.buffer }).then(next => {
      if (!disposed) { setResult(next.parsed); setIndex(0); }
    }).catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : '恢复原件失败'); })
      .finally(() => { if (!disposed) { busy.current = false; setReading(false); } });
    return () => { disposed = true; };
  }, [session]);
  async function read(file: TavernInputFile | null) {
    if (!file || busy.current || blocked || !confirmChange(false)) return;
    const current = sourceSelection.begin();
    busy.current = true; setReading(true); setError('');
    try {
      const next = await readTavernFile(file);
      if (!sourceSelection.isCurrent(current)) return;
      clearAiOutput();
      setResult(next.parsed); setBasePng(next.basePngBytes); setIndex(next.parsed.candidates.indexOf(next.parsed.selected));
    } catch (cause) { if (sourceSelection.isCurrent(current)) setError(cause instanceof Error ? cause.message : '读取失败'); }
    finally { busy.current = false; if (sourceSelection.isCurrent(current)) setReading(false); }
  }
  const candidate = result?.candidates[index];
  const normalized = useMemo(() => candidate ? normalizeTavernCard(candidate).normalized : null, [candidate]);
  const conversion = useMemo(() => {
    try { return { projection: candidate && template !== 'scenario' ? (template === 'magical-girl' ? convertTavernToMagicalGirlCard(candidate, preference) : template === 'canshou' ? convertTavernToCanshouCard(candidate, preference) : template === 'general-scenario' ? convertTavernToGeneralScenarioCard(candidate, preference) : convertTavernToGeneralCard(candidate, preference)) : null, error: null }; }
    catch (cause) { return { projection: null, error: cause instanceof Error ? cause.message : '转换失败，原件仍保留。' }; }
  }, [candidate, preference, template]);
  const aiCard = useMemo(() => ai.card ? validateTavernGeneratedCard(ai.cardKind, ai.card) : null, [ai.card, ai.cardKind]);
  const scenarioPreview = useMemo(() => aiCard && isTavernStructuredScenario(aiCard)
    ? buildTavernScenarioFragment(aiCard) ?? { title: '情景', content: JSON.stringify(aiCard, null, 2) } : null, [aiCard]);
  const projection = mode === 'ai' ? aiCard : conversion.projection;
  const { aiInput, aiInputError, warnings } = useMemo(() => {
    if (!candidate) return { aiInput: null, aiInputError: null, warnings: [] };
    const aiInput: TavernGenerationInput = { raw: candidate.parsed, template, language: ai.draft.language, preference };
    try {
      if (target.location === 'server') buildTavernHostedBody(aiInput);
      return { aiInput, aiInputError: null, warnings: prepareTavernGenerationInput(aiInput).warnings };
    }
    catch (cause) { return { aiInput, aiInputError: cause instanceof Error ? cause.message : 'AI 输入无效', warnings: [] }; }
  }, [candidate, template, ai.draft.language, preference, target.location]);
  const unavailable = target.unavailableReason;
  const generateDisabled = blocked || hostedStreamUnavailable || serverCooldown || accountBusy || !placeholderHydrated || !aiInput || !!aiInputError || !!unavailable || (target.location === 'client' && !target.mode) || !target.providerTarget || aiState.overlayState !== 'ready' || (target.profile !== null && aiState.profilesState !== 'ready');
  const generate = () => {
    if (generateDisabled || requestLock.current || session.isBusy() || !aiInput) return;
    if ((session.hasUnsavedResult() || ai.rawText) && !window.confirm('重新转换会替换当前 AI 结果与原始输出，且可能产生新的模型费用。确认继续？')) return;
    if (ai.phase === 'uncertain' && !window.confirm('上次转换是否已在服务器执行仍无法确认。再次转换可能产生重复调用与费用。确认继续？')) return;
    const account = cloudStore.getSnapshot();
    const owner = { userId: account.account?.userId ?? null, epoch: cloudStore.getCredentialEpoch(), verification: account.verification, authFlow: account.authFlow };
    const frozen = JSON.parse(JSON.stringify(aiInput)) as TavernGenerationInput;
    const frozenGenerationMode = generationMode;
    requestLock.current = true; setError('');
    session.updateDraft({ language: frozen.language, input: frozen, generationMode: frozenGenerationMode });
    void aiStore.withPreparedGeneration(async prepared => {
      if (!prepared.providerTarget || prepared.unavailableReason || (prepared.location === 'client' && !prepared.mode)) throw new Error('请选择可用的转换通道。');
      const hosted = prepared.location === 'server';
      if (hosted && frozenGenerationMode === 'stream') throw new Error(streamUnavailableReason);
      const current = cloudStore.getSnapshot();
      if (hosted && ((current.account?.userId ?? null) !== owner.userId || cloudStore.getCredentialEpoch() !== owner.epoch || current.verification !== owner.verification || current.authFlow !== owner.authFlow || current.authFlow.kind !== 'idle')) throw new Error('准备期间账号状态已变化，输入已保留，请重新确认转换。');
      await session.generate({ invoke, profileId: prepared.profile?.id ?? '', providerTarget: prepared.providerTarget,
        ...(hosted ? { onHostedDispatchSettled: (retryAfterSeconds?: number) => startCooldown(retryAfterSeconds === undefined ? cooldownMs : retryAfterSeconds * 1000) } : {}) }, frozen,
        { ...(hosted ? { mode: 'hosted-json' as const, generationMode: 'non-stream' as const } : { mode: prepared.mode!, generationMode: frozenGenerationMode }), modelId: prepared.modelId ?? undefined, overrides: prepared.generationOverrides }, true);
    }).catch(cause => setError(cause instanceof Error ? cause.message : 'AI 配置准备失败'))
      .finally(() => { requestLock.current = false; });
  };
  return <div className="magic-background-white"><div className="container !max-w-[980px]"><div className="card !max-w-none !p-0">
    <TavernHeroBanner title="酒馆生态" subtitle="SillyTavern 角色卡（PNG 内嵌 JSON）导入/导出工具" actions={<TavernTabs idPrefix={idPrefix} tab={tab} onChange={setTab} disabled={blocked || exporting} />} right={<Link to="/" className="text-sm text-pink-700 hover:underline">返回首页</Link>} />
    <div className="p-6">
      <p className="text-center text-xs text-gray-600">本地解析与导出 PNG / JSON、规则映射和卡库读写。仅选择 AI 深度转换并点击转换时，裁剪后的设定才会发送给所选供应商；云保存尚未接入。</p>
      <TavernTabPanels idPrefix={idPrefix} tab={tab} exportPanel={<TavernLocalExportPanel repository={repository} exportFile={exportTavernFile} getDefaultBase={getDesktopTavernBase} disabled={!guard.ready} onBusyChange={onExportBusy} />} importPanel={<>
      <TavernLocalSources selection={sourceSelection} repository={repository} disabled={blocked} onSource={(file) => void read(file)} />
      <TavernFileInput disabled={blocked} onFileSelected={(file) => void read(file)} />
      {reading ? <p role="status">解析中…</p> : null}
      {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}
      {candidate && normalized && result ? <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4"><TavernCandidateSelector candidates={result.candidates} selectedIndex={index} onSelect={(next) => { if (confirmChange()) { sourceSelection.begin(); setIndex(next); } }} disabled={blocked} />
          <TavernTemplateSelector value={template} templates={TAVERN_LOCAL_IMPORT_TEMPLATES} disabled={blocked}
            onChange={(next) => { if (confirmChange()) { sourceSelection.begin(); setTemplate(next); if (next === 'scenario' || next === 'magical-girl') setMode('ai'); } }} />
          <TavernPlaceholderFields preference={preference} name={normalized.name} onChange={(next) => { if (confirmChange()) setPreference(next); }} disabled={blocked || !placeholderHydrated} />
          <TavernConversionControls mode={mode} onModeChange={next => { if (next === 'rules' && template === 'scenario') return; if (confirmChange(true, next === 'rules')) setMode(next); }} disabled={blocked}
            rulesDisabledReason={template === 'scenario' ? '结构化情景目前仅支持 AI 深度转换，尚未提供规则映射。' : undefined}
            aiDescription="裁剪后的设定将通过所选客户端或服务器通道发送；完成结果通过共源 schema 校验，原件单独保留。"
            language={ai.draft.language} languages={languages.length ? languages : [{ code: ai.draft.language, name: ai.draft.language }]}
            onLanguageChange={language => { if (confirmChange()) session.updateDraft({ ...session.getSnapshot().draft, language }); }}
            languageExpanded={languageExpanded} onLanguageExpandedChange={setLanguageExpanded}
            generationMode={generationMode} onGenerationModeChange={next => { if (next === 'stream' && target.location === 'server') return; if (confirmChange()) session.updateDraft({ ...session.getSnapshot().draft, generationMode: next }); }}
            generationModeDisabledReasons={target.location === 'server' ? { stream: streamUnavailableReason } : undefined}
            generationModeDescription={describeTavernGenerationMode(template, generationMode)}
            provider={<DesktopAiProviderPanel generationMode={generationMode} serverUnavailableReason={generationMode === 'stream' ? streamUnavailableReason : undefined} showConnectionTest={false} onDirtyChange={setProviderDirty}
              copy={{ serverOutput: { stream: '', nonStream: '非流式 JSON' }, emptyProfilesHint: '请选择生成通道。', serverFootnote: '服务器仅接收裁剪后的设定；原件和占位符偏好保留本机。', payloadNoun: '裁剪后的酒馆设定' }} />}
            providerFootnote="API Key 使用本机安全存储。失败或取消后不会自动重发，请确认费用与原始输出后再手动重试。" />
          {mode === 'ai' ? <div className="mt-4 space-y-2">
            {unavailable ? <p role="status">{unavailable}</p> : null}
            {hostedStreamUnavailable ? <p role="status">{streamUnavailableReason}</p> : null}
            {aiInputError ? <p role="alert">{aiInputError}</p> : null}
            {warnings.map(warning => <p className="text-xs text-amber-700" key={warning}>{warning}</p>)}
            <button type="button" className="generate-button" disabled={generateDisabled} onClick={generate}>{generating ? '转换中…' : serverCooldown ? `冷却中 (${remainingTime}s)` : '开始转换'}</button>
            {ai.phase === 'generating' || aiStore.isPreparingGeneration() ? <button type="button" onClick={() => { aiStore.cancelPreparingGeneration(); session.cancel(); }}>取消转换</button> : null}
            {ai.message ? <p role={ai.phase === 'failed' ? 'alert' : 'status'}>{ai.message}</p> : null}
            <GenerationMarkdownPreview active={ai.phase === 'generating' && ai.activeGenerationMode === 'stream'} text={ai.rawText} />
            {ai.rawText ? <details open={ai.phase !== 'completed'}><summary>AI 原始输出</summary><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words">{ai.rawText}</pre></details> : null}
            {ai.rawText && ai.phase !== 'completed' && ai.phase !== 'generating' ? <div className="space-y-2">
              <p className="text-xs text-amber-700">未完成正文仅供保留，不是完成卡，不能保存到卡库。</p>
              <button type="button" disabled={blocked} onClick={() => {
                try { exportTavernFile({ name: 'tavern-unfinished.txt', bytes: new TextEncoder().encode(ai.rawText), mimeType: 'text/plain;charset=utf-8' }); }
                catch (cause) { setError(cause instanceof Error ? cause.message : '未完成正文导出失败'); }
              }}>导出未完成正文（文本）</button>
            </div> : null}
          </div> : null}
          {conversion.error ? <p role="alert" className="text-sm text-red-700">{conversion.error}</p> : null}
          {projection ? <><TavernLocalProjection conversionMode={mode} disabled={blocked || !placeholderHydrated} data={projection} exportFile={exportTavernFile} saveCard={async (data) => {
            busy.current = true; setSaving(true);
            try { if (mode === 'ai') { const saved = await session.saveResult(); if (!saved) throw new Error(session.getSnapshot().saveError ?? '保存失败'); return session.getSnapshot().saveStatus === 'already-present' ? 'already-present' : 'saved'; } return await saveDesktopTavernCard(repository, data); } finally { busy.current = false; setSaving(false); }
          }} />
          {isTavernMagicalGirlProjection(projection) ? <MagicalGirlCard magicalGirl={getTavernMagicalGirlPreview(projection)} gradientStyle={resolveMagicalGirlGradient(projection.appearance?.colorScheme)} /> : isTavernStructuredScenario(projection) ? <GeneralScenarioCard scenario={scenarioPreview ?? { title: '未命名情景', content: '' }} /> : projection.templateId === TAVERN_CANSHOU_TEMPLATE_ID ? <CanshouCard canshou={projection as unknown as CanshouDetails} /> : isTavernGeneralScenario(projection) ? <GeneralScenarioCard scenario={projection} /> : isTavernGeneralCharacter(projection) ? <GeneralCharacterCard general={projection} /> : null}</> : null}</div>
        <div className="space-y-4"><TavernCardPreview normalized={normalized} warnings={result.meta.warnings} />
          <TavernOriginalExport disabled={blocked} candidate={candidate} basePngBytes={basePng} exportFile={exportTavernFile} /></div>
      </div> : null}
      </>} />
      <QuestionnaireDraftPanel draftError={ai.draftError} draftBlocked={session.isDraftBlocked()} busy={blocked} actionClass="footer-link" onRetrySave={() => session.retryDraftSave()} />
      {session.isDraftBlocked() ? <button disabled={blocked} onClick={() => { if (window.confirm('确认清除损坏的 AI 草稿？请先导出需要保留的内容。')) session.discardDraft(); }}>清除损坏 AI 草稿</button> : null}
      {ai.resultRestored ? <p role="status">已恢复 AI 结果与酒馆 JSON 原件，不会重新发起请求。草稿不保存 PNG 底图；PNG 导出使用占位图。</p> : null}
      {guard.message ? <p role="alert" className="mt-3 text-sm text-red-700">{guard.message}</p> : null}
      <ProductFooter className="footer mt-8" assetSource={{ baseUrl: '/' }} onNavigateInternal={(href) => navigateByProductHref(router, href)} resolveInternalHref={resolveInternalHrefForHashHistory} onNavigateExternal={openFixed} />
    </div>
  </div></div></div>;
}

export function DesktopTavern() {
  const [session, setSession] = useState<TavernAiSession | null>(null);
  useEffect(() => {
    const owner = new TavernAiSession({ storage: window.localStorage, repository: new IpcLocalCardRepository((command, args) => invoke(command, args as never)) });
    owner.restoreDraft(false); setSession(owner);
    return () => owner.dispose();
  }, []);
  return session ? <TavernPage session={session} /> : <p role="status">正在准备草稿…</p>;
}
