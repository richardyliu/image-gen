# imagegen — Prompt → TikZ → SVG 生图网页应用 设计稿

日期:2026-09-27
状态:自主模式下由 Claude 拟定,**尚未经用户确认**;"假设"一节列出所有需要用户核对的决定。

## 1. 目标与理解

### 用户明确说的
- 在 `imagegen/` 下做一套**完整的** prompt 生图网页端应用。
- 目前**不需要后端、数据库**,只需要**快速出图**。
- 技术栈参照用户逆向出的参考应用:LLM 写 TikZ → 服务器 LaTeX 编译 → dvisvgm 转矢量 SVG → 直接插进页面 DOM;Next.js(App Router)+ React;`POST /api/tikz` 接收 `{tikz, libraries, theme}` 返回 `{svg}`;客户端按 `code+libraries+theme` 缓存 5 分钟并去重;错误阶段 `request → compile → convert → response`,错误码 `latex_failed / compile_timeout / conversion_failed / upstream_unavailable`;light/dark 双主题预热。

### 我的假设(需核对)
1. **"不需要后端"** = 不要独立服务、不要数据库、不要登录。Next.js 自带的 route handler 仍然要有,因为 LaTeX 必须在本机进程里跑,且 API key 不能下发到浏览器。
2. **LLM 用 Claude API**,默认模型 `claude-opus-5`(claude-api skill 的默认;用户没指定模型),通过环境变量可换。
3. **TeX 工具链用本机的 TeX Live 2025**(已验证:`latex`、`dvisvgm 3.4.3`、tikz/pgfplots/tikz-cd/circuitikz 均在)。不打包 Docker。
4. **单用户本地使用**为主;安全措施做"足够便宜的防御",不做多租户隔离。
5. "完整" = 可用的 UI + 流式进度 + 自动修复一次编译错误 + 代码可编辑重编 + 下载 SVG/PNG + 浏览器本地历史 + 双主题 + 示例 + README。

### 成功标准
- 输入一句中文/英文描述,点击生成,**首屏就能看到代码在流式生成**,流结束后 **≈1 秒内**出图(本机测得 latex+dvisvgm ≈ 0.8 s)。
- 编译失败时自动把错误回传 LLM 修一次;再失败则展示错误摘要与可编辑代码。
- 同一段代码+主题重复渲染不再请求编译(客户端 5 分钟缓存 + 服务端 LRU)。
- 切换 light/dark 无感(另一主题在后台预热)。

### 非目标
- 用户系统、持久化到数据库、多人协作、部署到 Vercel(TeX 无法在 Vercel 函数里跑)。
- 像素级图像模型(DALL·E/SD)——本项目不涉及任何图像模型。

## 2. 方案比较

| 方案 | 说明 | 结论 |
|---|---|---|
| **A. Next.js + 本机 latex/dvisvgm(推荐)** | 两个 route handler:`/api/generate`(SSE 流式产 TikZ)与 `/api/tikz`(编译)。与参考栈一致,编译 <1 s,key 留在服务端。 | **采用** |
| B. 纯静态 SPA + TikZJax(浏览器内 WASM TeX)+ 浏览器直连 Claude | 真正零服务端。但 key 暴露在浏览器、TikZJax 首次加载数 MB、库支持不全、字形质量差,且不符合参考栈。 | 否 |
| C. Next.js + 独立 TeX 编译服务(Docker) | 参考应用大概这么做(错误码里有 upstream)。对"目前不需要后端"过重。 | 否;设计上留 `TIKZ_UPSTREAM_URL` 切换点即可 |

## 3. 架构

```
浏览器 (React)                          Next.js route handlers (Node)            本机进程
──────────────                          ───────────────────────────────          ────────
PromptBar ──POST /api/generate──▶  lib/llm/generate.ts ──▶ Claude API (stream)
   ▲            ◀── SSE: status/delta/done/error ──
   │
useGeneration ──POST /api/tikz────▶  lib/tikz/compile.ts ──▶ latex ──▶ dvisvgm
   │            ◀── {svg,width,height,ms} ──          (temp dir, 沙箱 env, 超时)
   │                                   lib/tikz/cache.ts (LRU)
Canvas (inline <svg>)  CodePanel  HistoryStrip (localStorage)
renderCache.ts (5 min TTL + in-flight 去重 + 另一主题预热)
```

## 4. 组件与接口

### 4.1 `POST /api/tikz`
请求(zod 校验):
```ts
{ tikz: string;            // ≤ 60 000 字符
  libraries?: string[];    // 每项匹配 /^[a-zA-Z0-9.]+$/
  theme?: "light" | "dark" } // 默认 light
```
成功 `200`:
```ts
{ svg: string; width: number; height: number;   // pt
  ms: { compile: number; convert: number; total: number }; cached: boolean }
```
失败 `4xx/5xx`:
```ts
{ error: { stage: "request"|"compile"|"convert"|"response";
           code: "invalid_request"|"forbidden_command"|"forbidden_package"|
                 "latex_failed"|"compile_timeout"|"conversion_failed"|
                 "conversion_timeout"|"upstream_unavailable";
           message: string;
           errors?: { line: number|null; message: string }[];  // line 已换算到用户 TikZ 代码行
           log?: string } }                                    // 截断到 4 KB
```

### 4.2 `POST /api/generate`(SSE)
请求:
```ts
{ prompt: string;                      // 1–4000 字符
  theme?: "light"|"dark";
  repair?: { code: string; libraries: string[];
             errors: { line: number|null; message: string }[] } }
```
事件(`text/event-stream`,每条 `event: <name>\ndata: <json>\n\n`):
- `status` `{ phase: "thinking"|"writing" }`
- `delta` `{ text: string }`(仅 text 增量;thinking 不下发)
- `done` `{ code, libraries, model, usage: {input_tokens, output_tokens, cache_read_input_tokens}, ms }`
- `error` `{ code: "refused"|"truncated"|"rate_limited"|"auth"|"upstream"|"parse_failed"|"invalid_request"; message }`

### 4.3 `lib/tikz/document.ts` — 组装文档
- `parseTikzSource(raw) → { body, libraries, preamble[] }`:逐行扫描;抽出 `\usetikzlibrary{...}`(拆逗号)、`\usepgfplotslibrary{...}`、`\pgfplotsset{...}`、允许名单内的 `\usepackage{...}`;如含 `\documentclass`,只取 `\begin{document}…\end{document}` 内的内容,并把 `\definecolor / \tikzset / \newcommand / \pgfplotsset / \usetikzlibrary` 提到 preamble。若 body 不含 `\begin{tikzpicture}` 则自动包一层。
- `buildDocument({ body, libraries, preamble, theme }) → { tex, bodyLineOffset }`:
  ```tex
  \documentclass[dvisvgm,tikz,border=6pt]{standalone}
  \usepackage{amsmath,amssymb}
  \usetikzlibrary{<默认库 ∪ 请求库,去重排序>}
  <hoisted preamble>
  <theme block>
  \begin{document}
  <body>
  \end{document}
  ```
  默认库:`arrows.meta, calc, positioning, shapes.geometric, shapes.misc, backgrounds, fit, decorations.pathmorphing, decorations.markings, patterns, matrix, chains, angles, quotes, intersections, shadows`(已测:全部加载后 latex 仍 <1 s)。
  dark theme block:
  ```tex
  \definecolor{black}{RGB}{232,234,240}
  \definecolor{white}{RGB}{24,24,27}
  \tikzset{every picture/.append style={color=black}}
  ```
  效果:默认墨色与所有含 black/white 的混色跟随主题,显式的彩色(`blue!20`)不变。背景透明,由页面提供底色。
- `\usepackage` 允许名单:`pgfplots, tikz-cd, circuitikz, amsmath, amssymb, mathtools, bm, tikz-3dplot`;其余 → `forbidden_package`。
- 禁用命令(正则,匹配即 `forbidden_command`):`\special`、`\write`、`\openout`、`\openin`、`\read`、`\input`、`\include`、`\InputIfFileExists`、`\catcode`、`\directlua`、`\ShellEscape`。这只是廉价的第一层;真正的隔离靠 4.4 的进程环境。

### 4.4 `lib/tikz/compile.ts` — 编译
- `mkdtemp(os.tmpdir()/imagegen-)`,写 `doc.tex`。
- `latex -no-shell-escape -interaction=nonstopmode -halt-on-error -file-line-error doc.tex`,env 追加 `openin_any=p openout_any=p`(已验证可阻止读 `/etc/hosts` 与 `\write18`)。
- `dvisvgm --no-fonts --precision=3 -o doc.svg doc.dvi`。
- 超时:latex 20 s、dvisvgm 10 s(`IMAGEGEN_LATEX_TIMEOUT_MS / IMAGEGEN_DVISVGM_TIMEOUT_MS`),超时 SIGKILL,返回 `compile_timeout / conversion_timeout`。
- 并发信号量 4(`IMAGEGEN_MAX_CONCURRENCY`),防止预热与重编叠加时 fork 风暴。
- `ENOENT` 找不到二进制 → `upstream_unavailable`,message 提示安装 TeX Live / 检查 PATH。
- `finally` 删除临时目录。

### 4.5 `lib/tikz/errors.ts` — 错误摘要
解析 `-file-line-error` 输出 `./doc.tex:<n>: <msg>`,连同其后到空行的续行;`n - bodyLineOffset` 换算为用户代码行;最多 5 条;另附 `log` 尾部 4 KB。

### 4.6 `lib/tikz/sanitize.ts`
已验证 `\special{dvisvgm:raw <script>…}` 会原样注入 SVG。服务端对输出做:去掉 `<script>…</script>`、`<foreignObject>…</foreignObject>`、所有 `on*=` 属性、`href="javascript:…"`;去掉 XML 声明与注释;解析根元素 `width/height`(pt)。返回的 svg 以 `<svg` 开头,可直接 `dangerouslySetInnerHTML`。

### 4.7 `lib/tikz/cache.ts`
服务端 LRU,key = sha256(最终 tex 文本),容量 200,值为成功响应体。命中返回 `cached: true`。

### 4.8 `lib/llm/`
- `prompt.ts`:system prompt(英文,稳定文本,加 `cache_control: ephemeral`)。要点:只输出一个 ```tikz 围栏块;首行可放 `\usetikzlibrary{}`;用 `standalone`+dvisvgm 可用的写法;`font=\sffamily`;先定义坐标锚点、标签分两列对齐、`purple!20` 式混色;不写 `\documentclass`、不用 `\special`/文件 IO/外部图片;不硬编码 black/white 以适配深色主题;避免 shading(dvisvgm 对 `shade` 支持有限)。附一个精简版细胞图作为风格示例(来源:用户上一会话的 `cell2.tex` 复现)。
- `parse.ts`:`parseModelOutput(text) → { code, libraries }`:取第一个围栏块(无围栏则全文),再交给 `parseTikzSource`。
- `generate.ts`:`streamTikz({ prompt, theme, repair, signal })` 返回 async iterator 事件。用 `@anthropic-ai/sdk` 的 `client.beta.messages.stream`(需要 beta 端点是为了 `fallbacks: "default"` 与可选 fast mode):
  - `model = IMAGEGEN_MODEL ?? "claude-opus-5"`
  - `max_tokens = 16000`,`thinking: {type:"adaptive"}`(display 保持默认 omitted)
  - `output_config: { effort: IMAGEGEN_EFFORT ?? "medium" }`
  - `betas: ["server-side-fallback-2026-07-01"]`,`fallbacks: "default"`(skill 要求 opus-5 代码默认开启;`IMAGEGEN_FALLBACKS=0` 可关)
  - `IMAGEGEN_FAST_MODE=1` → 追加 beta `fast-mode-2026-02-01` 与 `speed: "fast"`(仅 Opus 5 支持,溢价 2×)
  - `stop_reason === "refusal"` → `error refused`;`max_tokens` → `error truncated`
  - 错误映射:`AuthenticationError → auth`,`RateLimitError → rate_limited`,其他 `APIError → upstream`。
- `mock.ts`:`IMAGEGEN_MOCK_LLM=1` 时用本地固定 TikZ 分片流式返回(prompt 含 `fail` 首次返回坏代码、repair 时返回修好的),用于无 key 的开发与端到端测试。

### 4.9 客户端
- `lib/client/sse.ts`:把 `fetch` 的 `ReadableStream` 解析为 `{event, data}`。
- `lib/client/renderCache.ts`:`renderTikzSvgCached({code, libraries, theme})`,Map 缓存 TTL 5 min、in-flight Promise 去重;`prewarmOtherTheme()` 成功后用 `setTimeout(…, 0)` 触发另一主题编译。
- `lib/client/history.ts`:localStorage `imagegen.history.v1`,最多 20 条 `{id, createdAt, prompt, code, libraries, theme, svg}`(svg 用作缩略图 `<img src="data:image/svg+xml,…">`,避免与主画布的 glyph id 冲突)。
- `hooks/useGeneration.ts`:状态机 `idle → generating → compiling → done | repairing → compiling → done | error`;记录各阶段耗时;`AbortController` 支持取消。
- 组件:`PromptBar`(textarea、示例 chips、⌘/Ctrl+Enter)、`Canvas`(inline SVG、空态示例、编译中保留上一张并叠加进度、错误态)、`Toolbar`(下载 SVG / PNG@2x、复制 TikZ、主题切换、适配/100%)、`CodePanel`(可折叠、可编辑、"重新编译")、`StatusBar`(Thinking · Writing(字符数)· Compiling · Rendered,各阶段 ms,模型名、token 用量)、`HistoryStrip`。
- 主题:`<html data-theme>`,CSS 变量;默认跟随 `prefers-color-scheme`,持久化 `imagegen.theme`。SVG 主题与页面主题联动。
- 样式:单个全局样式表 + CSS 变量(BEM 式类名),不引 Tailwind。

## 5. 数据流(正常路径)
1. 用户提交 prompt → `useGeneration` 置 `generating`,POST `/api/generate`。
2. 服务端流式转发 `delta`;客户端把增量拼进 CodePanel。
3. `done` 到达 → `compiling`,调用 `renderTikzSvgCached` → POST `/api/tikz`。
4. `200` → 写入 Canvas、历史、预热另一主题 → `done`。
5. `latex_failed` 且尚未修复过 → `repairing`,POST `/api/generate` 带 `repair` → 回到 3。
6. 再失败 → `error`,展示 `errors[]` 与 log,代码面板可编辑后手动重编。

## 6. 速度手段(按收益排序)
1. 流式输出:首 token 即可见,主观等待缩短。
2. `effort: medium` + adaptive thinking;需要更快可设 `low`。
3. 可选 fast mode(Opus 5,≈2.5× 输出速度)。
4. 编译 ≈0.8 s;服务端 LRU + 客户端 TTL 缓存;另一主题后台预热。
5. system prompt 前缀缓存。

## 7. 安全边界(本地工具级)
- 进程:`-no-shell-escape`、`openin_any=p`、`openout_any=p`、临时目录、超时 SIGKILL、并发上限。
- 输入:命令与包的允许/禁止名单(第一层);长度上限。
- 输出:SVG 去脚本/事件属性后再返回;主画布只挂一份 inline SVG。
- 明确不承诺:多租户隔离、抵御恶意 TeX 宏的资源耗尽以外的攻击。

## 8. 测试
- 单元(vitest,node 环境):`document.ts`(hoist、包裹、主题块、行偏移)、`parse.ts`(围栏/无围栏/多块)、`errors.ts`(行号换算)、`sanitize.ts`(script/on*/foreignObject/javascript:)、`cache.ts`(LRU 淘汰)、客户端 `renderCache.ts`(TTL、去重)、`sse.ts`(分片边界)。
- 集成:`compile.test.ts` 真跑 latex(无 latex 则 skip);校验 viewBox、元素只含 path/use/defs/g;坏代码返回 `latex_failed` 且行号正确;`\special` 被拒;超时路径用一个死循环 TikZ 验证。
- 端到端(手动脚本):`IMAGEGEN_MOCK_LLM=1 npm run dev`,curl 两条路由,并用本机 Chrome headless 截图首页。

## 9. 配置
`.env.local`(见 `.env.example`):
```
ANTHROPIC_API_KEY=
IMAGEGEN_MODEL=claude-opus-5
IMAGEGEN_EFFORT=medium          # low|medium|high|xhigh|max
IMAGEGEN_FAST_MODE=0
IMAGEGEN_FALLBACKS=1
IMAGEGEN_MOCK_LLM=0
IMAGEGEN_LATEX_TIMEOUT_MS=20000
IMAGEGEN_DVISVGM_TIMEOUT_MS=10000
IMAGEGEN_MAX_CONCURRENCY=4
```

## 10. 目录
```
imagegen/
  app/{layout.tsx,page.tsx,globals.css}
  app/api/tikz/route.ts
  app/api/generate/route.ts
  lib/tikz/{document,compile,errors,sanitize,cache,types}.ts
  lib/llm/{prompt,parse,generate,mock,types}.ts
  lib/client/{sse,renderCache,history}.ts
  hooks/useGeneration.ts
  components/{PromptBar,Canvas,Toolbar,CodePanel,StatusBar,HistoryStrip}.tsx (+ .module.css)
  tests/**.test.ts
  docs/superpowers/{specs,plans}/
  .env.example  README.md  package.json  tsconfig.json  next.config.ts  vitest.config.ts
```

## 11. 已验证的事实(本机,2026-09-27)
- `\documentclass[dvisvgm,tikz,border=…]{standalone}` + `latex` + `dvisvgm --no-fonts`:0.82 s,输出 viewBox 形如 `-68.0 -68.0 291.3 156.3`,元素仅 `path/use/defs/g`,字形 id `g0-65`,与参考应用指纹一致。
- 不加 `dvisvgm` 驱动选项时 PGF 走 PostScript special,dvisvgm 未链接 libgs,图形全部丢失——这是必须的选项。
- `openin_any=p` 阻止 `\input{/etc/hosts}`;`-no-shell-escape` 阻止 `\write18`。
- `\special{dvisvgm:raw <script>}` 会注入 SVG → 需要 sanitizer。
- `@anthropic-ai/sdk@0.128.0` 类型含 `fallbacks: Array|'default'`、`speed`、`output_config.effort`、beta 头 `server-side-fallback-2026-07-01` 与 `fast-mode-2026-02-01`。
