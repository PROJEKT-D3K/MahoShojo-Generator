// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EncyclopediaHeaderLinks } from '../src/encyclopedia/views';

const links = [
  { href: '/', text: '返回首页', className: 'footer-link' },
  { href: '/arena', text: '竞技场', className: 'text-blue-600 hover:underline' },
  { href: '/ranking', text: '排行榜', className: 'text-blue-600 hover:underline' },
];
const resolveInternalHref = (href: string) => `#${href}`;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('EncyclopediaHeaderLinks', () => {
  it('keeps the web hrefs, labels, order and classes without another layout wrapper', () => {
    act(() => root.render(<EncyclopediaHeaderLinks />));
    expect([...container.children].map((anchor) => ({
      tag: anchor.tagName,
      href: anchor.getAttribute('href'),
      text: anchor.textContent,
      className: anchor.className,
    }))).toEqual(links.map((link) => ({ tag: 'A', ...link })));
  });

  it.each(links)('resolves $href for native links when no navigation callback is provided', ({ href }) => {
    act(() => root.render(<EncyclopediaHeaderLinks resolveInternalHref={resolveInternalHref} />));
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    act(() => { container.querySelector(`a[href="#${href}"]`)!.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
  });

  it.each(links)('delegates ordinary and detail=0 activation of $href to the host', ({ href }) => {
    const onNavigate = vi.fn();
    act(() => root.render(<EncyclopediaHeaderLinks onNavigate={onNavigate} resolveInternalHref={resolveInternalHref} />));
    const anchor = container.querySelector(`a[href="#${href}"]`)!;
    // detail=0 covers the click contract used by keyboard activation; jsdom does not exercise a physical keyboard.
    for (const detail of [1, 0]) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail });
      act(() => { anchor.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(true);
    }
    expect(onNavigate.mock.calls).toEqual([[href], [href]]);
  });

  it.each(links)('preserves modified, non-primary and already-prevented clicks on $href', ({ href }) => {
    const onNavigate = vi.fn();
    act(() => root.render(<EncyclopediaHeaderLinks onNavigate={onNavigate} resolveInternalHref={resolveInternalHref} />));
    const anchor = container.querySelector(`a[href="#${href}"]`)!;
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }]) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...options });
      act(() => { anchor.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(false);
    }
    const prevented = new MouseEvent('click', { bubbles: true, cancelable: true });
    prevented.preventDefault();
    act(() => { anchor.dispatchEvent(prevented); });
    expect(prevented.defaultPrevented).toBe(true);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('gives renderLink priority over href resolution and navigation callbacks for all three links', () => {
    const onNavigate = vi.fn();
    const resolve = vi.fn(resolveInternalHref);
    const hostNavigate = vi.fn();
    act(() => root.render(<EncyclopediaHeaderLinks
      onNavigate={onNavigate}
      resolveInternalHref={resolve}
      renderLink={(props) => <a {...props} data-host="next" onClick={(event) => {
        event.preventDefault();
        hostNavigate(props.href);
      }} />}
    />));
    const anchors = [...container.querySelectorAll('a[data-host="next"]')];
    expect(anchors.map((anchor) => ({
      href: anchor.getAttribute('href'), text: anchor.textContent, className: anchor.className,
    }))).toEqual(links);
    for (const anchor of anchors) {
      act(() => { anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    }
    expect(hostNavigate.mock.calls).toEqual(links.map(({ href }) => [href]));
    expect(resolve).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
