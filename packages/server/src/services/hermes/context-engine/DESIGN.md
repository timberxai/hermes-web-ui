# Context Engine — 群聊上下文压缩模块

## 1. 概述

### 1.1 问题

当前群聊系统中，`AgentClient.handleUserMessage()` 每次调用 Hermes gateway `/v1/runs` 时只发送：

```json
{ "input": "<@agent 消息内容>", "session_id": "<临时ID>" }
```

每次交互都创建一个全新的 Hermes session，run 完成后立即删除。Agent 没有任何历史记忆，无法理解上下文、跟踪任务进度、记住已做出的决策。

### 1.2 目标

构建 `context-engine` 模块，在调用 `/v1/runs` 前：

1. 从 SQLite 获取群聊历史消息
2. 压缩历史为紧凑的摘要 + 近期原文
3. 通过 `conversation_history` 参数注入压缩后的上下文
4. 为每个 agent 生成身份感知的系统指令（`instructions`）

### 1.3 设计原则

- **不修改 Hermes 代码**：所有压缩逻辑在 Web UI 端完成
- **降级优先**：压缩失败时静默回退到当前无上下文行为，不影响核心功能
- **增量更新**：缓存摘要，只对新消息做增量合并，避免每次全量摘要
- **复用现有基础设施**：通过 `/v1/runs` 调用 LLM 做摘要（无本地 LLM）

---

## 2. 目录结构

```
packages/server/src/services/hermes/context-engine/
├── index.ts              # 公共 API：ContextEngine 类，工厂函数
├── types.ts              # 所有接口和类型定义
├── compressor.ts         # 核心压缩算法（三区域分割、摘要编排）
├── summary-cache.ts      # 内存缓存，per room+agent
├── prompt.ts             # 系统提示词和摘要生成指令模板
└── gateway-client.ts     # 调用 Hermes /v1/runs 做 LLM 摘要的封装
```

---

## 3. 核心接口

### 3.1 消息类型

```typescript
// 来自 SQLite messages 表的原始消息
interface StoredMessage {
  id: string
  roomId: string
  senderId: string       // Socket.IO socket ID
  senderName: string     // 显示名
  content: string
  timestamp: number      // Unix ms
}
```

### 3.2 压缩配置

```typescript
interface CompressionConfig {
  maxHistoryTokens: number        // conversation_history 最大 token 数，默认 4000
  tailMessageCount: number        // 保留的最近消息条数，默认 10
  headMessageCount: number        // 保留的最早消息条数，默认 4
  charsPerToken: number           // 字符/token 估算比率，默认 4
  summaryTtlMs: number            // 缓存摘要有效期，默认 120_000 (2分钟)
  summarizationTimeoutMs: number  // LLM 摘要超时，默认 30_000
}
```

### 3.3 压缩输出

```typescript
interface CompressedContext {
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>
  instructions: string
  meta: {
    totalMessages: number
    summarizedCount: number
    verbatimHeadCount: number
    verbatimTailCount: number
    summaryTokenEstimate: number
    cacheHit: boolean
  }
}
```

### 3.4 缓存条目

```typescript
interface SummaryCacheEntry {
  summaryContent: string          // 摘要文本
  lastSummarizedTimestamp: number // 最后一条被摘要的消息时间戳
  createdAt: number               // 缓存创建时间
  messageCountAtCreation: number  // 摘要时的消息总数
}
```

### 3.5 依赖注入接口

```typescript
interface MessageFetcher {
  getMessages(roomId: string, limit?: number): StoredMessage[]
}

interface GatewayCaller {
  summarize(
    upstream: string,
    apiKey: string | null,
    systemPrompt: string,
    messages: StoredMessage[],
    previousSummary?: string,
  ): Promise<string>
}
```

---

## 4. 压缩算法

借鉴 Hermes Agent `context_compressor.py` 的三区域模型，针对群聊场景简化。

### 4.1 三区域分割

给定 N 条消息：

```
[Head] ────── [Middle] ────── [Tail]
verbatim       summarized      verbatim
```

| 区域 | 范围 | 处理方式 |
|------|------|----------|
| Head | 前 `headMessageCount` (4) 条 | 原文保留 |
| Tail | 后 `tailMessageCount` (10) 条 | 原文保留 |
| Middle | Head 和 Tail 之间的所有消息 | LLM 摘要压缩 |

当 N ≤ `headMessageCount + tailMessageCount` 时，无需摘要，全部原文保留。

### 4.2 摘要策略

**缓存键**：`${roomId}:${agentId}`

| 场景 | 行为 |
|------|------|
| 无缓存 | 全量摘要：将 Middle 所有消息发送给 LLM 生成摘要 |
| 有缓存 + 无新消息 | 缓存命中：直接复用已有摘要 |
| 有缓存 + 有新消息 | 增量更新：将旧摘要 + 新消息发送给 LLM 合并更新 |

### 4.3 角色映射

`/v1/runs` 的 `conversation_history` 只接受 `user` 和 `assistant` 两种角色。群聊多人消息需要映射：

| 消息来源 | 映射角色 | content 格式 |
|----------|----------|-------------|
| Agent 自身 | `assistant` | 原文内容 |
| 其他所有人 | `user` | `[Name]: 原文内容` |

### 4.4 输出组装

```typescript
const history = []

// 1. 注入摘要（如有）
if (summaryContent) {
  history.push(
    { role: 'user', content: '[Previous conversation summary for context]\n' + summaryContent },
    { role: 'assistant', content: 'I have reviewed the conversation history and understand the context.' },
  )
}

// 2. Head 原文
history.push(...headMessages.map(mapToHistoryMessage))

// 3. Tail 原文
history.push(...tailMessages.map(mapToHistoryMessage))
```

### 4.5 Token 预算控制

无 tiktoken 环境，使用字符数估算：

```typescript
estimateTokens(messages) = ceil(totalChars / charsPerToken)
```

- 英文：约 4 字符/token
- 中文：约 1-2 字符/token（保守估算，不会超出）

当估算 token 超过 `maxHistoryTokens` 时，从 Tail 末尾向前裁剪消息直到满足预算。

---

## 5. 系统提示词设计

### 5.1 Agent 身份指令（`instructions` 字段）

每次 `/v1/runs` 调用时通过 `instructions` 字段发送，告知 agent 其身份和群聊规则：

```
You are "{agentName}", an AI assistant in a group chat room called "{roomName}".

Your role: {agentDescription}

Current members in this room: {member1}, {member2}, ...

Rules:
- You were mentioned with @{agentName} to respond. Focus on addressing the person who mentioned you.
- Keep your answer concise and helpful for the group context.
- Do not pretend to be a human. Identify yourself clearly when needed.
- The conversation history includes messages from multiple people, prefixed with their names.
- A previous conversation summary may be provided at the start for earlier context.
- Respond to the latest message that mentioned you.
```

### 5.2 摘要生成指令

用于 LLM 摘要调用的系统提示词：

```
You are a conversation summarizer for a group chat. Create a concise but informative summary
that helps an AI assistant understand the conversation context.

Include these key elements:
1. **Current topic/goal**: What is the group currently discussing or trying to accomplish?
2. **Key participants**: Who is actively involved? Note any @mentions directed at specific agents.
3. **Decisions made**: Any conclusions or agreements reached.
4. **Pending items**: Questions unanswered, tasks not completed.
5. **Recent agent actions**: What AI assistants were last asked to do and how they responded.
6. **Important context**: Errors, URLs, code snippets, or facts important to remember.

Rules:
- Be factual. Do not invent information.
- Keep it concise (under 500 words when possible).
- Focus on information that helps an AI respond intelligently to the next message.
- Use the same language as the conversation.
- Do not respond to the conversation. Only produce the summary.
```

**增量更新时的用户输入**：

```
The conversation has continued since the last summary. Please update the summary to incorporate
the new messages. Keep the same format but update all sections. Output ONLY the updated summary.
```

**首次摘要时的用户输入**：

```
Please create a concise summary of the conversation above. Output ONLY the summary.
```

---

## 6. 缓存策略

### 6.1 存储结构

内存 `Map<string, SummaryCacheEntry>`，键为 `${roomId}:${agentId}`。

### 6.2 生命周期

| 事件 | 行为 |
|------|------|
| 摘要生成成功 | 写入/更新缓存条目 |
| 缓存 TTL 过期（2分钟） | 下次调用时重新摘要 |
| 房间删除 | `invalidateRoom(roomId)` 清除该房间所有条目 |
| Agent 移除 | `delete(roomId, agentId)` 清除该条目 |
| 服务重启 | 缓存为空，首次调用时懒加载重建 |

### 6.3 内存估算

典型场景：10 个房间 × 5 个 agent = 50 条缓存，每条约 2-5KB 文本，总计 < 1MB。无需 LRU 淘汰，但可预留 200 条上限作为安全阀。

---

## 7. 集成方案

### 7.1 修改 `AgentClient`（agent-clients.ts）

**新增字段**：

```typescript
readonly description: string        // 从 AgentConfig 中存储
private contextEngine: ContextEngine | null = null
private storage: MessageFetcher | null = null
```

**新增方法**：

```typescript
setDescription(desc: string): void
setContextEngine(engine: ContextEngine): void
setStorage(storage: MessageFetcher): void
```

**修改 `handleUserMessage()`**：

在 `/v1/runs` fetch 调用前，插入上下文构建逻辑：

```typescript
private async handleUserMessage(roomId: string, msg: MessageData): Promise<void> {
  // ... 现有的过滤和 gateway 解析逻辑 ...

  let conversationHistory: Array<{role: string; content: string}> = []
  let instructions: string | undefined

  if (this.contextEngine && this.storage) {
    try {
      const ctx = await this.contextEngine.buildContext({
        roomId,
        agentId: this.agentId,
        agentName: this.name,
        agentDescription: this.description,
        agentSocketId: this.socket?.id || '',
        roomName: roomId,
        memberNames: [],       // 由外部注入
        upstream,
        apiKey,
        currentMessage: msg,
      })
      conversationHistory = ctx.conversationHistory
      instructions = ctx.instructions
    } catch (err: any) {
      console.warn(`[AgentClients] ${this.name}: context engine failed: ${err.message}`)
      // 降级：不带上下文继续
    }
  }

  const runRes = await fetch(`${upstream}/v1/runs`, {
    // ...
    body: JSON.stringify({
      input: msg.content,
      session_id: sessionId,
      ...(conversationHistory.length > 0 ? { conversation_history: conversationHistory } : {}),
      ...(instructions ? { instructions } : {}),
    }),
  })
  // ... 后续不变 ...
}
```

### 7.2 修改 `AgentClients`（agent-clients.ts）

新增传播方法（与现有 `setGatewayManager()` 模式一致）：

```typescript
setContextEngine(engine: ContextEngine): void {
  this.rooms.forEach(room =>
    room.forEach(client => client.setContextEngine(engine))
  )
}

setStorage(storage: MessageFetcher): void {
  this.rooms.forEach(room =>
    room.forEach(client => client.setStorage(storage))
  )
}
```

### 7.3 修改 `GroupChatServer`（index.ts）

在构造函数中创建 `ContextEngine` 并注入依赖：

```typescript
import { ContextEngine } from '../context-engine'

// 在 constructor 中，GroupChatServer 初始化后：
const contextEngine = new ContextEngine({
  messageFetcher: this.storage,  // ChatStorage 已有 getMessages(roomId, limit)
})

this.agentClients.setContextEngine(contextEngine)
this.agentClients.setStorage(this.storage)
```

`ChatStorage.getMessages(roomId, limit)` 的签名已匹配 `MessageFetcher` 接口，无需适配。

---

## 8. 降级策略

压缩是增强功能，不是必要条件。所有失败场景都应静默降级：

| 失败场景 | 行为 |
|----------|------|
| `ContextEngine` 未设置 | 跳过上下文构建，发送原始消息（当前行为） |
| `ChatStorage` 未设置 | 同上 |
| LLM 摘要调用失败（超时/5xx） | 日志警告，不带历史继续 |
| LLM 返回空/乱码 | 检测空响应，回退到无摘要 |
| Gateway 不可达 | 捕获 fetch 错误，日志，不带历史继续 |
| Token 超预算 | 裁剪 Tail 消息至预算内 |
| 缓存损坏 | 删除条目，重新全量摘要 |

---

## 9. Gateway 客户端（LLM 摘要）

`GatewaySummarizer` 封装对 Hermes `/v1/runs` 的摘要调用：

- 使用临时 `session_id`（不持久化）
- 非流式：等待 `run.completed` 获取完整响应
- 独立超时（30s，短于 agent 调用的 120s）
- 通过 EventSource SSE 获取结果

```typescript
class GatewaySummarizer implements GatewayCaller {
  async summarize(
    upstream: string,
    apiKey: string | null,
    systemPrompt: string,
    messages: StoredMessage[],
    previousSummary?: string,
  ): Promise<string> {
    // 1. 构建 conversation_history
    const history = messages.map(m => ({
      role: 'user' as const,
      content: `[${m.senderName}]: ${m.content}`,
    }))

    // 2. 如有旧摘要，注入到 history 开头
    if (previousSummary) {
      history.unshift(
        { role: 'user', content: `[Previous summary]\n${previousSummary}` },
        { role: 'assistant', content: 'Understood, I will update the summary.' },
      )
    }

    // 3. 调用 /v1/runs
    const { run_id } = await fetch(`${upstream}/v1/runs`, { ... })
    return this.pollForResult(upstream, apiKey, run_id)
  }
}
```

---

## 10. 实现顺序

| 步骤 | 文件 | 说明 |
|------|------|------|
| 1 | `types.ts` | 定义所有接口和类型 |
| 2 | `prompt.ts` | 系统提示词和摘要指令模板 |
| 3 | `summary-cache.ts` | 内存缓存实现 |
| 4 | `gateway-client.ts` | `GatewaySummarizer` 类 |
| 5 | `compressor.ts` | `ContextEngine` 主类（三区域分割、摘要编排、历史组装） |
| 6 | `index.ts` | 公共 API 导出 |
| 7 | `agent-clients.ts` | 修改 `AgentClient`：新增字段、方法、修改 `handleUserMessage()` |
| 8 | `agent-clients.ts` | 修改 `AgentClients`：新增 `setContextEngine()`、`setStorage()` |
| 9 | `group-chat/index.ts` | 修改 `GroupChatServer`：创建 `ContextEngine` 并注入 |
| 10 | `tests/server/context-engine.test.ts` | 单元测试和集成测试 |

---

## 附录：`/v1/runs` API 合约

**请求**：

```json
POST /v1/runs
{
  "input": "string | Array<{role, content}>",
  "instructions": "string (可选，系统指令)",
  "conversation_history": "Array<{role: string, content: string}> (可选)",
  "session_id": "string (可选)"
}
```

- `conversation_history` 严格验证：每项必须有 `role` 和 `content` 字段，值强制转为 string
- `input` 为当前用户消息，追加在 `conversation_history` 之后
- 两者共存时 `input` 提供当前消息，`conversation_history` 提供历史上下文

**响应**：

```json
HTTP 202
{ "run_id": "run_<uuid>", "status": "started" }
```

**SSE 事件流**（`GET /v1/runs/{run_id}/events`）：

| 事件 | 关键字段 |
|------|----------|
| `message` | `delta` — 流式文本片段 |
| `tool.started` | `tool`, `preview` |
| `tool.completed` | `tool`, `duration`, `error` |
| `run.completed` | `output` — 完整回复文本 |
| `run.failed` | `error` — 失败原因 |
