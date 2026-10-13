import { useCallback, useMemo, useState } from 'react';
import { zipSync } from 'fflate';
import { buildMagicTeaPartyImportPlan } from '@mahoshojo/domain/magic-tea-party/import-plan';
import { MagicTeaPartyTransferPanel } from '@mahoshojo/ui-web/magic-tea-party';

import { ErrorMessage } from '@/components/ErrorMessage';
import { useAppRouterAdapter } from '@/lib/app-router-adapter';
import { downloadBlob } from '@/lib/client/blobUrl';
import { buildSafeFileName } from '@/lib/client/fileName';
import { randomUUID } from '@/lib/crypto';
import {
  getMagicTeaPartyTachieBlob,
  listMagicTeaPartyMessages,
  listMagicTeaPartySessions,
  listMagicTeaPartyTachieAssets,
  putMagicTeaPartyMessage,
  putMagicTeaPartySession,
  putMagicTeaPartyTachieAsset,
} from '@/lib/magic-tea-party/storage';
import type {
  MagicTeaPartyMessage,
  MagicTeaPartyPreferences,
  MagicTeaPartyRole,
  MagicTeaPartyScenario,
  MagicTeaPartySession,
  MagicTeaPartyUpdateDraft,
} from '@/lib/magic-tea-party/types';
import {
  buildMagicTeaPartySessionExport,
  buildMagicTeaPartyArchiveZipEntries,
  stringifySillyTavernJsonl,
  type MagicTeaPartyArchiveExport,
  type MagicTeaPartySessionExport,
} from '@/lib/magic-tea-party/transfer';
import {
  checkMagicTeaPartySensitiveText,
  maskMagicTeaPartyJsonValue,
  maskMagicTeaPartyText,
} from '@/lib/magic-tea-party/import-safety';
import { mapMagicTeaPartyUpdateDraftCompat } from '@/lib/magic-tea-party/update-draft-mappers';

type ImportExportPanelProps = {
  activeSession: MagicTeaPartySession | null;
  preferences: MagicTeaPartyPreferences;
  onSessionImported: (sessionId: string) => void;
};

const getBaseTitle = (filename: string, fallback: string): string => {
  const trimmed = filename.trim();
  if (!trimmed) return fallback;
  return trimmed.replace(/\.[^/.]+$/, '').trim() || fallback;
};

const ensureRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

export function MagicTeaPartyImportExportPanel(props: ImportExportPanelProps) {
  const { activeSession, preferences, onSessionImported } = props;
  const router = useAppRouterAdapter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const roleNameLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const role of activeSession?.roles ?? []) {
      map.set(role.id, role.name);
    }
    return (roleId: string) => map.get(roleId) ?? roleId;
  }, [activeSession?.roles]);

  const buildSessionSettings = useCallback(
    (raw: Record<string, unknown> | null | undefined) => {
      const defaults = preferences;
      const base = (raw ?? {}) as Record<string, unknown>;
      const outputPlanRaw = base.outputPlan && typeof base.outputPlan === 'object' ? (base.outputPlan as Record<string, unknown>) : null;
      const normalizePlanValue = (value: unknown, fallback: 'off' | 'auto' | 'on') =>
        value === 'off' || value === 'on' || value === 'auto' ? (value as 'off' | 'auto' | 'on') : fallback;
      const outputPlan = outputPlanRaw
        ? {
            choices: normalizePlanValue(outputPlanRaw.choices, defaults.outputPlan.choices),
            summary: normalizePlanValue(outputPlanRaw.summary, defaults.outputPlan.summary),
            updates: normalizePlanValue(outputPlanRaw.updates, defaults.outputPlan.updates),
          }
        : defaults.outputPlan;
      return {
        providerId: typeof base.providerId === 'string' ? base.providerId : 'unknown',
        modelId: typeof base.modelId === 'string' ? base.modelId : '',
        temperature: typeof base.temperature === 'number' ? base.temperature : 0.75,
        maxContextMessages: typeof base.maxContextMessages === 'number' ? base.maxContextMessages : undefined,
        contextWindowTokens: typeof base.contextWindowTokens === 'number' ? base.contextWindowTokens : undefined,
        responseReserveTokens: typeof base.responseReserveTokens === 'number' ? base.responseReserveTokens : undefined,
        summaryTriggerRatio: typeof base.summaryTriggerRatio === 'number' ? base.summaryTriggerRatio : undefined,
        summaryMaxTokens: typeof base.summaryMaxTokens === 'number' ? base.summaryMaxTokens : undefined,
        summaryMinGapMessages: typeof base.summaryMinGapMessages === 'number' ? base.summaryMinGapMessages : undefined,
        enableChoices: typeof base.enableChoices === 'boolean' ? base.enableChoices : defaults.enableChoices,
        choiceCount: typeof base.choiceCount === 'number' ? base.choiceCount : defaults.choiceCount,
        outputFormat: base.outputFormat === 'markdown' ? 'markdown' : defaults.outputFormat,
        outputPlan,
        updateApplyMode:
          base.updateApplyMode === 'confirm' || base.updateApplyMode === 'draft'
            ? base.updateApplyMode
            : defaults.updateApplyMode,
        language: base.language === 'en-US' || base.language === 'ja-JP' ? base.language : defaults.language,
        userDisplayName: typeof base.userDisplayName === 'string' ? base.userDisplayName : defaults.userDisplayName,
        presetId: typeof base.presetId === 'string' ? base.presetId : undefined,
        worldbookPresetId: typeof base.worldbookPresetId === 'string' ? base.worldbookPresetId : undefined,
        enableSummary: typeof base.enableSummary === 'boolean' ? base.enableSummary : defaults.enableSummary,
        readArenaHistory: typeof base.readArenaHistory === 'boolean' ? base.readArenaHistory : defaults.readArenaHistory,
        readArenaHistoryLimit: typeof base.readArenaHistoryLimit === 'number' ? base.readArenaHistoryLimit : defaults.readArenaHistoryLimit,
        isArenaHistoryUnlimited:
          typeof base.isArenaHistoryUnlimited === 'boolean' ? base.isArenaHistoryUnlimited : defaults.isArenaHistoryUnlimited,
        readCurrentState: typeof base.readCurrentState === 'boolean' ? base.readCurrentState : defaults.readCurrentState,
        writeArenaHistory: typeof base.writeArenaHistory === 'boolean' ? base.writeArenaHistory : defaults.writeArenaHistory,
        writeCurrentState: typeof base.writeCurrentState === 'boolean' ? base.writeCurrentState : defaults.writeCurrentState,
      } as MagicTeaPartySession['settings'];
    },
    [preferences]
  );

  const maskOptionalText = useCallback((value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    return maskMagicTeaPartyText(value).value;
  }, []);

  const sanitizeMessage = useCallback(
    (message: MagicTeaPartyMessage): MagicTeaPartyMessage => {
      const next: MagicTeaPartyMessage = { ...message };
      if (typeof next.content === 'string') {
        next.content = maskMagicTeaPartyText(next.content).value;
      }
      if (Array.isArray(next.segments)) {
        next.segments = next.segments.map((seg) => {
          if (seg.type === 'narration') {
            return { ...seg, text: maskMagicTeaPartyText(seg.text).value };
          }
          if (seg.type === 'dialogue') {
            return {
              ...seg,
              speakerName: seg.speakerName ? maskMagicTeaPartyText(seg.speakerName).value : seg.speakerName,
              text: maskMagicTeaPartyText(seg.text).value,
            };
          }
          if (seg.type === 'choices') {
            const items = seg.items?.map((item) => ({
              ...item,
              text: maskMagicTeaPartyText(item.text).value,
            }));
            return { ...seg, items: items ?? seg.items };
          }
          return seg;
        });
      }
      if (Array.isArray(next.choices)) {
        next.choices = next.choices.map((item) => ({
          ...item,
          text: maskMagicTeaPartyText(item.text).value,
        }));
      }
      if (next.meta && typeof next.meta === 'object') {
        const meta = { ...(next.meta as Record<string, unknown>) };
        if (typeof meta.speakerName === 'string') {
          meta.speakerName = maskMagicTeaPartyText(meta.speakerName).value;
        }
        next.meta = meta;
      }
      return next;
    },
    []
  );

  const sanitizeRole = useCallback(
    (role: MagicTeaPartyRole): MagicTeaPartyRole => {
      const maskedName = maskOptionalText(role.name) ?? role.name;
      const maskedNotes = maskOptionalText(role.notes);
      const maskedCard = maskMagicTeaPartyJsonValue(role.card ?? {}).value as Record<string, unknown>;
      return {
        ...role,
        name: maskedName,
        ...(typeof maskedNotes === 'string' ? { notes: maskedNotes } : {}),
        card: maskedCard,
      };
    },
    [maskOptionalText]
  );

  const sanitizeScenario = useCallback(
    (scenario: MagicTeaPartyScenario): MagicTeaPartyScenario => {
      const maskedTitle = maskOptionalText(scenario.title) ?? scenario.title;
      const maskedNotes = maskOptionalText(scenario.notes);
      const maskedCard = maskMagicTeaPartyJsonValue(scenario.card ?? {}).value as Record<string, unknown>;
      return {
        ...scenario,
        title: maskedTitle,
        ...(typeof maskedNotes === 'string' ? { notes: maskedNotes } : {}),
        card: maskedCard,
      };
    },
    [maskOptionalText]
  );

  const maskTextValue = useCallback((value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const masked = maskMagicTeaPartyText(value).value;
    return masked.trim() ? masked : undefined;
  }, []);

  const sanitizeSummarySections = useCallback(
    (value: unknown): Record<string, string> | undefined => {
      const record = ensureRecord(value);
      if (!record) return undefined;
      const next: Record<string, string> = {};
      for (const [key, section] of Object.entries(record)) {
        const masked = maskTextValue(section);
        if (masked) next[key] = masked;
      }
      return Object.keys(next).length > 0 ? next : undefined;
    },
    [maskTextValue]
  );

  const sanitizeUpdateDrafts = useCallback(
    (value: unknown): MagicTeaPartyUpdateDraft[] | undefined => {
      if (!Array.isArray(value)) return undefined;
      const drafts = value
        .map((item) => {
          const mapped = mapMagicTeaPartyUpdateDraftCompat(item);
          if (!mapped) return null;
          const characterName = maskTextValue(mapped.characterName) ?? mapped.characterName;
          if (!characterName) return null;
          const impact = maskTextValue(mapped.impact);
          const currentStateSummary = maskTextValue(mapped.currentStateSummary);
          const winner = maskTextValue(mapped.winner);
          const roleId = mapped.roleId;
          const hasWinner = mapped.hasWinner;
          const meta = ensureRecord(mapped.meta) ?? undefined;
          return {
            ...ensureRecord(item),
            ...Object.fromEntries(['character', 'name', 'current_state_summary'].flatMap(key => {
              const value = ensureRecord(item)?.[key];
              return typeof value === 'string' ? [[key, maskMagicTeaPartyText(value).value]] : [];
            })),
            ...(roleId ? { roleId } : {}),
            characterName,
            ...(impact ? { impact } : {}),
            ...(currentStateSummary ? { currentStateSummary } : {}),
            ...(typeof hasWinner === 'boolean' ? { hasWinner } : {}),
            ...(winner ? { winner } : {}),
            ...(meta ? { meta } : {}),
          } as MagicTeaPartyUpdateDraft;
        })
        .filter((item): item is MagicTeaPartyUpdateDraft => Boolean(item));
      return drafts.length > 0 ? drafts : undefined;
    },
    [maskTextValue]
  );

  const sanitizeImportSession = useCallback(
    (session: MagicTeaPartySession): MagicTeaPartySession => ({
      ...session,
      title: maskOptionalText(session.title) || '导入会话',
      roles: session.roles.map(sanitizeRole),
      ...(session.scenario ? { scenario: sanitizeScenario(session.scenario) } : {}),
      auxScenarios: (session.auxScenarios ?? []).map(sanitizeScenario),
      ...(typeof session.summary === 'string' ? { summary: maskMagicTeaPartyText(session.summary).value } : {}),
      ...(session.summarySections ? { summarySections: sanitizeSummarySections(session.summarySections) } : {}),
      ...(session.protocolShadow ? {
        protocolShadow: { ...session.protocolShadow, drafts: sanitizeUpdateDrafts(session.protocolShadow.drafts) ?? [] },
      } : {}),
      ...(session.updateSnapshot ? {
        updateSnapshot: {
          ...session.updateSnapshot,
          drafts: sanitizeUpdateDrafts(session.updateSnapshot.drafts) ?? [],
          rolesBefore: session.updateSnapshot.rolesBefore.map(sanitizeRole),
          rolesAfter: session.updateSnapshot.rolesAfter.map(sanitizeRole),
        },
      } : {}),
      ...(session.lastChoices ? {
        lastChoices: session.lastChoices.map(choice => ({ ...choice, text: maskMagicTeaPartyText(choice.text).value })),
      } : {}),
      ...(typeof session.draft === 'string' ? { draft: maskMagicTeaPartyText(session.draft).value } : {}),
    }),
    [maskOptionalText, sanitizeRole, sanitizeScenario, sanitizeSummarySections, sanitizeUpdateDrafts]
  );

  const handleExportSession = useCallback(async () => {
    if (!activeSession) {
      setError('请先选择一个会话再导出。');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const messages = await listMagicTeaPartyMessages(activeSession.id);
      const tachieAssets = await listMagicTeaPartyTachieAssets(activeSession.id);
      const payload = buildMagicTeaPartySessionExport({
        session: activeSession,
        messages,
        tachieAssets,
        appVersion: 'unknown',
      });
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      downloadBlob(blob, buildSafeFileName(activeSession.title || 'magic-tea-party-session', 'json', 'magic-tea-party-session'));
      setNotice('会话已导出。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出失败');
    } finally {
      setBusy(false);
    }
  }, [activeSession]);

  const handleExportSessionJsonl = useCallback(async () => {
    if (!activeSession) {
      setError('请先选择一个会话再导出。');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const messages = await listMagicTeaPartyMessages(activeSession.id);
      const userDisplayName =
        activeSession.settings.userDisplayName || preferences.userDisplayName || '旅人';
      const playerRoleName = activeSession.playerRoleId
        ? (activeSession.roles ?? []).find((role) => role.id === activeSession.playerRoleId)?.name
        : undefined;
      const jsonl = stringifySillyTavernJsonl({
        messages,
        userDisplayName,
        playerRoleName,
        roleNameLookup,
      });
      const blob = new Blob([jsonl], { type: 'application/jsonl' });
      downloadBlob(
        blob,
        buildSafeFileName(`${activeSession.title || 'magic-tea-party'}_SillyTavern`, 'jsonl', 'magic-tea-party')
      );
      setNotice('SillyTavern JSONL 已导出。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出失败');
    } finally {
      setBusy(false);
    }
  }, [activeSession, preferences.userDisplayName, roleNameLookup]);

  const handleExportArchive = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const sessions = await listMagicTeaPartySessions({ limit: 9999 });
      const exports: MagicTeaPartySessionExport[] = [];
      for (const session of sessions) {
        const messages = await listMagicTeaPartyMessages(session.id);
        const assets = await listMagicTeaPartyTachieAssets(session.id);
        exports.push(
          buildMagicTeaPartySessionExport({
            session,
            messages,
            tachieAssets: assets,
            appVersion: 'unknown',
          })
        );
      }
      const archive: MagicTeaPartyArchiveExport = {
        schema: 'magic-tea-party.archive.v1',
        exportedAt: new Date().toISOString(),
        appVersion: 'unknown',
        sessions: exports,
      };
      const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' });
      downloadBlob(blob, buildSafeFileName('magic-tea-party-archive', 'json', 'magic-tea-party-archive'));
      setNotice(`已导出 ${exports.length} 个会话。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出失败');
    } finally {
      setBusy(false);
    }
  }, []);

  const handleExportArchiveZip = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const sessions = await listMagicTeaPartySessions({ limit: 9999 });
      const exports: MagicTeaPartySessionExport[] = [];
      const tachieBlobs: Record<string, Blob | null> = {};

      for (const session of sessions) {
        const messages = await listMagicTeaPartyMessages(session.id);
        const assets = await listMagicTeaPartyTachieAssets(session.id);
        const sessionExport = buildMagicTeaPartySessionExport({
          session,
          messages,
          tachieAssets: assets,
          appVersion: 'unknown',
        });
        exports.push(sessionExport);
        for (const asset of assets) {
          if (tachieBlobs[asset.id] !== undefined) continue;
          tachieBlobs[asset.id] = await getMagicTeaPartyTachieBlob(asset.id);
        }
      }

      const exportedAt = new Date().toISOString();
      const { entries, stats } = await buildMagicTeaPartyArchiveZipEntries({
        sessions: exports,
        tachieBlobs,
        exportedAt,
        appVersion: 'unknown',
      });

      const zipped = zipSync(entries, { level: 6 });
      const zipData = new Uint8Array(zipped);
      const blob = new Blob([zipData], { type: 'application/zip' });
      downloadBlob(blob, buildSafeFileName('magic-tea-party-archive', 'zip', 'magic-tea-party-archive'));
      setNotice(
        stats.missingCount > 0
          ? `已导出 ${stats.sessionCount} 个会话，包含 ${stats.blobCount} 个图片资源（${stats.missingCount} 个图片缺失）。`
          : `已导出 ${stats.sessionCount} 个会话，包含 ${stats.blobCount} 个图片资源。`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出失败');
    } finally {
      setBusy(false);
    }
  }, []);

  const handleFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      setBusy(true);
      setError(null);
      setNotice(null);

      try {
        const text = await file.text();
        const guard = await checkMagicTeaPartySensitiveText({
          text,
          reason: '使用危险符文',
          origin: '/magic-tea-party',
          label: '魔法茶会导入会话',
          filename: file.name,
          mimeType: file.type || 'application/json',
        });
        if (guard.blocked) {
          if (guard.redirectTarget) {
            await router.push(guard.redirectTarget);
          }
          return;
        }
        const ext = file.name.toLowerCase();
        const baseTitle = getBaseTitle(file.name, '导入会话');
        const plan = buildMagicTeaPartyImportPlan({
          input: ext.endsWith('.jsonl') ? { format: 'jsonl', text } : { format: 'json', value: JSON.parse(text) },
          createId: randomUUID,
          now: Date.now(),
          titleHint: baseTitle,
          userDisplayName: preferences.userDisplayName || '旅人',
          normalizeSettings: buildSessionSettings,
        });
        // Complete both shared preflight and Web masking for the entire batch before the first write.
        const entries = plan.entries.map(entry => ({
          ...entry,
          session: sanitizeImportSession(entry.session),
          messages: entry.messages.map(sanitizeMessage),
        }));
        for (const entry of entries) {
          await putMagicTeaPartySession(entry.session);
          await Promise.all(entry.messages.map(message => putMagicTeaPartyMessage(message)));
          await Promise.all(entry.tachieAssets.map(asset => putMagicTeaPartyTachieAsset(asset)));
        }
        if (plan.kind === 'jsonl') {
          const count = entries[0].messages.length;
          setNotice(plan.warnings.length > 0 ? `已导入 ${count} 条消息（${plan.warnings.length} 行已跳过）。` : `已导入 ${count} 条消息。`);
        } else {
          const summary = plan.kind === 'archive' ? `已导入 ${entries.length} 个会话。` : '会话已导入。';
          setNotice([summary, ...plan.warnings].join(' '));
        }
        onSessionImported(entries[0].session.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : '导入失败');
      } finally {
        setBusy(false);
        event.target.value = '';
      }
    },
    [buildSessionSettings, onSessionImported, preferences.userDisplayName, router, sanitizeImportSession, sanitizeMessage]
  );

  return (
    <MagicTeaPartyTransferPanel
      activeTitle={activeSession?.title ?? null}
      busy={busy}
      error={error}
      notice={notice}
      onImportFile={handleFileChange}
      onExportSession={handleExportSession}
      onExportSessionJsonl={handleExportSessionJsonl}
      onExportArchive={handleExportArchive}
      onExportArchiveZip={handleExportArchiveZip}
      renderError={(message) => <ErrorMessage message={message} className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" />}
    />
  );
}
