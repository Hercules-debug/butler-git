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

/**
 * 跑一个 git 命令。永远不抛 —— 失败以 {ok:false} 返回。
 *
 * `opts.raw = true` 时**不 trim 输出**。读**文件内容**时必须用它 ——
 * `git show HEAD:path` 的返回值是内容本身,trim 掉结尾换行会让
 * "内容和基线一样"被误判成"内容有变"(实测踩到)。
 * 树哈希、`status --porcelain` 那类行式输出则要 trim。
 */
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
    out: opts.raw ? (r.stdout ?? "") : (r.stdout ?? "").trim(),
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
 * ## 排除必须分两步走(BUG-1,实测趟出来的)
 *
 * 原来写的是一步:
 *
 *     git add -A -- . ':(exclude).bg'
 *
 * **它在本仓库必然失败。** `:(exclude)` 本身确实能排除未跟踪目录
 * (实测排得掉),但 `git add` 会**先**拿 pathspec 去匹配 `.bg`,
 * 撞上 `.gitignore` 就报错退出:
 *
 *     The following paths are ignored by one of your .gitignore files: .bg
 *     exit=1
 *
 * 于是 `workingTreeHash` 恒返回 `null` ⟹ 证据锚永远是空的、
 * 任何 `fsTree` 门禁永远点不亮。这恰好是本文件上面那段要防的死法,
 * 只是触发条件换了一个。
 *
 * 而 `.gitignore` 里不写 `.bg/` 的话,`.bg/` 又会进树 —— 两种写法都得能工作。
 * 所以拆成两步:
 *
 *     git add -A -- .                           # 不再显式匹配 .bg,不会报错
 *     git rm -r --cached --ignore-unmatch .bg    # 从**索引**里抹掉它
 *
 * 两步在"有 .gitignore"和"没有 .gitignore"两种仓库里都实测稳定
 * (见 `test/run.mjs` 验收 11 —— 那一条就是为这个 bug 补的)。
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

    // 第一步:全加。**不要**在这里用 :(exclude) —— 见上面那段。
    if (!git(dir, ["add", "-A", "--", "."], { env }).ok) return null;

    // 第二步:把工具自己的状态目录从**索引**里抹掉。
    // --ignore-unmatch:它本来就不在索引里时不该算失败。
    if (!git(dir, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", SELF_DIR], { env }).ok) {
      return null;
    }

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

/**
 * 路径在某个 rev 里的**内容原文**。不存在返回 `null`。
 *
 * **必须 raw**(不 trim):返回值是文件内容本身。
 * trim 掉结尾换行会让 "和基线一模一样" 被误判成 "内容有变" —— 实测踩到过。
 *
 * 注意它区分三种情况:
 *     null   文件在基线不存在
 *     ""     文件存在但内容为空
 *     "..."  文件存在且有内容
 */
export function fileAt(dir, rev, path) {
  const r = git(dir, ["show", `${rev}:${path}`], { raw: true });
  return r.ok ? r.out : null;
}

export function fileExists(dir, path) {
  return existsSync(join(dir, path));
}
