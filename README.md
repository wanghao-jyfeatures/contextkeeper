# ContextKeeper for Trae

> 给统一付费的 AI 用量做减法——智能体读取大文件先压缩再进上下文，**实测节省 59%~65% token**，省掉的部分用行号索引**随时无损取回**。

**零 API Key · 零网络 · 零改造 · 任意模型通用**

## 为什么需要它

企业统一付费的 AI 编程工具（如 Trae 企业版）按 token 计费：让智能体理解一个 2000+ 行的核心文件，一次性进入上下文 3 万多个 token，且每一轮对话重复计费。而所有传统省 token 方案（网关截流、模型代理）都依赖 API Key——企业账号根本没有。

ContextKeeper 换了个思路：**不打模型的主意，打上下文的主意**。它注册在 Trae 的 MCP 工具层（`vscode.trae.registerMcpProvider`），智能体读取大文件时自动做**结构骨架压缩**，需要细节时按行号**无损解引用**——工具层与模型完全解耦，零 Key、切模型照样生效。

## 核心特性

| 特性 | 说明 |
|---|---|
| **结构骨架压缩** | 类/方法签名 + docstring + import 全保留，超长函数体省略为行号索引（JS/Java/C/Go/Rust... 与 Python 两种引擎） |
| **REF 影子存储** | 每次压缩的原文落盘 `.contextkeeper/refs/`（200 条 LRU），IDE 重启后仍可按行号取回 |
| **无损解引用** | `load_context_ref(ref_id, ranges="747-874")` 精确到行，模型自主判断何时取、取哪段 |
| **模式开关** | `/optimize`（压缩，默认）↔ `/normal`（全文），跨对话持久化 |
| **实时账单** | 状态栏常驻 `⚡ CK 优化 \| 已省 38,837 tok`，`stats.jsonl` 逐条落盘可审计 |
| **模型无关** | 注册在 MCP 工具层，与聊天模型零耦合——GLM / DeepSeek / 任意模型通用 |

## 实测数据（2026-10，Node 直跑单测 + Trae 端到端）

| 文件 | 规模 | 节省 |
|---|---|---|
| server.py（Python 网关核心） | 2239 行 / 34,504 tok | **63%**（46 个方法 docstring 全保留，50 处省略全对齐） |
| extension.js（插件本体） | 665 行 JS | **59%** |
| mock_target.py（中型业务文件） | 58 行 | **65%** |
| 小文件 | 收益 <10% | 智能跳过，原样返回 |

同一次任务按 4 轮对话计：直接读全文 ~138,000 tokens → 压缩模式 ~52,000 tokens（含解引用），**省 62% 且信息总量不减少**。

## 安装（旁载部署，约 3 分钟）

Trae 的 `--install-extension` CLI 通道不可用（静默失败），须把插件注册进扩展权威清单：

1. **复制插件**：把 `extension/` 目录（含 `extension.js` + `package.json`）拷贝到 `C:\Users\<用户>\.trae-cn\extensions\hackathon-lm-probe.lm-probe-0.0.1\`
2. **注册清单**：运行 `python scripts/register_ext.py`（自动备份 + 幂等注册；手工编辑 `extensions.json` 的完整条目格式见[产品文档](docs/产品文档_ContextKeeper.html)）
   - ⚠️ 清单中**不能有重复 id 条目**，且 `location.path` 必须是 `scheme: "file"` 的绝对路径（URI 风格 `/c:/...`）——否则扩展不激活且无提示
3. **重载窗口**：Ctrl+Shift+P → `Reload Window`，看到右下角启动通知 + 状态栏 `⚡ CK 优化 \| 已省 N tok` 即成功
4. **验证**：对话中输入"调用 read_file_smart 读取任意代码文件"

## 使用

日常**什么都不用做**——工具对智能体透明，读大文件自动压缩、需要细节自动取回。用户可选操作：

- `/optimize` / `/normal`：切换压缩/常规模式（持久化）
- 状态栏点击：查看累计账单
- `docs/产品文档_ContextKeeper.html`：完整产品文档（原理 + 测试报告 + 集成细节）

## 原理速览

```
Trae 智能体（任意模型）
   │ 自然调用
   ▼
MCP 工具层（vscode.trae.registerMcpProvider）
   read_file_smart / load_context_ref / contextkeeper_mode / context_stats
   │ 纯本地规则处理（毫秒级）
   ▼
压缩引擎 + REF 影子存储（零 Key · 零网络 · 零模型依赖）
```

**为什么减 token 且不影响模型自主分析**：压缩不删除信息，只改变呈现密度——

1. **结构完整**：签名 + docstring + import 全保留，模型"看得见全局"（结构分析占日常任务 80%+）
2. **信息对称**：每处省略都带 `[CK-OMITTED 原文行 747-874]` 精确标记，模型明确知道自己没看什么
3. **按需解引用**：标记内嵌"取回说明书"，模型需要实现细节时自主调用，一个字不丢

## 运行测试

```bash
node test/test_compression.js
```

覆盖三种压缩模式、省略区间与原文逐行对齐校验、模式开关持久化往返（当前 7/7 PASS）。

## 目录结构

```
extension/          插件本体（extension.js + package.json）
scripts/            旁载注册脚本（register_ext.py）
test/               单元测试 + fixture
docs/               产品文档（HTML 单文件，含原理与测试报告）
```

## Roadmap

- [x] 结构骨架压缩（花括号 + Python 双引擎，叶子优先 + 签名保全）
- [x] REF 影子存储落盘持久化
- [x] 模式开关（/optimize ↔ /normal）
- [x] 状态栏实时账单
- [ ] 会话历史摘要
- [ ] 本地小模型语义压缩（当前为规则引擎）
- [ ] AST 级 Python 压缩（当前为缩进级）
- [ ] 部门级账单报表

## License

[MIT](LICENSE)

## 致谢

架构灵感来自开源项目 [Paritok](https://github.com/paritok/paritok) 的压缩管道与影子存储设计；本项目为全新实现（Python 网关 → Node.js 插件，零代码复用）。
