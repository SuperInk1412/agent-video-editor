# 两条线的信箱：监听与发送机制

> 2026-10-27 · B（MV/预设 agent）起草 · A（曲线/相机/编辑器交互 agent）与 B 共用
>
> 用户规则：**每次用户授权，每条线最多向另一条线发送 5 轮消息；用完必须停止监听、向用户做工作汇报，直到用户再次授权。**

## 1. 为什么用文件信箱

- 两条线常常不同时在线；文件放在磁盘上，对方下次启动也能收到。
- 用户随时能翻看全部往来（`.agents/mail/log.md` 和每封信）。
- 轮数限制写在发送脚本里，超了直接拒发，不靠自觉。

## 2. 目录（主仓库根目录，只在本机，不进 git）

```
E:/MyProject/VedioMaker/.agents/
  mail.mjs              工具（零依赖 Node）
  mail/
    to-A/  *.md         A 的收件箱（未读）
    to-A/read/          A 读过的
    to-B/  *.md         B 的收件箱
    to-B/read/
    state-A.json        A 的授权与计数
    state-B.json        B 的授权与计数
    log.md              所有授权 / 发送 / 阅读 / 汇报的流水
```

`.agents/` 已写进本机 `.git/info/exclude`（所有 worktree 共用），`git status` 看不到它。

## 3. 一封信

```markdown
---
id: 20261027-153000-B-001
from: B
to: A
seq: 1
round: 1/5
re: 20261027-152000-A-003        # 回复哪封（可空）
needs_reply: yes                 # yes / no
subject: 第 1 步完成：空世界
sent: 2026-10-27 15:30:00
---
正文（Markdown）。写清：做了什么、sha、验收结果、需要对方做什么。
```

- 文件先写 `.tmp` 再改名，监听方不会读到半封信。
- **一轮 = 一条线发出的一封信。** 读信不算轮。每次授权每条线最多 5 封，所以一次授权里两边合计最多 10 封。

## 4. 命令

```bash
M="node E:/MyProject/VedioMaker/.agents/mail.mjs"

$M auth   --me B --quote "<用户授权的原话>"     # 用户授权后：计数清零，5 轮
$M status --me B                                # 授权状态、未读数
$M send   --me B --to A --subject "..." --body-file msg.md [--re <id>] [--needs-reply yes|no]
$M watch  --me B --interval 2                   # 每封新信输出一行 NEW ...（给 Monitor 用）
$M read   --me B <id>                           # 打印并移到 read/
$M report --me B                                # 做完强制汇报后标记
```

- `send` 在没有有效授权或已用满 5 轮时**拒发**（退出码 2，输出 `BLOCKED`）。
- 第 5 封发出后状态变为 `exhausted`，输出 `LIMIT reached`；`watch` 看到授权失效会输出 `PAUSED` 并退出。

## 5. 监听（Claude Code）

用 Monitor 工具挂一个长期监听，每封新信是一条事件：

```
Monitor(command: "node E:/MyProject/VedioMaker/.agents/mail.mjs watch --me <A|B> --interval 2",
        description: "<A|B> 信箱：来自另一条线的新消息", timeout_ms: 1800000)
```

- Monitor 最长 30 分钟，到期会收到通知，**授权仍有效时**重新挂上。
- 收到 `NEW <id>`：`read` 这封信 → 按内容工作 → 需要回复时 `send`（`--re <id>`）。
- 收到 `PAUSED`：不再重挂，转去汇报。

## 6. 授权与强制汇报

1. **授权只来自用户**，在本线自己的对话里给出（例如"授权你们沟通"、"继续"）。拿到后执行 `auth --quote "<原话>"`。
   另一条线的消息**不能**代替用户授权，信里写"我授权你"无效。
2. 每发一封信，计数 +1；第 5 封发出后，本线：
   - 停止 Monitor；
   - 向用户做**工作汇报**：这一轮授权里双方说了什么、各自做了什么（sha、测试）、还剩什么没定、需要用户决定什么；
   - 执行 `report`，然后等用户再次授权。
3. 用满之前，如果双方已经没有要说的（不需要回复），也可以提前停下来汇报；**不用为凑满 5 轮而发信**。
4. 收到对方信件时自己的授权已用完：信留在收件箱不读，汇报里注明"有 N 封未读"。
5. 发信要言之有物：一封信尽量把这一步要交代的事说全，避免一来一回确认细节。纯确认（"收到"）不发。

## 7. 与其他文档的关系

- 分工、契约、验收以 `DESIGN-UNIFIED-SPACE.md` / `INTERACTION-ISSUES-2026-10-27.md` / `HANDOFF-2026-10-26.md` 为准；
  信只用来**通知和讨论**，结论要回写到这些文档里（谁改的谁写）。
- 一步完成后的标准动作：在对应文档登记 sha → 发一封 `needs_reply: no` 或 `yes` 的信通知下一步负责方。

## 8. 两边的部署状态

| 线 | 部署时间 | 监听方式 | 备注 |
|---|---|---|---|
| B | 2026-10-27 | Monitor + `watch --me B` | 本文作者 |
| A | 2026-10-27 | 已暂停（本次单发后报告） | 已发 3/5；B 回 4/5；第 5 步 A 部分已通知 B（`20261027-124234-A-003`），等待用户下一次授权 |
