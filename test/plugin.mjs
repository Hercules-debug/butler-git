/**
 * plugin.mjs —— 插件自测。**不起完整 DSH**,直接加载插件验证。
 *
 * 验四件事:
 *   1. Cordis 契约(inject 声明完整)—— 漏一个,真实启动时整棵插件树挂掉
 *   2. **四个**工具都注册了,参数 schema 正确
 *   3. 真的跑一遍 execute —— 形状对、结论对
 *   4. **插件不实现业务逻辑**:它调 ../lib,和 CLI 同一套
 *
 * 用法: node test/plugin.mjs
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

let PASS = 0;
let FAIL = 0;
const ok = (m) => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); PASS += 1; };
const bad = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); FAIL += 1; };

const registered = [];
const mod = await import(join(ROOT, "plugin", "index.js"));

// --- 0. Cordis 契约 ---------------------------------------------------------
//
// 模拟 cordis 的**严格 ctx**:没在 inject 里声明的服务,读取时直接抛
// `cannot get property "X" without inject`,而不是给个 undefined。
//
// 这一步是必需的 —— 之前用过普通对象,于是自测全绿但真实加载时崩。
const inject = new Set(mod.inject ?? []);
const CORDIS_API = new Set([
  "on", "off", "once", "emit", "parallel", "bail", "serial",
  "effect", "dispose", "start", "stop", "restart",
  "get", "set", "provide", "inject", "accessor",
  "logger", "fiber", "plugin", "root", "scope", "context", "registry", "reflect",
]);

const accessed = new Set();
const services = { tools: { register(def) { registered.push(def); } } };
const ctx = new Proxy({}, {
  get(_t, prop) {
    if (typeof prop === "symbol") return undefined;
    if (CORDIS_API.has(prop)) return undefined;
    accessed.add(prop);
    if (!inject.has(prop)) throw new Error(`cannot get property "${prop}" without inject`);
    return services[prop];
  },
});

mod.apply(ctx);

console.log("\n1. Cordis 契约 + 工具注册");

const undeclared = [...accessed].filter((s) => !inject.has(s));
if (!undeclared.length) {
  ok(`inject 声明完整: [${[...inject].join(", ")}]`);
} else {
  bad(`inject 缺声明: ${undeclared.join(", ")} —— 真实启动会抛 "without inject"`);
}

// **四个。** 上一版六个是负担 —— 模型会挑一个差不多的用,或者开始乱试。
const names = registered.map((t) => t.name).sort();
const want = ["node_abandon", "node_commit", "node_plan", "node_status"];
if (JSON.stringify(names) === JSON.stringify(want)) {
  ok(`注册了 ${names.length} 个工具: ${names.join(", ")}`);
} else {
  bad(`工具不对: ${names.join(", ")}`);
}

const planTool = registered.find((t) => t.name === "node_plan");
for (const k of ["id", "expect", "base", "verify", "delta", "parent", "owner",
  "delta_source"]) {
  if (!(k in (planTool.parameters?.properties ?? {}))) bad(`node_plan 缺参数 ${k}`);
}
ok("node_plan 参数齐(id / expect / base / Δ / P 都在)");

// base 和 verify 必须是必填 —— 它们是这套东西的承重墙
const req = planTool.parameters?.required ?? [];
for (const k of ["id", "expect", "base", "verify"]) {
  if (!req.includes(k)) bad(`node_plan 的 ${k} 应该是必填`);
}
ok("base 和 verify 是必填(不猜默认值 / P 必须有)");

// 插件**不暴露** asUser —— 模型不能自己授权自己改人定的验收
if (!("asUser" in (planTool.parameters?.properties ?? {}))) {
  ok("插件**不暴露** asUser —— 模型不能自己授权自己改人定的验收");
} else {
  bad("插件把 asUser 暴露给模型了");
}

// BUG-4 回归守卫:每个工具都必须能**显式指定 project**。
const noProject = registered
  .filter((t) => !("project" in (t.parameters?.properties ?? {})))
  .map((t) => t.name);
if (!noProject.length) {
  ok(`每个工具都能显式指定 project(${registered.length} 个全覆盖)`);
} else {
  bad(`这些工具没有 project 参数,只能看会话 cwd: ${noProject.join(", ")}`);
}

// BUG-5 回归守卫:patch 注释里的工具数必须和实现对得上。
const patch = readFileSync(join(ROOT, "plugin", "cordis.patch.yml"), "utf8");
const cn = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7 };
const m = patch.match(/只注册\**([一二三四五六七])\**个/);
if (m && cn[m[1]] === registered.length) {
  ok(`cordis.patch.yml 的注释说「${m[1]}个」,和实现一致`);
} else {
  bad(`注释说的工具数和实现对不上: ${m ? cn[m[1]] : "(没写)"} vs ${registered.length}`);
}

// --- 2. 真的跑一遍 ---------------------------------------------------------

console.log("\n2. 执行路径(用临时 git 仓库)");

const d = mkdtempSync(join(tmpdir(), "bg-plugin-"));
const sh = (c) => spawnSync(c, { shell: true, cwd: d, encoding: "utf8" });
sh("git init -q .");
sh("git config user.email a@b");
sh("git config user.name a");
writeFileSync(join(d, "x.py"), "v1\n", "utf8");
sh("git add -A && git commit -qm base");
const BASE = sh("git rev-parse HEAD").stdout.trim();

const exec = { agent: { session: { header: { cwd: d } } } };

/**
 * 调工具。`t.execute` 会**先**跑 schema 校验,和真实运行时一致 ——
 * 所以"必填缺失"这类是由 schema 挡的,不是我们的代码。
 *
 * 我们自己那两道门(不给 base 就报错、不给 P 就报错)在 CLI 侧验
 * (见 run.mjs 第 1 节)—— 那里没有 schema 抢在前面。
 */
const tool = (n) => registered.find((t) => t.name === n);
const call = (n, args) => tool(n).execute(args, exec);

// --- 必填由 schema 挡在前面(真实运行时就是这样) ---
let threwBase = false;
try { await call("node_plan", { id: "p-0", expect: "改 x.py", verify: "true" }); } catch { threwBase = true; }
if (threwBase) ok("没给 base -> schema 直接拒(必填)");
else bad("base 是必填,schema 应该拒");

let threwVerify = false;
try { await call("node_plan", { id: "p-0", expect: "改 x.py", base: BASE }); } catch { threwVerify = true; }
if (threwVerify) ok("没给 P -> schema 直接拒(必填)");
else bad("verify 是必填,schema 应该拒");

// --- 正常声明 ---
// 根节点只能由**人**签发(--as-user),插件里没有这个开关。
// 所以先让 CLI 建好根、拿回凭证 —— 插件从根往下拆。
const seed = spawnSync("node", [join(ROOT, "bin", "bg.mjs"), "--dir", d,
  "plan", "--as-user", "--id", "root", "--expect", "根", "--base", BASE,
  "--verify", "test -f x.py"], { encoding: "utf8" });
const ROOT_TOKEN = `${seed.stdout ?? ""}`.match(/凭证\s+(\w+)/)?.[1];
if (ROOT_TOKEN) ok("根节点由**人**创建,拿到凭证(插件没这个开关)");
else bad(`人建根应该拿到凭证: ${(seed.stdout ?? "") + (seed.stderr ?? "")}`.slice(0, 200));

// 插件**不能**建根节点
const noRoot = await call("node_plan", {
  id: "p-root", expect: "我想建个根", base: BASE, verify: "true",
});
if (noRoot.ok === false && /只能由\*\*人\*\*签发/.test(noRoot.lines.join())) {
  ok("插件建根节点 -> 拒绝(模型不能自己签发)");
} else {
  bad(`插件不该能建根: ${JSON.stringify(noRoot).slice(0, 200)}`);
}

// 没有凭证 -> 建不了子节点
const noTok = await call("node_plan", {
  id: "p-0", expect: "没凭证", base: BASE, verify: "true", parent: "root",
});
if (noTok.ok === false && /需要 root 自己的凭证/.test(noTok.lines.join())) {
  ok("没凭证建子节点 -> 拒绝,并说清需要**谁的**");
} else {
  bad(`没凭证应该被拒: ${JSON.stringify(noTok).slice(0, 200)}`);
}

const dec = await call("node_plan", {
  id: "p-1", expect: "让 x.py 支持 v2", base: BASE, parent: "root",
  verify: "grep -q v2 x.py", delta: ["M:x.py"], token: ROOT_TOKEN,
});
if (dec.ok === true && /凭证/.test(dec.lines.join())) {
  ok("拿父凭证 -> 建子节点成功,并拿到**自己的**凭证");
} else {
  bad(`node_plan 失败: ${JSON.stringify(dec).slice(0, 200)}`);
}
const P1 = dec.lines.join().match(/凭证\s+(\w+)/)?.[1];

// --- status:便宜,不跑 P ---
const st = await call("node_status", { id: "p-1" });
if (st.ok === true && /漏做/.test(st.lines.join())) {
  ok("node_status 指出 Δ 里声明的还没发生");
} else {
  bad(`node_status 结果不对: ${JSON.stringify(st).slice(0, 200)}`);
}

// --- commit:没做 -> 不提交,给要求 ---
const early = await call("node_commit", { id: "p-1", token: ROOT_TOKEN });
if (early.ok === false && /要求/.test(early.lines.join())) {
  ok("node_commit 没过时**不提交**,并给出要求");
} else {
  bad(`node_commit 结果不对: ${JSON.stringify(early).slice(0, 200)}`);
}

// --- 预期外的改动 ---
writeFileSync(join(d, "x.py"), "v2\n", "utf8");
writeFileSync(join(d, "junk.py"), "junk\n", "utf8");
const junk = await call("node_commit", { id: "p-1", token: ROOT_TOKEN });
if (junk.ok === false && /预期外/.test(junk.lines.join())) {
  ok("node_commit 抓住**预期外的改动**");
} else {
  bad(`预期外改动没被抓: ${JSON.stringify(junk).slice(0, 200)}`);
}

// --- 真的达成 ---
rmSync(join(d, "junk.py"));
const acc = await call("node_commit", { id: "p-1", token: ROOT_TOKEN });
if (acc.ok === true && /达成/.test(acc.summary)) {
  ok("node_commit 全过 -> 达成(产出证据 commit)");
} else {
  bad(`应该达成: ${JSON.stringify(acc).slice(0, 200)}`);
}

// --- 冻结 ---
const frozen = await call("node_plan", {
  id: "p-1", expect: "改主意", base: BASE, verify: "true",
  parent: "root", token: ROOT_TOKEN,
});
if (frozen.ok === false && /冻结/.test(frozen.lines.join())) {
  ok("已达成的节点 -> 门禁冻结");
} else {
  bad(`已达成的节点该冻结: ${JSON.stringify(frozen).slice(0, 200)}`);
}

// --- abandon:未达成的能放弃 ---
const dec2 = await call("node_plan", {
  id: "p-2", expect: "以后做", base: BASE, verify: "true",
  parent: "root", token: ROOT_TOKEN,
});
if (dec2.ok !== true) bad(`p-2 声明失败: ${JSON.stringify(dec2).slice(0, 160)}`);

// 改 p-2 **自己**要父凭证 —— 拿它自己的凭证不行(向创建者提权)
const selfTok = await call("node_plan", {
  id: "p-2", expect: "我自己改自己", base: BASE, verify: "true",
  parent: "root", token: dec2.lines.join().match(/凭证\s+(\w+)/)?.[1],
});
if (selfTok.ok === false && /需要它父节点/.test(selfTok.lines.join())) {
  ok("改自己要**父**的凭证 —— 向创建者提权");
} else {
  bad(`改自己应该要父凭证: ${JSON.stringify(selfTok).slice(0, 200)}`);
}

const ab = await call("node_abandon", { id: "p-2", reason: "不做", token: ROOT_TOKEN });
if (ab.ok === true) ok("node_abandon 移除未达成的声明");
else bad(`abandon 失败: ${JSON.stringify(ab).slice(0, 160)}`);

// --- 已达成的不能放弃 ---
const abDone = await call("node_abandon", { id: "p-1", token: ROOT_TOKEN });
if (abDone.ok === false && /不能放弃|任何凭证都改不动/.test(abDone.lines.join())) {
  ok("已达成的节点 -> 不能放弃(历史不改写)");
} else {
  bad(`已达成的节点不该能放弃: ${JSON.stringify(abDone).slice(0, 200)}`);
}

// --- 3. 不实现业务逻辑 -----------------------------------------------------

console.log("\n3. 逻辑只有一份(和 CLI 同一套)");

// 只看**代码**,不看注释 —— 注释里会解释历史,不该影响判定。
const src = readFileSync(join(ROOT, "plugin", "index.js"), "utf8");
const code = src.split("\n").filter((l) => !/^\s*[*/]/.test(l)).join("\n");

if (/\.\.\/lib\//.test(code) && !/spawnSync|execFile|spawn\(/.test(code)) {
  ok("插件只调 ../lib,**不自己起子进程、不重写一份逻辑**");
} else {
  bad("插件里出现了子进程调用或自成一体的实现 —— 那就是两个前端漂移的起点");
}

// 人的面不占模型的工具位
for (const human of ["node_tree", "node_health", "node_log", "node_recheck"]) {
  if (!names.includes(human)) ok(`人的面 ${human} **不**占模型的工具位`);
  else bad(`${human} 不该出现在模型的工具里`);
}

rmSync(d, { recursive: true, force: true });

console.log(`\n\x1b[1m结果\x1b[0m\n  通过 ${PASS} / 失败 ${FAIL}`);
process.exit(FAIL === 0 ? 0 : 1);
