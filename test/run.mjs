/**
 * run.mjs —— 负向验收。**全部是"抓错",不是"跑通"。**
 *
 * 理由和上一个实现一样:这个东西的价值全在"它会不会漏",
 * 而正向演示证明不了这一点。
 *
 * 用法: node test/run.mjs
 */

import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BG = join(HERE, "..", "bin", "bg.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let PASS = 0;
let FAIL = 0;
const ok = (m) => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); PASS += 1; };
const bad = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); FAIL += 1; };
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);
const say = (m) => console.log(`      ${m}`);

const tmpdirs = [];
function newRepo() {
  const d = mkdtempSync(join(tmpdir(), "bg-test-"));
  tmpdirs.push(d);
  sh("git init -q .", d);
  sh("git -c user.email=a@b -c user.name=a commit -q --allow-empty -m init", d);
  return d;
}
function sh(cmd, cwd) {
  return spawnSync(cmd, { shell: true, cwd, encoding: "utf8" });
}
/** 跑 bg。返回 {code, out}。 */
function bg(dir, args) {
  const r = spawnSync("node", [BG, "--project", dir, ...args], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const write = (dir, rel, text) => {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text, "utf8");
};

// ================================================================ 验收 1
head("验收 1:白给的门禁 —— 能在开工前通过的门禁 = 没有门禁");

{
  const d = newRepo();
  write(d, "x.py", "v1\n");
  sh("git add -A && git -c user.email=a@b -c user.name=a commit -q -m base", d);
  bg(d, ["init"]);

  // 假验证程序:永远退出 0
  const fake = bg(d, ["check", "--id", "fake", "--expect", "功能可用", "--verify", "true"]);
  if (fake.code !== 0 && /基线/.test(fake.out)) {
    ok("假验证程序被拒(它区分不了你做没做)");
  } else {
    bad(`假验证程序没被拒: ${fake.out.trim().slice(0, 120)}`);
  }

  // 只有安全网
  const net = bg(d, ["check", "--id", "net", "--expect", "别留垃圾", "--fs-absent", "junk.tmp"]);
  if (net.code !== 0 && /安全网/.test(net.out)) {
    ok("只有安全网被拒(没有任何会失败的东西)");
  } else {
    bad(`只有安全网没被拒: ${net.out.trim().slice(0, 120)}`);
  }

  // 基线就满足的文件断言 + 没有验证程序
  const vac = bg(d, ["check", "--id", "vac", "--expect", "x", "--fs-exists", "x.py"]);
  if (vac.code !== 0) {
    ok("基线已满足的文件断言 + 无验证程序 -> 拒");
  } else {
    bad("整个门禁在基线成立却没被拒");
  }

  // 真的门禁:基线跑不过
  const real = bg(d, ["check", "--id", "real", "--expect", "x",
    "--fs-contains", "x.py:v2", "--verify", "grep -q v2 x.py"]);
  if (real.code === 0) {
    ok("真门禁(基线跑不过)不被误拒");
  } else {
    bad(`真门禁被误拒: ${real.out.trim().slice(0, 120)}`);
  }

  // 安全网 + 真约束 -> 不该被误拒
  const mixed = bg(d, ["check", "--id", "mixed", "--expect", "x",
    "--fs-absent", "junk.tmp", "--fs-contains", "x.py:v2"]);
  if (mixed.code === 0) {
    ok("file_absent + 真约束不被误拒(一刀切会拒掉正当的清理约束)");
  } else {
    bad("file_absent 被误拒了");
  }
}

// ================================================================ 验收 2
head("验收 2:自相矛盾的门禁必须被拒");

{
  const d = newRepo();
  write(d, "x.py", "v1\n");
  sh("git add -A && git -c user.email=a@b -c user.name=a commit -q -m base", d);
  bg(d, ["init"]);

  const both = bg(d, ["check", "--id", "c1", "--expect", "x", "--fs-contains", "x.py:v2",
    "--proc-present", "svc", "--proc-absent", "svc"]);
  if (both.code !== 0 && /矛盾/.test(both.out)) {
    ok("同一个 pattern 既 present 又 absent -> 拒");
  } else {
    bad("自相矛盾的进程声明没被拒");
  }

  const ex = bg(d, ["check", "--id", "c2", "--expect", "x",
    "--fs-exists", "x.py", "--fs-absent", "x.py", "--verify", "false"]);
  if (ex.code !== 0 && /矛盾/.test(ex.out)) {
    ok("同一个路径既存在又不存在 -> 拒");
  } else {
    bad("自相矛盾的文件声明没被拒");
  }
}

// ================================================================ 验收 3
head("验收 3:第一盏灯 —— 只有验收能点亮它,而且点亮后不被推翻");

{
  const d = newRepo();
  write(d, "x.py", "v1\n");
  sh("git add -A && git -c user.email=a@b -c user.name=a commit -q -m base", d);
  bg(d, ["init"]);
  bg(d, ["declare", "--id", "n1", "--expect", "让 x 支持 v2", "--owner", "user",
    "--fs-contains", "x.py:v2", "--verify", "grep -q v2 x.py"]);

  // 世界**恰好**符合,但没验收
  write(d, "x.py", "v2\n");
  const before = bg(d, ["view"]);
  // 第一盏灯必须是 ○(没通过过)。第二盏此时是 · ——
  // 因为默认(cheap)不跑验证程序,所以第二盏灯还没有结论。
  if (/n1 {2}○/.test(before.out)) {
    ok("断言恰好为真 ≠ 通过过(第一盏灯没亮)");
  } else {
    bad(`没验收却亮了第一盏灯: ${before.out.split("\n")[0]}`);
  }

  // 验收
  const acc = bg(d, ["accept", "n1"]);
  if (acc.code === 0 && /"ok": true/.test(acc.out)) {
    ok("验收通过 -> 第一盏灯点亮");
  } else {
    bad(`验收没通过: ${acc.out.trim().slice(0, 140)}`);
  }

  // 证据锚
  const led = readFileSync(join(d, ".bg", "ledger.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .find((e) => e.type === "accept");
  if (led?.evidence?.tree && led.evidence.gate) {
    ok(`证据锚记下了门禁 + 树(${led.evidence.tree.slice(0, 8)}) + 时间`);
  } else {
    bad("验收没留下证据锚");
  }

  // 破坏世界 -> 第一盏灯仍亮,第二盏灯红
  write(d, "x.py", "v1\n");
  const after = bg(d, ["view"]);
  if (/●○/.test(after.out)) {
    ok("世界坏了:第一盏灯**仍亮**(历史事实),第二盏灯报出回归");
  } else {
    bad(`回归没被表达出来: ${after.out.split("\n")[0]}`);
  }
}

// ================================================================ 验收 4
head("验收 4:门禁的所有权与不可篡改");

{
  const d = newRepo();
  write(d, "x.py", "v1\n");
  sh("git add -A && git -c user.email=a@b -c user.name=a commit -q -m base", d);
  bg(d, ["init"]);
  bg(d, ["declare", "--id", "h", "--expect", "人定的", "--owner", "user", "--fs-contains", "x.py:v2"]);

  // 人定的门禁,模型不能改
  const tamper = bg(d, ["declare", "--id", "h", "--expect", "改松", "--owner", "user", "--fs-contains", "x.py:v9"]);
  if (tamper.code !== 0 && /user/.test(tamper.out)) {
    ok("人定(user)的门禁,模型改不动");
  } else {
    bad("模型竟然改动了人定的门禁");
  }

  // 模型自己的中间节点可以改
  bg(d, ["declare", "--id", "m", "--expect", "我拆的", "--owner", "model", "--fs-contains", "x.py:v3"]);
  const mine = bg(d, ["declare", "--id", "m", "--expect", "改主意了", "--owner", "model", "--fs-contains", "x.py:v4"]);
  if (mine.code === 0) {
    ok("模型自己拆的(model)中间节点可以改 —— 它改的是手段");
  } else {
    bad("模型改不动自己拆的节点");
  }

  // 通过过的 -> 冻结
  write(d, "x.py", "v2\n");
  bg(d, ["accept", "h"]);
  const frozen = bg(d, ["declare", "--id", "h", "--expect", "改掉它", "--owner", "user", "--fs-contains", "x.py:v9"]);
  if (frozen.code !== 0 && /通过过/.test(frozen.out)) {
    ok("通过过的节点门禁冻结(要变就起新节点)");
  } else {
    bad("通过之后还能改门禁 —— 验收标准可以事后消失");
  }

  // 改写要留痕,而且记门禁本身
  const led = readFileSync(join(d, ".bg", "ledger.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .find((e) => e.type === "node" && e.kind === "改写" && e.node === "m");
  if (led?.gate && led?.prevGate) {
    ok("改写留痕:标成【改写】,并记下门禁与改前的门禁");
  } else {
    bad("改写没留痕,或没记门禁本身");
  }
}

// ================================================================ 验收 5
head("验收 5:git 原生 —— 树比较是绝对判据,而且能诊断");

{
  const d = newRepo();
  write(d, "a.py", "v1\n");
  write(d, "b.py", "v1\n");
  sh("git add -A && git -c user.email=a@b -c user.name=a commit -q -m base", d);
  bg(d, ["init"]);

  // 把世界摆成"预计的样子",然后问工具:当前树哈希是多少。
  // (用工具自己的判据,才能保证两边说的是同一件事。)
  write(d, "a.py", "v2\n");
  const want = JSON.parse(bg(d, ["treeinfo"]).out).workingTree;

  // 先改回去 —— 这样门禁在基线不成立,才有约束力
  write(d, "a.py", "v1\n");
  bg(d, ["declare", "--id", "t", "--expect", "世界等于预计", "--fs-tree", want]);

  const no = bg(d, ["assert", "t"]);
  if (no.code !== 0 && /不一致/.test(no.out) && /a\.py/.test(no.out)) {
    ok("树不一致被抓住,而且**说出是哪个文件**");
    say(no.out.split("\n").find((l) => /不一致/.test(l))?.trim() ?? "");
  } else {
    bad(`树比较没诊断: ${no.out.trim().slice(0, 140)}`);
  }

  write(d, "a.py", "v2\n");
  const yes = bg(d, ["assert", "t"]);
  if (yes.code === 0) {
    ok("世界等于预计 -> 过(绝对判据)");
  } else {
    bad(`改对了却没过: ${yes.out.trim().slice(0, 140)}`);
  }

  // 工具自己的状态目录**不能**污染树哈希 ——
  // 否则每做一次操作哈希就漂,任何树门禁都不可能通过。
  const h1 = JSON.parse(bg(d, ["treeinfo"]).out).workingTree;
  bg(d, ["declare", "--id", "other", "--expect", "再写一个", "--fs-contains", "b.py:v9"]);
  const h2 = JSON.parse(bg(d, ["treeinfo"]).out).workingTree;
  if (h1 === h2) {
    ok("写节点不会让树哈希漂(.bg/ 已被排除 —— 否则门禁永远不可能通过)");
  } else {
    bad("工具自己的状态污染了树哈希 —— 观测者的记录混进了被观测对象");
  }
}

// ================================================================ 验收 6
head("验收 6:.gitignore 的路径 —— 树看不见,但直接 stat 看得见");

{
  const d = newRepo();
  write(d, ".gitignore", "build/\n");
  write(d, "x.py", "v1\n");
  sh("git add -A && git -c user.email=a@b -c user.name=a commit -q -m base", d);
  bg(d, ["init"]);

  // 产物落在被 ignore 的路径里;同时把一个**被跟踪**的文件改出真变化
  // (只声明"世界等于现在这样"是白给的门禁,会被正确地拒掉 —— 那不是这一条要测的)
  write(d, "build/out.js", "compiled\n");
  write(d, "x.py", "v2\n");
  const want = JSON.parse(bg(d, ["treeinfo"]).out).workingTree;

  // 改回去,让门禁有约束力
  write(d, "x.py", "v1\n");
  const dec = bg(d, ["declare", "--id", "art", "--expect", "世界等于预计", "--fs-tree", want]);
  if (dec.code !== 0) {
    bad(`声明失败: ${dec.out.trim().slice(0, 120)}`);
  }

  // 现在:build/out.js 一直在,而树比较**完全不知道它的存在**
  write(d, "x.py", "v2\n");
  const treeRes = bg(d, ["assert", "art"]);
  if (treeRes.code === 0) {
    ok("树比较通过 —— 而 build/out.js 一直在,它**根本没看见**(ignored 路径不进树)");
  } else {
    bad(`树比较被 ignored 路径影响了: ${treeRes.out.trim().slice(0, 120)}`);
  }

  bg(d, ["declare", "--id", "stat", "--expect", "产物在", "--fs-exists", "build/out.js"]);
  const statRes = bg(d, ["assert", "stat"]);
  if (statRes.code === 0) {
    ok("fsExists 直接 stat -> **免疫 .gitignore**,产物看得见");
  } else {
    bad(`fsExists 竟然看不见产物: ${statRes.out.trim().slice(0, 120)}`);
  }
}

// ================================================================ 验收 7
head("验收 7:观测不能有副作用");

{
  const d = newRepo();
  write(d, "x.py", "v1\n");
  sh("git add -A && git -c user.email=a@b -c user.name=a commit -q -m base", d);
  bg(d, ["init"]);
  bg(d, ["declare", "--id", "n", "--expect", "x", "--fs-contains", "x.py:v2", "--verify", "grep -q v2 x.py"]);
  write(d, "x.py", "v2\n");
  write(d, "extra.py", "new\n");

  const before = sh("git status --porcelain", d).stdout;
  bg(d, ["accept", "n"]);
  const after = sh("git status --porcelain", d).stdout;

  if (before === after) {
    ok("accept 之后工作区状态一字不变(算树哈希用了临时索引)");
  } else {
    bad("观测动作改了工作区/索引 —— 边看边改");
    say(`before: ${JSON.stringify(before)}`);
    say(`after:  ${JSON.stringify(after)}`);
  }

  const wt = sh("git worktree list", d).stdout.trim().split("\n");
  if (wt.length === 1) {
    ok("临时 worktree 清理干净(没留残骸)");
  } else {
    bad(`worktree 有残留: ${wt.join(" | ")}`);
  }
}

// ================================================================ 验收 8
head("验收 8:进程侧 —— 『看不见』绝不能变成『不存在』");

{
  const d = newRepo();
  write(d, "x.py", "v1\n");
  sh("git add -A && git -c user.email=a@b -c user.name=a commit -q -m base", d);
  bg(d, ["init"]);

  // 起一个**真正脱离**的进程:用 detached + unref。
  // (用 shell 的 `&` 不行 —— spawnSync 等到 shell 退出时,子进程会被带走。)
  write(d, "svc_zz.sh", "#!/bin/sh\nsleep 60\n");
  const child = spawn("/bin/sh", ["svc_zz.sh"], { cwd: d, detached: true, stdio: "ignore" });
  child.unref();
  await sleep(700);

  bg(d, ["declare", "--id", "p", "--expect", "服务在跑",
    "--proc-present", "svc_zz", "--fs-contains", "x.py:v2"]);
  write(d, "x.py", "v2\n");

  const res = spawnSync("node", [BG, "--project", d, "accept", "p"], { encoding: "utf8" });
  const text = `${res.stdout ?? ""}${res.stderr ?? ""}`;

  try { process.kill(-child.pid, "SIGKILL"); } catch { /* 已经没了 */ }

  // 两种结果都算对,但必须**说清楚是哪一种**:
  //   读得到命令行 -> 真的匹配到了 -> 过
  //   读不到命令行 -> 必须说"观测能力受限",不能默默当成"没找到"
  if (res.status === 0) {
    ok("进程匹配成功(这个宿主读得到命令行)");
  } else if (/观测能力受限|不知道/.test(text)) {
    ok("读不到命令行时明确报『观测能力受限』,而不是悄悄当成『没找到』");
    say(text.split("\n").find((l) => /受限/.test(l))?.trim() ?? "");
  } else {
    bad(`进程看不见时给了错误结论: ${text.trim().slice(0, 160)}`);
  }
}

// ================================================================ 验收 9
head("验收 9:两盏灯会**定位** —— 坏一个,别的灯不受影响");

{
  const d = newRepo();
  write(d, "x.py", "v1\n");
  write(d, "y.py", "v1\n");
  sh("git add -A && git -c user.email=a@b -c user.name=a commit -q -m base", d);
  bg(d, ["init"]);
  bg(d, ["declare", "--id", "c1", "--parent", "root", "--expect", "改 x", "--fs-contains", "x.py:XX"]);
  bg(d, ["declare", "--id", "c2", "--parent", "root", "--expect", "改 y", "--fs-contains", "y.py:YY"]);
  bg(d, ["declare", "--id", "root", "--expect", "整体",
    "--fs-contains", "x.py:XX", "--fs-contains", "y.py:YY"]);

  write(d, "x.py", "XX\n");
  write(d, "y.py", "YY\n");
  bg(d, ["accept", "c1"]);
  bg(d, ["accept", "c2"]);

  write(d, "y.py", "broken\n");
  const v = bg(d, ["view"]);
  const c1line = v.out.split("\n").find((l) => l.includes("c1")) ?? "";
  const c2line = v.out.split("\n").find((l) => l.includes("c2")) ?? "";

  if (/●●/.test(c1line) && /●○/.test(c2line)) {
    ok("只坏一个:坏的那个变 ●○,另一个保持 ●●");
  } else {
    bad(`定位不对 —— c1=[${c1line.trim()}] c2=[${c2line.trim()}]`);
  }
  if (/现在已经坏了\(c2\)/.test(v.out)) {
    ok("心跳指名道姓说是哪个节点坏了");
  } else {
    bad("心跳没定位到具体节点");
  }
}

// ================================================================ 验收 10
head("验收 10:作废是**追加**,不改写历史");

{
  const d = newRepo();
  write(d, "x.py", "v1\n");
  sh("git add -A && git -c user.email=a@b -c user.name=a commit -q -m base", d);
  bg(d, ["init"]);
  bg(d, ["declare", "--id", "n", "--expect", "x", "--fs-contains", "x.py:v2"]);
  write(d, "x.py", "v2\n");
  bg(d, ["accept", "n"]);
  bg(d, ["retract", "n", "--reason", "后来发现验错了"]);

  const lines = readFileSync(join(d, ".bg", "ledger.jsonl"), "utf8").split("\n").filter(Boolean);
  const hasAccept = lines.some((l) => JSON.parse(l).type === "accept");
  const hasRetract = lines.some((l) => JSON.parse(l).type === "retract");

  if (hasAccept && hasRetract) {
    ok("作废后 accept 那条**还在** —— 账本可读出『曾经通过,后被作废』");
  } else {
    bad("作废把历史抹掉了(应该追加,不该改写)");
  }

  const v = bg(d, ["view"]);
  if (/○/.test(v.out.split("\n")[0])) {
    ok("作废后第一盏灯灭了");
  } else {
    bad(`作废后第一盏灯还亮着: ${v.out.split("\n")[0]}`);
  }
}

// ================================================================ 验收 11
head("验收 11:树哈希在【两种 .gitignore 写法】下都必须算得出来(BUG-1)");

// 这一条是为一个真 bug 补的:
//
//   `workingTreeHash` 原来用 `git add -A -- . ':(exclude).bg'` 一步排除。
//   `:(exclude)` 本身排得掉未跟踪目录,但 `git add` 会**先**拿 pathspec 匹配 `.bg`,
//   撞上 `.gitignore` 就报错退出 —— 于是函数恒返回 null,
//   证据锚永远是空的、任何 fsTree 门禁永远点不亮。
//
// **原来的测试全都漏了**,因为那些临时仓库都没有 `.gitignore`。
// 所以这一条**两种写法都测**,少一种就会重新漏掉。
for (const [label, ignored] of [["没有 .gitignore", false], ["有 .gitignore 且忽略 .bg/", true]]) {
  const d = newRepo();
  if (ignored) write(d, ".gitignore", "build/\n.bg/\n");
  write(d, "x.py", "v1\n");
  sh("git add -A && git -c user.email=a@b -c user.name=a commit -q -m base", d);
  bg(d, ["init"]);

  const t1 = JSON.parse(bg(d, ["treeinfo"]).out).workingTree;
  if (!t1) {
    bad(`[${label}] 树哈希是 null —— 证据锚会是空的,fsTree 门禁永远点不亮`);
    continue;
  }
  ok(`[${label}] 树哈希算得出来(${t1.slice(0, 8)})`);

  // 写一个节点 -> .bg/ 变了 -> 树哈希**不该**跟着漂
  bg(d, ["declare", "--id", "n", "--expect", "x", "--fs-contains", "x.py:v2"]);
  const t2 = JSON.parse(bg(d, ["treeinfo"]).out).workingTree;
  if (t1 === t2) {
    ok(`[${label}] .bg/ 的改动没有污染树哈希(被观测对象里不含观测者自己)`);
  } else {
    bad(`[${label}] 树哈希随 .bg/ 漂了 —— 门禁永远不可能通过`);
  }

  // 而且这个哈希必须真的**能当门禁用**:世界等于它 -> 过
  write(d, "x.py", "v2\n");
  const want = JSON.parse(bg(d, ["treeinfo"]).out).workingTree;
  write(d, "x.py", "v1\n");
  bg(d, ["declare", "--id", "t", "--expect", "世界等于预计", "--fs-tree", want]);
  write(d, "x.py", "v2\n");
  if (bg(d, ["assert", "t"]).code === 0) {
    ok(`[${label}] fsTree 门禁能真的用(世界等于预计 -> 过)`);
  } else {
    bad(`[${label}] fsTree 门禁用不了`);
  }
}

// ================================================================ 验收 12
head("验收 12:渲染不能说假话 —— 「通过过」必须查第一盏灯(BUG-2)");

{
  const d = newRepo();
  write(d, "x.py", "v1\n");
  sh("git add -A && git -c user.email=a@b -c user.name=a commit -q -m base", d);
  bg(d, ["init"]);
  // 一个**从没验收过**、而且现在也不过 的节点
  bg(d, ["declare", "--id", "n", "--expect", "x", "--fs-contains", "x.py:NEVER"]);
  const v = bg(d, ["view"]);
  const row = v.out.split("\n").find((l) => l.includes("n ")) ?? v.out.split("\n")[0];

  if (!/通过过,但现在坏了/.test(v.out)) {
    ok("从没通过过的节点**没有**被说成「通过过,但现在坏了」");
  } else {
    bad(`渲染在断言一个不成立的历史事实: ${row.trim()}`);
  }
  if (/没通过过,现在也不过/.test(v.out)) {
    ok("说的是实话:「没通过过,现在也不过」");
  } else {
    bad(`措辞没对上实际状态: ${row.trim()}`);
  }

  // 反面:真的通过过、然后坏了 -> 那句话必须出现
  const d2 = newRepo();
  write(d2, "x.py", "v1\n");
  sh("git add -A && git -c user.email=a@b -c user.name=a commit -q -m base", d2);
  bg(d2, ["init"]);
  bg(d2, ["declare", "--id", "n", "--expect", "x", "--fs-contains", "x.py:v2"]);
  write(d2, "x.py", "v2\n");
  bg(d2, ["accept", "n"]);
  write(d2, "x.py", "v1\n");
  if (/通过过,但现在坏了/.test(bg(d2, ["view"]).out)) {
    ok("真的通过过又坏了 -> 仍然正确报出「通过过,但现在坏了」");
  } else {
    bad("真回归反而没报出来(修过头了)");
  }
}

// ================================================================ 验收 13
head("验收 13:可写边界真的执行(BUG-3)");

{
  const d = newRepo();
  write(d, "src/a.py", "v1\n");
  write(d, "x.py", "v1\n");
  sh("git add -A && git -c user.email=a@b -c user.name=a commit -q -m base", d);
  bg(d, ["init"]);
  bg(d, ["declare", "--id", "n", "--expect", "只改 src", "--allow", "src/**",
    "--fs-contains", "src/a.py:v2"]);

  // 世界改对了 —— 但**同时**动了边界外的东西
  write(d, "src/a.py", "v2\n");
  write(d, "outside.txt", "tampered\n");
  const r = bg(d, ["assert", "n"]);
  if (r.code !== 0 && /越界/.test(r.out) && /outside\.txt/.test(r.out)) {
    ok("边界外的改动被拦下(可写边界不再是描述)");
    say(r.out.split("\n").find((l) => /越界/.test(l))?.trim() ?? "");
  } else {
    bad(`越界没被拦: ${r.out.trim().slice(0, 140)}`);
  }

  // 声明了边界的节点 -> 边界内改动应当过
  const d2 = newRepo();
  write(d2, "src/a.py", "v1\n");
  sh("git add -A && git -c user.email=a@b -c user.name=a commit -q -m base", d2);
  bg(d2, ["init"]);
  bg(d2, ["declare", "--id", "n2", "--expect", "只改 src", "--allow", "src/**",
    "--fs-contains", "src/a.py:v2"]);
  write(d2, "src/a.py", "v2\n");
  if (bg(d2, ["assert", "n2"]).code === 0) {
    ok("边界内改动 -> 过(不误伤)");
  } else {
    bad("边界内改动被误判越界");
  }
}

// ================================================================ 验收 14
head("验收 14:放弃一个从未通过过的计划(BUG-7)");

{
  const d = newRepo();
  write(d, "x.py", "v1\n");
  sh("git add -A && git -c user.email=a@b -c user.name=a commit -q -m base", d);
  bg(d, ["init"]);
  // 「想做一个可视化」—— 后来决定不做了
  bg(d, ["declare", "--id", "viz", "--expect", "做个可视化", "--fs-contains", "x.py:VIZ"]);

  const before = bg(d, ["view"]);
  if (/viz/.test(before.out)) ok("放弃前:节点在图里");
  else bad("节点没进图");

  const r = bg(d, ["drop", "viz", "--reason", "决定不做了,先做别的"]);
  if (r.code === 0) ok("drop 成功(这是原来缺失的原语)");
  else bad(`drop 失败: ${r.out.trim().slice(0, 120)}`);

  const after = bg(d, ["view"]);
  if (!/^ *viz/m.test(after.out)) {
    ok("放弃后:节点从树里移出(图不再假装『还在做这件事』)");
  } else {
    bad(`放弃后节点还在树里: ${after.out.split("\n").find((l) => l.includes("viz"))}`);
  }
  if (/已放弃/.test(after.out)) {
    ok("但它**没有凭空消失** —— 心跳里报出「已放弃」");
  } else {
    bad("放弃的节点凭空消失了(那也是一种『静默』)");
  }

  const led = readFileSync(join(d, ".bg", "ledger.jsonl"), "utf8");
  if (/"type":"drop"/.test(led) && /"type":"node"/.test(led)) {
    ok("账本里留着:声明过 + 后来放弃了(历史不改写)");
  } else {
    bad("放弃没有留痕");
  }

  // 通过过的节点不能直接 drop —— 那会把一段真实的验收历史抹出图外
  const d2 = newRepo();
  write(d2, "x.py", "v1\n");
  sh("git add -A && git -c user.email=a@b -c user.name=a commit -q -m base", d2);
  bg(d2, ["init"]);
  bg(d2, ["declare", "--id", "done", "--expect", "x", "--fs-contains", "x.py:v2"]);
  write(d2, "x.py", "v2\n");
  bg(d2, ["accept", "done"]);
  const r2 = bg(d2, ["drop", "done"]);
  if (r2.code !== 0 && /retract/.test(r2.out)) {
    ok("通过过的节点不能直接 drop(要先 retract —— 历史不为方便让步)");
  } else {
    bad("通过过的节点被直接 drop 了");
  }
}

// ================================================================ 验收 15
head("验收 15:图是【每个项目一份】的 —— 指错目录不能安静地开一个新图");

// 图存在 `<项目>/.bg/`,而插件默认拿会话 cwd 当项目。
// 于是"指错目录"是个很现实的失误,而它原来的表现是:
//
//     declare -> ok:true,安静地在错的地方建了一个 .bg/,而且没有基线
//     直到事后某一步才冒出一句"(说明) 没有基线"
//
// 这正是最不能忍的那类失败。所以 declare 现在**必须先有基线**。
{
  const d = newRepo();
  write(d, "x.py", "v1\n");
  sh("git add -A && git -c user.email=a@b -c user.name=a commit -q -m base", d);

  // 没 init 就声明
  const r = bg(d, ["declare", "--id", "n", "--expect", "x", "--allow", "x.py",
    "--fs-contains", "x.py:v2"]);
  if (r.code !== 0 && /没有基线|baseline/.test(r.out)) {
    ok("没取基线就声明 -> 被拦下");
  } else {
    bad(`没基线竟然声明成功了: ${r.out.trim().slice(0, 120)}`);
  }
  if (!existsSync(join(d, ".bg"))) {
    ok("而且**没有偷偷建 .bg/** —— 没有在错的地方新开一个空图");
  } else {
    bad("悄悄建了 .bg/ —— 这正是那个静默失败");
  }

  // 取基线之后就正常
  bg(d, ["init"]);
  if (bg(d, ["declare", "--id", "n", "--expect", "x", "--allow", "x.py",
    "--fs-contains", "x.py:v2"]).code === 0) {
    ok("取了基线之后声明正常");
  } else {
    bad("取了基线还是声明不了");
  }

  // 反面:同一个仓库,用**错的** project 去读 -> 应该老实说"图是空的",
  // 而不是把另一个项目的图拿过来。
  const other = newRepo();
  write(other, "y.py", "v1\n");
  sh("git add -A && git -c user.email=a@b -c user.name=a commit -q -m base", other);
  const v = bg(other, ["view"]);
  if (/图是空的/.test(v.out) && !/n /.test(v.out)) {
    ok("另一个项目看到的确实是它自己的空图(图不串项目)");
  } else {
    bad(`图串项目了: ${v.out.split("\n")[0]}`);
  }
}

// ================================================================ 验收 16
head("验收 16:changed(增量谓词) —— 「改动了」和「没改」要分得开");

// 缺这个谓词的时候,"改了 A" 只能用 `contains(A, 新内容)` 间接表达 ——
// 而那证明的是"有这串字",不是"动过"。两种失败都实测过:
//   改法不同 -> 误报失败;   内容被毁 -> 漏过。
{
  const d = newRepo();
  write(d, "A", "old\nkeep1\nkeep2\n");
  write(d, "C", "c-content\n");
  sh("git add -A && git -c user.email=a@b -c user.name=a commit -q -m base", d);
  bg(d, ["init"]);

  // 「改了A / 生成了B / 删除了C」—— 三个谓词各管一件,每个都带方向
  const dec = bg(d, ["declare", "--id", "n", "--expect", "改A 生成B 删C",
    "--allow", "A", "--allow", "B", "--allow", "C",
    "--fs-changed", "A", "--fs-exists", "B", "--fs-absent", "C"]);
  if (dec.code === 0) ok("changed 进了契约(而且没被当成白给的门禁)");
  else bad(`声明失败: ${dec.out.trim().slice(0, 120)}`);

  // 做对:A 的内容改成**什么都行** —— changed 不要求内容
  write(d, "A", "COMPLETELY-DIFFERENT\n");
  write(d, "B", "b\n");
  sh("rm C", d);
  if (bg(d, ["assert", "n"]).code === 0) {
    ok("三件都做了 -> 过(changed 不要求内容是什么)");
  } else {
    bad("做对了却没过");
  }

  // **没改** -> 必须抓住。这一条同时守着 fileAt 的 trim bug:
  // 如果读基线内容时把结尾换行 trim 掉,"还原成基线"会被误判成"有变"。
  write(d, "A", "old\nkeep1\nkeep2\n");
  const r = bg(d, ["assert", "n"]);
  if (r.code !== 0 && /一模一样/.test(r.out)) {
    ok("A 还原成基线内容 -> 报「和基线一模一样」(没被 trim 掉结尾换行骗过)");
  } else {
    bad(`没改却被算成改过: ${r.out.trim().slice(0, 140)}`);
  }

  // 误用:changed 一个**新建**的文件 -> 要指出该用 fsExists
  bg(d, ["declare", "--id", "m1", "--expect", "x", "--fs-changed", "B"]);
  const r1 = bg(d, ["assert", "m1"]);
  if (r1.code !== 0 && /创建/.test(r1.out) && /fsExists/.test(r1.out)) {
    ok("对新建的文件用 changed -> 报「那是创建」并指向 fsExists(方向不能丢)");
  } else {
    bad(`创建/改 没分清: ${r1.out.trim().slice(0, 140)}`);
  }

  // 误用:changed 一个**被删**的文件 -> 要指出该用 fsAbsent
  bg(d, ["declare", "--id", "m2", "--expect", "x", "--fs-changed", "C"]);
  const r2 = bg(d, ["assert", "m2"]);
  if (r2.code !== 0 && /删除/.test(r2.out) && /fsAbsent/.test(r2.out)) {
    ok("对被删的文件用 changed -> 报「那是删除」并指向 fsAbsent");
  } else {
    bad(`删除/改 没分清: ${r2.out.trim().slice(0, 140)}`);
  }

  // **它的弱点,明写成验收**:changed 是相对判据,
  // "把 A 清空"也算"改过" —— 所以它不能单独用。
  const d2 = newRepo();
  write(d2, "A", "important\nlots\nof\ncontent\n");
  sh("git add -A && git -c user.email=a@b -c user.name=a commit -q -m base", d2);
  bg(d2, ["init"]);
  bg(d2, ["declare", "--id", "c", "--expect", "x", "--fs-changed", "A"]);
  write(d2, "A", "");
  if (bg(d2, ["assert", "c"]).code === 0) {
    ok("(已知弱点)把文件清空也算「改过」—— 相对判据允许任何改变,不能单独用");
  } else {
    bad("清空竟然没过?那语义和文档不符");
  }
}

// ================================================================ 收尾

for (const d of tmpdirs) rmSync(d, { recursive: true, force: true });

console.log(`\n\x1b[1m结果\x1b[0m\n  通过 ${PASS} / 失败 ${FAIL}`);
process.exit(FAIL === 0 ? 0 : 1);
