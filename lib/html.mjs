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
import { displayState, findBypass, gateFlags } from "./view.mjs";
import { head, workingTreeHash, treeOf } from "./git.mjs";

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
 * 一个节点的卡片。
 *
 * 用 `<details>` 做折叠 —— **原生、零 JS**。
 * 子节点递归嵌在父的 details 里,于是折叠父就折叠了整棵子树。
 */
function nodeHtml(n, children, depth, ctx) {
  const ds = displayState(n, ctx.treeY, treeOf(ctx.dir, n.base));
  const transcribed = n.delta_source === "at-commit";
  const flags = gateFlags(n);

  const deltaBody = n.delta?.length
    ? n.delta.map((d) => (
      `<span class="d"><b>${esc(d.code)}</b> ${esc(d.code === "R" ? `${d.path} → ${d.to}` : d.path)}</span>`
    )).join(" ")
    : `<span class="empty">${
      n.state === "done"
        ? "(空 —— 达成时没有预测,只有 P 在承重)"
        : "(空)"
    }</span>`;

  const kids = children.length
    ? `<ul class="tree">${children.map((c) => nodeHtml(c.node, c.children, depth + 1, ctx)).join("")}</ul>`
    : "";

  return `
<li class="node ${markClass(ds.mark)}">
  <details${depth < 2 ? " open" : ""}>
    <summary>
      <span class="mark">${ds.mark}</span>
      <code class="id">${esc(n.id)}</code>
      <span class="expect">${esc(n.expect)}</span>
      ${transcribed ? '<span class="tag warn">Δ 转录 · 非预测</span>' : ""}
      ${n.state === "done" ? `<span class="ev">${esc(short(n.result))}</span>` : ""}
    </summary>
    <div class="body">
      <div class="row"><span class="k">P</span><code class="v">${esc(n.verify ?? "(没有)")}</code></div>
      <div class="row"><span class="k">Δ</span><span class="v">${deltaBody}${
  transcribed ? '<span class="tag warn sm">← 照实际抄的,没约束过</span>' : ""
}</span></div>
      ${n.base ? `<div class="row"><span class="k">base</span><code class="v">${esc(short(n.base))}</code></div>` : ""}
      ${flags.map((f) => `<div class="flag">⚠ ${esc(f)}</div>`).join("")}
    </div>
  </details>
  ${kids}
</li>`;
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
  const bypass = findBypass(dir, nodes);
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

  return {
    dir,
    head: head(dir),
    // 给 displayState 看工作区用 —— 少了它 `◐ 进行中` 永远不亮。
    // 见 view.mjs 那段注释:workingTreeHash 本身是好的,只是以前没人调。
    treeY: workingTreeHash(dir),
    roots,
    bypass,
    stats: {
      done: live.filter((n) => n.state === "done").length,
      todo: live.filter((n) => n.state !== "done").length,
      total: live.length,
    },
    at: new Date().toISOString(),
  };
}

/**
 * 整棵树 -> HTML 片段(不含 <html> 外壳)。
 *
 * `serve` 要把这段塞进自己的壳里,所以外壳和内容是分开的。
 */
export function treeHtml(t) {
  const { roots, bypass, stats } = t;

  const body = roots.length
    ? `<ul class="tree">${roots.map((r) => nodeHtml(r.node, r.children, 0, t)).join("")}</ul>`
    : '<p class="empty">(图是空的)</p>';

  const bypassHtml = bypass.length
    ? `<div class="bypass"><h2>⚠ ${bypass.length} 个提交不在图里</h2>
       <ul>${bypass.slice(0, 20).map((b) => `<li><code>${esc(short(b.sha))}</code> ${esc(b.subject)}
         <span class="why">没有 bg-node trailer —— 绕过了门禁</span></li>`).join("")}</ul></div>`
    : "";

  const at = new Date(t.at).toLocaleString("zh-CN");

  return `
<h1>节点树 · <code>${esc(t.dir)}</code></h1>
<div class="meta">HEAD ${esc(short(t.head))} · ${at}</div>
<div class="stats"><b>${stats.done}</b> 绿 · <b>${stats.todo}</b> 待达成 · 共 ${stats.total} 个节点</div>
${body}
${bypassHtml}
<div class="legend">● 绿(有 commit,已验证) &nbsp; ◐ 进行中(有工作区改动) &nbsp; ○ 待办</div>
`;
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
  .bypass { margin-top:20px; background:#fff8f8; border:1px solid #f0d0d0; border-radius:6px; padding:10px 14px; }
  .bypass h2 { font-size:13px; margin:0 0 6px; color:#a33; }
  .bypass li { font-size:12px; margin:3px 0; }
  .why { color:var(--dim); }
  .legend { margin-top:20px; color:var(--dim); font-size:12px; }
  .live { font-size:11px; color:var(--dim); margin-left:8px; }
  .live b { color:#1a7f37; }
  .live.off b { color:#a33; }`;
}

/** 完整的静态单文件 HTML。 */
export function renderHtml(dir) {
  const t = buildTree(dir);
  return `<!DOCTYPE html>
<meta charset="utf-8">
<title>节点树 · ${esc(String(dir).split("/").pop())}</title>
<style>${styleCss()}
</style>
${treeHtml(t)}
`;
}
