# 画语 Canvas

一个运行在本机的单用户图片创作工作室。左侧对话，右侧查看图片和历史版本；Agent 读取所选 Skill，理解需求、安排步骤、调用工具，完成后交付图片。

内置「商品推广设计」「杂志海报」「菜单设计」「水彩绘本」四个 Skill，也支持自由创作和导入自己的 Skills。对话与图片模型可以分别接入不同服务商。

## 快速启动

需要 Node.js 22+ 和 npm。在项目目录执行：

```bash
npm install
cp -n .env.example .env
npm start
```

打开 `http://127.0.0.1:4320`。`cp -n` 保留已有 `.env`；首次使用时，示例配置中的 Key 留空即可进入演示模式，不调用真实 API。使用 Docker 沙箱时还需要启动 Docker，详见下方「沙箱与脚本」。

开发时可使用 `npm run dev`，服务端文件修改后自动重启。

## 使用流程

1. 新建创作，默认选择「商品推广设计」。点击当前技能可切换 Skill 或选择自由创作。
2. 描述用途和想要的画面，需要参考实物时上传、拖入或粘贴图片。支持 PNG、JPEG、WebP，单张最大 10 MB、2500 万像素。
3. 助手展示执行步骤，调用工具完成图片；新结果保存为独立版本。
4. 继续对话修改。选中任意历史版本后发消息，可以从该版本继续创作。
5. 输入框上方的 **×** 取消当前图片选择，保留对话和版本；顶部「新建创作」创建独立会话。
6. 在画布缩放查看、导出当前图片，或打开历史会话继续工作。刷新页面可以恢复会话，并查看仍在执行的任务。

只想讨论方案时，可以直接说明「先讨论，不生成」。运行中的任务可点击「停止」；已返回的图片会保留，已提交给服务商的请求不保证停止执行或计费。服务重启后，未完成任务标记为中断，不自动重试。

## 商品推广设计

### Skill 提供方法，Agent 决定画面

上传商品实拍，说明推广用途、想传达的感觉和具体要求即可。Skill 提供设计方法、参考资料和商品真实性要求；Agent 根据本轮需求决定主题、人物或场景、构图、光影、色彩、图文关系及画幅。

商品推广图可以是完整宣传海报、无新增文字的商品展示图、上手佩戴广告或生活场景图。是否添加文字取决于传播目的，内部创意主题不会自动变成画面标题，也没有固定的场景、配色、标题位置或卖点数量。

例如：

```text
基于这件商品做一张社交平台推广图，用画面体现轻盈、自然的感觉。

做成女性上手佩戴广告，用姿态和光影表现高贵感，画面不要新增文字。

保留这一版的场景、光线和排版，只把主标题改成「今日好心情」。
```

提出「单调、换个感觉、重新设计」等整体反馈时，Agent 应重新考虑视觉表达；明确要求局部修改时，则保留指定内容。商品依据和用户确认过的规范持续有效，Agent 上一轮自行选择的风格只作为参考。

### 商品依据与连续修改

- 商品资料区分「用户提供」「视觉观察」「待确认」。品牌、材质、工艺、价格、折扣和功效需要依据，缺失信息不编造。
- 有实拍时，连续修改始终以最初的商品原图作为图片接口的编辑输入。当前设计供 Agent 理解反馈和描述需要延续的画面，同时记录父版本关系。
- Agent 可按需保存商品资料和推广方案，生成版本记录对应快照；切换版本会恢复已有记录。上传新商品会重置上个商品的资料与方案。
- 图片接口接收 Agent 组织的本轮完整设计和商品资料，历史标题、配色与排版说明不会自动附加。
- 生成后可通过「原图对照」并排查看，再通过对话提出修改。生成式编辑可能改变商品细节，不能保证与实拍像素一致。

### 生成次数与交付

商品流程默认每轮最多一次生图尝试，生成后直接交付，不自动验图或返工。用户明确要求「生成两张」等数量时才增加本轮次数，仍受 `MAX_IMAGES_PER_TURN` 上限约束；失败的生图尝试也占用次数。

界面无需先选择尺寸或填写方案表单；有指定比例时直接在对话中说明，最终尺寸以图片接口返回为准。画面和所需文字统一由图片模型完成，没有独立文字图层，改字同样属于图片编辑，可能产生模型费用。

## 模型与 API 配置

### 连接真实服务

编辑 `.env`，配置可用的 Key、接口地址和模型 ID，再启动服务。以下模型 ID 与项目示例配置一致，实际可用性由所选服务商决定：

```dotenv
STUDIO_MODE=auto
OPENAI_API_KEY=your-api-key
# 未设置时使用 OpenAI 默认接口；使用兼容服务时填写其 API 基础地址。
# OPENAI_BASE_URL=https://your-provider.example/v1
AGENT_MODEL=gpt-6.1-sol
IMAGE_MODEL=gpt-image-2.5-sunburst
IMAGE_SIZE=auto
```

对话与参考图理解使用 `OPENAI_API_KEY` / `OPENAI_BASE_URL`。如需独立的生图服务，同时设置 `IMAGE_API_KEY` 和 `IMAGE_BASE_URL`；两项都不设置时，生图与编辑复用对话服务。

也可用 `STUDIO_CREDENTIALS_FILE` 指向凭据文件，支持 `~/` 路径。程序只读取其中的 `OPENAI_API_KEY` 和 `OPENAI_BASE_URL`，支持 `export KEY=value` 写法，不执行文件；直接设置的环境变量优先于凭据文件。

| 运行模式 | 行为 |
| --- | --- |
| `STUDIO_MODE=auto` | 有对话 Key 时真实调用，无 Key 时演示；默认值 |
| `STUDIO_MODE=demo` | 强制演示，只绘制明确标注的本地示意图 |
| `STUDIO_MODE=live` | 要求已配置对话 Key，否则启动失败 |

演示模式不进行 AI 理解或真实编辑，演示图片不能作为真实编辑的源图。真实接口失败后，应用会报告错误，不自动切换为演示模式。

### 在界面切换模型

顶部滑杆按钮或侧栏「模型调试」打开配置面板：

1. **中转站**：保存服务名称、API 基础地址、Key 和接口适配器。
2. **模型库**：为中转站登记实际支持的模型 ID，指定「对话」或「生图」用途。也可用「读取列表」请求 `/models`，列表本身不保证模型具备对应能力。
3. **调用路由**：分别选择对话与生图的「中转站 + 模型」。对话负责沟通、参考图理解和工具调用；生图路由同时用于编辑。

真实模式下保存后供后续任务使用，无需重启；有任务执行时禁止修改。编辑 Key 留空会保留原值，更换接口地址需要重新输入 Key。在演示模式中配置好 Key 后，需要重启并使用 `auto` 或 `live` 才会启用真实调用。

首次启动从环境变量或凭据文件初始化。面板保存后，配置写入数据目录中的 `model-settings.json`，文件权限为 `0600`；**已保存配置优先于环境变量**，修改 `.env` 中的初始模型或 Key 不会覆盖面板记录。密钥保存在服务端，不向面板回填，不写入会话记录；Agents SDK tracing 已关闭。

### 接口兼容性与运行参数

内置适配器为 `openai-responses` 和 `openai-chat-completions`。对话接口需要支持函数调用；理解参考图还需要图片输入。生图服务需要兼容 Images API 的生成、multipart 编辑、base64 图片返回，以及 `size`、`quality`、`output_format` 参数。

| 参数 | 说明 |
| --- | --- |
| `PORT` | 本地端口，默认 `4320` |
| `STUDIO_DATA_DIR` | 数据目录，默认项目下的 `.data/` |
| `SKILLS_DIR` | 额外技能目录，与内置及导入的技能一起加载 |
| `IMAGE_SIZE` | 默认 `auto`，也可设置接口支持的 `WIDTHxHEIGHT`；Agent 在提示中安排画幅，具体返回尺寸由接口决定 |
| `MAX_IMAGES_PER_TURN` | 每轮图片 API 调用上限；`.env.example` 设置为 `2`，未设置、`0` 或 `unlimited` 表示无全局固定上限；商品流程仍默认一次 |
| `AGENT_MAX_TURNS` | Agent 回合上限；未设置、`0` 或 `unlimited` 表示无固定上限 |
| `SANDBOX_MODE` | `local`、`docker` 或 `off`，默认 `local` |
| `SANDBOX_IMAGE` | Docker 镜像，默认 `python:3.12-slim` |
| `SANDBOX_NETWORK` | Docker 网络配置，当前只允许 `none` |
| `SANDBOX_WORKSPACE` | 可选的原生 Docker Sandbox 工作目录根路径 |

任务最长执行 5 分钟，图片接口禁用 SDK 自动重试。每轮回复下方展示请求的模型、耗时、图片调用次数和服务商返回的 token 用量；遗漏字段保留为未知，已知小计会标注记录不完整。当前未配置费用费率，实际人民币扣费以服务商账单为准。

## 扩展 Skills

### 添加方式

- **项目目录**：在 `skills/` 下添加包含 `SKILL.md` 的技能文件夹。
- **外部目录**：设置 `SKILLS_DIR=/absolute/path/to/my-skills` 后重启服务。
- **本地文件**：在技能库导入单个 `SKILL.md`；有配套参考、脚本或素材时使用完整目录。
- **GitHub 仓库**：在技能库输入公开仓库地址 `https://github.com/org/repo`。服务端浅克隆默认分支，扫描并复制技能到数据目录的 `skills/`，随后删除临时下载目录；导入阶段不执行仓库脚本。

完整目录示例：

```text
my-skills/
  brand-poster/
    SKILL.md
    references/
      brand.md
    assets/
    scripts/
```

`SKILL.md` 示例：

```markdown
---
name: 我的品牌海报
description: 根据品牌规范创建和调整海报
connectors: [openai-images, canvas-artifacts]
---
先读取 references/brand.md，理解品牌规范。
根据用户的用途和画面诉求安排设计。
执行前使用 update_plan 展示简短步骤。
通过 render_image 生成或编辑图片，完成后交付，等待用户后续修改。
```

所选 Skill 随会话保存，每轮加载其指令并记录 ID 和 `SKILL.md` 内容摘要。技能提供创作指南，不授予额外系统权限。商品流程由 `metadata.workflow: product-promotion` 启用，内置入口为 [skills/product-promotion/SKILL.md](skills/product-promotion/SKILL.md)。

### 应用提供的工具

| 工具 | 用途 |
| --- | --- |
| `update_plan` | 展示简短行动清单，不输出内部推理 |
| `read_skill_reference` / `read_skill_references` | 读取当前 Skill 的单份或多份文本参考资料，每轮合计最多 8 份 |
| `render_image` | 调用图片生成或编辑 API，保存新版本及父版本关系 |
| `save_product_brief` | 仅商品流程启用，按需保存商品依据、推广方案和实际文案 |
| `validate_menu_content` | 校验菜单分类、菜名、价格格式、重复项和缺失信息 |
| `render_menu_layout` | 通过 SVG/PNG 确定性排版绘制菜单文字和价格，每轮最多两个版本 |
| `run_skill_script` | 仅声明脚本能力且包含脚本的 Skill 提供，执行需要 Docker 模式 |

菜单设计优先校验数据，再使用确定性排版，交付图片与文字清单供用户核对。可单独提供 `currency`，例如 `currency: ¥` 和 `price: 18` 显示为 `¥18`。

文本参考支持 `.md`、`.txt`、`.json`、`.yaml`、`.yml`、`.csv`，单文件最多 64 KB，限制在所选技能目录的已登记文件内；扫描排除隐藏文件和符号链接。技能摘要只基于 `SKILL.md`，不包含参考文件的内容版本。

Frontmatter 支持 `allowed-tools`、`requires`、`connectors`。声明 `Bash`、`Shell`、`Python` 或 `run_skill_script` 等已识别脚本能力并包含 `scripts/` 时，可启用应用脚本工具；声明本身不会安装依赖。当前已注册 `openai-images` 和 `canvas-artifacts` 连接器，状态可通过 `/api/connectors` 查看。声明 MCP 或未知连接器的 Skill 会显示为未接入，禁止选择。

### 沙箱与脚本

项目通过 Agents SDK 的 `SandboxAgent` 和原生 `skills()` capability 挂载所选技能的指令、参考、素材与脚本。运行方式由 `SANDBOX_MODE` 决定：

| 模式 | 执行环境 |
| --- | --- |
| `local` | 使用 `UnixLocalSandboxClient`，以本机用户权限运行；默认值，适用于可信的本地技能 |
| `docker` | 使用 `DockerSandboxClient`，需要可用的 Docker daemon，容器网络关闭 |
| `off` | 不启用原生 Sandbox，仍可通过应用工具读取技能参考和生成图片 |

应用另提供 `run_skill_script`：只允许当前 Skill 已登记的 `scripts/` 下 Python 或 Shell 脚本，仅在 Docker 模式执行。每次调用使用无网络、无特权、非 root、只读根文件系统的容器，限制为 256 MB 内存、1 CPU 和 30 秒，技能目录只读挂载，工具返回标准输出。依赖的 Python 包或命令必须预装在 `SANDBOX_IMAGE` 中。

上述资源限制属于应用脚本工具，不能据此假定原生 Sandbox 具有相同限制；原生 Docker Sandbox 的资源配额需在 Docker 或外层运行环境设置。第三方 Skill 应先审核内容，再决定是否启用和执行。

## 项目结构与数据

| 路径 | 职责 |
| --- | --- |
| `public/` | 原生 ES 模块界面、画布、版本记录和模型调试面板，无需前端打包 |
| `server/index.js` / `server/config.js` | 启动参数、环境变量与凭据读取 |
| `server/app.js` | 本地 HTTP API、上传、后台任务、取消与请求去重 |
| `server/agent.js` | Agents SDK Agent/Runner 和创作工具 |
| `server/product.js` / `server/menu.js` | 商品资料与生成约束、菜单校验与排版 |
| `server/adapters.js` / `server/model-settings.js` | 接口适配、模型路由和配置持久化 |
| `server/skills.js` / `server/sandbox.js` / `server/skill-runner.js` | 技能扫描导入、原生挂载与应用脚本执行 |
| `server/store.js` / `server/usage.js` | 会话与图片版本存储、用量记录 |
| `skills/` | 内置技能和按需读取的参考资料 |
| `tests/` | 单元测试、界面测试和可选的付费接口验证 |

默认数据保存在 `.data/`：

```text
.data/
  sessions/           # 会话、消息、任务事件与图片元数据
  images/             # 上传原图与生成版本
  skills/             # 导入的技能
  model-settings.json # 已保存的服务商、密钥、模型和路由
```

`.env` 和 `.data/` 均已加入 `.gitignore`。备份时保留会话与图片的对应关系，并妥善保管含密钥的模型配置。

会话保存全部消息，每轮向模型传递最近 40 条非错误历史消息、当前选中图片和版本列表；商品流程另提供商品依据。执行记录展示公开工具事件，通过轮询更新，不流式展示模型 token。

这是仅绑定 `127.0.0.1` 的本机单用户应用，提供本地 Host、Origin 和写入令牌检查，尚无登录、多租户隔离或生产部署配置。画布用于单图预览和版本选择，不包含自由排版、独立文字图层或蒙版局部重绘。

新增服务协议时，在 `server/adapters.js` 实现 `createClient`、`modelProvider`、`generate`、`edit`、`listModels` 契约，并将请求的 AbortSignal 继续传给上游；模型与路由配置由 `server/model-settings.js` 管理。

## 开发验证

常规检查和界面测试使用临时数据及演示或模拟接口，不读取真实 Key、不计费：

```bash
npm run check
npx playwright install chromium
npm run test:ui
```

也可跳过 Chromium 下载，使用本机兼容浏览器，例如 macOS 上：

```bash
PLAYWRIGHT_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:ui
```

界面测试覆盖桌面与移动视口、上传、对话、版本分支、原图对照及模型配置等交互，截图输出到 `test-results/`。无头测试通过设置文本值并触发事件验证输入逻辑，中文输入法体验仍需手动检查。

真实接口验证需先启动真实模式服务，**会调用对话和图片 API 并产生费用**：

```bash
LIVE_SMOKE=1 node tests/live-smoke.mjs
```

默认创建一个测试会话，选择「杂志海报」，执行一次生成和一次编辑，检查任务完成与版本关系；测试会话和图片会保留。可通过 `STUDIO_URL` 指定服务地址，默认 `http://127.0.0.1:4320`。该脚本验证真实调用链路，不评价商品设计质量或画面一致性。
