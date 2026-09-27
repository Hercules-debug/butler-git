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

import { buildTree, treeHtml, styleCss, esc } from "./html.mjs";

/** 默认端口。只监听 **127.0.0.1**,不对外暴露。 */
export const DEFAULT_PORT = 8731;

/**
 * 自刷新的一小段 JS。
 *
 * 只有轮询 + 替换 innerHTML 两件事,**不引任何库**。
 * 轮询失败(比如服务刚被 Ctrl+C)就在页面上标"已断开",
 * 而不是假装数据还是新的 ——  stale 数据比断线更危险。
 */
const LIVE_JS = `
const box = document.getElementById('tree');
const st  = document.getElementById('live');
async function tick() {
  try {
    const r = await fetch('/api/tree', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    box.innerHTML = await r.text();
    st.className = 'live';
    st.innerHTML = '<b>● 实时</b> · ' + new Date().toLocaleTimeString('zh-CN');
  } catch (e) {
    st.className = 'live off';
    st.innerHTML = '<b>● 已断开</b> —— 服务停了(回到终端看一眼)';
  }
}
tick();
setInterval(tick, 2000);
`;

/** 页面外壳。内容由 JS 填,首次也由 JS 填 —— 只有一份渲染路径。 */
function page(dir) {
  return `<!DOCTYPE html>
<meta charset="utf-8">
<title>节点树(实时)· ${esc(String(dir).split("/").pop())}</title>
<style>${styleCss()}
</style>
<h1>节点树 · <code>${esc(dir)}</code>
  <span id="live" class="live">连接中…</span>
</h1>
<div id="tree"></div>
<div class="legend">● 绿(有 commit,已验证) &nbsp; ◐ 进行中(有工作区改动) &nbsp; ○ 待办</div>
<script>${LIVE_JS}</script>
`;
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
      if (url === "/api/tree") {
        try {
          const html = treeHtml(buildTree(dir));
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(html);
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
