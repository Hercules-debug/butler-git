/**
 * delta.mjs —— Δ(预期变化)。
 *
 * ## 它是什么
 *
 * **一个精确集合,带方向。** 不是"作用域",不是"允许改的范围"。
 *
 * 精确集合本身就同时说了两件事:
 *
 *     集合里的   必须发生
 *     集合外的   不许发生
 *
 * 所以不需要另一个 `allow`。旧模型里那两个概念是重复的,而且
 * "允许"管不住"漏做" —— Δ 能。
 *
 * ## 一次比较回答三件事
 *
 *     diff(base, result) 和 Δ 比:
 *        少了       ->  漏做
 *        多了       ->  预期外的改动(这条是旧模型完全没有的)
 *        类型不符   ->  做错方向(该删的改了、该加的删了)
 *
 * ## 它可以为空,而且空 = 没有预测
 *
 *     Δ 有值   ->  约束:实际必须**精确等于**它
 *     Δ 为空   ->  只有 P 在承重,没有任何东西防止意外改动
 *
 * 空不是"什么都没改",是"没说会改什么"。这两件事必须分得清 ——
 * 所以空 Δ 要在展示时标出来(见 view.mjs)。
 */

/** 四种方向。R 带两个路径(从 / 到)。 */
export const CODES = ["M", "A", "D", "R"];

export const CODE_TEXT = {
  M: "改了",
  A: "新增",
  D: "删除",
  R: "重命名",
};

/**
 * 从紧凑字符串解析。
 *
 * 两种形状:
 *
 *     "M:src/a.py"          普通
 *     "R:src/a.py:src/b.py" 重命名(两个路径)
 */
export function parseDelta(items) {
  if (!Array.isArray(items)) return [];
  return items.map((raw) => {
    if (typeof raw !== "string") return null;
    const first = raw.indexOf(":");
    if (first < 0) return { code: "M", path: raw };
    const code = raw.slice(0, first).toUpperCase();
    const rest = raw.slice(first + 1);
    if (code === "R") {
      // 重命名:剩下的再切一次
      const second = rest.indexOf(":");
      if (second < 0) return { code: "R", path: rest, to: rest };
      return { code: "R", path: rest.slice(0, second), to: rest.slice(second + 1) };
    }
    if (!CODES.includes(code)) return null;   // 不认识的就报错,不猜
    return { code, path: rest };
  }).filter(Boolean);
}

/** 反向:写成紧凑字符串(进 trailer)。 */
export function formatDelta(delta) {
  return (delta ?? []).map((d) => (
    d.code === "R" ? `R:${d.path}:${d.to}` : `${d.code}:${d.path}`
  ));
}

/** 改成一个比较用的键。同一条改动只该出现一次。 */
const keyOf = (d) => (d.code === "R" ? `R:${d.path}` : `${d.code}:${d.path}`);

/** 不管方向,只看"这条改动碰的是哪个路径"。 */
const pathOf = (d) => d.path;

/**
 * Δ 自己是不是自洽的。
 *
 * 同一条改动声明两次方向相反的(既 M 又 D)是自相矛盾 ——
 * 它永远不可能被满足,而且报错信息会是"漏做",把模型引到错的地方。
 */
export function selfCheck(delta) {
  const problems = [];
  const seen = new Map();

  for (const d of delta ?? []) {
    if (!CODES.includes(d.code)) {
      problems.push(`Δ 里有不认识的方向 "${d.code}"(只认 ${CODES.join(" / ")})`);
      continue;
    }
    if (!d.path) {
      problems.push(`Δ 里有一条没有路径`);
      continue;
    }
    if (d.code === "R" && !d.to) {
      problems.push(`Δ 里的重命名 ${d.path} 没说改成什么(R 要两个路径:"R:旧:新")`);
      continue;
    }
    const k = keyOf(d);
    if (seen.has(k)) {
      problems.push(`Δ 里 ${k} 声明了两次`);
      continue;
    }
    // 同一路径两种方向:只有真的矛盾才报(比如 M 和 D)
    const prev = [...seen.values()].find((x) => pathOf(x) === pathOf(d));
    if (prev && prev.code !== d.code) {
      const both = new Set([prev.code, d.code]);
      if (both.has("D") || both.has("A")) {
        problems.push(
          `Δ 里 ${pathOf(d)} 同时被声明成 ${prev.code} 和 ${d.code} —— `
          + "两个方向不可能都发生",
        );
      }
    }
    seen.set(k, d);
  }

  return problems;
}

/**
 * **核心**:实际的 diff 和 Δ 比,差在哪。
 *
 * 返回三条列表,每条都带"要求" —— 模型能照着修,不用猜。
 *
 * ## 为什么"多了"是最重要的一条
 *
 * 漏做模型自己会发现(它没做)。**预期外的改动它看不见** ——
 * 顺手改了个 util.py、验证程序留下个临时文件,它自己不知道那是越界。
 * 这条输出就是"防止预期外的改动"落地的地方。
 */
export function compare(declared, actual) {
  const want = declared ?? [];
  const got = actual ?? [];

  // 空 Δ = 没有预测,没有可比的东西。诚实地说"没预测",不是"通过"。
  if (want.length === 0) {
    return {
      ok: true,
      skipped: true,
      missing: [],
      extra: got.map((d) => ({
        ...d,
        demand: "Δ 是空的(没预测会改什么)—— 这些改动**没有被任何东西约束**。"
          + "不想要它们就把它们去掉;要就写进 Δ。",
      })),
      mismatch: [],
    };
  }

  const wantByKey = new Map(want.map((d) => [keyOf(d), d]));
  const wantByPath = new Map(want.map((d) => [pathOf(d), d]));

  const missing = [];
  const extra = [];
  const mismatch = [];
  const matchedKeys = new Set();

  for (const a of got) {
    // git 会报 U(未合并)。它不是一个方向 —— 合并没做完。
    if (a.code === "U") {
      extra.push({
        ...a,
        demand: `${a.path} 还没解决冲突。先解决冲突再提交。`,
      });
      continue;
    }

    const hit = wantByKey.get(keyOf(a));
    if (hit) {
      matchedKeys.add(keyOf(a));
      continue;
    }

    // 路径声明过,但方向不对
    const byPath = wantByPath.get(pathOf(a));
    if (byPath) {
      mismatch.push({
        path: a.path,
        declared: byPath.code,
        actual: a.code,
        demand: `${a.path}:声明的是 ${byPath.code}(${CODE_TEXT[byPath.code]}),`
          + `实际是 ${a.code}(${CODE_TEXT[a.code] ?? a.code}) —— 做错方向了。`
          + (byPath.code === "D" && a.code === "M"
            ? " 声明了删除,结果只是改了内容 —— 内容还在。" : ""),
      });
      continue;
    }

    // 完全没声明 —— 预期外的改动
    extra.push({
      ...a,
      demand: `${a.path} 不在 Δ 里 —— **预期外的改动**。`
        + "它是这一步的一部分就把它加进 Δ;不是就把它去掉。",
    });
  }

  for (const d of want) {
    if (!matchedKeys.has(keyOf(d)) && !mismatch.some((m) => m.path === pathOf(d))) {
      missing.push({
        ...d,
        demand: `${pathOf(d)} 声明了 ${d.code}(${CODE_TEXT[d.code]}),但没发生 —— 漏做了。`,
      });
    }
  }

  return {
    ok: missing.length === 0 && extra.length === 0 && mismatch.length === 0,
    skipped: false,
    missing,
    extra,
    mismatch,
  };
}
