'use client';

import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { ChevronDown, FileText, Maximize, Minimize, PanelsTopLeft } from 'lucide-react';
import { getVisibleOutputTokens } from '@mahoshojo/ai-core/token-usage';
import type { ArenaBattleReport } from '@mahoshojo/ai-core/arena-generation';
import { SegmentedControl, type SegmentedOption } from '../details-controls/SegmentedControl';

export type ArenaWebDisplayMode = 'ordinary' | 'web';

const DISPLAY_OPTIONS: readonly SegmentedOption<ArenaWebDisplayMode>[] = [
  { value: 'ordinary', label: '普通显示', icon: <FileText />, description: '使用普通战报卡片展示正文，适合阅读、保存图片和下载战斗记录。' },
  { value: 'web', label: 'Web 显示', icon: <PanelsTopLeft />, description: '在隔离环境中展示生成的网页战报，保留自定义排版和交互。' },
];

export function ArenaWebDisplayModeSelectorView({ value, onChange, disabled, webUnavailableReason, webDescription }: {
  value: ArenaWebDisplayMode;
  onChange(value: ArenaWebDisplayMode): void;
  disabled?: boolean;
  webUnavailableReason?: string;
  webDescription?: string;
}) {
  const options = DISPLAY_OPTIONS.map(option => option.value === 'web'
    ? { ...option, description: webDescription ?? option.description, disabled: Boolean(webUnavailableReason), reason: webUnavailableReason }
    : option);
  return <SegmentedControl label="显示方式" value={value} options={options} disabled={disabled} onChange={onChange} />;
}

export const ARENA_WEB_CONTROL_CLASS_NAME = 'inline-flex min-h-11 max-w-full items-center justify-center gap-2 rounded-(--app-radius-sm) border border-white/40 px-3 py-2 text-sm font-medium text-white transition-colors duration-150 enabled:hover:border-white/65 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none [html[data-motion=reduce]_&]:transition-none forced-colors:border-[ButtonText] forced-colors:bg-[ButtonFace] forced-colors:text-[ButtonText]';

/** Presentation only: the host retains ownership of the isolated window and its lifecycle. */
export function ArenaWebWindowStatusView({ message, children }: { message: string | null; children?: ReactNode }) {
  return <section aria-label="独立 Web 作品窗口" className="min-w-0 space-y-3 rounded-(--app-radius-md) border border-white/20 bg-white/5 p-4 text-white">
    <div className="flex items-start gap-3">
      <PanelsTopLeft size={20} aria-hidden="true" className="mt-1 shrink-0" />
      <div className="min-w-0 space-y-1 wrap-anywhere">
        <h3 className="text-base font-semibold">独立作品窗口</h3>
        {message ? <p role="status" className="text-sm">{message}</p> : null}
        <p className="text-sm text-white/80">使用下方控件返回作品、切换沉浸或重新加载。作品在隔离窗口运行，交互进度不会自动保存。</p>
      </div>
    </div>
    {children}
  </section>;
}

/** Shared control only; the host decides whether this controls a DOM viewer or a native isolated window. */
export function ArenaWebImmersiveButton({ immersive, onClick, disabled, buttonRef }: {
  immersive: boolean;
  onClick(): void;
  disabled?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return <button ref={buttonRef} type="button" onClick={onClick} disabled={disabled}
    className={`${ARENA_WEB_CONTROL_CLASS_NAME} shrink-0 whitespace-nowrap bg-white/10 enabled:hover:bg-white/20`}>
    {immersive ? <Minimize size={16} aria-hidden="true" className="shrink-0" /> : <Maximize size={16} aria-hidden="true" className="shrink-0" />}
    {immersive ? '退出沉浸' : '沉浸体验'}
  </button>;
}

/** Applied by a host to its own rendering surface; this module never creates an iframe or executable document. */
export const ARENA_WEB_FRAME_CLASS_NAME = 'block h-[75dvh] min-h-[360px] w-full border-0 bg-white group-data-[immersive=true]/web-viewer:h-full group-data-[immersive=true]/web-viewer:min-h-0';

export type ArenaWebViewerProps = Readonly<{
  children: ReactNode;
  immersive: boolean;
  onToggleImmersive(viewer: HTMLDivElement | null): void;
  contentIdentity?: unknown;
  reload?: number;
  aiModel?: string | null;
  aiUsage?: ArenaBattleReport['aiUsage'] | null;
}>;

/** Stable viewer chrome. Layout switches never reparent the host-owned content or reset its browsing context. */
export function ArenaWebViewer({ children, immersive, onToggleImmersive, contentIdentity, reload, aiModel, aiUsage }: ArenaWebViewerProps) {
  const [expanded, setExpanded] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const viewerRef = useRef<HTMLDivElement>(null);
  const immersiveButtonRef = useRef<HTMLButtonElement>(null);
  const focusOnExpandRef = useRef(false);
  const model = aiModel?.trim();
  const hasTokens = [aiUsage?.promptTokens, aiUsage?.reasoningTokens, aiUsage?.completionTokens, aiUsage?.textTokens]
    .some(value => typeof value === 'number' && Number.isFinite(value));
  const formatToken = (value: number | null | undefined) =>
    typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '-';

  useEffect(() => { setExpanded(true); }, [contentIdentity, reload, immersive]);
  useEffect(() => {
    if (!expanded || hovered || keyboardFocus) return;
    const timer = window.setTimeout(() => {
      immersiveButtonRef.current?.blur();
      setExpanded(false);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [expanded, hovered, keyboardFocus, contentIdentity, reload, immersive]);
  useEffect(() => {
    if (expanded && focusOnExpandRef.current) {
      focusOnExpandRef.current = false;
      immersiveButtonRef.current?.focus({ preventScroll: true });
    }
  }, [expanded]);

  return <div ref={viewerRef} role={immersive ? 'dialog' : undefined} aria-modal={immersive ? true : undefined}
    aria-label={immersive ? '沉浸式 Web 战报' : undefined} data-testid={immersive ? 'arena-web-immersive' : undefined}
    data-immersive={immersive} className={`group/web-viewer ${immersive ? 'fixed inset-0 z-(--app-z-overlay) h-dvh overflow-hidden overscroll-none bg-black' : 'relative'}`}>
    <header data-testid="arena-web-header" aria-hidden={!expanded} inert={!expanded}
      className={`pointer-events-none absolute inset-x-0 top-0 z-1 bg-linear-to-b from-zinc-900/85 via-zinc-900/75 via-[calc(100%-32px)] to-transparent px-2 pt-2 pb-10 text-white transition-[opacity,transform] duration-150 motion-reduce:transition-none [html[data-motion=reduce]_&]:transition-none sm:px-3 sm:pt-3 sm:pb-11 ${!expanded ? '-translate-y-1 opacity-0 motion-reduce:translate-y-0 [html[data-motion=reduce]_&]:translate-y-0' : ''} ${immersive ? 'pt-[max(8px,env(safe-area-inset-top))] pl-[max(8px,env(safe-area-inset-left))] pr-[max(8px,env(safe-area-inset-right))] sm:pt-[max(12px,env(safe-area-inset-top))] sm:pl-[max(12px,env(safe-area-inset-left))] sm:pr-[max(12px,env(safe-area-inset-right))]' : ''}`}>
      <div className={`flex items-start justify-between gap-3 ${expanded ? 'pointer-events-auto' : 'pointer-events-none'}`}
        onPointerEnter={event => { if (event.pointerType === 'mouse') setHovered(true); }} onPointerLeave={() => setHovered(false)}
        onPointerDownCapture={() => setKeyboardFocus(false)} onKeyDownCapture={() => setKeyboardFocus(true)}
        onFocusCapture={event => { const visible = event.target.matches(':focus-visible'); setKeyboardFocus(current => current || visible); }}
        onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setKeyboardFocus(false); }}>
        <div className="min-w-0">
          <img src="/arena-white.svg" alt="魔法少女竞技场" width={140} height={45} className="block h-auto w-32 max-w-full sm:w-40" />
          {model || hasTokens ? <div className="mt-1 flex flex-wrap text-xs leading-normal tabular-nums">
            {model ? <span className="mr-1 min-w-0 wrap-anywhere">模型：{model}{hasTokens ? ' · ' : ''}</span> : null}
            {hasTokens ? <>
              <span className="whitespace-nowrap">tokens：输入 {formatToken(aiUsage?.promptTokens)}</span>
              <span className="whitespace-nowrap">｜推理 {formatToken(aiUsage?.reasoningTokens)}</span>
              <span className="whitespace-nowrap">｜输出 {formatToken(getVisibleOutputTokens(aiUsage))}</span>
            </> : null}
          </div> : null}
        </div>
        <ArenaWebImmersiveButton buttonRef={immersiveButtonRef} immersive={immersive} onClick={() => onToggleImmersive(viewerRef.current)} />
      </div>
    </header>
    <button type="button" hidden={expanded} aria-label="展开 Web 战报工具栏" aria-expanded={expanded}
      className={`${ARENA_WEB_CONTROL_CLASS_NAME} absolute top-2 right-2 z-1 min-w-11 bg-black/65 enabled:hover:bg-black/80 sm:top-3 sm:right-3 ${expanded ? 'hidden' : ''} ${immersive ? 'top-[max(8px,env(safe-area-inset-top))] right-[max(8px,env(safe-area-inset-right))] sm:top-[max(12px,env(safe-area-inset-top))] sm:right-[max(12px,env(safe-area-inset-right))]' : ''}`}
      onClick={event => { focusOnExpandRef.current = event.detail === 0; setKeyboardFocus(event.detail === 0); setExpanded(true); }}>
      <ChevronDown size={20} aria-hidden="true" />
    </button>
    {children}
  </div>;
}
