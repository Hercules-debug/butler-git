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

/**
 * 建一个根并拿回它的凭证。
 *
 * 凭证是全量开的,所以**每个测试仓库都得先有这一步** ——
 * 根节点只能由人签发(--as-user),agent 从它往下拆。
 */
function seedRoot(dir, { verify = "test -f f.txt" } = {}) {
  const b = headSha(dir);
  const r = bg(dir, ["plan", "--as-user", "--id", "root", "--expect", "根",
    "--base", b, "--verify", verify]);
  return { token: r.out.match(/凭证\s+(\w+)/)?.[1] ?? null, base: b };
}

/** 建一个子节点(用父凭证)。返回它自己的凭证。 */
function mkNode(dir, { id, parent, token, base, expect = "一件事",
  verify = "true", delta = [] } = {}) {
  const args = ["plan", "--token", token, "--id", id, "--parent", parent,
    "--expect", expect, "--base", base, "--verify", verify];
  for (const dd of delta) args.push("--delta", dd);
  const r = bg(dir, args);
  return { token: r.out.match(/凭证\s+(\w+)/)?.[1] ?? null, out: r.out, code: r.code };
}


function cleanup() {
  for (const d of tmpdirs) rmSync(d, { recursive: true, force: true });
}

// ============================================================ 1. plan 的门

head("1. plan:该拦的拦住");
{
  const d = newRepo();
  const { token, base: b } = seedRoot(d);

  let r = bg(d, ["plan", "--token", token, "--id", "n1", "--parent", "root",
    "--expect", "改 f", "--verify", "true"]);
  if (r.code !== 0 && /没有给 base/.test(r.out)) ok("不给 base -> 报错(不猜默认值)");
  else bad(`不给 base 应该报错,实际:${r.out}`);

  r = bg(d, ["plan", "--token", token, "--id", "n1", "--parent", "root",
    "--expect", "改 f", "--base", b]);
  if (r.code !== 0 && /没有给 verify/.test(r.out)) ok("不给 P -> 报错(P 必须有)");
  else bad(`不给 P 应该报错,实际:${r.out}`);

  r = bg(d, ["plan", "--token", token, "--id", "n1", "--parent", "root",
    "--expect", "改 f", "--base", "deadbeef", "--verify", "true"]);
  if (r.code !== 0) ok("base 不存在 -> 报错");
  else bad("base 不存在应该报错");

  r = bg(d, ["plan", "--token", token, "--id", "n1", "--parent", "root",
    "--expect", "改 f", "--base", b, "--verify", "true",
    "--delta", "M:f.txt", "--delta", "D:f.txt"]);
  if (r.code !== 0 && /两个方向不可能都发生/.test(r.out)) ok("Δ 自相矛盾(M 又 D)-> 报错");
  else bad(`Δ 自相矛盾应该报错,实际:${r.out}`);

  r = bg(d, ["plan", "--token", token, "--id", "n1", "--parent", "root",
    "--expect", "", "--base", b, "--verify", "true"]);
  if (r.code !== 0) ok("没有 expect -> 报错");
  else bad("没有 expect 应该报错");
}

// ============================================================ 2. Δ 的三件事

head("2. Δ:漏做 / 预期外 / 方向错");
{
  const d = newRepo();
  const { token, base: b } = seedRoot(d);
  mkNode(d, { id: "n1", parent: "root", token, base: b, expect: "改 f",
    verify: "grep -q v1 f.txt", delta: ["M:f.txt"] });

  // 漏做:什么都没改
  let r = bg(d, ["commit", "n1", "--token", token]);
  if (r.code !== 0 && /漏做/.test(r.out)) ok("漏做 -> 不提交(附要求)");
  else bad(`漏做应该被抓,实际:${r.out}`);
  if (headSha(d) === b) ok("没过时 HEAD 不动");
  else bad("没过却动了 HEAD");

  // 预期外的改动
  write(d, "f.txt", "v1\n");
  write(d, "junk.txt", "junk\n");
  r = bg(d, ["commit", "n1", "--token", token]);
  if (r.code !== 0 && /预期外/.test(r.out)) ok("多出来的改动 -> 不提交");
  else bad(`预期外改动应该被抓,实际:${r.out}`);

  // status 也要显示它
  r = bg(d, ["status", "n1"]);
  if (/预期外的改动/.test(r.out)) ok("status 里也标出\"预期外\"");
  else bad(`status 应该显示预期外改动,实际:${r.out}`);

  // 方向错:声明删除,实际只是改了内容
  rmSync(join(d, "junk.txt"));
  const d2 = newRepo();
  const s2 = seedRoot(d2);
  mkNode(d2, { id: "n2", parent: "root", token: s2.token, base: s2.base,
    expect: "删掉 f", verify: "! test -f f.txt", delta: ["D:f.txt"] });
  write(d2, "f.txt", "changed\n");
  r = bg(d2, ["commit", "n2", "--token", s2.token]);
  if (r.code !== 0 && /方向/.test(r.out)) ok("该删的却改了 -> 报方向错");
  else bad(`方向错应该被抓,实际:${r.out}`);
}

// ============================================================ 3. P 与 unknown

head("3. P:不过就不提交,unknown 不算通过");
{
  const d = newRepo();
  const { token, base: b } = seedRoot(d);
  mkNode(d, { id: "n1", parent: "root", token, base: b, expect: "改 f",
    verify: "grep -q v1 f.txt", delta: ["M:f.txt"] });

  write(d, "f.txt", "wrong\n");
  let r = bg(d, ["commit", "n1", "--token", token]);
  if (r.code !== 0 && /退出码/.test(r.out)) ok("P 不通过 -> 不提交,报退出码");
  else bad(`P 不过应该被抓,实际:${r.out}`);

  // Δ 对了但 P 不对
  write(d, "f.txt", "still-wrong\n");
  r = bg(d, ["commit", "n1", "--token", token]);
  if (r.code !== 0) ok("Δ 对但 P 不对 -> 仍然不提交");
  else bad("P 不过就不该提交");

  // 超时
  const d2 = newRepo();
  const s2 = seedRoot(d2);
  mkNode(d2, { id: "n1", parent: "root", token: s2.token, base: s2.base,
    expect: "x", verify: "sleep 10", delta: ["M:f.txt"] });
  write(d2, "f.txt", "v1\n");
  r = bg(d2, ["commit", "n1", "--token", s2.token, "--timeout", "800"]);
  if (r.code !== 0 && /超时/.test(r.out)) ok("P 超时 -> 报超时(不说成退出码)");
  else bad(`超时应该被单独报出来,实际:${r.out}`);
}

// ============================================================ 4. 弱 P

head("4. 弱 P:P 在基线时就通过 -> 要标出来");
{
  const d = newRepo();
  const { token, base: b } = seedRoot(d);
  mkNode(d, { id: "n1", parent: "root", token, base: b, expect: "改 f",
    verify: "true", delta: ["M:f.txt"] });
  write(d, "f.txt", "v1\n");
  const r = bg(d, ["commit", "n1", "--token", token]);
  if (r.code === 0 && /区分不了你做没做/.test(r.out)) ok("verify:true -> 标出弱 P");
  else bad(`弱 P 应该被标出来,实际:${r.out}`);

  const trail = sh("git log -1 --format=%B", d).stdout;
  if (/bg-weak-verify: true/.test(trail)) ok("弱 P 也写进 trailer(跟着版本走)");
  else bad(`弱 P 应该进 trailer,实际:${trail}`);
}

// ============================================================ 5. 所有节点一视同仁
//
// **这一节取代了原来的「向根负责」。** 那个模型是:每个子节点达成时额外跑
// 一遍【根节点的 P】,建立在那条不变式上 ——"每一个绿的 commit 上,根门禁
// 都是通过的"。
//
// 它被删了,因为那个模型是错的:根 P 和子节点的 P 是**同一种东西**
// (都是"这件事做对了"的证明),它不该下来压每一个子任务。
//
// 所以这一节的验收**反过来**:
//   ① 子节点**不受**根 P 的牵连(根 P 坏着,子节点照样能达成)
//   ② 根节点自己**照常**受自己的 P 约束(它不特殊)
//   ③ trailer 里不再有 bg-root-verify

head("5. 所有节点一视同仁:子节点不受根 P 牵连,根自己照常受约束");
{
  const d = newRepo();
  const b = headSha(d);
  write(d, "root.txt", "ok\n");
  sh("git add -A", d);
  sh("git commit -qm add-root", d);
  const b2 = headSha(d);

  // 根 P 故意写成**恒失败** —— 用来证明它压不到子节点身上。
  // (删掉根门禁之前,这里会让 n1 永远达不成。)
  const { token } = seedRoot(d, { verify: "exit 1" });
  mkNode(d, { id: "n1", parent: "root", token, base: b2, expect: "n1 自己的活",
    verify: "true", delta: ["M:root.txt"] });

  write(d, "root.txt", "whatever\n");
  const r = bg(d, ["commit", "n1", "--token", token]);
  if (r.code === 0) ok("根 P 恒失败,子节点**照样**达成(一视同仁)");
  else bad(`子节点不该被根 P 牵连,实际:${r.out}`);

  const trail = sh("git log -1 --format=%B", d).stdout;
  if (!/bg-root-verify/.test(trail)) ok("trailer 里**没有** bg-root-verify(那个概念没了)");
  else bad(`不该再写 bg-root-verify,实际:${trail}`);

  // ② 根自己照常受自己的 P 约束 —— 它不特殊
  const rc = bg(d, ["commit", "root", "--as-user"]);
  if (rc.code !== 0 && /P 不通过/.test(rc.out)) {
    ok("根自己提交 -> 照常跑自己的 P,没过就不过(根不特殊)");
  } else {
    bad(`根该被自己的 P 拦住,实际:${rc.out}`);
  }
}

// ============================================================ 6. 冻结

head("6. 冻结:达成之后不许改");
{
  const d = newRepo();
  const { token, base: b } = seedRoot(d);
  mkNode(d, { id: "n1", parent: "root", token, base: b, expect: "改 f",
    verify: "grep -q v1 f.txt", delta: ["M:f.txt"] });
  write(d, "f.txt", "v1\n");
  let r = bg(d, ["commit", "n1", "--token", token]);
  if (r.code === 0) ok("正常达成");
  else bad(`应该达成,实际:${r.out}`);

  r = bg(d, ["plan", "--token", token, "--id", "n1", "--parent", "root",
    "--expect", "改主意", "--base", b, "--verify", "true"]);
  if (r.code !== 0 && /冻结/.test(r.out)) ok("改已达成的节点 -> 冻结");
  else bad(`已达成的节点该冻结,实际:${r.out}`);

  r = bg(d, ["abandon", "n1", "--token", token]);
  if (r.code !== 0 && /不能放弃|任何凭证都改不动/.test(r.out)) ok("放弃已达成的节点 -> 不许");
  else bad(`已达成的节点不该能放弃,实际:${r.out}`);
}

// ============================================================ 7. owner

head("7. owner=user:模型改不动");
{
  const d = newRepo();
  const { token, base: b } = seedRoot(d);
  mkNode(d, { id: "n1", parent: "root", token, base: b, expect: "验收标准",
    verify: "true", delta: ["M:f.txt"] });
  // owner=user:改它需要**人**的凭证,agent 拿不到
  bg(d, ["plan", "--as-user", "--token", token, "--id", "n1", "--parent", "root",
    "--expect", "验收标准", "--base", b, "--verify", "true", "--owner", "user"]);
  const r = bg(d, ["plan", "--token", token, "--id", "n1", "--parent", "root",
    "--expect", "偷偷改验收", "--base", b, "--verify", "true"]);
  if (r.code !== 0 && /人\*\*的凭证/.test(r.out)) ok("改 owner=user 的节点 -> 要人的凭证");
}

// ============================================================ 8. 证据与篡改

head("8. 证据:verified-tree 与篡改");
{
  const d = newRepo();
  const { token, base: b } = seedRoot(d);
  mkNode(d, { id: "n1", parent: "root", token, base: b, expect: "改 f",
    verify: "grep -q v1 f.txt", delta: ["M:f.txt"] });
  write(d, "f.txt", "v1\n");
  const r = bg(d, ["commit", "n1", "--token", token]);
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

// ============================================================ 9. 没有"绕过"这回事
//
// **这一节取代了原来的「绕过:裸 git commit 会被看见」。**
//
// 那套把"没走节点的提交"标成「⚠ 绕过了门禁」,是错的:
//
//     节点(node) = 一种**记录**
//     git commit = 一个**工具**
//
// 模型用 git commit 是正常干活,不是绕过谁。"⚠ 绕过了门禁"在暗示
// 存在一条没被遵守的规矩 —— 那是在编造规则,会让人以为出了问题。
//
// 所以现在的立场是:**图只显示有记录的节点,别的不管。**
// 这一节锁的就是这个 —— 有人把"不报"当成"忘了报"的话,这里会说话。

head("9. 没有\"绕过\"这回事:git 那边发生什么,图不管");
{
  const d = newRepo();
  const { token, base: b } = seedRoot(d);
  mkNode(d, { id: "n1", parent: "root", token, base: b, expect: "改 f",
    verify: "grep -q v1 f.txt", delta: ["M:f.txt"] });
  write(d, "f.txt", "v1\n");
  bg(d, ["commit", "n1", "--token", token]);

  // 一次**普通的** git 提交 —— 没走节点,但那不是违规
  write(d, "plain.txt", "x\n");
  sh("git add -A", d);
  sh("git commit -qm '一次普通的提交'", d);

  const r = bg(d, ["tree"]);
  if (!/绕过|不在图里/.test(r.out)) ok("普通 git commit -> tree **不**说它绕过(那不是违规)");
  else bad(`不该报绕过,实际:${r.out}`);

  // 它仍然该**算进历史** —— 图不该因此错乱
  if (/n1/.test(r.out) && /root/.test(r.out)) ok("图本身照常(有记录的节点还在)");
  else bad(`图不该受影响,实际:${r.out}`);

  const h = bg(d, ["health"]);
  if (!/绕过/.test(h.out)) ok("health 也不报绕过数");
  else bad(`health 不该报绕过,实际:${h.out}`);

  // 但 walk 到 git 层面,那个提交**确实在** —— 我们没假装它不存在
  const log = sh("git log --oneline", d).stdout;
  if (/一次普通的提交/.test(log)) ok("它当然还在 git 历史里(我们没假装它不存在)");
  else bad(`git 历史该有它,实际:${log}`);
}

// ============================================================ 10. 合并

head("10. 合并:成果不许静默消失");
{
  const d = newRepo();
  const b = headSha(d);
  const { token } = seedRoot(d);

  // 分支 A 上做成 nA(新增 a.txt)
  sh("git checkout -q -b A", d);
  mkNode(d, { id: "nA", parent: "root", token, base: b, expect: "加 a.txt",
    verify: "test -f a.txt", delta: ["A:a.txt"] });
  write(d, "a.txt", "a\n");
  let r = bg(d, ["commit", "nA", "--token", token]);
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

  mkNode(d, { id: "m1", parent: "root", token, base: b, expect: "合并",
    verify: "test -f f.txt" });
  r = bg(d, ["commit", "m1", "--token", token]);
  if (r.code !== 0 && /成果在解决冲突时被撤销/.test(r.out)) ok("合并里撤销别人的成果 -> 抓住");
  else bad(`合并丢成果应该被抓,实际:${r.out}`);

  // 正常合并
  write(d, "a.txt", "a\n");
  sh("git add -A", d);
  r = bg(d, ["commit", "m1", "--token", token]);
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
  const { token } = seedRoot(d);
  sh("git checkout -q -b B", d);
  write(d, "f.txt", "vB\n");
  sh("git add -A", d);
  sh("git commit -qm B", d);
  sh("git checkout -q master 2>/dev/null || git checkout -q main", d);
  write(d, "f.txt", "vM\n");
  sh("git add -A", d);
  sh("git commit -qm M", d);
  sh("git merge --no-commit --no-ff B", d);

  mkNode(d, { id: "m1", parent: "root", token, base: b, expect: "合并",
    verify: "test -f f.txt" });
  const r = bg(d, ["commit", "m1", "--token", token]);
  if (r.code !== 0 && /没解决冲突/.test(r.out)) ok("还有冲突 -> 不许提交");
  else bad(`没解决冲突应该被拦,实际:${r.out}`);
}

// ============================================================ 12. abandon

head("12. abandon:只从图里移除,不动工作区");
{
  const d = newRepo();
  const { token, base: b } = seedRoot(d);
  mkNode(d, { id: "n1", parent: "root", token, base: b, expect: "改 f",
    verify: "true", delta: ["M:f.txt"] });
  write(d, "f.txt", "changed\n");   // 工作区有改动

  const r = bg(d, ["abandon", "n1", "--token", token, "--reason", "不做了"]);
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
  const { token, base: b } = seedRoot(d);
  mkNode(d, { id: "n1", parent: "root", token, base: b, expect: "改 f",
    verify: "grep -q v1 f.txt" });
  const r = bg(d, ["status", "n1"]);
  if (/没有任何东西防止意外改动/.test(r.out)) ok("status 标出 Δ 空的风险");
  else bad(`Δ 空应该被标出来,实际:${r.out}`);

  // 空 Δ 时任何改动都能提交 —— 这是设计,但要能看见
  write(d, "f.txt", "v1\n");
  write(d, "whatever.txt", "x\n");
  const c = bg(d, ["commit", "n1", "--token", token]);
  if (c.code === 0) ok("Δ 空时改动能提交(不拦,但已告知)");
  else bad(`Δ 空时不该拦,实际:${c.out}`);
}

// ============================================================ 14. 提交精确性

head("14. 提交的是被验过的那个树");
{
  const d = newRepo();
  const { token, base: b } = seedRoot(d);
  mkNode(d, { id: "n1", parent: "root", token, base: b, expect: "改 f",
    verify: "grep -q v1 f.txt", delta: ["M:f.txt"] });
  write(d, "f.txt", "v1\n");

  const r = bg(d, ["commit", "n1", "--token", token]);
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
  const { token, base: b } = seedRoot(d);
  mkNode(d, { id: "n1", parent: "root", token, base: b, expect: "加个带空格的文件",
    verify: "test -f 'my file.txt'", delta: ["A:my file.txt"] });
  write(d, "my file.txt", "x\n");
  const r = bg(d, ["commit", "n1", "--token", token]);
  if (r.code === 0) ok("路径带空格 -> 正常(-z 解析)");
  else bad(`带空格路径应该能工作,实际:${r.out}`);
}

// ============================================================ 16. Δ 来源

head("16. delta_source:预测 vs 转录");
{
  const d = newRepo();
  const { token, base: b } = seedRoot(d);
  mkNode(d, { id: "n1", parent: "root", token, base: b, expect: "改 f",
    verify: "grep -q v1 f.txt", delta: ["M:f.txt"] });
  // 改它要用**父**凭证(向创建者提权)
  bg(d, ["plan", "--token", token, "--id", "n1", "--parent", "root", "--expect", "改 f",
    "--base", b, "--verify", "grep -q v1 f.txt", "--delta", "M:f.txt",
    "--delta-source", "at-commit"]);
  write(d, "f.txt", "v1\n");
  const r = bg(d, ["commit", "n1", "--token", token]);
  if (r.code !== 0) { bad(`应该达成,实际:${r.out}`); }
  else {
    const trail = sh("git log -1 --format=%B", d).stdout;
    if (/bg-delta-source: at-commit/.test(trail)) ok("转录标记进 trailer");
    else bad(`转录标记应该进 trailer,实际:${trail}`);
  }
}

// ============================================================ 17. 凭证

head("17. 凭证:像目录权限,向下包含");
{
  const d = newRepo();
  const b = headSha(d);

  // 人建根
  let r = bg(d, ["plan", "--id", "root", "--expect", "根", "--base", b, "--verify", "true"]);
  if (r.code !== 0 && /只能由\*\*人\*\*签发/.test(r.out)) ok("agent 建根节点 -> 拒绝(只能人签发)");
  else bad(`agent 不该能建根,实际:${r.out}`);

  const rootOut = bg(d, ["plan", "--as-user", "--id", "root", "--expect", "根",
    "--base", b, "--verify", "test -f f.txt"]);
  const RT = rootOut.out.match(/凭证\s+(\w+)/)?.[1];
  if (rootOut.code === 0 && RT) ok("人建根节点 -> 拿到凭证");
  else bad(`人建根应该拿到凭证,实际:${rootOut.out}`);

  // 库里只存 hash,不存明文
  const stored = read(d, ".bg/nodes.json");
  if (RT && !stored.includes(RT)) ok("库里**不存**凭证明文(只存 hash)");
  else bad("凭证明文不该进库");

  // 没凭证建子节点
  r = bg(d, ["plan", "--id", "n1", "--parent", "root", "--expect", "一层",
    "--base", b, "--verify", "true"]);
  if (r.code !== 0 && /需要 root 自己的凭证/.test(r.out)) ok("没凭证建子节点 -> 拒绝,并说需要谁的");
  else bad(`没凭证应该被拒,实际:${r.out}`);

  // 拿根凭证建子节点
  const n1Out = bg(d, ["plan", "--token", RT, "--id", "n1", "--parent", "root",
    "--expect", "一层", "--base", b, "--verify", "true"]);
  const T1 = n1Out.out.match(/凭证\s+(\w+)/)?.[1];
  if (n1Out.code === 0 && T1) ok("拿父凭证建子节点 -> 成功,拿到自己的凭证");
  else bad(`拿根凭证应该能建子节点,实际:${n1Out.out}`);

  // 孙
  const n11Out = bg(d, ["plan", "--token", T1, "--id", "n11", "--parent", "n1",
    "--expect", "二层", "--base", b, "--verify", "true"]);
  const T2 = n11Out.out.match(/凭证\s+(\w+)/)?.[1];
  if (n11Out.code === 0 && T2) ok("凭证沿树往下签发");
  else bad(`孙节点应该能建,实际:${n11Out.out}`);

  // --- 向下包含 ---
  r = bg(d, ["plan", "--token", RT, "--id", "n11", "--parent", "n1",
    "--expect", "根直接改孙", "--base", b, "--verify", "true"]);
  if (r.code === 0) ok("根凭证能改**所有**后代(向下包含)");
  else bad(`根凭证应该能改孙,实际:${r.out}`);

  // --- 不能向上 ---
  r = bg(d, ["plan", "--token", T1, "--id", "root", "--expect", "子改根",
    "--base", b, "--verify", "true"]);
  if (r.code !== 0 && /人\*\*的凭证/.test(r.out)) ok("子凭证改不了根(不能向上)");
  else bad(`子不该能改根,实际:${r.out}`);

  r = bg(d, ["plan", "--token", T2, "--id", "n1", "--parent", "root",
    "--expect", "孙改父", "--base", b, "--verify", "true"]);
  if (r.code !== 0 && /需要它父节点/.test(r.out)) ok("孙凭证改不了父(要父的凭证)");
  else bad(`孙不该能改父,实际:${r.out}`);

  // --- 改自己要父的凭证(向创建者提权)---
  r = bg(d, ["plan", "--token", T1, "--id", "n1", "--parent", "root",
    "--expect", "改我自己", "--base", b, "--verify", "true"]);
  if (r.code !== 0 && /需要它父节点 root/.test(r.out)) ok("改自己要**父**的凭证 = 向创建者提权");
  else bad(`改自己应该要父凭证,实际:${r.out}`);

  // --- 改写时不给 parent 不能"变成根"(提权漏洞)---
  r = bg(d, ["plan", "--token", RT, "--id", "n1", "--expect", "不给 parent",
    "--base", b, "--verify", "true"]);
  if (r.code !== 0 && /提权|移动节点/.test(r.out)) ok("改写时漏给 parent -> 拒绝(那是一次提权)");
  else bad(`改写时不该能把子节点变成根,实际:${r.out}`);
}

// ============================================================ 18. 冻结优先

head("18. 冻结优先于凭证");
{
  const d = newRepo();
  const b = headSha(d);
  const RT = bg(d, ["plan", "--as-user", "--id", "root", "--expect", "根",
    "--base", b, "--verify", "test -f f.txt"]).out.match(/凭证\s+(\w+)/)?.[1];

  bg(d, ["plan", "--token", RT, "--id", "n1", "--parent", "root", "--expect", "加 g",
    "--base", b, "--verify", "test -f g.txt", "--delta", "A:g.txt"]);
  write(d, "g.txt", "g\n");

  const c = bg(d, ["commit", "n1", "--token", RT]);
  if (c.code === 0) ok("持有凭证 -> 能达成");
  else bad(`应该能达成,实际:${c.out}`);

  const r = bg(d, ["plan", "--token", RT, "--id", "n1", "--parent", "root",
    "--expect", "改已达成的", "--base", b, "--verify", "true"]);
  if (r.code !== 0 && /任何凭证都改不动/.test(r.out)) ok("已达成 -> **任何凭证**都改不动");
  else bad(`冻结不该被凭证破,实际:${r.out}`);

  // 达成后 commit 也要被同一道门挡住
  const c2 = bg(d, ["commit", "n1", "--token", RT]);
  if (c2.code !== 0) ok("已达成 -> commit 也拒绝");
  else bad("已达成不该能再 commit");

  // 没凭证不能 commit
  const d2 = newRepo();
  const b2 = headSha(d2);
  const RT2 = bg(d2, ["plan", "--as-user", "--id", "root", "--expect", "根",
    "--base", b2, "--verify", "true"]).out.match(/凭证\s+(\w+)/)?.[1];
  bg(d2, ["plan", "--token", RT2, "--id", "n1", "--parent", "root", "--expect", "x",
    "--base", b2, "--verify", "true"]);
  const c3 = bg(d2, ["commit", "n1"]);
  if (c3.code !== 0 && /凭证/.test(c3.out)) ok("commit 也要凭证(不能绕过 plan 直接办)");
  else bad(`commit 应该要凭证,实际:${c3.out}`);

  // 没凭证不能 abandon
  const ab = bg(d2, ["abandon", "n1"]);
  if (ab.code !== 0 && /凭证/.test(ab.out)) ok("abandon 也要凭证(不能删别人的意图)");
  else bad(`abandon 应该要凭证,实际:${ab.out}`);

  const abOK = bg(d2, ["abandon", "n1", "--token", RT2]);
  if (abOK.code === 0) ok("持有父凭证 -> 能放弃子节点");
  else bad(`父应该能放弃子节点,实际:${abOK.out}`);
}

// ============================================================ 19. P 的程序文件路径
//
// 立场:**宁可说"不知道",也不猜一个看起来像的路径。**
// 猜错的代价是让人去找一个不存在的文件,比不显示更糟。
head("19. P 的程序文件路径(保守推断)");

{
  const { inferVerifyPath } = await import(join(HERE, "..", "lib", "nodes.mjs"));

  // 形态明确的 -> 推得出来
  for (const [cmd, want] of [
    ["node test/plugin.mjs", "test/plugin.mjs"],
    ["python3 -q foo/bar.py", "foo/bar.py"],
    ["./scripts/ci.sh", "./scripts/ci.sh"],
    ["/usr/local/bin/node build/v.mjs", "build/v.mjs"],
    ["bash --noprofile x.sh", "x.sh"],
  ]) {
    const got = inferVerifyPath(cmd);
    if (got === want) ok(`推得出: ${cmd} -> ${want}`);
    else bad(`该推出来: ${cmd} 期望 ${want},实际 ${got}`);
  }

  // **形态不明确的 -> 必须返回 null,不许猜。**
  // `grep -q ok root.txt` 里的 root.txt 是**被验对象**,不是验证程序 ——
  // 把它当"验证程序路径"是这一节最要防的错。
  for (const cmd of [
    "grep -q ok root.txt", "test -f f.txt", "true", "sleep 10", "pytest -q",
    'node -e "console.log(1)"', 'bash -c "exit 0"',
  ]) {
    const got = inferVerifyPath(cmd);
    if (got === null) ok(`不猜: ${cmd} -> null`);
    else bad(`不许猜: ${cmd} 应该是 null,实际 ${got}`);
  }

  // 显式声明优先,而且**不标"推断"**(标注意味着不确定)
  const d3 = newRepo();
  const b3 = headSha(d3);
  bg(d3, ["plan", "--as-user", "--id", "root", "--expect", "根",
    "--base", b3, "--verify", "test -f f.txt",
    "--verify-path", "scripts/check.sh"]);
  const t3 = bg(d3, ["tree"]).out;
  if (/scripts\/check\.sh/.test(t3) && !/推断/.test(t3)) {
    ok("显式 verify-path -> 原样显示,且**不**标\"推断\"");
  } else {
    bad(`显式路径该被原样显示,实际:${t3.slice(0, 200)}`);
  }

  // 推不出来的 -> 明说"内联命令",不留白。
  // 要用一个**真正没有** verify-path 的仓库 —— 上面那个 root 声明过了,
  // 拿它测会一直看到显式路径,测不到这条。
  const d4 = newRepo();
  const b4 = headSha(d4);
  bg(d4, ["plan", "--as-user", "--id", "root", "--expect", "根",
    "--base", b4, "--verify", "grep -q v0 f.txt"]);
  const t4 = bg(d4, ["tree"]).out;
  if (/内联命令/.test(t4)) ok("推不出来 -> 明说\"P 是内联命令\",不留白");
  else bad(`推不出来该明说,实际:${t4.slice(0, 200)}`);
}

// ============================================================ 20. 图渲染(mermaid)
//
// 这一节是**补上的**。上一版渲染改完"一条验收都没加",测试 73/73 过,
// 但跑的**全是旧测试**,新渲染零覆盖 —— 那是这个仓库记过的错之一。
//
// 所以这里**只测纯函数**(toMermaid:数据 -> 文本),不测浏览器。
// 理由:mermaid 渲染在浏览器里,node 测不到;但**生成什么样的文本**
// 完全在我们手里,而文本错了浏览器只会给你一片空白 —— 图错了却
// 没人报错,正是最该拦的。

head("20. 图渲染:分叉必须画对,不能编造顺序");

/** 造一个**真的有分叉**的仓库 —— 直线历史证明不了任何事。 */
function forkRepo() {
  const d = newRepo();
  sh("git checkout -q -b side", d);
  write(d, "side.txt", "s\n");
  sh("git add -A", d);
  sh("git commit -qm side", d);
  const side = headSha(d);
  sh("git checkout -q master || git checkout -q main", d);
  write(d, "main.txt", "m\n");
  sh("git add -A", d);
  sh("git commit -qm main", d);
  const main = headSha(d);
  sh("git merge --no-commit side >/dev/null 2>&1 || true", d);
  sh('git commit -qm merge || true', d);
  return { d, side, main };
}

{
  const { d, side, main } = forkRepo();
  const base = sh("git rev-list --max-parents=0 HEAD", d).stdout.trim();

  const r = bg(d, ["plan", "--as-user", "--id", "root", "--expect", "起点",
    "--base", base, "--verify", "true"]);
  const tok = (r.out.match(/[a-f0-9]{32}/) ?? [])[0];
  bg(d, ["plan", "--token", tok, "--id", "onSide", "--parent", "root",
    "--expect", "分支上的活", "--base", side, "--verify", "true"]);
  bg(d, ["plan", "--token", tok, "--id", "onMain", "--parent", "root",
    "--expect", "主线上的活", "--base", main, "--verify", "true"]);

  const { graphData, toMermaid } = await import(join(HERE, "..", "lib", "mermaid.mjs"));
  const g = graphData(d);
  const src = toMermaid(g);

  // ---- 负向 0:必须是一棵**连通的**树,不能有游离的点 ----
  //
  // **这条是人肉眼看出来的,说明前面 6 条都没拦住它。**
  //
  // 上一版生成了两套点:commit 点(c*)和节点框(n*),而 `-.->` 只在
  // n 和 n 之间 —— **没有任何边把 n 连到 c**。mermaid 看到两个互不相连的
  // 连通分量,就把它们画成两块,人看到的是"好几棵分离的树"。
  //
  // 根因是模型错了:节点**依托于某个 commit**,该是同一个点,
  // 不是两个点再加一条线。所以这里按**连通分量**验,而不是数点数。
  {
    const allEdges = src.split("\n")
      .filter((l) => /-->/.test(l))
      .map((l) => {
        const m = l.match(/(c\d+)\s*-+>\s*(c\d+)/);
        return m ? [m[1], m[2]] : null;
      })
      .filter(Boolean);
    const pts = src.split("\n")
      .filter((l) => l.includes(":::") && l.includes("["))
      .map((l) => l.trim().split("[")[0].trim());

    const adj = new Map();
    for (const [a, b] of allEdges) {
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push(b);
      adj.get(b).push(a);
    }
    let comps = 0;
    const seen2 = new Set();
    for (const p of pts) {
      if (seen2.has(p)) continue;
      comps += 1;
      const q = [p];
      while (q.length) {
        const x = q.shift();
        if (seen2.has(x)) continue;
        seen2.add(x);
        for (const y of adj.get(x) ?? []) q.push(y);
      }
    }

    if (pts.length > 1 && comps === 1) {
      ok(`图是**一棵连通树**:${pts.length} 个点,${allEdges.length} 条边,1 个连通分量`);
    } else {
      bad(`图裂成了 ${comps} 块(共 ${pts.length} 个点)—— `
        + "节点必须画在它所属的 commit 上,不能另立游离的点");
    }
  }

  // ---- 负向 0.5:上下必须 = 时间顺序(旧在上,新在下)----
  //
  // **这条也是人肉眼看出来的。** 实测踩的坑:
  //
  // 意图父子原本画成 `父 -.-> 子`,而 `root.result` 比 `t1.result` **晚**
  // (父节点**后**达成),于是虚线要求"父在上"、实线要求"旧在上" ——
  // **两种关系方向打架**,mermaid 服从虚线,把 root 拉到最顶,
  // 整条实线链**翻了过来**。
  //
  // ⚠ **这个坑需要专门的场景才复现**:必须有一个节点,它的**父节点
  // 比它晚达成**。全是 todo 的仓库复现不了 —— 那种情况下大家都锚在
  // base 上,方向天然一致,翻不翻都看不出来。
  // (实测:这条验收的第一版就是这么**空过**的,变异测试照样全绿。)
  //
  // 所以这里**专门造**那个场景:先达成子,后达成父。
  {
    const d2 = newRepo();
    const b0 = headSha(d2);
    const r2 = bg(d2, ["plan", "--as-user", "--id", "father", "--expect", "父",
      "--base", b0, "--verify", "true"]);
    const tok2 = (r2.out.match(/[a-f0-9]{32}/) ?? [])[0];
    bg(d2, ["plan", "--token", tok2, "--id", "child", "--parent", "father",
      "--expect", "子", "--base", b0, "--verify", "true"]);

    // 子先达成
    write(d2, "c.txt", "c\n");
    bg(d2, ["commit", "child", "--token", tok2]);

    // 父后达成(于是 父.result 比 子.result 新)
    //
    // ⚠ 注意:father 是**根节点**,commit 它需要 `--as-user` ——
    // agent 拿不到根的凭证(实测:`节点 father 是根节点 —— 改它需要人的凭证`)。
    // 这里不写 `--as-user` 的话它会**静默不达成**,场景就造不出来。
    write(d2, "f2.txt", "f\n");
    bg(d2, ["commit", "father", "--as-user"]);

    // result 要从节点库里读 —— `bg status` 只打短 sha,拿不到完整值。
    const { allNodes: allNodes2 } = await import(join(HERE, "..", "lib", "store.mjs"));
    const nd = Object.fromEntries(allNodes2(d2).map((n) => [n.id, n]));
    const childSha = nd.child?.result ?? null;
    const fatherSha = nd.father?.result ?? null;

    const m2 = toMermaid(graphData(d2));
    const map2 = {};
    for (const l of m2.split("\n")) {
      const m = l.trim().match(/^(c\d+)\["([a-f0-9]{8})/);
      if (m) map2[m[1]] = m[2];
    }
    // ⚠ **键必须是短 sha** —— `map2` 里存的是 label 里的 8 位短 sha,
    // 而 `git log --format=%H` 给的是 40 位。直接拿完整 sha 做键,
    // `rank.get()` 会**静默返回 undefined**,比较永远 false,
    // 这条验收就变成了永远通过的死代码。(实测踩过:变异测试全绿。)
    const order2 = sh("git log --reverse --format=%H", d2).stdout.trim().split("\n");
    const rank2 = new Map(order2.map((sha, i) => [sha.slice(0, 8), i]));

    // ⚠ 过滤条件**不能**写 `/-->/` —— `-.->` 不含 `-->`,
    // 虚线会被整条丢掉,这条验收就只验了实线(实测:变异测试全绿)。
    // 正确做法:先按"含箭头"捞,再从中区分两种线。
    const all2 = m2.split("\n")
      .map((l) => l.match(/(c\d+)\s*(-\.->|-->)\s*(c\d+)/))
      .filter(Boolean)
      .map((mm) => [mm[1], mm[3], mm[2].includes(".") ? "虚线" : "实线"]);

    const wrong2 = all2.filter(([a, b]) => {
      const ra = rank2.get(map2[a]);
      const rb = rank2.get(map2[b]);
      return ra != null && rb != null && ra > rb;
    });

    if (!childSha || !fatherSha || childSha === fatherSha) {
      // 场景没造出来 -> 这条等于没验,必须报错而不是静默通过。
      bad("父后达成的场景没造出来(父子没产出两个不同 commit)—— 这条等于没验");
    } else if (all2.length && !wrong2.length) {
      ok(`父比子晚达成时,${all2.length} 条边仍然"旧在上" —— 没被虚线带翻`);
    } else {
      bad(`父比子晚达成时图会翻:${wrong2.length}/${all2.length} 条边要求"新的在上"(`);
    }
  }

  // ---- 负向 1:分叉必须出现两条实线 ----
  //
  // **这条是这一节存在的理由。** 上一版把提交映射成一个标量
  // (`git rev-list --count`),在分叉历史里**编造了一个顺序** ——
  // 它在本仓库(纯线性)上看起来是对的,那是最坏的那种错。
  const solid = src.split("\n").filter((l) => l.includes("-->"));
  if (solid.length >= 2) {
    ok(`分叉画出来了:${solid.length} 条 git 实线`);
  } else {
    bad(`分叉没画出来 —— 只找到 ${solid.length} 条实线。真正的分叉要有两条`);
  }

  // ---- 负向 2:不能把提交压成一个标量/序号 ----
  //
  // 只要源码里出现"第几个提交"这种数字排序,就是又在编造顺序。
  const ids = src.match(/\bc\d+\b/g) ?? [];
  if (ids.length && !/--count|rev-list\s+--count/.test(src)) {
    ok("按 git 父子画,没有用提交计数编造顺序");
  } else {
    bad("疑似又用提交计数当坐标 —— 分叉历史里那是在编造顺序");
  }

  // ---- 负向 3:意图父子必须是虚线,不能和 git 实线混 ----
  const dashed = src.split("\n").filter((l) => l.includes("-.->"));
  if (dashed.length >= 2) {
    ok(`意图父子用虚线:${dashed.length} 条`);
  } else {
    bad(`意图父子该用虚线,实际 ${dashed.length} 条 —— 混画会让人以为两者是一回事`);
  }

  // ---- 负向 3.5:三种状态必须画成三种,不能把"进行中"吞成"已达成" ----
  //
  // 实测踩的坑:一个点上落了多个节点时,我原来只判
  // `owners.some(state === "done")` —— **"进行中"整个被吞了**。
  // 建两个改了工作区的节点,它们和已达成节点共用同一个 commit,
  // 于是被标成**绿色**,看起来像"已经完成" —— 而真相是正在改。
  //
  // 这条验收的关键在**一个 commit 上同时挂 done 和 wip**,
  // 单节点场景测不出来。
  {
    const d3 = newRepo();
    const b3 = headSha(d3);

    // 先有一个**已达成**的根 —— 它会占住那个 commit。
    bg(d3, ["plan", "--as-user", "--id", "root", "--expect", "根",
      "--base", b3, "--verify", "true"]);
    write(d3, "r.txt", "r\n");
    bg(d3, ["commit", "root", "--as-user"]);
    const { allNodes: allNodes3 } = await import(join(HERE, "..", "lib", "store.mjs"));
    const rootSha = allNodes3(d3).find((n) => n.id === "root")?.result;

    // 再声明一个**待办**节点,base 指向**同一个 commit**。
    bg(d3, ["plan", "--as-user", "--id", "wip1", "--expect", "正在改的",
      "--base", rootSha, "--verify", "true"]);

    // 动一下工作区 —— 这才让它变成"进行中"。
    write(d3, "w.txt", "w\n");

    // ⚠ **必须传 treeY** —— 不传的话没有任何工作区信号,
    // "进行中"就永远不可能出现,这条验收会变成**假绿**。
    // (实测:第一版就是这么写的,测试报了红,但红的是测试自己。)
    const { workingTreeHash: wth3 } = await import(join(HERE, "..", "lib", "git.mjs"));
    const m3 = toMermaid(graphData(d3), { treeY: wth3(d3) });
    const line = m3.split("\n").find((l) => l.includes("[")) ?? "";
    // 那个点同时挂着 root(done)和 wip1(进行中)-> 必须画成 wip(橙)
    if (/:::wip/.test(line)) {
      ok("同一点上 done + 进行中 -> 画成**进行中**(没被绿色吞掉)");
    } else {
      bad(`同一点上有"进行中"的节点,却被画成 ${(line.match(/:::\w+/) ?? [])[0]} `
        + "—— 会让人以为已经完成了");
    }

    // 而且三种 classDef 都得有,否则 mermaid 认不出 wip 这个类。
    if (/classDef\s+wip/.test(m3)) ok("声明了 wip 的 classDef(橙)");
    else bad("没有 wip 的 classDef —— 进行中的点会没有颜色");
  }

  // ---- 负向 4:双引号必须被换掉 ----
  //
  // 实测:expect 里有一个半角 `"` 就会让**整张图渲染失败**(不是画错,
  // 是空白)。仓库自己的历史里就有一条 `删掉"绕过"概念`。
  const dq = newRepo();
  const bq = headSha(dq);
  bg(dq, ["plan", "--as-user", "--id", 'say"hi', "--expect", '含"引号"的意图',
    "--base", bq, "--verify", "true"]);
  const qsrc = toMermaid(graphData(dq));
  const stray = qsrc.split("\n")
    .filter((l) => l.includes("[\""))
    .some((l) => {
      // 把首尾那对引号剥掉,里面不该再有半角双引号
      const inner = l.slice(l.indexOf('["') + 2, l.lastIndexOf('"]'));
      return inner.includes('"');
    });
  if (!stray) ok("label 里的半角双引号被换掉(否则整张图会空白)");
  else bad("label 里还有半角双引号 —— mermaid 会解析失败,页面一片空白");

  // ---- 负向 4.5:两条渲染路径都要传 treeY,否则实时版看不出"进行中" ----
  //
  // 实测踩的坑:`bg html`(静态)传了 `treeY`,但 `bg serve`(实时)
  // **漏了** —— 于是同一个仓库,静态页能看出"进行中",实时页却
  // 永远是绿/灰两色。**两条路径渲染同一个东西,却给出不同的答案。**
  //
  // 这条不启服务(那要开端口),而是**直接查源码**:两个入口都必须
  // 把 treeY 交给渲染。源码级守卫比跑一遍更稳,也更便宜。
  {
    const htmlSrc = readFileSync(join(HERE, "..", "lib", "html.mjs"), "utf8");
    const serveSrc = readFileSync(join(HERE, "..", "lib", "serve.mjs"), "utf8");
    const hasTreeY = (s) => /mermaidHtml\([\s\S]{0,200}?treeY:/.test(s);

    if (hasTreeY(htmlSrc)) ok("bg html 传了 treeY(能判出\"进行中\")");
    else bad("bg html **没传 treeY** —— 进行中的节点会显示成待办");

    if (hasTreeY(serveSrc)) ok("bg serve 传了 treeY(能判出\"进行中\")");
    else bad("bg serve **没传 treeY** —— 实时页看不出进行中,和静态页不一致");
  }

  // ---- 负向 5:断网兜底必须存在 ----
  //
  // 引了 CDN 就意味着**断网打不开图**。打不开不能表现成空白 ——
  // 那会让人以为"这个仓库没有节点"。纯 HTML 的文字清单必须在。
  const page = bg(d, ["html"]).out;
  const file = read(d, ".bg/tree.html");
  if (/断网时的节点清单/.test(file) && /<li>/.test(file)) {
    ok("断网兜底:页面里有纯文字节点清单(不依赖 JS)");
  } else {
    bad("没有断网兜底 —— 图打不开时页面会是空白,人会以为没有节点");
  }

  // ---- 负向 6:必须说清"要联网" ----
  if (/需要联网|加载不了 mermaid/.test(file)) {
    ok("说清了图需要联网,不假装自包含");
  } else {
    bad("没说清要联网 —— 断网时人会以为是工具坏了");
  }
}

// ============================================================ 结果

cleanup();
console.log(`\n${FAIL === 0 ? "\x1b[32m" : "\x1b[31m"}${PASS} 过 / ${FAIL} 败\x1b[0m`);
process.exit(FAIL === 0 ? 0 : 1);
