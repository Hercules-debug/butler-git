/**
 * store.mjs —— 状态:基线、图、账本。
 *
 *     <项目>/.bg/
 *       baseline.json   开工时的世界(树哈希 + HEAD)
 *       nodes.json      图
 *       ledger.jsonl    账本 —— **追加式,不改写**
 *
 * ## 账本为什么必须是追加式
 *
 * "通过过"是**历史事实**。历史要能被引用,前提是它不能被改写。
 * 一旦允许覆盖,你看到的绿就可能是"改过的绿",而没有任何痕迹说明它改过。
 *
 * 所以:
 *   - 改写节点 -> **追加**一条 `改写`,带上改前改后的门禁
 *   - 验收通过 -> **追加**一条 `accept`,带上证据(门禁/树/时间)
 *   - 没有任何一条操作会动已有的行
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync,
} from "node:fs";
import { join } from "node:path";

export const BG_DIR = ".bg";

export const paths = (dir) => ({
  root: join(dir, BG_DIR),
  baseline: join(dir, BG_DIR, "baseline.json"),
  nodes: join(dir, BG_DIR, "nodes.json"),
  ledger: join(dir, BG_DIR, "ledger.jsonl"),
});

export function ensure(dir) {
  const p = paths(dir);
  if (!existsSync(p.root)) mkdirSync(p.root, { recursive: true });
  return p;
}

export const nowIso = () => new Date().toISOString();

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** 原子写:先写临时文件再改名 —— 避免半截文件。 */
function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, file);
}

// ------------------------------------------------------------------ 基线

export function baseline(dir) {
  return readJson(paths(dir).baseline, null);
}

export function saveBaseline(dir, data) {
  writeJson(ensure(dir).baseline, data);
}

// ------------------------------------------------------------------ 图

export function allNodes(dir) {
  const g = readJson(paths(dir).nodes, { nodes: {} });
  return Object.values(g.nodes ?? {});
}

export function getNode(dir, id) {
  return readJson(paths(dir).nodes, { nodes: {} }).nodes?.[id] ?? null;
}

export function putNode(dir, node) {
  const file = ensure(dir).nodes;
  const g = readJson(file, { nodes: {} });
  g.nodes ??= {};
  g.nodes[node.id] = node;
  writeJson(file, g);
  return node;
}

// ------------------------------------------------------------------ 账本

/** 追加一行。**这是账本唯一允许的写入方式。** */
export function appendLedger(dir, event) {
  appendFileSync(ensure(dir).ledger, `${JSON.stringify({ ts: nowIso(), ...event })}\n`, "utf8");
}

export function readLedger(dir) {
  const p = paths(dir).ledger;
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;   // 坏行跳过 —— 但不静默丢弃整本账
      }
    })
    .filter(Boolean);
}

// ------------------------------------------------- 第一盏灯:通过过没有

/**
 * 这个节点**通过过**吗 —— 只读账本,不看世界。
 *
 * 这是第一盏灯。它回答的是"有没有一次郑重的验收",不是"现在对不对"。
 * 所以它**永远不会被后来的改动推翻** —— 那正是"历史事实"的意思。
 */
export function acceptanceOf(dir, id) {
  let accepted = false;
  let evidence = null;
  for (const e of readLedger(dir)) {
    if (e.node !== id) continue;
    if (e.type === "accept") {
      accepted = true;
      evidence = e.evidence ?? evidence;
    }
    // 作废:记在账本里,不是删掉那条 accept —— 历史不改写
    if (e.type === "retract") {
      accepted = false;
    }
  }
  return { accepted, evidence };
}

// --------------------------------------------- 放弃:从未通过过的节点

/**
 * 被**放弃**的节点(BUG-7)。
 *
 * 原来只有 `retract`,而它只对"通过过"的节点有效(语义是"把通过过收回")。
 * 于是**一个从未通过过的节点无法从图里移除** —— 只能 `declare` 改写它,
 * 或者留在图里一直红着。后者会让图看起来像"还在做这件事",而事实不是。
 *
 * `drop` 就是"放弃一个计划"这个原语。它同样**追加**(历史不改写):
 * 账本里能读出"它曾经被声明过,后来被放弃了"。
 *
 * 顺序规则:后来的 `node`(重新声明)会清掉放弃标记 —— 那是新的意图。
 */
export function droppedSet(dir) {
  const dropped = new Set();
  for (const e of readLedger(dir)) {
    if (!e.node) continue;
    if (e.type === "drop") dropped.add(e.node);
    else if (e.type === "node") dropped.delete(e.node);   // 重新声明 = 复活
  }
  return dropped;
}

/** 这个节点是不是被放弃了(含祖先被放弃)。 */
export function isDropped(dir, id, nodesById, dropped = null) {
  const set = dropped ?? droppedSet(dir);
  let cur = id;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    if (set.has(cur)) return true;
    seen.add(cur);
    cur = nodesById?.get(cur)?.parent ?? null;
  }
  return false;
}
