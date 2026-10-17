'use client';

import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { BaseModal } from './BaseModal';
import { DeferredChunkRecovery } from './DeferredChunkRecovery';

type DeferredChunkBoundaryProps = {
  readonly children: ReactNode;
} & ({
  readonly mode?: 'modal';
  readonly isOpen?: boolean;
  readonly onClose: () => void;
} | {
  readonly mode: 'inline';
  readonly label: string;
});

type DeferredChunkBoundaryState = {
  readonly hasError: boolean;
  readonly error: unknown;
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
  state: DeferredChunkBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: unknown): DeferredChunkBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // 可选代码块的失败由本地提示承接，不影响父页面。
  }

  render(): ReactNode {
    if (!this.state.hasError) return (
      <Suspense fallback={this.props.mode === 'inline'
        ? <p role="status">正在加载{this.props.label}…</p>
        : <DeferredChunkLoading isOpen={this.props.isOpen} onClose={this.props.onClose} />}>
        {this.props.children}
      </Suspense>
    );
    if (this.props.mode === 'inline') return (
      <div className="space-y-3 rounded-lg border border-gray-200 p-3">
        <p role="alert">{this.props.label}加载失败，页面其他内容仍可继续使用。</p>
        <DeferredChunkRecovery error={this.state.error} />
      </div>
    );
    if (this.props.isOpen === false) return null;

    return (
      <BaseModal isOpen onClose={this.props.onClose} title="功能加载失败" maxWidthClassName="max-w-md" zIndexClassName="z-[1100]">
        <div className="space-y-4">
          <p role="alert">此功能加载失败，页面其他内容仍可继续使用。</p>
          <DeferredChunkRecovery error={this.state.error} />
        </div>
      </BaseModal>
    );
  }
}
