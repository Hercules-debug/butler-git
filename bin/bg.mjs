#!/usr/bin/env node
/**
 * bg —— butler-git 的命令行。**给人用的那一半。**
 *
 * 模型走插件(plugin/index.js),人走这里。两边调的是**同一套 lib** ——
 * 所以不存在"两个前端漂移"的问题(上一个实现正是死在这上面:
 * Python 核心和 JS 插件各写一遍,改了一边另一边静默落后)。
 *
 *   bg init                          取基线
 *   bg check --file c.json           只检查一份门禁够不够格
 *   bg declare --file c.json         声明/改写一个节点
 *   bg accept <id>                   跑完整门禁;全过则点亮第一盏灯
 *   bg retract <id> [--reason ...]   作废(追加一条,不改写历史)
 *   bg view [--live] [--detail <id>] 看树(两盏灯)
 *   bg health                        心跳一行
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { isRepo, head, treeOf, workingTreeHash } from "../lib/git.mjs";
import * as store from "../lib/store.mjs";
import { checkContract, checkVacuity } from "../lib/contract.mjs";
import { declare, accept, retract, normalize } from "../lib/nodes.mjs";
import { evaluateGate } from "../lib/gate.mjs";
import { render, renderDetail, healthLine } from "../lib/view.mjs";

const REPEATABLE = new Set([
  "allow", "fs-exists", "fs-absent", "fs-contains", "fs-not-contains",
  "proc-present", "proc-absent",
]);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    i += 1;
    if (REPEATABLE.has(key)) {
      flags[key] = [...(flags[key] ?? []), next];
    } else {
      flags[key] = next;
    }
  }
  return { positional, flags };
}

const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** 从 --file(JSON)或紧凑参数拼一份契约。 */
function contractFrom({ flags }) {
  if (flags.file) {
    const text = flags.file === "-" ? readFileSync(0, "utf8") : readFileSync(flags.file, "utf8");
    try {
      return { ok: true, contract: JSON.parse(text) };
    } catch (e) {
      return { ok: false, error: `读不了契约 JSON: ${e.message}` };
    }
  }

  if (!flags.id && !flags.expect) {
    return { ok: false, error: "给出契约:--file <路径|-> 或 --id/--expect/... 紧凑参数" };
  }

  const paths = [
    ...asList(flags["fs-exists"]).map((path) => ({ kind: "exists", path })),
    ...asList(flags["fs-absent"]).map((path) => ({ kind: "absent", path })),
    ...asList(flags["fs-contains"]).map((s) => {
      // 只切**第一个**冒号 —— pattern 里含冒号是常见的(比如 URL)
      const i = s.indexOf(":");
      return i < 0
        ? { kind: "contains", path: s, pattern: "" }
        : { kind: "contains", path: s.slice(0, i), pattern: s.slice(i + 1) };
    }),
    ...asList(flags["fs-not-contains"]).map((s) => {
      const i = s.indexOf(":");
      return i < 0
        ? { kind: "not_contains", path: s, pattern: "" }
        : { kind: "not_contains", path: s.slice(0, i), pattern: s.slice(i + 1) };
    }),
  ];

  return {
    ok: true,
    contract: {
      id: flags.id,
      expect: flags.expect ?? "",
      parent: flags.parent ?? null,
      owner: flags.owner ?? "model",
      allow: asList(flags.allow),
      fs: { paths, tree: flags["fs-tree"] ?? null },
      proc: {
        present: asList(flags["proc-present"]),
        absent: asList(flags["proc-absent"]),
      },
      verify: flags.verify ?? null,
    },
  };
}

const projectDir = (flags) => resolve(flags.project ?? process.cwd());
const emit = (o) => console.log(JSON.stringify(o, null, 2));

// ------------------------------------------------------------------ 命令

function cmdInit(flags) {
  const dir = projectDir(flags);
  if (!isRepo(dir)) {
    console.log(`基线已取: ${dir}\n  git: 否 —— **文件侧没有保证**(不假装能做到)`);
    store.saveBaseline(dir, { head: "", tree: null, isRepo: false, ts: store.nowIso() });
    return 0;
  }
  const h = head(dir);
  const t = treeOf(dir, "HEAD");
  store.saveBaseline(dir, { head: h, tree: t, isRepo: true, ts: store.nowIso() });
  store.appendLedger(dir, { type: "init", head: h, tree: t });
  console.log(`基线已取: ${dir}\n  git: 是  head=${h.slice(0, 12) || "(空仓库)"}  tree=${(t ?? "-").slice(0, 12)}`);
  return 0;
}

function cmdCheck(flags) {
  const dir = projectDir(flags);
  const { ok, contract, error } = contractFrom({ flags });
  if (!ok) { console.log(error); return 2; }
  const r = checkContract(dir, normalize(contract));
  emit({ ok: r.ok, problems: r.problems, notes: r.notes });
  return r.ok ? 0 : 1;
}

function cmdDeclare(flags) {
  const dir = projectDir(flags);
  const { ok, contract, error } = contractFrom({ flags });
  if (!ok) { console.log(error); return 2; }
  const r = declare(dir, contract, { asUser: Boolean(flags["as-user"]) });
  emit(r.ok
    ? { ok: true, node: r.node.id, rewrite: r.rewrite, notes: r.notes }
    : { ok: false, problems: r.problems, owner: r.owner });
  return r.ok ? 0 : 1;
}

function cmdAccept(args, flags) {
  const dir = projectDir(flags);
  const id = args[0];
  if (!id) { console.log("用法: bg accept <节点 id>"); return 2; }
  const r = accept(dir, id, { timeout: Number(flags.timeout ?? 120_000) });
  if (r.ok) {
    emit({ ok: true, node: id, evidence: { tree: r.evidence.tree, ts: r.evidence.ts } });
    return 0;
  }
  console.log(`[验收 ${id}] 不通过`);
  for (const p of r.problems) console.log(`  ✗ ${p}`);
  return 1;
}

function cmdRetract(args, flags) {
  const dir = projectDir(flags);
  const id = args[0];
  if (!id) { console.log("用法: bg retract <节点 id>"); return 2; }
  const r = retract(dir, id, flags.reason ?? "");
  emit(r);
  return r.ok ? 0 : 1;
}

function cmdAssert(args, flags) {
  const dir = projectDir(flags);
  const id = args[0];
  if (!id) { console.log("用法: bg assert <节点 id> [--cheap]"); return 2; }
  const node = store.getNode(dir, id);
  if (!node) { console.log(`节点 ${id} 不存在`); return 1; }
  const mode = flags.cheap ? "cheap" : "full";
  const r = evaluateGate(dir, node, { mode });
  for (const i of r.items) {
    const mark = i.status === "ok" ? "✓" : i.status === "fail" ? "✗" : "?";
    console.log(`  ${mark} ${i.label}  ${i.detail}`);
    if (i.demand) console.log(`      -> 要求: ${i.demand}`);
  }
  if (r.empty) console.log("  (这个节点没有门禁)");
  console.log(r.ok ? `[门禁 ${id}] 过` : `[门禁 ${id}] ${r.failed.length ? "不过" : "未复查"}`);
  return r.ok ? 0 : 1;
}

function cmdView(flags) {
  const dir = projectDir(flags);
  const light2 = flags.live ? "full" : (flags.cheap ? "cheap" : "cheap");
  if (flags.detail) {
    console.log(renderDetail(dir, flags.detail, { light2 }));
    return 0;
  }
  console.log(render(dir, { light2, task: flags.task ?? null }));
  return 0;
}

function cmdHealth(flags) {
  console.log(healthLine(projectDir(flags)));
  return 0;
}

function cmdGateInfo(flags) {
  const dir = projectDir(flags);
  const t = workingTreeHash(dir);
  emit({ workingTree: t, head: head(dir), baseline: store.baseline(dir) });
  return 0;
}

// ------------------------------------------------------------------ main

const HELP = `bg —— git 原生的节点门禁

  init                              取基线
  check   --file c.json             只检查门禁够不够格(不写入)
  declare --file c.json [--as-user] 声明/改写一个节点
  accept  <id> [--timeout ms]       跑完整门禁;全过则点亮第一盏灯
  assert  <id> [--cheap]            门禁现在过不过(默认全跑)
  retract <id> [--reason ...]       作废(追加一条,不改写历史)
  view    [--live] [--detail <id>]  看树(两盏灯)
  health                            心跳一行
  treeinfo                          当前工作区树哈希 / 基线

全局: --project <目录>
`;

function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const cmd = positional.shift();

  switch (cmd) {
    case "init": return cmdInit(flags);
    case "check": return cmdCheck(flags);
    case "declare": return cmdDeclare(flags);
    case "accept": return cmdAccept(positional, flags);
    case "assert": return cmdAssert(positional, flags);
    case "retract": return cmdRetract(positional, flags);
    case "view": return cmdView(flags);
    case "health": return cmdHealth(flags);
    case "treeinfo": return cmdGateInfo(flags);
    case "vacuity": {
      const dir = projectDir(flags);
      const { ok, contract, error } = contractFrom({ flags });
      if (!ok) { console.log(error); return 2; }
      emit(checkVacuity(dir, normalize(contract)));
      return 0;
    }
    default:
      console.log(HELP);
      return cmd ? 2 : 0;
  }
}

process.exit(main());
