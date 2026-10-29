# MCP stdio 接口

启动一个绑定项目的 MCP server：

```bash
node /absolute/path/agent-video-editor/mcp/server.js --project /absolute/path/project
```

客户端配置示例（字段按所用 MCP 客户端的配置文件放置）：

```json
{
  "mcpServers": {
    "vediomaker": {
      "command": "node",
      "args": ["/absolute/path/agent-video-editor/mcp/server.js", "--project", "/absolute/path/project"]
    }
  }
}
```

保持零 npm 依赖。传输支持 `2025-11-25`、`2025-06-18`、`2025-03-26` 的初始化与版本协商，
仅声明 tools / resources；不声明实验性 MCP Tasks。stdout 仅输出协议，日志走 stderr。
项目必须已存在；可先使用 `vdm init` 创建。MCP 进程退出不关闭项目运行时或取消已提交渲染，
运行时可由 `vdm engine stop --project <dir>` 显式停止。

## 编辑闭环

1. `vdm_capabilities {}`：确认模型与 Blender 可用性。
2. `vdm_project_read {"section":"summary"}`：取得 rev；使用元素、分镜、相机或对象分页进一步读取。
3. `vdm_context_read {"time":1.5}`：读取求值结果和附近拍点。
4. `vdm_project_apply_ops` 带 expectedRev / requestId，先 dryRun，再提交。
5. `vdm_render_submit` 提交 still / video；用 `vdm_job_get` 轮询。
6. `vdm_artifact_read {"id":"job-...","image":true}` 返回可看的 PNG；视频返回元数据和本地访问路径。

```json
{
  "expectedRev": 12,
  "requestId": "title-colour-1",
  "dryRun": false,
  "ops": [{"op":"set","id":"el_title","path":"style.color","value":"#ffd400"}]
}
```

工具有明确 JSON Schema。2D 位置单位是像素，原点在画面中心、y 向下；3D 为米、y 向上；
所有关键帧使用项目绝对秒数。`scene.objects` 为当前 3D 模型；`scenes` 树仍是实验模型，
没有切换为公开写入格式。

同一 requestId 的完全相同请求跨连接、跨进程重试会返回原事务与生成 ID；不同输入复用 ID
返回 `REQUEST_ID_CONFLICT`。`REV_CONFLICT` 包含 currentRev，应重新读取后规划新的请求，
不要只把旧请求的 expectedRev 换成新值。dryRun 不占用 requestId，也不保存撤销步骤。

## 工具

| 工具 | 用途 |
| --- | --- |
| `vdm_capabilities` | 版本、支持模型、操作与依赖 |
| `vdm_project_read` | summary / project / segments / elements / cameras / objects / world |
| `vdm_context_read` | 指定时刻的紧凑求值上下文 |
| `vdm_project_apply_ops` | 原子编辑、版本前提、去重、预检 |
| `vdm_history_list` / `undo` / `redo` | 项目持久化全局历史 |
| `vdm_media_list` / `probe` / `import` | 受目录限制的素材操作 |
| `vdm_render_submit` | 固定项目与素材快照后排队 |
| `vdm_job_list` / `get` / `cancel` | 任务生命周期 |
| `vdm_artifact_read` | 产物信息与最多 8 MiB 的 PNG |
| `vdm_inspect_stack` | 一帧的 2D 层序（远→近）、每层深度/平面，以及某像素谁拥有 |
| `vdm_inspect_coverage` | 逐帧覆盖：谁盖住这个像素；`focus` 给某元素的在屏/未遮挡采样 |
| `vdm_inspect_cut_edges` | 元素边界与镜头切点差不到 N 帧的地方（播放露出、导出不画的中间态） |
| `vdm_inspect_diff` | 两份工程/修订的变更报告 `changed[{id,kind,path,before,after}]` |
| `vdm_changeset_list` | 变更集列表（新的在前）：状态、actor、意图、rev、事务号、改动条数 |
| `vdm_changeset_show` | 一个变更集：`changed[]` 差异、报告计数、验证状态、撤销决策 |
| `vdm_changeset_apply` | 提交一个变更集（`id` 已有提案或 `ops` 新变更集），带 expectedRev / requestId / dryRun |
| `vdm_changeset_revert` | 整组或单条（`index` / `entityId`+`path`）撤销，只撤没人再改过的属性 |

### 变更集与锁定

一个变更集（`application/changeset-service.js`）把「一次被接受的编辑」记成一条记录：它提交的事务号
（`.vdm/transactions.json` 里对应的 `changesetId`）、`inspect-service.js::diff` 生成的 §8.3 差异报告
`changed[{id,kind,path,before,after}]`，以及状态 `proposed | applied | reverted | needs-decision`。

- 写入口只有 `vdm_project_apply_ops` 那一条事务路径：一个变更集就是一次（或一组）事务，`rev` 照常 +1，
  `requestId` 重放语义、`expectedRev` 前提、`dryRun` 预检都相同。`dryRun` 与 `preview()` 不写盘、不占 rev。
- `vdm_changeset_apply` 可以只给 `ops`（记录并提交一个变更集），也可以先 `ops`+`dryRun` 预演、再用 `id` 提交。
  提交失败（版本冲突、锁定、校验）时，已记录的提案标成 `needs-decision`，原因写进 `report.decisions`；
  `ops` 模式在预演阶段（校验、锁定）就失败时不留下记录。
- `vdm_changeset_revert` 只撤销「现在仍等于该变更集写下的值」的属性。别人改过同一属性 → 冲突；
  元素/相机/物体已被删除、关键帧键已不存在 → 冲突。冲突进 `report.decisions`，状态变 `needs-decision`，
  **不会**强行覆盖，也不会抛异常。`index` 是条目的全局序号（`changed[]` 在前，然后 `added[]`、`removed[]`），
  单条撤销后变更集仍为 `applied`，直到所有条目都回到旧值。
- 报告里的「已验证 / 未验证」是如实标注：这个服务从不把结果标成已验证
  （`report.verification.status = "unverified"`），要验证请用 `vdm_render_submit` + `vdm_inspect_*`。

锁定（`el.locked`，相机与 3D 物体同理）是人与 Agent 的权限边界：`locked: true` 的元素/相机/物体，
`actorId` 为 `agent:*` 的写入（改属性、删宿主、解锁）一律返回 `LOCKED`（`issues` 里给出具体宿主与位置）；
`ui` / `human` / `local` / `cli` 照常可写（检查器里的锁定开关是 WP2.5）。锁在存储层拦一次，
所以变更集、`vdm_history_undo` 与 CLI 走的是同一条规则。
**已知边界**：MCP 的 `vdm_project_apply_ops` 由项目运行时以 `local` 身份代写（`engine/server.js`，不在 WP2.2
的改动范围），因此它不会被锁定拦住；`vdm_changeset_*`（默认 `agent:mcp`）以及任何显式 `agent:*` 身份会被拦。
Agent 身份在 WP2.4 统一之后两者一致。

`job_get` 状态：queued / preparing / rendering / encoding / cancelling / succeeded /
failed / cancelled / interrupted。`cancel` 表示请求取消，终态 cancelled 才表示工作进程已经退出。
sourceRev 指产物来源，不随后续编辑改变。重启后未完成任务标为 interrupted，不自动重复执行。

业务失败返回 `isError: true` 与 `structuredContent.error`，含 code / message / retryable；
字段问题、currentRev 等按适用情况提供。JSON-RPC 的未知方法、解析失败与初始化错误使用协议错误。
请求取消不会回滚已提交事务，也不隐式取消已接收的渲染任务；任务使用专门的 cancel 工具。

## 资源

- `vdm://project/summary`：当前摘要。
- `vdm://project/schema`：公开编辑 schema。
- `vdm://artifacts/{jobId}`：已完成的 PNG 图像。

资源是补充入口，agent 所需上下文也可全部通过 tools 获得。当前只实现本地 stdio；
HTTP + SSE 是应用内部协议，不是 MCP Streamable HTTP。

## 验证

`npm test` 包含 stdio 分片、Unicode、生命周期、schema、冲突、两个独立连接的重试与真实静帧回读。
没有 Blender 时真实图像用例明确跳过，其余协议测试仍执行。客户端交互体验以实际目标客户端为准。
