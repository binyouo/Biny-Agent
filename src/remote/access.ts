import { redactSecrets } from "../utils/secrets.js";
import { createRemotePeerApi, type RemoteHostProvider } from "./api.js";
import { remotePairingUrl, remoteRelayUrl } from "./address.js";
import { generateConnectCode } from "./crypto.js";
import { runRemoteTunnel } from "./tunnel.js";

export interface RemoteAccessInput { relay: string; registrationKey?: string }
export interface RemoteAccessStatus {
  state: "disabled" | "connecting" | "connected" | "reconnecting" | "error";
  relay?: string;
  pairingUrl?: string;
  connections: number;
  error?: string;
}
interface AccessRun {
  input: RemoteAccessInput;
  code: string;
  controller: AbortController;
  task: Promise<void>;
}

/** 一个入口授权整台 Biny；各项目 Host 由手机端请求按需接入，关闭不取消已提交回合。 */
export class RemoteAccess {
  private current?: AccessRun;
  private snapshot: RemoteAccessStatus = { state: "disabled", connections: 0 };

  constructor(
    private readonly provider: RemoteHostProvider,
    private readonly changed: () => void
  ) {}

  status(): RemoteAccessStatus { return { ...this.snapshot }; }

  start(input: RemoteAccessInput): RemoteAccessStatus {
    const relay = remoteRelayUrl(input.relay).origin;
    if (this.current) throw new Error("请先关闭当前远程访问。");
    const run: AccessRun = { input: { ...input, relay }, code: generateConnectCode(), controller: new AbortController(), task: Promise.resolve() };
    this.current = run;
    this.snapshot = { state: "connecting", relay, connections: 0 };
    this.changed();
    run.task = this.run(run);
    // 清理失败仍由 stop 等待并报告，同时避免运行期间出现未观察的拒绝。
    void run.task.catch(() => {
      this.snapshot = { state: "error", relay, connections: 0, error: "远程连接资源未能完全释放，请退出并重新启动 Biny。" };
      this.changed();
    });
    return this.status();
  }

  async stop(): Promise<RemoteAccessStatus> {
    const run = this.current;
    if (!run) return this.status();
    run.controller.abort();
    // 立即撤下旧码，等待通道与 Host 客户端释放后才允许再次开启。
    this.snapshot = { state: "disabled", relay: run.input.relay, connections: 0 };
    this.changed();
    await run.task;
    if (this.current === run) this.current = undefined;
    return this.status();
  }

  async regenerate(): Promise<RemoteAccessStatus> {
    const input = this.current?.input;
    if (!input) throw new Error("请先开启远程访问。");
    await this.stop();
    return this.start(input);
  }

  private async run(run: AccessRun): Promise<void> {
    try {
      await runRemoteTunnel({
        relay: run.input.relay, code: run.code, registrationKey: run.input.registrationKey,
        createPeer: emit => createRemotePeerApi(this.provider, emit),
        onStatus: state => {
          if (run.controller.signal.aborted) return;
          this.snapshot = { state, relay: run.input.relay, connections: this.snapshot.connections,
            pairingUrl: state === "connected" ? remotePairingUrl(run.input.relay, run.code) : undefined };
          this.changed();
        },
        onPeerCount: connections => {
          if (run.controller.signal.aborted) return;
          this.snapshot = { ...this.snapshot, connections };
          this.changed();
        }
      }, run.controller.signal);
    } catch (cause) {
      if (run.controller.signal.aborted) throw cause;
      const message = redactSecrets(cause instanceof Error ? cause.message : "远程连接失败。").replaceAll(run.code, "[redacted]");
      this.snapshot = { state: "error", relay: run.input.relay, connections: 0,
        error: run.input.registrationKey ? message.replaceAll(run.input.registrationKey, "[redacted]") : message };
      this.changed();
    }
  }
}
