import { useState, type ReactNode } from 'react';

import { MAGICAL_GIRL_CARD_GRADIENT, MagicalGirlCard } from '../character-card';
import { COLOR_MODE_OPTIONS, useColorModePreference } from '../color-mode';
import { generationActionClassNames } from '../generation-actions';
import type { HomeAssetSource } from '../home/feature-catalog';
import { BaseModal } from '../modal';
import { ProductFooter } from '../shell';
import { SHOWROOM_MAGICAL_GIRL } from './fixtures';
import { SHOWROOM_SECTIONS, type ShowroomSectionId } from './sections';

export interface ShowroomViewProps {
  /**
   * 宿主品牌资源根（两端当前均为 origin 根 `/`，形状同源但来源各自声明）。
   * 供页脚等展示位拼接站内资源路径。
   */
  assetSource?: HomeAssetSource;
}

const PANEL_CLASS = 'rounded-xl border border-(--app-border) bg-(--app-surface) p-5 shadow-sm';
const SWATCH_CLASS = 'h-14 w-full rounded-md border border-(--app-border)';

function SectionFrame({ id, title, summary, children }: {
  id: ShowroomSectionId;
  title: string;
  summary: string;
  children: ReactNode;
}) {
  return (
    <section id={`showroom-${id}`} className="flex scroll-mt-20 flex-col gap-4" aria-labelledby={`showroom-${id}-title`}>
      <div>
        <h2 id={`showroom-${id}-title`} className="text-lg font-semibold text-(--app-text)">{title}</h2>
        <p className="mt-1 text-sm text-(--app-text-muted)">{summary}</p>
      </div>
      {children}
    </section>
  );
}

function TokenSwatch({ token }: { token: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className={SWATCH_CLASS} style={{ background: `var(${token})` }} role="img" aria-label={`${token} 色样`} />
      <code className="text-xs break-all text-(--app-text-muted)">{token}</code>
    </div>
  );
}

const COLOR_GROUPS: ReadonlyArray<{ title: string; tokens: readonly string[] }> = [
  { title: '页面与表面', tokens: ['--app-page-bg', '--app-surface', '--app-surface-80', '--app-surface-60', '--app-surface-40', '--app-border', '--app-border-strong'] },
  { title: '文本', tokens: ['--app-text', '--app-text-muted', '--app-text-subtle'] },
  { title: '输入', tokens: ['--app-input-bg', '--app-input-border'] },
  { title: '强调', tokens: ['--app-accent', '--app-accent-strong', '--app-accent-shadow', '--app-focus-ring'] },
  { title: 'Creator 面板', tokens: ['--creator-panel-bg', '--creator-panel-border', '--creator-subpanel-bg', '--creator-input-bg', '--creator-input-border'] },
  { title: '结果卡', tokens: ['--app-result-card-bg', '--app-result-item-bg', '--app-card-shadow'] },
];

const SPACE_TOKENS = ['--app-space-1', '--app-space-2', '--app-space-3', '--app-space-4', '--app-space-5', '--app-space-6', '--app-space-8', '--app-space-10'] as const;
const RADIUS_TOKENS = ['--app-radius-sm', '--app-radius-md', '--app-radius-lg', '--app-radius-xl', '--app-radius-pill'] as const;
const SHADOW_TOKENS = ['--app-shadow-sm', '--app-shadow-md', '--app-shadow-lg'] as const;
const Z_TOKENS = ['--app-z-overlay', '--app-z-modal', '--app-z-toast'] as const;
const TEXT_TOKENS = ['--app-text-xs', '--app-text-sm', '--app-text-base', '--app-text-lg', '--app-text-xl', '--app-text-2xl'] as const;

function SemanticColorsSection() {
  return (
    <div className="flex flex-col gap-5">
      {COLOR_GROUPS.map((group) => (
        <div key={group.title}>
          <h3 className="mb-2 text-sm font-medium text-(--app-text-muted)">{group.title}</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {group.tokens.map((token) => <TokenSwatch key={token} token={token} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

function TypographySection() {
  return (
    <div className={`${PANEL_CLASS} flex flex-col gap-4`}>
      <div>
        <h3 className="mb-1 text-sm font-medium text-(--app-text-muted)">--app-font-sans</h3>
        <p className="text-(--app-text)" style={{ fontFamily: 'var(--app-font-sans)' }}>
          魔法少女生成器 — The quick brown fox jumps over the lazy dog 0123456789
        </p>
      </div>
      <div>
        <h3 className="mb-1 text-sm font-medium text-(--app-text-muted)">--app-font-mono</h3>
        <p className="text-(--app-text)" style={{ fontFamily: 'var(--app-font-mono)' }}>
          {`const codename = '样板间·澄星'; // 0123456789`}
        </p>
      </div>
      <div className="flex flex-col gap-1 border-t border-(--app-border) pt-3">
        {TEXT_TOKENS.map((token) => (
          <p key={token} className="text-(--app-text)" style={{ fontSize: `var(${token})` }}>
            <code className="mr-2 text-xs text-(--app-text-muted)">{token}</code>
            魔法少女生成器 MahoShojo
          </p>
        ))}
      </div>
    </div>
  );
}

function ScalesSection() {
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div className={`${PANEL_CLASS} flex flex-col gap-2`}>
        <h3 className="text-sm font-medium text-(--app-text-muted)">间距（4px 网格）</h3>
        {SPACE_TOKENS.map((token) => (
          <div key={token} className="flex items-center gap-3">
            <code className="w-28 shrink-0 text-xs text-(--app-text-muted)">{token}</code>
            <div className="h-3 rounded-sm" style={{ width: `var(${token})`, background: 'var(--app-accent)' }} />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-5">
        <div className={PANEL_CLASS}>
          <h3 className="mb-3 text-sm font-medium text-(--app-text-muted)">圆角</h3>
          <div className="flex flex-wrap items-end gap-4">
            {RADIUS_TOKENS.map((token) => (
              <div key={token} className="flex flex-col items-center gap-1.5">
                <div
                  className="h-14 w-14 border-2"
                  style={{ borderColor: 'var(--app-accent)', borderRadius: `var(${token})`, background: 'var(--app-surface-60)' }}
                />
                <code className="text-xs text-(--app-text-muted)">{token.replace('--app-radius-', '')}</code>
              </div>
            ))}
          </div>
        </div>
        <div className={PANEL_CLASS}>
          <h3 className="mb-3 text-sm font-medium text-(--app-text-muted)">阴影</h3>
          <div className="flex flex-wrap gap-4">
            {SHADOW_TOKENS.map((token) => (
              <div key={token} className="flex flex-col items-center gap-1.5">
                <div
                  className="h-14 w-20 rounded-lg border border-(--app-border) bg-(--app-surface)"
                  style={{ boxShadow: `var(${token})` }}
                />
                <code className="text-xs text-(--app-text-muted)">{token.replace('--app-shadow-', '')}</code>
              </div>
            ))}
          </div>
        </div>
        <div className={PANEL_CLASS}>
          <h3 className="mb-2 text-sm font-medium text-(--app-text-muted)">层级</h3>
          <ul className="flex flex-col gap-1 text-sm text-(--app-text)">
            <li><code>--global-topbar-z-index</code>（既有语义 token）</li>
            {Z_TOKENS.map((token) => <li key={token}><code>{token}</code></li>)}
          </ul>
        </div>
      </div>
    </div>
  );
}

function ControlsSection() {
  return (
    <div className={`${PANEL_CLASS} flex flex-wrap items-center gap-3`}>
      <button type="button" className={generationActionClassNames.primary}>主操作</button>
      <button type="button" className={generationActionClassNames.secondary}>次要操作</button>
      <button type="button" className={generationActionClassNames.destructive}>危险操作</button>
      <button type="button" className={generationActionClassNames.primary} disabled>禁用主操作</button>
      <button type="button" className={generationActionClassNames.secondary} disabled>禁用次要操作</button>
    </div>
  );
}

function FormsSection() {
  return (
    <div className={`${PANEL_CLASS} flex flex-col gap-5`}>
      <div className="max-w-md">
        <div className="input-group">
          <label className="input-label" htmlFor="showroom-input">输入标签（.input-label）</label>
          <input id="showroom-input" className="input-field" type="text" placeholder="占位文本走 --app-text-subtle" />
        </div>
        <div className="input-group mb-0">
          <label className="input-label" htmlFor="showroom-input-filled">已填写输入</label>
          <input id="showroom-input-filled" className="input-field" type="text" defaultValue="示例输入内容" readOnly />
        </div>
      </div>
      <div className="flex flex-col gap-2 border-t border-(--app-border) pt-4">
        <h3 className="text-sm font-medium text-(--app-text-muted)">battle-lite 共享类</h3>
        <p className="battle-lite-strong-text">.battle-lite-strong-text —— 主文本</p>
        <p className="battle-lite-muted-text">.battle-lite-muted-text —— 弱化文本</p>
        <p className="battle-lite-subtle-text">.battle-lite-subtle-text —— 最弱文本</p>
        <p><a href="#showroom-forms" className="battle-lite-link">.battle-lite-link —— 链接样式</a></p>
        <div className="battle-lite-accent-box rounded-lg p-3 text-sm">.battle-lite-accent-box —— 强调盒面</div>
        <div className="battle-lite-info-box rounded-lg p-3 text-sm">.battle-lite-info-box —— 信息盒面</div>
        <span className="battle-lite-info-pill inline-block rounded-full px-3 py-1 text-xs">.battle-lite-info-pill</span>
      </div>
    </div>
  );
}

function OverlaySection({ onOpen }: { onOpen: () => void }) {
  return (
    <div className={`${PANEL_CLASS} flex flex-wrap items-center gap-3`}>
      <button type="button" className={generationActionClassNames.secondary} onClick={onOpen}>
        打开示例对话框
      </button>
      <p className="text-sm text-(--app-text-muted)">共源 BaseModal：Escape 栈顶消费、焦点圈留、初始焦点在关闭按钮。</p>
    </div>
  );
}

function ResultSurfacesSection() {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-(--app-text-muted)">
        以下为共享 <code>MagicalGirlCard</code> 真实组件（fixture 数据 + <code>MAGICAL_GIRL_CARD_GRADIENT</code>）：
      </p>
      <div className="max-w-3xl">
        <MagicalGirlCard magicalGirl={SHOWROOM_MAGICAL_GIRL} gradientStyle={MAGICAL_GIRL_CARD_GRADIENT} />
      </div>
    </div>
  );
}

export function ShowroomView({ assetSource = { baseUrl: '/' } }: ShowroomViewProps) {
  const { preference, resolvedMode, setPreference, isHydrated } = useColorModePreference();
  const [modalOpen, setModalOpen] = useState(false);

  const sectionContent = (id: ShowroomSectionId): ReactNode => {
    switch (id) {
      case 'semantic-colors': return <SemanticColorsSection />;
      case 'typography': return <TypographySection />;
      case 'scales': return <ScalesSection />;
      case 'controls': return <ControlsSection />;
      case 'forms': return <FormsSection />;
      case 'overlay': return <OverlaySection onOpen={() => setModalOpen(true)} />;
      case 'result-surfaces': return <ResultSurfacesSection />;
      case 'footer': return <ProductFooter assetSource={assetSource} />;
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-6 py-10" data-showroom-root>
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-bold text-(--app-text)">视觉样板间</h1>
        <p className="max-w-3xl text-sm text-(--app-text-muted)">
          双端共源视觉基线的集中审查面（SPEC-visual-baseline-v1 VIS-SHOW-001）：
          全部样板直接渲染生产 token 与生产组件，不做"好看版"另写。
          开发路由专用，不进产品导航。
        </p>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="颜色模式（与设置页同一共享偏好）">
          <span className="text-sm text-(--app-text-muted)">
            颜色模式{isHydrated ? `（当前解析：${resolvedMode === 'dark' ? '暗' : '亮'}）` : ''}：
          </span>
          {COLOR_MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={preference === option.value}
              onClick={() => setPreference(option.value)}
              className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                preference === option.value
                  ? 'border-(--app-accent) bg-(--app-surface) font-medium text-(--app-text)'
                  : 'border-(--app-border) bg-(--app-surface-60) text-(--app-text-muted) hover:bg-(--app-surface)'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <nav aria-label="样板间分区导航" className="flex flex-wrap gap-2 text-sm">
          {SHOWROOM_SECTIONS.map((section) => (
            <a key={section.id} href={`#showroom-${section.id}`} className="battle-lite-link">
              {section.title}
            </a>
          ))}
        </nav>
      </header>

      {SHOWROOM_SECTIONS.map((section) => (
        <SectionFrame key={section.id} id={section.id} title={section.title} summary={section.summary}>
          {sectionContent(section.id)}
        </SectionFrame>
      ))}

      <BaseModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title="示例对话框"
        description="共享 BaseModal 原语演示"
        footer={(
          <div className="flex justify-end gap-2">
            <button type="button" className={generationActionClassNames.secondary} onClick={() => setModalOpen(false)}>
              取消
            </button>
            <button type="button" className={generationActionClassNames.primary} onClick={() => setModalOpen(false)}>
              确认
            </button>
          </div>
        )}
      >
        <p className="text-sm">
          Tab 在对话框内循环；Escape 关闭栈顶一层；背景点按同样关闭。
          这些行为与生产弹层共享同一 escape-stack 登记。
        </p>
      </BaseModal>
    </div>
  );
}
