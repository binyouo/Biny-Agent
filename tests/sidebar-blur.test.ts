/** Real hook + DOM events; the clock only controls timer delivery, not layout logic. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, type PointerEvent as ReactPointerEvent } from "react";
import { useSidebarLayout } from "../src/desktop/renderer/src/app/useSidebarLayout.js";
import { SIDEBAR_PEEK_CLOSE_MS, SIDEBAR_PEEK_LEAVE_GRACE_MS, SIDEBAR_PEEK_OPEN_DELAY_MS, SIDEBAR_PEEK_PINNING_MS } from "../src/desktop/sidebarSizing.js";

class ManualClock {
  private now = 0;
  private nextId = 0;
  private readonly tasks = new Map<number, { due: number; callback: () => void }>();

  readonly setTimeout = (callback: () => void, delay = 0): number => {
    const id = ++this.nextId;
    this.tasks.set(id, { due: this.now + Math.max(0, delay), callback });
    return id;
  };

  readonly clearTimeout = (id: number | undefined): void => {
    if (id !== undefined) this.tasks.delete(id);
  };

  get pending(): number { return this.tasks.size; }

  private next(): [number, { due: number; callback: () => void }] | undefined {
    return [...this.tasks.entries()].sort(([aId, a], [bId, b]) => a.due - b.due || aId - bId)[0];
  }

  /** Deliver exactly one task so the zero-delay exit cleanup can be interrupted. */
  runNext(): void {
    const entry = this.next();
    assert.ok(entry, "expected a pending timer");
    const [id, task] = entry;
    this.now = task.due;
    this.tasks.delete(id);
    task.callback();
  }

  advance(ms: number): void {
    const target = this.now + ms;
    let entry = this.next();
    let delivered = 0;
    while (entry && entry[1].due <= target) {
      assert.ok(++delivered <= 1_000, "timer delivery limit exceeded (possible zero-delay loop)");
      this.runNext();
      entry = this.next();
    }
    this.now = target;
  }
}

type Controller = ReturnType<typeof useSidebarLayout>;

interface Fixture {
  controller(): Controller;
  clock: ManualClock;
  toggle(): Promise<void>;
  enter(): Promise<void>;
  leave(): Promise<void>;
  blur(): Promise<void>;
  focus(): Promise<void>;
  advance(ms: number): Promise<void>;
  next(): Promise<void>;
  unmount(): Promise<void>;
}

async function withFixture(check: (fixture: Fixture) => Promise<void>): Promise<void> {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://localhost" });
  const clock = new ManualClock();
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let unmount: (() => Promise<void>) | undefined;
  try {
    for (const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      Element: dom.window.Element,
      Node: dom.window.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout
    })) {
      saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    const { createRoot } = await import("react-dom/client");
    const container = dom.window.document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    let controller!: Controller;
    let mounted = true;
    function Harness(): null { controller = useSidebarLayout(); return null; }
    unmount = async (): Promise<void> => {
      if (!mounted) return;
      await act(() => root.unmount());
      mounted = false;
    };
    const fixture: Fixture = {
      controller: () => controller,
      clock,
      toggle: async () => { await act(() => controller.toggle()); },
      enter: async () => {
        await act(() => controller.triggerHandlers.onPointerEnter({} as ReactPointerEvent<HTMLElement>));
      },
      leave: async () => {
        await act(() => controller.drawerHandlers.onPointerLeave({ clientX: controller.layout.contentWidth + 1 } as ReactPointerEvent<HTMLElement>));
      },
      blur: async () => { await act(() => { dom.window.dispatchEvent(new dom.window.Event("blur")); }); },
      focus: async () => { await act(() => { dom.window.dispatchEvent(new dom.window.Event("focus")); }); },
      advance: async (ms) => { await act(() => clock.advance(ms)); },
      next: async () => { await act(() => clock.runNext()); },
      unmount
    };
    await act(() => root.render(createElement(Harness)));
    await check(fixture);
  } finally {
    try {
      await unmount?.();
    } finally {
      try {
        dom.window.close();
      } finally {
        for (const [key, descriptor] of saved) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else Reflect.deleteProperty(globalThis, key);
        }
      }
    }
  }
}

function expectLayout(fixture: Fixture, mode: Controller["layout"]["mode"], transition: Controller["layout"]["transition"]): void {
  assert.equal(fixture.controller().layout.mode, mode);
  assert.equal(fixture.controller().layout.transition, transition);
}

async function openPeek(fixture: Fixture): Promise<void> {
  expectLayout(fixture, "expanded", "idle");
  await fixture.toggle();
  await fixture.enter();
  await fixture.advance(SIDEBAR_PEEK_OPEN_DELAY_MS);
  expectLayout(fixture, "peek", "idle");
}

async function startClosing(fixture: Fixture): Promise<void> {
  await openPeek(fixture);
  await fixture.leave();
  await fixture.advance(SIDEBAR_PEEK_LEAVE_GRACE_MS);
  expectLayout(fixture, "peek", "peek-closing");
}

for (const blur of [false, true]) {
  test(`peek pinning completes at its original deadline (blur=${blur})`, async () => {
    await withFixture(async (fixture) => {
      await openPeek(fixture);
      await fixture.toggle();
      expectLayout(fixture, "peek", "pinning");
      await fixture.advance(100);
      if (blur) await fixture.blur();
      await fixture.advance(SIDEBAR_PEEK_PINNING_MS - 101);
      expectLayout(fixture, "peek", "pinning");
      if (blur) await fixture.blur();
      await fixture.advance(1);
      expectLayout(fixture, "expanded", "idle");
      assert.equal(fixture.clock.pending, 0);
    });
  });

  test(`peek closing completes at its original deadline and can reopen (blur=${blur})`, async () => {
    await withFixture(async (fixture) => {
      await startClosing(fixture);
      await fixture.advance(50);
      if (blur) await fixture.blur();
      await fixture.advance(SIDEBAR_PEEK_CLOSE_MS - 51);
      expectLayout(fixture, "peek", "peek-closing");
      if (blur) await fixture.blur();
      await fixture.advance(1);
      expectLayout(fixture, "collapsed", "idle");
      assert.equal(fixture.clock.pending, 0);
      await fixture.focus();
      await fixture.enter();
      await fixture.advance(SIDEBAR_PEEK_OPEN_DELAY_MS);
      expectLayout(fixture, "peek", "idle");
    });
  });
}

test("blur cancels a pending hover open without changing collapsed mode", async () => {
  await withFixture(async (fixture) => {
    await fixture.toggle();
    await fixture.enter();
    assert.equal(fixture.clock.pending, 1);
    await fixture.blur();
    assert.equal(fixture.clock.pending, 0);
    await fixture.advance(SIDEBAR_PEEK_OPEN_DELAY_MS);
    expectLayout(fixture, "collapsed", "idle");
  });
});

test("blur starts closing an open peek and repeated blur preserves the deadline", async () => {
  await withFixture(async (fixture) => {
    await openPeek(fixture);
    await fixture.blur();
    expectLayout(fixture, "peek", "peek-closing");
    await fixture.advance(SIDEBAR_PEEK_CLOSE_MS - 1);
    await fixture.blur();
    await fixture.advance(1);
    expectLayout(fixture, "collapsed", "idle");
  });
});

test("blur between the closing and zero-delay exit tasks preserves cleanup (simulated task ordering)", async () => {
  await withFixture(async (fixture) => {
    await startClosing(fixture);
    await fixture.next();
    expectLayout(fixture, "collapsed", "peek-exited");
    assert.equal(fixture.clock.pending, 1);
    await fixture.blur();
    assert.equal(fixture.clock.pending, 1, "blur must preserve the pending exit cleanup");
    await fixture.next();
    expectLayout(fixture, "collapsed", "idle");
    assert.equal(fixture.clock.pending, 0);
    await fixture.enter();
    await fixture.advance(SIDEBAR_PEEK_OPEN_DELAY_MS);
    expectLayout(fixture, "peek", "idle");
  });
});

test("explicit collapse after blur still cancels the pin completion", async () => {
  await withFixture(async (fixture) => {
    await openPeek(fixture);
    await fixture.toggle();
    await fixture.blur();
    await fixture.toggle();
    await fixture.advance(SIDEBAR_PEEK_PINNING_MS);
    expectLayout(fixture, "collapsed", "idle");
    assert.equal(fixture.clock.pending, 0);
  });
});

for (const phase of ["opening", "grace", "closing", "exited", "pinning"] as const) {
  test(`unmount clears the pending ${phase} timer; post-unmount blur schedules no work`, async () => {
    await withFixture(async (fixture) => {
      if (phase === "opening") {
        await fixture.toggle();
        await fixture.enter();
      } else {
        await openPeek(fixture);
        if (phase === "pinning") {
          await fixture.toggle();
        } else {
          await fixture.leave();
          if (phase !== "grace") await fixture.advance(SIDEBAR_PEEK_LEAVE_GRACE_MS);
          if (phase === "exited") await fixture.next();
        }
      }
      assert.equal(fixture.clock.pending, 1);
      await fixture.unmount();
      assert.equal(fixture.clock.pending, 0);
      await fixture.blur();
      assert.equal(fixture.clock.pending, 0);
      await fixture.advance(SIDEBAR_PEEK_PINNING_MS * 2);
    });
  });
}
