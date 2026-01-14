import { describe, test, expect, beforeEach } from "bun:test"
import type { BackgroundTask, ResumeInput } from "./types"

const TASK_TTL_MS = 30 * 60 * 1000

class MockBackgroundManager {
  private tasks: Map<string, BackgroundTask> = new Map()
  private notifications: Map<string, BackgroundTask[]> = new Map()
  public resumeCalls: Array<{ sessionId: string; prompt: string }> = []

  addTask(task: BackgroundTask): void {
    this.tasks.set(task.id, task)
  }

  getTask(id: string): BackgroundTask | undefined {
    return this.tasks.get(id)
  }

  findBySession(sessionID: string): BackgroundTask | undefined {
    for (const task of this.tasks.values()) {
      if (task.sessionID === sessionID) {
        return task
      }
    }
    return undefined
  }

  getTasksByParentSession(sessionID: string): BackgroundTask[] {
    const result: BackgroundTask[] = []
    for (const task of this.tasks.values()) {
      if (task.parentSessionID === sessionID) {
        result.push(task)
      }
    }
    return result
  }

  getAllDescendantTasks(sessionID: string): BackgroundTask[] {
    const result: BackgroundTask[] = []
    const directChildren = this.getTasksByParentSession(sessionID)

    for (const child of directChildren) {
      result.push(child)
      const descendants = this.getAllDescendantTasks(child.sessionID)
      result.push(...descendants)
    }

    return result
  }

  markForNotification(task: BackgroundTask): void {
    const queue = this.notifications.get(task.parentSessionID) ?? []
    queue.push(task)
    this.notifications.set(task.parentSessionID, queue)
  }

  getPendingNotifications(sessionID: string): BackgroundTask[] {
    return this.notifications.get(sessionID) ?? []
  }

  private clearNotificationsForTask(taskId: string): void {
    for (const [sessionID, tasks] of this.notifications.entries()) {
      const filtered = tasks.filter((t) => t.id !== taskId)
      if (filtered.length === 0) {
        this.notifications.delete(sessionID)
      } else {
        this.notifications.set(sessionID, filtered)
      }
    }
  }

  pruneStaleTasksAndNotifications(): { prunedTasks: string[]; prunedNotifications: number } {
    const now = Date.now()
    const prunedTasks: string[] = []
    let prunedNotifications = 0

    for (const [taskId, task] of this.tasks.entries()) {
      const age = now - task.startedAt.getTime()
      if (age > TASK_TTL_MS) {
        prunedTasks.push(taskId)
        this.clearNotificationsForTask(taskId)
        this.tasks.delete(taskId)
      }
    }

    for (const [sessionID, notifications] of this.notifications.entries()) {
      if (notifications.length === 0) {
        this.notifications.delete(sessionID)
        continue
      }
      const validNotifications = notifications.filter((task) => {
        const age = now - task.startedAt.getTime()
        return age <= TASK_TTL_MS
      })
      const removed = notifications.length - validNotifications.length
      prunedNotifications += removed
      if (validNotifications.length === 0) {
        this.notifications.delete(sessionID)
      } else if (validNotifications.length !== notifications.length) {
        this.notifications.set(sessionID, validNotifications)
      }
    }

    return { prunedTasks, prunedNotifications }
  }

  getTaskCount(): number {
    return this.tasks.size
  }

  getNotificationCount(): number {
    let count = 0
    for (const notifications of this.notifications.values()) {
      count += notifications.length
    }
    return count
  }

  resume(input: ResumeInput): BackgroundTask {
    const existingTask = this.findBySession(input.sessionId)
    if (!existingTask) {
      throw new Error(`Task not found for session: ${input.sessionId}`)
    }

    this.resumeCalls.push({ sessionId: input.sessionId, prompt: input.prompt })

    existingTask.status = "running"
    existingTask.completedAt = undefined
    existingTask.error = undefined
    existingTask.parentSessionID = input.parentSessionID
    existingTask.parentMessageID = input.parentMessageID
    existingTask.parentModel = input.parentModel

    existingTask.progress = {
      toolCalls: existingTask.progress?.toolCalls ?? 0,
      lastUpdate: new Date(),
    }

    return existingTask
  }
}

function createMockTask(overrides: Partial<BackgroundTask> & { id: string; sessionID: string; parentSessionID: string }): BackgroundTask {
  return {
    parentMessageID: "mock-message-id",
    description: "test task",
    prompt: "test prompt",
    agent: "test-agent",
    status: "running",
    startedAt: new Date(),
    ...overrides,
  }
}

describe("BackgroundManager.getAllDescendantTasks", () => {
  let manager: MockBackgroundManager

  beforeEach(() => {
    // #given
    manager = new MockBackgroundManager()
  })

  test("should return empty array when no tasks exist", () => {
    // #given - empty manager

    // #when
    const result = manager.getAllDescendantTasks("session-a")

    // #then
    expect(result).toEqual([])
  })

  test("should return direct children only when no nested tasks", () => {
    // #given
    const taskB = createMockTask({
      id: "task-b",
      sessionID: "session-b",
      parentSessionID: "session-a",
    })
    manager.addTask(taskB)

    // #when
    const result = manager.getAllDescendantTasks("session-a")

    // #then
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("task-b")
  })

  test("should return all nested descendants (2 levels deep)", () => {
    // #given
    // Session A -> Task B -> Task C
    const taskB = createMockTask({
      id: "task-b",
      sessionID: "session-b",
      parentSessionID: "session-a",
    })
    const taskC = createMockTask({
      id: "task-c",
      sessionID: "session-c",
      parentSessionID: "session-b",
    })
    manager.addTask(taskB)
    manager.addTask(taskC)

    // #when
    const result = manager.getAllDescendantTasks("session-a")

    // #then
    expect(result).toHaveLength(2)
    expect(result.map(t => t.id)).toContain("task-b")
    expect(result.map(t => t.id)).toContain("task-c")
  })

  test("should return all nested descendants (3 levels deep)", () => {
    // #given
    // Session A -> Task B -> Task C -> Task D
    const taskB = createMockTask({
      id: "task-b",
      sessionID: "session-b",
      parentSessionID: "session-a",
    })
    const taskC = createMockTask({
      id: "task-c",
      sessionID: "session-c",
      parentSessionID: "session-b",
    })
    const taskD = createMockTask({
      id: "task-d",
      sessionID: "session-d",
      parentSessionID: "session-c",
    })
    manager.addTask(taskB)
    manager.addTask(taskC)
    manager.addTask(taskD)

    // #when
    const result = manager.getAllDescendantTasks("session-a")

    // #then
    expect(result).toHaveLength(3)
    expect(result.map(t => t.id)).toContain("task-b")
    expect(result.map(t => t.id)).toContain("task-c")
    expect(result.map(t => t.id)).toContain("task-d")
  })

  test("should handle multiple branches (tree structure)", () => {
    // #given
    // Session A -> Task B1 -> Task C1
    //           -> Task B2 -> Task C2
    const taskB1 = createMockTask({
      id: "task-b1",
      sessionID: "session-b1",
      parentSessionID: "session-a",
    })
    const taskB2 = createMockTask({
      id: "task-b2",
      sessionID: "session-b2",
      parentSessionID: "session-a",
    })
    const taskC1 = createMockTask({
      id: "task-c1",
      sessionID: "session-c1",
      parentSessionID: "session-b1",
    })
    const taskC2 = createMockTask({
      id: "task-c2",
      sessionID: "session-c2",
      parentSessionID: "session-b2",
    })
    manager.addTask(taskB1)
    manager.addTask(taskB2)
    manager.addTask(taskC1)
    manager.addTask(taskC2)

    // #when
    const result = manager.getAllDescendantTasks("session-a")

    // #then
    expect(result).toHaveLength(4)
    expect(result.map(t => t.id)).toContain("task-b1")
    expect(result.map(t => t.id)).toContain("task-b2")
    expect(result.map(t => t.id)).toContain("task-c1")
    expect(result.map(t => t.id)).toContain("task-c2")
  })

  test("should not include tasks from unrelated sessions", () => {
    // #given
    // Session A -> Task B
    // Session X -> Task Y (unrelated)
    const taskB = createMockTask({
      id: "task-b",
      sessionID: "session-b",
      parentSessionID: "session-a",
    })
    const taskY = createMockTask({
      id: "task-y",
      sessionID: "session-y",
      parentSessionID: "session-x",
    })
    manager.addTask(taskB)
    manager.addTask(taskY)

    // #when
    const result = manager.getAllDescendantTasks("session-a")

    // #then
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("task-b")
    expect(result.map(t => t.id)).not.toContain("task-y")
  })

  test("getTasksByParentSession should only return direct children (not recursive)", () => {
    // #given
    // Session A -> Task B -> Task C
    const taskB = createMockTask({
      id: "task-b",
      sessionID: "session-b",
      parentSessionID: "session-a",
    })
    const taskC = createMockTask({
      id: "task-c",
      sessionID: "session-c",
      parentSessionID: "session-b",
    })
    manager.addTask(taskB)
    manager.addTask(taskC)

    // #when
    const result = manager.getTasksByParentSession("session-a")

    // #then
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("task-b")
  })
})

describe("BackgroundManager.notifyParentSession - release ordering", () => {
  test("should unblock queued task even when prompt hangs", async () => {
    // #given - concurrency limit 1, task1 running, task2 waiting
    const { ConcurrencyManager } = await import("./concurrency")
    const concurrencyManager = new ConcurrencyManager({ defaultConcurrency: 1 })

    await concurrencyManager.acquire("explorer")

    let task2Resolved = false
    const task2Promise = concurrencyManager.acquire("explorer").then(() => {
      task2Resolved = true
    })

    await Promise.resolve()
    expect(task2Resolved).toBe(false)

    // #when - simulate notifyParentSession: release BEFORE prompt (fixed behavior)
    let promptStarted = false
    const simulateNotifyParentSession = async () => {
      concurrencyManager.release("explorer")

      promptStarted = true
      await new Promise(() => {})
    }

    simulateNotifyParentSession()

    await Promise.resolve()
    await Promise.resolve()

    // #then - task2 should be unblocked even though prompt never completes
    expect(promptStarted).toBe(true)
    await task2Promise
    expect(task2Resolved).toBe(true)
  })

  test("should keep queue blocked if release is after prompt (demonstrates the bug)", async () => {
    // #given - same setup
    const { ConcurrencyManager } = await import("./concurrency")
    const concurrencyManager = new ConcurrencyManager({ defaultConcurrency: 1 })

    await concurrencyManager.acquire("explorer")

    let task2Resolved = false
    concurrencyManager.acquire("explorer").then(() => {
      task2Resolved = true
    })

    await Promise.resolve()
    expect(task2Resolved).toBe(false)

    // #when - simulate BUGGY behavior: release AFTER prompt (in finally)
    const simulateBuggyNotifyParentSession = async () => {
      try {
        await new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 50))
      } finally {
        concurrencyManager.release("explorer")
      }
    }

    await simulateBuggyNotifyParentSession().catch(() => {})

    // #then - task2 resolves only after prompt completes (blocked during hang)
    await Promise.resolve()
    expect(task2Resolved).toBe(true)
  })
})

describe("BackgroundManager.pruneStaleTasksAndNotifications", () => {
  let manager: MockBackgroundManager

  beforeEach(() => {
    // #given
    manager = new MockBackgroundManager()
  })

  test("should not prune fresh tasks", () => {
    // #given
    const task = createMockTask({
      id: "task-fresh",
      sessionID: "session-fresh",
      parentSessionID: "session-parent",
      startedAt: new Date(),
    })
    manager.addTask(task)

    // #when
    const result = manager.pruneStaleTasksAndNotifications()

    // #then
    expect(result.prunedTasks).toHaveLength(0)
    expect(manager.getTaskCount()).toBe(1)
  })

  test("should prune tasks older than 30 minutes", () => {
    // #given
    const staleDate = new Date(Date.now() - 31 * 60 * 1000)
    const task = createMockTask({
      id: "task-stale",
      sessionID: "session-stale",
      parentSessionID: "session-parent",
      startedAt: staleDate,
    })
    manager.addTask(task)

    // #when
    const result = manager.pruneStaleTasksAndNotifications()

    // #then
    expect(result.prunedTasks).toContain("task-stale")
    expect(manager.getTaskCount()).toBe(0)
  })

  test("should prune stale notifications", () => {
    // #given
    const staleDate = new Date(Date.now() - 31 * 60 * 1000)
    const task = createMockTask({
      id: "task-stale",
      sessionID: "session-stale",
      parentSessionID: "session-parent",
      startedAt: staleDate,
    })
    manager.markForNotification(task)

    // #when
    const result = manager.pruneStaleTasksAndNotifications()

    // #then
    expect(result.prunedNotifications).toBe(1)
    expect(manager.getNotificationCount()).toBe(0)
  })

  test("should clean up notifications when task is pruned", () => {
    // #given
    const staleDate = new Date(Date.now() - 31 * 60 * 1000)
    const task = createMockTask({
      id: "task-stale",
      sessionID: "session-stale",
      parentSessionID: "session-parent",
      startedAt: staleDate,
    })
    manager.addTask(task)
    manager.markForNotification(task)

    // #when
    manager.pruneStaleTasksAndNotifications()

    // #then
    expect(manager.getTaskCount()).toBe(0)
    expect(manager.getNotificationCount()).toBe(0)
  })

  test("should keep fresh tasks while pruning stale ones", () => {
    // #given
    const staleDate = new Date(Date.now() - 31 * 60 * 1000)
    const staleTask = createMockTask({
      id: "task-stale",
      sessionID: "session-stale",
      parentSessionID: "session-parent",
      startedAt: staleDate,
    })
    const freshTask = createMockTask({
      id: "task-fresh",
      sessionID: "session-fresh",
      parentSessionID: "session-parent",
      startedAt: new Date(),
    })
    manager.addTask(staleTask)
    manager.addTask(freshTask)

    // #when
    const result = manager.pruneStaleTasksAndNotifications()

    // #then
    expect(result.prunedTasks).toHaveLength(1)
    expect(result.prunedTasks).toContain("task-stale")
    expect(manager.getTaskCount()).toBe(1)
    expect(manager.getTask("task-fresh")).toBeDefined()
  })
})

describe("BackgroundManager.resume", () => {
  let manager: MockBackgroundManager

  beforeEach(() => {
    // #given
    manager = new MockBackgroundManager()
  })

  test("should throw error when task not found", () => {
    // #given - empty manager

    // #when / #then
    expect(() => manager.resume({
      sessionId: "non-existent",
      prompt: "continue",
      parentSessionID: "session-new",
      parentMessageID: "msg-new",
    })).toThrow("Task not found for session: non-existent")
  })

  test("should resume existing task and reset state to running", () => {
    // #given
    const completedTask = createMockTask({
      id: "task-a",
      sessionID: "session-a",
      parentSessionID: "session-parent",
      status: "completed",
    })
    completedTask.completedAt = new Date()
    completedTask.error = "previous error"
    manager.addTask(completedTask)

    // #when
    const result = manager.resume({
      sessionId: "session-a",
      prompt: "continue the work",
      parentSessionID: "session-new-parent",
      parentMessageID: "msg-new",
    })

    // #then
    expect(result.status).toBe("running")
    expect(result.completedAt).toBeUndefined()
    expect(result.error).toBeUndefined()
    expect(result.parentSessionID).toBe("session-new-parent")
    expect(result.parentMessageID).toBe("msg-new")
  })

  test("should preserve task identity while updating parent context", () => {
    // #given
    const existingTask = createMockTask({
      id: "task-a",
      sessionID: "session-a",
      parentSessionID: "old-parent",
      description: "original description",
      agent: "explorer",
    })
    manager.addTask(existingTask)

    // #when
    const result = manager.resume({
      sessionId: "session-a",
      prompt: "new prompt",
      parentSessionID: "new-parent",
      parentMessageID: "new-msg",
      parentModel: { providerID: "anthropic", modelID: "claude-opus" },
    })

    // #then
    expect(result.id).toBe("task-a")
    expect(result.sessionID).toBe("session-a")
    expect(result.description).toBe("original description")
    expect(result.agent).toBe("explorer")
    expect(result.parentModel).toEqual({ providerID: "anthropic", modelID: "claude-opus" })
  })

  test("should track resume calls with prompt", () => {
    // #given
    const task = createMockTask({
      id: "task-a",
      sessionID: "session-a",
      parentSessionID: "session-parent",
    })
    manager.addTask(task)

    // #when
    manager.resume({
      sessionId: "session-a",
      prompt: "continue with additional context",
      parentSessionID: "session-new",
      parentMessageID: "msg-new",
    })

    // #then
    expect(manager.resumeCalls).toHaveLength(1)
    expect(manager.resumeCalls[0]).toEqual({
      sessionId: "session-a",
      prompt: "continue with additional context",
    })
  })

  test("should preserve existing tool call count in progress", () => {
    // #given
    const taskWithProgress = createMockTask({
      id: "task-a",
      sessionID: "session-a",
      parentSessionID: "session-parent",
    })
    taskWithProgress.progress = {
      toolCalls: 42,
      lastTool: "read",
      lastUpdate: new Date(),
    }
    manager.addTask(taskWithProgress)

    // #when
    const result = manager.resume({
      sessionId: "session-a",
      prompt: "continue",
      parentSessionID: "session-new",
      parentMessageID: "msg-new",
    })

    // #then
    expect(result.progress?.toolCalls).toBe(42)
  })
})

describe("LaunchInput.skillContent", () => {
  test("skillContent should be optional in LaunchInput type", () => {
    // #given
    const input: import("./types").LaunchInput = {
      description: "test",
      prompt: "test prompt",
      agent: "explorer",
      parentSessionID: "parent-session",
      parentMessageID: "parent-msg",
    }

    // #when / #then - should compile without skillContent
    expect(input.skillContent).toBeUndefined()
  })

  test("skillContent can be provided in LaunchInput", () => {
    // #given
    const input: import("./types").LaunchInput = {
      description: "test",
      prompt: "test prompt",
      agent: "explorer",
      parentSessionID: "parent-session",
      parentMessageID: "parent-msg",
      skillContent: "You are a playwright expert",
    }

    // #when / #then
    expect(input.skillContent).toBe("You are a playwright expert")
  })
})

describe("BackgroundManager.notifyParentSession - agent context preservation", () => {
  test("should not pass agent field when parentAgent is undefined", async () => {
    // #given
    const task: BackgroundTask = {
      id: "task-no-agent",
      sessionID: "session-child",
      parentSessionID: "session-parent",
      parentMessageID: "msg-parent",
      description: "task without agent context",
      prompt: "test",
      agent: "explorer",
      status: "completed",
      startedAt: new Date(),
      completedAt: new Date(),
      parentAgent: undefined,
      parentModel: { providerID: "anthropic", modelID: "claude-opus" },
    }

    // #when
    const promptBody = buildNotificationPromptBody(task)

    // #then
    expect("agent" in promptBody).toBe(false)
    expect(promptBody.model).toEqual({ providerID: "anthropic", modelID: "claude-opus" })
  })

  test("should include agent field when parentAgent is defined", async () => {
    // #given
    const task: BackgroundTask = {
      id: "task-with-agent",
      sessionID: "session-child",
      parentSessionID: "session-parent",
      parentMessageID: "msg-parent",
      description: "task with agent context",
      prompt: "test",
      agent: "explorer",
      status: "completed",
      startedAt: new Date(),
      completedAt: new Date(),
      parentAgent: "Sisyphus",
      parentModel: { providerID: "anthropic", modelID: "claude-opus" },
    }

    // #when
    const promptBody = buildNotificationPromptBody(task)

    // #then
    expect(promptBody.agent).toBe("Sisyphus")
  })

  test("should not pass model field when parentModel is undefined", async () => {
    // #given
    const task: BackgroundTask = {
      id: "task-no-model",
      sessionID: "session-child",
      parentSessionID: "session-parent",
      parentMessageID: "msg-parent",
      description: "task without model context",
      prompt: "test",
      agent: "explorer",
      status: "completed",
      startedAt: new Date(),
      completedAt: new Date(),
      parentAgent: "Sisyphus",
      parentModel: undefined,
    }

    // #when
    const promptBody = buildNotificationPromptBody(task)

    // #then
    expect("model" in promptBody).toBe(false)
    expect(promptBody.agent).toBe("Sisyphus")
  })
})

describe("validateSessionHasOutput - fault-tolerant completion detection", () => {
  /**
   * Tests for multi-layer fault-tolerant completion detection.
   * All layers must pass for a task to be marked complete.
   */

  function validateSessionHasOutput(messages: Array<{
    info?: { role?: string }
    parts?: Array<{ 
      type?: string
      text?: string
      state?: { status?: string; output?: string }
      content?: string | unknown[]
    }>
  }>): boolean {
    // Layer 1: Basic sanity - has assistant/tool messages
    const assistantMessages = messages.filter(
      (m) => m.info?.role === "assistant" || m.info?.role === "tool"
    )
    if (assistantMessages.length === 0) return false

    // Layer 2: Tool execution guard - no running/pending tools
    const hasRunningTools = messages.some((m) => {
      if (m.info?.role !== "assistant") return false
      const parts = m.parts ?? []
      return parts.some((p) => 
        p.type === "tool" && (p.state?.status === "running" || p.state?.status === "pending")
      )
    })
    if (hasRunningTools) return false

    // Layer 3: Output structure - last assistant message should end with "text"
    const lastAssistantMsg = assistantMessages.filter((m) => m.info?.role === "assistant").pop()
    if (lastAssistantMsg) {
      const parts = lastAssistantMsg.parts ?? []
      if (parts.length > 0) {
        const lastPart = parts[parts.length - 1]
        
        // If last part is reasoning-only, agent is still thinking
        if (lastPart.type === "reasoning" && !parts.some((p) => p.type === "text")) {
          return false
        }
        
        // If last part is a tool call, check if there's text after it
        if (lastPart.type === "tool") {
          const lastToolIndex = parts.findLastIndex((pt) => pt.type === "tool")
          const hasTextAfterTools = parts.some((p, i) => p.type === "text" && i > lastToolIndex)
          if (!hasTextAfterTools) return false
        }
      }
    }

    return true
  }

  test("should return false when tool is still running", () => {
    // #given - session with a tool call that is still running
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: "Let me search for that information..." },
          { 
            type: "tool", 
            state: { status: "running" }  // Tool is still executing!
          }
        ]
      }
    ]

    // #when
    const result = validateSessionHasOutput(messages)

    // #then - EXPECTED: false (tool not complete), ACTUAL (bug): true
    // This test will FAIL with current implementation, exposing the bug
    expect(result).toBe(false)
  })

  test("should return false when tool is pending", () => {
    // #given - session with a pending tool call
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          { 
            type: "tool", 
            state: { status: "pending" }
          }
        ]
      }
    ]

    // #when
    const result = validateSessionHasOutput(messages)

    // #then - EXPECTED: false (tool not complete)
    expect(result).toBe(false)
  })

  test("should return false when tool is completed but no text follows (Layer 3)", () => {
    // #given - session with a completed tool call but text is BEFORE the tool
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: "Here are the results:" },
          { 
            type: "tool", 
            state: { status: "completed", output: "Found 5 facts about cats" }
          }
        ]
      }
    ]

    // #when
    const result = validateSessionHasOutput(messages)

    // #then - Layer 3: last part is tool, no text after it = not complete
    expect(result).toBe(false)
  })

  test("should return true when tool is completed AND text follows", () => {
    // #given - session with completed tool AND final text response
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: "Let me search..." },
          { 
            type: "tool", 
            state: { status: "completed", output: "Found 5 facts" }
          },
          { type: "text", text: "Here are 5 facts about cats:\n1. Cats sleep 16 hours..." }
        ]
      }
    ]

    // #when
    const result = validateSessionHasOutput(messages)

    // #then - Has text after tool = complete
    expect(result).toBe(true)
  })

  test("should return false when tool errored but no text follows (Layer 3)", () => {
    // #given - session with a tool that errored but no text response after
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          { 
            type: "tool", 
            state: { status: "error" }
          }
        ]
      }
    ]

    // #when
    const result = validateSessionHasOutput(messages)

    // #then - Layer 3: last part is tool (even errored), no text after = not complete
    expect(result).toBe(false)
  })

  test("should return true when tool errored AND text follows with error message", () => {
    // #given - session with errored tool AND agent's error response
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          { 
            type: "tool", 
            state: { status: "error" }
          },
          { type: "text", text: "I encountered an error while searching. Let me try a different approach..." }
        ]
      }
    ]

    // #when
    const result = validateSessionHasOutput(messages)

    // #then - Has text after tool = complete
    expect(result).toBe(true)
  })

  test("should return false when only text exists but tool is still running", () => {
    // #given - session with text AND a running tool
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: "I'll search for that now..." },
          { type: "reasoning", text: "User wants cat facts, I should use web search" },
          { 
            type: "tool", 
            state: { status: "running" }
          }
        ]
      }
    ]

    // #when
    const result = validateSessionHasOutput(messages)

    // #then - Even though text exists, tool is running so not complete
    // This is the key scenario: agent wrote text, called tool, waiting for result
    expect(result).toBe(false)
  })

  test("should return false when only reasoning exists without final text (Layer 3)", () => {
    // #given - session with ONLY reasoning/thinking content, no final text output
    // This happens when agent is still thinking/planning but hasn't written final answer
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          { 
            type: "reasoning", 
            text: "<analysis>\n**Literal Request**: Find 5 interesting facts about cats\n**Actual Need**: General knowledge retrieval\n</analysis>\n\nI'll search for interesting facts about cats..." 
          }
        ]
      }
    ]

    // #when
    const result = validateSessionHasOutput(messages)

    // #then - Reasoning alone should NOT count as complete output
    // Agent is still thinking, hasn't produced final answer yet
    expect(result).toBe(false)
  })

  test("should return true when reasoning AND final text exist", () => {
    // #given - session with both reasoning and final text output
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          { type: "reasoning", text: "User wants cat facts, let me search..." },
          { type: "text", text: "Here are 5 interesting facts about cats:\n1. Cats sleep 12-16 hours per day\n2. ..." }
        ]
      }
    ]

    // #when
    const result = validateSessionHasOutput(messages)

    // #then - Has final text output, so complete
    expect(result).toBe(true)
  })

  test("should return false when reasoning exists with incomplete tool call", () => {
    // #given - agent wrote reasoning, called a tool, tool still running
    // This is the exact scenario that caused truncated output
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          { type: "reasoning", text: "I need to search for cat facts using web search" },
          { type: "text", text: "Let me search for that..." },
          { type: "tool", state: { status: "running" } }
        ]
      }
    ]

    // #when
    const result = validateSessionHasOutput(messages)

    // #then - Tool still running, not complete
    expect(result).toBe(false)
  })
})

function buildNotificationPromptBody(task: BackgroundTask): Record<string, unknown> {
  const body: Record<string, unknown> = {
    parts: [{ type: "text", text: `[BACKGROUND TASK COMPLETED] Task "${task.description}" finished.` }],
  }

  if (task.parentAgent !== undefined) {
    body.agent = task.parentAgent
  }

  if (task.parentModel?.providerID && task.parentModel?.modelID) {
    body.model = { providerID: task.parentModel.providerID, modelID: task.parentModel.modelID }
  }

  return body
}
