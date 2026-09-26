/**
 * contract.mjs —— 门禁**写下来的时候**就要过的检查。
 *
 * 这里只回答一个问题:**这份门禁够格吗。**
 * "这个节点现在做到了没有"是 gate.mjs 的事 —— 两件事不能混。
 *
 * ## 最要紧的一条:整个门禁不能是白给的
 *
 * 判据:门禁是全部断言的**合取**。如果它在**基线时就已经成立**,
 * 那它在开工前就是绿的 —— 等于没有门禁。
 *
 * 必须看合取,不能一条一条看:一条"别破坏 X"的回归断言单独看会在基线通过,
 * 但如果**另一条**要求世界变化,整体门禁仍然有约束力。单条判会冤枉它。
 *
 * 这一条挡住了最危险的一类松弛:**写个假验证程序糊过去**
 * (`verify: "true"` —— 永远退出 0)。单条检查看不见它,
 * 只有真的去基线上跑一遍才暴露。
 */

import { treeOf, baselinePasses, fileAt } from "./git.mjs";

/** 安全网:基线成立正是它的意思,不参与"白给"判断。 */
function isSafetyNet(a) {
  return a.kind === "absent";
}

export function checkContract(dir, c) {
  const problems = [];
  const notes = [];

  if (!c.id) problems.push("契约缺 id");
  if (!c.expect?.trim()) problems.push("契约缺 expect —— 一句话说清这一步要达成什么");

  const paths = c.fs?.paths ?? [];
  const hasTree = Boolean(c.fs?.tree);
  const present = c.proc?.present ?? [];
  const absent = c.proc?.absent ?? [];
  const hasVerify = Boolean(c.verify);

  if (!paths.length && !hasTree && !present.length && !absent.length && !hasVerify) {
    problems.push("门禁是空的 —— 至少要有一件可测量的事");
    return { ok: false, problems, notes };
  }

  // ---------------------------------------------------------- 矛盾
  for (const p of present) {
    if (absent.includes(p)) {
      problems.push(`矛盾: '${p}' 同时出现在 present 和 absent —— 两个都不可能同时成立`);
    }
  }
  const byPath = new Map();
  for (const a of paths) {
    byPath.set(a.path, [...(byPath.get(a.path) ?? []), a]);
  }
  for (const [path, list] of byPath) {
    const kinds = new Set(list.map((a) => a.kind));
    if (kinds.has("exists") && kinds.has("absent")) {
      problems.push(`矛盾: ${path} 既要求存在又要求不存在`);
    }
    const yes = list.find((a) => a.kind === "contains");
    const no = list.find((a) => a.kind === "not_contains");
    if (yes && no && yes.pattern === no.pattern) {
      problems.push(`矛盾: ${path} 既要求包含又要求不包含 ${JSON.stringify(yes.pattern)}`);
    }
  }

  // ------------------------------------------------------ 非空转
  const vac = checkVacuity(dir, c);
  problems.push(...vac.problems);
  notes.push(...vac.notes);

  return { ok: problems.length === 0, problems, notes };
}

/**
 * 整个门禁在基线时成立吗。
 *
 * 分两段,按**成本**排序 —— 只有这样它才不会拖慢常见情况:
 *
 *   1. 先看便宜的文件侧。只要有一条在基线**不**成立,门禁就有约束力,
 *      立刻返回,**完全不用跑命令**。
 *   2. 只有文件侧全部在基线成立时,才去跑验证程序(可能很贵)。
 */
export function checkVacuity(dir, c) {
  const problems = [];
  const notes = [];

  const paths = c.fs?.paths ?? [];
  const present = c.proc?.present ?? [];
  const absent = c.proc?.absent ?? [];
  const hasTree = Boolean(c.fs?.tree);
  const hasVerify = Boolean(c.verify);

  const forcePaths = paths.filter((a) => !isSafetyNet(a));
  const forcePresent = present.length > 0;

  // 只有安全网 -> 没有任何东西会失败
  if (!forcePaths.length && !hasTree && !forcePresent && !hasVerify) {
    problems.push(
      "门禁里只有『不许留下什么』这类安全网,没有任何会失败的东西 —— "
      + "它在开工前就是绿的,等于没有门禁",
    );
    return { problems, notes };
  }

  // `proc.present` 在基线判不了(进程侧没有基线快照,这是明确接受的取舍)。
  // 所以**不据此拒** —— 那会冤枉一个正常的节点。它确实会失败,有约束力。
  if (forcePresent) return { problems, notes };

  const baseTree = treeOf(dir, "HEAD");
  if (!baseTree) {
    notes.push("拿不到 HEAD 的树哈希(非 git 仓库 或 空仓库)—— 非空转没法判定");
    return { problems, notes };
  }

  // ---- 第一段:便宜的文件侧 ----
  for (const a of forcePaths) {
    if (!baselineSatisfiedPath(dir, a)) return { problems, notes };  // 有约束力
  }
  if (hasTree && c.fs.tree !== baseTree) return { problems, notes };  // 有约束力

  // ---- 第二段:文件侧全在基线成立,门禁全靠验证程序撑着 ----
  if (!hasVerify) {
    problems.push(
      "整个门禁在基线时就已经成立 —— 它在开工前就是绿的,等于没有门禁。"
      + "至少要有一样**现在不成立**的东西",
    );
    return { problems, notes };
  }

  const r = baselinePasses(dir, c.verify);
  if (r === true) {
    problems.push(
      `验证程序在基线(HEAD)上就已经通过 —— 它区分不了你做没做: ${c.verify}`,
    );
  } else if (r === null) {
    // **诚实降级**:不能当成通过(冤枉),也不能当成不通过(放过)。
    notes.push(
      `验证程序没能在基线上跑一遍(worktree 失败 / 超时 / 非 git)—— `
      + `所以**不知道**它是不是本来就过: ${c.verify}`,
    );
  }
  return { problems, notes };
}

/** 这条文件断言,在基线时就已经成立了吗。 */
function baselineSatisfiedPath(dir, a) {
  const text = fileAt(dir, "HEAD", a.path);
  switch (a.kind) {
    case "exists": return text !== null;
    case "absent": return text === null;
    case "contains": return text !== null && Boolean(a.pattern) && text.includes(a.pattern);
    case "not_contains": return text === null || !text.includes(a.pattern ?? "");
    default: return false;
  }
}
