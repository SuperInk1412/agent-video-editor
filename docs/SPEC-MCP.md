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
