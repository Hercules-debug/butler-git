/**
 * view.mjs —— 渲染。**只画,不算。**
 *
 * 两盏灯:
 *
 *     ●●  通过过,现在也对
 *     ●○  通过过,但现在已经坏了    <- 回归
 *     ○●  没通过过,但现在能过
 *     ○○  没通过过,现在也不过
 *     ·   第二盏没算(它是参考,不该让"看一眼"变贵)
 *     –   没有门禁,第二盏对它没有意义
 *
 * 图例常驻 —— 符号没人解释就等于没有。
 */

import { buildTree, flatten, L2 } from "./lights.mjs";

const CH = {
  [L2.pass]: "●",
  [L2.fail]: "○",
  [L2.unchecked]: "·",
  [L2.none]: "–",
  [L2.off]: "·",
};

const l1 = (v) => (v.light1 ? "●" : "○");
const l2 = (v) => CH[v.light2] ?? "·";

function note(v) {
  const tail = [];
  if (v.light2 === L2.fail) tail.push("通过过,但现在坏了");
  else if (v.light2 === L2.unchecked) tail.push("未复查");
  if (!v.light1 && v.light2 === L2.pass) tail.push("能过,但没通过过");
  if (v.belowRed && v.light2 !== L2.fail) tail.push("↓ 底下有红的");
  else if (v.belowUnchecked && v.light2 === L2.pass) tail.push("↓ 底下有未复查");
  if (v.owner === "user") tail.push("人定");
  return tail.length ? `   (${tail.join("; ")})` : "";
}

/** 标准树形:根不带枝,子节点带 ├─ / └─,并按祖先是否末位续上竖线。 */
function renderNode(v, prefix = "", isLast = true, isRoot = true) {
  const branch = isRoot ? "" : (isLast ? "└─ " : "├─ ");
  const out = [`${prefix}${branch}${v.id}  ${l1(v)}${l2(v)}  ${v.expect}${note(v)}`];

  const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");
  const kids = v.children;
  kids.forEach((c, i) => {
    out.push(...renderNode(c, childPrefix, i === kids.length - 1, false));
  });
  return out;
}

/** 树 + 心跳 + 图例。 */
export function render(dir, { light2 = "cheap", task = null } = {}) {
  let views = buildTree(dir, { light2 });
  if (task) views = views.filter((v) => v.id === task);
  if (!views.length) return "(图是空的。先声明一个节点)";

  const lines = [];
  views.forEach((v, i) => {
    if (i) lines.push("");
    lines.push(...renderNode(v, ""));
  });

  const flat = flatten(views);
  const acceptedN = flat.filter((v) => v.light1).length;
  const notYet = flat.length - acceptedN;
  const broken = flat.filter((v) => v.light1 && v.light2 === L2.fail);

  const health = [];
  if (notYet) health.push(`${notYet} 个没通过过`);
  if (broken.length) {
    health.push(`${broken.length} 个通过过但现在已经坏了(${broken.map((v) => v.id).join(", ")})`);
  }
  lines.push("");
  lines.push(`● ${health.length ? health.join("、") : "干净"}`);
  lines.push(`图例  第一盏: ● 通过过 / ○ 没通过过     第二盏: ● 现在过 / ○ 现在坏了 / · 未复查 / – 无检测`);
  return lines.join("\n");
}

/** 单节点细节:门禁逐条 + 证据锚。 */
export function renderDetail(dir, id, { light2 = "full" } = {}) {
  const all = flatten(buildTree(dir, { light2 }));
  const v = all.find((x) => x.id === id);
  if (!v) return `节点 ${id} 不存在`;

  const out = [`── ${id}  ${v.expect}  [${l1(v)}${l2(v)}] ──`];
  out.push(`  第一盏  ${v.light1 ? "通过过" : "没通过过"}(读账本,历史事实)`);
  out.push(`  第二盏  ${v.light2}(跑检查,只是参考)`);
  if (v.owner) out.push(`  所有权  ${v.owner}${v.owner === "user" ? "(人定的 —— 模型改不动)" : "(模型自己拆的)"}`);

  if (v.evidence) {
    const t = v.evidence.tree;
    out.push(`  证据锚  树=${t ? t.slice(0, 12) : "(拿不到)"}  时间=${v.evidence.ts}`);
  }

  const n = v.node;
  if (n) {
    if (n.allow?.length) out.push(`  可写边界  ${n.allow.join(" ")}`);
    out.push("  门禁");
    if (n.fs?.tree) out.push(`    tree = ${n.fs.tree.slice(0, 12)}`);
    for (const a of n.fs?.paths ?? []) {
      out.push(`    fs ${a.kind}(${a.path}${a.pattern ? `:${a.pattern}` : ""})`);
    }
    for (const p of n.proc?.present ?? []) out.push(`    proc_present(${p})`);
    for (const p of n.proc?.absent ?? []) out.push(`    proc_absent(${p})`);
    if (n.verify) out.push(`    verify(${n.verify})`);
  }

  if (v.items?.length) {
    out.push("  逐条核对");
    for (const i of v.items) {
      const mark = i.status === "ok" ? "✓" : i.status === "fail" ? "✗" : "?";
      out.push(`    ${mark} ${i.label}  ${i.detail}`);
      if (i.demand) out.push(`        -> 要求: ${i.demand}`);
    }
  }
  return out.join("\n");
}

/** 心跳一行。只报第一盏(便宜、永远算得起)。 */
export function healthLine(dir) {
  const flat = flatten(buildTree(dir, { light2: "off" }));
  if (!flat.length) return "● 还没有节点";
  const acceptedN = flat.filter((v) => v.light1).length;
  const notYet = flat.length - acceptedN;
  return notYet ? `● ${notYet} 个没通过过` : "● 干净";
}
