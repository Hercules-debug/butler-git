/**
 * view.mjs —— 渲染。**只画,不算。**
 *
 * ## 展示的三条纪律(DESIGN.md「可见性是唯一的问责机制」)
 *
 *     ① P 的**原文**要看得见,不能只显示"通过"
 *     ② 弱 P 要标出来(P 在基线时就通过 -> 它区分不了你做没做)
 *     ③ Δ 为空要标出来(没有任何东西防止意外改动)
 *
 * 不拦,但不隐瞒。这是"模型自决"能站住的唯一方式 —— **自决不等于无痕**。
 */

import { allNodes, rootNode, droppedSet, isDropped } from "./store.mjs";
import { head, logRaw, isAncestor, workingTreeHash, treeOf } from "./git.mjs";
import { status, parseTrailers, inferVerifyPath } from "./nodes.mjs";

const pad = (s, n) => String(s).padEnd(n, " ");
const short = (s) => String(s ?? "").slice(0, 8);

/**
 * **派生**出来的显示状态(不存储,算出来的)。
 *
 *     todo + 工作区相对 base 无改动  ->  待办
 *     todo + 工作区相对 base 有改动  ->  进行中
 *     done                          ->  绿
 *
 * 进行中要"看工作区",所以调用方得给 treeY(算一次很便宜)。
 */
export function displayState(node, treeY = null, baseTree = null) {
  if (node.state === "done") return { mark: "●", text: "绿" };
  //
  // **比的是树,不是 commit。**
  //
  // 原来这里写 `treeY !== node.base`。那是拿**树哈希**和**commit sha**比
  // —— 两种东西,永远不相等,于是这条分支恒真:
  // 只要传了 treeY,**任何**待办节点都显示 ◐,哪怕一个字都没改。
  //
  // (这个 bug 之所以一直没暴露,恰恰因为 treeY 一直是 null ——
  //  分支根本没机会执行。**修一个 bug 会把旁边那个 bug 放出来。**)
  //
  // 正确做法:把 base 也解析成树,再比。
  if (treeY && baseTree && treeY !== baseTree) {
    return { mark: "◐", text: "进行中" };
  }
  return { mark: "○", text: "待办" };
}

/** `node.base` 的树哈希 —— 给 displayState 比大小用。 */
export function baseTreeOf(dir, node) {
  return node?.base ? treeOf(dir, node.base) : null;
}

/**
 * 图外的提交 —— **绕过检测**。
 *
 * 模型有 bash,没法禁止它裸 `git commit`。所以不是"禁止",而是"**发现**":
 *
 *     有 bg-node trailer  ->  走门禁的
 *     没有                ->  绕过的
 */
// ---------------------------------------------------------- 没有"绕过"这回事
//
// 这里原来有个 `findBypass`:扫 git log,把**没有 bg-node trailer** 的提交
// 列出来,标成「⚠ 绕过了门禁」,还在 health 里报「N 个提交绕过门禁」。
//
// **删掉了。那个概念本身是错的。**
//
//     节点(node)   = 一种**记录**:意图 + 证据
//     git commit   = 一个**工具**:版本控制
//
// 模型用 `git commit` 提交代码,那是**正常干活** —— 不是"绕过"谁。
// 没走节点只意味着"这件事没有留下记录",**不意味着它违规了**。
// 而"⚠ 绕过了门禁"这句话在暗示"存在一条你没遵守的规矩" —— 那是在
// 编造规则,会让人以为出了问题,而其实什么都没有发生。
//
// 它还逼出了一个自己打自己脸的豁免逻辑:原代码得专门判断
// "比最老的 base 还老的提交不算绕过",否则每个仓库都会把 init 报成
// 违规。**需要不断解释"哪些不算绕过",正说明"绕过"不是一个真概念。**
//
// 所以:**图只显示有记录的节点,别的不管。**
// git 那边发生了什么,是 git 的事。

/** 弱 P / 空 Δ 的标记 —— 不拦,但不隐瞒。 */
export function gateFlags(node) {
  const flags = [];
  if (node.weak_verify === true) {
    flags.push("⚠ P 在基线时就通过 —— 它区分不了你做没做");
  }
  if (node.state !== "done" && !node.delta?.length) {
    flags.push("Δ 空 —— 没有任何东西防止意外改动");
  }
  return flags;
}

/**
 * P 的展示(含"程序文件在哪")。
 *
 * 三种情况**都要说出来**,不能沉默:
 *   · 显式声明了路径 -> 直接显示
 *   · 从命令推出来了 -> 显示,但标"推断"(推断可能错,人要能分辨)
 *   · 都没有         -> 明说"P 是内联命令"
 *
 * 留白是最坏的:人看不出那是"本来就没有",还是"渲染漏了"。
 */
function pLines(node, ind) {
  const out = [`${ind}P: ${node.verify ?? "(没有)"}`];
  if (!node.verify) return out;
  if (node.verify_path) {
    out.push(`${ind}P 文件: ${node.verify_path}`);
  } else {
    const guess = inferVerifyPath(node.verify);
    out.push(guess
      ? `${ind}P 文件: ${guess}  (推断)`
      : `${ind}P 文件: (无 —— P 是内联命令)`);
  }
  return out;
}

/**
 * `node_tree`:看整棵树(灯 + P 原文 + 弱 P 标记 + 图外的提交)。
 *
 * **这是人的面**,不占模型的工具位。
 */
export function renderTree(dir) {
  const nodes = allNodes(dir);
  if (!nodes.length) {
    return { ok: true, lines: ["(图是空的)—— 还没有任何节点。用 node_plan 声明一个。"] };
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const dropped = droppedSet(dir);
  const root = rootNode(dir);

  const lines = [];

  // ---------------------------------------------------------- 画成一棵树
  //
  // 原来这里是**遍历 nodes 直接输出** —— `parent` 一个字都没参与渲染。
  // 结果:数据结构是树,屏幕上是一个扁平列表,`n1` 的子和 `n1` 的兄弟
  // 缩进一样、看不出谁是谁的子。层级信息在 nodes.json 里存着
  // (凭证的"向下包含"就靠它遍历),但人看不见。
  //
  // 所以要**按 parent 建 children 索引,从根往下走**。
  //
  // 三条边界,都不是假设:
  //   · 父不在图里(被 abandon 了,或压根没声明)-> 当根层,不能丢
  //   · 环(a.parent=b, b.parent=a)-> 走 seen,不能死循环
  //   · 没有根(理论上不会,root 是人签的;但防御)-> 退回扁平
  //
  // **丢节点是最坏的失败** —— 人看不见自己的计划,而"看得见"是这套
  // 东西唯一的问责机制。所以孤儿和环一律**照画**,只是放在根层。

  const live = nodes.filter((n) => !isDropped(dir, n.id, byId, dropped));

  // **算一次工作区的树,给 displayState 用。**
  //
  // 少了这一句,`◐ 进行中` 那盏灯**从来没亮过**:
  // `displayState(n)` 不传 treeY -> 默认 null -> "看工作区"那条分支
  // 永远进不去 -> 待办节点哪怕工作区改得翻天覆地,也只显示 ○。
  //
  // 而 `workingTreeHash` 本身是好的(BUG-1 已修,有回归验收),
  // 只是**没人调它**。所以这不是地基问题,是一个没接上的线头。
  //
  // 算一次很便宜(临时索引 + write-tree),而且它排除了 `.bg/` ——
  // 工具自己的状态不该算作"工作区改动"。
  const treeY = workingTreeHash(dir);

  const childrenOf = new Map();
  for (const n of live) {
    const p = n.parent ?? null;
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p).push(n);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  /** 一个节点的块。depth 只影响缩进。 */
  const block = (n, depth) => {
    const ds = displayState(n, treeY, treeOf(dir, n.base));
    const ind = "  ".repeat(depth);
    // `at-commit` = 提交时照着实际改动抄下来的,**不是事前预测**。
    // 它拦不住"做错方向" —— 它只保证"改动被记录下来了,创建者看得见"。
    // 所以标记要**显眼**:不能和预测过的 Δ 看起来一样。
    const transcribed = n.delta_source === "at-commit";
    const src = transcribed ? " 〔Δ 转录 · 非预测〕" : "";
    const out = [];

    out.push(`${ind}${ds.mark} ${pad(n.id, 12)} ${n.expect.slice(0, 44)}${src}`);
    out.push(...pLines(n, `${ind}  `));

    // ---- Δ 始终占位 ----
    //
    // 原来「有 Δ 才画」。沉默的代价是:一个没声明 Δ 的节点看起来
    // 和"声明了且已满足"没有区别 —— 而 DESIGN 里写死了
    // 「空不是'没改动',是'没预测'」。那就必须说出来,不沉默。
    //
    // **但不要和 gateFlags 说两遍。** gateFlags 那句带后果
    // ("没有任何东西防止意外改动"),信息更全;这里只补它**不覆盖**的情况:
    //   · 已达成(state=done)-> gateFlags 不报空 Δ,这里得说
    //   · 待办/进行中      -> gateFlags 已经报了,这里只留一个位置标记
    if (n.delta?.length) {
      const suffix = transcribed
        ? "   ← 转录(提交时照实际抄的,不是事前预测 —— 拦不住做错方向)"
        : "";
      out.push(`${ind}  Δ: ${n.delta.map((d) => `${d.code} ${d.path}`).join("  ")}${suffix}`);
    } else if (n.state === "done") {
      out.push(`${ind}  Δ: (空 —— 达成时没有预测,只有 P 在承重)`);
    } else {
      out.push(`${ind}  Δ: (空)`);
    }

    for (const f of gateFlags(n)) out.push(`${ind}  ${f}`);
    if (n.state === "done") out.push(`${ind}  证据 ${short(n.result)}`);
    return out;
  };

  /** 从 depth 开始深度优先。seen 防环;seenSelf 只防自己这条路径。 */
  const walk = (n, depth, seen) => {
    if (seen.has(n.id)) {
      lines.push(`${"  ".repeat(depth)}⚠ ${n.id} 父指针成环 —— 停在这里`);
      return;
    }
    seen.add(n.id);
    lines.push(...block(n, depth));
    for (const c of childrenOf.get(n.id) ?? []) walk(c, depth + 1, seen);
  };

  const globalSeen = new Set();

  if (root && byId.has(root.id)) {
    const ds = displayState(root, treeY, treeOf(dir, root.base));
    const rootTranscribed = root.delta_source === "at-commit";
    lines.push(`根 ${ds.mark} ${root.id}  ${root.expect.slice(0, 50)}`
      + `${rootTranscribed ? "  〔Δ 转录 · 非预测〕" : ""}`);
    lines.push(...pLines(root, "     "));
    // 根也一样:Δ 空要说出来,不沉默。同上,不和 gateFlags 说两遍。
    if (root.delta?.length) {
      const suffix = rootTranscribed
        ? "   ← 转录(提交时照实际抄的,不是事前预测)"
        : "";
      lines.push(`     Δ: ${root.delta.map((d) => `${d.code} ${d.path}`).join("  ")}${suffix}`);
    } else {
      lines.push(`     Δ: ${root.state === "done"
        ? "(空 —— 达成时没有预测,只有 P 在承重)"
        : "(空)"}`);
    }
    for (const f of gateFlags(root)) lines.push(`     ${f}`);
    if (root.state === "done") lines.push(`     证据 ${short(root.result)}`);
    globalSeen.add(root.id);

    for (const c of childrenOf.get(root.id) ?? []) walk(c, 1, globalSeen);
    lines.push("");
  }

  // **孤儿照画。** 父不在图里(被放弃 / 没声明)—— 它是根层的节点,
  // 不是"不该出现"。丢掉它 = 人看不见自己声明过的意图。
  const orphans = live.filter((n) => {
    if (root && n.id === root.id) return false;
    if (globalSeen.has(n.id)) return false;
    return !(n.parent && byId.has(n.parent));
  });
  if (orphans.length) {
    lines.push(`(有 ${orphans.length} 个节点的父不在图里 —— 照画,不丢)`);
    for (const n of orphans) walk(n, 1, globalSeen);
  }

  // 兜底:既不是根的后代、也不是孤儿(理论上只剩环里的),也别丢。
  for (const n of live) {
    if (globalSeen.has(n.id)) continue;
    lines.push(...block(n, 1));
    globalSeen.add(n.id);
  }

  lines.push("");
  lines.push("● 绿(有 commit,已验证)  ◐ 进行中(有工作区改动)  ○ 待办");

  const nDropped = nodes.filter((n) => isDropped(dir, n.id, byId, dropped)).length;
  if (nDropped) lines.push(`(放弃了 ${nDropped} 个)`);

  return { ok: true, lines };
}

/**
 * `node_status` —— 这套东西的使用体验所在。
 *
 * 输出**直接对着 Δ 的形状**:漏做 / 预期外 / 方向错是三种不同的问题,
 * 混成一句"不一致"模型就没法修。
 */
export function renderStatus(dir, id) {
  const r = status(dir, id);
  if (!r.ok) return { ok: false, lines: r.problems.map((p) => `  ✗ ${p}`) };

  const n = r.node;
  const lines = [];

  lines.push(`节点 ${n.id}  ${n.state === "done" ? "● 绿" : "○ 待办"}  ${n.expect}`);
  lines.push(`  基准 ${short(n.base)}`);
  lines.push(`  当前 ${short(r.current) || "(空)"}`);
  lines.push("");

  if (!r.actual?.length) {
    lines.push("相对基准**没有改动**。");
  } else {
    lines.push(`相对基准改了 ${r.actual.length} 个文件:`);
    for (const d of r.actual) {
      lines.push(`  ${d.code}  ${d.code === "R" ? `${d.path} -> ${d.to}` : d.path}`);
    }
  }

  lines.push("");
  lines.push("这些改动会成为一个节点:");
  lines.push(`  node_commit ${n.id}`);

  // ---- 和 Δ 比 ----
  if (n.delta?.length) {
    const src = n.delta_source === "at-commit" ? "(转录)" : "(预测)";
    lines.push("");
    lines.push(`和声明的 Δ 比 ${src}`);

    const got = new Set(r.actual.map((d) => `${d.code}:${d.path}`));

    for (const d of n.delta) {
      const k = `${d.code}:${d.path}`;
      const p = d.code === "R" ? `${d.path} -> ${d.to}` : d.path;
      if (got.has(k)) {
        lines.push(`  ✓ ${d.code}  ${p}`);
        continue;
      }
      const byPath = r.actual.find((x) => x.path === d.path);
      if (byPath) {
        lines.push(`  ✗ ${d.code}  ${p}  实际是 ${byPath.code} —— **方向不对**`);
      } else {
        lines.push(`  ✗ ${d.code}  ${p}  声明了,但**没发生** —— 漏做了`);
      }
    }

    for (const a of r.actual) {
      const declared = n.delta.some((d) => `${d.code}:${d.path}` === `${a.code}:${a.path}`);
      const samePath = n.delta.some((d) => d.path === a.path);
      if (!declared && !samePath) {
        lines.push(`  + ${a.code}  ${a.path}  **多出来的 —— 预期外的改动**`);
      }
    }
  } else {
    lines.push("");
    lines.push("Δ 是空的 —— 没有预测,**没有任何东西防止意外改动**,只有 P 在承重。");
    if (r.actual?.length) {
      lines.push("如果你本来就想改这些,把它们写进 Δ(动手前写才算真的约束)。");
    }
  }

  lines.push("");
  lines.push(`P: ${n.verify}`);
  if (n.weak_verify === true) {
    lines.push("  ⚠ 这条 P 在基线时就通过 —— 它区分不了你做没做");
  } else if (n.weak_verify === null || n.weak_verify === undefined) {
    lines.push("  (还没探过它在基线时过不过 —— commit 时会探)");
  }

  if (n.state === "done") {
    lines.push("");
    lines.push(`已达成:证据 ${short(n.result)}  验过的树 ${short(n.verified_tree)}`);
  }

  return { ok: true, lines, report: r };
}

/**
 * 心跳一行。
 *
 * 只报**派生**出来的东西 —— 便宜,永远算得起,不跑 P。
 */
export function healthLine(dir) {
  const nodes = allNodes(dir);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const dropped = droppedSet(dir);
  const live = nodes.filter((n) => !isDropped(dir, n.id, byId, dropped));

  const done = live.filter((n) => n.state === "done").length;
  const todo = live.length - done;
  const bits = [`${done} 绿 / ${todo} 待达成`];
  const weak = live.filter((n) => n.weak_verify === true).length;
  if (weak) bits.push(`${weak} 条弱 P`);
  return `${bits.join("  ·  ")}   (HEAD ${short(head(dir)) || "-"})`;
}

/**
 * `node_log` —— 从 commit trailer 读出来的历史。
 *
 * 绿是"一个关于某个 commit 的事实",所以历史本身就是绿的清单。
 */
export function renderLog(dir) {
  const lines = [];
  for (const c of logRaw(dir, { limit: 100 })) {
    const t = parseTrailers(c.body);
    const subject = (c.body.split("\n").find((l) => l.trim()) ?? "(无 message)").trim();
    if (t["bg-node"]) {
      const weak = t["bg-weak-verify"] ? "  ⚠弱P" : "";
      lines.push(`● ${c.sha.slice(0, 8)}  ${t["bg-node"]}  ${subject.slice(0, 50)}${weak}`);
      if (t["bg-verify"]) lines.push(`      P: ${t["bg-verify"]}`);
      if (t["bg-delta"] && !t["bg-delta"].startsWith("(")) {
        lines.push(`      Δ: ${t["bg-delta"]}   [${t["bg-delta-source"] ?? "?"}]`);
      }
    } else {
      lines.push(`○ ${c.sha.slice(0, 8)}  ${subject.slice(0, 50)}  (不在图里)`);
    }
  }
  if (!lines.length) lines.push("(还没有 commit)");
  return { ok: true, lines };
}
