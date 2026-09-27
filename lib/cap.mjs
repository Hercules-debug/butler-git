/**
 * cap.mjs —— 凭证(capability)。
 *
 * ## 形状:像文件目录权限,而且是**向下包含**的
 *
 *     持有 X 的凭证  ->  能改 X 的**所有后代**(不需要后代各自的凭证)
 *     改 X 自己      ->  需要 parent(X) 的凭证
 *
 * 所以凭证是"从 X 往下这一整棵子树归我",不是只管一层。
 * 父不需要记住每个子的凭证 —— 一条就够。
 *
 * ## 为什么是凭证,不是身份
 *
 * 要的是"**谁能改哪个节点**",不是"**你是谁**"。
 *
 * 工具拿得到 `exec.agent.id`,但那不该被当成认证依据:
 * 一个 subagent 报上来的身份,工具没法验证它是不是真的。
 * 拿它做权限,等于把一道门建在一个自己都核验不了的东西上。
 *
 * 凭证绕开了这个问题:**谁拿出凭证谁有权**,不问你是谁。
 * 代价是凭证会泄漏(谁拿到谁有权),所以:
 *
 *     · 库里只存 hash,不存明文 —— 泄漏了库也拿不到凭证
 *     · 明文只在**签发那一刻**出现一次(在返回值里),之后不留存
 *
 * ## 它防的是误伤,不是恶意
 *
 * 和"绕过只能发现不能禁止"是同一条线:一个 agent 想把自己那份凭证
 * 递给另一个,没有任何机制拦得住。**但递出去这件事会留在账本里。**
 * 不拦,但不隐瞒 —— 这是这套东西一贯的取舍。
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { allNodes, getNode } from "./store.mjs";

/** 凭证长度(字节)。128 bit —— 不需要人类记得住,只要撞不出来。 */
const TOKEN_BYTES = 16;

/** 新凭证。返回 { token, hash }。 */
export function mint() {
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  return { token, hash: hashOf(token) };
}

/** 凭证的 hash。库里只存这个。 */
export function hashOf(token) {
  return createHash("sha256").update(String(token ?? ""), "utf8").digest("hex");
}

/**
 * 比对凭证。**用定长安全比较**,不用 `===` ——
 * 后者会按字节短路,比较耗时能泄漏"前几位对不对"。
 * 凭证这种东西上,`===` 是个真实的(虽然小的)侧信道。
 */
export function matches(token, hash) {
  if (!token || !hash) return false;
  const a = Buffer.from(hashOf(token), "hex");
  const b = Buffer.from(String(hash), "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 改**这个节点本身**,需要谁的凭证。
 *
 *     root      ->  需要"人"(没有父,只能由人签发)
 *     owner=user  ->  需要"人"
 *     其他      ->  需要父节点的凭证
 *
 * 这就是"向创建者提权":父持有凭证,所以父能改子,子不能改自己。
 */
export function requiredAuthority(node) {
  if (!node) return "none";
  const isRoot = node.parent === null || node.parent === undefined;
  if (isRoot) return "user";
  if (node.owner === "user") return "user";
  return "parent";
}

/**
 * 这次调用能不能改 `target`。
 *
 * `actor`:
 *   { kind: "user" }                    人(--as-user,CLI 才有)
 *   { kind: "holder", token }           持有某个节点的凭证
 *
 * 规则:
 *   1. **已达成 = 冻结,任何凭证都破不了** —— 见下面那段
 *   2. 改 target 自己 -> 要"它父亲"的凭证
 *   3. 在 target 下面(新增子节点)-> 要 target **自己**的凭证
 */
export function canModify(dir, target, actor, { mode = "self" } = {}) {
  // ---- 冻结优先于一切 ----
  //
  // 冻结保护的是**历史事实**(那个 commit 真的被验过),
  // 凭证保护的是"谁能改意图"。这是两件事。
  // 让提权能破冻结,那条绿就变成可以事后修改的东西 ——
  // 而 verified-tree 的全部意义就是它不可事后修改。
  if (target?.state === "done") {
    return {
      ok: false,
      problems: [
        `节点 ${target.id} 已经**达成**过(证据 ${target.result})—— 门禁冻结,`
        + "**任何凭证都改不动它**。要变,起一个新节点(历史不改写)。",
      ],
    };
  }

  const need = mode === "child" ? "self" : requiredAuthority(target);

  // ---- 人 ----
  if (need === "user") {
    if (actor?.kind === "user") return { ok: true };
    const isRootTarget = target.parent === null || target.parent === undefined;
    return {
      ok: false,
      problems: [
        (isRootTarget
          ? `节点 ${target.id} 是**根节点** —— 改它需要**人**的凭证。`
          : `节点 ${target.id} 是**人定的**(owner=user)—— 改它需要**人**的凭证。`)
        + " agent 拿不到;要改,请人用 --as-user 跑。",
      ],
    };
  }

  // ---- 需要父节点的凭证 ----
  if (need === "parent") {
    const parent = getNode(dir, target.parent);
    if (!parent) {
      return {
        ok: false,
        problems: [`节点 ${target.id} 的父 ${target.parent} 不在图里 —— 判不了权限(**不知道**)`],
      };
    }
    if (actor?.kind === "user") return { ok: true };   // 人能改一切未冻结的
    if (holds(dir, parent, actor?.token)) return { ok: true };
    return {
      ok: false,
      problems: [
        `改 ${target.id} 需要它父节点 ${parent.id} 的凭证 —— `
        + `你拿的不是它。**向 ${parent.id} 的持有者提权**。`,
      ],
    };
  }

  // ---- 需要它自己的凭证(在它下面新增子节点时)----
  if (need === "self") {
    if (actor?.kind === "user") return { ok: true };
    if (holds(dir, target, actor?.token)) return { ok: true };
    return {
      ok: false,
      problems: [
        `在 ${target.id} 下面加东西需要 ${target.id} 自己的凭证 —— 你拿的不是它。`,
      ],
    };
  }

  return { ok: false, problems: ["判不了权限(**不知道**)"] };
}

/**
 * 这个 actor 持有 `node` 的凭证吗 —— **含向下包含**。
 *
 * "持有 X" 的语义是"X 这棵子树归我",所以:
 *
 *     直接持有 X           ->  是
 *     持有 X 的某个祖先    ->  也是(向下包含)
 *
 * 后者让父能管它下面**全部**后代,不用为每个后代单独持凭证。
 */
export function holds(dir, node, token) {
  if (!token || !node) return false;

  const byId = new Map(allNodes(dir).map((n) => [n.id, n]));

  let cur = node;
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    // 空的 cap_hash 表示"这个节点还没有凭证" —— 那是旧数据,见 MIGRATE 那段
    if (cur.cap_hash && matches(token, cur.cap_hash)) return true;
    cur = cur.parent ? byId.get(cur.parent) : null;
  }
  return false;
}

/**
 * 给一个节点装上凭证(只在**首次创建**时做)。
 *
 * 返回 { token, hash } —— 明文**只在这里出现一次**,
 * 由调用方交到创建者手上(写进工具返回值),之后库里只有 hash。
 */
export function issue() {
  return mint();
}
