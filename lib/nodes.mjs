/**
 * nodes.mjs —— 节点的写路径:**plan / commit / abandon**,加只读的 status。
 *
 * ## 节点是「意图」,commit 是「证据」
 *
 * 节点先存在(你要达成什么),commit 后出现(你做完了什么)。
 * 两者不是相等关系,而是**达成关系**:节点达成时,留下一个 commit 作为证据。
 *
 * ## 权威在 .bg/,证据在 commit
 *
 *     图(.bg/nodes.json)  当前状态 —— 权威
 *     commit trailer      证据 —— 不可变、可重放、带 verified-tree 防篡改
 *
 * 绿是"这个节点达成了,并且那次达成的证据还在"。校验时比
 * `commit^{tree} == bg-verified-tree`,不等就是被 amend 过 —— 伪造的绿。
 *
 * ## 两道门
 *
 *    1. **达成之后,门禁冻结** —— 连人也不能直接改。
 *       要变,起一个**新节点**把改动做出来(历史不改写,旧节点保持绿)。
 *    2. **owner=user 且已经有一份门禁** -> 模型改不动,要人授权。
 *
 * ## 为什么"达成"之后就冻结
 *
 * 因为那次达成是**历史事实** —— 它当时确实被验过,这件事永远为真。
 * 让你回头改门禁,等于让"当时的验收"变成一句无法核对的话。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  appendLedger, getNode, putNode, allNodes, withLock, nowIso, paths,
} from "./store.mjs";
import { evaluateGate, probeWeakVerify } from "./gate.mjs";
import { selfCheck } from "./delta.mjs";
import { canModify, holds, issue } from "./cap.mjs";
import {
  workingTreeHash, diffNameStatus, treeOf, commitTree, updateHead,
  readIndexFromHead, mergeHeads, indexTree, unmergedPaths, clearMergeState,
  isAncestor, head, isRepo, git,
} from "./git.mjs";

/** 把节点补成完整形状。缺的部分给空,不猜。 */
export function normalize(c) {
  return {
    id: c.id,
    parent: c.parent ?? null,
    owner: c.owner ?? "model",
    expect: (c.expect ?? "").trim(),
    // **必须显式给。** 不给就报错,不偷偷用 HEAD 兜 ——
    // "从哪个 commit 开始"是节点属性,默认值会让它变成一句模糊的话。
    base: c.base ?? null,
    delta: c.delta ?? [],
    delta_source: c.delta?.length ? (c.delta_source ?? "before-work") : null,
    verify: c.verify ?? null,
    // **P 的程序文件在哪**(可选)。
    //
    // P 是一条**命令**,不是路径 —— `grep -q ok root.txt` 里哪个算
    // "验证程序"根本判不出来(`root.txt` 是被验对象)。所以这个字段
    // **只能显式声明**,不做魔法推断;没声明时可视化如实说"没有程序文件",
    // 由 `inferVerifyPath` 对**明确形态**做一次保守推断兜底。
    verify_path: c.verify_path ?? null,
    result: c.result ?? null,
    state: c.state ?? "todo",
    // 达成时才有:
    verified_tree: c.verified_tree ?? null,
    accepted_at: c.accepted_at ?? null,
    // 诊断:这条 P 在基线时就通过吗(null = 没查过)
    weak_verify: c.weak_verify ?? null,
    merge: c.merge ?? null,
    // 凭证:库里只存 hash,明文只在签发时给出去一次
    cap_hash: c.cap_hash ?? null,
  };
}

/** 这个节点有没有实质门禁内容(用来判"是不是首次定义")。 */
export function hasGate(node) {
  return Boolean(node.delta?.length || node.verify);
}

/**
 * 从 P 里**保守地**推断验证程序的文件路径。
 *
 * ## 为什么只认这几种形态
 *
 * P 是任意 shell 命令。绝大多数形态里"哪个词是程序"是**语义问题**,
 * 例如 `grep -q ok root.txt` —— `root.txt` 是**被验对象**,不是验证程序;
 * `test -f f.txt`、`true`、`sleep 10` 压根没有程序文件。
 *
 * 机器判不了语义,所以这里**只在形态明确时开口**:
 *
 *     node <file>        /usr/bin/node <file>
 *     bash <file>        sh <file>        zsh <file>
 *     python3 <file>     python <file>
 *     ./<file>                           (可执行脚本)
 *
 * 其余一律返回 `null` —— **不知道就说不知道**,不猜一个看起来像的路径。
 * 猜错的代价是误导人去找一个不存在的文件,比不显示更糟。
 *
 * 声明者想给准确答案,就用 `verify_path` 显式写(它优先)。
 */
export function inferVerifyPath(verify) {
  const cmd = String(verify ?? "").trim();
  if (!cmd) return null;

  // 带引号的路径、以及明显的"不是文件程序"的命令,一律不推断。
  const bare = cmd.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/, "");   // 去掉前置 FOO=bar

  // 形态 1:`<解释器> <文件>`(解释器可带路径,中间可夹选项)
  //
  // 选项要同时认 `-q`(短)和 `--foo`(长)、以及 `--foo=bar`。
  // 只写 `--\S+` 会漏掉短选项 —— 实测 `python3 -q foo/bar.py` 就漏了。
  const m = bare.match(
    /^(?:\S*\/)?(?:node|nodejs|bash|sh|zsh|python3?|ruby|perl|deno|bun)\s+(?:--?\S+\s+)*(\S+)/,
  );
  if (m) {
    const p = m[1];
    if (!p.startsWith("-") && /\.\w+$/.test(p)) return p;
    return null;
  }

  // 形态 2:`./<文件>`(可执行脚本)
  const m2 = bare.match(/^\.\/(\S+)/);
  if (m2 && !m2[1].includes("|")) return `./${m2[1]}`;

  // 其余:不知道。
  return null;
}

/** 节点最终展示用的 P 路径:显式声明优先,否则保守推断。 */
export function verifyPathOf(node) {
  return node?.verify_path ?? inferVerifyPath(node?.verify);
}

/** 弱 P 探测的时间预算。它是**诊断**,不该和 P 本身一样贵。 */
const WEAK_PROBE_TIMEOUT = 15_000;

// ------------------------------------------------------------- plan

/**
 * 声明一个节点(新增或改写)。
 *
 * `actor` 是调用方的凭证:
 *
 *     { kind: "user" }          人(CLI --as-user;**插件永远不给这个**)
 *     { kind: "holder", token } 持有一个节点凭证的 agent
 *
 * 返回 { ok, node?, problems?, rewrite?, token? }
 * `token` 只在**首次创建**时出现 —— 那是这个节点的新凭证,给创建者拿着。
 */
export function plan(dir, raw, { actor = null } = {}) {
  const c = normalize(raw);
  let newToken = null;

  if (!c.id) return { ok: false, problems: ["没有给 id"] };
  if (!c.expect) return { ok: false, problems: [`${c.id} 没有写 expect(要达成什么)`] };

  // **必须先有 git 仓库。** 节点要产出 commit,没有 git 就没有"证据"这一半。
  if (!isRepo(dir)) {
    return {
      ok: false,
      problems: [`${dir} 不是 git 仓库 —— 节点达成要靠 commit 当证据,先 git init`],
    };
  }

  // **base 必须显式给。** 见 normalize 里那段。
  if (!c.base) {
    return {
      ok: false,
      problems: [
        `${c.id} 没有给 base。base 是**节点属性** —— "从哪个 commit 开始"由你定,`
        + "我不猜一个默认值(默认的会让 diff 的语义变模糊)。"
        + `当前 HEAD 是 ${head(dir) || "(空仓库,还没有 commit)"},要用它就显式写上。`,
      ],
    };
  }
  if (!treeOf(dir, c.base)) {
    return { ok: false, problems: [`base "${c.base}" 在这个仓库里不存在`] };
  }

  // P 必须有 —— DESIGN.md:「检测程序必须有」
  if (!c.verify) {
    return {
      ok: false,
      problems: [
        `${c.id} 没有给 verify(P)。**P 必须有** —— Δ 只管"改的是不是这些文件",`
        + "没有 P 就没有任何东西说'改对了'。",
      ],
    };
  }

  const dp = selfCheck(c.delta);
  if (dp.length) return { ok: false, problems: dp };

  // ============ 从这里到返回,整段在锁里 ============
  //
  // `getNode` -> 判断 -> `putNode` 是**读-改-写**。两个 subagent 并行时,
  // 两边读到同一份旧内容,后写的会把先写的**整个覆盖掉**。
  // 实测:20 轮并行(每轮 2 个,期望 40 个)只活下来 20 个 ——
  // **丢的那 20 个没有任何痕迹。** 所以整个"读 -> 判 -> 写 -> 记账"
  // 必须是**一个**临界区,不能只锁写。
  return withLock(dir, () => {
    const old = getNode(dir, c.id);
    const isRewrite = old !== null;

    if (isRewrite) {
      // --- 改一个已存在的节点 ---
      //
      // 两道门都在 `canModify` 里,顺序是**冻结优先于凭证**:
      //   · 已达成 = 冻结,**任何凭证都破不了**(保护历史事实)
      //   · 否则要它**父**的凭证 —— 这就是"向创建者提权"
      const grant = canModify(dir, old, actor, { mode: "self" });
      if (!grant.ok) return { ...grant, owner: old.owner };

      // 改写时**继承**这些 —— 它们不是这次要改的东西。
      //
      // **parent 必须继承,不能看这次的参数。** 否则"改写时忘了给 parent"
      // 会把一个子节点变成根节点 —— 而根节点的权限是"人"那一档,
      // 于是忘了一个参数就完成了一次提权。移动节点不是这个工具该干的事。
      if (c.parent !== old.parent) {
        const given = c.parent === null || c.parent === undefined;
        return {
          ok: false,
          problems: [
            given
              ? `${c.id} 已经存在,它的父是 ${old.parent} —— 改写时**不给 parent** `
                + "不等于『把它变成根节点』(那会是一次提权)。"
                + "要改它的父,那是**移动节点**,另说。"
              : `${c.id} 的父是 ${old.parent},这次给的是 ${c.parent} —— `
                + "**移动节点**不是 plan 该干的事。要换父,放弃它再重新声明。",
          ],
        };
      }
      c.parent = old.parent;
      c.base = old.base;
      c.result = old.result;
      c.state = old.state;
      c.verified_tree = old.verified_tree;
      c.accepted_at = old.accepted_at;
      c.weak_verify = old.weak_verify;
      c.merge = old.merge;
      c.cap_hash = old.cap_hash;   // **凭证不因改写而重发** —— 换了等于把权限收回
    } else {
      // --- 新建 ---
      //
      // 在 X 下面加子节点,需要 X **自己**的凭证;
      // 根节点没有父,所以只能由人签发。
      const parentId = c.parent ?? null;
      if (parentId) {
        const parent = getNode(dir, parentId);
        if (!parent) {
          return {
            ok: false,
            problems: [
              `父节点 ${parentId} 不存在 —— 先声明它,或者不给 parent(那就是根节点)`,
            ],
          };
        }
        const grant = canModify(dir, parent, actor, { mode: "child" });
        if (!grant.ok) return grant;
      } else if (actor?.kind !== "user") {
        return {
          ok: false,
          problems: [
            "根节点没有父 —— 它的凭证只能由**人**签发。"
            + "请人用 --as-user 创建根节点;agent 从根节点往下拆。",
          ],
        };
      }

      // **首次创建 = 签发凭证。** 明文只在这一次返回,之后库里只有 hash。
      const cap = issue();
      c.cap_hash = cap.hash;
      newToken = cap.token;
    }

    if (c.delta.length && !c.delta_source) c.delta_source = "before-work";

    putNode(dir, c);
    appendLedger(dir, {
      type: "plan",
      kind: isRewrite ? "改写" : "新增",
      node: c.id,
      parent: c.parent,
      expect: c.expect,
      owner: c.owner,
      by: actor?.kind === "user" ? "user" : "model",
      // **门禁本身必须留痕。** 只记一句描述的话,
      // "真正要保护的那个东西"反而没有任何痕迹。
      gate: { base: c.base, delta: c.delta, delta_source: c.delta_source, verify: c.verify },
      prevGate: isRewrite ? old : null,
    });

    return {
      ok: true,
      node: c,
      rewrite: isRewrite,
      // 明文**只在这里出现一次**。之后库里只有 hash —— 再要看也看不到了。
      token: newToken ?? undefined,
    };
  });
}

// ------------------------------------------------------------- status

/**
 * 只读:相对 base 改了什么,**和 Δ 比差在哪**。
 *
 * 这是这套东西的使用体验所在 —— 它同时服务三件事:
 * **写 Δ、自查、理解为什么没过**。所以输出要**直接对着 Δ 的形状**。
 *
 * **不跑 P** —— 和 git status 一样便宜。
 */
export function status(dir, id) {
  const node = getNode(dir, id);
  if (!node) return { ok: false, problems: [`节点 ${id} 不存在`] };

  // 比的是**工作区当前内容**,不是 HEAD —— 未提交的改动才是"你正在做的"。
  const treeY = workingTreeHash(dir);
  const actual = treeY ? (diffNameStatus(dir, node.base, treeY) ?? []) : [];

  const r = evaluateGate(dir, node, { treeY, actualDiff: actual, mode: "cheap" });

  return {
    ok: true,
    node,
    base: node.base,
    current: head(dir),
    treeY,
    actual,
    items: r.items,
    delta: r.delta,
    weak_verify: node.weak_verify,
  };
}

// ------------------------------------------------------------- commit

/**
 * 门禁求值的共用部分:**固定树 Y -> 算 Δ -> 跑 (Δ, P)**。
 *
 * `commit` / `propose` / `approve` 都走这一段。**顺序是承重的**:
 * 先固定树、再跑 P —— 决定的是"后面能不能精确提交那个被验过的树"。
 * 写成两遍就会有两个版本,迟早不一致。
 *
 * 返回 `{ok:true, treeY, diff, report, weak, merging}` 或 `{ok:false, problems, report, weak}`。
 */
function evaluateNodeGate(dir, node, { timeout }) {
  const merging = mergeHeads(dir).length > 0;

  // ---------- 第 1 步:固定树 Y ----------
  let treeY;
  if (merging) {
    // 合并中:结果在**索引**里(模型自己 git merge --no-commit 跑出来的)
    const un = unmergedPaths(dir) ?? [];
    if (un.length) {
      return {
        ok: false,
        problems: [
          `还有 ${un.length} 个文件没解决冲突:${un.slice(0, 10).join(", ")}。`
          + "先解决再提交(用 bash 改到满意为止)。",
        ],
      };
    }
    treeY = indexTree(dir);
    if (!treeY) return { ok: false, problems: ["索引里没有可提交的内容"] };
  } else {
    treeY = workingTreeHash(dir);
    if (!treeY) {
      return {
        ok: false,
        problems: ["算不出工作区的树哈希(**不知道**当前世界长什么样)—— 不提交"],
      };
    }
  }

  // ---------- 实际 diff ----------
  let actualDiff;
  if (merging) {
    // 合并节点不用 Δ —— 见 checkMergeContents 里的说明。
    const mc = checkMergeContents(dir, treeY, mergeHeads(dir));
    if (!mc.ok) return { ok: false, problems: mc.problems, report: mc };
    actualDiff = [];
  } else {
    const d = diffNameStatus(dir, node.base, treeY);
    if (d === null) {
      return { ok: false, problems: ["算不出 diff(base, Y)—— **不知道**,不提交"] };
    }
    actualDiff = d;
  }

  // ---------- 第 2、3 步:跑 (Δ, P) ----------
  //
  // **没有"根 P"这一层。** 所有节点一视同仁 —— 各自只跑各自的 P,
  // 根节点也不例外(它的 P 通常验"整体可用",但那只是它的 P)。
  // 见 gate.mjs 末尾那段。
  const report = evaluateGate(dir, node, { treeY, actualDiff, mode: "full", timeout });

  // 弱 P 探测:只在还没查过时做。它是**诊断**,不是门禁 ——
  // 所以给它一个比 P 小得多的预算(否则慢的 P 会被跑两遍)。
  let weak = node.weak_verify;
  if (weak === null || weak === undefined) {
    weak = probeWeakVerify(dir, node.verify, node.base, { timeout: WEAK_PROBE_TIMEOUT });
  }

  if (!report.ok) {
    return {
      ok: false,
      problems: report.items
        .filter((i) => i.status !== "pass")
        .map((i) => {
          const tag = i.status === "unknown" ? "?" : "✗";
          return `${tag} ${i.detail}${i.demand ? `\n    -> 要求: ${i.demand}` : ""}`;
        }),
      report,
      weak,
      treeY,
    };
  }

  return { ok: true, treeY, diff: actualDiff, report, weak, merging };
}

/**
 * **提议达成** —— 门禁先跑,但**不落地**。
 *
 * ## 谁用它
 *
 * 子 agent。它改完了、P 也过了,但它**没有父节点的凭证** ——
 * 按设计,达成是父的事(验收权不下放)。
 *
 * 所以它:① 在自己那儿把门禁跑完(**先验,再打扰父** —— 没过就不该问);
 * ② 把结果报给父,等父决定。
 *
 * ## 报告里为什么带"验过的树"
 *
 * 父批准时会**重跑一遍门禁**(不信任子报上来的结果 —— 子可能撒谎)。
 * 带上树哈希,父就能看出"你报的那个世界,和我现在看到的是不是同一个"。
 *
 * **这个函数不写任何状态** —— 没有持久化的"待批准"记录。
 * 所以父批准时必然重跑,这是"不加 pending 状态"的直接代价。
 */
export function propose(dir, id, { timeout = 120_000 } = {}) {
  const node = getNode(dir, id);
  if (!node) return { ok: false, problems: [`节点 ${id} 不存在`] };

  if (node.state === "done") {
    return {
      ok: false,
      problems: [
        `节点 ${id} 已经达成了(证据 ${node.result})—— 门禁冻结。要变,起一个新节点。`,
      ],
    };
  }

  const g = evaluateNodeGate(dir, node, { timeout });
  if (!g.ok) {
    return {
      ok: false,
      problems: ["门禁没过 —— **不提议**。先按下面的要求把它弄过:", ...g.problems],
      report: g.report,
    };
  }

  // **把候选 commit 先建出来,但不挪 HEAD。**
  //
  // 这是"子申请、父批准"能成立的关键:父要批准的东西必须是**一个具体的
  // 对象**,而不是"我刚才看到的那堆改动"。建出来了它就是不可变的 ——
  // 子之后再怎么改工作区,这个 sha 指向的内容一个字节都不会变。
  //
  // 不挪 HEAD 是刻意的:HEAD 一动,这次就"已经提交了",父的批准就没意义了。
  const parents = g.merging ? mergeHeads(dir) : [head(dir)].filter(Boolean);
  const shouldTranscribe = !g.merging && !(node.delta?.length);
  const msg = buildMessage(node, {
    treeY: g.treeY,
    delta: g.merging ? null : (shouldTranscribe ? g.diff : node.delta),
    delta_source: shouldTranscribe ? "at-commit" : node.delta_source,
    weak: g.weak,
    merge: g.merging,
  });
  const ct = commitTree(dir, { tree: g.treeY, parents, message: msg });
  if (!ct.sha) {
    return { ok: false, problems: [`建候选 commit 失败:${ct.err} —— 没提议`] };
  }

  const deltaText = node.delta?.length
    ? node.delta.map((d) => `${d.code}:${d.path}`).join(" ")
    : "(空)";

  return {
    ok: true,
    node,
    treeY: g.treeY,
    candidate: ct.sha,          // ← 父要批准的那个对象
    weak: g.weak,
    summary: [
      `节点 ${id}「${node.expect}」门禁已过,请求批准达成。`,
      `  Δ: ${deltaText}`,
      `  P: ${node.verify}  —— 通过`,
      `  候选 commit: ${ct.sha}`,
      `  (它已经建好了,但**没挂到 HEAD 上** —— 等父批准才落地)`,
      g.weak === true ? "  ⚠ P 在基线时就通过 —— 它区分不了你做没做" : "",
    ].filter(Boolean).join("\n"),
  };
}

/**
 * **批准达成** —— 父 agent 的动作。
 *
 * 逻辑上它**就是** commit:权限检查 + 跑门禁 + 落地。
 * 但它**不信任子报上来的门禁结果**,自己重跑一遍 ——
 * 因为没有持久化的待批准记录,而且子可能报了个假结果。
 *
 * 重跑的代价是 P 跑两遍(子一次、父一次)。串行场景下工作区没变,
 * 结果必然一致;要是**变了**,那正是该拒绝的时候:
 *
 *     父批准时门禁不过  ->  "你批准的那个世界"已经不一样了
 */
export function approve(dir, id, { timeout = 120_000, actor = null, candidate = null } = {}) {
  const node = getNode(dir, id);
  if (!node) return { ok: false, problems: [`节点 ${id} 不存在`] };

  // 权限:和 commit 同一道门 —— 需要**父节点**的凭证。
  // 父 agent 天然持有它,所以"批准"这个动作正好对得上。
  const grant = canModify(dir, node, actor, { mode: "self" });
  if (!grant.ok) return grant;

  if (node.state === "done") {
    return {
      ok: false,
      problems: [`节点 ${id} 已经达成了(证据 ${node.result})—— 门禁冻结。`],
    };
  }

  // ---------- 给了候选 commit:就批准**它** ----------
  //
  // 这是"子申请 -> 父批准"的正路。父批准的是子**当时验过的那个对象**,
  // 不是"父现在看到的工作区"。
  //
  // 为什么要校验三条,而不是照着 sha 就挂上去:
  //
  //   ① **存在性** —— sha 可能根本不是一个 commit(子报了个假的)
  //   ② **是我们的孩子吗** —— 它的父必须是**当前的** HEAD。
  //      不然可以把一个来路不明的提交直接挂进历史。
  //   ③ **内容还是那个内容吗** —— 它的 tree 必须是子验过的那个。
  //      这一条防的是"子报了一个 sha,但那个 sha 的内容和它报的门禁
  //      结果对不上"。
  //
  // 三条都过了,才 `updateHead`。**父不需要访问子的工作区** ——
  // 需要的一切都在那个 commit 对象里。
  if (candidate) {
    const isCommit = git(dir, ["cat-file", "-e", `${candidate}^{commit}`]).ok;
    if (!isCommit) {
      return { ok: false, problems: [`${candidate} 不是一个 commit 对象 —— 不批准`] };
    }

    const cur = head(dir);
    const parents = git(dir, ["rev-list", "--parents", "-n", "1", candidate]).out.split(/\s+/).slice(1);
    if (cur && !parents.includes(cur)) {
      return {
        ok: false,
        problems: [
          `候选 ${candidate.slice(0, 8)} 的父不是当前 HEAD(${String(cur).slice(0, 8)})`
          + " —— 它不是基于现在的历史做出来的。",
          "  要么它已经过期(中间有人提交过),要么它本来就不属于这里。",
        ],
      };
    }

    // ③ **内容还是那个内容吗** —— 拿候选自己的 trailer 对。
    //
    // 注意这里**不能**看 `node.verified_tree`:那个字段只在 commit 成功
    // 写回时才设,而提议阶段节点还是 todo,它必然是 null —— 拿它做判断
    // 等于没判。(实测:写完发现 `verified_tree: null`,那条校验是空的。)
    //
    // 该问的是**候选自己**:它的 trailer 声明验过哪个树,和它的实际 tree
    // 对不对得上。对不上 = 这个 commit 的内容不是被验过的那些内容。
    const tree = treeOf(dir, candidate);
    const t = parseTrailers(git(dir, ["log", "-1", "--format=%B", candidate]).out);
    const claimed = t["bg-verified-tree"];
    if (claimed && tree && claimed !== tree) {
      return {
        ok: false,
        problems: [
          `候选 ${candidate.slice(0, 8)} 自称验过的树是 ${String(claimed).slice(0, 8)},`
          + `但它实际的树是 ${String(tree).slice(0, 8)} —— **不是被验过的那个内容**。`,
        ],
      };
    }
    if (t["bg-node"] && t["bg-node"] !== id) {
      return {
        ok: false,
        problems: [
          `候选 ${candidate.slice(0, 8)} 的 trailer 写的是节点 ${t["bg-node"]},`
          + `不是 ${id} —— 批错了对象。`,
        ],
      };
    }

    if (!updateHead(dir, candidate)) {
      return { ok: false, problems: [`HEAD 没能挪到 ${candidate.slice(0, 8)}`] };
    }
    readIndexFromHead(dir);

    const done = {
      ...node,
      state: "done",
      result: candidate,
      verified_tree: tree,
      accepted_at: nowIso(),
    };
    putNode(dir, done);
    appendLedger(dir, {
      type: "commit",
      node: id,
      result: candidate,
      tree,
      delta: node.delta,
      delta_source: node.delta_source,
      verify: node.verify,
      approved_from: candidate,
    });

    return { ok: true, node: done, result: candidate, tree, weak_verify: node.weak_verify };
  }

  // ---------- 没给候选:退回"父自己重跑一遍" ----------
  //
  // 老路:父在**自己的工作区**里重跑门禁然后提交。
  // 只在"父和子看的是同一个工作区"(串行)时才真正等价。
  return commit(dir, id, { timeout, actor });
}

/**
 * **提交即门禁**:Δ + P,过了才产生版本。
 *
 * ## 顺序(见 gate.mjs 顶部)
 *
 *     1. 先算 Y(工作区树哈希)—— 固定"现在这个世界"
 *     2. 在 Y 上跑 P
 *     3. 过了 -> 用 commit-tree 精确提交 Y
 *
 * 第 3 步是**必须**的:用 `git commit` 的话,提交的是"跑命令那一刻的工作区",
 * 而 P 可能已经留下了临时产物。那样 trailer 说的"通过了"就是假的。
 *
 * ## 合并也是一次提交
 *
 * 检测到 MERGE_HEAD 时走合并分支:
 *     1. 结果必须是**所有**父的后代
 *     2. 每个父的 Δ,在它自己碰过的路径上,合并后仍然成立
 *     3. P 在结果上通过
 * 第 2 条防的是"解决冲突时把另一个分支的成果整个撤销掉"。
 */
export function commit(dir, id, { timeout = 120_000, actor = null } = {}) {
  const node = getNode(dir, id);
  if (!node) return { ok: false, problems: [`节点 ${id} 不存在`] };

  // 达成**也是一种修改**(它改 state、写 result),所以要同一道门。
  // 少了这一条的话,一个拿不到 plan 权限的 agent 可以直接 commit 把事办了。
  const grant = canModify(dir, node, actor, { mode: "self" });
  if (!grant.ok) return grant;

  if (node.state === "done") {
    return {
      ok: false,
      problems: [
        `节点 ${id} 已经达成了(证据 ${node.result})—— 门禁冻结。`
        + "要变,起一个新节点。",
      ],
    };
  }

  // 固定树 + 算 Δ + 跑门禁 —— 和 propose 共用同一段。
  // 写成两遍会有两个版本,迟早不一致(而且"先固定树再跑 P"这个顺序是承重的)。
  const g = evaluateNodeGate(dir, node, { timeout });
  if (!g.ok) {
    return {
      ok: false,
      problems: g.problems,
      report: g.report,
      weak_verify: g.weak,
    };
  }
  const { treeY, weak, merging } = g;

  // ---------- 第 3 步:精确提交 Y ----------
  const parents = merging ? mergeHeads(dir) : [head(dir)].filter(Boolean);

  // **转录在这里算,不在写回时算。** trailer 和写回必须用**同一个**值 ——
  // 否则证据(trailer)里写的和节点里存的不一致,以后 crosscheck 会对不上。
  // 规则见下面写回处那段注释:只有原本为空的 Δ 才转录,合并不转录。
  const shouldTranscribe = !merging && !(node.delta?.length);
  const finalDelta = shouldTranscribe ? g.diff : node.delta;
  const finalDeltaSource = shouldTranscribe ? "at-commit" : node.delta_source;

  const msg = buildMessage(node, {
    treeY,
    delta: merging ? null : finalDelta,
    delta_source: finalDeltaSource,
    weak,
    merge: merging,
  });

  const ct = commitTree(dir, { tree: treeY, parents, message: msg });
  if (!ct.sha) {
    return { ok: false, problems: [`commit-tree 失败:${ct.err}—— 没有提交`] };
  }

  // **合并的祖先检查必须在这里做**,不能提前:
  // "结果是不是所有父的后代"问的是**commit 之间**的关系,
  // 而树哈希不是 commit —— 拿树去问祖先,git 只会说判不了(实测)。
  // 所以先把 commit 对象建出来(它还没挂上 HEAD,不影响任何东西),
  // 验过了再决定挂不挂。**没过就把它丢掉**,不留痕迹。
  if (merging) {
    const anc = checkAncestry(dir, ct.sha, parents);
    if (!anc.ok) return { ok: false, problems: anc.problems, orphan: ct.sha };
  }

  if (!updateHead(dir, ct.sha)) {
    return {
      ok: false,
      problems: [
        `commit 建出来了(${ct.sha})但 HEAD 没能挪过去 —— 提交存在,但不在历史线上`,
      ],
    };
  }
  readIndexFromHead(dir);   // 让索引跟上,否则 git status 会谎报
  if (merging) clearMergeState(dir);

  // ---------- 写回状态 ----------
  //
  // **空 Δ 达成时,把实际改动转录进来**(转录值在上面算好,和 trailer 同一个)。
  //
  // 为什么:Δ 是这套东西防"子 agent 做出预期外变更"的机制,但它只在
  // **创建者写了 Δ** 时才起作用。空 Δ 时门禁跳过比对(`gate.mjs` 的
  // `cmp.skipped` 分支),改动被标成 pass —— 于是**既没拦,也没记**。
  // 创建者事后想知道"这一步到底动了什么",只能自己去翻 git diff,
  // 那等于把"审查"静默丢掉了,而审查是**不可缺失**的。
  //
  // 所以不拦(**Δ 空 = 创建者不在意约束,不该拦**),但**必须记**:
  //   · 进节点 -> tree 里被显著标注为"转录 · 非预测"
  //   · 进 trailer -> 证据里看得见
  //   · 进账本
  // 这就是「不拦,但不隐瞒」—— 约束可以没有,记录不能没有。
  //
  // 边界:只有**原本为空**的 Δ 才转录。写了 Δ 的节点不动它 —— 那是真预测,
  // 被门禁逐个比对过的,用实际值覆盖会把"预期外"的证据擦掉。
  const done = {
    ...node,
    state: "done",
    result: ct.sha,
    verified_tree: treeY,
    accepted_at: nowIso(),
    weak_verify: weak ?? null,
    merge: merging ? { parents } : null,
    delta: finalDelta,
    delta_source: finalDeltaSource,
  };
  putNode(dir, done);

  appendLedger(dir, {
    type: "commit",
    node: id,
    result: ct.sha,
    tree: treeY,
    delta: merging ? null : finalDelta,
    delta_source: finalDeltaSource,
    verify: node.verify,
    weak_verify: weak ?? null,
    merge: merging ? parents : null,
    transcribed: shouldTranscribe || undefined,
  });

  return {
    ok: true,
    node: done,
    result: ct.sha,
    tree: treeY,
    weak_verify: weak,
    notes: ct.fallbackUsed
      ? ["git 没配 user.name / user.email,这次用了兜底身份 —— commit 的作者不是你"]
      : [],
  };
}

/**
 * 合并专属的检查(替代 Δ)。
 *
 * 为什么不用 Δ:合并没有单一的 base,而且无冲突时 Δ 可推导、
 * 有冲突时解决是刻意的 —— 都是"照抄",没有约束力。
 *
 * 所以换成两条:
 *   1. 结果必须是**所有**父的后代
 *   2. 每个父的 Δ,在它自己碰过的路径上,合并后仍然成立
 *
 * 第 2 条防的是这个:
 *
 *     git merge-base --is-ancestor X_A X_M   ->  ✓ 通过
 *     git diff X_A X_M -- feature.py         ->  M feature.py   ← A 的成果没了
 *
 * **"X_A 是祖先"只证明历史里包含 A,不证明 A 的内容还在。**
 * 解决冲突时可以把一个分支的成果整个撤销掉,而祖先检查看不出来。
 */
/**
 * 合并的两条检查。**它们必须在两个不同的时刻做**,因为问的对象不同:
 *
 *     checkMergeContents   父的成果还在吗      ->  问**树**,提交前就能查
 *     checkAncestry        结果包含所有父吗    ->  问**commit**,必须先建出对象
 *
 * 第 2 条防的是这个:
 *
 *     git merge-base --is-ancestor X_A X_M   ->  ✓ 通过
 *     git diff X_A X_M -- feature.py         ->  M feature.py   ← A 的成果没了
 *
 * **"X_A 是祖先"只证明历史里包含 A,不证明 A 的内容还在。**
 * 解决冲突时可以把一个分支的成果整个撤销掉,而祖先检查看不出来。
 * 所以两条都要,缺一不可。
 *
 * ## 为什么不用 Δ
 *
 * 合并没有单一的 base,而且无冲突时 Δ 可推导、有冲突时解决是刻意的 ——
 * 都是"照抄",没有约束力。所以换成上面这两条。
 */
function checkMergeContents(dir, treeY, parents) {
  const problems = [];
  const nodes = allNodes(dir);

  for (const p of parents) {
    const pn = nodes.find((n) => n.result === p);
    if (!pn || !pn.delta?.length) continue;

    const now = diffNameStatus(dir, pn.base, treeY) ?? [];
    for (const d of pn.delta) {
      const path = d.code === "R" ? d.to : d.path;
      const hit = now.find((x) => x.path === path || x.to === path);
      if (!hit) {
        problems.push(
          `${pn.id}(${p.slice(0, 7)}) 的 Δ 里 ${d.code} ${path} `
          + "在合并结果里找不到了 —— **它的成果在解决冲突时被撤销了**。"
          + "要么恢复,要么这个合并本来就是错的。",
        );
      }
    }
  }

  if (problems.length) return { ok: false, problems };
  return { ok: true };
}

/** 祖先检查 —— 只能在 commit 对象建出来之后跑。见上面那段。 */
function checkAncestry(dir, sha, parents) {
  const problems = [];
  for (const p of parents) {
    const anc = isAncestor(dir, p, sha);
    if (anc === false) {
      problems.push(`${p.slice(0, 8)} 不是结果的祖先 —— 结果没有包含它`);
    } else if (anc === null) {
      problems.push(`判不了 ${p.slice(0, 8)} 是不是结果的祖先(**不知道** —— 不算通过)`);
    }
  }
  if (problems.length) return { ok: false, problems };
  return { ok: true };
}

// ------------------------------------------------------------- abandon

/**
 * 把一个**声明了但没做**的节点从图里移除。
 *
 * 为什么必须有:
 *
 *     plan 声明一个意图  ->  它必须被记下来(否则人看不见计划)
 *     声明了不做        ->  那条记录必须**能被移除**
 *
 * 否则图里永远挂着一个"待办",而图会看起来像还在做这件事。
 *
 * **但它只做一件事:从图里移除声明。**
 * "把工作区撤回去"不是它的职责 —— 那是普通的 `git reset --hard <base>`,
 * 模型有 bash,自己就能做。工具只管"图",不管"工作区"。
 */
export function abandon(dir, id, reason = "", { actor = null } = {}) {
  const node = getNode(dir, id);
  if (!node) return { ok: false, problems: [`节点 ${id} 不存在`] };

  // 放弃也是修改。少了这一条,拿不到 plan 权限的 agent 能把别人的意图删掉。
  const grant = canModify(dir, node, actor, { mode: "self" });
  if (!grant.ok) return grant;

  if (node.state === "done") {
    return {
      ok: false,
      problems: [
        `节点 ${id} 已经**达成**了(证据 ${node.result})—— 不能放弃。`
        + "历史不改写:它达成了这件事永远为真。要改,起一个新节点。",
      ],
    };
  }

  // 账本**先**写:即使后面写图失败,"它被放弃过"这件事也已经留下了。
  appendLedger(dir, { type: "drop", node: id, reason, expect: node.expect });

  withLock(dir, () => {
    const rest = allNodes(dir).filter((n) => n.id !== id);
    const obj = { nodes: {} };
    for (const n of rest) obj.nodes[n.id] = n;
    writeFileSync(paths(dir).nodes, JSON.stringify(obj, null, 2), "utf8");
  });

  return { ok: true, node: id, reason };
}

// ------------------------------------------------------------- 证据校验

/**
 * 一个已达成的节点,它的证据还**完好**吗。
 *
 * 判据:`commit^{tree} == bg-verified-tree`。
 *
 * 为什么要记 verified-tree 而不是 commit 自己的哈希:commit 是不可变的,
 * **但可以被 amend**:
 *
 *     走门禁 commit 了 V(带 trailer:"P 通过")
 *     git commit --amend 改内容(保留 message 和 trailer)
 *       -> V' 内容变了,trailer 还写着"P 通过"  ->  一个伪造的绿
 *
 * 不能记 commit 自己的哈希(鸡生蛋),但**树哈希可以在 commit 之前算出来**。
 *
 * 返回 { status: ok | tampered | unknown | n/a, detail }
 */
export function verifyEvidence(dir, node) {
  if (node.state !== "done" || !node.result) {
    return { status: "n/a", detail: "这个节点还没有达成" };
  }
  const t = treeOf(dir, node.result);
  if (!t) return { status: "unknown", detail: `读不到 ${node.result.slice(0, 8)} 的树(**不知道**)` };
  if (!node.verified_tree) {
    return { status: "unknown", detail: "达成时没记下 verified-tree(**不知道**)—— 这次达成没有防篡改锚" };
  }
  if (t !== node.verified_tree) {
    return {
      status: "tampered",
      detail: `${node.result.slice(0, 8)} 被改过:它的树是 ${t.slice(0, 8)},`
        + `但达成时验的是 ${node.verified_tree.slice(0, 8)} —— **这是一个伪造的绿**`,
    };
  }
  return { status: "ok", detail: `证据完好(tree ${t.slice(0, 8)})` };
}

// ------------------------------------------------------------- commit message

/**
 * 拼 commit message + trailer。
 *
 * trailer 是**证据的形状**。为什么每条都得有:
 *
 *     P 必须跟着版本走  ->  不能只活在工具的运行时
 *     Δ + 来源          ->  说明"预言"还是"转录"
 *     verified-tree     ->  防 amend 伪造
 */
export function buildMessage(
  node,
  { treeY, delta, delta_source, weak, merge },
) {
  const first = node.expect || `node ${node.id}`;

  const t = [
    `bg-node: ${node.id}`,
    `bg-owner: ${node.owner}`,
    `bg-parent: ${node.parent ?? ""}`,
    `bg-base: ${node.base}`,
  ];

  if (merge) {
    t.push("bg-merge: yes");
    t.push("bg-delta: (合并 —— 不用 Δ)");
  } else if (delta?.length) {
    t.push(`bg-delta: ${delta.map((d) => (
      d.code === "R" ? `R:${d.path}:${d.to}` : `${d.code}:${d.path}`
    )).join(" ")}`);
    // **来源要用**这次实际用的那个**,不是 node 上旧的那个。
    // 空 Δ 转录的场合,node.delta_source 还是 null,而 delta 已经是实际改动 ——
    // 用旧值会把"转录"写成"before-work",证据就撒谎了。
    const src = delta_source ?? node.delta_source ?? "before-work";
    t.push(`bg-delta-source: ${src}`);
    if (src === "at-commit") {
      t.push("bg-delta-transcribed: true   "
        + "# 提交时照实际改动抄的 —— 不是事前预测,**没有约束过这些改动**");
    }
  } else {
    t.push("bg-delta: (空 —— 没有预测,只有 P 在承重)");
  }

  t.push(`bg-verify: ${node.verify}`);
  t.push(`bg-verified-tree: ${treeY}`);
  if (weak === true) {
    t.push("bg-weak-verify: true   # P 在基线时就通过 —— 它区分不了你做没做");
  }

  return `${first}\n\n${t.join("\n")}\n`;
}

/**
 * 从 commit message 里读出 trailer。
 *
 * 用来判断"这个 commit 走没走门禁":
 *
 *     有 bg-node  ->  走门禁的
 *     没有        ->  **绕过的**
 *
 * 模型有 bash,没法禁止它裸 `git commit`。所以不是"禁止",而是"**发现**"。
 */
export function parseTrailers(body) {
  const out = {};
  for (const line of (body ?? "").split("\n")) {
    const m = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k.startsWith("bg-")) out[k] = v.trim();
  }
  return out;
}
