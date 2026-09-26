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

import { workingTreeHash, treeDiff } from "./git.mjs";
import { findByPattern } from "./proc.mjs";

export const OK = "ok";
export const FAIL = "fail";
export const UNKNOWN = "unknown";

function item(part, label, status, detail = "", demand = "") {
  return { part, label, status, detail, demand };
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
 * @returns { ok, items, failed, unknown }
 *          ok 只在**每一条都 ok** 时为真 —— unknown 不算通过。
 */
export function evaluateGate(dir, node, { mode = "cheap", timeout = 120_000 } = {}) {
  const items = [
    ...evalPaths(dir, node.fs),
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
    empty: items.length === 0,
  };
}
