/**
 * serve.mjs —— `bg serve`:一个**前台**的本地查看器。
 *
 * ## 为什么是前台阻塞,不是后台服务
 *
 * 常驻进程最容易出的问题不是功能,是**生命周期**:
 * 忘了关、起了两个、崩了没人知道。所以这里刻意**不做**
 * daemon / pid 文件 / start-stop 那套,而是:
 *
 *     它占据你的终端 —— 你**看得见**它活着
 *     Ctrl+C 或关窗口 —— 进程就没了,不留残余
 *     不可能起两个    —— 第二个会撞端口,直接报错退出
 *
 * 它的生命周期严格等于那个终端窗口。**看不见的服务才是问题,
 * 占一个窗口换来"我知道它在"是划算的。**
 *
 * ## 为什么不做守护/自动重启
 *
 * 崩了就退出,堆栈打在终端上 —— 你立刻知道。
 * 静默重启会**掩盖真问题**,而这整个工具的前提是「不隐瞒」。
 *
 * ## 只读
 *
 * 每次请求**现读现算,不缓存** —— 所以你 `bg commit` 之后刷新就能看到。
 * 读不碰 `.bg/.lock`(那是写路径的排它锁);万一撞上 commit 正在写,
 * 最多读到稍旧的快照,不会损坏数据。
 */

import { createServer } from "node:http";
import { createHash } from "node:crypto";

import { graphData, mermaidHtml, toMermaid } from "./mermaid.mjs";
import { workingTreeHash } from "./git.mjs";

/** 默认端口。只监听 **127.0.0.1**,不对外暴露。 */
export const DEFAULT_PORT = 8731;

/**
 * 自刷新的一小段 JS。
 *
 * ## 为什么要整页重载,而不是替换 innerHTML
 *
 * 原来这里是 `box.innerHTML = await r.text()`。
 * **换成 mermaid 之后这条路废了**:mermaid 渲染出的是 `id="g0"` 的 SVG,
 * 每 2 秒换一次 innerHTML 会不断插入**同 id 的新 SVG**,
 * 而且我们还得手动再调一次 `mermaid.render` —— 竞态很难对。
 *
 * 更简单也更诚实的做法:**图变了就整页刷新**。
 * 代价是每 2 秒闪一下?没有 —— 只有 `/api/rev` 报的版本**真的变了**
 * 才刷新。没变就什么都不做,页面是安静的。
 *
 * 断线时说"已断开",不假装数据还是新的 —— stale 数据比断线更危险。
 */
const LIVE_JS = `
const st = document.getElementById('live');
let rev = null;
async function tick() {
  try {
    const r = await fetch('/api/rev', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const cur = await r.text();
    st.className = 'live';
    st.innerHTML = '<b>● 实时</b> · ' + new Date().toLocaleTimeString('zh-CN');
    if (rev === null) { rev = cur; return; }
    if (cur !== rev) { location.reload(); }   // 图变了才刷新
  } catch (e) {
    st.className = 'live off';
    st.innerHTML = '<b>● 已断开</b> —— 服务停了(回到终端看一眼)';
  }
}
tick();
setInterval(tick, 2000);
`;

/** 页面外壳。图由 mermaid 渲染,和静态版**同一套渲染路径**。 */
function page(dir) {
  // ⚠ **`treeY` 不能漏。** 它是"工作区改没改"的信号,少了它
  // `displayState` 判不出"进行中" —— 所有待办节点都会显示成灰色,
  // **点了工作区也不会变橙**。(实测:`bg html` 传了,这里漏了,
  // 于是实时查看器里永远是 done/todo 两色,人以为没有进行中的活。)
  //
  // 静态版(`html.mjs` 的 renderHtml)传的是同一个值,两边保持一致 ——
  // 这正是 `test/plugin.mjs` 那条"逻辑只有一份"守卫要防的事。
  return mermaidHtml(graphData(dir), {
    title: `节点图(实时)· ${String(dir).split("/").pop()}`,
    treeY: workingTreeHash(dir),
  });
}

/**
 * 起服务。**阻塞,直到 Ctrl+C。**
 *
 * 返回 Promise,resolve 时带 `{ port, url }`;端口占用则 reject,
 * 由调用方决定怎么报(不要在这里静默换端口 —— 那会让人连到错的进程)。
 */
export function serve(dir, { port = DEFAULT_PORT, host = "127.0.0.1" } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = String(req.url ?? "/");

      // **只服务本机,且只服务这两个路由。** 别的路径一律 404。
      if (url === "/" || url === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page(dir));
        return;
      }
      // 前端用这个判断"图变了没有" —— **变没变由这里说了算**。
      //
      // 不能靠 mtime 或者随机数(那会让页面每 2 秒白刷一次)。
      // 用 mermaid 源文本做指纹:节点一变它就变,不变就一模一样。
      if (url === "/api/rev") {
        try {
          const g = graphData(dir);
          const rev = toMermaid(g, { treeY: workingTreeHash(dir) });
          res.writeHead(200, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
          });
          // 不存明文图,存个短指纹就够了 —— 前端只做相等比较。
          res.end(createHash("sha1").update(rev).digest("hex").slice(0, 16));
        } catch (e) {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end(`渲染失败:${e?.message ?? e}`);
        }
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("404");
    });

    // 端口被占 -> 明确报错,**不静默换端口**。
    server.once("error", (e) => {
      if (e?.code === "EADDRINUSE") {
        reject(new Error(
          `端口 ${port} 被占用 —— 可能是另一个 bg serve 正在跑。\n`
          + "  要么回到那个终端 Ctrl+C 停掉它,要么换端口: bg serve --port "
          + String(port + 1),
        ));
        return;
      }
      reject(e);
    });

    server.listen(port, host, () => {
      const url = `http://${host}:${port}`;
      resolve({
        port,
        url,
        stop: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
