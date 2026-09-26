/**
 * run.mjs —— 负向验收。**全部是"抓错",不是"跑通"。**
 *
 * 理由和上一个实现一样:这个东西的价值全在"它会不会漏",
 * 而正向演示证明不了这一点。
 *
 * 用法: node test/run.mjs
 */

import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
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

// ================================================================ 收尾

for (const d of tmpdirs) rmSync(d, { recursive: true, force: true });

console.log(`\n\x1b[1m结果\x1b[0m\n  通过 ${PASS} / 失败 ${FAIL}`);
process.exit(FAIL === 0 ? 0 : 1);
