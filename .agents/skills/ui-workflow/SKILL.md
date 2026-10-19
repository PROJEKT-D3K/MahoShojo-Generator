---
name: ui-workflow
description: Use when implementing UI/UX changes in MahoShojo-Generator Web 或 Desktop——新增或修改共享样式、组件、页面视觉或交互。不用于与界面无关的纯逻辑/协议改动。
---

# UI Workflow

## 先读权威口径

1. `docs/specs/2026-10-19_215200_双端视觉基线与工程契约规格.md`（VIS-* 要求与变更权限分级）；
2. `packages/ui-web/src/styles.css`——全部 `--app-*`/`--creator-*` token 与三段主题解析的唯一事实源；
3. `packages/ui-web/src/showroom/sections.ts` 与 `ShowroomView`——现有分区与写法样板；
4. 触及业务域时，叠加该域自己的 accepted spec/ADR。

## 复用优先

- 视觉值一律经 `--app-*` token 或既有共享类（`btn-primary`/`btn-secondary`/`input-group`/`modal-*`/`footer-*` 等），控件默认图标+文字；禁止新增未声明的 `var()`、逗号兜底、样式表数字字重与离网格间距/非刻度圆角/字号字面量。
- 组件一律从 `@mahoshojo/ui-web` 的显式 exports 导入，不深挖 `src/*`，不在宿主侧另写"本端一套"。
- 写法政策：Tailwind utility + 共享类；styled-jsx/CSS Module/inline style 属 legacy，存量随接触清理、增量为零。
- 双端同语义只实现一次：宿主只做薄壳/平台装配。

## 同单元义务

- 新增或显著变更共享组件/共享样式时，同一工作单元加入或更新对应样板分区（分区渲染生产组件，禁写"好看版"示例），并同步 `SHOWROOM_SECTIONS` 登记。
- token 命名/配对变化时同步 `tests/design-tokens.test.ts`、`tests/design-contrast.test.ts` 的登记表；已知缺口只能登记为 known-violation，不得静默改色或放宽阈值。

## 变更权限（VIS-GOV-001）

- A 级（token 内修复、同源抽取、门禁维护、样板分区）可自主实施并附验证；
- B 级（新共享控件/原语、主布局、新刻度 token）先向用户说明问题、候选与复用路径再动手；
- C 级（产品语义、主题整体换血、视觉语言重定义）未获明确授权不做。

## 验证与交付

- 最小验证：受影响包的 `lint`/`typecheck`/`test`；改 token/CSS 必跑 `tests/design-tokens.test.ts` + `tests/design-contrast.test.ts`；改样板/入口必跑 `tests/visual-showroom.test.ts` + `packages/ui-web` 样板渲染测试。
- 视觉面变化建议本地 `pnpm review:visual`（可 `--screenshots`），报告与证据落在 `.tmp/visual-review/`；它是人工验收辅助，不是门禁。
- 回执写清：依据（哪条 VIS-*/ADR）、复用了什么、实测环境（命令与结果）、未测范围（如 Desktop WebView2 需按 runbook 人工验收）。
