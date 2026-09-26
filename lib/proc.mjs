/**
 * proc.mjs —— 进程侧:**只对照声明,不扫描**。
 *
 * ## 判据从"猜"变成"对照声明"
 *
 * 全表扫描找残留这件事**没有可靠判据** —— 每加一层过滤都是在赌
 * (名字像不像系统进程、活多久、白名单),而**噪声比漏报更危险**:
 * 噪声会让你开始忽略报告。
 *
 * 所以这里只做一件事:对照节点**事先声明的** pattern 查。
 * 代价明说:**模型没声明的进程,系统发现不了。**
 *
 * ## 这个文件存在的另一个理由:修一个真实的坑
 *
 * 旧实现里 `cmdline()` 读不到时返回**空串**,调用方 `if (!argv) continue`
 * —— 于是"**我看不见**"被当成了"**它不存在**"。
 *
 * 那个 bug 的表现是:沙箱里 `ps` 被拒 -> 所有 `proc_present` 永远找不到目标
 * -> `proc_absent` 永远通过。**不报错,只是安静地给出错误结论。**
 *
 * 所以这里显式区分三种状态:
 *
 *     matched      真的匹配到了
 *     absent       真的没有(读得到命令行,且不匹配)
 *     unreadable   **看不见** —— 观测能力受限,不是事实
 *
 * `unreadable` 既不能当成通过,也不能当成不通过。
 */

import { spawnSync } from "node:child_process";
import { basename } from "node:path";

function pgrep(pattern) {
  const r = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8", timeout: 10_000 });
  if (r.error || r.status !== 0) return [];   // 退出码 1 = 没匹配,不是错误
  return (r.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+$/.test(l))
    .map(Number);
}

function cmdline(pid) {
  const r = spawnSync("/bin/ps", ["-o", "args=", "-p", String(pid)],
    { encoding: "utf8", timeout: 10_000 });
  if (r.error || r.status !== 0) return null;   // null = 读不到(不是 "空命令行")
  const out = (r.stdout ?? "").trim();
  return out || null;
}

function stem(name) {
  const base = basename(name);
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(0, i) : base;
}

/**
 * 命令行匹不匹配 pattern。
 *
 * ## 只认 argv[0] / argv[1] —— 这是实测标定出来的
 *
 * 子串匹配会让**观测者命中自己**:跑检查的那个 shell,它自己的命令行里
 * 就含 pattern 字面串,于是每次都报"该关的还没关",而且永远清不掉。
 *
 * 而真的启动一个脚本时形态是 `/bin/sh <脚本路径>` —— 名字在 argv[1]。
 */
function matches(cmd, pattern) {
  const argv = cmd.split(/\s+/).filter(Boolean);
  if (!argv.length) return false;
  const a0 = basename(argv[0]);
  if (a0 === pattern || stem(a0) === pattern) return true;
  if (argv.length >= 2) {
    const a1 = basename(argv[1]);
    if (a1 === pattern || stem(a1) === pattern) return true;
  }
  return false;
}

/**
 * 按 pattern 查进程。
 *
 * 返回 { matched: [pid], capability: "ok"|"unreadable" }
 *
 * capability = "unreadable" 的意思是:**有候选进程,但一条命令行都读不到**。
 * 这时不能下任何结论 —— 调用方必须把它当成"不知道",不能当成"没有"。
 */
export function findByPattern(pattern) {
  const pids = pgrep(pattern);
  const matched = [];
  let read = 0;

  for (const pid of pids) {
    const cl = cmdline(pid);
    if (cl === null) continue;
    read += 1;
    if (matches(cl, pattern)) matched.push(pid);
  }

  // 有候选、却一条也没读到 -> 观测能力受限
  const capability = pids.length > 0 && read === 0 ? "unreadable" : "ok";
  return { matched: matched.sort((a, b) => a - b), candidates: pids.length, read, capability };
}
