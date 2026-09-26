/**
 * Composer 内的统一动作按钮。
 *
 * 这里不使用原生 `title`，避免浏览器弹出时序不可控的提示；Tooltip 由 Astryx
 * 的 layer 统一处理延迟、焦点、Escape 和窗口边界。带禁用原因时保留按钮焦点，
 * 但拦截激活事件，让键盘用户也能知道按钮为什么不可用。
 */
import { useTooltip } from "@astryxdesign/core/Tooltip";
import React, { forwardRef, useCallback } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ComposerActionButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "disabled" | "title"> {
  children: ReactNode;
  label: string;
  tooltip?: string;
  disabled?: boolean;
  disabledReason?: string;
  active?: boolean;
  loading?: boolean;
}

export const ComposerActionButton = forwardRef<HTMLButtonElement, ComposerActionButtonProps>(function ComposerActionButton({
  active = false,
  children,
  className,
  disabled = false,
  disabledReason,
  label,
  loading = false,
  onClick,
  onKeyDown,
  type = "button",
  tooltip,
  ...rest
}, ref): React.JSX.Element {
  // disabledReason 只描述不可用状态；即使调用方误传，也不能覆盖可用按钮的正常提示。
  const content = disabled ? disabledReason ?? tooltip : tooltip;
  const keepFocusable = disabled && Boolean(disabledReason);
  const tooltipApi = useTooltip({
    delay: 150,
    focusTrigger: "auto",
    isEnabled: Boolean(content),
    placement: "above"
  });

  const setButtonRef = useCallback((element: HTMLButtonElement | null): void => {
    tooltipApi.ref(element);
    if (typeof ref === "function") {
      ref(element);
    } else if (ref) {
      ref.current = element;
    }
  }, [ref, tooltipApi]);

  const handleClick: NonNullable<ButtonHTMLAttributes<HTMLButtonElement>["onClick"]> = (event) => {
    if (disabled) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };

  const handleKeyDown: NonNullable<ButtonHTMLAttributes<HTMLButtonElement>["onKeyDown"]> = (event) => {
    if (keepFocusable && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      return;
    }
    onKeyDown?.(event);
  };

  return (
    <>
      <button
        {...rest}
        aria-describedby={content ? [rest["aria-describedby"], tooltipApi.describedBy].filter(Boolean).join(" ") : rest["aria-describedby"]}
        aria-busy={loading || undefined}
        aria-disabled={keepFocusable || undefined}
        aria-label={rest["aria-label"] ?? label}
        className={className ? `biny-composer-action ${className}` : "biny-composer-action"}
        data-active={active ? "true" : undefined}
        data-loading={loading ? "true" : undefined}
        disabled={disabled && !keepFocusable}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        ref={setButtonRef}
        type={type}
      >
        <span className="biny-composer-action-content">{children}</span>
      </button>
      {content ? tooltipApi.renderTooltip(content) : null}
    </>
  );
});

ComposerActionButton.displayName = "ComposerActionButton";
