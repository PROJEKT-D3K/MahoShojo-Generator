import type { ComponentPropsWithRef } from 'react';

/** 大型生成按钮保留既有视觉，间距交还当前生成页容器。 */
export const generationSubmitClassName = 'generate-button ui-web-generation-submit';

/** 生成页已有的三类操作层级；不拥有派发、保存、确认或可信度判定。 */
export const generationActionClassNames = {
  primary: 'ui-web-generation-action ui-web-generation-action--primary',
  secondary: 'ui-web-generation-action ui-web-generation-action--secondary',
  destructive: 'ui-web-generation-action ui-web-generation-action--destructive',
} as const;

export type GenerationActionVariant = keyof typeof generationActionClassNames;

export interface GenerationActionButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: GenerationActionVariant;
}

/** 链接等原生元素可复用 classNames；按钮默认不提交宿主表单。 */
export function GenerationActionButton({
  variant = 'secondary', className, type = 'button', ...props
}: GenerationActionButtonProps) {
  return <button {...props} type={type} className={[generationActionClassNames[variant], className].filter(Boolean).join(' ')} />;
}

/** 残兽结果页的再次生成入口；确认、冷却与派发仍由宿主负责。 */
export function CanshouRegenerateButton(props: ComponentPropsWithRef<'button'>) {
  return <button
    {...props}
    type="button"
    className={generationSubmitClassName}
    style={{ marginTop: '0.5rem', backgroundColor: '#a855f7', backgroundImage: 'linear-gradient(to right, #a855f7, #d946ef)' }}
  />;
}
