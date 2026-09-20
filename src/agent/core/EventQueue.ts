/**
 * 把回调产生的事件与正在消费的异步流汇合。
 *
 * 载荷只保存在队列里；Promise 仅作为唤醒信号，避免每个调用方各自维护
 * pendingEvents、waker 和清理时机。它只保证展示事件的局部 FIFO，不承担
 * 持久化、消息里程碑或终态的控制流顺序。
 */
export class EventQueue<T> {
  private readonly events: T[] = [];
  private wake: Promise<void>;
  private resolveWake: () => void = () => undefined;

  constructor() {
    this.wake = this.nextWake();
  }

  push(...events: T[]): void {
    if (!events.length) return;
    this.events.push(...events);
    this.resolveWake();
    this.wake = this.nextWake();
  }

  drain(): T[] {
    return this.events.splice(0, this.events.length);
  }

  async waitForEventOr<U>(pending: Promise<U>): Promise<U | undefined> {
    if (this.events.length) return undefined;
    return await Promise.race([pending, this.wake.then(() => undefined)]);
  }

  private nextWake(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolveWake = resolve;
    });
  }
}
