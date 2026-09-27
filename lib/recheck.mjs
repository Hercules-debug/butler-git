/**
 * recheck.mjs —— 复查:**对当前 commit 重跑各历史节点的 (Δ, P)**。
 *
 * ## 为什么它不是一盏灯
 *
 * 一个灯会丢掉"回归可见性":
 *
 *     node 5 弄坏了 node 2 的功能
 *       node 5 的 P 如果没覆盖  ->  它绿
 *       node 2 的灯是对它那个 commit 的事实  ->  它**还是绿**
 *
 * 补法是把它做成**一次查询**,而不是节点的一个状态:
 *
 *     node_recheck  ->  对【当前 commit】重跑各历史节点的 (Δ, P)
 *                   ->  指出谁现在会不通过
 *
 * **它是"看的时候才算"的诊断。** 所以灯还是一个。
 *
 * ## 它同时是"图和 commit 对不对得上"的检查
 *
 * 权威在 .bg/,证据在 commit。两者不一致时(改了 .bg/、或 amend 了 commit),
 * 这里会报出来 —— 见 `verifyEvidence`。
 */

import { allNodes, rootNode } from "./store.mjs";
import { head, treeOf, diffNameStatus, logRaw } from "./git.mjs";
import { runVerify } from "./gate.mjs";
import { compare } from "./delta.mjs";
import { verifyEvidence, parseTrailers } from "./nodes.mjs";

const short = (s) => String(s ?? "").slice(0, 8);

/**
 * 复查所有**已达成**节点在当前 HEAD 上的情况。
 *
 * `mode`:
 *   "delta"  只比 Δ(便宜)
 *   "full"   Δ + 重跑 P
 */
export function recheck(dir, { mode = "delta", timeout = 120_000 } = {}) {
  const nodes = allNodes(dir);
  const done = nodes.filter((n) => n.state === "done");
  const cur = head(dir);

  if (!done.length) {
    return { ok: true, lines: ["(还没有已达成的节点 —— 没有可复查的东西)"], regressions: [] };
  }
  if (!cur) {
    return { ok: true, lines: ["(还没有 commit —— 没有可复查的东西)"], regressions: [] };
  }

  const curTree = treeOf(dir, cur);
  const root = rootNode(dir);
  const regressions = [];
  const lines = [`复查 ${done.length} 个已达成节点 —— 基准是当前 HEAD ${short(cur)}`, ""];

  for (const n of done) {
    // ---------- ① 证据还完好吗 ----------
    const ev = verifyEvidence(dir, n);
    if (ev.status === "tampered") {
      regressions.push({ id: n.id, kind: "evidence", detail: ev.detail });
      lines.push(`✗ ${n.id}  ${ev.detail}`);
      continue;
    }
    if (ev.status === "unknown") {
      lines.push(`? ${n.id}  ${ev.detail}`);
    }

    // ---------- ② Δ 还成立吗 ----------
    //
    // 这里比的是 diff(这个节点的 base, 当前 HEAD),不是"重跑它自己的改动"。
    // 语义是:**它做的那些改动,现在还在吗**。
    const actual = diffNameStatus(dir, n.base, cur) ?? [];
    const cmp = compare(n.delta, actual);

    if (n.delta?.length) {
      const gone = cmp.missing.length;
      const changedDir = cmp.mismatch.length;
      const extra = cmp.extra.length;

      if (gone || changedDir) {
        regressions.push({
          id: n.id,
          kind: "delta",
          detail: `${n.id} 的 Δ 现在不成立了:`
            + [gone ? `${gone} 条没了` : "", changedDir ? `${changedDir} 条方向变了` : ""]
              .filter(Boolean).join("、"),
        });
        lines.push(
          `✗ ${n.id}  它的改动现在对不上了:`
          + [gone ? `${gone} 条没了` : "", changedDir ? `${changedDir} 条方向变了` : ""]
            .filter(Boolean).join("、"),
        );
        for (const m of cmp.missing) lines.push(`     漏: ${m.code} ${m.path}`);
        for (const m of cmp.mismatch) {
          lines.push(`     方向: ${m.path} 声明 ${m.declared},现在 ${m.actual}`);
        }
      } else {
        // "多出来的"在复查里**不算回归** —— 后来的人本来就该加东西。
        // 但要看的话看得到,所以列出来、不标 ✗。
        if (extra) lines.push(`· ${n.id}  Δ 仍然成立(另有 ${extra} 条后来的改动)`);
        else lines.push(`· ${n.id}  Δ 仍然成立`);
      }
    } else {
      lines.push(`· ${n.id}  Δ 是空的(本来就没有预测可比)`);
    }

    // ---------- ③ P 现在还过吗 ----------
    if (mode === "full") {
      const p = runVerify(dir, n.verify, { timeout });
      if (p.status === "ok") {
        lines.push(`     P 现在仍然通过: ${n.verify}`);
      } else {
        regressions.push({
          id: n.id,
          kind: "verify",
          detail: `${n.id} 的 P 现在不通过: ${n.verify}`,
        });
        lines.push(`✗ ${n.id}  P 现在不通过: ${n.verify}`);
      }
    }
  }

  // ---------- 根 P ----------
  if (root?.verify) {
    const rp = runVerify(dir, root.verify, { timeout });
    lines.push("");
    if (rp.status === "ok") lines.push(`根 P 现在通过: ${root.verify}`);
    else {
      regressions.push({ id: root.id, kind: "root", detail: `根 P 现在不通过: ${root.verify}` });
      lines.push(`✗ 根 P 现在不通过: ${root.verify}`);
    }
  }

  // ---------- ④ 历史里每个 commit 自证:commit^{tree} == 它自己的 bg-verified-tree ----------
  //
  // 这一条**不依赖 .bg/** —— 它只看 commit 自己。所以它是最强的那张网:
  //
  //     走门禁 commit 了 V(带 trailer:"P 通过",verified-tree: T)
  //     git commit --amend 改内容(保留 message 和 trailer)
  //       -> V' 内容变了,trailer 还写着"P 通过"  ->  一个伪造的绿
  //
  // 图丢了、被改了、换了一份,这一条照样抓得住。
  const forged = [];
  for (const c of logRaw(dir, { limit: 300 })) {
    const t = parseTrailers(c.body);
    const claimed = t["bg-verified-tree"];
    if (!claimed) continue;
    const actualTree = treeOf(dir, c.sha);
    if (actualTree === null) continue;      // 读不到 = 不知道,不假装查过
    if (actualTree !== claimed) {
      forged.push({
        sha: c.sha,
        node: t["bg-node"],
        detail: `${short(c.sha)}(节点 ${t["bg-node"] ?? "?"}) 的内容被改过:`
          + `它的树是 ${short(actualTree)},但它的 trailer 说验过的是 ${short(claimed)}`
          + ` —— **这是一个伪造的绿**`,
      });
    }
  }

  if (forged.length) {
    lines.push("");
    lines.push(`✗ 有 ${forged.length} 个 commit 的**证据对不上自己写下的 trailer**:`);
    for (const f of forged) {
      lines.push(`  ${f.detail}`);
      regressions.push({ id: f.node ?? f.sha, kind: "forged", detail: f.detail });
    }
  }

  lines.push("");
  if (regressions.length) {
    lines.push(`${regressions.length} 处回归 / 问题。`);
    lines.push("注意:这些节点的灯**仍然是绿的** —— 绿是对它那个 commit 的事实。");
    lines.push("这里说的是**现在**对不上,两件事不冲突。");
  } else {
    lines.push("没有发现回归。");
  }

  return { ok: regressions.length === 0, lines, regressions };
}

/**
 * 图和 commit 对不对得上。
 *
 * 两种不一致都要能看见:
 *   · commit 里有 bg-node,但图里没这个节点(图被动过 / 换了一份)
 *   · 图里说 done,但那个 commit 上没有 trailer(图在说谎)
 */
export function crossCheck(dir) {
  const nodes = allNodes(dir);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const issues = [];

  for (const c of logRaw(dir, { limit: 200 })) {
    const t = parseTrailers(c.body);
    const id = t["bg-node"];
    if (!id) continue;
    const n = byId.get(id);
    if (!n) {
      issues.push(`commit ${short(c.sha)} 说它是节点 ${id},但图里没有这个节点`);
      continue;
    }
    if (n.result !== c.sha) {
      issues.push(`commit ${short(c.sha)} 说它是节点 ${id},但图里记的证据是 ${short(n.result)}`);
    }
  }

  for (const n of nodes) {
    if (n.state !== "done") continue;
    if (!n.result) {
      issues.push(`节点 ${n.id} 标记为 done,但没有 result commit`);
      continue;
    }
    const body = logRaw(dir, { limit: 300 }).find((c) => c.sha === n.result)?.body;
    if (body === undefined) {
      issues.push(`节点 ${n.id} 的证据 ${short(n.result)} 不在当前历史里`);
    } else if (!parseTrailers(body)["bg-node"]) {
      issues.push(`节点 ${n.id} 的证据 ${short(n.result)} 上没有 bg-node trailer —— 那不是走门禁产生的`);
    }
  }

  return issues;
}
