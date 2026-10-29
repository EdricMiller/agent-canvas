# 画语 Canvas

一个本地单用户图片创作工作室：左侧持续对话，右侧图片画布。用户选定 Skill 后，OpenAI Agents SDK 运行主 Agent，理解需求、安排步骤、调用图片工具并直接交付，每次修改保存为新版本。

## 启动

需要 Node.js 22+。

```bash
npm install
cp .env.example .env
# 编辑 .env 中的 API 配置
npm start
```

访问 http://127.0.0.1:4320 。当前工作区的 `.env` 已配置对话和参考图理解走 ffka，图片生成与编辑走 API易（APIYI）。不要用上面的 `cp` 覆盖现有 `.env`，除非要重新配置。

### 配置

对话和参考图理解使用 `OPENAI_API_KEY`、`OPENAI_BASE_URL`，也可从 `STUDIO_CREDENTIALS_FILE` 读取。图片生成与编辑可单独配置 `IMAGE_API_KEY`、`IMAGE_BASE_URL`，例如：

```dotenv
STUDIO_CREDENTIALS_FILE=~/.config/codex-imagegen/ffka.env
IMAGE_BASE_URL=https://api.apiyi.com/v1
IMAGE_API_KEY=your-apiyi-key
AGENT_MODEL=gpt-6.1-sol
IMAGE_MODEL=gpt-image-2.5-sunburst
IMAGE_SIZE=auto
```

直接设置的 `OPENAI_API_KEY` 和 `OPENAI_BASE_URL` 优先于凭据文件。`IMAGE_API_KEY` 和 `IMAGE_BASE_URL` 必须同时设置；两项都不设置时，图片生成与编辑复用对话凭据。这样可以让两个用途使用不同中转站，也能继续使用同一个中转站。

凭据文件可使用 `export OPENAI_API_KEY=...` / `export OPENAI_BASE_URL=...`。程序只读取这两个变量，不执行文件。`.env`、运行数据和生成图片均被 `.gitignore` 排除。配置接口不返回 API Key，密钥不写入会话记录或 SDK tracing。

`STUDIO_MODE=auto` 在没有 Key 时使用演示模式；`demo` 强制演示；`live` 要求存在 Key。演示模式只绘制明确标注的本地示意图，不进行 AI 理解或真实编辑。真实模式不能把演示图片当作编辑源。

模型必须在对应的账号/接口商可用。`IMAGE_SIZE=auto` 时由 GPT Image 根据提示词自动选择生成尺寸；也可设置为符合接口约束的 `WIDTHxHEIGHT`。对话接口支持 Responses API 或 Chat Completions API，需支持函数调用，理解参考图还需要图片输入；生图接口需要兼容 Images API（生成、multipart 编辑、base64 返回，以及当前的 size、quality、output_format 参数）。应用不会在接口失败后悄悄切换到演示模式。

### 模型调试与适配器

顶部滑杆按钮和侧栏「模型调试」入口打开调试面板，分别管理三层配置：

- **中转站**：名称、API 基础地址、密钥和接口适配器。目前提供 `openai-responses` 与 `openai-chat-completions`。兼容这两种协议的站点直接添加即可。
- **模型库**：模型属于一个中转站，填写该站点实际支持的模型 ID，并指定「对话」或「生图」用途。可手动填写，也可点击「读取列表」请求该站点的 `/models`；列表不保证模型具备相应用途的能力。
- **调用路由**：分别选择对话和生图的「中转站 + 模型」。对话路由负责需求理解、多轮沟通、参考图理解与工具调用，生图路由也用于编辑。保存后供后续任务使用，无需重启；有任务执行时禁止修改，避免一轮任务混用配置。

新站点先在「中转站」保存，再在「模型库」登记模型，最后在「调用路由」选择。已有站点增加模型只需后两步。编辑密钥留空保留原值；更换接口地址必须重新输入密钥。

首次从 `.env` / 凭据文件初始化。面板保存后，完整配置写入本机 `.data/model-settings.json`（权限 `0600`），启动时优先读取该文件；此后修改环境变量中的模型默认值不会覆盖已保存的选择。密钥只由后端保管，面板不回填已有密钥。演示模式仍不发出模型请求；配置好密钥后重启服务，使用 `STUDIO_MODE=auto` 或 `live` 启用真实调用。

非兼容协议在 `server/adapters.js` 注册新适配器，实现统一契约：`createClient`、`modelProvider`（供 Agents SDK 使用）、`generate`、`edit`、`listModels`。图片接口返回 base64 图片；请求选项中的 AbortSignal 应继续传给上游。业务工具仅调用这个契约，`server/model-settings.js` 负责站点、模型、路由校验与持久化，无需为每个中转站复制业务逻辑。

## 使用

1. 新建创作默认选择「商品推广设计」；可切换到「杂志海报」「水彩绘本」等技能，也可选择自由创作。
2. 描述图片，或上传 / 拖入 / 粘贴 PNG、JPEG、WebP；最多 10 MB、2500 万像素。
3. 助手展示工作步骤，调用工具生成图片并直接交付，不再发起独立的图片检查。
4. 继续对话调整当前图片。选中任意历史版本后发消息，可从它创建分支。
5. 输入框上方的 × 取消选中图片，保留会话和历史版本。顶部「新建创作」创建独立会话。
6. 通过历史会话继续工作；图片可缩放查看、下载。刷新页面会恢复会话和正在执行的任务。

## 商品推广设计

上传商品实拍并描述使用场景、推广目标和想要的画面。商品 Skill 提供设计方法、参考与商品真实性要求，Agent 根据本轮需求决定主题、场景、构图、字体、图文关系和提示词。它不按商品类别、推广用途分配固定风格，也不要求每张图都有标题或固定数量的卖点。用户可以要求完整宣传海报、商品主图、场景种草图，或其他具体画面。

Agent 先判断画面需要传达什么，再判断文字是否承担必要任务。有无文案由本轮目标决定，内部主题不自动变成上图标题。用户提出“单调、换个感觉”等整体反馈时，会重新考虑视觉焦点、构图、光影、色彩与图文关系；明确要求局部修改时则尊重修改范围。商品本身与用户已确认的规范持续有效，上一轮由 Agent 自行选择的风格只作为参考。历史方案供 Agent 理解上下文；图片接口接收 Agent 组织的本轮完整设计和商品资料，不再自动附加历史标题与视觉说明。

Agent 可按需通过 `save_product_brief` 记录受众、目标、实际文案、视觉方向和商品资料，这些记录用于延续上下文，不是生成前必须填满的表单。商品资料区分用户提供、视觉观察与待确认；品牌、材质、工艺、价格、折扣和功效须有依据，缺失信息留空。新上传商品会清除上个商品的资料与方案；通过输入框上方的 × 取消选中图片后，可不依赖当前图片创作。

生成和修改统一使用 `render_image`，由图片模型完成画面和需要的文字。项目不提供固定商品排版器、制作模式切换或独立改字接口。界面不要求选择尺寸，由 Agent 根据用途和画面描述安排画幅；用户有特定比例时直接在对话中说明，最终尺寸以图片接口返回为准。图片没有独立文字图层，改字也属于图片编辑，可能产生模型费用。

默认每轮只生成一张，生成后直接交付并停止，不自动验图或返工。需要修改时发送新消息；明确写出「生成两张」等数量要求时才增加本轮数量，仍受配置上限约束。失败生图尝试也占用本轮次数，Agent 的计划和剩余额度不能自行增加次数。

商品原图与生成版本分开保存。连续修改以最初的实拍作为图片接口的编辑输入，同时保留当前设计的父版本关系；Agent 可参考当前设计安排需要延续的画面。每版保存独立方案，切换版本会恢复对应记录。生成后可通过「原图对照」并排查看，再通过对话提出修改。生成式编辑仍可能改变商品细节和背景，不能保证像素一致。

每轮回复下方记录请求的对话/图片模型、耗时，以及规划对话和图片生成/编辑实际返回的 token 用量。第三方接口遗漏的字段保持未知，已知小计会标注记录不完整。当前未配置费率，估算费用与实际扣费不混算；实际人民币扣费需以接口商账单为准。

默认 Skill 的 ID 和 `metadata.workflow` 为 `product-promotion`，入口和按需读取的资料位于 `skills/product-promotion/`。本次直接使用新流程，不提供旧技能 ID、旧字段或专用排版接口的兼容处理。磁盘上的历史图片与会话文件保留。

## 接入自己的 Skills

完整技能目录：

```text
my-skills/
  brand-poster/
    SKILL.md
    references/
      brand.md
```

设置 `SKILLS_DIR=/absolute/path/to/my-skills`，重启后会在技能库出现。也可直接放入项目的 `skills/` 目录。前端「导入技能」只导入单个 `SKILL.md`，配套参考资料请使用目录方式。

```markdown
---
name: 我的品牌海报
description: 根据品牌规范创建和调整海报
---
先读取 references/brand.md。
使用 update_plan 公布简短工作步骤。
通过 render_image 生成或编辑图片，完成后直接交付，等待用户后续修改请求。
```

支持的工具：

| 工具 | 行为 |
| --- | --- |
| `update_plan` | 展示行动清单，不输出内部推理 |
| `read_skill_reference` | 读取当前 Skill 文件列表中的文本资料，限制在技能目录内 |
| `render_image` | 调用生成/编辑 API，输出新版本，保留父版本关系 |
| `save_product_brief` | 仅在商品流程启用，记录结构化推广方案、实际文案和注明来源的商品资料 |
| `validate_menu_content` | 校验菜单分类、菜名、价格格式、重复项和缺失信息 |
| `render_menu_layout` | 用确定性 SVG/PNG 排版绘制菜名和价格，避免图片模型写错文字 |

菜单设计 Skill 会优先使用后两个工具。币种可以单独放在 `currency` 字段中，排版器会自动补到未带符号的价格前，例如 `currency: ¥` 与 `price: 18` 会显示为 `¥18`。菜单排版每轮最多生成两个版本，完成后交付图片与文字清单，等待用户核对并提出修改。

用户的选择保存在会话中，每轮加载该技能指令，记录技能 ID 和 SKILL.md 内容摘要。技能被当作创作指南，不作为系统权限来源。

当前已接入 Agents SDK 原生 `SandboxAgent + skills()`：所选 Skill 的 `SKILL.md`、`scripts/`、`references/` 和 `assets/` 会挂载到 Sandbox，Skill 可以使用 SDK 提供的 Shell / Filesystem capability。当前 `.env` 默认使用 Docker：`SANDBOX_MODE=docker`、`SANDBOX_IMAGE=python:3.12-slim`、`SANDBOX_NETWORK=none`。每次 Agent 运行由 `DockerSandboxClient` 创建隔离容器，脚本不会在宿主机直接执行；容器网络关闭，默认使用非 root 容器用户。

沙箱模式有三档：`docker` 适合社区 Skill 和带脚本的场景；`local` 只适合本机开发，脚本会以当前用户权限运行；`off` 禁用原生 Sandbox。Docker 模式需要 Docker Desktop 已启动，首次使用会拉取 `SANDBOX_IMAGE`。当前 SDK 的 Docker client 暴露的是镜像、网络和工作目录配置，CPU/内存配额还应在 Docker Desktop 或外层编排环境设置。生产环境仍应审核第三方 Skill、固定 Git commit，并为不同租户使用独立运行环境。

Skill frontmatter 现在支持 `allowed-tools`、`requires` 和 `connectors` 元数据。已知的 `Bash`、`Shell`、`Python` 或 `run_skill_script` 声明会开启受控脚本能力；Agent 只能调用 `run_skill_script`，脚本必须位于当前 Skill 的 `scripts/` 目录，并在 Docker 中以无网络、无特权、只读根文件系统、256 MB 内存、1 CPU 和 30 秒超时运行。脚本只能返回标准输出，不能访问宿主机或任意路径。脚本依赖的 Python 包或外部命令必须预装在 `SANDBOX_IMAGE` 中。MCP 和未注册的 connectors 会在技能库中显示为未接入并禁止选择。

当前已注册连接器：`openai-images`（图片生成与编辑）与 `canvas-artifacts`（版本和画布产物）。Skill 可以在 frontmatter 中声明 `connectors: [openai-images, canvas-artifacts]`；未知连接器或 MCP 声明会被拒绝选择。连接器状态可通过 `/api/connectors` 查看。

文本参考支持 `.md`、`.txt`、`.json`、`.yaml`、`.yml`、`.csv`，单文件最多 64 KB。不会读取隐藏文件、符号链接或目录之外的文件。技能摘要目前基于 `SKILL.md`，不包括参考文件的内容版本。

## 实现

- `public/`：原生 ES 模块界面，无需打包；所有界面素材本地提供。
- `server/agent.js`：Agents SDK 的 Agent/Runner，以及生成和编辑工具，通过适配器调用上游。
- `server/adapters.js`：协议适配器注册与统一调用契约，兼容 Responses / Chat Completions / Images。
- `server/model-settings.js`：中转站与模型注册、独立路由、服务端密钥保存。
- `public/debug.js`：模型调试面板与配置入口。
- `server/app.js`：本地 HTTP 服务、上传、后台任务、取消、请求去重。
- `server/store.js`：逐会话 JSON 持久化与图片版本。
- `server/skills.js`：技能扫描、导入、参考资料边界。
- `server/sandbox.js`：将所选 Skill 以 Agents SDK 原生 Skills capability 挂载到 Sandbox。
- `.data/sessions/`：会话、消息、步骤和图片元数据。
- `.data/images/`：原图和所有生成版本。

会话持久保存全部消息；每轮向模型传递最近 40 条非错误消息、当前选中图片和版本列表。执行步骤展示公开的工具事件，采用轮询更新，不流式展示模型 token。程序重启后将未完成任务标记为中断，不自动重试收费操作。

全局图片调用数量和 Agent 回合默认都不设固定上限，可通过 `MAX_IMAGES_PER_TURN` 或 `AGENT_MAX_TURNS` 设置数值上限。商品流程额外按用户本轮请求限制生图次数，默认一次，即使全局为 unlimited 也不允许自动追加。任务仍有最长 5 分钟超时和停止按钮。Skill 参考资料优先通过批量工具读取，每轮最多读取 8 份，避免大型社区 Skill 因逐个扫描 references 耗尽回合。图片接口禁用 SDK 自动重试。取消会传播 AbortSignal；已经发送给供应商的请求不保证停止执行或计费，已有图片保留。

接口错误会在会话中显示经过脱敏和截断的具体原因，并在服务端日志记录完整错误对象；API Key 等 Bearer 凭据不会写入错误提示。

这是本机单用户应用，仅绑定 `127.0.0.1`，有本地 Host、Origin 和写入令牌检查，没有登录、多租户隔离或生产部署配置。画布目前是单图预览和版本选择，不包含独立文字图层、自由排版或蒙版局部重绘。AI 编辑不能保证未指定区域像素不变。

## 验证

```bash
npm run check
npx playwright install chromium
npm run test:ui
```

可用 `PLAYWRIGHT_EXECUTABLE_PATH` 指定兼容的本地 Chromium。无头测试通过设置文本值并触发 input 事件验证输入组件；真实中文键盘输入另在内置浏览器验证。

真实接口验证需要服务已启动，并且**会产生图片和文字费用**：

```bash
LIVE_SMOKE=1 node tests/live-smoke.mjs
```

它创建一个测试会话，验证技能参考读取、生成、第二轮编辑和版本关系。普通测试使用隔离的临时目录与演示/模拟接口，不读取真实 Key，不计费。

技能库现在支持输入公开 GitHub 仓库地址导入。服务端会使用浅克隆下载、扫描仓库中的 `SKILL.md`、复制有效 Skill 到本地 `.data/skills/`，下载完成后删除临时目录。只接受 `https://github.com/org/repo`，不接受任意域名、SSH 地址或带认证信息的 URL；仓库脚本不会在导入阶段执行，后续才由 Sandbox 运行。导入前仍应审核仓库内容，生产环境建议固定 commit，而当前 UI 先支持公开仓库默认分支。
