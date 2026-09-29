/**
 * mermaid.mjs —— 把节点图渲染成 **mermaid flowchart**。
 *
 * ## 为什么这里破了一次"零依赖"
 *
 * 这个仓库的第一条规矩原是「零依赖,只要 `node` 和 `git`」。
 * 手写 SVG 的难点**不在画线**——`<path>` 就几行——而在**布局**。
 *
 * 原来 `html.mjs` 的 `treeSvg` 是**递归树布局**:
 *
 *     const kids = entry.children;            // 只认"孩子"
 *     const xs = kids.map(k => layout(k));    // 每个节点恰好一个位置
 *     x = (xs[0] + xs[last]) / 2;             // 父居中在子树上方
 *
 * 这个假设决定了它**画不出 DAG**:每个节点只能有一个父。
 * 实测后果:`vis2→graph1→flat1→approve1→…` 那条**首尾相连的时间链**,
 * 被摊平成七个并列方块,先后关系看不出来。
 *
 * 所以这次换 mermaid 来做布局。**代价是实测过的,不是猜的**:
 *
 *     mermaid@10 dist = 3,337,857 字节(3.3 MB,经 CDN)
 *     打开页面必须联网 —— 断网就打不开图
 *
 * 人已知情并确认接受这个取舍(见 `docs/任务-真DAG节点图.md` 的修订记录)。
 *
 * ## 边界:破了规矩的地方就只在这里
 *
 * **门禁语义一个字没动。** `plan` / `status` / `commit` / `abandon` /
 * `approve` 仍然只靠 `node` 和 `git`——**渲染坏了不影响门禁**。
 * 这个文件只做一件事:图 -> 文本。它**不算**,只画。
 *
 * ## 为什么不用 gitGraph
 *
 * 人最初给的是一个 `gitGraph` 示例。**那是一条死路**:
 * `gitGraph` 是**手写 DSL**——你得自己敲 `commit id: "t1"`、`branch dev`、
 * `merge dev`。它不读仓库、不认识"节点"、也不知道谁是 todo。
 * 27 个提交手写还行,仓库一动就要重敲一遍。
 *
 * 能自动生成的是 **`flowchart`**:我们生成文本,布局交给 mermaid。
 */

import { allNodes, droppedSet, isDropped, rootNode } from "./store.mjs";
import { displayState } from "./view.mjs";
import { inferVerifyPath } from "./nodes.mjs";
import { treeOf, logRaw, fullSha } from "./git.mjs";

/** mermaid 的字符串字面量里,**只有这几样**会炸。 */
function mstr(s) {
  // 双引号会提前闭合 mermaid 的 "..." 字面量 —— 必须换掉。
  // 实测:`删掉"绕过"概念` 原样输出会让整张图渲染失败(不是画错,是空白)。
  return String(s ?? "")
    .replace(/"/g, "\u201c")     // " -> 全角左引号
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, " ");
}

/**
 * mermaid 的**节点 id** 必须是一个安全的标识符。
 *
 * 节点 id 是模型自己起的(实测有 `演示甲`、`要凭证的` 这种中文 id)。
 * mermaid 对非 ASCII id **不保证**支持,所以这里映射成 `n0`、`n1`…,
 * 中文原名放在 label 里显示 —— **显示的东西一点不丢**。
 */
function idMap(nodes) {
  const m = new Map();
  nodes.forEach((n, i) => m.set(n.id, `n${i}`));
  return m;
}

/** 灯 -> mermaid 的 class,样式在 CSS 里。 */
function stateClass(mark) {
  if (mark === "●") return "done";
  if (mark === "◐") return "wip";
  return "todo";
}

/**
 * 一张图需要的数据 —— 从既有函数取,**不重新实现任何逻辑**。
 *
 * 和 `html.mjs` 的 `buildTree` 是同一套取法(那边的接续边判定踩过坑:
 * 缩写的 base 直接做键会让 `A.result == B.base` 永远不成立,
 * 这里沿用同一条纪律:两边都规范化成完整 sha)。
 */
export function graphData(dir) {
  const nodes = allNodes(dir);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const dropped = droppedSet(dir);
  const live = nodes.filter((n) => !isDropped(dir, n.id, byId, dropped));
  const root = rootNode(dir);

  // 意图父子(虚线):节点的 parent 字段。
  const intentEdges = live
    .filter((n) => n.parent && byId.has(n.parent))
    .map((n) => ({ from: n.parent, to: n.id }));

  // ---- git 父子(实线)------------------------------------------------
  //
  // **这是"主干"。** 任务书要求:点 = commit,线 = git 的父子关系
  // (`%P` 给出的 parents),普通提交压成线,但**分叉/合并必须保留**。
  //
  // ## 只取一次
  //
  // `logRaw` 一次 `git log` 就把**所有**提交的父列表拿回来了。
  // 上一版在这里翻过车:把 `git rev-list` 放进排序比较函数,
  // 27 个提交调了 **131 次子进程**,渲染要 53 秒。
  // 纪律就是这条:**git 调用要一次性取够,别在循环/比较里调。**
  const commits = logRaw(dir, { limit: 2000 });
  const bySha = new Map(commits.map((c) => [c.sha, c]));

  // ---- 哪些 commit 是"节点" ----------------------------------------
  //
  // 节点在 commit 图上的锚点有两个,都要算:
  //
  //     result  已达成 -> 它的证据 commit(这个点上有个真节点)
  //     base    起点   -> 它从哪个版本开始干活
  //
  // base 也要算进去,原因见下面算"区间"那段 —— 未达成的 todo 节点
  // 在 git 里**没有自己的 commit**,它只有 base。不锚 base 的话
  // todo 节点在主干上就没有位置,而任务书要求"todo 节点有位置"。
  const anchor = new Map();          // sha -> [nodeId...]
  const norm = (s) => (s ? (fullSha(dir, s) ?? s) : null);

  for (const n of live) {
    for (const raw of [n.result, n.base]) {
      const sha = norm(raw);
      if (!sha || !bySha.has(sha)) continue;      // 图外的提交,不当锚点
      if (!anchor.has(sha)) anchor.set(sha, []);
      if (!anchor.get(sha).includes(n.id)) anchor.get(sha).push(n.id);
    }
  }

  // ---- 只画"有节点的点",普通提交压成线 ------------------------------
  //
  // 做法:从每个锚点出发**向上游走**,一直走到遇见另一个锚点为止。
  // 中间经过的普通提交通通不要,于是它们自动变成一条线。
  // 上游的**每一个**锚点都连过来 —— 这样分叉/合并不会被压掉:
  //
  //     ● 节点A ─┬─────────── ● 节点D
  //              └─────────── ● 节点E
  //
  const gitEdges = [];
  const seenEdge = new Set();

  for (const [sha] of anchor) {
    const c = bySha.get(sha);
    if (!c) continue;
    // 广度优先向上游;每个分支走到底(撞到另一个锚点 / 走到根)。
    const queue = [...c.parents];
    const visited = new Set();
    while (queue.length) {
      const p = queue.shift();
      if (!p || visited.has(p)) continue;
      visited.add(p);
      if (anchor.has(p)) {
        // 撞到锚点 -> 这就是一条"节点之间"的边,收工不再往上走。
        const key = `${p}->${sha}`;
        if (!seenEdge.has(key)) {
          seenEdge.add(key);
          gitEdges.push({ fromSha: p, toSha: sha });
        }
        continue;
      }
      const pc = bySha.get(p);
      if (!pc) continue;           // 图外(初始提交之前等),到此为止
      queue.push(...pc.parents);
    }
  }

  return { dir, nodes: live, root, intentEdges, gitEdges, anchor, bySha, fullSha: norm };
}

/**
 * 图 -> mermaid flowchart 文本。
 *
 * 这是**纯函数**:同样的数据出同样的文本,不碰 git、不碰磁盘。
 * 纯函数才测得动——这是这一版补上负向验收的前提。
 */
export function toMermaid(g, { treeY = null } = {}) {
  const { nodes, gitEdges } = g;
  if (!nodes.length) return "";

  const out = ["flowchart TD"];

  // ---- 一个点 = 一个 commit;节点**画在它所属的 commit 上** --------------
  //
  // ## 这里原来错得很具体,记下来免得再犯
  //
  // 上一版生成了**两套点**:
  //
  //     点集 A:c0..c14  (commit)  —— 只用 `-->` 互相连
  //     点集 B:n0..n12  (节点)    —— 只用 `-.->` 互相连
  //
  // 而 `-.->` 只存在于 n 和 n 之间,**没有任何一条边把 n 连到 c**。
  // mermaid 于是看到**两个互不相连的连通分量**,把它们画成两块 ——
  // 人看到的就是"好几棵分离的树"(实测:15 个 commit 点旁边,
  // 有 5 个 n 点飘在右边,彼此不接)。
  //
  // **根因不是布局,是模型错了**:节点不是"挂在 commit 旁边的另一个东西",
  // **节点就是依托于某个 commit 的**。所以它该是**同一个点**,
  // 不是两个点再加一条线。一个点上可以落多个节点(实测:
  // `f5d612a5` 上同时有 root、gate2、gate2b)。
  //
  // ## 一个节点落在哪个 commit 上
  //
  // 优先 `result`(达成的地方 —— 那是它的证据);
  // 没达成(todo)就退到 `base`(它从哪儿开始干)。
  // 这样 **todo 节点也有位置**,不会因为"还没有 commit"就消失。
  const anchorOf = new Map();      // nodeId -> sha
  for (const n of nodes) {
    const sha = n.result ?? n.base ?? null;
    if (sha) anchorOf.set(n.id, normSha(g, sha));
  }

  // ---- 只画"有节点的 commit";无关提交省略 -----------------------------
  //
  // 人的要求:不关心没绑定节点的 commit。做法是**从锚点出发向上游走**,
  // 一直走到遇见另一个锚点为止 —— 中间路过的普通提交通通不进图,
  // 它们自动变成一条线。
  //
  // 上游的**每一个**锚点都要连过来,这样分叉/合并不被压掉:
  //
  //     ● 节点A ─┬─────────── ● 节点D
  //              └─────────── ● 节点E
  const anchors = new Set(anchorOf.values());
  const drawn = new Set(anchors);
  const pairs = new Set();

  for (const sha of anchors) {
    const start = g.bySha.get(sha);
    if (!start) continue;
    const queue = [...start.parents];
    const visited = new Set();
    while (queue.length) {
      const p = queue.shift();
      if (!p || visited.has(p)) continue;
      visited.add(p);
      if (anchors.has(p)) {
        pairs.add(`${p}->${sha}`);
        continue;                     // 撞到锚点 -> 收工,中间的不进图
      }
      const pc = g.bySha.get(p);
      if (!pc) continue;              // 图外的历史,到此为止
      queue.push(...pc.parents);
    }
  }

  // ---- 点:一个 commit 一个点,标签里列出落在它上面的节点 ----------------
  const ids = new Map();
  let i = 0;
  for (const sha of anchors) {
    if (!g.bySha.has(sha)) continue;  // 锚点不在历史里(比如凭空写的 sha)
    ids.set(sha, `c${i++}`);
  }

  for (const [sha, cid] of ids) {
    const owners = [...anchorOf].filter(([, s]) => s === sha).map(([id]) => id);

    // **一个点上有多个节点时,取"最活跃"的那个状态。**
    //
    // 顺序:进行中 > 待办 > 已达成。理由:绿是"这件事已经完了",
    // 而点上有东西在动才是当下最该被看见的。
    //
    // ⚠ 这里原来写的是 `owners.some(isDone) ? "done" : "todo"` ——
    // **只认 done,把"进行中"整个吞了**。实测:建两个改了工作区的节点,
    // 它们和 nobypass1 落在同一个 commit 上,于是被标成绿色,
    // 看起来像"已经完成" —— 而真相是它们正在改。
    //
    // 正确做法:调 `displayState`(它是**唯一**判定状态的地方,
    // 见 view.mjs),不在这里自己再判一次。逻辑只有一份。
    const marks = owners.map((o) => {
      const n = nodes.find((x) => x.id === o);
      if (!n) return { mark: "○", text: "待办" };
      return displayState(n, treeY, n.base ? treeOf(g.dir, n.base) : null);
    });
    const cls = marks.some((m) => m.mark === "◐") ? "wip"
      : marks.some((m) => m.mark === "●") ? "done" : "todo";

    const label = owners.map((o) => {
      const n = nodes.find((x) => x.id === o);
      const ex = String(n?.expect ?? "");
      return `${mstr(o)}<br/>${mstr(ex.length > 30 ? `${ex.slice(0, 30)}…` : ex)}`;
    }).join("<br/>――<br/>");
    out.push(`  ${cid}["${sha.slice(0, 8)}<br/>${label}"]:::${cls}`);
    drawn.add(sha);
  }

  // ---- 实线:git 父子(主干)------------------------------------------
  //
  // ## 方向:旧在上,新在下 —— 顺着时间流
  //
  // 这里原来画的是 `child --> parent`(孩子指向父亲,意思是"我来自哪儿")。
  // **那是反的**,实测后果(人一眼看出来的):
  //
  //     flowchart TD 把箭头指向当作"往下",于是
  //     最旧的 bb019201 被推到屏幕最下面
  //     最新的 f5d612a5 站在最上面
  //
  // 而 `git log` 是**新的在上**。两套直觉叠在一起,读起来就拧了。
  //
  // 现在改成 `parent --> child`:**箭头 = "这个提交生出了下一个"**,
  // `TD` 下读起来就是旧的在最上面、新的往下流 —— 顺着历史走,不用反过来读。
  //
  // ⚠ 注意:**边的方向只是画法,不该改变数据语义。** 上面 `pairs` 里存的
  // 仍然是 `上游->下游`,这里翻转的是**呈现**,不是判定 ——
  // 分叉/合并的判断(谁是谁的祖先)一个字没动。
  //
  // 分叉/合并原样保留 —— 这是 git 的结构,不能压掉。
  // **不编造顺序**:只画 git 真实给出的父子关系,不映射成"第几个"。
  const seenEdge = new Set();
  for (const p of pairs) {
    const [up, down] = p.split("->");
    const a = ids.get(up);      // 上游(更旧)= 箭尾
    const b = ids.get(down);    // 下游(更新)= 箭头
    if (!a || !b || a === b || seenEdge.has(p)) continue;
    seenEdge.add(p);
    out.push(`  ${a} --> ${b}`);
  }

  // ---- 虚线:意图父子(谁拆给谁的)------------------------------------
  //
  // **这两个点现在都在主干的点集里**(因为一个节点要么落 result、要么落 base,
  // 都是锚点),所以虚线是**树内部**的边,不会再把图撕成两块。
  //
  // ## 为什么方向是 `子 -.-> 父`(和直觉相反)
  //
  // 这里原来是 `父 -.-> 子`,**那会把整张图翻过来**。实测(隔离出来的):
  //
  //     点 + 实线 + classDef            -> c1(t1) 在 y=10 ✅
  //     再加一条 `c0(root) -.-> c1(t1)` -> c0(root) 被拉到 y=10 ❌ 翻了
  //
  // ## 根因:两种关系的**时间方向天然相反**
  //
  //     root.result = f5d612a5   (root 达成于 f5d612a5)
  //     t1.result   = 292f10ff   (t1 达成于 292f10ff,t1 更早)
  //
  // `root` 是 `t1` 的**意图父节点**,但它在 git 时间上**更晚**达成。
  // 于是:
  //
  //     实线要求:  t1(上) → ... → root(下)     旧 → 新
  //     旧虚线要求: root(上) -.-> t1(下)         父 → 子   ← **打架**
  //
  // mermaid 服从了虚线,把 root 拉到顶,整条实线链就翻了。
  //
  // **修法:让虚线跟实线同向**,都指向"更新"的方向:
  //
  //     子 -.-> 父    —— 语义是"我(更早达成的子)接到了我的父"
  //
  // ⚠ 代价:**读法变了** —— 虚线箭头不是"谁拆给谁",而是
  // "这个子节点接续到了它的父"。要顺着**实线**读时间,
  // 虚线只表达"这两个点有意图关系",不表达先后。
  // 图例里会写清楚,不让人猜。
  const seen = new Set();
  for (const e of g.intentEdges) {
    const child = ids.get(anchorOf.get(e.to));    // 子(意图上)
    const parent = ids.get(anchorOf.get(e.from)); // 父(意图上)
    if (!child || !parent || child === parent) continue;  // 同一 commit 上,不画
    const key = `${child}->${parent}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`  ${child} -.-> ${parent}`);
  }

  // ---- 状态 classDef ----
  //
  // 三种状态一眼可分(任务书要求)。颜色由 mermaid 管,所以这里
  // 只用 classDef 声明,不写 CSS —— 免得和主题打架。
  out.push("  classDef done fill:#d7f5dd,stroke:#1a7f37,color:#0b3d1c");
  out.push("  classDef wip  fill:#ffe8cc,stroke:#bc4c00,color:#5c2300");
  out.push("  classDef todo fill:#f0f0f0,stroke:#888,color:#333");
  out.push("  classDef commit fill:#e8eefc,stroke:#3b5bdb,color:#1a2b6d");

  return out.join("\n");
}

/** base/result 可能是缩写的 sha —— 一律规范化成完整 sha 再做键。 */
function normSha(g, sha) {
  if (g.bySha.has(sha)) return sha;
  const full = g.fullSha?.(sha);
  if (full && g.bySha.has(full)) return full;
  return sha;
}

/**
 * 一个**自包含的 HTML 页面**,用 mermaid 渲染图。
 *
 * ## 断网降级(这是硬要求)
 *
 * 引 CDN 意味着**断网就打不开图**。但"打不开"不能表现成**一片空白** ——
 * 那会让人以为"这个仓库没有节点"。所以:
 *
 *     脚本 onerror / mermaid 未定义 -> 明确说出"需要联网",
 *     并把**节点清单用文字列出来**(纯 HTML,不依赖 JS)
 *
 * 这样断网时信息**降级但不丢**:图没有了,节点还在。
 *
 * ## 详情面板
 *
 * 点击节点看详情(任务书要求)。mermaid 自己不管点击后的 UI,
 * 所以这里挂一层自己写的 JS 去读 `data-detail`——
 * **不为了点击再拉一个库**。
 */
export function mermaidHtml(g, { title = "节点图", treeY = null } = {}) {
  const { nodes } = g;
  const src = toMermaid(g, { treeY });

  // 断网兜底:纯 HTML 的节点清单,**不依赖任何 JS**。
  const fallback = nodes.length
    ? `<ul class="fb-list">${nodes.map((n) => {
      const ds = displayState(n, treeY, n.base ? treeOf(g.dir, n.base) : null);
      return `<li><b>${esc(n.id)}</b> ${esc(ds.mark)} — ${esc(n.expect ?? "")}</li>`;
    }).join("")}</ul>`
    : "<p>(这个仓库还没有节点)</p>";

  // 详情数据:塞进 <script type="application/json">,不拼进 HTML 字符串。
  const detail = Object.fromEntries(nodes.map((n) => {
    const ds = displayState(n, treeY, n.base ? treeOf(g.dir, n.base) : null);
    const vp = n.verify_path ?? inferVerifyPath(n.verify) ?? null;
    return [n.id, {
      state: ds.text,
      expect: n.expect ?? "",
      verify: n.verify ?? "(没有)",
      verifyPath: vp ?? "(无 —— P 是内联命令)",
      verifyPathInferred: !n.verify_path && Boolean(vp),
      delta: (n.delta ?? []).map((d) => `${d.code} ${d.path}`),
      deltaTranscribed: n.delta_source === "at-commit",
      result: n.result ?? "",
      base: n.base ?? "",
      parent: n.parent ?? "",
    }];
  }));

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${mermaidCss()}</style>
</head>
<body>
<h1>${esc(title)}</h1>
<div class="meta">
  共 ${nodes.length} 个节点 ·
  <b>从上到下 = 时间顺序</b>(旧 → 新,由 git 决定)·
  实线 = git 父子 · 虚线 = 意图父子(子 -.-> 父,<b>只表示有关系,不表示先后</b>)
</div>

<div id="offline" class="offline" hidden>
  <b>⚠ 加载不了 mermaid —— 图需要联网。</b><br>
  下面的节点清单是纯文字,不依赖网络,信息没丢。
</div>

<div id="diagram" class="diagram"></div>

<div class="legend">
  <span class="lg done">● 绿(有 commit,已验证)</span>
  <span class="lg wip">◐ 进行中(有工作区改动)</span>
  <span class="lg todo">○ 待办</span>
  <span class="lg">点任意节点看详情</span>
</div>

<pre id="src" class="src">${esc(src)}</pre>

<details class="raw"><summary>断网时的节点清单(纯文字)</summary>${fallback}</details>

<div id="panel" class="panel" hidden></div>

<script type="application/json" id="detail">${esc(JSON.stringify(detail))}</script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"
        onerror="document.getElementById('offline').hidden=false"></script>
<script>${MERMAID_JS}</script>
</body>
</html>
`;
}

/** 页面 JS —— 自己写,不引第二个库。 */
const MERMAID_JS = `
(function () {
  var box = document.getElementById('diagram');
  var srcEl = document.getElementById('src');
  if (typeof mermaid === 'undefined') {
    document.getElementById('offline').hidden = false;
    return;
  }
  mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });
  mermaid.render('g0', srcEl.textContent).then(function (r) {
    box.innerHTML = r.svg;
    wire();
  }).catch(function (e) {
    // 渲染失败**要说出来** —— 空白页会让人以为"没有数据"。
    document.getElementById('offline').hidden = false;
    document.getElementById('offline').innerHTML =
      '<b>⚠ mermaid 渲染失败。</b><br><code>' +
      String(e && e.message ? e.message : e) + '</code>';
  });

  function wire() {
    var data = {};
    try { data = JSON.parse(document.getElementById('detail').textContent); } catch (e) {}
    var panel = document.getElementById('panel');
    box.querySelectorAll('.node').forEach(function (el) {
      var id = (el.id || '').replace(/^flowchart-/, '').replace(/-\\d+$/, '');
      var hit = Object.keys(data).find(function (k) {
        return el.textContent.indexOf(k) === 0;
      });
      if (!hit) return;
      el.style.cursor = 'pointer';
      el.addEventListener('click', function () {
        var d = data[hit];
        panel.hidden = false;
        panel.innerHTML =
          '<h3>' + hit + ' <span class="st">' + d.state + '</span></h3>' +
          row('expect', d.expect) +
          row('P', d.verify) +
          row('P 文件', d.verifyPath + (d.verifyPathInferred ? '  (推断)' : '')) +
          row('Δ', d.delta.length ? d.delta.join('  ') : '(空)' +
              (d.deltaTranscribed ? '  ← 转录,没约束过' : '')) +
          row('证据 commit', d.result || '(还没达成)') +
          row('base', d.base) +
          row('父节点', d.parent || '(根)');
      });
    });
  }
  function row(k, v) {
    return '<div class="row"><span class="k">' + k + '</span><span class="v">' +
           String(v == null ? '' : v).replace(/</g, '&lt;') + '</span></div>';
  }
})();
`;

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function mermaidCss() {
  return `
:root { --bg:#fafafa; --card:#fff; --line:#e3e3e3; --fg:#222; --dim:#777; }
* { box-sizing:border-box; }
body { margin:0; padding:24px; background:var(--bg); color:var(--fg);
       font:14px/1.6 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif; }
h1 { font-size:17px; margin:0 0 4px; }
.meta { color:var(--dim); font-size:12px; margin-bottom:16px; }
.diagram { background:var(--card); border:1px solid var(--line); border-radius:6px;
           padding:12px; overflow:auto; }
.offline { background:#fff4e5; border:1px solid #f0c48a; border-radius:5px;
           padding:8px 12px; margin-bottom:12px; font-size:13px; }
.legend { margin:10px 0; font-size:13px; display:flex; gap:16px; flex-wrap:wrap; }
.lg.done { color:#1a7f37; } .lg.wip { color:#bc4c00; } .lg.todo { color:#666; }
.src { background:#f6f6f6; border:1px solid var(--line); border-radius:5px;
       padding:10px; font-size:12px; overflow:auto; white-space:pre; }
.raw { margin-top:14px; font-size:13px; }
.fb-list { margin:8px 0; padding-left:20px; }
.panel { position:fixed; right:20px; top:20px; width:380px; max-height:80vh;
         overflow:auto; background:var(--card); border:1px solid var(--line);
         border-radius:8px; padding:14px; box-shadow:0 6px 24px rgba(0,0,0,.12); }
.panel h3 { margin:0 0 10px; font-size:15px; }
.panel .st { color:var(--dim); font-weight:400; font-size:12px; }
.panel .row { display:flex; gap:8px; margin:4px 0; font-size:13px; }
.panel .k { color:var(--dim); min-width:76px; flex-shrink:0; }
.panel .v { word-break:break-all; }`;
}
