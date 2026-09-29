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

import { plan, commit, abandon, normalize, propose, approve } from "../lib/nodes.mjs";
import { parseDelta } from "../lib/delta.mjs";
import { renderStatus } from "../lib/view.mjs";
import { getNode } from "../lib/store.mjs";
import { requiredAuthority } from "../lib/cap.mjs";

/** 插件的 Cordis 名称。 */
export const name = "butler-git-tools";

/**
 * Cordis 依赖声明 —— 必须声明,否则 ctx.tools 取不到。
 *
 * Cordis 的 ctx 是 Proxy:没在 inject 里声明的服务属性,读取时**直接抛**
 * `cannot get property "X" without inject`。漏一个,整棵插件树起不来。
 */
export const inject = ["tools", "approval", "agents", "subagents"];

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
      "工作目录(默认 = 会话 cwd)。**图在它的 .bg/ 下。**\n"
      + "**当你要操作的项目不是你当前所在的目录时,必须显式给这个参数** —— "
      + "否则工具会去找会话 cwd 的 .bg/,看不见你在别处声明的节点。\n"
      + "\n"
      + "**`git worktree` 的场合尤其注意(会静默出事)。**\n"
      + "想并行干活时,给每个子 agent 开一个 worktree 是合适的做法 —— "
      + "那是 git 的能力,用 `git worktree add` 就行,这个工具不掺和。\n"
      + "但在 worktree 里调本工具时,**`project` 必须指向主工作区**\n"
      + "(图在主工作区的 `.bg/` 里,不在 worktree 里)。\n"
      + "忘了给的话,工具会**安静地**在 worktree 里新建一份图 —— "
      + "你的节点就不在主图里了,而且没有任何报错。\n"
      + "\n"
      + "反过来,父 agent **不需要**进子的 worktree:子报上来的是一个 "
      + "commit sha,而 commit 对象在所有 worktree 之间是共享的。",
  },
};

/**
 * 凭证(capability)—— **像目录权限,而且向下包含**。
 *
 *     持有 X 的凭证  ->  能改 X 的**所有后代**
 *     改 X 自己      ->  需要 parent(X) 的凭证  <- 这就是"向创建者提权"
 *     根节点         ->  没有父,只能由人签发
 *
 * 所以你拿到一个节点的凭证,就在它下面任意控制;但要改那个节点**本身**,
 * 得找创建它的那个(它的父)拿凭证。
 *
 * ## 为什么是凭证,不是 agent id
 *
 * 工具拿得到 `exec.agent.id`,但它不该被当成认证依据 ——
 * 一个 subagent 报上来的身份,工具核验不了。拿它做权限,
 * 等于把一道门建在自己都验证不了的东西上。
 *
 * 凭证绕开这件事:**谁拿出凭证谁有权**,不问你是谁。
 * 所以库里只存 hash,明文只在创建时给一次。
 */
const TOKEN_PARAM = {
  type: "string",
  description:
    "你持有的**凭证**。创建节点时工具会给你一个(只在那一刻显示一次,"
    + "之后查不到,自己收好)。\n"
    + "拿着 X 的凭证 -> 能在 X 下面建子节点、改 X 的所有后代。\n"
    + "要改 X **自己** -> 需要它父节点的凭证(向创建者提权)。",
};

/**
 * 这次调用是谁。**插件里永远不"直接"是 "user"** ——
 * 模型不能自己授权自己,那是人的权限。
 *
 * 但人可以**当场把它借给这一次调用**(见下面 `requestUserActor`):
 * 弹窗点"允许" -> 这次调用按 `{ kind:"user" }` 走。一次性,不落库。
 */
function actorOf(args) {
  const t = args?.token;
  if (typeof t === "string" && t) return { kind: "holder", token: t };
  return null;
}

/**
 * **向人要授权** —— 根节点那条特殊路径的入口。
 *
 * ## 为什么需要它
 *
 * `requiredAuthority` 里:根节点没有父,拿不到父的凭证,所以
 *
 *     改根 -> 需要 { kind:"user" }
 *
 * 而 `{ kind:"user" }` 原来**只在 CLI 存在**(`--as-user`)。
 * 于是模型想改根只有一条死路:请人开终端。这不该是唯一入口。
 *
 * 这里接上 DSH 自己的审批 seam(`ctx.approval`),让模型在会话里
 * **当场向人申请**,人在界面上点一下即可。
 *
 * ## 一次性,而且放行 ≠ 通过
 *
 * `allowed-once` 只对**这一次工具调用**有效 —— 不写库、不签发凭证、
 * 不改变以后任何一次调用。而且它只解决"你有没有权":
 * 之后的 Δ 比对和 P 照样要跑,过了才是绿。
 * **权限和门禁是两道独立的门。**
 *
 * ## fail-closed
 *
 * 没有应答者(无 UI / CI / `policy: never`)-> `unavailable` -> **拒绝**。
 * 缺了审批通道就是不给,绝不默认放行。
 */
async function requestUserActor({ ctx, exec, toolName, what, detail }) {
  // 取审批服务。**两种写法都要认**:
  //   ctx.approval   —— Cordis 的常规属性访问(inject 声明过就能读)
  //   ctx.get(...)   —— 部分宿主/测试用的取法
  // 而且**别假设它们一定在**:万一宿主没 compose 审批服务,或者 ctx
  // 形状变了,要走到下面的 fail-closed,而不是在这里崩 ——
  // 崩掉会让人以为"工具坏了",而真实情况是"没有授权通道,所以不给"。
  let approval = null;
  try {
    approval = ctx?.approval ?? null;
    if (!approval && typeof ctx?.get === "function") approval = ctx.get("approval") ?? null;
  } catch {
    approval = null;   // 严格 ctx 抛(没 inject)-> 当作没有通道
  }
  if (!approval || typeof approval.request !== "function") {
    return {
      ok: false,
      problems: [
        `${what} 需要**人**的授权,但这次调用没有可用的审批通道`
        + "(没有 ctx.approval)。",
        "  要么在带界面的会话里重试(会弹窗问人),"
        + "要么请人用 CLI 跑:`bg ... --as-user`(那条路一直有效)。",
      ],
    };
  }

  const reason = [
    `butler-git:${what}`,
    detail,
    "这是**根节点/人定的节点** —— 它的凭证只能由人签发,agent 拿不到。",
    "允许 = 仅这一次放行(仍要过 Δ + P);不会签发任何凭证。",
  ].filter(Boolean).join("\n");

  let outcome;
  try {
    outcome = await approval.request({
      agent: exec?.agent,
      toolName,
      callId: exec?.callId,
      reason,
      ...(exec?.signal ? { signal: exec.signal } : {}),
    });
  } catch (e) {
    // 空闲或在轮次之间调用会在这里抛(见官方实现)—— 如实报出来,不假装问过了。
    return {
      ok: false,
      problems: [
        `没能向人发起授权请求:${e?.message ?? e}`,
        "  (这个 seam 要求处于未结束的轮次里;空闲时它拒绝发起)",
        "  兜底:请人用 CLI 跑 `bg ... --as-user`。",
      ],
    };
  }

  switch (outcome) {
    case "allowed-once":
      return { ok: true, actor: { kind: "user" }, via: "approval" };
    case "rejected":
      return { ok: false, problems: ["**人拒绝了**这次授权 —— 操作没有执行。"] };
    case "cancelled":
      return { ok: false, problems: ["授权请求被**取消**了 —— 操作没有执行。"] };
    case "unavailable":
      return {
        ok: false,
        problems: [
          "**没有可用的审批应答者**(fail-closed)—— 操作没有执行。",
          "  兜底:请人用 CLI 跑 `bg ... --as-user`。",
        ],
      };
    default:
      // 不合词汇的返回值一律当"没批" —— 绝不默认放行。
      return { ok: false, problems: [`审批返回了无法识别的结果(${outcome})—— 按拒绝处理。`] };
  }
}

/**
 * **子 agent 向父 agent 请示** —— 达成要父批准。
 *
 * ## 为什么不用 ctx.approval(那是给人用的)
 *
 * `ctx.approval` 打通的是"向**人**要授权"(弹窗)。但子节点提交要的是
 * **父 agent** 的同意 —— 而父不是人,它是这个进程里另一个活的 agent。
 * 所以走的是另一条路:agent 之间发消息。
 *
 * ## 怎么找到父
 *
 *     session.header.parentSession    -> SessionId   (持久谱系)
 *     ctx.agents.get(那个 id)          -> Agent       (活的引用)
 *
 * 然后用 `isOwnedBy` 核验一次 —— 它是**运行时**的父子关系,宿主验证过,
 * 和"子 agent 自己报上来的身份"是两回事(那个不可信,所以凭证系统当初
 * 才退到"谁拿出钥匙谁有权")。
 *
 * ## 为什么是异步的
 *
 * `sendMessage` 只保证"送到了",**拿不到回复**。所以子 agent 不能等父
 * 批准 —— 它报完就结束,父之后异步处理。这正是"子调用 + 异步"那个选择
 * 的直接体现。
 *
 * 返回 `{ok:true, sent:true}` / `{ok:false, problems}`。
 */
async function askParent({ ctx, exec, summary }) {
  const mySession = exec?.agent?.session;
  const parentId = mySession?.header?.parentSession;

  if (!parentId) {
    return {
      ok: false,
      problems: [
        "这一步需要**父节点**批准,但这次调用没有父 agent"
        + "(这是顶层会话,没有可请示的对象)。",
        "  顶层会话要达成节点,走**人**的授权(会自动弹窗)。",
      ],
    };
  }

  let parentAgent = null;
  try {
    parentAgent = ctx.agents.get(parentId) ?? null;
  } catch (e) {
    return { ok: false, problems: [`查父 agent 失败:${e?.message ?? e}`] };
  }
  if (!parentAgent) {
    return {
      ok: false,
      problems: [
        `父会话 ${String(parentId).slice(0, 12)} 不在存活列表里 —— 可能已经结束。`,
        "  它不在了,就没人能批准;要么等它回来,要么由人处理。",
      ],
    };
  }

  // 运行时核验:**我确实挂在这个父下面**(不是随便报一个 id)。
  try {
    if (typeof ctx.agents.isOwnedBy === "function"
        && !ctx.agents.isOwnedBy(mySession.id, parentAgent)) {
      return {
        ok: false,
        problems: ["请求的父 agent 不是**我实际的**创建者 —— 拒绝请示(邻接不符)。"],
      };
    }
  } catch {
    // 核验接口不可用就不当成失败;下面的 sendMessage 自己还会校验邻接。
  }

  try {
    const { brandString } = await import("@deepseek-ai/dsh-tools");
    const idToSend = typeof brandString === "function" ? brandString(parentId) : parentId;
    await ctx.subagents.sendMessage(exec.agent, idToSend, [{ type: "text", text: summary }], {});
    return { ok: true, sent: true };
  } catch (e) {
    // sendMessage 会校验邻接关系 —— 非直接父会被它拒。
    return {
      ok: false,
      problems: [
        `通知父 agent 失败:${e?.message ?? e}`,
        "  (sendMessage 只允许发给**直接**父或直接子;邻接不符会被拒)",
      ],
    };
  }
}

/**
 * 决定这次调用用哪个 actor,必要时**先向人要授权**。
 *
 * 只在"真的需要 user、而手上又没有凭证"时才弹窗 ——
 * 拿得出凭证的调用**一次都不会打扰人**。
 */
async function resolveActor({ ctx, exec, toolName, node, args, what, detail, force = false }) {
  const direct = actorOf(args);
  if (direct) return { ok: true, actor: direct };

  // `force` = 调用方已经决定"这次就该问人",别在这里再判一次。
  //
  // 为什么需要它:原来这里只认 `requiredAuthority(node) === "user"`,
  // 于是**普通子节点**会直接返回 `actor: null`(交给 lib 去报"缺谁的凭证")。
  // 但"顶层会话没有父 agent"这种情况是**调用方**才知道的判断
  // (它要看 session.header),这里看不出来 —— 结果就是顶层提交普通节点
  // 时,外面决定问人、里面又把它挡回去,变成一个没人能解开的结。
  const need = requiredAuthority(node);
  if (!force && need !== "user") return { ok: true, actor: null };

  return requestUserActor({ ctx, exec, toolName, what, detail });
}

/**
 * 把一次调用的关键信息压成一行,给人看。
 * 弹窗的 reason 是纯文本,所以这里只放**判断所需的**东西。
 */
function describe(node) {
  const parts = [`节点 ${node.id}`];
  if (node.expect) parts.push(`目标「${String(node.expect).slice(0, 60)}」`);
  if (node.verify) parts.push(`P: ${node.verify}`);
  const d = node.delta?.length
    ? node.delta.map((x) => `${x.code}:${x.path}`).join(" ")
    : "(空)";
  parts.push(`Δ: ${d}`);
  return parts.join(" · ");
}

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
        + "权限(**像目录权限,而且向下包含**):\n"
        + "  持有 X 的凭证 -> 能在 X 下面建子节点、改 X 的**所有后代**\n"
        + "  改 X 自己     -> 需要它**父**的凭证 —— 这就是「向创建者提权」\n"
        + "  根节点        -> 没有父,只能由人签发(你没有,所以别试图建根)\n"
        + "  已达成        -> **冻结,任何凭证都改不动。** 要变就起一个新节点。\n"
        + "\n"
        + "创建时会返回一个 🔑 凭证 —— **它只显示这一次**,收好。\n"
        + "不给 token = 没有凭证:只能建人已经给了你父凭证的节点。",
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
            + "Δ 只管\"改的是不是这些文件\",没有 P 就没有任何东西说\"改对了\"。\n"
            + "\n"
            + "**P 的质量决定这个节点的绿有没有意义。** 机器只能判\"有没有 P\"、\n"
            + "\"是不是恒真\"(弱 P 会被标出来),判不了 P 够不够。所以这条靠你:\n"
            + "\n"
            + "  ✗ `true` / `test -f x.py`   —— 几乎恒真,验不了你做没做\n"
            + "  ✓ `grep -q v2 x.py`          —— 验**你这次那个改动**,不只是文件在\n"
            + "  ✓ `node test/plugin.mjs`     —— 跑一套真的验收(本仓库自己的用法)\n"
            + "  ✓ `npm test && node test/x`  —— 改动动到核心时,跑全量\n"
            + "\n"
            + "拿不准就问自己:**如果我把这次改动整个撤销,P 还会通过吗?**\n"
            + "会通过的话,它就不是 P。",
        },
        verify_path: {
          type: "string",
          description:
            "**P 的程序文件在哪**(可选)。P 是一条命令,不是路径 —— "
            + "`grep -q ok root.txt` 里哪个算\"验证程序\"判不出来。"
            + "想让可视化显示得准就在这里写明脚本文件,如 \"test/plugin.mjs\"。\n"
            + "不给时工具会**保守推断**(只认 `node <文件>` / `bash <文件>` / `./<文件>` "
            + "这类明确形态),推不出来就如实说\"没有程序文件\",**不猜**。",
        },
        parent: {
          type: "string",
          description: "父节点 id。不给 = 这是**根**节点(一个任务的起点;它的 P 只在自己提交时跑,不压别人)",
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
        token: TOKEN_PARAM,
        ...PROJECT_PARAM,
      },
      output: { schema: OUTPUT, render: (_a, v) => [{ type: "text", text: renderText(v) }] },
      async execute(args, exec) {
        const dir = projectOf(exec, args);

        // **新建根**和**改写已存在的节点**都可能需要人 ——
        //   新建根:没有父 -> 没有父的凭证可给 -> 要人
        //   改写:如果目标是根 / owner=user -> 要人
        // 别的情况(在某个节点下建子节点)走 parent 的凭证,一次都不打扰人。
        let actor = actorOf(args);
        if (!actor) {
          const existing = getNode(dir, args.id);
          // 目标不存在 + 没有 parent = 在新建一个根
          const creatingRoot = !existing && !args.parent;
          const target = existing ?? (creatingRoot ? { id: args.id, parent: null, owner: args.owner ?? "model", expect: args.expect, verify: args.verify, delta: parseDelta(args.delta ?? []) } : null);

          if (target && requiredAuthority(target) === "user") {
            const resolved = await requestUserActor({
              ctx, exec, toolName: "node_plan",
              what: creatingRoot ? `**创建根节点** ${args.id}` : `改写节点 ${existing.id}`,
              detail: describe(target),
            });
            if (!resolved.ok) {
              return { ok: false, summary: "需要人的授权,但没有拿到", lines: brief(resolved.problems) };
            }
            actor = resolved.actor;
          }
          // 其他情况 actor 仍是 null —— 由 lib 去报"需要谁的凭证"。
        }

        const r = plan(dir, normalize({
          id: args.id,
          expect: args.expect,
          base: args.base,
          parent: args.parent ?? null,
          owner: args.owner ?? "model",
          delta: parseDelta(args.delta ?? []),
          delta_source: args.delta_source ?? null,
          verify: args.verify ?? null,
          verify_path: args.verify_path ?? null,
        }), { actor });

        if (!r.ok) {
          return { ok: false, summary: "plan 不通过", lines: brief(r.problems) };
        }
        const n = r.node;
        const lines = [
          `  expect  ${n.expect}`,
          `  base    ${String(n.base).slice(0, 8)}`,
          `  Δ       ${n.delta.length
            ? n.delta.map((d) => `${d.code} ${d.path}`).join("  ")
            : "(空 —— 没有任何东西防止意外改动)"}`,
          `  P       ${n.verify}`,
        ];
        // **凭证明文只出现这一次。** 之后没有任何办法查回它。
        if (r.token) {
          lines.push("");
          lines.push(`  🔑 凭证  ${r.token}`);
          lines.push("     **收好它 —— 只显示这一次。**");
          lines.push(`     拿着它:能在 ${n.id} 下面建子节点、改它的所有后代`);
          lines.push(`     改 ${n.id} 自己:要它父节点的凭证(向创建者提权)`);
        }
        return {
          ok: true,
          summary: `${r.rewrite ? "改写" : "声明"}了 ${n.id}`,
          lines,
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
        token: TOKEN_PARAM,
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
        "**提交即门禁**:Δ + P,全过才产生一个版本(commit)。**不过就不提交。**\n"
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
        token: TOKEN_PARAM,
        ...PROJECT_PARAM,
      },
      output: { schema: OUTPUT, render: (_a, v) => [{ type: "text", text: renderText(v) }] },
      async execute(args, exec) {
        const dir = projectOf(exec, args);
        const node = getNode(dir, args.id);
        if (!node) {
          return { ok: false, summary: `${args.id} 不存在`, lines: [] };
        }
        const timeout = Number(args.timeout ?? 120_000);

        // ---------- 有凭证:直接提交(父 agent / 有权者) ----------
        const direct = actorOf(args);
        if (direct) {
          const r = commit(dir, args.id, { timeout, actor: direct });
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
        }

        // ---------- 没凭证:**先跑门禁**,再决定找谁 ----------
        //
        // 顺序是刻意的:**先验,再打扰**。
        // 一个连 Δ 都没过的提交不该去问任何人 —— 那只会浪费对方的注意力,
        // 而且对方拿到的信息也不足以判断(它看到的是"没过"的东西)。
        //
        // 门禁过了之后再分岔:
        //   · 目标需要**人**(根/owner=user) -> 弹窗(已有)
        //   · 有父 agent                     -> 请示父(异步)
        const g = propose(dir, args.id, { timeout });
        if (!g.ok) {
          return {
            ok: false,
            summary: `${args.id} **没有提交** —— 门禁没过`,
            lines: brief(g.problems),
          };
        }

        // ---------- 门禁过了,决定问谁要授权 ----------
        //
        // 三种情况,而且**优先级是刻意的**:
        //
        //     ① 目标需要人(根 / owner=user)  -> 问人(弹窗)
        //     ② 我有父 agent                  -> 问父(异步请示)
        //     ③ 我是顶层(没有父 agent)         -> 也问人(弹窗)
        //
        // 第 ③ 条是**降级**,不是绕过:顶层会话(比如直接跟人对话的那个
        // agent)本来就不该卡死 —— 它上面没有人可以替它批准,而它又是
        // 人在直接指挥的。让它走弹窗,等于"人当场授权",和 ① 是同一件事。
        //
        // 缺了 ③ 的话,顶层 agent 提交任何普通节点都会撞上"没有可请示的
        // 父"而卡住 —— 一个没人能解开的死结。
        const need = requiredAuthority(node);
        const parentId = exec?.agent?.session?.header?.parentSession ?? null;
        const askHuman = (need === "user") || !parentId;

        if (askHuman) {
          const why = need === "user"
            ? `提交(达成)节点 ${node.id}`
            : `提交(达成)节点 ${node.id}(顶层会话,没有父 agent 可请示)`;
          const resolved = await resolveActor({
            ctx, exec, toolName: "node_commit", node, args,
            what: why,
            detail: describe(node),
            force: true,   // 调用方已经判定"该问人"(见上面 askHuman)
          });
          if (!resolved.ok) {
            return { ok: false, summary: `${args.id} **没有提交** —— 没拿到人的授权`, lines: brief(resolved.problems) };
          }
          const r = commit(dir, args.id, { timeout, actor: resolved.actor });
          if (!r.ok) {
            return { ok: false, summary: `${args.id} **没有提交** —— 门禁没过`, lines: brief(r.problems) };
          }
          return {
            ok: true,
            summary: `● ${args.id} 达成 —— 证据 ${String(r.result).slice(0, 8)}`,
            lines: [
              `  验过的树 ${String(r.tree).slice(0, 8)}(和 commit 的内容一个字节都不差)`,
              "  (经由**人**的授权 —— allowed-once,仅这一次)",
            ],
          };
        }

        // 请示父 agent。**不落地** —— 达成是父的事(验收权不下放)。
        const asked = await askParent({
          ctx,
          exec,
          summary: `${g.summary}\n\n`
            + `请批准:node_approve(${args.id}, candidate: "${g.candidate}")\n`
            + "候选 commit 已经建好了(**没挂到 HEAD 上**),父批准时才落地。\n"
            + "父不需要访问我的工作区 —— 需要的一切都在那个 commit 里。",
        });
        if (!asked.ok) {
          return {
            ok: false,
            summary: `${args.id} 门禁已过,但**没能请示父节点**`,
            lines: brief(asked.problems),
          };
        }
        return {
          ok: true,
          summary: `${args.id} 门禁已过 —— 已请示父节点批准(**尚未落地**)`,
          lines: [
            `  验过的树 ${String(g.treeY).slice(0, 8)}`,
            "  达成要父节点调 node_approve —— 它会在批准时重跑门禁。",
            ...(g.weak === true ? ["  ⚠ 这条 P 在基线时就通过 —— 它区分不了你做没做"] : []),
          ],
        };
      },
    }),
  );

  // ---------------------------------------------------------- 4. approve
  ctx.tools.register(
    defineTool({
      name: "node_approve",
      description:
        "**批准一个子节点达成** —— 父 agent 的动作。\n"
        + "\n"
        + "流程:子 agent 干完活调 node_commit,门禁过了会**请示你**;\n"
        + "你看了它报上来的(节点、Δ、P、验过的树)觉得可以,就调它落地。\n"
        + "\n"
        + "**它会重跑一遍门禁** —— 不采信子报上来的结果。原因两条:\n"
        + "  ① 没有持久化的待批准记录,没有可信的中间结果可查\n"
        + "  ② 子报上来的东西没有理由被当成事实(它可能报个假的)\n"
        + "所以 P 会跑两遍(子一次、你一次)。串行场景下工作区没变,\n"
        + "结果必然一致;**要是变了,那正是该拒绝的时候** ——\n"
        + "说明你批准的那个世界已经不一样了。\n"
        + "\n"
        + "权限:需要**该节点父节点**的凭证(和 commit 同一道门)。\n"
        + "父 agent 天然持有它;拿不出就批不了。",
      parameters: {
        id: { type: "string", required: true, description: "要批准达成的节点 id" },
        candidate: {
          type: "string",
          description:
            "子 agent 报上来的**候选 commit sha**。给了它就批准**那个对象** —— "
            + "不重跑门禁,而且父不需要访问子的工作区。\n"
            + "不给则退回旧路:父在自己的工作区里重跑门禁再提交"
            + "(只在父子看同一个工作区时才等价)。\n"
            + "无论给不给,都会校验:它是不是 commit、它的父是不是当前 HEAD、"
            + "它自称验过的树和它实际的内容对不对得上。",
        },
        timeout: { type: "number", description: "P 的超时(毫秒),默认 120000" },
        token: TOKEN_PARAM,
        ...PROJECT_PARAM,
      },
      output: { schema: OUTPUT, render: (_a, v) => [{ type: "text", text: renderText(v) }] },
      async execute(args, exec) {
        const dir = projectOf(exec, args);
        const r = approve(dir, args.id, {
          timeout: Number(args.timeout ?? 120_000),
          actor: actorOf(args),
          candidate: args.candidate ?? null,
        });
        if (!r.ok) {
          return {
            ok: false,
            summary: `没有批准 ${args.id} —— 门禁没过或权限不够`,
            lines: brief(r.problems),
          };
        }
        return {
          ok: true,
          summary: `● 批准了 ${args.id} —— 证据 ${String(r.result).slice(0, 8)}`,
          lines: [
            `  验过的树 ${String(r.tree).slice(0, 8)}(你批准时的重跑结果)`,
            ...(r.weak_verify === true
              ? ["  ⚠ 这条 P 在基线时就通过 —— 它区分不了你做没做"] : []),
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
        token: TOKEN_PARAM,
        ...PROJECT_PARAM,
      },
      output: { schema: OUTPUT, render: (_a, v) => [{ type: "text", text: renderText(v) }] },
      async execute(args, exec) {
        const dir = projectOf(exec, args);
        const node = getNode(dir, args.id);
        if (!node) {
          return { ok: false, summary: `${args.id} 不存在`, lines: [] };
        }

        // 放弃也是一种修改(它改图)—— 目标是根时同样向人要。
        let actor = actorOf(args);
        if (!actor && requiredAuthority(node) === "user") {
          const resolved = await resolveActor({
            ctx, exec, toolName: "node_abandon", node, args,
            what: `放弃节点 ${node.id}`,
            detail: describe(node),
          });
          if (!resolved.ok) {
            return { ok: false, summary: `${args.id} 没有放弃 —— 没拿到人的授权`, lines: brief(resolved.problems) };
          }
          actor = resolved.actor;
        }

        const r = abandon(dir, args.id, args.reason ?? "", { actor });
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
