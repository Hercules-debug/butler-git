/**
 * git.mjs —— git 原语。**整个设计的地基。**
 *
 * ## 为什么用 git 而不是"自己扫文件"
 *
 * git 给的是**内容哈希**,不是"变没变":
 *
 *     HEAD          过去的某个世界
 *     工作区树哈希   现在这个世界长什么样
 *     树比对         两个世界差在哪几个文件
 *
 * 所以门禁可以问一个**绝对**问题 —— "世界和预计的一样吗" ——
 * 而不是相对问题 "世界变了没有"。后者说不出对错。
 *
 * ## 两条硬规则(都在这个文件里落地)
 *
 * 1. **观测动作不能改动观测对象。**
 *    算树哈希必须先"暂存",而 `git add` 会动真索引 —— 那等于边看边改。
 *    所以 `workingTreeHash` 用**临时索引**(GIT_INDEX_FILE)。
 *    `baselinePasses` 用**临时 worktree**,不碰当前工作区。
 *
 * 2. **"看不见"和"不存在"是两件事。**
 *    任何降级都返回 null 并说明原因,**绝不返回一个看起来正常的值**。
 *    这条是踩过的坑:cmdline 读不到时返回空串,调用方当成"进程不存在",
 *    于是观测能力退化和事实缺失长得一模一样。
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 跑一个 git 命令。永远不抛 —— 失败以 {ok:false} 返回。 */
export function git(cwd, args, opts = {}) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: opts.timeout ?? 30_000,
    env: opts.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return { ok: false, out: "", err: String(r.error.message) };
  return {
    ok: r.status === 0,
    out: (r.stdout ?? "").trim(),
    err: (r.stderr ?? "").trim(),
    status: r.status,
  };
}

export function isRepo(dir) {
  return git(dir, ["rev-parse", "--git-dir"]).ok;
}

/** HEAD 的 commit sha。空仓库返回 ""。 */
export function head(dir) {
  const r = git(dir, ["rev-parse", "HEAD"]);
  return r.ok ? r.out : "";
}

/** 工具自己的状态目录。**算树哈希时必须排除它。** */
export const SELF_DIR = ".bg";

/**
 * 工作区**当前内容**的树哈希。这是绝对判据的核心。
 *
 * 用临时索引算,所以真索引一点都不动 —— 见文件头规则 1。
 * 失败返回 null(不是空串) —— 见文件头规则 2。
 *
 * ## 必须排除工具自己的状态目录
 *
 * `.bg/` 里是账本和图 —— 它们**每做一次操作就会变**。
 * 不排除的话,树哈希每次都漂,于是:
 *
 *     任何"世界必须等于这个树"的门禁,永远都不可能通过
 *
 * 这不是理论问题 —— 上一个实现正是死在这里(`.butler/` 自己造成永久假阳性)。
 * 判据:**被观测对象里不能包含观测者自己的记录。**
 *
 * 用 pathspec 排除,不写 .gitignore、不碰真索引 —— 不留痕迹。
 */
export function workingTreeHash(dir) {
  if (!isRepo(dir)) return null;

  const tmp = mkdtempSync(join(tmpdir(), "bg-idx-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
  try {
    let r = git(dir, ["read-tree", "HEAD"], { env });
    if (!r.ok) {
      // 还没有 HEAD 的空仓库
      r = git(dir, ["read-tree", "--empty"], { env });
      if (!r.ok) return null;
    }
    const add = git(dir, ["add", "-A", "--", ".", `:(exclude)${SELF_DIR}`], { env });
    if (!add.ok) return null;
    const w = git(dir, ["write-tree"], { env });
    return w.ok ? w.out : null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 某个 rev 的树哈希。失败返回 null。 */
export function treeOf(dir, rev) {
  const r = git(dir, ["rev-parse", `${rev}^{tree}`]);
  return r.ok ? r.out : null;
}

/**
 * 两个树差在哪几个文件 —— **诊断用**。
 *
 * 只比哈希的话,失败时只能说"不一致",模型没法修。
 * `--name-status` 能说出 "M src/a.py / D src/c.py" —— 那才可修。
 */
export function treeDiff(dir, aTree, bTree) {
  const r = git(dir, ["diff", "--name-status", aTree, bTree]);
  if (!r.ok) return null;
  return r.out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [code, ...rest] = l.split(/\s+/);
      return { code, path: rest.join(" ") };
    });
}

/**
 * 这个命令在**基线(rev)**上跑得过吗。
 *
 * 判据是"门禁会不会是白给的":能在开工前就通过的门禁 = 没有门禁。
 *
 * 用一个**临时 worktree** 跑 —— 不碰当前工作区,也不碰真索引。
 * 跑完就拆掉(worktree 元数据在 .git/worktrees/,不进工作区)。
 *
 * 返回:
 *   true   基线时就通过   -> 它区分不了你做没做(白给)
 *   false  基线时不通过   -> 它是一道真的门禁
 *   null   跑不了         -> **不知道**,不假装查过
 */
export function baselinePasses(dir, cmd, { rev = "HEAD", timeout = 60_000 } = {}) {
  if (!isRepo(dir)) return null;
  if (!head(dir)) return null;

  const tmp = mkdtempSync(join(tmpdir(), "bg-base-"));
  const wt = join(tmp, "wt");
  try {
    const add = git(dir, ["worktree", "add", "--detach", wt, rev]);
    if (!add.ok) return null;

    const r = spawnSync(cmd, {
      shell: true,
      cwd: wt,
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.error) return null;
    return r.status === 0;
  } finally {
    git(dir, ["worktree", "remove", "--force", wt]);
    git(dir, ["worktree", "prune"]);
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 工作区相对某个基线树改动了哪些文件(诊断用)。 */
export function changedSince(dir, baseTree) {
  const cur = workingTreeHash(dir);
  if (cur === null || !baseTree) return null;
  if (cur === baseTree) return [];
  return treeDiff(dir, baseTree, cur);
}

/** 这个路径在基线里存在吗(内容原文)。不存在返回 null。 */
export function fileAt(dir, rev, path) {
  const r = git(dir, ["show", `${rev}:${path}`]);
  return r.ok ? r.out : null;
}

export function fileExists(dir, path) {
  return existsSync(join(dir, path));
}
