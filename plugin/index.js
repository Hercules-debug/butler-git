/**
 * dsh-butler-git —— git 原生的节点门禁,做成 DSH 工具。
 *
 * ## 三个概念
 *
 *     节点   一个步骤。它带一份**门禁**。
 *     门禁   预期文件系统 + 进程情况 + 验证程序。**三条全过才算"现在过"。**
 *     两盏灯  第一盏"通过过"(历史,不可变) 第二盏"现在过不过"(当下,参考)
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
 */

import { defineTool } from "@deepseek-ai/dsh-tools";

import { checkContract } from "../lib/contract.mjs";
import { declare, accept, normalize } from "../lib/nodes.mjs";
import { render, renderDetail, healthLine } from "../lib/view.mjs";

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
 * 插件拿到的 ctx 没有 agent scope(所以是全局注册),
 * 但 execute 里能拿到 exec,那里有会话的 cwd。
 */
function projectOf(exec) {
  return exec?.agent?.session?.header?.cwd ?? process.cwd();
}

// ---------------------------------------------------------------- 参数表

/**
 * 门禁的紧凑参数。**file_contains 是两段,只切第一个冒号** ——
 * 所以 pattern 里含冒号(URL、时间戳)不会被切坏。
 */
const GATE_PARAMS = {
  stepId: {
    type: "string",
    required: true,
    description: "节点 id,自己起一个,如 n-001。同一个 id 再声明 = 改这份门禁(改有前提,见下)",
  },
  expectation: {
    type: "string",
    required: true,
    description: "一句话说清这一步要达成什么。这是执行者判断'怎么做才合理'的依据",
  },
  parent: {
    type: "string",
    description: "父节点 id。给了就加入那个任务;不给就是新任务",
  },
  owner: {
    type: "string",
    description:
      "user = 人和模型约定的验收(模型改不动它); model = 你自己拆的(默认,可以自己改)",
  },
  allow: {
    type: "array",
    items: { type: "string" },
    description: "可写边界(工作区相对路径通配),如 ['src/**']",
  },
  fsExists: {
    type: "array",
    items: { type: "string" },
    description: "【预期文件系统】这些路径必须**存在**。直接 stat,免疫 .gitignore",
  },
  fsAbsent: {
    type: "array",
    items: { type: "string" },
    description: "【预期文件系统】这些路径必须**不存在**(别留下垃圾)。单靠它不构成门禁",
  },
  fsContains: {
    type: "array",
    items: { type: "string" },
    description: "【预期文件系统】'路径:字面串' —— 该文件必须包含这串字。只切第一个冒号",
  },
  fsNotContains: {
    type: "array",
    items: { type: "string" },
    description: "【预期文件系统】'路径:字面串' —— 该文件必须**不含**这串字",
  },
  fsTree: {
    type: "string",
    description:
      "【预期文件系统】整个世界必须等于这个 git 树哈希(绝对判据)。"
      + "注意:.gitignore 的路径它看不见,所以编译产物那类别用它,用 fsExists",
  },
  procPresent: {
    type: "array",
    items: { type: "string" },
    description: "【进程情况】这些进程应当**在跑**",
  },
  procAbsent: {
    type: "array",
    items: { type: "string" },
    description: "【进程情况】这些进程应当**已关闭**。单靠它不构成门禁",
  },
  verify: {
    type: "string",
    description:
      "【验证程序】一条命令,退出码 0 才算过。这是门禁里最强的一半 —— "
      + "它验行为,前面那些只验痕迹。**它必须在基线时跑不过**,否则它等于没验",
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

function renderText(v) {
  return [v.summary, ...(v.lines ?? [])].join("\n");
}

/** 把工具参数拼成一份契约。和 CLI 的紧凑形式**同一套语义**。 */
function contractFromArgs(args) {
  const split = (s) => {
    const i = s.indexOf(":");
    return i < 0
      ? { path: s, pattern: "" }
      : { path: s.slice(0, i), pattern: s.slice(i + 1) };
  };

  const paths = [
    ...(args.fsExists ?? []).map((path) => ({ kind: "exists", path })),
    ...(args.fsAbsent ?? []).map((path) => ({ kind: "absent", path })),
    ...(args.fsContains ?? []).map((s) => ({ kind: "contains", ...split(s) })),
    ...(args.fsNotContains ?? []).map((s) => ({ kind: "not_contains", ...split(s) })),
  ];

  return normalize({
    id: args.stepId,
    expect: args.expectation,
    parent: args.parent ?? null,
    owner: args.owner ?? "model",
    allow: args.allow ?? [],
    fs: { paths, tree: args.fsTree ?? null },
    proc: {
      present: args.procPresent ?? [],
      absent: args.procAbsent ?? [],
    },
    verify: args.verify ?? null,
  });
}

function brief(problems, notes) {
  return [
    ...(problems ?? []).map((p) => `  ✗ ${p}`),
    ...(notes ?? []).map((n) => `  (说明) ${n}`),
  ];
}

// ------------------------------------------------------------------ 工具

export function apply(ctx) {
  // ---------------------------------------------------------- 自检
  ctx.tools.register(
    defineTool({
      name: "node_check",
      description:
        "写门禁**之前**自检:这份门禁够格吗。不通过就返回原因,改完再跑。\n"
        + "\n"
        + "一个门禁 = 三部分,三部分都可以为空,但不能全空:\n"
        + "  fs      预期文件系统   fsExists / fsAbsent / fsContains / fsNotContains / fsTree\n"
        + "  proc    进程情况       procPresent / procAbsent\n"
        + "  verify  验证程序       一条命令,退出码 0 才算过\n"
        + "\n"
        + "它会挡三件事:\n"
        + "  · **整个门禁在基线时就成立** —— 那它在开工前就是绿的,等于没有门禁\n"
        + "    (最典型:`verify: \"true\"` —— 永远退出 0,什么都没验)\n"
        + "  · 自相矛盾(present 和 absent 同一个名字;既要求存在又要求不存在)\n"
        + "  · 只有'不许留下什么'这类安全网,没有任何会失败的东西\n"
        + "\n"
        + "注意 check 只看门禁本身,**不看世界**。想知道某个节点现在过不过,用 node_accept。",
      parameters: GATE_PARAMS,
      output: { schema: OUTPUT, render: (_a, v) => [{ type: "text", text: renderText(v) }] },
      async execute(args, exec) {
        const dir = projectOf(exec);
        const c = contractFromArgs(args);
        const r = checkContract(dir, c);
        return {
          ok: r.ok,
          summary: r.ok ? `check: 通过,可以 declare` : "check 不通过",
          lines: brief(r.problems, r.notes),
        };
      },
    }),
  );

  // ---------------------------------------------------------- 声明
  ctx.tools.register(
    defineTool({
      name: "node_declare",
      description:
        "把一个节点连同它的门禁写进图。它会**再检查一遍** —— 所以先让 node_check 通过。\n"
        + "\n"
        + "两道门(会在改的时候拦你):\n"
        + "\n"
        + "  1. **通过过的节点,门禁冻结。** 要变,起一个**新节点**把改动做出来 ——\n"
        + "     历史不改写,旧节点保持'通过过'。这不是限制,是因为绿是历史事实:\n"
        + "     回头改门禁 = 让当时的验收变成一句没法核对的话。\n"
        + "  2. **owner=user 且已经有一份门禁** -> 你改不动,要人授权。\n"
        + "     那是人和模型约定的验收,不是你自己拆的手段。",
      parameters: GATE_PARAMS,
      output: { schema: OUTPUT, render: (_a, v) => [{ type: "text", text: renderText(v) }] },
      async execute(args, exec) {
        const dir = projectOf(exec);
        const c = contractFromArgs(args);
        // **绝不传 asUser。** 模型不能自己授权自己改人定的验收。
        const r = declare(dir, c, { asUser: false });
        return {
          ok: r.ok,
          summary: r.ok
            ? `declare: ${r.rewrite ? "改写" : "新增"}了 ${r.node.id}`
            : "declare 不通过",
          lines: brief(r.problems, r.notes),
        };
      },
    }),
  );

  // ---------------------------------------------------------- 验收
  ctx.tools.register(
    defineTool({
      name: "node_accept",
      description:
        "**验收**:跑完整门禁(含验证程序)。三条全过 -> 点亮第一盏灯「通过过」。\n"
        + "\n"
        + "这是唯一能点亮第一盏灯的动作。它不说话、只看事实:\n"
        + "  - 有断言不过 -> 逐条告诉你 **要求** 做什么\n"
        + "  - 有东西**看不见**(比如沙箱读不到进程命令行)-> 报「不知道」,\n"
        + "    **不算通过**,也不当成不通过\n"
        + "\n"
        + "做完一步就跑它,直到通过再报告 —— 不要等人来告诉你没过。",
      parameters: {
        stepId: { type: "string", required: true, description: "要验收的节点 id" },
        timeout: { type: "number", description: "验证程序的超时(毫秒),默认 120000" },
      },
      output: { schema: OUTPUT, render: (_a, v) => [{ type: "text", text: renderText(v) }] },
      async execute(args, exec) {
        const dir = projectOf(exec);
        const r = accept(dir, args.stepId, { timeout: args.timeout ?? 120_000 });
        if (r.ok) {
          return {
            ok: true,
            summary: `[验收 ${args.stepId}] 通过 —— 第一盏灯已点亮`,
            lines: [`  证据锚  树=${(r.evidence.tree ?? "(拿不到)").slice(0, 12)}  时间=${r.evidence.ts}`],
          };
        }
        return {
          ok: false,
          summary: `[验收 ${args.stepId}] 不通过`,
          lines: (r.problems ?? []).map((p) => `  ✗ ${p}`),
        };
      },
    }),
  );

  // ---------------------------------------------------------- 看灯
  ctx.tools.register(
    defineTool({
      name: "node_tree",
      description:
        "看整棵树。每个节点**两盏灯**:\n"
        + "\n"
        + "    第一盏  通过过没有   历史,不可变,读账本\n"
        + "    第二盏  现在过不过   当下,跑检查,只是参考\n"
        + "\n"
        + "  ●●  通过过,现在也对\n"
        + "  ●○  通过过,但现在已经坏了   <- **回归**,最该看一眼的\n"
        + "  ○●  没通过过,但现在能过\n"
        + "  ○○  没通过过,现在也不过\n"
        + "  ·   第二盏没算(它是参考,默认不跑命令)\n"
        + "  –   没有门禁\n"
        + "\n"
        + "`live=true` 会连验证程序一起跑,给出完整的第二盏灯 ——\n"
        + "东西坏掉的时候,它能**指出是哪个节点坏的**,不用你猜。",
      parameters: {
        live: { type: "boolean", description: "连验证程序一起跑(贵,但完整)" },
        detail: { type: "string", description: "展开某个节点的细节(门禁逐条 + 证据锚)" },
      },
      output: { schema: OUTPUT, render: (_a, v) => [{ type: "text", text: renderText(v) }] },
      async execute(args, exec) {
        const dir = projectOf(exec);
        const mode = args.live ? "full" : "cheap";
        if (args.detail) {
          return {
            ok: true,
            summary: renderDetail(dir, args.detail, { light2: mode }),
            lines: [],
          };
        }
        return { ok: true, summary: render(dir, { light2: mode }), lines: [] };
      },
    }),
  );

  // 心跳(给人看的,也顺手给模型一个"现在什么状态")。
  ctx.tools.register(
    defineTool({
      name: "node_health",
      description: "心跳一行:有多少节点还没通过过。**只报第一盏灯**(便宜、永远算得起)。",
      parameters: {},
      output: { schema: OUTPUT, render: (_a, v) => [{ type: "text", text: renderText(v) }] },
      async execute(_args, exec) {
        return { ok: true, summary: healthLine(projectOf(exec)), lines: [] };
      },
    }),
  );
}
