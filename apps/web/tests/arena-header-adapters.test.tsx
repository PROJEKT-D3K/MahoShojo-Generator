// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BattleLiteHeader } from '@/components/arena-lite/BattleLiteHeader';
import { BattleHeader } from '@/components/arena/components/BattleHeader';
import { ArenaPageLinks } from '@/components/arena/shared/ArenaPageLinks';
import { ArenaRankingLinks } from '@/components/arena/shared/ArenaRankingLinks';

vi.mock('@/components/shared/ThemeImage', () => ({ ThemeImage: () => <span>logo</span> }));

describe('Web Arena host adapters', () => {
  it('uses shared guide composition while keeping Web draft and illustration facts', () => {
    const lite = renderToStaticMarkup(<BattleLiteHeader />);
    expect(lite).toContain('共享同一套已选角色、情景与生成结果');
    expect(lite).toContain('立绘生成');
    expect(lite).toContain('使用须知');
    expect(lite).toContain('href="/encyclopedia/guidance"');
    const full = renderToStaticMarkup(<BattleHeader />);
    expect(full).toContain('本页是完整版竞技场');
    expect(full).toContain('href="/battle"');
    expect(full).not.toContain('分别保存草稿');
    expect(full).not.toContain('插图生成暂未开放');
  });

  it('retains both page switches, external destination and the working quick-ranking action', () => {
    expect(renderToStaticMarkup(<ArenaPageLinks variant="lite" />)).toContain('href="/arena"');
    const full = renderToStaticMarkup(<ArenaPageLinks variant="full" />);
    expect(full).toContain('href="/battle"');
    expect(full).toContain('https://wantu-waystation.pages.dev/arena');
    const ranking = renderToStaticMarkup(<ArenaRankingLinks onOpenRankingModal={() => undefined} />);
    expect(ranking).toContain('快速查看排行榜');
    expect(ranking).toContain('href="/ranking"');
  });
});
