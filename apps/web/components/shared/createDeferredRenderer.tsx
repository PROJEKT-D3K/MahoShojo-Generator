'use client';

import { Component, Suspense, lazy, type ComponentType, type ReactNode } from 'react';
import { createDeferredModuleLoader } from '@/lib/client/loadDeferredModule';
import { DeferredChunkRecovery } from './DeferredChunkRecovery';

/** Only the optional renderer remounts on retry; its owner's generation/recovery hooks stay mounted. */
export function createDeferredRenderer<Props extends object>(
  load: () => Promise<{ default: ComponentType<Props> }>,
  options: {
    label: string;
    fallback?: (props: Props) => ReactNode;
    wrapFallback?: (content: ReactNode, props: Props) => ReactNode;
  },
) {
  const loadWithRetry = createDeferredModuleLoader(load);
  const createRenderer = () => lazy(loadWithRetry);
  let CurrentRenderer = createRenderer();

  return class DeferredRenderer extends Component<Props, {
    hasError: boolean;
    error: unknown;
    Renderer: typeof CurrentRenderer;
  }> {
    state = { hasError: false, error: null as unknown, Renderer: CurrentRenderer };

    static getDerivedStateFromError(error: unknown) {
      return { hasError: true, error };
    }

    retry = () => {
      // Reset React's rejected lazy cache, not webpack's deployment-specific asset URL.
      CurrentRenderer = createRenderer();
      this.setState({ hasError: false, error: null, Renderer: CurrentRenderer });
    };

    renderFallback = () => {
      const content = (
        <div className="space-y-3 rounded-lg border border-gray-200 p-3">
          <div role={this.state.hasError ? 'alert' : 'status'} className="text-sm">
            {this.state.hasError ? `${options.label}加载失败，已有内容仍保留。` : `正在加载${options.label}…`}
          </div>
          {this.state.hasError ? <DeferredChunkRecovery error={this.state.error} onRetry={this.retry} /> : null}
          {options.fallback?.(this.props)}
        </div>
      );
      return options.wrapFallback ? options.wrapFallback(content, this.props) : content;
    };

    render() {
      if (this.state.hasError) return this.renderFallback();
      const Renderer = this.state.Renderer;
      return <Suspense fallback={this.renderFallback()}><Renderer {...this.props} /></Suspense>;
    }
  };
}
