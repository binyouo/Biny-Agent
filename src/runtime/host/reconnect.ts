/**
 * Runtime Host 重连退避与 spawn 熔断。
 *
 * 这里是独立可测的纯逻辑：退避曲线只产出下一次等待的毫秒数，熔断只累计「spawn-即死」
 * 并在越限时给出终结错误；socket/进程等副作用仍归 client.ts 与 lifecycle.ts。
 *
 * 参数语义与客户端重连生命周期保持一致，包含
 * minMs/maxMs/stableConnectionMs（#3462 对策：host spawn 即死 + 固定间隔重试会把
 * 注册栈跑几千次直到主进程 OOM）。
 */

export interface RuntimeHostReconnectBackoffOptions {
  /** 第一次重连的基准延迟。 */
  readonly minMs: number;
  /** 常规退避上限。 */
  readonly maxMs: number;
  /** 连接稳定运行超过该时长后，退避计数重置。 */
  readonly stableConnectionMs: number;
  /** [0,1) 随机源，测试可注入固定值消除抖动。 */
  readonly random?: () => number;
}

export const runtimeHostReconnectMinMs = 250;
export const runtimeHostReconnectMaxMs = 30_000;
export const runtimeHostReconnectStableMs = 60_000;

/**
 * 计算第 `attempt` 次（≥1）重连前的等待毫秒数：minMs 起步、×2 指数、封顶 maxMs，
 * 并叠加 ±20% 抖动防止多客户端同拍重连。`attempt <= 1` 落在基准 minMs 附近。
 */
export function runtimeHostReconnectDelayMs(attempt: number, options: RuntimeHostReconnectBackoffOptions): number {
  const { minMs, maxMs } = options;
  if (attempt <= 1) {
    return Math.min(maxMs, applyJitter(minMs, options.random));
  }
  const exponential = minMs * 2 ** Math.min(attempt - 1, 30);
  return Math.min(maxMs, applyJitter(exponential, options.random));
}

function applyJitter(baseMs: number, random: (() => number) | undefined): number {
  const sample = random?.() ?? Math.random();
  const bounded = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
  return Math.max(1, Math.round(baseMs * (0.8 + bounded * 0.4)));
}

export const runtimeHostSpawnCircuitThreshold = 3;

/** spawn 熔断越限时抛出的终结错误；client/host 据此停止 respawn 而不是无限重试。 */
export class RuntimeHostSpawnCircuitOpenError extends Error {
  constructor(readonly endpoint: string, readonly attempts: number, lastFailure?: Error) {
    super(
      `Runtime Host process died immediately ${String(attempts)} times in a row; giving up spawning. `
      + "Inspect the startup details, fix the cause, then reopen Biny or restart the affected CLI/TUI client."
      + (lastFailure === undefined ? "" : `\nLast startup failure: ${lastFailure.message}`),
      { cause: lastFailure }
    );
    this.name = "RuntimeHostSpawnCircuitOpenError";
  }
}

export interface RuntimeHostSpawnCircuit {
  /** 进程起来后立刻退出/握手失败计一次；返回当前连续失败数。 */
  recordFailure(error?: Error): number;
  /** 一次成功握手（host 真正 ready）清零连续失败计数。 */
  recordSuccess(): void;
  /** 越限（连续失败 ≥ threshold）时返回应抛出的终结错误，否则 undefined。 */
  failureError(): RuntimeHostSpawnCircuitOpenError | undefined;
  readonly consecutiveFailures: number;
}

/**
 * 进程内共享的 spawn 熔断器。CLI/TUI/Desktop 的本进程 respawn 与 daemon 的进程内拉起
 * 最终都收口到 spawnRuntimeHostProcess + waitForHostRegistration，因此一个模块级实例即可
 * 拦住所有进程内 respawn 通路，避免任何一条成为绕过熔断的风暴通路。（launchd KeepAlive 的
 * 跨进程拉起在进程外，靠 host 启动自身失败即退出来打断，不在此计数。）
 */
export function createRuntimeHostSpawnCircuit(
  endpoint: string,
  threshold: number = runtimeHostSpawnCircuitThreshold
): RuntimeHostSpawnCircuit {
  let consecutiveFailures = 0;
  let lastFailure: Error | undefined;
  return {
    get consecutiveFailures() {
      return consecutiveFailures;
    },
    recordFailure(error?: Error): number {
      consecutiveFailures += 1;
      lastFailure = error;
      return consecutiveFailures;
    },
    recordSuccess(): void {
      consecutiveFailures = 0;
      lastFailure = undefined;
    },
    failureError(): RuntimeHostSpawnCircuitOpenError | undefined {
      return consecutiveFailures >= threshold
        ? new RuntimeHostSpawnCircuitOpenError(endpoint, consecutiveFailures, lastFailure)
        : undefined;
    }
  };
}

const spawnCircuits = new Map<string, RuntimeHostSpawnCircuit>();

/** 同一 endpoint（即同一 workspace）共享一个熔断计数，跨调用方累计连续失败。 */
export function runtimeHostSpawnCircuitFor(endpoint: string): RuntimeHostSpawnCircuit {
  let circuit = spawnCircuits.get(endpoint);
  if (!circuit) {
    circuit = createRuntimeHostSpawnCircuit(endpoint);
    spawnCircuits.set(endpoint, circuit);
  }
  return circuit;
}
