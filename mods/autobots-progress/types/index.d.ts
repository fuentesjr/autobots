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
