import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const parse = (file: string) => ts.createSourceFile(file, readFileSync(resolve(file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const cards = new Set(['MagicalGirlCard', 'CanshouCard', 'GeneralCharacterCard', 'CreatorStructuredResultCard']);
function cardUsages(file: string) {
  const found: ts.JsxAttributes[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && cards.has(node.tagName.getText())) found.push(node.attributes);
    ts.forEachChild(node, visit);
  };
  visit(parse(file)); return found;
}
const attribute = (attributes: ts.JsxAttributes, name: string) => attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText() === name)?.getText();

describe('角色卡导出宿主装配', () => {
  it('Desktop 每个实际角色卡消费均显式提供同一账号展示和失效守卫', () => {
    const consumers = readdirSync('apps/desktop/src/app').filter(file => file.endsWith('.tsx')).flatMap(file => {
      const uses = cardUsages(`apps/desktop/src/app/${file}`);
      for (const attrs of uses) {
        expect(attribute(attrs, 'generatedByBadge'), file).toContain('DesktopCharacterCardExportBadge');
        expect(attribute(attrs, 'captureExportGuard'), file).toContain('captureDesktopCharacterCardExportGuard');
      }
      return uses.length ? [file] : [];
    });
    expect(consumers.sort()).toEqual(['canshou-page.tsx', 'character-manager-page.tsx', 'creator-page.tsx', 'details-page.tsx', 'free-page.tsx', 'party-page.tsx', 'sublimation-page.tsx', 'tavern-page.tsx']);
  });

  it('Web Creator 的直接共享结构卡保留 client 边界并显式注入角色导出语义', () => {
    const file = 'apps/web/components/creation/CreatorPage.tsx';
    const first = parse(file).statements[0];
    expect(ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text).toBe('use client');
    const attrs = cardUsages(file).find(attrs => attribute(attrs, 'generatedByBadge'))!;
    expect(attribute(attrs, 'generatedByBadge')).toContain('CHARACTER_CARD_EXPORTER_LABEL');
    expect(attribute(attrs, 'captureExportGuard')).toContain('captureCharacterCardExportGuard');
  });
});
