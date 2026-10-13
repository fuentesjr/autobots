export type Phase = 'plan' | 'design' | 'delegate' | 'review' | 'close'

export type PlannedTask = {
  title: string
  role: string
  after: number[]
}

export type Flow = {
  title: string
  total: number
  done: number
  running: number
  phase: Phase
  isFinished: boolean
  tasks: PlannedTask[]
  // Autobots Mode: the main agent's direct file edits in this flow. Only the count, never what
  // was edited. Absent while the flow does not count (started only by a roster subagent spawn).
  edits?: number
  // Started by the autobots skill and not yet reported: the first progress call continues it.
  isSkillStarted?: boolean
}

export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentRun = {
  id: string
  agentId?: string
  type: string
  description: string
  model: string
  effort?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  contextTokens: number
  contextMax: number
  tokens: number
  costUsd: number
  steps: number
  round: number
  // Activity observed from the agent's own model steps. `lastTool` is display
  // text, already summarized: never the tool's raw input.
  toolCalls: number
  lastTool?: string
  lastStepAt?: number
  // When the model step that is out began; absent between steps.
  stepStartedAt?: number
  // The prompt cache, from the agent's steps; absent before its first.
  cache?: CacheStats
}

// Sums over every step, for the hit rate; the latest step, for warmth and rebuilds; and the most
// recent steps' bars for the desktop strip, packed into one string (see `packBar` in the hook): the
// state layer's write cost grows with nested values, and R15 (2000 steps, 5 s timeout) runs ~3 s packed
// against ~7 s, failing, as tuples. Re-measure before unpacking.
export type CacheStats = {
  read: number
  write: number
  input: number
  last: CacheStep
  bars: string
}

export type CacheStep = {
  read: number
  write: number
  input: number
  model: string
  // When the step ended.
  at: number
  // Present on a rebuild: the time since the step before it ended, in ms.
  rebuiltAfter?: number
}

export type Panel = {
  isCompact: boolean
  isDoneCollapsed: boolean
  autoOpenedFor: string
}

declare module 'claude-code' {
  interface PluginState {
    'autobots-progress': {
      flow: Flow | null
      agents: AgentRun[]
      panel: Panel
      now: number
      // The session's working directory, from `session.start`: Autobots Mode counts edits inside it.
      cwd: string
    }
  }
}
