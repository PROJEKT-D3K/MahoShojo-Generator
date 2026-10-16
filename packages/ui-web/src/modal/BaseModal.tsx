import type { ReactNode, RefObject } from 'react';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

import { hasNonDeferredFocusTrapLayer, hasNonDeferredLayerAbove, isTopmostFocusTrapLayer, popEscapeLayer, pushEscapeLayer, subscribeFocusTrapLayers } from './escape-stack';
import { acquireModalEnvironment } from './modal-lifecycle';

type Props = {
  isOpen: boolean;
  title?: ReactNode;
  titleId?: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  maxWidthClassName?: string;
  zIndexClassName?: string;
  closeOnBackdrop?: boolean;
  /** 仅供异步结果预览：其他模态前台期间暂停，保留 owner 的打开状态。 */
  deferToOtherModals?: boolean;
  closeButtonContent?: ReactNode;
  closeButtonAriaLabel?: string;
  onClose: () => void;
};

export type BaseModalLayoutClassNameOptions = {
  maxWidthClassName?: string;
  zIndexClassName?: string;
};

const joinClassNames = (...classNames: Array<string | null | undefined | false>): string =>
  classNames.filter(Boolean).join(' ');

const noModalLayer = () => false;
const noModalSubscription = () => () => {};

const DEFAULT_Z_INDEX_CLASS_NAME = 'z-50';
const DEFAULT_MAX_WIDTH_CLASS_NAME = 'max-w-4xl';
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * 对话框的 Escape/Tab 层级由 `escape-stack` 统一登记（DESK-PARITY-007）：
 * 一次按键只消费栈顶一层，Tab 循环只由最高的焦点约束层接管。此前模块内
 * 私有的 openModalStack 与该栈同源后，非模态弹层（抽屉、下拉、原生
 * <dialog>）也能进入同一条层级链，互不双消费。
 */

export const useBaseModalAccessibility = ({
  isOpen,
  onClose,
  fallbackFocusRef,
  deferToOtherModals = false,
}: {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly fallbackFocusRef?: RefObject<HTMLElement | null>;
  readonly deferToOtherModals?: boolean;
}) => {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const layerId = useMemo(() => Symbol('base-modal'), []);
  const suspended = useSyncExternalStore(
    deferToOtherModals ? subscribeFocusTrapLayers : noModalSubscription,
    deferToOtherModals ? hasNonDeferredFocusTrapLayer : noModalLayer,
    noModalLayer,
  );
  const isActive = isOpen && !suspended;

  useEffect(() => {
    // 同一 commit 中更早挂载的普通层也必须先让位，不能先抢焦点再等订阅重渲染。
    if (!isActive || (deferToOtherModals && hasNonDeferredFocusTrapLayer())) return;
    pushEscapeLayer({
      id: layerId,
      trapsFocus: true,
      deferred: deferToOtherModals,
      // 对话框始终消费落在自己头上的 Escape——即使 onClose 因业务条件
      // （如删除在途）暂不关闭，也不允许按键穿透到下层。
      onEscape: () => {
        onCloseRef.current();
        return true;
      },
    });
    const modalEnvironment = acquireModalEnvironment(fallbackFocusRef?.current ?? null);
    let initialFocusCancelled = false;
    const focusInitial = () => {
      const initialFocus = initialFocusRef.current;
      if (initialFocus && !initialFocus.disabled) {
        initialFocus.focus({ preventScroll: true });
      } else {
        dialogRef.current?.focus({ preventScroll: true });
      }
    };
    if (deferToOtherModals) {
      // 当前 effect 批次可能还有普通层尚未登记；异步预览不得先产生一次 focusin。
      queueMicrotask(() => {
        if (!initialFocusCancelled && !hasNonDeferredFocusTrapLayer()
          && !hasNonDeferredLayerAbove(layerId) && dialogRef.current?.isConnected) {
          modalEnvironment.refreshReturnFocus();
          focusInitial();
        }
      });
    } else {
      focusInitial();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !isTopmostFocusTrapLayer(layerId)) return;

      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])]
        .filter((element) => !element.matches(':disabled') && !element.hidden && element.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !dialogRef.current?.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !dialogRef.current?.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      initialFocusCancelled = true;
      const wasTopmost = isTopmostFocusTrapLayer(layerId);
      popEscapeLayer(layerId);
      modalEnvironment.releaseScroll();
      document.removeEventListener('keydown', onKeyDown);
      // 下层关闭不能把焦点从仍在交互的上层弹窗拉回页面。
      if (!wasTopmost) return;
      modalEnvironment.restoreFocus();
    };
  }, [deferToOtherModals, fallbackFocusRef, isActive, layerId]);

  return { dialogRef, initialFocusRef, titleId, isActive };
};

export const BASE_MODAL_ROOT_LAYOUT_CLASS_NAME = 'fixed inset-0 flex items-center justify-center overflow-hidden overscroll-none p-4';
export const BASE_MODAL_PANEL_LAYOUT_CLASS_NAME =
  'relative flex max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden';
export const BASE_MODAL_HEADER_LAYOUT_CLASS_NAME = 'shrink-0';
export const BASE_MODAL_BODY_LAYOUT_CLASS_NAME = 'min-h-0 flex-1 overflow-auto overscroll-contain';
export const BASE_MODAL_FOOTER_LAYOUT_CLASS_NAME = 'shrink-0';

export const getBaseModalLayoutClassNames = ({
  maxWidthClassName = DEFAULT_MAX_WIDTH_CLASS_NAME,
  zIndexClassName = DEFAULT_Z_INDEX_CLASS_NAME,
}: BaseModalLayoutClassNameOptions = {}) => ({
  rootClassName: joinClassNames(BASE_MODAL_ROOT_LAYOUT_CLASS_NAME, zIndexClassName),
  panelClassName: joinClassNames(
    BASE_MODAL_PANEL_LAYOUT_CLASS_NAME,
    'rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-950',
    maxWidthClassName,
  ),
  headerClassName: joinClassNames(
    BASE_MODAL_HEADER_LAYOUT_CLASS_NAME,
    'flex items-start justify-between gap-3 border-b border-gray-200 px-5 py-4 dark:border-gray-800',
  ),
  bodyClassName: joinClassNames(
    BASE_MODAL_BODY_LAYOUT_CLASS_NAME,
    'px-5 py-4 text-gray-900 dark:bg-gray-950 dark:text-gray-100',
  ),
  footerClassName: joinClassNames(
    BASE_MODAL_FOOTER_LAYOUT_CLASS_NAME,
    'border-t border-gray-200 bg-gray-50 px-5 py-3 dark:border-gray-800 dark:bg-gray-900',
  ),
});

export function BaseModal({
  isOpen,
  title,
  titleId: providedTitleId,
  description,
  children,
  footer,
  maxWidthClassName,
  zIndexClassName,
  closeOnBackdrop = true,
  deferToOtherModals = false,
  closeButtonContent,
  closeButtonAriaLabel = '关闭对话框',
  onClose,
}: Props) {
  const [mounted, setMounted] = useState(false);
  const {
    dialogRef,
    initialFocusRef: closeButtonRef,
    titleId: generatedTitleId,
    isActive,
  } = useBaseModalAccessibility({ isOpen: isOpen && mounted, onClose, deferToOtherModals });
  const titleId = providedTitleId ?? generatedTitleId;

  useEffect(() => {
    setMounted(true);
  }, []);

  const wrapper = useMemo(() => {
    if (!mounted) return null;
    return document.body;
  }, [mounted]);

  if (!isActive || !wrapper) return null;
  const { rootClassName, panelClassName, headerClassName, bodyClassName, footerClassName } =
    getBaseModalLayoutClassNames({ maxWidthClassName, zIndexClassName });
  const accessibleTitle = title || '对话框';

  return createPortal(
    <div className={rootClassName}>
      <button
        type="button"
        aria-label={closeOnBackdrop ? closeButtonAriaLabel : undefined}
        aria-hidden={!closeOnBackdrop}
        tabIndex={closeOnBackdrop ? 0 : -1}
        className="absolute inset-0 bg-black/60"
        onClick={closeOnBackdrop ? onClose : undefined}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={panelClassName}
      >
        <div className={headerClassName}>
          <div className="min-w-0">
            <div id={titleId} className="truncate text-lg font-semibold text-gray-900 dark:text-gray-100">{accessibleTitle}</div>
            {description ? <div className="mt-1 text-sm text-gray-600 dark:text-gray-400">{description}</div> : null}
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label={closeButtonAriaLabel}
            className="min-h-10 min-w-10 rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
          >
            {closeButtonContent ?? <X className="h-5 w-5" />}
          </button>
        </div>

        <div className={bodyClassName} role="region" aria-labelledby={titleId} tabIndex={0}>{children}</div>

        {footer ? <div className={footerClassName}>{footer}</div> : null}
      </div>
    </div>,
    wrapper
  );
}
