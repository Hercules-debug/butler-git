/**
 * dsh-butler-git —— 节点是「意图」,commit 是「证据」。做成 DSH 工具。
 *
 * ## 三个概念
 *
 *     节点    一个意图(你要达成什么)。它带 Δ(预期变化)和 P(检测程序)
 *     commit  达成时留下的**证据**。不可变,可重放
 *     绿      一个关于某个 commit 的事实 —— 所以永不过时
 *
 * ## 为什么做成工具,而不是让模型拼 bash
 *
 * 门禁的参数**就是**契约的结构。做成工具之后:
 *   - schema 引导模型,不用猜形状 -> 少重试(重试才是隐藏的成本大头)
 *   - 没有 shell 引号问题
 *   - 结构化返回
 *
 * ## 这个插件**不实现业务逻辑**
 *
 * 它调 `../lib/*.mjs`,和 CLI(`bin/bg.mjs`)**同一套代码**。
 *
 * 这一条是刻意的,而且是有代价换来的:上一个实现把核心写了两遍
 * (Python 一份、JS 一份),改了一边另一边静默落后 ——
 * 于是"模型用的那半边没有新门禁"。**逻辑只写一次,两个前端只是渲染。**
 *
 * ## 为什么只有四个工具
 *
 * 上一版 25 个是负担 —— 模型会挑一个差不多的用,或者开始乱试。
 * "看树"和"合并"都不该占模型的工具位:树用 `git log` 看,
 * 合并折进 `node_commit`(检测到 MERGE_HEAD 就走合并分支)。
 */

import { defineTool } from "@deepseek-ai/dsh-tools";

import { plan, commit, abandon, normalize } from "../lib/nodes.mjs";
import { parseDelta } from "../lib/delta.mjs";
import { renderStatus } from "../lib/view.mjs";

/** 插件的 Cordis 名称。 */
export const name = "butler-git-tools";

/**
 * Cordis 依赖声明 —— 必须声明,否则 ctx.tools 取不到。
 *
 * Cordis 的 ctx 是 Proxy:没在 inject 里声明的服务属性,读取时**直接抛**
 * `cannot get property "X" without inject`。漏一个,整棵插件树起不来。
 */
export const inject = ["tools"];

/**
 * 会话的工作区 —— 所有状态都在它的 `.bg/` 下。
 *
 * ## 为什么参数能覆盖它(BUG-4)
 *
 * 原来这里**写死**会话 cwd,而且工具的参数表里没有 `project`。
 * 后果实测过:节点声明在 A 目录的 `.bg/`,而会话在 B 目录 ——
 * 工具去找 B 的 `.bg/`,返回"(图是空的)"。
 * **模型看不见自己刚声明的验收**,只能绕道 CLI。
 *
 * 所以每个工具都能显式给 `project`;不给才退回会话 cwd。
 */
function projectOf(exec, args) {
  return args?.project ?? exec?.agent?.session?.header?.cwd ?? process.cwd();
}

const PROJECT_PARAM = {
  project: {
    type: "string",
    description:
      "工作目录(默认 = 会话 cwd)。图在它的 .bg/ 下。"
      + "**当你要操作的项目不是你当前所在的目录时,必须显式给这个参数** —— "
      + "否则工具会去找会话 cwd 的 .bg/,看不见你在别处声明的节点。",
  },
};

const OUTPUT = {
  type: "object",
  additionalProperties: true,
  properties: {
    ok: { type: "boolean", required: true },
    summary: { type: "string", required: true },
    lines: { type: "array", items: { type: "string" } },
  },
};

const renderText = (v) => [v.summary, ...(v.lines ?? [])].join("\n");

function brief(problems) {
  return (problems ?? []).map((p) => `  ${p}`);
}

// ------------------------------------------------------------------ 工具

export function apply(ctx) {
  // ---------------------------------------------------------- 1. plan
  ctx.tools.register(
    defineTool({
      name: "node_plan",
      description:
        "声明一个任务(**意图**)。它不跑任何验证,只把「要达成什么」记下来 —— "
        + "所以人看得见你的计划。\n"
        + "\n"
        + "三个必填:\n"
        + "  id      自己起一个,如 n7\n"
        + "  expect  一句话:要达成什么。**它同时就是 commit message**\n"
        + "  base    从哪个 commit 开始(**必须显式给**,我不猜默认值)\n"
        + "  verify  P:检测程序,一条命令,退出码 0 才算过。**必须有**\n"
        + "\n"
        + "delta(Δ)= 预期变化,精确集合,带方向:\n"
        + "  \"M:src/a.py\"          改了\n"
        + "  \"A:src/b.py\"          新增\n"
        + "  \"D:src/c.py\"          删除\n"
        + "  \"R:src/c.py:src/d.py\" 重命名\n"
        + "  **精确等于**:少了=漏做,多了=预期外的改动,类型不符=做错方向。\n"
        + "  不给 = 空。**空不是'没改动',是'没预测'** —— 那就没有任何东西防止意外改动。\n"
        + "\n"
        + "两道门(会在改的时候拦你):\n"
        + "  1. **达成过的节点,门禁冻结。** 要变,起一个新节点 —— 历史不改写。\n"
        + "  2. owner=user 且已经有一份门禁 -> 你改不动,要人授权。",
      parameters: {
        id: {
          type: "string",
          required: true,
          description: "节点 id,自己起一个,如 n7",
        },
        expect: {
          type: "string",
          required: true,
          description: "一句话:要达成什么。它同时就是 commit message",
        },
        base: {
          type: "string",
          required: true,
          description:
            "**初始 commit 的 sha,必须显式给。** \"从这个版本开始做\"。"
            + "用 `git rev-parse HEAD` 拿到当前的。不填默认值 —— "
            + "默认会让 Δ 的语义变模糊。",
        },
        verify: {
          type: "string",
          required: true,
          description:
            "**检测程序 P**:一条命令,退出码 0 才算过。必须有 —— "
            + "Δ 只管\"改的是不是这些文件\",没有 P 就没有任何东西说\"改对了\"。",
        },
        parent: {
          type: "string",
          description: "父节点 id。不给 = 这是**根**节点(它的 P 会变成所有人的根门禁)",
        },
        owner: {
          type: "string",
          description:
            "user = 人和模型约定的验收(模型改不动它);model = 你自己拆的(默认)",
        },
        delta: {
          type: "array",
          items: { type: "string" },
          description:
            "预期变化。**\"方向:路径\"**,如 [\"M:src/a.py\", \"A:src/b.py\"]。"
            + "实际改动必须**精确等于**它 —— 少了是漏做,多了是预期外的改动。",
        },
        delta_source: {
          type: "string",
          description:
            "before-work(默认)= 动手前声明的,真的能拦住方向性错误;"
            + "at-commit = 提交时照着 git status 抄的,只能拦住\"忘了说\"。",
        },
        ...PROJECT_PARAM,
      },
      output: { schema: OUTPUT, render: (_a, v) => [{ type: "text", text: renderText(v) }] },
      async execute(args, exec) {
        const dir = projectOf(exec, args);
        const r = plan(dir, normalize({
          id: args.id,
          expect: args.expect,
          base: args.base,
          parent: args.parent ?? null,
          owner: args.owner ?? "model",
          delta: parseDelta(args.delta ?? []),
          delta_source: args.delta_source ?? null,
          verify: args.verify ?? null,
        }), { asUser: false });

        if (!r.ok) {
          return { ok: false, summary: "plan 不通过", lines: brief(r.problems) };
        }
        const n = r.node;
        return {
          ok: true,
          summary: `${r.rewrite ? "改写" : "声明"}了 ${n.id}`,
          lines: [
            `  expect  ${n.expect}`,
            `  base    ${String(n.base).slice(0, 8)}`,
            `  Δ       ${n.delta.length
              ? n.delta.map((d) => `${d.code} ${d.path}`).join("  ")
              : "(空 —— 没有任何东西防止意外改动)"}`,
            `  P       ${n.verify}`,
          ],
        };
      },
    }),
  );

  // ---------------------------------------------------------- 2. status
  ctx.tools.register(
    defineTool({
      name: "node_status",
      description:
        "看这个节点:相对 base 改了什么,**和 Δ 比差在哪**。**不跑 P** —— "
        + "和 git status 一样便宜,随时可以调。\n"
        + "\n"
        + "它同时服务三件事:**写 Δ、自查、理解为什么没过**。输出直接对着 Δ 的形状:\n"
        + "  ✓ 声明了,也确实发生了\n"
        + "  ✗ 声明了但没发生(漏做)/ 方向不对(该删的改了)\n"
        + "  + **多出来的 —— 预期外的改动**  <- 这条最重要,你自己看不见它\n"
        + "\n"
        + "想提交之前先跑它。",
      parameters: {
        id: { type: "string", required: true, description: "节点 id" },
        ...PROJECT_PARAM,
      },
      output: { schema: OUTPUT, render: (_a, v) => [{ type: "text", text: renderText(v) }] },
      async execute(args, exec) {
        const dir = projectOf(exec, args);
        const r = renderStatus(dir, args.id);
        return {
          ok: r.ok,
          summary: r.ok ? `status ${args.id}` : `status ${args.id} 出错`,
          lines: r.lines,
        };
      },
    }),
  );

  // ---------------------------------------------------------- 3. commit
  ctx.tools.register(
    defineTool({
      name: "node_commit",
      description:
        "**提交即门禁**:Δ + P + 根 P,全过才产生一个版本(commit)。**不过就不提交。**\n"
        + "\n"
        + "顺序:先固定工作区的树 Y -> 在 Y 上跑 P -> 过了才用 commit-tree 精确提交 Y。\n"
        + "所以 commit 的内容**就是**被验过的那个内容,一个字节都不差 —— "
        + "验证程序留下的临时产物进不去。\n"
        + "\n"
        + "三种结果:ok(确实满足)/ fail(不满足,附一条**要求**,你照着修)/ "
        + "unknown(**不知道** —— 观测受限,**不算通过**)。\n"
        + "\n"
        + "**合并也是一次提交**:你先 `git merge --no-commit <父们>` 并自己解决冲突,"
        + "然后调它。它会查:结果是所有父的后代、每个父的 Δ 在合并后仍然成立"
        + "(防\"解决冲突时把另一个分支的成果整个撤销掉\")、P 在结果上通过。\n"
        + "\n"
        + "达成之后门禁**冻结** —— 要变就起一个新节点。",
      parameters: {
        id: { type: "string", required: true, description: "节点 id" },
        timeout: {
          type: "number",
          description: "P 的超时(毫秒),默认 120000",
        },
        ...PROJECT_PARAM,
      },
      output: { schema: OUTPUT, render: (_a, v) => [{ type: "text", text: renderText(v) }] },
      async execute(args, exec) {
        const dir = projectOf(exec, args);
        const r = commit(dir, args.id, { timeout: Number(args.timeout ?? 120_000) });

        if (!r.ok) {
          return {
            ok: false,
            summary: `${args.id} **没有提交** —— 门禁没过`,
            lines: brief(r.problems),
          };
        }
        return {
          ok: true,
          summary: `● ${args.id} 达成 —— 证据 ${String(r.result).slice(0, 8)}`,
          lines: [
            `  验过的树 ${String(r.tree).slice(0, 8)}(和 commit 的内容一个字节都不差)`,
            ...(r.weak_verify === true
              ? ["  ⚠ 这条 P 在基线时就通过 —— 它区分不了你做没做"] : []),
            ...(r.notes ?? []),
          ],
        };
      },
    }),
  );

  // ---------------------------------------------------------- 4. abandon
  ctx.tools.register(
    defineTool({
      name: "node_abandon",
      description:
        "把一个**声明了但没做**的任务从图里移除。\n"
        + "\n"
        + "为什么必须有:plan 把意图记下来了,人看得见它;声明了不做,"
        + "那条记录就必须能被移除 —— 否则图里永远挂着一个待办,"
        + "而图看起来像还在做这件事。\n"
        + "\n"
        + "**它只做一件事:从图里移除声明。**\n"
        + "\"把工作区撤回去\"不是它的职责 —— 那是 `git reset --hard <base>`,你自己有 bash。\n"
        + "\n"
        + "已经达成的节点不能放弃(历史不改写)。要改,起一个新节点。",
      parameters: {
        id: { type: "string", required: true, description: "节点 id" },
        reason: { type: "string", description: "为什么放弃(会记进账本)" },
        ...PROJECT_PARAM,
      },
      output: { schema: OUTPUT, render: (_a, v) => [{ type: "text", text: renderText(v) }] },
      async execute(args, exec) {
        const dir = projectOf(exec, args);
        const r = abandon(dir, args.id, args.reason ?? "");
        if (!r.ok) return { ok: false, summary: "abandon 不通过", lines: brief(r.problems) };
        return {
          ok: true,
          summary: `已放弃 ${args.id} —— 它不在图里了`,
          lines: args.reason ? [`  理由: ${args.reason}`] : [],
        };
      },
    }),
  );
}
