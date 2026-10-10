import type { TestContext } from "node:test";

/** Register teardown before setup; release each acquired resource once, in reverse order. */
export function fixtureCleanup(t: Pick<TestContext, "after">): (action: () => void | Promise<void>) => () => Promise<void> {
  const actions: Array<() => Promise<void>> = [];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const action of actions.reverse()) {
      try { await action(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Fixture cleanup failed");
  });
  return (action) => {
    let pending = true;
    const dispose = async () => {
      if (!pending) return;
      pending = false;
      await action();
    };
    actions.push(dispose);
    return dispose;
  };
}
