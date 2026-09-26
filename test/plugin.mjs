/**
 * plugin.mjs —— 插件自测。**不起完整 DSH**,直接加载插件验证。
 *
 * 验四件事:
 *   1. Cordis 契约(inject 声明完整)—— 漏一个,真实启动时整棵插件树挂掉
 *   2. 五个工具都注册了,参数 schema 正确
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

const names = registered.map((t) => t.name).sort();
const want = ["node_accept", "node_check", "node_declare", "node_drop",
  "node_health", "node_tree"];
if (JSON.stringify(names) === JSON.stringify(want)) {
  ok(`注册了 ${names.length} 个工具: ${names.join(", ")}`);
} else {
  bad(`工具不对: ${names.join(", ")}`);
}

const declareTool = registered.find((t) => t.name === "node_declare");
for (const k of ["stepId", "expectation", "fsExists", "fsAbsent", "fsContains",
  "fsTree", "procPresent", "procAbsent", "verify", "owner", "parent", "allow"]) {
  if (!(k in declareTool.parameters.properties)) bad(`缺参数 ${k}`);
}
ok("门禁参数齐(fs / proc / verify 三部分都在)");

if (!("asUser" in declareTool.parameters.properties)) {
  ok("插件**不暴露** asUser —— 模型不能自己授权自己改人定的验收");
} else {
  bad("插件把 asUser 暴露给模型了");
}

// BUG-4 回归守卫:每个工具都必须能**显式指定 project**。
// 原来写死会话 cwd —— 于是"节点声明在 A 目录、会话在 B 目录"时,
// 模型看不见自己刚声明的验收(实测过)。
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
sh("git -c user.email=a@b -c user.name=a commit -q --allow-empty -m init");
writeFileSync(join(d, "x.py"), "v1\n", "utf8");
sh("git add -A && git -c user.email=a@b -c user.name=a commit -q -m base");

// 插件从 exec 里取会话 cwd
const exec = { agent: { session: { header: { cwd: d } } } };
const call = (n, args) => registered.find((t) => t.name === n).execute(args, exec);

const init = spawnSync("node", [join(ROOT, "bin", "bg.mjs"), "--project", d, "init"],
  { encoding: "utf8" });
void init;

const fakeCheck = await call("node_check", {
  stepId: "p-1", expectation: "功能可用", verify: "true",
});
if (fakeCheck.ok === false && fakeCheck.lines.some((l) => /基线/.test(l))) {
  ok("node_check 拒绝白给的门禁(假验证程序)");
} else {
  bad(`node_check 没拦住假验证程序: ${JSON.stringify(fakeCheck).slice(0, 140)}`);
}

const good = await call("node_check", {
  stepId: "p-2", expectation: "让 x.py 支持 v2",
  fsContains: ["x.py:v2"], verify: "grep -q v2 x.py",
});
if (good.ok === true) ok("node_check 通过真门禁");
else bad(`真门禁没通过: ${JSON.stringify(good).slice(0, 140)}`);

const dec = await call("node_declare", {
  stepId: "p-2", expectation: "让 x.py 支持 v2",
  fsContains: ["x.py:v2"], verify: "grep -q v2 x.py",
});
if (dec.ok === true) ok("node_declare 写进图");
else bad(`node_declare 失败: ${JSON.stringify(dec).slice(0, 140)}`);

const early = await call("node_accept", { stepId: "p-2" });
if (early.ok === false && early.lines.some((l) => /要求/.test(l))) {
  ok("node_accept 未达成时不通过,并给出**要求**");
} else {
  bad(`node_accept 结果不对: ${JSON.stringify(early).slice(0, 140)}`);
}

writeFileSync(join(d, "x.py"), "v2\n", "utf8");
const acc = await call("node_accept", { stepId: "p-2" });
if (acc.ok === true && /第一盏灯/.test(acc.summary)) {
  ok("node_accept 通过 -> 点亮第一盏灯(带证据锚)");
} else {
  bad(`验收没通过: ${JSON.stringify(acc).slice(0, 140)}`);
}

const tree = await call("node_tree", {});
if (/●/.test(tree.summary) && /图例/.test(tree.summary)) {
  ok("node_tree 渲染两盏灯 + 图例");
} else {
  bad(`node_tree 输出不对: ${tree.summary.slice(0, 120)}`);
}

const health = await call("node_health", {});
if (/●/.test(health.summary)) ok("node_health 出声");
else bad("node_health 没输出");

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

rmSync(d, { recursive: true, force: true });

console.log(`\n\x1b[1m结果\x1b[0m\n  通过 ${PASS} / 失败 ${FAIL}`);
process.exit(FAIL === 0 ? 0 : 1);
