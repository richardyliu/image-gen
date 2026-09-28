# imagegen — Prompt → TikZ → SVG

输入一句话,Claude 写出 TikZ 代码,本机 LaTeX 编译,dvisvgm 转成矢量 SVG 直接内联到页面。没有图像模型,没有数据库。

## 依赖
- Node ≥ 22(开发用 24)、npm
- TeX Live(需要 `latex`、`xelatex`、`dvisvgm`,以及 tikz / pgfplots / tikz-cd / circuitikz / fontspec / xeCJK)。macOS 装 MacTeX 即可。
- Anthropic API key

## 启动
```bash
cp .env.example .env.local   # 填入 ANTHROPIC_API_KEY
npm install
npm run dev                  # http://localhost:3000
```
没有 key 时可以 `IMAGEGEN_MOCK_LLM=1 npm run dev` 跑通整条链路(用内置样例代替模型)。

## 工作流
1. `POST /api/generate`:SSE 流式返回 Claude 写的 TikZ(`status` / `delta` / `done` / `error`)。
2. `POST /api/tikz`:`{tikz, libraries, theme}` → 组装 `standalone` 文档 → `latex`(含 CJK 时 `xelatex -no-pdf`)→ `dvisvgm --no-fonts` → 清洗后返回 `{svg, width, height, engine, ms}`。
3. 编译失败时把错误摘要回传模型自动修一次;仍失败则展示错误与可编辑代码。
4. 客户端按 `code + libraries + theme` 缓存 5 分钟并预热另一主题;服务端 LRU 缓存 200 条。
5. 历史保存在 localStorage(最近 20 张)。

## 配置
见 `.env.example`。常用:`IMAGEGEN_EFFORT=low` 更快,`IMAGEGEN_FAST_MODE=1` 用 Opus 5 fast mode,`IMAGEGEN_CJK_FONT` 换中文字体(默认 Hiragino Sans GB;`PingFang SC` 在 XeTeX 下找不到)。

## 安全边界
本地工具级:`-no-shell-escape`、`openin_any=p`、`openout_any=p`、临时目录、超时 SIGKILL、并发上限、命令/宏包名单、SVG 去脚本。不是多租户沙箱,不要直接暴露到公网。

## 命令
`npm run dev` · `npm run build` · `npm run test` · `npm run typecheck` · `npm run lint` · `npm run check`
