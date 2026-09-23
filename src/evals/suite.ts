/**
 * 内置评测集与真实 agent 执行器。
 *
 * 这几个任务刻意选得小而明确：每个都有一条可执行的判据，跑一次几十秒，能覆盖编码 agent
 * 的基本动作（读、改、跑命令、按报错修）。它不是基准测试，是一把用来发现回归的尺子 ——
 * 改完 loop 或 prompt 之后跑一遍，看有没有任务从通过变成不通过。
 */
import { createCommandRuntime } from "../runtime/CommandRuntime.js";
import type { EvalAgentRunner } from "./runner.js";
import type { EvalTask } from "./types.js";

export const builtinEvalTasks: EvalTask[] = [
  {
    id: "fix-failing-test",
    prompt: "Run `node test.js`. It fails. Fix the implementation in sum.js so the test passes. Do not change test.js.",
    fixture: [
      { path: "sum.js", content: "export function sum(values) {\n  return values.length;\n}\n" },
      {
        path: "test.js",
        protected: true,
        content: [
          "import { sum } from './sum.js';",
          "const actual = sum([1, 2, 3]);",
          "if (actual !== 6) {",
          "  console.error(`expected 6, got ${actual}`);",
          "  process.exit(1);",
          "}",
          "console.log('ok');",
          ""
        ].join("\n")
      },
      { path: "package.json", content: '{\n  "name": "eval-fixture",\n  "type": "module"\n}\n', protected: true }
    ],
    // 最终判据由框架持有；工作区中的测试只是供 Agent 调试的样例。
    verify: `node --input-type=module -e 'import assert from "node:assert/strict"; import { sum } from "./sum.js"; for (const [input, expected] of [[[1,2,3],6],[[],0],[[-2,3],1],[[0.5,1.5],2]]) assert.equal(sum(input), expected);'`
  },
  {
    id: "multi-file-rename",
    prompt: "Rename the exported function `oldName` to `newName` everywhere in this project, including its call sites. Keep behaviour identical.",
    fixture: [
      { path: "lib.js", content: "export function oldName(value) {\n  return value * 2;\n}\n" },
      { path: "app.js", content: "import { oldName } from './lib.js';\n\nexport const result = oldName(21);\n" },
      { path: "package.json", content: '{\n  "name": "eval-fixture",\n  "type": "module"\n}\n' }
    ],
    verify: "! grep -rq 'oldName' . --include='*.js' && node -e \"import('./app.js').then(m => process.exit(m.result === 42 ? 0 : 1))\""
  },
  {
    id: "read-before-write",
    prompt: "The file notes.md has a list under '## Tasks'. Append a new item '- ship it' as the last entry of that list, leaving everything else untouched.",
    fixture: [
      {
        path: "notes.md",
        content: "# Notes\n\n## Tasks\n\n- write code\n- review code\n\n## Other\n\nkeep this section unchanged\n"
      }
    ],
    verify: "grep -q '^- ship it$' notes.md && grep -q 'keep this section unchanged' notes.md && [ \"$(grep -c '^- ' notes.md)\" = 3 ]"
  }
];

/**
 * 真实执行器：为每个任务起一个独立 runtime，跑一个回合，收集用量。
 *
 * 权限设为 full-access —— 评测环境是一次性临时工作区，交互式确认在这里既无人应答也没有
 * 意义。这也意味着**评测跑的不是权限路径**，权限的正确性由 permission 测试单独覆盖。
 */
export const runTaskWithAgent: EvalAgentRunner = async (workspaceRoot, task, signal) => {
  const runtime = await createCommandRuntime(workspaceRoot);
  try {
    const outcome = await runtime.agent.runTask(task.prompt, {
      abortSignal: signal,
      maxSteps: task.maxSteps,
      confirmPermission: async () => ({ approved: true, scope: "session" })
    });
    const usage = runtime.agent.usageSummary();
    return {
      steps: outcome.steps,
      totalTokens: usage.totalTokens,
      ...(usage.pricingKnown ? { costUsd: usage.costUsd } : {}),
      pricingKnown: usage.pricingKnown
    };
  } finally {
    await runtime.close();
  }
};
