/**
 * git.mjs —— git 原语。**整个设计的地基。**
 *
 * ## 为什么用 git 而不是"自己扫文件"
 *
 * git 给的是**内容哈希**,不是"变没变":
 *
 *     base          过去的某个世界(节点的初始 commit)
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
 *    例外只有一处:`commitTree` 之后的 `readIndexFromHead`。那时候"改动"
 *    是刻意的 —— 不把索引挪到新 commit 上,`git status` 会把刚提交的东西
 *    全报成未提交改动,模型就看不清自己站在哪。
 *
 * 2. **"看不见"和"不存在"是两件事。**
 *    任何降级都返回 null 并说明原因,**绝不返回一个看起来正常的值**。
 *    这条是踩过的坑:cmdline 读不到时返回空串,调用方当成"进程不存在",
 *    于是观测能力退化和事实缺失长得一模一样。
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, unlinkSync } from "node:fs";
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
    input: opts.input ?? undefined,   // 给 `commit-tree -F -` 这类用
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

export function absoluteGitDir(dir) {
  const r = git(dir, ["rev-parse", "--absolute-git-dir"]);
  return r.ok ? r.out : null;
}

/** 工具自己的状态目录.**算树哈希时必须排除它。** */
export const SELF_DIR = ".bg";

/**
 * 工作区**当前内容**的树哈希。这是绝对判据的核心。
 *
 * 用临时索引算,所以真索引一点都不动 —— 见文件头规则 1。
 * 失败返回 null(不是空串) —— 见文件头规则 2。
 *
 * ## 必须排除工具自己的状态目录
 *
 * `.bg/` 里是图和账本 —— 它们**每做一次操作就会变**。
 * 不排除的话,树哈希每次都漂,于是:
 *
 *     任何"世界必须等于这个树"的判据,永远都不可能成立
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
 * 于是 `workingTreeHash` 恒返回 `null` ⟹ 证据锚永远是空的。
 * 这恰好是本文件上面那段要防的死法,只是触发条件换了一个。
 *
 * 而 `.gitignore` 里不写 `.bg/` 的话,`.bg/` 又会进树 —— 两种写法都得能工作。
 * 所以拆成两步:
 *
 *     git add -A -- .                           # 不再显式匹配 .bg,不会报错
 *     git rm -r --cached --ignore-unmatch .bg    # 从**索引**里抹掉它
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
 * **真索引**当前的树哈希 —— 只在**合并**时用。
 *
 * 合并是模型自己 `git merge --no-commit` 跑出来的,结果就**在索引里**。
 * 那份暂存是刻意的,不是观测副作用,所以这里读真索引是对的。
 *
 * 有未解决的冲突时 `write-tree` 会失败 —— 返回 null,由调用方要求"先解决冲突"。
 */
export function indexTree(dir) {
  const r = git(dir, ["write-tree"]);
  return r.ok ? r.out : null;
}

/** 还有冲突没解决的路径。合并提交前必须为空。 */
export function unmergedPaths(dir) {
  const r = git(dir, ["ls-files", "--unmerged", "-z"]);
  if (!r.ok) return null;
  return r.out.split("\0").filter(Boolean).map((l) => l.split("\t").pop() ?? l);
}

/** MERGE_HEAD 里的父们。不在合并中返回 []。 */
export function mergeHeads(dir) {
  const gd = absoluteGitDir(dir);
  if (!gd) return [];
  const f = join(gd, "MERGE_HEAD");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** 合并提交之后清掉 MERGE_HEAD —— 否则 git 一直以为还在合并中。 */
export function clearMergeState(dir) {
  const gd = absoluteGitDir(dir);
  if (!gd) return false;
  for (const f of ["MERGE_HEAD", "MERGE_MSG"]) {
    try {
      const p = join(gd, f);
      if (existsSync(p)) unlinkSync(p);
    } catch { /* 清不掉就算了,不影响提交本身 */ }
  }
  return true;
}

/**
 * 两个版本差在哪几个文件 —— Δ 比对和诊断都靠它。
 *
 * 只比哈希的话,失败时只能说"不一致",模型没法修。
 * `--name-status` 能说出 "M src/a.py / D src/c.py" —— 那才可修。
 *
 * **用 `-z`**:路径里带空格时行式输出会切坏(实测:文件名含空格的
 * 改动被当成两个路径)。
 *
 * 重命名会输出 `R100\0old\0new\0`,所以这里带 `to`。
 */
export function diffNameStatus(dir, from, to) {
  const r = git(dir, ["diff", "--name-status", "-z", from, to]);
  if (!r.ok) return null;
  const parts = r.out.split("\0");
  const out = [];
  let i = 0;
  while (i < parts.length) {
    const raw = parts[i++];
    if (!raw) continue;
    const code = raw.replace(/\d+$/, "");   // R100 -> R, C75 -> C
    const path = parts[i++];
    if (path === undefined) break;
    if (code === "R" || code === "C") {
      const to2 = parts[i++];
      out.push({ code, path, to: to2 });
    } else {
      out.push({ code, path });
    }
  }
  return out;
}

/** `a` 是 `b` 的祖先吗 —— 合并门禁第 1 条。 */
export function isAncestor(dir, a, b) {
  const r = git(dir, ["merge-base", "--is-ancestor", a, b]);
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null;   // 跑不了 = 不知道,不假装查过
}

/** git 的身份。没配的话 commit-tree 会失败,所以要能提前说清楚。 */
export function identity(dir) {
  return {
    name: git(dir, ["config", "user.name"]).out,
    email: git(dir, ["config", "user.email"]).out,
  };
}

/**
 * 用 `commit-tree` **精确提交一个树**。
 *
 * ## 为什么不是 `git commit`
 *
 * `git commit` 提交的是"跑命令那一刻的工作区"。而门禁要的是:
 *
 *     提交的树 == 刚被验过的那个树(Y),一个字节都不差
 *
 * 中间只要有任何东西变了 —— 哪怕只是验证程序留下的临时产物 ——
 * `git commit` 就会把它一起提进去,而 trailer 还写着"验过了"。
 *
 * `commit-tree` 直接吃树哈希:提交什么由**我们**说,不由"那一刻"决定。
 * 这也是 `bg-verified-tree` 能成立的唯一理由(见 nodes.mjs)。
 *
 * 没有身份时给一个明确的兜底,并把这件事告诉调用方 ——
 * 静默用兜底等于让 commit 的作者变成一句假话。
 */
export function commitTree(dir, { tree, parents = [], message }) {
  const args = ["commit-tree", tree];
  for (const p of parents) args.push("-p", p);

  const id = identity(dir);
  const env = { ...process.env };
  let fallbackUsed = false;
  for (const [k, v] of [
    ["GIT_AUTHOR_NAME", id.name],
    ["GIT_AUTHOR_EMAIL", id.email],
    ["GIT_COMMITTER_NAME", id.name],
    ["GIT_COMMITTER_EMAIL", id.email],
  ]) {
    if (v) env[k] = v;
    else {
      env[k] = k.includes("NAME") ? "bg" : "bg@localhost";
      fallbackUsed = true;
    }
  }

  // **message 必须走 stdin。** `git commit-tree` 只从标准输入读 message ——
  // 不喂的话它会一直等(或者拿到空),产出一个**没有 message 的 commit**,
  // 于是 trailer 全丢,证据也就没了。用 -F - 显式说"从 stdin 读"。
  const r = git(dir, [...args, "-F", "-"], { env, input: message, raw: false });
  if (!r.ok) return { sha: null, err: r.err || r.out, fallbackUsed };
  return { sha: r.out, err: null, fallbackUsed };
}

/** 把 HEAD 挪到这个 commit。 */
export function updateHead(dir, sha) {
  return git(dir, ["update-ref", "HEAD", sha]).ok;
}

/**
 * 让索引跟上 HEAD。**不动工作区。**
 *
 * 不做这一步的话,索引还停在旧 commit,于是 `git status` 会把刚提交进
 * 去的改动**全部**报成"未提交" —— 模型看到的图和事实不符。
 */
export function readIndexFromHead(dir) {
  return git(dir, ["read-tree", "HEAD"]).ok;
}

/**
 * 这个命令在**基线(rev)**上跑得过吗。
 *
 * 判据是"门禁会不会是白给的":能在开工前就通过的 P = 验不了任何东西。
 *
 * 用一个**临时 worktree** 跑 —— 不碰当前工作区,也不碰真索引。
 * 跑完就拆掉(worktree 元数据在 .git/worktrees/,不进工作区)。
 *
 * 返回:
 *   true   基线时就通过   ->  ⚠ 它区分不了你做没做
 *   false  基线时不通过   ->  它是一道真的门禁
 *   null   跑不了         ->  **不知道**,不假装查过
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
  return diffNameStatus(dir, baseTree, cur);
}

/**
 * 提交历史 —— `node_log` 和"图外的提交"都从这里来。
 *
 * 用 `\x1e` 分记录、`\x1f` 分字段:commit message 里什么分隔符都可能出现,
 * 用这两个控制字符是唯一不会被内容本身骗过的切法。
 */
export function logRaw(dir, { limit = 500 } = {}) {
  const r = git(dir, [
    "log",
    `--max-count=${limit}`,
    "--format=%H%x1f%P%x1f%B%x1e",
  ]);
  if (!r.ok) return [];
  return r.out
    .split("\x1e")
    .map((s) => s.replace(/^\n+/, ""))
    .filter(Boolean)
    .map((rec) => {
      const [sha, parents, body = ""] = rec.split("\x1f");
      return {
        sha,
        parents: parents.split(" ").filter(Boolean),
        body,
      };
    });
}

/** 一个 commit 的完整 message。 */
export function commitMessage(dir, sha) {
  const r = git(dir, ["log", "-1", "--format=%B", sha], { raw: true });
  return r.ok ? r.out : null;
}

/** 工作区里某个文件/目录存在吗。 */
export function pathExists(dir, rel) {
  return existsSync(join(dir, rel));
}
