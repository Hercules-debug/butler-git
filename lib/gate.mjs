/**
 * gate.mjs —— 门禁求值。**这是核心。**
 *
 * 一个节点的门禁由三部分组成(和最初的约定一致):
 *
 *     fs      预期的文件系统情况
 *             ├ paths  逐条路径断言(直接 stat/读 —— **免疫 .gitignore**)
 *             └ tree   整个世界必须等于这个树哈希(绝对判据,可选)
 *     proc    进程情况(该在的在 / 该没的没有)
 *     verify  验证程序(跑起来成不成)
 *
 * **三条全过,节点才"现在过"。**
 *
 * ## 三种结果,不是两种
 *
 *     ok        确实满足
 *     fail      确实不满足(附一条"要求",模型能照着修)
 *     unknown   **不知道** —— 观测能力受限,或这次没查(贵的部分)
 *
 * `unknown` 既不是通过也不是不通过。**它必须能被表达出来**,
 * 否则"看不见"会被读成"没问题"(这个坑在 proc.mjs 顶部记着)。
 *
 * ## 为什么 fs 要分 paths 和 tree
 *
 *     tree   说"世界和预计**一模一样**" —— 强,但给不出诊断,而且
 *            .gitignore 的路径它**看不见**(所以编译产物那类不能用它)
 *     paths  逐个点名 —— 直接 stat/read,gitignore 免疫,失败可定位
 *
 * 两个都要,因为它们覆盖不同的东西。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { workingTreeHash, treeDiff, changedSince, blobHash } from "./git.mjs";
import { findByPattern } from "./proc.mjs";
import { baseline } from "./store.mjs";

export const OK = "ok";
export const FAIL = "fail";
export const UNKNOWN = "unknown";

function item(part, label, status, detail = "", demand = "") {
  return { part, label, status, detail, demand };
}

// ------------------------------------------------------------ 可写边界

/**
 * 路径匹配一个 glob。语义和旧实现保持一致:
 *
 *     src/export/**   前缀目录递归
 *     src/export/*    只这一层
 *     *.tmp           文件名通配
 *     a/b/c.py        精确
 */
export function globMatch(pattern, path) {
  const p = String(path).replace(/^\.\//, "");
  const pat = String(pattern).replace(/^\.\//, "");

  if (pat.endsWith("/**")) {
    const base = pat.slice(0, -3).replace(/\/$/, "");
    return p === base || p.startsWith(`${base}/`);
  }
  if (pat.endsWith("/*")) {
    const base = pat.slice(0, -2).replace(/\/$/, "");
    if (!p.startsWith(`${base}/`)) return false;
    return !p.slice(base.length + 1).includes("/");
  }
  if (pat.includes("*")) {
    const rx = new RegExp(`^${pat.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
    return rx.test(p) || rx.test(p.slice(p.lastIndexOf("/") + 1));
  }
  return p === pat || p.slice(p.lastIndexOf("/") + 1) === pat;
}

/**
 * **可写边界真的执行**(BUG-3)。
 *
 * 原来 `allow` 只被声明、存储、显示 —— `gate` 和 `contract` 都不读它。
 * 于是"可写边界"是**描述**,不是边界:写超了不会被拦,也没人告诉你。
 *
 * 判据:相对**基线树**改动过的路径,必须落在 `allow` 内。
 *
 * ## 没声明 allow 时怎么办
 *
 * 不拒 —— 那会让每一个没写 `allow` 的节点都失败,而 `allow` 在 `declare`
 * 里本来就是可选的。但也**不能沉默**,所以给一条 note:
 * "有改动,但这一维没有被检查"。**沉默才是这个项目最反对的东西。**
 */
function evalAllow(dir, node) {
  const allow = node.allow ?? [];
  const base = baseline(dir);
  if (!base?.tree) {
    return { items: [], notes: ["没有基线(先 init)—— 可写边界这一维没核对"] };
  }

  const changed = changedSince(dir, base.tree);
  if (changed === null) {
    return { items: [], notes: ["算不出改动清单 —— 可写边界这一维没核对"] };
  }
  if (!changed.length) return { items: [], notes: [] };

  if (!allow.length) {
    return {
      items: [],
      notes: [`有 ${changed.length} 处改动,但没声明可写边界(allow)—— 这一维没有被检查`],
    };
  }

  const outside = changed.filter((c) => !allow.some((pat) => globMatch(pat, c.path)));
  return {
    items: outside.map((c) => item(
      "allow",
      `越界(${c.code} ${c.path})`,
      FAIL,
      `不在声明的可写边界内: ${allow.join(" ")}`,
      `把改动移出边界,或把 ${c.path} 加进 allow`,
    )),
    notes: [],
  };
}

// -------------------------------------------------------------- 文件侧

function evalPaths(dir, spec) {
  const out = [];
  for (const a of spec?.paths ?? []) {
    const p = a.path ?? "";
    const full = join(dir, p);
    const label = a.kind === "contains" ? `${a.kind}(${p}) ${JSON.stringify(a.pattern ?? "")}`
      : `${a.kind}(${p})`;

    if (a.kind === "exists") {
      const yes = existsSync(full);
      out.push(yes
        ? item("fs", label, OK, "存在")
        : item("fs", label, FAIL, "不存在", `创建 ${p}`));
    } else if (a.kind === "absent") {
      const gone = !existsSync(full);
      out.push(gone
        ? item("fs", label, OK, "已无")
        : item("fs", label, FAIL, "仍存在", `删除 ${p}`));
    } else if (a.kind === "contains" || a.kind === "not_contains") {
      if (!existsSync(full)) {
        out.push(item("fs", label, FAIL, `${p} 不存在`, `创建 ${p} 并让它${a.kind === "contains" ? "包含" : "不含"} ${JSON.stringify(a.pattern ?? "")}`));
        continue;
      }
      let text;
      try {
        text = readFileSync(full, "utf8");
      } catch (e) {
        out.push(item("fs", label, UNKNOWN, `${p} 读不了: ${e.message}`));
        continue;
      }
      const has = text.includes(a.pattern ?? "");
      const want = a.kind === "contains" ? has : !has;
      out.push(want
        ? item("fs", label, OK, a.kind === "contains" ? "包含" : "不含")
        : item("fs", label, FAIL,
          a.kind === "contains" ? "不含" : "仍包含",
          `让 ${p} ${a.kind === "contains" ? "包含" : "去掉"} ${JSON.stringify(a.pattern ?? "")}`));
    }
  }
  return out;
}

/**
 * `changed(path)` —— **该路径的内容和基线不同**。这是我们唯一的**增量谓词**。
 *
 *     exists / absent / contains    是【世界】的谓词   "现在是什么样"
 *     changed                       是【增量】的谓词   "和基线比,变过没有"
 *
 * 缺了它,"改了 A"就只能用 `contains(A, 新内容)` 间接表达 ——
 * 而那证明的是"有这串字",不是"动过"。
 *
 * ## 为什么要求两边都存在
 *
 * "创建"和"删除"**另有谓词**(`exists` / `absent`),那两种写法**带方向**。
 * 让 changed 也包办它们,方向就丢了:
 *
 *     changed(B)   在"生成了 B"和"删除了 B"两种情况下都成立
 *
 * 而方向恰恰是验收要的。所以一边不存在时这里报 FAIL,并**指出该改用哪个谓词**。
 *
 * ## 参照点是【记录的基线】,不是当前 HEAD
 *
 * `.bg/baseline.json` 里记的才是"开工时的世界"。HEAD 会随模型自己 commit 而前移 ——
 * 拿它当参照点,同一个断言在不同时刻会给出不同答案(而且不报错)。
 *
 * ## 它的弱点,必须说清
 *
 * `changed` 是**相对判据**,允许**任何**改变,包括毁灭性的:
 *
 *     printf '' > A     ->  changed(A) 照样通过
 *
 * 所以它**不能单独用**。它只回答"动过没有";"动对了没有"要靠
 * `contains`(内容)或 `tree`(整体)。
 */
function evalChanged(dir, spec) {
  const paths = spec?.changed ?? [];
  if (!paths.length) return [];

  const nodeBase = spec?.changedBase ?? null;   // 声明时记下的节点基线

  const out = [];
  for (const path of paths) {
    const label = `changed(${path})`;
    const exists = existsSync(join(dir, path));
    const now = exists ? blobHash(dir, path) : null;

    // "读不了" 和 "不存在" 是两件事 —— 见 proc.mjs 那个坑。
    if (exists && now === null) {
      out.push(item("fs", label, UNKNOWN, `${path} 存在但算不出内容哈希`));
      continue;
    }

    // ---- 参照点:**节点基线**(声明这个节点时的内容哈希)----
    //
    // 不能用 init 基线:前一个节点改过的文件,会让后一个节点的 changed 白给。
    // 实测过 —— node1 把 A 从 v1 改到 v2,node2 什么都没做,changed(A) 照样通过。
    if (!nodeBase || !Object.prototype.hasOwnProperty.call(nodeBase, path)) {
      // 没有节点基线 = 这个节点不是用当前版本声明的。**不硬凑一个参照点** ——
      // 那正是"看不见却给出结论"。重新声明一次就有基线了。
      out.push(item("fs", label, UNKNOWN,
        "这个节点没有节点基线(声明时没记下内容哈希)—— 和什么比都不知道",
        `重新 declare 一次 ${path} 就会记下基线`));
      continue;
    }
    const before = nodeBase[path];

    if (before === null && now !== null) {
      out.push(item("fs", label, FAIL,
        "基线时不存在、现在存在 —— 那是**创建**,不是改",
        `改用 fsExists(${path}) —— 它带方向`));
    } else if (before !== null && now === null) {
      out.push(item("fs", label, FAIL,
        "基线时存在、现在不存在 —— 那是**删除**,不是改",
        `改用 fsAbsent(${path}) —— 它带方向`));
    } else if (before === null && now === null) {
      out.push(item("fs", label, FAIL,
        "基线不存在、现在也不存在 —— 从来没被创建过",
        `创建 ${path},或用 fsExists 表达"它应当存在"`));
    } else if (before === now) {
      out.push(item("fs", label, FAIL,
        "和这个节点开始时一模一样 —— 没有改动", `改动 ${path}`));
    } else {
      out.push(item("fs", label, OK, "内容有变"));
    }
  }
  return out;
}

function evalTree(dir, spec) {
  if (!spec?.tree) return [];
  const cur = workingTreeHash(dir);
  const label = `tree(=${spec.tree.slice(0, 8)})`;
  if (cur === null) {
    return [item("fs", label, UNKNOWN, "算不出工作区树哈希(非 git 仓库 或 git 出错)")];
  }
  if (cur === spec.tree) return [item("fs", label, OK, "世界和预计一致")];

  // **诊断**:光说"不一致"模型没法修,要说出差在哪几个文件。
  const d = treeDiff(dir, spec.tree, cur) ?? [];
  const detail = d.length
    ? `不一致: ${d.map((x) => `${x.code} ${x.path}`).join(", ")}`
    : "不一致";
  return [item("fs", label, FAIL, detail, "让世界变成预计的样子(或改这份预计)")];
}

// -------------------------------------------------------------- 进程侧

function evalProc(spec) {
  const out = [];
  for (const pat of spec?.present ?? []) {
    const r = findByPattern(pat);
    const label = `proc_present(${pat})`;
    if (r.capability === "unreadable") {
      out.push(item("proc", label, UNKNOWN,
        `${r.candidates} 个候选,但命令行一条都读不到 —— 观测能力受限`));
    } else if (r.matched.length) {
      out.push(item("proc", label, OK, `在跑: pid=${r.matched.join(",")}`));
    } else {
      out.push(item("proc", label, FAIL, "没找到", `启动匹配 '${pat}' 的进程`));
    }
  }
  for (const pat of spec?.absent ?? []) {
    const r = findByPattern(pat);
    const label = `proc_absent(${pat})`;
    if (r.capability === "unreadable") {
      out.push(item("proc", label, UNKNOWN,
        `${r.candidates} 个候选,但命令行一条都读不到 —— 观测能力受限`));
    } else if (r.matched.length) {
      out.push(item("proc", label, FAIL, `仍有 ${r.matched.length} 个: pid=${r.matched.join(",")}`,
        `关闭匹配 '${pat}' 的进程(pid: ${r.matched.join(", ")})`));
    } else {
      out.push(item("proc", label, OK, "已无"));
    }
  }
  return out;
}

// ------------------------------------------------------------ 验证程序

function evalVerify(dir, node, { mode, timeout }) {
  const cmd = node.verify;
  if (!cmd) return [];
  const label = `verify(${cmd})`;

  // 便宜模式不跑命令 —— 它是**参考**,不该让"看一眼"变贵。
  if (mode !== "full") {
    return [item("verify", label, UNKNOWN, "未复查 —— 要跑命令,用 full 模式")];
  }

  const r = spawnSync(cmd, {
    shell: true, cwd: dir, encoding: "utf8",
    timeout, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) return [item("verify", label, UNKNOWN, `跑不起来: ${r.error.message}`)];
  if (r.status === 0) return [item("verify", label, OK, "退出码 0")];

  const tail = (r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" | ");
  return [item("verify", label, FAIL,
    `退出码 ${r.status}${tail ? `  ${tail}` : ""}`, "让验证程序通过")];
}

// ------------------------------------------------------------------ 总入口

/**
 * 求值一个节点的门禁。
 *
 * @param mode  "cheap"(默认,跳过验证程序) | "full"(全跑)
 * @returns { ok, items, failed, unknown, notes }
 *          ok 只在**每一条都 ok** 时为真 —— unknown 不算通过。
 *
 *          `notes` 是**不改变通过与否**的说明(比如"可写边界这一维没声明,
 *          所以没检查")。它不会让 ok 变假,但必须能被看见。
 */
export function evaluateGate(dir, node, { mode = "cheap", timeout = 120_000 } = {}) {
  const allow = evalAllow(dir, node);

  const items = [
    ...allow.items,
    ...evalPaths(dir, node.fs),
    ...evalChanged(dir, node.fs),
    ...evalTree(dir, node.fs),
    ...evalProc(node.proc),
    ...evalVerify(dir, node, { mode, timeout }),
  ];

  const failed = items.filter((i) => i.status === FAIL);
  const unknown = items.filter((i) => i.status === UNKNOWN);

  return {
    ok: items.length > 0 && failed.length === 0 && unknown.length === 0,
    items,
    failed,
    unknown,
    notes: allow.notes,
    empty: items.length === 0,
  };
}
