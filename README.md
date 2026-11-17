# dsh-wb-free-model

在 DSH 里装上这个插件，**无需登录、注册、填 API Key 或任何其它操作**，就能使用免费模型。

插件在本机拉起一个隔离的 OpenCode 1.19.6 运行时（首次启动自动下载，约 182 MB），把运行时里的**零成本模型**发布为 DSH 的 `WB Free Model` 供应商，并额外提供 `WB · auto`：按实测耗时加权自动挑选当前可用的免费模型。

业务逻辑移植自 [wbBridge](https://github.com/trexwb/wbBridge)：隔离运行时、免费模型发现与探测、加权自动选择、信封协议、会话与权限边界。打包形态参考 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)。

## 它做什么

1. **拉取官方运行时**：从 npm 下载与平台匹配的 `opencode-<platform>@1.19.6`，校验 `sha512` 完整性后解压，落在插件自己的数据目录里。也支持复用 PATH 上同版本的 `opencode` 或手动指定的二进制。
2. **发现免费模型**：读取 `GET /provider`，只保留输入、输出、缓存读写成本全部为 0、支持文本输出、状态非 deprecated 的模型。OpenCode 内置的匿名模型与通过配置注入的 Kilo 匿名网关都会出现在目录里。
3. **启动即探测**：每个模型用一次真实对话验证「能否按信封协议返回一个 `Read` 动作」。探测通过的模型才发布；只会聊天、不会函数调用的模型按「仅对话」发布；超时或格式不支持则失败并记录原因。结果持久化，再次启动时 12 小时内不会重复探测。
4. **WB · auto**：请求时按能力过滤（工具、图像、推理档位），在通过探测的模型里取权重最高者，权重相同随机选择。探测权重按耗时分档：≤2s 100、≤5s 80、≤10s 60、≤20s 40、≤40s 20、更慢 10；单次真实请求超过 30s 再扣 20。所有模型权重都跌到 0 时自动重新探测。
5. **信封协议**：托管模型永远不执行 DSH 工具。它只返回一个 JSON 对象：

   ```json
   {"content": "给用户的文字", "calls": [{"name": "工具名", "arguments": {}}]}
   ```

   插件校验这个对象，再把它转换成 DSH 原生 tool-call 块交给 harness 执行。格式错误会用修复提示重试一次；输出被截断会要求压缩重发。工具的执行、权限与结果始终在 DSH 这一侧。

## 安装

要求 Node.js `^22.19.0 || >=24`。

```sh
# 作为插件装进一个 profile（web / desktop / 自建 profile 名）
dsh plugin --profile web add github:trexwb/dsh-wb-free-model

# 启动
npx @deepseek-ai/dsh web
```

桌面端也可以在「设置 → 插件」里从仓库地址安装，然后在「设置 → WB Free Model」查看模型列表。

首次启动会下载 OpenCode 运行时，耗时取决于网络。下载完成后，模型会出现在 DSH 的模型选择器里，供应商名为 **WB Free Model**，第一项是 **WB · auto**。

## 模型标识

- `auto` → `WB · auto`
- `opencode/<模型键>` → 带 `OC ·` 前缀的显示名
- `kilo/<模型键>` → 带 `KL ·` 前缀的显示名

模型选择器按供应商分组，所以全部免费模型都在 `WB Free Model` 下。推理档位只在该模型自己声明了 variants 时出现；固定推理模型接受 `minimal`–`max` 的标准档位。

## 设置页

「设置 → WB Free Model」提供：

- 运行时状态、端口、目录更新时间、模型总数；
- 每个模型的可用性、探测耗时、权重、能力标签（工具 / 图像 / 推理）；
- 刷新目录、检测全部、重试失败、单模型重试；
- 启用车道、启动时自动检测两个开关。

同一份数据也通过 `GET /api/wb-free-model/status` 暴露，POST 路由为 `/refresh`、`/probe`、`/retry`、`/settings`。这些路由只接受本机回环地址、只接受 `application/json`。

## 数据与日志

默认数据目录：`~/.dsh/dsh-wb-free-model`（`DSH_HOME` 可覆盖）。

```
state.json                 目录快照与探测结果（0600）
runtime/opencode-1.19.6-*/ 下载的运行时
opencode/{config,data,cache,state,project}/  隔离的 XDG 根（0700）
logs/opencode.log          OpenCode 服务端日志
```

可用的环境变量：

- `DSH_HOME`：DSH 主目录。
- `DSH_WB_FREE_MODEL_BIN` / `WB_FREE_MODEL_OPENCODE`：指定 `opencode` 可执行文件。
- `WB_FREE_MODEL_NPM_REGISTRY`：替换 npm registry（例如内网镜像）。

## 安全边界

沿袭 wbBridge 的红线：

- 子进程环境是**显式白名单**（PATH、HOME、语言、证书路径等），宿主里的其它供应商凭据不会进入运行时。
- OpenCode 只监听 `127.0.0.1` 的随机端口，Basic 认证密码每次启动随机生成。
- 原生工具权限全部 `ask` 或 `deny`；实际运行时会拒绝并记录任何原生工具请求，模型只能通过信封返回动作。
- 只允许配置走 `OPENCODE_CONFIG_CONTENT` 内联内容；不禁用 TLS 校验；不自动更新；不启用 share。
- 插件关闭或进程退出时 `SIGTERM` → 4 秒 → `SIGKILL` 回收子进程。

`auto` 选择、`calls` 数组、工具名与参数都经过校验；未列出的工具、歧义字段、字符串化参数会被拒绝或规范化，不会把未经检查的动作直接送进执行层。

## 已知限制

- 免费模型由上游随时调整，某个模型探测失败或临时 500 是常态；失败原因会写在设置页，重试即可。
- 托管端点不提供 token 级流式输出：插件拿到完整信封后一次性发出内容块。DSH 侧的工具循环不受影响。
- 首次启动需要下载 182 MB 运行时；离线环境请预置二进制并设置 `DSH_WB_FREE_MODEL_BIN`。
- 只发布零成本模型。付费模型、需要用户自有 API Key 的供应商不会出现。

## 开发

```sh
node --check index.js
node --check client.js
node --check src/*.js
```

插件没有构建步骤，也没有运行时依赖：Host 半使用 Node 内置模块，浏览器半只 `require('react')`。`cordis.patch.yml` 负责把插件插进 profile 的 bundle 链，`catalog/dsh-plugin.json` 是 dsh.so 的发现清单。

## 许可

MIT。信封协议与运行时隔离逻辑来自 MIT 许可的 [wbBridge](https://github.com/trexwb/wbBridge)。
