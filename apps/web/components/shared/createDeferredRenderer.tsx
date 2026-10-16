'use client';

import { Component, Suspense, lazy, type ComponentType, type ReactNode } from 'react';

/** Only the optional renderer remounts on retry; its owner's generation/recovery hooks stay mounted. */
export function createDeferredRenderer<Props extends object>(
  load: () => Promise<{ default: ComponentType<Props> }>,
  options: {
    label: string;
    fallback?: (props: Props) => ReactNode;
    wrapFallback?: (content: ReactNode, props: Props) => ReactNode;
  },
) {
  let CurrentRenderer = lazy(load);

  return class DeferredRenderer extends Component<Props, {
    hasError: boolean;
    Renderer: typeof CurrentRenderer;
  }> {
    state = { hasError: false, Renderer: CurrentRenderer };

    static getDerivedStateFromError() {
      return { hasError: true };
    }

    retry = () => {
      // React.lazy caches rejections. A fresh lazy instance retries the chunk without reloading the page.
      CurrentRenderer = lazy(load);
      this.setState({ hasError: false, Renderer: CurrentRenderer });
    };

    renderFallback = () => {
      const content = (
        <div className="space-y-3 rounded-lg border border-gray-200 p-3">
          <div role={this.state.hasError ? 'alert' : 'status'} className="text-sm">
            {this.state.hasError ? `${options.label}加载失败，已有内容仍保留。` : `正在加载${options.label}…`}
            {this.state.hasError ? (
              <button type="button" onClick={this.retry} className="ml-3 rounded border px-3 py-1">
                重试加载
              </button>
            ) : null}
          </div>
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
