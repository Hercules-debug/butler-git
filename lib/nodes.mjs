/**
 * nodes.mjs —— 节点的写路径:**声明 / 改写 / 验收 / 作废**。
 *
 * ## 所有权:跟作者走
 *
 *     owner = "user"   人和模型**约定**的验收(根节点)
 *                      -> 模型改不动,要人授权
 *     owner = "model"  模型自己拆出来的中间节点
 *                      -> 模型可以自己改(它改的是**手段**,不是目标)
 *
 * 这不是权限洁癖,是结构需要:门禁同时是**规格**和**检查**,
 * 所以**门禁本身就是唯一的目标物**。能随便改它,等于能让验收标准事后消失。
 *
 * ## 两道门
 *
 *    1. **通过过的节点,门禁冻结** —— 连人也不能直接改。
 *       要变,起一个**新节点**把改动做出来(历史不改写,旧节点保持"通过过")。
 *    2. **owner=user 且已经有一份门禁** -> 模型不能改,要人授权。
 *       注意"已经有一份门禁"这个条件:`plan` 先把节点记下来时还没有门禁,
 *       模型随后补写是**首次定义**,不是改 —— 不该拦。
 *
 * ## 为什么"通过过"之后就冻结
 *
 * 因为绿是**历史事实**。它当时确实被验过,这件事永远为真。
 * 让你回头改门禁,等于让"当时的验收"变成一句无法核对的话。
 */

import { appendLedger, getNode, putNode, acceptanceOf, baseline } from "./store.mjs";
import { checkContract } from "./contract.mjs";
import { evaluateGate } from "./gate.mjs";
import { workingTreeHash } from "./git.mjs";

/** 把契约补成完整形状。缺的部分给空,不猜。 */
export function normalize(c) {
  return {
    id: c.id,
    parent: c.parent ?? null,
    expect: (c.expect ?? "").trim(),
    owner: c.owner ?? "model",
    allow: c.allow ?? [],
    fs: {
      paths: c.fs?.paths ?? [],
      tree: c.fs?.tree ?? null,
    },
    proc: {
      present: c.proc?.present ?? [],
      absent: c.proc?.absent ?? [],
    },
    verify: c.verify ?? null,
    confidence: c.confidence ?? "中",
  };
}

/** 这个节点的门禁里有没有实质内容。 */
export function hasGate(node) {
  return Boolean(
    node.fs?.paths?.length || node.fs?.tree
    || node.proc?.present?.length || node.proc?.absent?.length
    || node.verify,
  );
}

/**
 * 声明(新增或改写)一个节点。
 *
 * 返回 { ok, node?, problems?, notes?, rewrite? }
 */
export function declare(dir, raw, { asUser = false } = {}) {
  const c = normalize(raw);

  // **必须先有基线。**
  //
  // 图是**每个项目一份**的(`<项目>/.bg/`),而插件默认用会话 cwd 当项目 ——
  // 于是"指错目录"是个很现实的失误。没有这道门的话,它会**安静地**
  // 在错的地方开一个新的空图,还报 ok:true,直到事后某一步才冒出一句
  // "(说明) 没有基线"。
  //
  // 这正是这个项目最反对的失败:**指错了地方,不报错,只是给你一个空的图。**
  // 所以在这里硬拦 —— 修法对调用方只有一步(`bg init` 或给对 `project`)。
  if (!baseline(dir)) {
    return {
      ok: false,
      problems: [
        `${dir} 下面没有基线(.bg/baseline.json 不存在)。`
        + "先 `bg init` 取基线;如果你本来想操作**别的项目**,"
        + "给对 `project` 参数 —— 图是每个项目一份的,别在错的地方新开一个。",
      ],
      noBaseline: true,
    };
  }

  const chk = checkContract(dir, c);
  if (!chk.ok) return { ok: false, problems: chk.problems, notes: chk.notes };

  const old = getNode(dir, c.id);
  const isRewrite = old !== null;

  if (isRewrite) {
    const { accepted } = acceptanceOf(dir, c.id);

    // --- 门一:通过过的,门禁冻结 ---
    if (accepted) {
      return {
        ok: false,
        problems: [
          `节点 ${c.id} 已经**通过过**(历史事实)—— 门禁冻结,不许改。`
          + "要变,就起一个**新节点**把改动做出来(历史不改写,"
          + "旧节点保持'通过过');确实要改这份约定,那是改计划。",
        ],
        owner: old.owner,
      };
    }

    // --- 门二:人定的门禁,模型改不动 ---
    // 注意 `hasGate(old)`:plan 先记节点的时候还没有门禁,
    // 模型随后补写是**首次定义**,不是改。
    if (old.owner === "user" && hasGate(old) && !asUser) {
      return {
        ok: false,
        problems: [
          `节点 ${c.id} 的 owner 是「user」,而且**已经有一份门禁** —— `
          + "模型不能单方面改它,要改得由人授权(--as-user)。",
        ],
        owner: old.owner,
      };
    }
  }

  putNode(dir, c);
  appendLedger(dir, {
    type: "node",
    kind: isRewrite ? "改写" : "新增",
    node: c.id,
    parent: c.parent,
    expect: c.expect,
    owner: c.owner,
    by: asUser ? "user" : "model",
    // **门禁本身必须留痕。** 只记一句描述的话,
    // "真正要保护的那个东西"反而没有任何痕迹。
    gate: c,
    prevGate: isRewrite ? old : null,
  });

  return { ok: true, node: c, rewrite: isRewrite, notes: chk.notes };
}

/**
 * 验收:跑**完整**门禁(含验证程序)。全过 -> 点亮第一盏灯。
 *
 * 证据锚是必须的:
 *
 *     门禁   当时验的是哪几条(断言本身,不是一句描述)
 *     树     当时的世界长什么样(工作区树哈希,绝对判据)
 *     ts     什么时候
 *
 * 没有锚的"通过过"只是一句声称 —— 而第一盏灯能被信任,
 * 全靠这个锚。所以树哈希算不出来时**照样记**,但要说清楚它是空的。
 */
export function accept(dir, id, { timeout = 120_000 } = {}) {
  const node = getNode(dir, id);
  if (!node) return { ok: false, problems: [`节点 ${id} 不存在`] };
  if (!hasGate(node)) {
    return { ok: false, problems: [`节点 ${id} 没有门禁 —— 没有可验收的东西`] };
  }

  const r = evaluateGate(dir, node, { mode: "full", timeout });
  if (!r.ok) {
    return {
      ok: false,
      problems: [
        ...r.failed.map((i) => `${i.label}  ${i.detail}${i.demand ? `  -> 要求: ${i.demand}` : ""}`),
        ...r.unknown.map((i) => `${i.label}  ${i.detail}(**不知道** —— 不算通过)`),
      ],
      report: r,
    };
  }

  const tree = workingTreeHash(dir);
  const evidence = {
    gate: node,
    tree,
    ts: new Date().toISOString(),
    treeAvailable: tree !== null,
  };
  appendLedger(dir, { type: "accept", node: id, evidence });
  return { ok: true, node: id, evidence };
}

/**
 * 作废:把"通过过"收回。**追加一条,不改写那条 accept。**
 *
 * 历史不改写 —— 所以看到的是"它曾经通过,后来被作废了",
 * 而不是"它从来没有通过"。后者会丢掉信息。
 */
export function retract(dir, id, reason = "") {
  const { accepted } = acceptanceOf(dir, id);
  if (!accepted) return { ok: false, problems: [`节点 ${id} 本来就没有通过过`] };
  appendLedger(dir, { type: "retract", node: id, reason });
  return { ok: true, node: id };
}

/**
 * **放弃一个计划**(BUG-7)。
 *
 * `retract` 管的是"把通过过收回";这个管的是**从未通过过的节点怎么退出**。
 *
 * 原来没有这个原语,后果实测过:放弃掉一件事之后,当初为它声明的节点
 * 既不能被删、也不该被假装通过,只能**留在图里一直红着** ——
 * 于是图看起来像"还在做这件事",而事实不是。
 *
 * ## 和 retract 的关系
 *
 * 通过过的节点**不能直接 drop** —— 那会把一段真实的验收历史抹出图外。
 * 要放弃可以,但得先 `retract`(把通过过收回,并留下那条记录),
 * 再 drop。**历史不改写**是这套东西的地基,不为方便让步。
 *
 * 同样**追加**:账本里能读出"它被声明过,后来被放弃了"。
 */
export function drop(dir, id, reason = "") {
  const node = getNode(dir, id);
  if (!node) return { ok: false, problems: [`节点 ${id} 不存在`] };

  const { accepted } = acceptanceOf(dir, id);
  if (accepted) {
    return {
      ok: false,
      problems: [
        `节点 ${id} 已经**通过过** —— 不能直接放弃。`
        + "先 retract 收回它(那条历史会留在账本里),再 drop。",
      ],
    };
  }

  appendLedger(dir, { type: "drop", node: id, reason, expect: node.expect });
  return { ok: true, node: id, reason };
}
