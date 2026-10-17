// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdvancedArenaHeader, ArenaPageLinks, ArenaRankingLinks, BattleLiteHeader, type ArenaPageLinkProps } from '../src/arena';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const Link = (props: ArenaPageLinkProps) => <a {...props} />;
async function render(element: ReactElement) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(element));
}
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); localStorage.clear(); });

describe('shared Arena headers and navigation', () => {
  it('retains the Web Lite guide, helper position, links and disclosure preference', async () => {
    await render(<BattleLiteHeader Link={Link} logo={<span>logo</span>} draftSharing="shared" illustrationAvailable />);
    const hero = container.querySelector('.battle-lite-hero-card')!;
    expect(hero.textContent).toContain('基于 2025 年 9 月的轻量怀旧版本');
    expect(hero.querySelector('a')?.getAttribute('href')).toBe('/arena');
    expect(container.textContent).toContain('共享同一套已选角色、情景与生成结果');
    expect(container.textContent).toContain('立绘生成');
    expect([...container.querySelectorAll('ol a')].map(link => link.getAttribute('href'))).toEqual(['/arena', '/details', '/canshou']);
    expect([...container.querySelectorAll('a[href^="/encyclopedia/"]')].map(link => link.getAttribute('href'))).toEqual(['/encyclopedia/arena', '/encyclopedia/guidance']);
    const toggle = container.querySelector('button[aria-expanded]')!;
    await act(async () => (toggle as HTMLButtonElement).click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('ol')).toBeNull();
    expect(localStorage.getItem('battle-lite.section.guide.open')).toBe('0');
    await act(async () => (toggle as HTMLButtonElement).click());
    expect(container.querySelector('ol')).not.toBeNull();
    expect(localStorage.getItem('battle-lite.section.guide.open')).toBe('1');
  });

  it.each([BattleLiteHeader, AdvancedArenaHeader])('only describes the Desktop capabilities supplied by the host', async Header => {
    await render(<Header Link={Link} logo={<span>logo</span>} draftSharing="independent" illustrationAvailable={false} />);
    expect(container.textContent).toContain('分别保存草稿；切换页面不会带入已选角色、情景或生成结果');
    expect(container.textContent).toContain('插图生成暂未开放');
    expect(container.textContent).not.toContain('共享同一套');
    expect(container.textContent).not.toContain('立绘生成');
    expect(container.textContent).not.toContain('客户端 Direct');
  });

  it('keeps full Web instructions and the existing full-guide storage key', async () => {
    localStorage.setItem('arena.section.guide.open', '0');
    await render(<AdvancedArenaHeader Link={Link} logo={<span>logo</span>} draftSharing="shared" illustrationAvailable />);
    expect(container.textContent).toContain('能亲眼见到强者之战');
    expect(container.querySelector('ol')).toBeNull();
    await act(async () => (container.querySelector('button[aria-expanded]') as HTMLButtonElement).click());
    expect(container.querySelectorAll('ol li')).toHaveLength(5);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/battle');
    expect(container.textContent).not.toContain('插图生成暂未开放');
  });

  it('shows quick ranking only with a real action, always keeping the normal ranking link', async () => {
    const open = vi.fn();
    await render(<ArenaRankingLinks Link={Link} />);
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).not.toContain('快速查看排行榜');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/ranking');
    await act(async () => root.render(<ArenaRankingLinks Link={Link} onOpenRankingModal={open} />));
    await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
    expect(open).toHaveBeenCalledOnce();
  });

  it('keeps Web external anchor semantics and delegates Desktop external opens to the host', async () => {
    const open = vi.fn();
    await render(<ArenaPageLinks Link={Link} variant="full" />);
    const external = container.querySelector<HTMLAnchorElement>('a[target="_blank"]')!;
    expect(external.href).toBe('https://wantu-waystation.pages.dev/arena');
    expect(external.rel).toBe('noopener noreferrer');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/battle');
    await act(async () => root.render(<ArenaPageLinks Link={Link} variant="full" onNavigateExternal={open} />));
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => external.dispatchEvent(click));
    expect(click.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledExactlyOnceWith(external.href);
    await act(async () => root.render(<ArenaPageLinks Link={Link} variant="lite" onNavigateExternal={open} />));
    expect(container.querySelector('a[target]')).toBeNull();
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/arena');
  });
});
