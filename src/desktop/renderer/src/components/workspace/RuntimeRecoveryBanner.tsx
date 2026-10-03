import { useRef, useState } from "react";
import type { DesktopRuntimeError, DesktopSessionWriterConflict } from "../../../../protocol.js";
import { errorMessage } from "../../app/desktopApi.js";
import { Icon } from "../Icon.js";

interface RuntimeRecoveryBannerProps {
  writerConflict?: DesktopSessionWriterConflict;
  runtimeError?: DesktopRuntimeError;
  onRetry(): Promise<void>;
  onCreateBranch?(): Promise<void>;
  onOpenProject(): void;
}

export function RuntimeRecoveryBanner({ writerConflict, runtimeError, onRetry, onCreateBranch, onOpenProject }: RuntimeRecoveryBannerProps): React.JSX.Element {
  const [action, setAction] = useState<"retry" | "branch">();
  const [failure, setFailure] = useState<string>();
  const inFlight = useRef(false);
  const run = async (nextAction: "retry" | "branch", operation: () => Promise<void>): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setAction(nextAction);
    setFailure(undefined);
    try {
      await operation();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      inFlight.current = false;
      setAction(undefined);
    }
  };
  const executing = writerConflict?.conflictKind === "execution";
  const owner = writerConflict?.ownerSurface === "tui" ? "终端 TUI"
    : writerConflict?.ownerSurface === "cli" ? "命令行"
    : writerConflict?.ownerSurface === "desktop" ? "桌面端" : "另一个执行入口";
  const title = writerConflict ? executing ? "此会话正在执行" : "此会话的写入权被占用"
    : runtimeError?.kind === "startup_timeout" ? "运行时启动超时"
    : runtimeError?.kind === "protocol_mismatch" ? "运行时版本不一致"
    : runtimeError?.kind === "host_unavailable" ? "运行时连接不可用"
    : "暂时无法启动运行时";
  const description = writerConflict ? executing
    ? `${owner}正在执行此会话。等待本轮结束后刷新状态，或创建聊天分支继续；同目录的其他会话仍可使用。`
    : `${writerConflict.ownerPid === undefined ? "另一个进程" : `进程 ${String(writerConflict.ownerPid)}`}持有此会话的写入权。等待它完成或在该进程中关闭会话后刷新状态。其他会话仍可使用。`
    : runtimeError?.kind === "protocol_mismatch" ? "确认旧运行时没有正在执行的任务后，将它退出，再重新打开 Biny。历史记录仍可查看。"
    : runtimeError?.kind === "host_unavailable" ? "已发现后台运行时进程，但暂时无法连接。请检查技术详情中的进程状态，再重试连接；历史和未发送的输入仍会保留。"
    : runtimeError?.retryable === false ? "运行时连续启动失败，已停止自动尝试。请检查技术详情，修复原因后重新打开 Biny。历史记录仍可查看。"
    : "历史记录和未发送的输入仍会保留。重试只重新连接运行时，不会自动发送消息。";
  return (
    <div className="biny-runtime-recovery-container">
      <aside aria-busy={action !== undefined} aria-live="polite" className="biny-runtime-recovery" role="alert">
        {writerConflict ? <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 18 18" width="18">
          <rect height="8.8" rx="2.25" stroke="currentColor" strokeWidth="1.33" width="11.6" x="3.2" y="6.2" />
          <path d="M5.3 6.3V6a3.7 3.7 0 0 1 7.4 0v.3" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.33" />
          <path d="M8.5 10.5h1" stroke="currentColor" strokeLinecap="round" strokeWidth="1.33" />
        </svg> : <Icon name="warning" size={18} />}
        <div className="biny-runtime-recovery-copy">
          <h3>{title}</h3>
          <span>{description}</span>
          {runtimeError ? <details><summary>技术详情</summary><p>{runtimeError.message}</p></details> : null}
          {writerConflict ? <details><summary>占用详情</summary>
            <p>会话：{writerConflict.sessionId}{writerConflict.runId ? `；运行：${writerConflict.runId}` : ""}{writerConflict.ownerPid === undefined ? "" : `；${executing ? "运行时" : "占用"}进程：${String(writerConflict.ownerPid)}`}</p>
          </details> : null}
          {failure ? <span className="biny-runtime-recovery-failure">{failure}</span> : null}
        </div>
        <div className="biny-runtime-recovery-actions">
          {writerConflict || runtimeError?.retryable ? <button disabled={action !== undefined} onClick={() => void run("retry", onRetry)} type="button">{writerConflict ? "刷新状态" : "重试"}</button> : null}
          {writerConflict && onCreateBranch ? <button disabled={action !== undefined} onClick={() => void run("branch", onCreateBranch)} type="button">创建聊天分支</button> : null}
          {!writerConflict ? <button disabled={action !== undefined} onClick={onOpenProject} type="button">打开其他项目</button> : null}
        </div>
      </aside>
    </div>
  );
}
