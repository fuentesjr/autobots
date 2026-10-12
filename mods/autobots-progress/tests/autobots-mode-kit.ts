// Shared harness for the Autobots Mode spec tests (docs/requirements/autobots-mode.md).
// Only what the mod does not own sits beneath it: the clock, the environment, the pane list, the
// engine's file tools, the Skill tool, the owner's prompt, and the engine's own drawing.
import { expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

export const PROGRESS_TOOL = 'mcp__autobots-progress__progress'
export const CWD = '/work'
export const HOME = '/Users/x'
export const TMP = '/var/folders/ab/xyz/T'
export const SUBAGENT = 'agent-coding-worker'
export const PROJECT_FILE = `${CWD}/src/app.rb`
// What the tool beneath the mod returns for a call that ran: the mod must pass it on unchanged.
export const TOOL_OUTPUT = 'sentinel tool output 5c1e'
const ENGINE_BAND = 'engine-own-band'

export type Surface = 'terminal' | 'desktop'
export const SURFACES: Surface[] = ['terminal', 'desktop']
export type Outcome = 'ran' | 'error' | 'deny'
export type Reply = { result?: unknown; context?: readonly string[]; deny?: string; isError?: boolean }

export type Kit = {
  // Each file tool call as it reached the engine's tool: the tool and the loop it ran in.
  reached: { tool: string; agentId?: string }[]
  stateWrites: { plugin: string; key: string; value: unknown }[]
  // How the tool beneath the mod answers the next calls.
  outcome(o: Outcome): void
  // The model's tool calls; `agentId` makes the call a subagent's.
  skill(skill: string, agentId?: string): Promise<Reply>
  edit(file_path: string, agentId?: string): Promise<Reply>
  write(file_path: string, agentId?: string): Promise<Reply>
  notebook(notebook_path: string, agentId?: string): Promise<Reply>
  bash(command: string, agentId?: string): Promise<Reply>
  progress(args: Record<string, unknown>): Promise<Reply>
  prompt(text: string): Promise<void>
  spawn(subagentType: string): Promise<void>
  // Every string the band / the open agents panel draws on a surface: element text and a drawing's alt text.
  band(surface: Surface): Promise<string[]>
  panel(surface: Surface): Promise<string[]>
  // Presses the band's close button on the terminal.
  dismiss(): Promise<void>
}

// Boots the mod in a session in CWD.
export async function setup($: Engine, on: On): Promise<Kit> {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME, TMPDIR: TMP })
  const open = new Set<string>()
  const openedPanes: string[] = []
  const stateWrites: Kit['stateWrites'] = []
  const reached: Kit['reached'] = []
  let outcome: Outcome = 'ran'

  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', async (_$, e) => ({ value: { tool: e.name } }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.panes', async () => ({
    value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('ui.open', async (_$, e) => {
    open.add(e.id)
    openedPanes.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', async (_$, e) => {
    open.delete(e.id)
    return { value: undefined as never }
  })
  on('state.set', async (_$, e, next) => {
    stateWrites.push({ plugin: e.plugin, key: e.key, value: e.value })
    return next(e)
  })
  on('tool.call', { tool: 'Agent' }, async () => ({ result: 'started' }))
  on('tool.call', { tool: 'Skill' }, async () => ({ result: 'skill loaded' }))
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit', 'Bash'] } as never, (async (_$: unknown, e: { tool: string; agentId?: string }) => {
    reached.push({ tool: e.tool, ...(e.agentId ? { agentId: e.agentId } : {}) })
    if (outcome === 'deny') return { deny: 'refused beneath the mod' }
    if (outcome === 'error') return { isError: true, result: 'the tool failed' }
    return { result: TOOL_OUTPUT }
  }) as never)
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  const spawned = new Map<string, number>()
  on('agent.spawn', async (_$, e) => {
    const n = (spawned.get(e.subagentType) ?? 0) + 1
    spawned.set(e.subagentType, n)
    return { model: 'claude-sonnet-5-5', agentId: n === 1 ? `agent-${e.subagentType}` : `agent-${e.subagentType}-${n}` }
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return Box({ key: ENGINE_BAND } as never)
  })

  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

  const call = async (input: Record<string, unknown>, agentId?: string): Promise<Reply> =>
    (await $.tool.call({ ...input, ...(agentId ? { agentId } : {}) } as never)) as Reply

  const mountBand = (surface: Surface) =>
    $.ui.mount({
      plugin: 'autobots-progress',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
  const stringsOf = (els: { text: string; props: Record<string, unknown> }[]): string[] =>
    els.flatMap(el => [el.text, typeof el.props.alt === 'string' ? el.props.alt : '']).filter(Boolean)

  return {
    reached,
    stateWrites,
    outcome: o => {
      outcome = o
    },
    skill: (skill, agentId) => call({ tool: 'Skill', skill }, agentId),
    edit: (file_path, agentId) => call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' }, agentId),
    write: (file_path, agentId) => call({ tool: 'Write', file_path, content: 'x' }, agentId),
    notebook: (notebook_path, agentId) => call({ tool: 'NotebookEdit', notebook_path, new_source: 'x', cell_id: 'c1' }, agentId),
    bash: (command, agentId) => call({ tool: 'Bash', command }, agentId),
    progress: args => call({ tool: PROGRESS_TOOL, ...args }),
    prompt: async text => {
      await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
    },
    spawn: async subagentType => {
      await $.tool.call({ tool: 'Agent', subagent_type: subagentType, description: 'a task', prompt: 'go' } as never)
      await $.agent.spawn({
        tool_use_id: 'toolu-spawn',
        prompt: 'go',
        description: 'a task',
        subagentType,
        provider: { plugin: 'engine', tier: 'core' },
        parentModel: 'claude-sonnet-5-5',
        background: false,
        fork: false,
      })
    },
    band: async surface => {
      const ui = await mountBand(surface)
      const strings = stringsOf(await ui.findAll({}))
      await ui.unmount()
      return strings
    },
    panel: async surface => {
      if (openedPanes.length === 0) await $.command.run({ command: 'agents-info', args: '' } as never)
      expect(openedPanes.length, 'the agents panel is open').toBeGreaterThan(0)
      const pane = await $.ui.mount({
        plugin: 'autobots-progress',
        surface,
        component: 'Pane',
        requestId: openedPanes[0],
        props: { title: 'Agents', isFocused: false, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
      })
      const strings = stringsOf(await pane.findAll({}))
      await pane.unmount()
      return strings
    },
    dismiss: async () => {
      const ui = await mountBand('terminal')
      const buttons = await ui.findAll({ type: 'Button' })
      const x = buttons.find(b => [b.text, b.props.label, b.props.alt, b.props.title].some(v => typeof v === 'string' && v.includes('✕')))
      expect(x, 'the band draws a Button marked with the close sign').toBeDefined()
      expect(x?.key, 'the close Button has a key to press it by').toBeDefined()
      await ui.press({ key: x!.key! })
      await ui.unmount()
    },
  }
}

// ---------------------------------------------------------------------------
// Reading what the mod shows

// The edit mark and a count on the band, not part of a longer number.
export const showsEdits = (strings: string[], n: number): boolean => strings.some(s => new RegExp(`✎ ${n}(?!\\d)`).test(s))
export const showsNoEditMark = (strings: string[]): boolean => !strings.some(s => s.includes('✎'))
// `N direct edits` in the panel, `1 direct edit` when N is 1.
export const showsDirectEdits = (strings: string[], n: number): boolean =>
  strings.some(s => new RegExp(`(^|\\D)${n} direct edit${n === 1 ? '(?!s)' : 's'}`).test(s))
export const showsNoDirectEdits = (strings: string[]): boolean => !strings.some(s => s.includes('direct edit'))
// Whether the band shows `title` on its own, or leading a "title: status" description.
export const showsTitle = (strings: string[], title: string): boolean => strings.some(s => s === title || s.startsWith(`${title}: `))

// The reminder is the one entry of `context`; "no reminder" is no context at all.
export const remindersOf = (r: Reply): readonly string[] => r.context ?? []

// The band shows the mark and `n` (or no mark at 0) on both surfaces.
export async function expectBand(k: Kit, n: number, why: string): Promise<void> {
  for (const surface of SURFACES) {
    const strings = await k.band(surface)
    if (n > 0) expect(showsEdits(strings, n), `${why}: the ${surface} band shows the edit mark and ${n}; it draws ${JSON.stringify(strings)}`).toBe(true)
    else expect(showsNoEditMark(strings), `${why}: the ${surface} band shows no edit mark; it draws ${JSON.stringify(strings)}`).toBe(true)
  }
}
