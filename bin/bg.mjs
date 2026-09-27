#!/usr/bin/env node
/**
 * bg —— butler-git 的命令行。**给人用的那一半。**
 *
 * 模型走插件(plugin/index.js),人走这里。两边调的是**同一套 lib** ——
 * 所以不存在"两个前端漂移"的问题(上一个实现正是死在这上面:
 * Python 核心和 JS 插件各写一遍,改了一边另一边静默落后)。
 *
 * ## 模型的四个工具
 *
 *   bg plan     声明一个任务(base / expect / Δ? / P)
 *   bg status   相对 base 改了什么;和 Δ 比差在哪(便宜,不跑 P)
 *   bg commit   提交即门禁:Δ + P + 根 P,过了才产生版本
 *   bg abandon  把一个声明了但没做的任务从图里移除
 *
 * ## 人的面(不占模型的工具位)
 *
 *   bg tree            看整棵树(灯 + P 原文 + 弱 P 标记 + 图外的提交)
 *   bg recheck         对当前 commit 复查各历史节点 —— 诊断,不是灯
 *   bg health          心跳一行
 *   bg log             从 commit trailer 读出来的历史
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

import { head, isRepo } from "../lib/git.mjs";
import { plan, commit, abandon, normalize } from "../lib/nodes.mjs";
import { parseDelta } from "../lib/delta.mjs";
import {
  renderTree, renderStatus, renderLog, healthLine,
} from "../lib/view.mjs";
import { recheck, crossCheck } from "../lib/recheck.mjs";
import { renderHtml } from "../lib/html.mjs";
import { serve, DEFAULT_PORT } from "../lib/serve.mjs";

const REPEATABLE = new Set(["delta"]);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const key = a.slice(2);

    // **可重复的 flag 要一直吃到下一个 `--` 为止。**
    //
    // 原来这里只吃**一个**值:
    //     --delta "M:a.py" "A:b.py" "D:c.py"
    //   -> 只有 "M:a.py" 进了 delta,后两个掉到第 42 行被当成位置参数,
    //      **静默丢弃**。人以为声明了三条 Δ,工具只记了一条 ——
    //      于是"预期外改动"会报出一堆其实声明过的文件。
    //      最坏的是它**不报错**:丢得无声无息。
    //
    // 所以两种写法都得支持:
    //     --delta a --delta b        (重复 flag)
    //     --delta a b                (空格分隔)
    // 两者可以混用,结果都是 [a, b]。
    if (REPEATABLE.has(key)) {
      const vals = Array.isArray(flags[key])
        ? flags[key]
        : (flags[key] === undefined || flags[key] === true ? [] : [flags[key]]);
      let j = i + 1;
      while (j < argv.length && !String(argv[j]).startsWith("--")) {
        vals.push(argv[j]);
        j += 1;
      }
      if (!vals.length) {
        flags[key] = true;      // --delta 后面没给值:保持原来的布尔语义
      } else {
        flags[key] = vals;
        i = j - 1;              // 让循环末尾的 i += 1 落在下一个未读参数上
      }
      continue;
    }

    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    i += 1;
    flags[key] = next;
  }
  return { positional, flags };
}

const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/**
 * 这次调用是谁 —— **凭证**,不是身份。
 *
 *     --as-user            人。只有人能创建根节点、改人定的节点
 *     --token <凭证>       持有某个节点凭证的 agent
 *
 * 不给 token 就是"没有凭证" —— 那所有需要凭证的事都做不了,
 * 但错误信息会说明**需要谁的**凭证(不是只说"不行")。
 *
 * **CLI 是人的面**,所以 `--as-user` 在这里存在。插件里**没有**这个开关 ——
 * 模型不能自己授权自己(见 plugin/index.js)。
 */
function actorOf(flags) {
  if (flags["as-user"] === true) return { kind: "user" };
  const t = flags.token;
  if (typeof t === "string" && t) return { kind: "holder", token: t };
  return null;
}

function die(msg, code = 2) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

function out(lines) {
  process.stdout.write(`${lines.join("\n")}\n`);
}

/** 输出一个结果:失败就列"要求",成功就列内容。 */
function emit(r, { okLines = [] } = {}) {
  if (!r.ok) {
    out([...okLines, ...(r.problems ?? []).map((p) => `  ${p}`)]);
    process.exit(1);
  }
  out([...(r.lines ?? okLines), ...(r.problems ?? [])]);
}

const USAGE = `
bg —— 节点是「意图」,commit 是「证据」

模型用的四个:
  bg plan     --id <id> --expect <一句话> --base <sha> --verify <命令>
              [--parent <id>] [--owner user|model]
              [--delta "M:src/a.py"]... [--delta-source at-commit]
                 Δ 可重复也可空格分隔,两种等价(可以混用):
                   --delta "M:a.py" --delta "A:b.py"
                   --delta "M:a.py" "A:b.py"
  bg status   <id>                    相对 base 改了什么;和 Δ 比差在哪(不跑 P)
  bg commit   <id> [--timeout <ms>]   提交即门禁:Δ + P + 根 P,过了才产生版本
  bg abandon  <id> [--reason ...]     把一个声明了但没做的任务从图里移除

人用的:
  bg tree                 看整棵树(灯 + P 原文 + 弱 P 标记 + 图外的提交)
  bg html  [文件]         同上,渲染成一个**单文件 HTML**(默认 .bg/tree.html)
  bg serve [--port N]     前台实时查看器(默认 127.0.0.1:8731),Ctrl+C 停
  bg recheck  [--full]    对当前 commit 复查各历史节点(诊断,不是灯)
  bg health               心跳一行
  bg log                  从 commit trailer 读出来的历史
  bg crosscheck           图和 commit 对不对得上

全局:  --dir <路径>   默认是当前目录

凭证(capability)—— 像目录权限,而且**向下包含**:
  持有 X 的凭证  ->  能改 X 的**所有后代**
  改 X 自己      ->  需要 parent(X) 的凭证   <- 这就是"向创建者提权"
  根节点         ->  没有父,只能由人签发(--as-user)

  bg plan --as-user --id root ...        人创建根节点,拿回根凭证
  bg plan --token <根凭证> --id n1 --parent root ...
  bg commit  <id> --token <凭证>
  bg abandon <id> --token <凭证>

  明文只在**创建那一刻**出现一次(上面那条 🔑),库里只存 hash。
  已达成 = 冻结,**任何凭证都改不动** —— 要变就起一个新节点。
`.trim();

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  const dir = resolve(flags.dir ?? ".");

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    out([USAGE]);
    process.exit(0);
  }

  if (cmd === "health") {
    out([healthLine(dir)]);
    return;
  }

  if (cmd === "tree") {
    emit(renderTree(dir));
    return;
  }

  if (cmd === "log") {
    emit(renderLog(dir));
    return;
  }

  // **HTML:写到文件,不打到 stdout。**
  // 打到 stdout 的话 `bg html > x.html` 能用,但管道里混着别的输出就废了;
  // 而且默认给一个确定路径,人不用记重定向。
  if (cmd === "html") {
    const dest = positional[1] ?? join(dir, ".bg", "tree.html");
    writeFileSync(dest, renderHtml(dir), "utf8");
    out([`写好了 ${dest}`, "  浏览器打开即可。它是**单文件**,不联网、不依赖任何东西。"]);
    return;
  }

  // **前台查看器。** 它占着终端 —— 所以你**看得见**它活着;
  // Ctrl+C 就停,不留后台进程。刻意不做 daemon / pid 那套。
  if (cmd === "serve") {
    const port = Number(flags.port ?? DEFAULT_PORT);
    // 注意:`main()` 不是 async(改它会影响上面所有命令),所以用
    // Promise 的 then/catch,而不是 await。
    serve(dir, { port }).then((s) => {
      out([
        `看着 ${dir}`,
        `  ${s.url}`,
        "",
        "  浏览器打开上面那个地址。**页面每 2 秒自己更新一次**,不用按 F5。",
        "  停:Ctrl+C(它只活在这个终端里,关掉就没了)。",
      ]);
      // 让 SIGINT 干净退出,不打难看的堆栈。
      process.on("SIGINT", () => { out(["", "停了。"]); process.exit(0); });
    }).catch((e) => {
      die(`bg serve 起不来:\n  ${String(e?.message ?? e).split("\n").join("\n  ")}`);
    });
    return;
  }

  if (cmd === "crosscheck") {
    const issues = crossCheck(dir);
    if (!issues.length) out(["图和 commit 对得上。"]);
    else {
      out(["图和 commit **对不上**:", ...issues.map((i) => `  ✗ ${i}`)]);
      process.exit(1);
    }
    return;
  }

  if (cmd === "recheck") {
    const r = recheck(dir, { mode: flags.full ? "full" : "delta" });
    out(r.lines);
    if (!r.ok) process.exit(1);
    return;
  }

  if (cmd === "status") {
    const id = positional[1];
    if (!id) die("用法: bg status <id>");
    emit(renderStatus(dir, id));
    return;
  }

  if (cmd === "abandon") {
    const id = positional[1];
    if (!id) die("用法: bg abandon <id> [--reason ...]");
    const r = abandon(dir, id, typeof flags.reason === "string" ? flags.reason : "",
      { actor: actorOf(flags) });
    if (!r.ok) die((r.problems ?? ["放弃失败"]).join("\n"));
    out([`已放弃 ${id}${typeof flags.reason === "string" ? ` (${flags.reason})` : ""} —— 它不在图里了。`]);
    return;
  }

  if (cmd === "commit") {
    const id = positional[1];
    if (!id) die("用法: bg commit <id> [--timeout <ms>]");
    const r = commit(dir, id, {
      timeout: Number(flags.timeout ?? 120_000),
      actor: actorOf(flags),
    });
    if (!r.ok) {
      out(r.problems.map((p) => `  ${p}`));
      process.exit(1);
    }
    out([
      `● ${id} 达成 —— 证据 ${String(r.result).slice(0, 8)}`,
      `  验过的树 ${String(r.tree).slice(0, 8)}(和 commit 的内容一个字节都不差)`,
      ...(r.weak_verify === true
        ? ["  ⚠ 这条 P 在基线时就通过 —— 它区分不了你做没做"] : []),
      ...(r.notes ?? []),
    ]);
    return;
  }

  if (cmd === "plan") {
    const raw = {
      id: flags.id,
      expect: flags.expect,
      base: flags.base,
      parent: flags.parent ?? null,
      owner: flags.owner ?? "model",
      delta: parseDelta(asList(flags.delta)),
      delta_source: flags["delta-source"] ?? null,
      verify: flags.verify ?? null,
    };
    const r = plan(dir, normalize(raw), { actor: actorOf(flags) });
    if (!r.ok) {
      out(r.problems.map((p) => `  ✗ ${p}`));
      process.exit(1);
    }
    const n = r.node;
    const lines = [
      `${r.rewrite ? "改写" : "声明"}了 ${n.id}`,
      `  expect  ${n.expect}`,
      `  base    ${String(n.base).slice(0, 8)}`,
      `  Δ       ${n.delta.length ? n.delta.map((d) => `${d.code} ${d.path}`).join("  ") : "(空 —— 没有任何东西防止意外改动)"}`,
      `  P       ${n.verify}`,
    ];
    // **凭证明文只出现这一次。** 之后工具里查不到它,只有你自己记着。
    if (r.token) {
      lines.push("");
      lines.push(`  🔑 凭证  ${r.token}`);
      lines.push("     **收好它 —— 它只显示这一次。**");
      lines.push(`     拿着它才能在 ${n.id} 下面建子节点、改它的后代;`);
      lines.push(`     改 ${n.id} **自己**要它父节点的凭证(向创建者提权)。`);
    }
    out(lines);
    return;
  }

  die(`不认识的命令 "${cmd}"\n\n${USAGE}`);
}

try {
  main();
} catch (e) {
  die(`bg 崩了: ${e.stack ?? e.message}`, 3);
}
