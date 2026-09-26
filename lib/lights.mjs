/**
 * lights.mjs —— **两盏灯**。
 *
 *     第一盏  通过过没有   读账本,历史事实,不可变
 *     第二盏  现在过不过   跑检查,当下,只是参考
 *
 * ## 为什么必须是两盏,而不是一盏
 *
 * 一盏灯的时候,"绿"同时在说两件事,于是必然有一件说错:
 *
 *   只按"现在符合"算  ->  没有任何验收动作的节点也会显示绿,
 *                        那把"验收"这个动作本身的价值抹掉了
 *   只按"通过过"算    ->  可以有一棵全绿的树而产品是坏的
 *
 * 分开之后没有歧义,而且四种组合都有意义:
 *
 *     ●●  通过过,现在也对
 *     ●○  通过过,但现在已经坏了   <- **回归**,最该看一眼的
 *     ○●  没通过过,但现在能过     <- 从前的假绿
 *     ○○  没通过过,现在也不过
 *
 * ## 第二盏灯为什么只在看的时候算
 *
 * 它是**参考**,不是门禁。所以它:
 *   - 可以贵(可能要跑验证程序)-> 默认用 cheap 模式,不跑命令
 *   - 不影响第一盏灯
 *   - 逐节点给出 —— 所以根出问题的时候,它**指出是哪里坏的**
 */

import { allNodes, acceptanceOf, droppedSet, isDropped } from "./store.mjs";
import { evaluateGate } from "./gate.mjs";

export const L2 = {
  pass: "过",
  fail: "不过",
  unchecked: "未复查",
  none: "无检测",
  off: "未算",
};

/** 第二盏灯:现在过不过。 */
export function liveLight(dir, node, mode) {
  if (mode === "off") return { state: L2.off, items: [] };
  if (!hasAny(node)) return { state: L2.none, items: [] };

  const r = evaluateGate(dir, node, { mode: mode === "full" ? "full" : "cheap" });
  if (r.empty) return { state: L2.none, items: [] };
  if (r.failed.length) return { state: L2.fail, items: r.items };
  if (r.unknown.length) return { state: L2.unchecked, items: r.items };
  return { state: L2.pass, items: r.items };
}

function hasAny(node) {
  return Boolean(
    node.fs?.paths?.length || node.fs?.tree
    || node.proc?.present?.length || node.proc?.absent?.length
    || node.verify,
  );
}

/** 一个节点属于哪个任务 —— 沿 parent 走到根。 */
export function taskOf(dir, id) {
  const seen = new Set();
  let cur = id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const n = allNodes(dir).find((x) => x.id === cur);
    if (!n) return null;
    if (!n.parent) return n.id;
    cur = n.parent;
  }
  return null;
}

/**
 * 建整棵树。
 *
 * 每个节点带两盏灯,外加一个 `belowRed` —— 后代里有没有人现在是红的。
 * 有了它,一个折叠起来的父节点也能告诉你"底下有问题",而不用展开。
 */
export function buildTree(dir, { light2 = "cheap" } = {}) {
  const nodes = allNodes(dir);
  if (!nodes.length) return [];

  const byParent = new Map();
  for (const n of nodes) {
    const k = n.parent ?? null;
    byParent.set(k, [...(byParent.get(k) ?? []), n]);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.id.localeCompare(b.id));

  const make = (n, depth, seen) => {
    const { accepted, evidence } = acceptanceOf(dir, n.id);
    const l2 = liveLight(dir, n, light2);

    // 被放弃的节点(自己或祖先)不进树 —— 但**账本里留着**。
    // 不进树是因为:留在图里会让人以为"还在做这件事"。
    const children = seen.has(n.id)
      ? []
      : (byParent.get(n.id) ?? []).map((c) => make(c, depth + 1, new Set([...seen, n.id])));

    const belowRed = children.some((c) => c.light2 === L2.fail || c.belowRed);
    const belowUnchecked = children.some(
      (c) => c.light2 === L2.unchecked || c.belowUnchecked,
    );

    return {
      id: n.id,
      parent: n.parent ?? null,
      expect: n.expect,
      owner: n.owner,
      depth,
      light1: accepted,
      light2: l2.state,
      belowRed,
      belowUnchecked,
      evidence,
      node: n,
      items: l2.items,
      children,
    };
  };

  // 放弃的标记要**先算出来**:包括"祖先被放弃"的子节点。
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const dropped = droppedSet(dir);
  const alive = (n) => !isDropped(dir, n.id, nodesById, dropped);

  for (const [k, list] of byParent) {
    const kept = list.filter(alive);
    if (kept.length) byParent.set(k, kept);
    else byParent.delete(k);
  }

  return (byParent.get(null) ?? []).map((r) => make(r, 0, new Set()));
}

/** 被放弃的节点(给渲染层报个数,不然它们就凭空消失了)。 */
export function droppedList(dir) {
  const nodes = allNodes(dir);
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const dropped = droppedSet(dir);
  return nodes
    .filter((n) => isDropped(dir, n.id, nodesById, dropped))
    .map((n) => ({ id: n.id, expect: n.expect }));
}

/** 拍平成一维(给汇总用)。 */
export function flatten(views) {
  const out = [];
  const walk = (v) => {
    out.push(v);
    v.children.forEach(walk);
  };
  views.forEach(walk);
  return out;
}
