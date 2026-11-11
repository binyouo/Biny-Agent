/** ActivityAnalyzer 的时机层测试：覆盖首次 120s、周期 10min 和活跃跳过行为。 */
import assert from "node:assert/strict";
import {
  ACTIVITY_ANALYSIS_INITIAL_DELAY_MS,
  ACTIVITY_ANALYSIS_SWEEP_INTERVAL_MS,
  ActivityAnalysisScheduler,
  type ActivityAnalysisSchedulerTimers
} from "../src/activity/analysisScheduler.js";

class FakeTimers implements ActivityAnalysisSchedulerTimers {
  private nextId = 1;
  private time = 0;
  private timers = new Map<number, { deadline: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { deadline: this.time + ms, callback });
    return id;
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }

  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    while (true) {
      let next: { id: number; deadline: number; callback: () => void } | undefined;
      for (const [id, timer] of this.timers) {
        const candidate = { id, deadline: timer.deadline, callback: timer.callback };
        if (candidate.deadline <= target
          && (next === undefined || candidate.deadline < next.deadline
            || (candidate.deadline === next.deadline && candidate.id < next.id))) {
          next = candidate;
        }
      }
      if (!next) break;
      this.timers.delete(next.id);
      this.time = next.deadline;
      next.callback();
      await Promise.resolve();
    }
    this.time = target;
  }

  pendingCount(): number {
    return this.timers.size;
  }
}

await testInitialAndPeriodicSweep();
await testActiveSweepIsSkipped();
await testStopClearsBothTimers();
await testStartIsIdempotent();
await testRunningSweepIsNotReentered();

async function testInitialAndPeriodicSweep(): Promise<void> {
  const timers = new FakeTimers();
  const runs: number[] = [];
  const scheduler = new ActivityAnalysisScheduler({
    run: () => { runs.push(runs.length + 1); },
    timers
  });
  scheduler.start();
  await timers.advance(ACTIVITY_ANALYSIS_INITIAL_DELAY_MS - 1);
  assert.deepEqual(runs, []);
  await timers.advance(1);
  assert.deepEqual(runs, [1], "启动后 120 秒做首次 sweep");
  await timers.advance(ACTIVITY_ANALYSIS_SWEEP_INTERVAL_MS - ACTIVITY_ANALYSIS_INITIAL_DELAY_MS - 1);
  assert.deepEqual(runs, [1]);
  await timers.advance(1);
  assert.deepEqual(runs, [1, 2], "之后每 10 分钟 sweep 一次");
  scheduler.stop();
}

async function testActiveSweepIsSkipped(): Promise<void> {
  const timers = new FakeTimers();
  let active = true;
  let runs = 0;
  const scheduler = new ActivityAnalysisScheduler({
    run: () => { runs += 1; },
    isUserActive: () => active,
    timers
  });
  scheduler.start();
  await timers.advance(ACTIVITY_ANALYSIS_INITIAL_DELAY_MS);
  assert.equal(runs, 0, "用户刚有输入时首次 sweep 应跳过");
  active = false;
  await timers.advance(ACTIVITY_ANALYSIS_SWEEP_INTERVAL_MS - ACTIVITY_ANALYSIS_INITIAL_DELAY_MS);
  assert.equal(runs, 1, "下一周期应重新检查 pending session");
  scheduler.stop();
}

async function testStopClearsBothTimers(): Promise<void> {
  const timers = new FakeTimers();
  let runs = 0;
  const scheduler = new ActivityAnalysisScheduler({ run: () => { runs += 1; }, timers });
  scheduler.start();
  scheduler.stop();
  assert.equal(timers.pendingCount(), 0);
  await timers.advance(ACTIVITY_ANALYSIS_SWEEP_INTERVAL_MS * 2);
  assert.equal(runs, 0);
}

async function testStartIsIdempotent(): Promise<void> {
  const timers = new FakeTimers();
  let runs = 0;
  const scheduler = new ActivityAnalysisScheduler({ run: () => { runs += 1; }, timers });
  scheduler.start();
  scheduler.start();
  assert.equal(timers.pendingCount(), 2, "重复 start 不应重复注册首次/周期定时器");
  await timers.advance(ACTIVITY_ANALYSIS_INITIAL_DELAY_MS);
  assert.equal(runs, 1);
  scheduler.stop();
}

async function testRunningSweepIsNotReentered(): Promise<void> {
  const timers = new FakeTimers();
  let runs = 0;
  let release: (() => void) | undefined;
  const scheduler = new ActivityAnalysisScheduler({
    run: async () => {
      runs += 1;
      await new Promise<void>((resolve) => { release = resolve; });
    },
    timers
  });
  scheduler.start();
  await timers.advance(ACTIVITY_ANALYSIS_INITIAL_DELAY_MS);
  await timers.advance(ACTIVITY_ANALYSIS_SWEEP_INTERVAL_MS - ACTIVITY_ANALYSIS_INITIAL_DELAY_MS);
  assert.equal(runs, 1, "周期到点时在途分析不可并发重入");
  release?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  scheduler.stop();
}

// A run may synchronously change settings and restart its scheduler.
{
  const timers = new FakeTimers();
  let restarted = false;
  const scheduler = new ActivityAnalysisScheduler({ timers, initialDelayMs: 100, sweepIntervalMs: 10,
    run: () => { if (!restarted) { restarted = true; scheduler.stop(); scheduler.start(); } } });
  scheduler.start();
  await timers.advance(10);
  assert.equal(timers.pendingCount(), 2, "旧周期回调不能在重启后再创建一条周期链");
  scheduler.stop();
  assert.equal(timers.pendingCount(), 0, "停止必须清理所有轮次的计时器");
}
