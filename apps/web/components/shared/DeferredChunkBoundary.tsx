'use client';

import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { BaseModal } from './BaseModal';

type DeferredChunkBoundaryProps = {
  readonly children: ReactNode;
  readonly isOpen?: boolean;
  readonly onClose: () => void;
};

type DeferredChunkBoundaryState = {
  readonly hasError: boolean;
};

export function DeferredChunkLoading({ isOpen = true, onClose, title = '正在加载…' }: {
  readonly isOpen?: boolean;
  readonly onClose: () => void;
  readonly title?: string;
}) {
  return (
    <BaseModal isOpen={isOpen} onClose={onClose} title={title} maxWidthClassName="max-w-md" zIndexClassName="z-[1100]">
      <p role="status">首次打开需要加载此功能，请稍候。</p>
    </BaseModal>
  );
}

/** 防止可选客户端代码块加载失败时连带卸载父页面。 */
export class DeferredChunkBoundary extends Component<
  DeferredChunkBoundaryProps,
  DeferredChunkBoundaryState
> {
  state: DeferredChunkBoundaryState = { hasError: false };

  static getDerivedStateFromError(): DeferredChunkBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // 可选代码块的失败由本地提示承接，不影响父页面。
  }

  render(): ReactNode {
    if (!this.state.hasError) return (
      <Suspense fallback={<DeferredChunkLoading isOpen={this.props.isOpen} onClose={this.props.onClose} />}>
        {this.props.children}
      </Suspense>
    );
    if (this.props.isOpen === false) return null;

    return (
      <BaseModal isOpen onClose={this.props.onClose} title="功能加载失败" maxWidthClassName="max-w-md" zIndexClassName="z-[1100]">
        <div className="space-y-4">
          <p role="alert">此功能加载失败，页面其他内容仍可继续使用。刷新页面会丢失尚未保存的输入。</p>
          <div className="flex justify-end gap-2">
            <button type="button" className="rounded bg-pink-600 px-3 py-1 text-white" onClick={() => window.location.reload()}>
              刷新重试
            </button>
          </div>
        </div>
      </BaseModal>
    );
  }
}
