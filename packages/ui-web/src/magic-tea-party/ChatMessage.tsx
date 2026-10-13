'use client';

import { Fragment, type ReactNode } from 'react';

import type { AIReasoningEnvelope } from '@mahoshojo/contracts/ai-reasoning';
import type {
  MagicTeaPartyMessage,
  MagicTeaPartyPreferences,
  MagicTeaPartySession,
} from '@mahoshojo/domain/magic-tea-party/types';

import { AiReasoningPanel } from '../details-controls/AiReasoningPanel';
import { MarkdownBlock, type MarkdownBlockProps } from '../markdown/MarkdownBlock';

export type MagicTeaPartyChatMarkdownProps = Pick<MarkdownBlockProps, 'content' | 'variant' | 'mode' | 'className'>;

/** 宿主负责 Markdown 策略、附件地址和帮助导航；共享默认不加载外部媒体。 */
export type MagicTeaPartyChatMessagePresentationProps = {
  renderMarkdown?: (props: MagicTeaPartyChatMarkdownProps) => ReactNode;
  renderAttachments?: (message: MagicTeaPartyMessage, session: MagicTeaPartySession | null) => ReactNode;
  renderBlockedHelp?: (message: MagicTeaPartyMessage) => ReactNode;
  renderError?: (message: MagicTeaPartyMessage) => ReactNode;
};

const renderDefaultMarkdown = (props: MagicTeaPartyChatMarkdownProps) => <MarkdownBlock {...props} />;

export type MagicTeaPartyChatMessageProps = MagicTeaPartyChatMessagePresentationProps & {
  message: MagicTeaPartyMessage;
  session: MagicTeaPartySession | null;
  preferences: MagicTeaPartyPreferences;
  isGenerating: boolean;
  outputView?: 'raw' | 'rendered';
  onSelectChoice?: (text: string) => void;
  onUseAsReference?: (message: MagicTeaPartyMessage, plainText: string) => void;
  onRegenerate?: (message: MagicTeaPartyMessage) => void;
  showRegenerate?: boolean;
  editingMessageId?: string | null;
  editingDraft?: string;
  onStartEdit?: (message: MagicTeaPartyMessage) => void;
  onEditDraftChange?: (value: string) => void;
  onCancelEdit?: () => void;
  onConfirmEdit?: (message: MagicTeaPartyMessage) => void;
  onDeleteMessage?: (message: MagicTeaPartyMessage) => void;
  onCompactMessage?: (message: MagicTeaPartyMessage) => void;
  messageCharLimit?: number;
};

const isMessageSuperseded = (message: MagicTeaPartyMessage): boolean => {
  const meta = message.meta && typeof message.meta === 'object' ? (message.meta as Record<string, unknown>) : null;
  return Boolean(meta && meta.superseded === true);
};

const getMessageMetaRecord = (message: MagicTeaPartyMessage): Record<string, unknown> | null => {
  if (!message.meta || typeof message.meta !== 'object') return null;
  return message.meta as Record<string, unknown>;
};

const getMessageAiReasoning = (message: MagicTeaPartyMessage): AIReasoningEnvelope | null => {
  const meta = getMessageMetaRecord(message);
  if (!meta) return null;
  const payload = meta.aiReasoning;
  if (!payload || typeof payload !== 'object') return null;
  return payload as AIReasoningEnvelope;
};

const getSpeakerNameFromRole = (session: MagicTeaPartySession | null, roleId: string): string => {
  const roles = session?.roles ?? [];
  const match = roles.find((role) => role.id === roleId);
  return match?.name || roleId;
};

const getAssistantPrefix = (session: MagicTeaPartySession | null): string => {
  const presetId = session?.settings?.presetId || '';
  const prefix = presetId.startsWith('arena-') ? 'A.R.E.N.A. 魔法茶会' : '魔法茶会';
  return `${prefix} · 叙述者`;
};

const getPlainTextFromMessage = (message: MagicTeaPartyMessage, session: MagicTeaPartySession | null): string => {
  const segments = Array.isArray(message.segments) ? message.segments : null;
  if (segments && segments.length > 0) {
    const lines: string[] = [];
    for (const seg of segments) {
      if (!seg) continue;
      if (seg.type === 'narration') {
        const text = typeof seg.text === 'string' ? seg.text.trim() : '';
        if (text) lines.push(text);
        continue;
      }
      if (seg.type === 'dialogue') {
        const speakerName =
          typeof seg.speakerName === 'string' && seg.speakerName.trim()
            ? seg.speakerName.trim()
            : typeof seg.speakerId === 'string'
              ? getSpeakerNameFromRole(session, seg.speakerId)
              : '';
        const text = typeof seg.text === 'string' ? seg.text.trim() : '';
        if (text) lines.push(speakerName ? `${speakerName}: ${text}` : text);
        continue;
      }
    }
    return lines.join('\n').trim();
  }
  return (message.content ?? '').trim();
};

const renderAssistantFooter = (
  message: MagicTeaPartyMessage,
  presentation: MagicTeaPartyChatMessageProps
) => {
  if (message.status === 'streaming') {
    return (
      <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-pink-200 border-t-pink-600" aria-hidden="true" />
        <span>生成中…</span>
      </div>
    );
  }

  if (message.status === 'blocked') {
    const blockedBy = message.safety?.blockedBy;
    const hint =
      blockedBy === 'server'
        ? '该内容不符合安全策略，已被拦截。'
        : presentation.onRegenerate
          ? '本轮输出被安全策略截断（可尝试修改输入或重新生成）。'
          : '本轮输出被安全策略截断。';
    return (
      <div className="mt-2 text-xs text-amber-700">
        <span>{hint}</span>
        {presentation.renderBlockedHelp?.(message)}
      </div>
    );
  }

  if (message.status === 'error') {
    return (
      <div className="mt-2">
        {presentation.renderError ? presentation.renderError(message) : (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {message.error?.message?.trim() || '生成失败'}
          </div>
        )}
      </div>
    );
  }

  return null;
};

const isMessageOverCharLimit = (message: MagicTeaPartyMessage, messageCharLimit?: number): boolean =>
  typeof messageCharLimit === 'number'
  && messageCharLimit > 0
  && (typeof message.content === 'string' ? message.content.length : 0) > messageCharLimit;

const CompactMessageButton = (props: {
  message: MagicTeaPartyMessage;
  isGenerating: boolean;
  messageCharLimit?: number;
  onCompactMessage?: (message: MagicTeaPartyMessage) => void;
}) => {
  const { message, isGenerating, messageCharLimit, onCompactMessage } = props;
  if (!onCompactMessage) return null;
  if (!isMessageOverCharLimit(message, messageCharLimit)) return null;
  const length = typeof message.content === 'string' ? message.content.length : 0;

  return (
    <button
      type="button"
      className="underline underline-offset-2 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
      onClick={() => onCompactMessage(message)}
      disabled={isGenerating}
      title={`本条 ${length} 字，超过单条预算 ${messageCharLimit} 字；点击保留首尾并省略中段`}
    >
      精简长消息
    </button>
  );
};

const renderAssistantActions = (props: {
  message: MagicTeaPartyMessage;
  session: MagicTeaPartySession | null;
  isGenerating: boolean;
  onUseAsReference?: (message: MagicTeaPartyMessage, plainText: string) => void;
  onRegenerate?: (message: MagicTeaPartyMessage) => void;
  showRegenerate?: boolean;
  onDeleteMessage?: (message: MagicTeaPartyMessage) => void;
  onCompactMessage?: (message: MagicTeaPartyMessage) => void;
  messageCharLimit?: number;
}) => {
  const { message, session, isGenerating, onUseAsReference, onRegenerate, showRegenerate, onDeleteMessage } = props;
  if (message.status === 'streaming') return null;

  const plain = getPlainTextFromMessage(message, session);
  const canUseReference = plain && typeof onUseAsReference === 'function';
  const canRegenerate = showRegenerate && typeof onRegenerate === 'function';
  const canDelete = message.role !== 'system' && typeof onDeleteMessage === 'function';
  const canCompact = Boolean(props.onCompactMessage) && isMessageOverCharLimit(message, props.messageCharLimit);

  if (!canUseReference && !canRegenerate && !canDelete && !canCompact) return null;

  return (
    <div className="mt-2 flex items-center justify-end gap-2 text-xs text-gray-500">
      {canUseReference ? (
        <button
          type="button"
          className="underline underline-offset-2 hover:text-gray-700"
          onClick={() => onUseAsReference(message, plain.slice(0, 2000))}
          title="将该条 AI 输出作为插画/立绘的参考片段"
        >
          用作插画参考
        </button>
      ) : null}
      {canRegenerate ? (
        <button
          type="button"
          className="underline underline-offset-2 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => onRegenerate(message)}
          disabled={isGenerating}
          title="重新生成这条 AI 输出"
        >
          重新生成
        </button>
      ) : null}
      {canCompact ? (
        <CompactMessageButton
          message={message}
          isGenerating={isGenerating}
          messageCharLimit={props.messageCharLimit}
          onCompactMessage={props.onCompactMessage}
        />
      ) : null}
      {canDelete ? (
        <button
          type="button"
          className="underline underline-offset-2 hover:text-gray-700"
          onClick={() => onDeleteMessage?.(message)}
          disabled={isGenerating}
          title="删除这条对话消息"
        >
          删除
        </button>
      ) : null}
    </div>
  );
};

const renderUserActions = (props: {
  message: MagicTeaPartyMessage;
  isGenerating: boolean;
  onStartEdit?: (message: MagicTeaPartyMessage) => void;
  onDeleteMessage?: (message: MagicTeaPartyMessage) => void;
  onCompactMessage?: (message: MagicTeaPartyMessage) => void;
  messageCharLimit?: number;
}) => {
  const { message, isGenerating, onStartEdit, onDeleteMessage } = props;
  if (message.role !== 'user') return null;
  const canEdit = typeof onStartEdit === 'function' && !isGenerating;
  const canDelete = typeof onDeleteMessage === 'function' && !isGenerating;
  const canCompact = Boolean(props.onCompactMessage) && isMessageOverCharLimit(message, props.messageCharLimit);
  if (!canEdit && !canDelete && !canCompact) return null;

  return (
    <div className="mt-2 flex items-center justify-end gap-2 text-xs text-gray-500">
      {canEdit ? (
        <button
          type="button"
          className="underline underline-offset-2 hover:text-gray-700"
          onClick={() => onStartEdit?.(message)}
          title="编辑这条输入并创建新的会话分支"
        >
          编辑并分支
        </button>
      ) : null}
      {canCompact ? (
        <CompactMessageButton
          message={message}
          isGenerating={isGenerating}
          messageCharLimit={props.messageCharLimit}
          onCompactMessage={props.onCompactMessage}
        />
      ) : null}
      {canDelete ? (
        <button
          type="button"
          className="underline underline-offset-2 hover:text-gray-700"
          onClick={() => onDeleteMessage?.(message)}
          title="删除这条对话消息"
        >
          删除
        </button>
      ) : null}
    </div>
  );
};

export function MagicTeaPartyChatMessage(props: MagicTeaPartyChatMessageProps) {
  const { message, session, preferences, isGenerating } = props;
  const renderMarkdown = props.renderMarkdown ?? renderDefaultMarkdown;
  const isUser = message.role === 'user';
  const bubbleClass = isUser ? 'bg-pink-600 text-white' : 'bg-white border border-pink-100 text-gray-800';
  const isRawView = message.role === 'assistant' && props.outputView === 'raw';
  const messageReasoning = message.role === 'assistant' ? getMessageAiReasoning(message) : null;
  const reasoningStatus = messageReasoning?.status ?? (message.status === 'streaming' ? 'thinking' : 'idle');
  const speakerName =
    message.meta && typeof message.meta === 'object' && typeof message.meta.speakerName === 'string'
      ? String(message.meta.speakerName).trim()
      : '';
  const bubbleSpeaker =
    speakerName ||
    (message.role === 'system'
      ? 'system'
      : message.role === 'user'
        ? message.speakerId
          ? getSpeakerNameFromRole(session, message.speakerId)
          : (session?.settings.userDisplayName || preferences.userDisplayName || '旅人').trim() || '旅人'
        : getAssistantPrefix(session));
  const speakerClass = `px-1 text-xs font-semibold ${isUser ? 'text-right text-pink-700' : 'text-gray-600'}`;
  const isSuperseded = isMessageSuperseded(message);
  const canEdit = Boolean(props.onStartEdit && props.onEditDraftChange && props.onCancelEdit && props.onConfirmEdit);
  const isEditing = canEdit && message.role === 'user' && props.editingMessageId === message.id;
  const editingDraft = typeof props.editingDraft === 'string' ? props.editingDraft : message.content;

  const withHeader = (bubble: ReactNode) => (
    <div className={`space-y-1 ${isSuperseded ? 'opacity-70' : ''}`}>
      <div className={speakerClass}>{bubbleSpeaker}</div>
      {bubble}
      {isSuperseded ? <div className="text-[11px] text-gray-400">该条消息已被更新替换</div> : null}
    </div>
  );

  if (isRawView) {
    return withHeader(
      <div className={`rounded-xl px-4 py-3 ${bubbleClass}`}>
        <div className="whitespace-pre-wrap leading-relaxed">{message.content}</div>
        {props.renderAttachments?.(message, session)}
        <AiReasoningPanel reasoning={messageReasoning} status={reasoningStatus} compact />
        {renderAssistantFooter(message, props)}
        {renderAssistantActions({
          message,
          session,
          isGenerating,
          onUseAsReference: props.onUseAsReference,
          onRegenerate: props.onRegenerate,
          showRegenerate: props.showRegenerate,
          onDeleteMessage: props.onDeleteMessage,
          onCompactMessage: props.onCompactMessage,
          messageCharLimit: props.messageCharLimit,
        })}
      </div>
    );
  }

  if (message.role === 'assistant' && Array.isArray(message.segments) && message.segments.length > 0) {
    return withHeader(
      <div className={`rounded-xl px-4 py-3 ${bubbleClass} space-y-2`}>
        {message.segments.map((seg, idx) => {
          if (seg.type === 'narration') {
            return (
              <Fragment key={`${message.id}-n-${idx}`}>
                {renderMarkdown({ content: seg.text, variant: 'light', mode: 'compact', className: 'text-sm' })}
              </Fragment>
            );
          }
          if (seg.type === 'dialogue') {
            const segSpeakerName = seg.speakerName || getSpeakerNameFromRole(session, seg.speakerId);
            return (
              <div key={`${message.id}-d-${idx}`} className="rounded-lg bg-pink-50 px-3 py-2">
                <div className="text-xs font-semibold text-pink-700">{segSpeakerName}</div>
                {renderMarkdown({ content: seg.text, variant: 'light', mode: 'compact', className: 'text-sm' })}
              </div>
            );
          }
          if (seg.type === 'choices') {
            return (
              <div key={`${message.id}-c-${idx}`} className="grid gap-2 sm:grid-cols-2">
                {seg.items.map((item) => props.onSelectChoice ? (
                  <button
                    key={item.id}
                    type="button"
                    className="rounded-xl border border-pink-200 bg-white px-4 py-2 text-left text-sm font-semibold text-pink-700 hover:bg-pink-50 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={isGenerating}
                    onClick={() => props.onSelectChoice?.(item.text)}
                    title="选择该行动"
                  >
                    {item.text}
                  </button>
                ) : (
                  <div key={item.id} className="rounded-xl border border-pink-200 bg-white px-4 py-2 text-left text-sm font-semibold text-pink-700">
                    {item.text}
                  </div>
                ))}
              </div>
            );
          }
          return null;
        })}
        {props.renderAttachments?.(message, session)}
        <AiReasoningPanel reasoning={messageReasoning} status={reasoningStatus} compact />
        {renderAssistantFooter(message, props)}
        {renderAssistantActions({
          message,
          session,
          isGenerating,
          onUseAsReference: props.onUseAsReference,
          onRegenerate: props.onRegenerate,
          showRegenerate: props.showRegenerate,
          onDeleteMessage: props.onDeleteMessage,
          onCompactMessage: props.onCompactMessage,
          messageCharLimit: props.messageCharLimit,
        })}
      </div>
    );
  }

  if (isEditing) {
    return withHeader(
      <div className={`rounded-xl px-4 py-3 ${bubbleClass} space-y-2`}>
        <textarea
          className="w-full rounded-lg border border-pink-200 bg-white px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-pink-200"
          value={editingDraft}
          onChange={(event) => props.onEditDraftChange?.(event.target.value)}
          placeholder="编辑后将创建新会话分支"
          rows={4}
        />
        <div className="flex items-center justify-end gap-2 text-xs text-gray-500">
          <button
            type="button"
            className="rounded-md border border-gray-200 bg-white px-3 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50"
            onClick={() => props.onCancelEdit?.()}
          >
            取消
          </button>
          <button
            type="button"
            className="rounded-md bg-pink-600 px-3 py-1 text-xs font-semibold text-white hover:bg-pink-700 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => props.onConfirmEdit?.(message)}
            disabled={!editingDraft.trim()}
          >
            创建分支
          </button>
        </div>
      </div>
    );
  }

  const metaOutputFormat =
    message.meta && typeof message.meta === 'object' && typeof message.meta.outputFormat === 'string'
      ? message.meta.outputFormat
      : null;
  const preferMarkdown = metaOutputFormat === 'markdown' || (!metaOutputFormat && session?.settings.outputFormat === 'markdown');

  if (message.role === 'assistant' && preferMarkdown) {
    return withHeader(
      <div className={`rounded-xl px-4 py-3 ${bubbleClass}`}>
        {renderMarkdown({ content: message.content || '', variant: 'light', mode: 'article' })}
        {props.renderAttachments?.(message, session)}
        <AiReasoningPanel reasoning={messageReasoning} status={reasoningStatus} compact />
        {renderAssistantFooter(message, props)}
        {renderAssistantActions({
          message,
          session,
          isGenerating,
          onUseAsReference: props.onUseAsReference,
          onRegenerate: props.onRegenerate,
          showRegenerate: props.showRegenerate,
          onDeleteMessage: props.onDeleteMessage,
          onCompactMessage: props.onCompactMessage,
          messageCharLimit: props.messageCharLimit,
        })}
      </div>
    );
  }

  return withHeader(
    <div className={`rounded-xl px-4 py-3 ${bubbleClass}`}>
      <div className="whitespace-pre-wrap leading-relaxed">{message.content}</div>
      {props.renderAttachments?.(message, session)}
      {message.role === 'assistant'
        ? (
            <>
              <AiReasoningPanel reasoning={messageReasoning} status={reasoningStatus} compact />
              {renderAssistantFooter(message, props)}
            </>
          )
        : null}
      {message.role === 'assistant'
        ? renderAssistantActions({
            message,
            session,
            isGenerating,
            onUseAsReference: props.onUseAsReference,
            onRegenerate: props.onRegenerate,
            showRegenerate: props.showRegenerate,
            onCompactMessage: props.onCompactMessage,
            messageCharLimit: props.messageCharLimit,
          })
        : renderUserActions({
            message,
            isGenerating,
            onStartEdit: canEdit ? props.onStartEdit : undefined,
            onDeleteMessage: props.onDeleteMessage,
            onCompactMessage: props.onCompactMessage,
            messageCharLimit: props.messageCharLimit,
          })}
    </div>
  );
}
