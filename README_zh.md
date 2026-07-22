# Evidence Loom

[![CI](https://github.com/simonguo/evidenceloom/actions/workflows/ci.yml/badge.svg)](https://github.com/simonguo/evidenceloom/actions/workflows/ci.yml)
[![CodeQL](https://github.com/simonguo/evidenceloom/actions/workflows/codeql.yml/badge.svg)](https://github.com/simonguo/evidenceloom/actions/workflows/codeql.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Evidence Loom 是一个本地优先的多智能体市场研究桌面工作区。它将 Next.js 界面、Tauri 桌面外壳和嵌入式 [TradingAgents](https://github.com/TauricResearch/TradingAgents) 研究核心组合成一个可审计的工作流。

> Evidence Loom 是独立的社区项目，与 TauricResearch 不存在隶属或官方背书关系。输出来自概率模型与第三方数据，不构成金融、投资、法律或交易建议。

[English](README.md)

![Evidence Loom 任务中心](assets/desktop/desktop-tasks.png)

## 主要能力

- 协调行情、情绪、新闻、基本面、研究、交易和风险智能体。
- 桌面端通过随应用打包的 sidecar 本地运行，无需 Evidence Loom 云账户。
- 任务历史和报告保存在本机。
- 桌面 API Key 保存到 macOS Keychain 或 Windows Credential Manager。
- 支持 OpenAI 兼容接口、Anthropic、Google、Azure OpenAI、DeepSeek、通义千问、智谱、MiniMax、OpenRouter 与本地/自定义端点。

## 支持平台

| 平台 | 安装包 | 源码构建 |
| --- | --- | --- |
| macOS Apple Silicon | 签名并公证的 DMG | 支持 |
| macOS Intel | 签名并公证的 DMG | 支持 |
| Windows x64 | Authenticode 签名安装包 | 支持 |
| Linux | 首发不提供安装包 | 技术用户可从源码运行 |

安装包只从本仓库的 [GitHub Releases](https://github.com/simonguo/evidenceloom/releases) 下载。如果平台签名或公证未完成，该平台安装包不会发布。

## 从源码运行

需要 Python 3.10–3.13、[uv](https://docs.astral.sh/uv/)、Node.js 22/npm 和 Rust 1.95。

```bash
git clone https://github.com/simonguo/evidenceloom.git
cd evidenceloom
cp .env.example .env
uv sync --locked --group dev
npm --prefix frontend ci
```

启动浏览器开发界面（`http://localhost:31741`）：

```bash
npm --prefix frontend run dev
```

启动 Tauri 开发应用：

```bash
npm --prefix frontend run tauri:dev
```

运行兼容上游的 CLI：

```bash
uv run tradingagents
```

使用 Docker 运行 CLI 环境：

```bash
docker compose run --rm evidenceloom
```

## 架构与数据流

```text
Next.js 界面
  ├─ Web 开发模式 → 本地 Next.js API → Python 研究核心
  └─ 桌面模式 → 受限 Tauri IPC → Rust 进程控制器 → Python sidecar
                                                     ├─ LLM Provider
                                                     └─ 行情/新闻数据 Provider
```

桌面设置和任务元数据保存在本地 SQLite。桌面快照接口不会返回 API Key：Rust 从操作系统凭据库读取机密，并仅注入 sidecar 进程。Web 模式的 Key 只在当前浏览器会话内存中存在，不写入 localStorage。

提示词、证券代码、日期、检索到的市场上下文及生成内容可能发送到你选择的模型和数据提供商；各 Provider 的计费、数据保留、地域处理和使用条款独立适用。使用真实持仓信息前请阅读 [PRIVACY.md](PRIVACY.md)。

## 开发检查

```bash
uv lock --check
uv run ruff check .
uv run ruff format --check .
uv run pytest

npm --prefix frontend run lint
npm --prefix frontend run typecheck
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend audit --audit-level=high

cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

构建产物和架构相关 sidecar 均由构建流程生成，禁止提交到 Git。打包细节见 [frontend/SIDECAR.md](frontend/SIDECAR.md) 和 [frontend/DESKTOP_DISTRIBUTION.md](frontend/DESKTOP_DISTRIBUTION.md)。

## 故障排查

- **桌面应用提示缺少 sidecar：** 按 [frontend/SIDECAR.md](frontend/SIDECAR.md) 为与桌面应用相同的 Rust target 构建 runner；不要给其他架构的产物改名冒充。
- **Provider 仍显示未配置：** 重新保存 Key，并允许 macOS Keychain 或 Windows Credential Manager 的系统提示。Evidence Loom 不会降级到明文存储。
- **31741 端口被占用：** 停止冲突进程，或同时修改前端与 Tauri 开发配置中的端口。
- **干净安装失败：** 核对上文列出的 Python、Node、npm、Rust 版本，并使用带 `--locked` 的命令或 `npm ci`；不要用重建锁文件掩盖问题。
- **模型或行情请求失败：** 检查 Provider、Endpoint、账户额度、区域可用性和证券代码格式。提交 Issue 前请阅读 [SUPPORT.md](SUPPORT.md)。

## 社区与安全

- 贡献流程：[CONTRIBUTING.md](CONTRIBUTING.md) 与 [DCO.md](DCO.md)
- 安全报告：[SECURITY.md](SECURITY.md)
- 支持边界：[SUPPORT.md](SUPPORT.md)
- 隐私与威胁模型：[PRIVACY.md](PRIVACY.md)
- 上游来源：[UPSTREAM.md](UPSTREAM.md)

## 许可与上游

Evidence Loom 使用 [Apache License 2.0](LICENSE)，包含基于 TradingAgents 修改的代码，上游固定为 `v0.2.5`、提交 `a5cb7cbd61d217fb0bc43f017392a861257afe6a`。内部 Python 模块继续使用 `tradingagents` 以保持上游兼容，但 Evidence Loom 不会用该名称发布 PyPI 包。

归属、修改和依赖许可见 [NOTICE](NOTICE)、[MODIFICATIONS.md](MODIFICATIONS.md)、[UPSTREAM.md](UPSTREAM.md) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
