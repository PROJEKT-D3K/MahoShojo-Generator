---
name: ui-review
description: Use when reviewing MahoShojo-Generator 的 UI/UX 改动（组件、样式、token、样板间、视觉一致性），对照视觉基线 spec 与契约门禁判断是否达标。不用于纯逻辑/协议审查（用 code-review）。
---

# UI Review

## 审查基准

1. `docs/decisions/2026-10-19_215000_双端视觉治理体系决策.md`（已接受治理决策）；
2. `docs/specs/2026-10-19_215200_双端视觉基线与工程契约规格.md` 的 VIS-* MUST/MUST NOT；
3. 机器守卫的登记表：`tests/design-tokens.test.ts`（变量声明/兜底/字重/离网格 baseline）、`tests/design-contrast.test.ts`（配对矩阵与已知缺口）、`tests/visual-showroom.test.ts`（分区覆盖与入口约束）。

## 重点检查

- 视觉值是否走 `--app-*` token/共享类：新增未声明 `var()`、逗号兜底、数字字重、离网格字面量属违约（baseline 只能降不能增）；
- 是否绕过共享组件另写"本端一套"，或跨包深挖 `src/*` 私有路径；
- 新增/变更共享组件是否同单元更新样板分区与 `SHOWROOM_SECTIONS`，分区是否渲染生产组件而非另写示例；
- 写法政策：增量 styled-jsx/CSS Module/inline style 是否为零，遗留清理是否顺手但未混入无关重构；
- a11y：是否新增 jsx-a11y warn、`focus-visible` 与键盘可达是否保持、新控件是否处理 forced-colors 或登记缺口；
- 变更权限：B/C 级改动是否有先行说明/授权，是否存在"借修 UI 之名"改产品语义。

## 证据要求

- 不接受"看起来对"：要求列明实际运行的 lint/typecheck/test 与结果；
- 视觉面变化可要求 `pnpm review:visual`（含 `--screenshots`）的 `.tmp/visual-review/` 证据，但它是本地辅助而非硬门槛；
- Desktop 真 WebView2、原生高对比主题、读屏等人工验收项按 runbook 口径列为未验项即可，不要求本工具冒充。

## 结论

按严重度排序列出发现（文件/行为证据、影响、闭合标准），区分确认缺陷、设计问题与可选清理；收尾给出 `Block`、`Changes required` 或 `Looks good with minor follow-ups`。
