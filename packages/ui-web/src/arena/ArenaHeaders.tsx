'use client';

import type { ReactNode } from 'react';
import { CollapsibleSection } from '../creator/CollapsibleSection';
import { AdvancedArenaHeaderView } from './AdvancedArenaHeaderView';
import { BattleLiteHeaderView } from './BattleLiteHeaderView';
import { ArenaPageLinks, type ArenaPageLinkComponent } from './ArenaPageNavigation';

export type ArenaHeaderProps = Readonly<{
  logo: ReactNode;
  Link: ArenaPageLinkComponent;
  draftSharing: 'shared' | 'independent';
  illustrationAvailable: boolean;
}>;

function GuideLinks({ Link, variant }: { Link: ArenaPageLinkComponent; variant: 'lite' | 'full' }) {
  const className = variant === 'lite' ? 'battle-lite-link' : 'text-blue-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
  return <div className="mt-3 flex flex-wrap gap-3 text-xs">
    <Link href="/encyclopedia/arena" className={className}>百科：竞技场</Link>
    <Link href="/encyclopedia/guidance" className={className}>
      {variant === 'lite' ? '百科：故事引导与读写状态' : '引导/判定事件/读写状态'}
    </Link>
  </div>;
}

export function BattleLiteHeader({ logo, Link, draftSharing, illustrationAvailable }: ArenaHeaderProps) {
  return (
    <BattleLiteHeaderView logo={logo}
      description="基于 2025 年 9 月的轻量怀旧版本，同时加入了选择AI模型等实用新功能，继续复用最新版竞技场后端与结果链路。"
      helper={<><span>需要辅助情景、问卷 Lore 等完整能力时，可随时</span><ArenaPageLinks Link={Link} variant="lite" /></>}>
      <CollapsibleSection title="📰 使用须知"
        description="熟悉后可收起该部分，或前往完整版竞技场获取更丰富的功能。"
        defaultOpen storageKey="battle-lite.section.guide.open" className="mt-5" contentClassName="text-sm">
        <ol className="battle-lite-muted-text list-decimal list-inside space-y-2">
          <li>
            本页是 `/battle` 简洁版，与
            <Link href="/arena" className="battle-lite-link mx-1">完整版竞技场</Link>
            {draftSharing === 'shared' ? '共享同一套已选角色、情景与生成结果。' : '分别保存草稿；切换页面不会带入已选角色、情景或生成结果。'}
          </li>
          <li>
            前往<Link href="/details" className="battle-lite-link mx-1">奇妙妖精大调查</Link>
            或<Link href="/canshou" className="battle-lite-link mx-1">研究院残兽调查</Link>
            页面生成角色并下载设定文件，或直接使用本页的预设角色 / 在线角色库。
          </li>
          <li>简洁版只保留主情景、故事方向引导、自定义 AI 提供商和基础生成方式；高级控制项已收敛到完整版。</li>
          <li>{illustrationAvailable ? '页面底部仍保留连续战报会话、立绘生成等结果扩展能力。' : '页面底部可继续生成连续战报；插图生成暂未开放。'}</li>
        </ol>
        <GuideLinks Link={Link} variant="lite" />
      </CollapsibleSection>
    </BattleLiteHeaderView>
  );
}

export function AdvancedArenaHeader({ logo, Link, draftSharing, illustrationAvailable }: ArenaHeaderProps) {
  const linkClassName = 'footer-link focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
  return (
    <AdvancedArenaHeaderView logo={logo} description="能亲眼见到强者之战，这下就算死也会值回票价呀！"
      guideStorageKey="arena.section.guide.open" guideChildren={<>
        <ol className="list-decimal list-inside space-y-1">
          <li>
            本页是完整版竞技场，如需更简洁或怀旧的体验，可前往
            <Link href="/battle" className={linkClassName}>【简洁版竞技场】</Link>。
            {draftSharing === 'independent' ? '两页分别保存草稿；切换页面不会带入已选角色、情景或生成结果。' : null}
          </li>
          <li>
            前往<Link href="/details" className={linkClassName}>【奇妙妖精大调查】</Link>
            或<Link href="/canshou" className={linkClassName}>【研究院残兽调查】</Link>
            页面，生成角色并下载其【设定文件】。
          </li>
          <li>收集至少 2 位角色的设定文件（.json 格式）。</li>
          <li>选择预设、上传设定文件，或使用随机匹配功能添加参战者。</li>
          <li>选择一个模式，然后敬请期待「命运的舞台」上的故事！</li>
          {!illustrationAvailable ? <li>页面底部可继续生成连续战报；插图生成暂未开放。</li> : null}
        </ol>
        <GuideLinks Link={Link} variant="full" />
      </>} />
  );
}
