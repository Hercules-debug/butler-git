/**
 * gate.mjs —— 门禁的**求值**。
 *
 * ## 一次提交 = 一次门禁
 *
 *     node_commit(n):
 *       1. 固定工作区:算它的树 Y
 *       2. 查 Δ:diff(base, Y) 精确匹配 n.delta(为空的场合跳过)
 *       3. 跑 P:在 Y 上跑 n.verify
 *       全部通过  ->  commit,trailer 记下证据
 *       任何一条不过 -> **不提交**,逐条给出"要求"
 *
 * ## 顺序很重要
 *
 * 必须**先固定树、再跑 P**,否则:
 *
 *     跑 P -> 通过
 *     [这中间工作区又变了]
 *     commit -> 提交的是另一个状态,而 trailer 说它通过了
 *
 * 所以这个模块**只负责求值**,跑完把 Y 交回去 —— 由 nodes.mjs 用
 * `commit-tree` 精确提交 Y(见 git.mjs 里那段)。
 *
 * ## 三种结果,不是两种
 *
 *     ok        确实满足
 *     fail      确实不满足(附一条"要求",模型能照着修)
 *     unknown   **不知道** —— 观测能力受限
 *
 * `unknown` **不算通过**。它必须能被表达出来,否则"看不见"会被读成"没问题"。
 * 这是这个文件里最要紧的一条纪律。
 */

import { spawnSync } from "node:child_process";
import { baselinePasses } from "./git.mjs";
import { compare } from "./delta.mjs";

/** P 的默认超时。跑不完就是不过 —— 不给无限时间。 */
export const DEFAULT_TIMEOUT = 120_000;

/**
 * 跑验证程序。
 *
 * 退出码 0 才算过。**超时也是一种失败**,而且要说清楚是超时 ——
 * 否则模型会以为"命令返回了非零",去查一个根本不存在的问题。
 */
export function runVerify(dir, cmd, { timeout = DEFAULT_TIMEOUT } = {}) {
  if (!cmd || !cmd.trim()) {
    return { status: "unknown", detail: "没有验证程序" };
  }

  let r;
  try {
    r = spawnSync(cmd, {
      shell: true,
      cwd: dir,
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    return { status: "unknown", detail: `跑不起来:${e.message}` };
  }

  if (r.error) {
    // 超时在 node 里以 error 的形式出现(带 ETIMEDOUT 或 killed 信号)
    const msg = String(r.error.message ?? "");
    const timedOut = r.error.code === "ETIMEDOUT"
      || msg.includes("ETIMEDOUT")
      || r.error.killed === true;
    return {
      status: timedOut ? "fail" : "unknown",
      detail: timedOut
        ? `超时(${Math.round(timeout / 1000)} 秒)—— P 没跑完,不算通过`
        : `跑不起来:${msg}(**不知道** —— 不算通过)`,
      timedOut: Boolean(timedOut),
    };
  }

  if (r.status === 0) return { status: "ok", output: (r.stdout ?? "").trim() };

  const tail = ((r.stdout ?? "") + (r.stderr ?? "")).trim().split("\n").slice(-5).join("\n");
  return {
    status: "fail",
    detail: `退出码 ${r.status}`,
    output: tail,
  };
}

/**
 * **弱 P 探测**:这条 P 在基线时就通过吗。
 *
 * 判据是"它区分不了你做没做":
 *
 *     P 在 base 上就过  ->  没做和做了都过  ->  ⚠ 验不了任何东西
 *     最典型:`verify: "true"`
 *
 * 机器只能判这一种"弱"。**P 够不够全判不了** —— 那是语义问题,
 * 属于 DESIGN.md 的已知边界。
 *
 * 返回:
 *   true   基线时就通过  ->  弱 P,要标出来
 *   false  真的门禁
 *   null   跑不了        ->  不知道,不假装查过
 */
export function probeWeakVerify(dir, cmd, base, { timeout = 60_000 } = {}) {
  if (!cmd || !cmd.trim()) return null;
  return baselinePasses(dir, cmd, { rev: base, timeout });
}

/**
 * 求一个节点的**全部**门禁。
 *
 * `mode`:
 *   "cheap" 只算 Δ(不跑 P)—— 给 node_status 用,和 git status 一样便宜
 *   "full"  Δ + P  —— 给 node_commit 用
 *
 * **没有"根门禁"这一层了。** 所有节点一视同仁:各自跑各自的 P。
 * 见下面 evaluateGate 末尾那段注释。
 *
 * **Y 由调用方先算好再传进来** —— 因为"先固定树、再跑 P"这个顺序,
 * 决定的是"后面能不能精确提交那个被验过的树"。求值本身不该重新算一遍。
 */
export function evaluateGate(dir, node, opts) {
  const {
    treeY = null,
    actualDiff = [],
    mode = "full",
    timeout = DEFAULT_TIMEOUT,
  } = opts;

  const items = [];

  // ---------------- 第 2 步:Δ ----------------
  const cmp = compare(node.delta, actualDiff);
  if (cmp.skipped) {
    items.push({
      kind: "delta",
      status: "pass",
      detail: "Δ 是空的(没有预测),跳过比对 —— **没有任何东西防止意外改动**",
      weak: true,
    });
    for (const e of cmp.extra) {
      items.push({
        kind: "delta",
        status: "pass",
        detail: `${e.code} ${e.path}(Δ 空,不受约束)`,
        demand: e.demand,
      });
    }
  } else {
    for (const m of cmp.missing) {
      items.push({
        kind: "delta",
        status: "fail",
        detail: `${m.code} ${m.path} 没发生`,
        demand: m.demand,
      });
    }
    for (const x of cmp.extra) {
      items.push({
        kind: "delta",
        status: "fail",
        detail: `+ ${x.code} ${x.path} 预期外`,
        demand: x.demand,
      });
    }
    for (const x of cmp.mismatch) {
      items.push({
        kind: "delta",
        status: "fail",
        detail: `${x.path} 方向不对(声明 ${x.declared},实际 ${x.actual})`,
        demand: x.demand,
      });
    }
    if (cmp.ok) {
      items.push({
        kind: "delta",
        status: "pass",
        detail: `Δ 精确匹配(${node.delta.length} 条)`,
      });
    }
  }

  if (mode === "cheap") {
    return {
      ok: items.every((i) => i.status !== "fail"),
      items,
      delta: cmp,
      treeY,
      ranVerify: false,
    };
  }

  // ---------------- 第 3 步:P ----------------
  const p = runVerify(dir, node.verify, { timeout });
  if (p.status === "ok") {
    items.push({ kind: "verify", status: "pass", detail: `P 通过:${node.verify}` });
  } else if (p.status === "fail") {
    items.push({
      kind: "verify",
      status: "fail",
      detail: `P 不通过:${node.verify}(${p.detail})`,
      demand: `让 "${node.verify}" 退出码为 0`,
      output: p.output,
    });
  } else {
    items.push({
      kind: "verify",
      status: "unknown",
      detail: `P 跑不了:${node.verify}(${p.detail})**不知道** —— 不算通过`,
    });
  }

  // ---------------- 没有第 4 步了 ----------------
  //
  // 原来这里有一层「根门禁」:**每个**子节点达成时,额外跑一遍**根节点的 P**。
  // 它建立在那条不变式上 ——"每一个绿的 commit 上,根门禁都是通过的"。
  //
  // **它被删掉了,因为那个模型是错的。**
  //
  // 正确的形状是:**所有节点一视同仁**,每个节点只跑自己的 P。
  //
  //     根节点    P = "整体可用"(如 node test/run.mjs && node test/plugin.mjs)
  //     子节点 n1 P = "n1 这件事做对了"
  //     子节点 n2 P = "n2 这件事做对了"
  //
  // 根 P 和 n1 的 P 是**同一种东西** —— 它不特殊,只是恰好验的是"整体"。
  // 它只在**根自己提交时**跑,不下来压每一个子节点。
  //
  // 原来的做法有两个问题:
  //   ① 它把"整体可用"变成了**每个子任务的义务**,而子任务只该对它
  //      自己那件事负责 —— 拿整体去卡一个局部改动,不是这套东西的哲学
  //   ② "根"这个概念被迫特殊化(取哪个根?多个根怎么办?),而实际上
  //      根本不需要"找根"这个动作
  //
  // 代价要说清:"整体可用"不再是自动保证的了。它变成**根的 P 的
  // 责任** —— 想要整体保证,就建一个有整体 P 的节点。这不是退化,
  // 是把那个决定权交回给声明者。

  const ok = items.every((i) => i.status === "pass");
  return {
    ok,
    items,
    delta: cmp,
    treeY,
    ranVerify: true,
  };
}
