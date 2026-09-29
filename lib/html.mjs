/**
 * html.mjs —— 把图渲染成一个**单文件 HTML**。
 *
 * ## 为什么是"第三渲染前端"却还敢做
 *
 * 这个东西**回退过一次**。当时的理由是 BUG-1:`workingTreeHash` 恒为 null,
 * "验收"的证据锚永远是空的 —— 在那种地基上交付任何东西都没法真诚地验收。
 *
 * BUG-1 已修(有回归验收)。所以这次不是重蹈覆辙,是重来。
 *
 * ## 它**不算**,只画
 *
 * 数据全部来自 `store.mjs` / `view.mjs` / `git.mjs` 的既有函数。
 * 这里**不解析 nodes.json、不重新实现 Δ 比对**——
 * 逻辑只有一份(见 test/plugin.mjs 那条守卫),前端只是渲染。
 *
 * ## 展示纪律(DESIGN.md「可见性是唯一的问责机制」)
 *
 *     ① P 的**原文**要看得见,不能只显示"通过"
 *     ② 弱 P 要标出来
 *     ③ Δ 为空要标出来
 *     ④ 转录的 Δ 要和预测的分开 —— 它没约束过那些改动
 *
 * 不拦,但不隐瞒。
 */

import { allNodes, rootNode, droppedSet, isDropped } from "./store.mjs";
import { displayState, gateFlags } from "./view.mjs";
import { inferVerifyPath } from "./nodes.mjs";
import { head, workingTreeHash, treeOf, isAncestor, fullSha } from "./git.mjs";
import { graphData, mermaidHtml } from "./mermaid.mjs";

/** HTML 转义。**节点的 expect / verify 是模型写的,里面可能有 < > &。 */
export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const short = (s) => String(s ?? "").slice(0, 8);

/** 灯 -> 一个 class 名,样式在 CSS 里。 */
function markClass(mark) {
  if (mark === "●") return "done";
  if (mark === "◐") return "wip";
  return "todo";
}

/**
 * "P 的程序文件在哪"那一行的 HTML。
 *
 * 三种情况都**显式呈现**(和终端版同一套语义,见 view.mjs 的 pLines):
 *   显式声明 / 推断 / 没有。推断的标灰,让人知道它可能不准。
 */
function vpRow(n) {
  if (!n.verify) return "";
  if (n.verify_path) {
    return `<div class="row"><span class="k">P 文件</span><code class="v">${esc(n.verify_path)}</code></div>`;
  }
  const guess = inferVerifyPath(n.verify);
  if (guess) {
    return `<div class="row"><span class="k">P 文件</span><code class="v">${esc(guess)}<span class="why">  (推断)</span></code></div>`;
  }
  return '<div class="row"><span class="k">P 文件</span><span class="v empty">(无 —— P 是内联命令)</span></div>';
}

/**
 * 取数据 —— **不算前端逻辑,只是把 lib 的数据整理成树的形状。**
 *
 * 拆出来是因为 `bg serve` 要**每次请求现读现算**(不缓存),
 * 而静态文件也要同样的形状。两边共用这一个函数,不各写一份。
 */
export function buildTree(dir) {
  const nodes = allNodes(dir);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const dropped = droppedSet(dir);
  const live = nodes.filter((n) => !isDropped(dir, n.id, byId, dropped));
  const root = rootNode(dir);

  const childrenOf = new Map();
  for (const n of live) {
    const p = n.parent ?? null;
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p).push(n);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  const seen = new Set();
  const build = (n) => {
    if (seen.has(n.id)) return { node: n, children: [] };
    seen.add(n.id);
    return { node: n, children: (childrenOf.get(n.id) ?? []).map(build) };
  };

  const roots = [];
  if (root && byId.has(root.id)) roots.push(build(root));
  // 孤儿照画,不丢 —— 丢节点 = 人看不见自己声明过的意图。
  for (const n of live) {
    if (seen.has(n.id)) continue;
    if (n.parent && byId.has(n.parent)) continue;
    roots.push(build(n));
  }

  // ---- 接续边(虚线)------------------------------------------------
  //
  // **父子关系不是唯一的连接。** 节点还通过 **代码历史** 相连:
  //
  //     A.result == B.base   ->   B 是从 A 达成的那个版本开始的
  //
  // 于是"不同的根"其实可能是一条链。实测:root.result = f5d612a5,
  // gate2.base 也是 f5d612a5 —— 它们没有父子关系,但历史接得上。
  //
  // 这两种边**语义不同,不能混画**:
  //
  //     父子边 -> "谁拆给谁的"(意图结构)
  //     接续边 -> "代码从哪儿来的"(版本结构)
  //
  // 用同一种线画会让人以为 gate2 是 root 的子节点 —— 那是在撒谎。
  //
  // 注意:`A.result == B.base` 里 A 必须是**已达成的**节点(result 才有值)。
  // 指向图外的 base(比如某个绕过门禁的裸 commit)—— 你说了不管,跳过。
  //
  // **索引要按键规范化** —— 老节点里存过缩写的 base(实测踩过),
  // 直接拿字符串做键的话,`A.result == B.base` 永远不成立,链就断了。
  // 这里两边都解析成完整 sha(解析不了就退回原字符串)。
  const byResult = new Map();
  for (const n of live) {
    if (!n.result) continue;
    byResult.set(n.result, n);
    const f = fullSha(dir, n.result);
    if (f) byResult.set(f, n);
  }

  const continuation = [];      // { from: 节点, to: 节点 }
  const danglingBase = [];      // { node, base }  base 在图外
  //
  // **判据:base 比"最早的 base"还老 —— 那才是建图之前的历史。**
  //
  // 不能写成"它是某个 base 的祖先"。那太松:`vis2.base = 84e209f4`
  // 是 `ec936cd5` 的**后代**(更晚),却被 `some()` 匹配上,于是
  // "base 在图外"这件事被**静默吞掉**了。(实测踩过。)
  //
  // 形状:**比每一个 base 都老**(或是 base 本身)才叫历史;
  // 否则就是图外的提交,该如实报出来。
  const bases = live.map((n) => n.base).filter(Boolean);

  for (const n of live) {
    if (!n.base) continue;
    const from = byResult.get(n.base) ?? byResult.get(fullSha(dir, n.base) ?? "");
    if (!from) {
      const olderThanAll = bases.length > 0
        && bases.every((b) => b === n.base || isAncestor(dir, n.base, b) === true);
      if (!olderThanAll) danglingBase.push({ node: n, base: n.base });
      continue;
    }
    if (from.id === n.id) continue;                 // 自指,不画
    if (from.id === (n.parent ?? null)) continue;   // 已经是父子边,不重复画

    // **只在"根"上画接续边。**
    //
    // 非根节点已经有父子边挂在图上,它的 base 接续关系由**它所在的
    // 那条链的起点**代表就够了。否则 gate2b(base 也 = f5d612a5)会额外
    // 画一条 root -> gate2b 的线,和 gate2 -> gate2b 交叉,让人以为
    // gate2b 同时挂在两个地方。(实测踩过一次。)
    if (n.parent && byId.has(n.parent)) continue;

    continuation.push({ from, to: n });
  }

  return {
    dir,
    head: head(dir),
    // 给 displayState 看工作区用 —— 少了它 `◐ 进行中` 永远不亮。
    // 见 view.mjs 那段注释:workingTreeHash 本身是好的,只是以前没人调。
    treeY: workingTreeHash(dir),
    roots,
    continuation,     // 接续边(A.result == B.base),和父子边语义不同
    danglingBase,     // base 指向图外的节点 —— 如实报出来,不假装接得上
    stats: {
      done: live.filter((n) => n.state === "done").length,
      todo: live.filter((n) => n.state !== "done").length,
      total: live.length,
    },
    at: new Date().toISOString(),
  };
}

/** CSS —— 静态文件和 `bg serve` **共用同一份**,不各写一套。 */
export function styleCss() {
  return `
  :root { --bg:#fafafa; --card:#fff; --line:#e3e3e3; --fg:#222; --dim:#777; }
  * { box-sizing:border-box; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--fg);
         font:14px/1.6 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif; }
  h1 { font-size:17px; margin:0 0 4px; }
  .meta { color:var(--dim); font-size:12px; margin-bottom:16px; }
  .stats { margin-bottom:18px; font-size:13px; }
  .stats b { font-weight:600; }
  ul.tree, ul.tree ul { list-style:none; margin:0; padding-left:0; }
  ul.tree ul { padding-left:20px; border-left:1px dashed var(--line); margin-left:6px; }
  li.node { margin:6px 0; }
  details { background:var(--card); border:1px solid var(--line); border-radius:6px; }
  details[open] { padding-bottom:2px; }
  summary { cursor:pointer; padding:8px 10px; display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; }
  summary::-webkit-details-marker { display:none; }
  .mark { font-size:13px; }
  li.done > details > summary .mark { color:#1a7f37; }
  li.wip  > details > summary .mark { color:#bc4c00; }
  li.todo > details > summary .mark { color:#888; }
  .id { font-weight:600; font-size:12px; background:#f0f0f0; padding:1px 6px; border-radius:4px; }
  .expect { flex:1; min-width:200px; }
  .ev { font-size:11px; color:var(--dim); font-family:ui-monospace, monospace; }
  .tag { font-size:11px; padding:1px 6px; border-radius:3px; background:#fff4e0; color:#8a5300; }
  .tag.sm { margin-left:6px; }
  .body { padding:2px 10px 10px 28px; border-top:1px solid #f0f0f0; }
  .row { display:flex; gap:8px; padding:2px 0; align-items:baseline; }
  .k { width:34px; flex:none; color:var(--dim); font-size:11px; text-transform:uppercase; }
  .v { font-family:ui-monospace, monospace; font-size:12px; word-break:break-all; flex:1; }
  .d { display:inline-block; margin-right:8px; background:#f4f4f4; padding:0 5px; border-radius:3px; }
  .d b { color:#555; }
  .empty { color:var(--dim); }
  .flag { color:#8a5300; font-size:12px; margin-top:3px; }
  .why { color:var(--dim); }
  .legend { margin-top:20px; color:var(--dim); font-size:12px; }
  .live { font-size:11px; color:var(--dim); margin-left:8px; }
  .live b { color:#1a7f37; }
  .live.off b { color:#a33; }

  /* ---- 图 ---- */
  .graphwrap { overflow-x:auto; padding:4px 0 8px; }
  svg.graph { display:block; }
  path.edge { fill:none; stroke-width:1.4; }
  path.edge.parent { stroke:#b9b9b9; }
  path.edge.cont   { stroke:#c9a227; stroke-dasharray:5 4; }
  .gnode rect { fill:#fff; stroke:#dcdcdc; stroke-width:1.4; }
  .gnode.wip  rect { stroke:#e0a060; }
  .gnode.todo rect { stroke:#d0d0d0; stroke-dasharray:4 3; }
  .gnode text { font-family:-apple-system, "PingFang SC", sans-serif; }
  .gnode .mk  { font-size:13px; }
  .gnode.done .mk { fill:#1a7f37; }
  .gnode.wip  .mk { fill:#bc4c00; }
  .gnode.todo .mk { fill:#999; }
  .gnode .nid { font-size:11px; font-weight:600; fill:#333; }
  .gnode .ex  { font-size:11px; fill:#444; }
  .gnode .pf  { font-size:10px; fill:#888; font-family:ui-monospace, monospace; }
  .gnode .tt  { font-size:9px; fill:#8a5300; }
  .gnode .tt.warn { font-size:11px; }
  .legend2 { color:var(--dim); font-size:11px; margin:2px 0 10px; display:flex; gap:18px; flex-wrap:wrap; }
  .legend2 svg { vertical-align:middle; }
  .cont { font-size:12px; color:#6b5a10; background:#fffbe8; border:1px solid #f0e3b0;
          border-radius:5px; padding:6px 10px; margin:6px 0; }
  .cont.dim { color:var(--dim); background:#fafafa; border-color:var(--line); }`;
}

/**
 * 完整的静态 HTML。
 *
 * **2026-09-30 改道**:这里原来渲染的是「缩进列表 + 一长串 data-detail 表格行」,
 * 同一个节点在页面里出现两次(而且都没画成图)。手写 SVG 那条路
 * (`treeSvg`)画不出 DAG —— 它是递归树布局,每个节点只能有一个父,
 * 所以 `vis2→graph1→flat1→…` 那条链被摊平成并列方块。
 *
 * 现在图交给 mermaid(`lib/mermaid.mjs`),**只留一套渲染**。
 * `treeSvg` / `treeHtml` / `nodeHtml` 已删 —— 留着就是两套并存,
 * 那正是上一版"同一个节点出现三次"的成因。
 *
 * `buildTree` **保留**:`bg serve` 和终端版还在用它取数据。
 */
export function renderHtml(dir) {
  const g = graphData(dir);
  return mermaidHtml(g, {
    title: `节点图 · ${String(dir).split("/").pop()}`,
    treeY: workingTreeHash(dir),
  });
}
