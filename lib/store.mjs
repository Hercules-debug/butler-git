/**
 * store.mjs —— 状态:图、账本。
 *
 *     <项目>/.bg/
 *       nodes.json      图(**权威**:节点的当前状态在这里)
 *       ledger.jsonl    账本 —— **追加式,不改写**
 *
 * ## 为什么图放在 .bg/ 而不是"从 commit trailer 读"
 *
 * 按 DESIGN.md,绿是**对一个 commit 的事实**,所以做完的节点有 commit 为证。
 * 但"当前状态"仍然需要一处可写的地方:todo 节点还没 commit,放弃记录
 * 也没有 commit。
 *
 * 定下来的分工:
 *
 *     图(.bg/)      当前状态 —— 权威,读得快,可写
 *     commit        做成的证据 —— 不可变,可重放,带 verified-tree 防篡改
 *
 * 两者对不上时(改了 .bg/ 里的 state、或者 amend 了 commit),
 * `node_recheck` 会把这件事报出来 —— 见 lib/recheck.mjs。
 *
 * ## 账本为什么必须是追加式
 *
 * "通过过"是**历史事实**。历史要能被引用,前提是它不能被改写。
 * 一旦允许覆盖,你看到的绿就可能是"改过的绿",而没有任何痕迹说明它改过。
 *
 * 所以:
 *   - 声明 / 改写节点 -> **追加**一条,带上改前的门禁
 *   - 达成             -> **追加**一条,带上证据(树 / P / 时间)
 *   - 放弃             -> **追加**一条
 *   - 没有任何一条操作会动已有的行
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync,
  openSync, closeSync, statSync, rmSync,
} from "node:fs";
import { join } from "node:path";

export const BG_DIR = ".bg";

export const paths = (dir) => ({
  root: join(dir, BG_DIR),
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

/**
 * 原子写:先写临时文件再改名 —— 避免半截文件。
 *
 * **临时文件名必须唯一。** 原来写的是固定的 `${file}.tmp`,于是两个进程
 * 并行时抢同一个临时文件:一个先 rename 走了,另一个的 rename 就 ENOENT
 * **直接崩掉**(实测:A 抛 `ENOENT: rename '.bg/nodes.json.tmp'`)。
 * 用 pid + 随机数区分。
 */
function writeJson(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, file);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* 清不掉就算了 */ }
    throw e;
  }
}

// ------------------------------------------------------- 并行:写锁

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => Atomics.wait(SLEEP_BUF, 0, 0, ms);

/**
 * `.bg/` 上的**排它锁**。做"读-改-写"时必须拿着它。
 *
 * ## 为什么必须有
 *
 * `putNode` 是**读-改-写**:读出整个 nodes.json,改一个节点,写回去。
 * 两个 subagent 并行时,两边都读到同一份旧内容,后写的把先写的**整个覆盖掉** ——
 * 实测:20 轮并行 declare(每轮 2 个,期望 40 个节点),**只活下来 20 个**。
 *
 * 这正是这个项目最反对的失败:**安静地丢掉东西。**
 *
 * ## 用 `wx` 排它创建当互斥量
 *
 * 零依赖,跨进程有效。拿不到就重试;锁太久(持有者崩了)就**抢过来** ——
 * 否则一次崩溃会把整个项目永久锁死。
 */
export function withLock(dir, fn) {
  const p = ensure(dir);
  const lock = `${p.root}/.lock`;
  const STALE_MS = 10_000;
  const deadline = Date.now() + 10_000;

  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      try {
        const out = fn();
        try { rmSync(lock, { force: true }); } catch { /* 已经没了 */ }
        return out;
      } catch (e) {
        try { rmSync(lock, { force: true }); } catch { /* 已经没了 */ }
        throw e;
      }
    } catch (e) {
      if (e.code !== "EEXIST") throw e;

      // 持有者崩了?锁文件太老就抢过来。
      try {
        const st = statSync(lock);
        if (Date.now() - st.mtimeMs > STALE_MS) {
          rmSync(lock, { force: true });
          continue;
        }
      } catch { /* 锁刚被释放,下一轮就能拿到 */ }

      if (Date.now() > deadline) {
        throw new Error(`拿不到 ${lock}(等 10 秒)—— 有别的进程在写图,或者锁没被清掉`);
      }
      sleepSync(5 + Math.floor(Math.random() * 15));
    }
  }
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

export function rootNode(dir) {
  return allNodes(dir).find((n) => n.parent === null || n.parent === undefined) ?? null;
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

// ------------------------------------------------------------------ 放弃

/**
 * 被**放弃**的节点(BUG-7)。
 *
 * 没有这个原语时,放弃掉一件事之后,当初为它声明的节点既不能被删、
 * 也不该被假装达成,只能**留在图里一直待办** ——
 * 于是图看起来像"还在做这件事",而事实不是。
 *
 * 顺序规则:后来的 `plan` 重新声明会清掉放弃标记 —— 那是新的意图。
 */
export function droppedSet(dir) {
  const dropped = new Set();
  for (const e of readLedger(dir)) {
    if (!e.node) continue;
    if (e.type === "drop") dropped.add(e.node);
    else if (e.type === "plan") dropped.delete(e.node);   // 重新声明 = 复活
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
