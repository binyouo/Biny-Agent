/**
 * 模型测试按钮与结果卡片的统一入口，统一工具模型测试模式：
 * 烧瓶描边按钮与选择器同行等高，测试中转圈，结果不用按钮图标表达，
 * 而由下方独立的结果卡片展示（成功带耗时，失败给原因）。
 * 服务商面板的「测试连接」沿用另一套成熟模式（状态在图标上），从这里取状态图标。
 */
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { Icon } from "../Icon.js";
import type { DesktopModelConnectionTestResult } from "../../../../protocol.js";

/** 测试按钮上的状态图标：进行中 / 最近结果 / 空闲，三态由调用方的测试状态驱动。 */
export function ModelTestStatusIcon({ testing, lastResult }: {
  testing: boolean;
  lastResult?: DesktopModelConnectionTestResult;
}): React.JSX.Element {
  return testing ? <Icon className="icon-spin" name="loader" size={14} />
    : lastResult?.ok ? <Icon className="is-ok" name="circle-check" size={14} />
    : lastResult ? <Icon className="is-error" name="circle-close" size={14} />
    : <Icon name="spark" size={14} />;
}

/** 单模型测试按钮：烧瓶图标、高度跟随同行选择器，用于工具模型与记忆工具模型。 */
export function ModelTestButton({ testing, disabled, label, onClick }: {
  testing: boolean;
  disabled?: boolean;
  label: string;
  onClick(): void;
}): React.JSX.Element {
  return (
    <Tooltip delay={150} content={label}>
      <button
        aria-label={label}
        className={`provider-test-button model-test-button${testing ? " is-testing" : ""}`}
        disabled={disabled || testing}
        onClick={onClick}
        type="button"
      >
        {testing ? <Icon className="icon-spin" name="loader" size={16} /> : <Icon name="flask" size={16} />}
      </button>
    </Tooltip>
  );
}

/** 测试结果独立成行：成功带时长，失败直接给原因，长错误整体折行不撑破面板。 */
export function ModelTestResult({ result }: { result?: DesktopModelConnectionTestResult }): React.JSX.Element | null {
  if (!result) return null;
  return (
    <div className={`connection-test-result${result.ok ? " is-ok" : " is-error"}`} role="status">
      <span>{result.ok
        ? `测试通过${result.latencyMs === undefined ? "" : ` · ${(result.latencyMs / 1000).toFixed(1)} 秒`}`
        : "测试失败"}</span>
      {!result.ok && result.message ? <pre>{result.message}</pre> : null}
    </div>
  );
}
