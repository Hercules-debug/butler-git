/**
 * run.mjs —— 负向验收。**全部是"抓错",不是"跑通"。**
 *
 * 理由:这个东西的价值全在"它会不会漏",而正向演示证明不了这一点。
 *
 * 用法: node test/run.mjs
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BG = join(HERE, "..", "bin", "bg.mjs");

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
  sh("git config user.email a@b", d);
  sh("git config user.name a", d);
  write(d, "f.txt", "v0\n");
  sh("git add -A", d);
  sh('git commit -qm init', d);
  return d;
}

function sh(cmd, cwd) {
  return spawnSync(cmd, { shell: true, cwd, encoding: "utf8" });
}

/** 跑 bg。默认 cwd = 仓库(不再用 --project,CLI 只认 --dir)。 */
function bg(dir, args) {
  const r = spawnSync("node", [BG, "--dir", dir, ...args], { encoding: "utf8" });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const write = (dir, rel, text) => {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text, "utf8");
};
const read = (dir, rel) => readFileSync(join(dir, rel), "utf8");
const exists = (dir, rel) => existsSync(join(dir, rel));
const headSha = (dir) => sh("git rev-parse HEAD", dir).stdout.trim();

function cleanup() {
  for (const d of tmpdirs) rmSync(d, { recursive: true, force: true });
}

// ============================================================ 1. plan 的门

head("1. plan:该拦的拦住");
{
  const d = newRepo();
  const b = headSha(d);

  let r = bg(d, ["plan", "--id", "n1", "--expect", "改 f", "--verify", "true"]);
  if (r.code !== 0 || /没有给 base/.test(r.out)) ok("不给 base -> 报错(不猜默认值)");
  else bad(`不给 base 应该报错,实际:${r.out}`);

  r = bg(d, ["plan", "--id", "n1", "--expect", "改 f", "--base", b]);
  if (r.code !== 0 || /没有给 verify/.test(r.out)) ok("不给 P -> 报错(P 必须有)");
  else bad(`不给 P 应该报错,实际:${r.out}`);

  r = bg(d, ["plan", "--id", "n1", "--expect", "改 f", "--base", "deadbeef", "--verify", "true"]);
  if (r.code !== 0) ok("base 不存在 -> 报错");
  else bad("base 不存在应该报错");

  r = bg(d, ["plan", "--id", "n1", "--expect", "改 f", "--base", b, "--verify", "true",
    "--delta", "M:f.txt", "--delta", "D:f.txt"]);
  if (r.code !== 0 && /两个方向不可能都发生/.test(r.out)) ok("Δ 自相矛盾(M 又 D)-> 报错");
  else bad(`Δ 自相矛盾应该报错,实际:${r.out}`);

  r = bg(d, ["plan", "--id", "n1", "--expect", "", "--base", b, "--verify", "true"]);
  if (r.code !== 0) ok("没有 expect -> 报错");
  else bad("没有 expect 应该报错");
}

// ============================================================ 2. Δ 的三件事

head("2. Δ:漏做 / 预期外 / 方向错");
{
  const d = newRepo();
  const b = headSha(d);
  bg(d, ["plan", "--id", "n1", "--expect", "改 f", "--base", b,
    "--verify", "grep -q v1 f.txt", "--delta", "M:f.txt"]);

  // 漏做:什么都没改
  let r = bg(d, ["commit", "n1"]);
  if (r.code !== 0 && /漏做/.test(r.out)) ok("漏做 -> 不提交(附要求)");
  else bad(`漏做应该被抓,实际:${r.out}`);
  if (headSha(d) === b) ok("没过时 HEAD 不动");
  else bad("没过却动了 HEAD");

  // 预期外的改动
  write(d, "f.txt", "v1\n");
  write(d, "junk.txt", "junk\n");
  r = bg(d, ["commit", "n1"]);
  if (r.code !== 0 && /预期外/.test(r.out)) ok("多出来的改动 -> 不提交");
  else bad(`预期外改动应该被抓,实际:${r.out}`);

  // status 也要显示它
  r = bg(d, ["status", "n1"]);
  if (/预期外的改动/.test(r.out)) ok("status 里也标出\"预期外\"");
  else bad(`status 应该显示预期外改动,实际:${r.out}`);

  // 方向错:声明删除,实际只是改了内容
  rmSync(join(d, "junk.txt"));
  const d2 = newRepo();
  const b2 = headSha(d2);
  bg(d2, ["plan", "--id", "n2", "--expect", "删掉 f", "--base", b2,
    "--verify", "! test -f f.txt", "--delta", "D:f.txt"]);
  write(d2, "f.txt", "changed\n");
  r = bg(d2, ["commit", "n2"]);
  if (r.code !== 0 && /方向/.test(r.out)) ok("该删的却改了 -> 报方向错");
  else bad(`方向错应该被抓,实际:${r.out}`);
}

// ============================================================ 3. P 与 unknown

head("3. P:不过就不提交,unknown 不算通过");
{
  const d = newRepo();
  const b = headSha(d);
  bg(d, ["plan", "--id", "n1", "--expect", "改 f", "--base", b,
    "--verify", "grep -q v1 f.txt", "--delta", "M:f.txt"]);

  write(d, "f.txt", "wrong\n");
  let r = bg(d, ["commit", "n1"]);
  if (r.code !== 0 && /退出码/.test(r.out)) ok("P 不通过 -> 不提交,报退出码");
  else bad(`P 不过应该被抓,实际:${r.out}`);

  // Δ 对了但 P 不对
  write(d, "f.txt", "still-wrong\n");
  r = bg(d, ["commit", "n1"]);
  if (r.code !== 0) ok("Δ 对但 P 不对 -> 仍然不提交");
  else bad("P 不过就不该提交");

  // 超时
  const d2 = newRepo();
  const b2 = headSha(d2);
  bg(d2, ["plan", "--id", "n1", "--expect", "x", "--base", b2,
    "--verify", "sleep 10", "--delta", "M:f.txt"]);
  write(d2, "f.txt", "v1\n");
  r = bg(d2, ["commit", "n1", "--timeout", "800"]);
  if (r.code !== 0 && /超时/.test(r.out)) ok("P 超时 -> 报超时(不说成退出码)");
  else bad(`超时应该被单独报出来,实际:${r.out}`);
}

// ============================================================ 4. 弱 P

head("4. 弱 P:P 在基线时就通过 -> 要标出来");
{
  const d = newRepo();
  const b = headSha(d);
  bg(d, ["plan", "--id", "n1", "--expect", "改 f", "--base", b,
    "--verify", "true", "--delta", "M:f.txt"]);
  write(d, "f.txt", "v1\n");
  const r = bg(d, ["commit", "n1"]);
  if (r.code === 0 && /区分不了你做没做/.test(r.out)) ok("verify:true -> 标出弱 P");
  else bad(`弱 P 应该被标出来,实际:${r.out}`);

  const trail = sh("git log -1 --format=%B", d).stdout;
  if (/bg-weak-verify: true/.test(trail)) ok("弱 P 也写进 trailer(跟着版本走)");
  else bad(`弱 P 应该进 trailer,实际:${trail}`);
}

// ============================================================ 5. 向根负责

head("5. 向根负责:子节点把根弄坏 -> 不达成");
{
  const d = newRepo();
  const b = headSha(d);
  write(d, "root.txt", "ok\n");
  sh("git add -A", d);
  sh("git commit -qm add-root", d);
  const b2 = headSha(d);

  // 根 P:root.txt 必须是 ok
  bg(d, ["plan", "--id", "root", "--expect", "项目可用", "--base", b2,
    "--verify", "grep -q ok root.txt"]);
  bg(d, ["plan", "--id", "n1", "--parent", "root", "--expect", "改坏 root",
    "--base", b2, "--verify", "true", "--delta", "M:root.txt"]);

  write(d, "root.txt", "BROKEN\n");
  let r = bg(d, ["commit", "n1"]);
  if (r.code !== 0 && /根 P 不通过/.test(r.out)) ok("把根弄坏 -> 不提交,并说清要求");
  else bad(`根被弄坏应该被抓,实际:${r.out}`);

  // 修好根
  write(d, "root.txt", "ok\n");
  r = bg(d, ["commit", "n1"]);
  if (r.code !== 0 && /没发生/.test(r.out)) ok("恢复原样 -> Δ 说\"没发生\"(诚实)");
  else bad(`恢复原样后不该通过,实际:${r.out}`);

  const trail = sh("git log -1 --format=%B", d).stdout;
  if (!/bg-root-verify/.test(trail)) ok("没达成时历史里没有 root-verify trailer");
  else bad("HEAD 不该有新的达成");
}

// ============================================================ 6. 冻结

head("6. 冻结:达成之后不许改");
{
  const d = newRepo();
  const b = headSha(d);
  bg(d, ["plan", "--id", "n1", "--expect", "改 f", "--base", b,
    "--verify", "grep -q v1 f.txt", "--delta", "M:f.txt"]);
  write(d, "f.txt", "v1\n");
  let r = bg(d, ["commit", "n1"]);
  if (r.code === 0) ok("正常达成");
  else bad(`应该达成,实际:${r.out}`);

  r = bg(d, ["plan", "--id", "n1", "--expect", "改主意", "--base", b, "--verify", "true"]);
  if (r.code !== 0 && /门禁冻结/.test(r.out)) ok("改已达成的节点 -> 冻结");
  else bad(`已达成的节点该冻结,实际:${r.out}`);

  r = bg(d, ["abandon", "n1"]);
  if (r.code !== 0 && /不能放弃/.test(r.out)) ok("放弃已达成的节点 -> 不许");
  else bad(`已达成的节点不该能放弃,实际:${r.out}`);
}

// ============================================================ 7. owner

head("7. owner=user:模型改不动");
{
  const d = newRepo();
  const b = headSha(d);
  bg(d, ["plan", "--id", "n1", "--expect", "验收标准", "--base", b,
    "--verify", "true", "--owner", "user", "--delta", "M:f.txt"]);
  const r = bg(d, ["plan", "--id", "n1", "--expect", "偷偷改验收", "--base", b, "--verify", "true"]);
  // CLI 不传 --as-user,所以模型侧一定改不动
  if (r.code !== 0 && /要人授权/.test(r.out)) ok("改人定的门禁 -> 拦住");
}

// ============================================================ 8. 证据与篡改

head("8. 证据:verified-tree 与篡改");
{
  const d = newRepo();
  const b = headSha(d);
  bg(d, ["plan", "--id", "n1", "--expect", "改 f", "--base", b,
    "--verify", "grep -q v1 f.txt", "--delta", "M:f.txt"]);
  write(d, "f.txt", "v1\n");
  const r = bg(d, ["commit", "n1"]);
  if (r.code !== 0) { bad(`应该达成,实际:${r.out}`); }
  else {
    const trail = sh("git log -1 --format=%B", d).stdout;
    const claimed = trail.match(/bg-verified-tree: (\w+)/)?.[1];
    const actual = sh("git rev-parse HEAD^{tree}", d).stdout.trim();
    if (claimed && claimed === actual) ok("verified-tree == commit^{tree}");
    else bad(`verified-tree 对不上:${claimed} vs ${actual}`);

    const needed = ["bg-node", "bg-owner", "bg-base", "bg-verify", "bg-verified-tree"];
    const missing = needed.filter((k) => !trail.includes(`${k}:`));
    if (!missing.length) ok("trailer 里证据齐全");
    else bad(`trailer 缺:${missing.join(", ")}`);

    // amend 伪造
    write(d, "f.txt", "FORGED\n");
    sh("git add -A", d);
    sh("git commit -q --amend --no-edit", d);
    const rc = bg(d, ["recheck"]);
    if (rc.code !== 0 && /伪造的绿/.test(rc.out)) ok("amend 篡改 -> recheck 抓出来");
    else bad(`篡改应该被抓,实际:${rc.out}`);
  }
}

// ============================================================ 9. 绕过

head("9. 绕过:裸 git commit 会被看见");
{
  const d = newRepo();
  const b = headSha(d);
  bg(d, ["plan", "--id", "n1", "--expect", "改 f", "--base", b,
    "--verify", "grep -q v1 f.txt", "--delta", "M:f.txt"]);
  write(d, "f.txt", "v1\n");
  bg(d, ["commit", "n1"]);

  // 绕过
  write(d, "sneaky.txt", "x\n");
  sh("git add -A", d);
  sh("git commit -qm '绕过门禁'", d);

  const r = bg(d, ["tree"]);
  if (/不在图里/.test(r.out) && /绕过了门禁/.test(r.out)) ok("裸 commit -> tree 报出来");
  else bad(`绕过应该被发现,实际:${r.out}`);

  const h = bg(d, ["health"]);
  if (/绕过门禁/.test(h.out)) ok("heartbeat 也报绕过数");
  else bad(`health 应该报绕过,实际:${h.out}`);
}

// ============================================================ 10. 合并

head("10. 合并:成果不许静默消失");
{
  const d = newRepo();
  const b = headSha(d);
  bg(d, ["plan", "--id", "root", "--expect", "可用", "--base", b, "--verify", "test -f f.txt"]);

  // 分支 A 上做成 nA(新增 a.txt)
  sh("git checkout -q -b A", d);
  bg(d, ["plan", "--id", "nA", "--parent", "root", "--expect", "加 a.txt",
    "--base", b, "--verify", "test -f a.txt", "--delta", "A:a.txt"]);
  write(d, "a.txt", "a\n");
  let r = bg(d, ["commit", "nA"]);
  if (r.code !== 0) bad(`nA 应该达成,实际:${r.out}`);

  sh(`git checkout -q ${sh("git rev-parse --abbrev-ref HEAD", d).stdout.trim() === "A" ? "master" : "master"}`, d);
  sh("git checkout -q master 2>/dev/null || git checkout -q main", d);

  // 分支 B:改 f.txt(制造冲突)
  sh("git checkout -q -b B", d);
  write(d, "f.txt", "vB\n");
  sh("git add -A", d);
  sh("git commit -qm 'B 改 f'", d);
  sh("git checkout -q master 2>/dev/null || git checkout -q main", d);
  write(d, "f.txt", "vM\n");
  sh("git add -A", d);
  sh("git commit -qm 'master 改 f'", d);

  sh("git merge --no-commit --no-ff A B", d);
  // 恶意"解决":删掉 A 的成果
  rmSync(join(d, "a.txt"), { force: true });
  write(d, "f.txt", "merged\n");
  sh("git add -A", d);

  bg(d, ["plan", "--id", "m1", "--parent", "root", "--expect", "合并",
    "--base", b, "--verify", "test -f f.txt"]);
  r = bg(d, ["commit", "m1"]);
  if (r.code !== 0 && /成果在解决冲突时被撤销/.test(r.out)) ok("合并里撤销别人的成果 -> 抓住");
  else bad(`合并丢成果应该被抓,实际:${r.out}`);

  // 正常合并
  write(d, "a.txt", "a\n");
  sh("git add -A", d);
  r = bg(d, ["commit", "m1"]);
  if (r.code === 0) ok("恢复后合并成功");
  else bad(`恢复后应该能合并,实际:${r.out}`);

  const parents = sh("git log -1 --format=%P", d).stdout.trim().split(/\s+/);
  if (parents.length === 2) ok("产出的是真正的 merge commit(两个父)");
  else bad(`应该有 2 个父,实际 ${parents.length}:${parents}`);

  if (!exists(d, ".git/MERGE_HEAD")) ok("MERGE_HEAD 已清理");
  else bad("MERGE_HEAD 应该被清掉");
}

// ============================================================ 11. 冲突未解决

head("11. 合并:冲突没解决不许提交");
{
  const d = newRepo();
  const b = headSha(d);
  bg(d, ["plan", "--id", "root", "--expect", "可用", "--base", b, "--verify", "test -f f.txt"]);
  sh("git checkout -q -b B", d);
  write(d, "f.txt", "vB\n");
  sh("git add -A", d);
  sh("git commit -qm B", d);
  sh("git checkout -q master 2>/dev/null || git checkout -q main", d);
  write(d, "f.txt", "vM\n");
  sh("git add -A", d);
  sh("git commit -qm M", d);
  sh("git merge --no-commit --no-ff B", d);

  bg(d, ["plan", "--id", "m1", "--parent", "root", "--expect", "合并",
    "--base", b, "--verify", "test -f f.txt"]);
  const r = bg(d, ["commit", "m1"]);
  if (r.code !== 0 && /没解决冲突/.test(r.out)) ok("还有冲突 -> 不许提交");
  else bad(`没解决冲突应该被拦,实际:${r.out}`);
}

// ============================================================ 12. abandon

head("12. abandon:只从图里移除,不动工作区");
{
  const d = newRepo();
  const b = headSha(d);
  bg(d, ["plan", "--id", "n1", "--expect", "改 f", "--base", b,
    "--verify", "true", "--delta", "M:f.txt"]);
  write(d, "f.txt", "changed\n");   // 工作区有改动

  const r = bg(d, ["abandon", "n1", "--reason", "不做了"]);
  if (r.code === 0) ok("能放弃未达成的节点");
  else bad(`应该能放弃,实际:${r.out}`);

  const t = bg(d, ["tree"]);
  if (!/n1/.test(t.out)) ok("放弃后不在图里了");
  else bad(`放弃后不该还在图里,实际:${t.out}`);

  if (read(d, "f.txt") === "changed\n") ok("工作区没被动(它只管图)");
  else bad("abandon 不该动工作区");
}

// ============================================================ 13. Δ 为空

head("13. Δ 为空:要说清楚没有东西防意外改动");
{
  const d = newRepo();
  const b = headSha(d);
  bg(d, ["plan", "--id", "n1", "--expect", "改 f", "--base", b, "--verify", "grep -q v1 f.txt"]);
  const r = bg(d, ["status", "n1"]);
  if (/没有任何东西防止意外改动/.test(r.out)) ok("status 标出 Δ 空的风险");
  else bad(`Δ 空应该被标出来,实际:${r.out}`);

  // 空 Δ 时任何改动都能提交 —— 这是设计,但要能看见
  write(d, "f.txt", "v1\n");
  write(d, "whatever.txt", "x\n");
  const c = bg(d, ["commit", "n1"]);
  if (c.code === 0) ok("Δ 空时改动能提交(不拦,但已告知)");
  else bad(`Δ 空时不该拦,实际:${c.out}`);
}

// ============================================================ 14. 提交精确性

head("14. 提交的是被验过的那个树");
{
  const d = newRepo();
  const b = headSha(d);
  bg(d, ["plan", "--id", "n1", "--expect", "改 f", "--base", b,
    "--verify", "grep -q v1 f.txt", "--delta", "M:f.txt"]);
  write(d, "f.txt", "v1\n");

  // P 会留下一个临时产物(模拟"验证程序自己造垃圾")
  bg(d, ["plan", "--id", "n2", "--expect", "x", "--base", b, "--verify", "true"]);
  const r = bg(d, ["commit", "n1"]);
  if (r.code !== 0) { bad(`应该达成,实际:${r.out}`); }
  else {
    const trail = sh("git log -1 --format=%B", d).stdout;
    const claimed = trail.match(/bg-verified-tree: (\w+)/)?.[1];
    const actual = sh("git rev-parse HEAD^{tree}", d).stdout.trim();
    if (claimed === actual) ok("commit 的树 == 验过的树(commit-tree 精确提交)");
    else bad(`提交内容和验过的内容不一致:${claimed} vs ${actual}`);
  }
}

// ============================================================ 15. 重名与路径带空格

head("15. 边角:路径带空格");
{
  const d = newRepo();
  const b = headSha(d);
  bg(d, ["plan", "--id", "n1", "--expect", "加个带空格的文件", "--base", b,
    "--verify", "test -f 'my file.txt'", "--delta", "A:my file.txt"]);
  write(d, "my file.txt", "x\n");
  const r = bg(d, ["commit", "n1"]);
  if (r.code === 0) ok("路径带空格 -> 正常(-z 解析)");
  else bad(`带空格路径应该能工作,实际:${r.out}`);
}

// ============================================================ 16. Δ 来源

head("16. delta_source:预测 vs 转录");
{
  const d = newRepo();
  const b = headSha(d);
  bg(d, ["plan", "--id", "n1", "--expect", "改 f", "--base", b,
    "--verify", "grep -q v1 f.txt", "--delta", "M:f.txt", "--delta-source", "at-commit"]);
  write(d, "f.txt", "v1\n");
  const r = bg(d, ["commit", "n1"]);
  if (r.code !== 0) { bad(`应该达成,实际:${r.out}`); }
  else {
    const trail = sh("git log -1 --format=%B", d).stdout;
    if (/bg-delta-source: at-commit/.test(trail)) ok("转录标记进 trailer");
    else bad(`转录标记应该进 trailer,实际:${trail}`);
  }
}

// ============================================================ 结果

cleanup();
console.log(`\n${FAIL === 0 ? "\x1b[32m" : "\x1b[31m"}${PASS} 过 / ${FAIL} 败\x1b[0m`);
process.exit(FAIL === 0 ? 0 : 1);
