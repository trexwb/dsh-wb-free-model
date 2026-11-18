# dsh-wb-free-model

在 DSH 里装上这个插件，**无需登录、注册、填 API Key 或任何其它操作**，就能使用免费模型。

插件进程**直连两条免密免费车道**（不下载任何运行时、不拉起任何子进程）：

- **OC · 免密免费车道**：opencode.ai 背后的匿名免费池，OpenCode 客户端自己用的同一条车道。线上的 v2 指纹契约（官方提示词、官方工具集、会话编码、请求头）收录自 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)（MIT，`src/o2a/` 逐字携带）。
- **KL · Kilo 免费池**：Kilo AI 公共网关的 `isFree` 模型切片，完全无需凭据。

并额外提供 `WB · auto`：按实测耗时加权自动挑选当前可用的免费模型。业务逻辑移植自 [wbBridge](https://github.com/trexwb/wbBridge)：免费模型发现与探测、加权自动选择、会话与权限边界。

因为整条车道都是插件进程内的出站 HTTPS，**iOS 等无法派生子进程的宿主同样可用**——这是本插件相对早期版本（本机拉起 OpenCode 运行时）的根本变化。

## 它做什么

1. **发现免费模型**：每次刷新从 `GET /inference/v1/models`（免费车道）与 `GET {KILO_BASE}/models` 的 `isFree` 切片（Kilo 车道）重新拉取清单，插件内不保存静态快照。免费车道的 id 与一张本地能力表（上下文窗口 / 视觉 / 推理档位，随 dsh-our-free-model 的实测校准）合并成目录。
2. **启动即探测**：每个模型用一次真实对话验证「能否按请求返回一个 `Read` 动作」。探测通过的模型才发布；只会聊天、不会函数调用的模型按「仅对话」发布；超时或格式不支持则失败并记录原因。结果持久化，再次启动时 12 小时内不会重复探测。
3. **WB · auto**：请求时按能力过滤（工具、图像、推理档位），在通过探测的模型里取权重最高者，权重相同随机选择。探测权重按耗时分档：≤2s 100、≤5s 80、≤10s 60、≤20s 40、≤40s 20、更慢 10；单次真实请求超过 30s 再扣 20。所有模型权重都跌到 0 时自动重新探测。
4. **工具调用是原生的**：模型经上游网关返回标准 tool-calls，适配器把它们转换成 DSH 原生 tool-call 块交给 harness 执行。上游网关是纯推理端点，**不执行任何东西**；工具的执行、权限与结果始终在 DSH 这一侧——这与早期信封协议的安全边界等价，且不再依赖托管运行时的 StructuredOutput。
5. **免费车道指纹契约**（`src/o2a/`）：请求按 v2 客户端指纹塑形——官方系统提示词、官方 13 工具集（调用方同名工具按别名收编，其余以可逆改名收编并注入占位注记压住）、`stream_options.include_usage`、会话与项目头的稳定派生。对话到上游会话的映射持久化在插件数据目录（`session-map.json`），重试不换会话。
6. **配额断路器**：免费车道按出口 IP 计配额；一次真实 429 即开窗（`Retry-After` 缺省 6 小时），窗口内本插件本地拒绝新请求、不再向墙上送请求。成功即清窗。Kilo 车道不受影响。

## 安装

要求 Node.js `^22.19.0 || >=24`（需要内置 `fetch`）。

```sh
# 作为插件装进一个 profile（web / desktop / 自建 profile 名）
dsh plugin --profile web add github:trexwb/dsh-wb-free-model

# 启动
npx @deepseek-ai/dsh web
```

桌面端也可以在「设置 → 插件」里从仓库地址安装，然后在「设置 → WB Free Model」查看模型列表。

启动后模型会出现在 DSH 的模型选择器里，供应商名为 **WB Free Model**，第一项是 **WB · auto**。没有首次下载：所有上游流量都是插件进程内的普通 HTTPS 请求。

## 模型标识

- `auto` → `WB · auto`
- `OC · <名称>` → 免密免费车道（如 `OC · DeepSeek V4.1 Flash`）
- `kilo/<org>/<模型>` → Kilo 免费池，显示名带 `KL ·` 前缀

推理档位只在该模型自己声明了档位菜单时出现（档位按原值随 `reasoning_effort` / Kilo `reasoning` 字段下发，上游会校验集合外的取值）；`WB · auto` 的档位是全部模型声明档位的并集。

## 设置页

「设置 → WB Free Model」提供：

- 车道状态、清单更新时间、模型总数；
- 每个模型的可用性、探测耗时、权重、能力标签（工具 / 图像 / 推理）；
- 刷新目录、检测全部、重试失败、单模型重试；
- 启用车道、启动时自动检测两个开关；
- 免费车道配额窗口与客户端指纹拒绝的醒目提示。

**启用车道开关是完整的启停开关**：关闭后，全部模型（含 `WB · auto`）立即从 DSH 模型选择器移除，进行中的探测安静退出，状态接口如实显示停用；状态持久化，重启 DSH 不会自动拉起，直到重新开启。开启后走既有启动路径：清单刷新 → 按需探测 → 模型重新发布。

同一份数据也通过 `GET /api/wb-free-model/status` 暴露，POST 路由为 `/refresh`、`/probe`、`/retry`、`/settings`。这些路由只接受本机回环地址、只接受 `application/json`。`/refresh`、`/probe` 是异步的：立即返回 `202`，进度与结果通过状态轮询获取。车道关闭时它们返回 `409`。

## 数据与日志

默认数据目录：`~/.dsh/dsh-wb-free-model`（`DSH_HOME` 可覆盖）。

```
state.json                 目录快照与探测结果（0600）
session-map.json           对话 → 上游会话映射（免费车道配额按会话计）
```

可用的环境变量：

- `DSH_HOME`：DSH 主目录。
- `WB_FREE_MODEL_BASE`：替换免费车道网关地址（默认 `https://opencode.ai`，例如内网镜像或自建调试端点）。
- `WB_FREE_MODEL_KILO_BASE`：替换 Kilo 网关地址（默认 `https://api.kilo.ai/api/gateway`）。

## 安全边界

沿袭 wbBridge 的红线：

- **上游是纯推理端点**：模型返回的 tool-calls 只是数据；执行、权限与结果始终在 DSH 这一侧。上游网关无从执行本地动作。
- **不做任何本地监听**：没有子进程、没有回环端口、没有 Basic 认证；出站只有对两条车道网关的 HTTPS，TLS 校验不关闭。
- 免费车道的 `authorization` 是上游免费池的**公共池化凭据**（与 OpenCode 客户端自带的一致），不存在任何用户私有密钥；Kilo 车道完全不发送凭据。
- 工具名在响应侧经可逆映射还原后才校验：不在调用方工具清单里的名字（含官方注入项）一律丢弃并告警，不会把未经检查的动作送进执行层。
- 会话、请求、项目头的派生是确定性的，不携带任何宿主环境秘密；发往上流的系统提示词只包含插件自己的进程元数据（工作目录 / 平台 / 日期）。
- 插件停用或进程退出时，进行中的探测被中止；没有需要回收的子进程。

## 已知限制

- 免费模型由上游随时调整，某个模型探测失败或临时 5xx 是常态；探测与真实请求的失败都会记录在设置页（请求失败保留原权重），重试即可恢复。清单刷新失败时若缓存目录仍在，请求会用缓存目录继续服务，并在设置页提示刷新错误。
- 插件拿到完整回复后一次性发出内容块（非 token 级流式）；DSH 侧的工具循环不受影响。
- 免费车道清单里走 `/responses` 与 Anthropic `/messages` 线型的 id（muse-spark、union-alpha）不发布：本插件只实现 Chat 线型。
- 上游按出口 IP 计免费配额：一个烧掉的出口会以 429 + 小时级 `Retry-After` 回答；断路器会在窗口内本地拒绝，换出口即清窗。不支持配置出站代理。
- Kilo 免费池由上游免费提供，其模型卡声明 prompt 可能被记录用于改进服务——请勿发送敏感内容。
- 只发布免费模型。付费模型、需要用户自有 API Key 的供应商不会出现。

## 开发

```sh
node --check index.js
node --check client.js
node --check src/*.js
node --check src/o2a/*.js
```

插件没有构建步骤，也没有运行时依赖：Host 半使用 Node 内置模块，浏览器半只 `require('react')`。`cordis.patch.yml` 负责把插件插进 profile 的 bundle 链，`catalog/dsh-plugin.json` 是 dsh.so 的发现清单。

`src/o2a/` 与其资产来自 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)（MIT）逐字收录，仅作格式化对齐；上游契约更新时以该仓库为准同步。

## 许可

MIT。信封协议（历史版本）与运行时隔离逻辑来自 MIT 许可的 [wbBridge](https://github.com/trexwb/wbBridge)；免费车道线契约来自 MIT 许可的 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)。
