'use client';

import Link from 'next/link';

import {
  MagicTeaPartyChatMessage as SharedMagicTeaPartyChatMessage,
  type MagicTeaPartyChatMarkdownProps,
  type MagicTeaPartyChatMessagePresentationProps,
  type MagicTeaPartyChatMessageProps as SharedMagicTeaPartyChatMessageProps,
} from '@mahoshojo/ui-web/magic-tea-party';
import type {
  MagicTeaPartyMessage,
  MagicTeaPartySession,
  MagicTeaPartyTachieAsset,
} from '@mahoshojo/domain/magic-tea-party/types';

import { ErrorMessage } from '@/components/ErrorMessage';
import { MarkdownBlock } from '@/components/MarkdownBlock';
import { inferErrorCategoryForError } from '@/lib/error-help';

export type MagicTeaPartyChatMessageProps = Omit<SharedMagicTeaPartyChatMessageProps, keyof MagicTeaPartyChatMessagePresentationProps> & {
  tachieAssets?: MagicTeaPartyTachieAsset[];
};

const getSpeakerNameFromRole = (session: MagicTeaPartySession | null, roleId: string): string => {
  const match = session?.roles.find((role) => role.id === roleId);
  return match?.name || roleId;
};

const renderMessageAttachments = (
  message: MagicTeaPartyMessage,
  session: MagicTeaPartySession | null,
  assets: MagicTeaPartyTachieAsset[] | undefined
) => {
  if (!assets || assets.length === 0) return null;
  const attached = assets
    .filter((asset) => asset.anchorMessageId === message.id)
    .filter((asset) => Boolean(asset.imageUrl || asset.blobRef));
  if (attached.length === 0) return null;

  const sorted = [...attached].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const display = sorted.slice(0, 2);
  const remaining = sorted.length - display.length;

  return (
    <div className="mt-2 space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        {display.map((asset) => {
          const url = asset.imageUrl || asset.blobRef || '';
          if (!url) return null;
          const kindLabel = asset.kind === 'illustration' ? '剧情插画' : '角色立绘';
          const roleLabel = asset.roleId ? getSpeakerNameFromRole(session, asset.roleId) : '';
          const label = [kindLabel, roleLabel].filter(Boolean).join(' · ');
          return (
            <div key={asset.id} className="overflow-hidden rounded-lg border border-pink-100 bg-white">
              <a href={url} target="_blank" rel="noreferrer" className="block">
                <img src={url} alt={label || '已生成图片'} className="h-36 w-full object-cover" loading="lazy" />
              </a>
              {label ? <div className="px-2 py-1 text-[11px] text-gray-600">{label}</div> : null}
            </div>
          );
        })}
      </div>
      {remaining > 0 ? <div className="text-[11px] text-gray-500">还有 {remaining} 张已绑定图片，可在下方“插画 / 立绘”面板查看。</div> : null}
    </div>
  );
};

const renderError = (message: MagicTeaPartyMessage) => {
  const rawCode = message.error?.code ?? '';
  const status = /^\d{3}$/.test(rawCode) ? Number(rawCode) : null;
  const category = inferErrorCategoryForError({ message: message.error?.message, status });
  const kind =
    message.meta && typeof message.meta === 'object' && typeof message.meta.kind === 'string'
      ? String(message.meta.kind)
      : '';

  const title =
    kind === 'choices'
      ? '生成选项失败'
      : kind === 'opening'
        ? '生成开场失败'
        : kind === 'continue'
          ? '继续生成失败'
          : '生成失败';

  const lines: string[] = [`❌ ${title}`];
  if (status) lines.push(`HTTP：${status}`);
  else if (rawCode) lines.push(`错误码：${rawCode}`);
  if (category) lines.push(`分类：${category.label}`);
  if (message.error?.message?.trim()) lines.push(`原因：${message.error.message.trim()}`);

  return (
    <ErrorMessage
      message={lines.join('\n')}
      status={status}
      className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
      linkClassName="text-red-700 underline underline-offset-2 hover:opacity-95"
    />
  );
};

const renderMarkdown = (props: MagicTeaPartyChatMarkdownProps) => <MarkdownBlock {...props} />;

const renderBlockedHelp = () => (
  <Link href="/encyclopedia/sensitive-words" className="ml-2 underline underline-offset-2 hover:opacity-90">
    查看百科：敏感词与逮捕
  </Link>
);

export function MagicTeaPartyChatMessage({ tachieAssets, ...props }: MagicTeaPartyChatMessageProps) {
  return (
    <SharedMagicTeaPartyChatMessage
      {...props}
      renderMarkdown={renderMarkdown}
      renderAttachments={(message, session) => renderMessageAttachments(message, session, tachieAssets)}
      renderBlockedHelp={renderBlockedHelp}
      renderError={renderError}
    />
  );
}
