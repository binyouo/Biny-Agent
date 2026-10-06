/**
 * 把回调产生的事件与正在消费的异步流汇合。
 *
 * 载荷只保存在队列里；Promise 仅作为唤醒信号，避免每个调用方各自维护
 * pendingEvents、waker 和清理时机。它只保证展示事件的局部 FIFO，不承担
 * 持久化、消息里程碑或终态的控制流顺序。
 */
interface WakeGeneration {
  promise: Promise<void>;
  resolve: () => void;
  waiters: number;
}

export class EventQueue<T> {
  private readonly events: T[] = [];
  private wake: WakeGeneration;

  constructor() {
    this.wake = this.nextWake();
  }

  push(...events: T[]): void {
    if (!events.length) return;
    this.events.push(...events);
    this.wake.resolve();
    this.wake = this.nextWake();
  }

  drain(): T[] {
    return this.events.splice(0, this.events.length);
  }

  async waitForEventOr<U>(pending: Promise<U>): Promise<U | undefined> {
    if (this.events.length) return undefined;
    const wake = this.wake;
    wake.waiters += 1;
    try {
      return await Promise.race([pending, wake.promise.then(() => undefined)]);
    } finally {
      wake.waiters -= 1;
      // 静默流的每个结果都会留下一个 losing wake reaction；最后一个等待者
      // 离开时释放这一代，避免已消费的结果一直保留到下一次 push。
      // push 可能已创建新一代，也不能让仍在等待的其他调用方失去唤醒源。
      if (wake.waiters === 0 && this.wake === wake) this.wake = this.nextWake();
    }
  }

  private nextWake(): WakeGeneration {
    let resolveWake: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      resolveWake = resolve;
    });
    return { promise, resolve: resolveWake, waiters: 0 };
  }
}
