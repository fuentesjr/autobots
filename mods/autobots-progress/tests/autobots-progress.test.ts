// Spec tests for the autobots-progress mod. They describe the behavior the
// mod must have once adapted to this repo's subagent roster; they say nothing
// about how the mod is built. The pane id, state keys and tool short names are
// discovered from what the mod does, not assumed.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'

const ROSTER = [
  'planner',
  'coding-worker',
  'fast-coding-worker',
  'helper-worker',
  'forensic-analyst',
  'doc-reviewer',
  'reviewer',
  'qa-engineer',
  'edge-case-analyst',
  'advisor',
  'spec-test-writer',
] as const

const PROGRESS_TOOL = 'mcp__autobots-progress__progress'
const STEP_TOOL = 'mcp__autobots-progress__step'

// What the engine would draw if the mod passes the band through.
const ENGINE_BAND = 'engine-own-band'

type Harness = {
  registeredTools: { name: string; inputSchema: Record<string, any> }[]
  registeredCommands: string[]
  stateWrites: { plugin: string; key: string; value: unknown }[]
  openedPanes: string[]
  closedPanes: string[]
  clock: MockClock
}

// Boots the mod in a session. Only what the mod does not own sits beneath it:
// the clock, the environment, the pane list, and the engine's own drawing.
async function boot($: Engine, on: On): Promise<Harness> {
  const clock = mock.clock(on, { now: 1_000_000 })
  const h: Harness = { registeredTools: [], registeredCommands: [], stateWrites: [], openedPanes: [], closedPanes: [], clock }
  const open = new Set<string>()
  mock.env(on, {})

  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', async (_$, e) => {
    h.registeredTools.push({ name: e.name, inputSchema: e.inputSchema })
    return { value: { tool: e.name } }
  })
  on('command.register', async (_$, e) => {
    h.registeredCommands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.panes', async () => ({
    value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('ui.open', async (_$, e) => {
    open.add(e.id)
    h.openedPanes.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', async (_$, e) => {
    open.delete(e.id)
    h.closedPanes.push(e.id)
    return { value: undefined as never }
  })
  on('state.set', async (_$, e, next) => {
    h.stateWrites.push({ plugin: e.plugin, key: e.key, value: e.value })
    return next(e)
  })
  // The Agent tool is the engine's; the test raises its spawn itself (see spawnSubagent).
  on('tool.call', { tool: 'Agent' }, async () => ({ result: 'started' }))
  // Each spawn gets its own agent id: agent-<type> for the first of a type, agent-<type>-2 for the second.
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

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  return h
}

// Starts a subagent as the engine does: the model's Agent tool call, then the
// spawn it leads to. A mod may notice the subagent at either event.
async function spawnSubagent($: Engine, subagentType: string, description = 'a task', model?: string): Promise<void> {
  await $.tool.call({ tool: 'Agent', subagent_type: subagentType, description, prompt: 'go', ...(model ? { model } : {}) } as never)
  await $.agent.spawn({
    tool_use_id: 'toolu-spawn',
    prompt: 'go',
    description,
    subagentType,
    provider: { plugin: 'engine', tier: 'core' },
    ...(model ? { model } : {}),
    parentModel: 'claude-sonnet-5-5',
    background: false,
    fork: false,
  })
}

async function mountBand($: Engine, surface: 'terminal' | 'desktop') {
  return $.ui.mount({
    plugin: 'autobots-progress',
    surface,
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 100,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  })
}

// True when the mod drew its own bar, false when it left the band to the engine.
// The terminal and the desktop must agree.
async function hasBar($: Engine): Promise<boolean> {
  const seen: boolean[] = []
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountBand($, surface)
    seen.push((await ui.find({ key: ENGINE_BAND })) === undefined)
    await ui.unmount()
  }
  expect(seen[0], 'the bar is drawn on the terminal exactly when it is drawn on the desktop').toBe(seen[1])
  return seen[0] === true
}

// The strings the bar shows on the desktop: its text, and the description of
// its drawing (the kit does not expose a drawing's pixels or markup).
async function barStrings($: Engine): Promise<string[]> {
  const ui = await mountBand($, 'desktop')
  const strings = (await ui.findAll({})).flatMap(el => [el.text, typeof el.props.alt === 'string' ? el.props.alt : ''])
  await ui.unmount()
  return strings.filter(Boolean)
}

// Whether the bar shows `title` as its title: on its own, or leading a "title: status" description.
const showsTitle = (strings: string[], title: string): boolean =>
  strings.some(s => s === title || s.startsWith(`${title}: `))

describe('identity', () => {
  test('the only model-callable tool is mcp__autobots-progress__progress; there is no step tool', async ($, on) => {
    const h = await boot($, on)
    // Registered by short name; the engine names them mcp__<plugin>__<name>.
    expect(h.registeredTools.map(t => t.name)).toEqual(['progress'])

    // A call to a tool name nothing answers rejects: progress resolving means the mod serves it,
    // step rejecting means the mod does not.
    await expect($.tool.call({ tool: PROGRESS_TOOL, title: 'Identity check' } as never)).resolves.toBeDefined()
    await expect($.tool.call({ tool: STEP_TOOL, done: 1 } as never)).rejects.toBeDefined()
  })

  test('the plugin is named autobots-progress', async ($, on) => {
    const seen: string[] = []
    on('plugin.register', async (_$, e) => {
      seen.push(e.name)
      return { allow: true as const }
    })
    await boot($, on)
    expect(seen).toContain('autobots-progress')
    expect(seen).not.toContain('savvy-progress')
  })

  test('/agents-info is registered and toggles the agents panel open then closed', async ($, on) => {
    const h = await boot($, on)
    expect(h.registeredCommands).toEqual(['agents-info'])

    await $.command.run({ command: 'agents-info', args: '' } as never)
    expect(h.openedPanes).toHaveLength(1)
    expect(h.closedPanes).toHaveLength(0)

    await $.command.run({ command: 'agents-info', args: '' } as never)
    expect(h.closedPanes).toEqual(h.openedPanes)
  })
})

describe('roster recognition', () => {
  for (const role of ROSTER) {
    test(`a subagent of type ${role} is recognized as a roster role`, async ($, on) => {
      await boot($, on)
      await spawnSubagent($, role)
      expect(await hasBar($), `the bar appears once a ${role} subagent is spawned`).toBe(true)
    })

    test(`a subagent of type autobots:${role} is recognized as the ${role} role`, async ($, on) => {
      await boot($, on)
      await spawnSubagent($, `autobots:${role}`)
      expect(await hasBar($), `the bar appears once an autobots:${role} subagent is spawned`).toBe(true)
    })
  }

  // Role names are exact and case-sensitive.
  for (const type of ['Explore', 'general-purpose', 'savvy-medium', 'planner-v2', 'my-reviewer', 'Planner', 'CODING-WORKER']) {
    test(`a subagent of type ${type} is not a roster role`, async ($, on) => {
      await boot($, on)
      await spawnSubagent($, type)
      expect(await hasBar($), `no bar for a ${type} subagent`).toBe(false)
    })
  }
})

describe('progress bar', () => {
  test('the bar does not appear while only non-roster subagents have run, and appears when a roster subagent is spawned', async ($, on) => {
    await boot($, on)
    for (const type of ['Explore', 'general-purpose', 'savvy-medium']) await spawnSubagent($, type)
    expect(await hasBar($), 'no bar after only non-roster subagents').toBe(false)

    await spawnSubagent($, 'coding-worker')
    expect(await hasBar($), 'the bar appears once a roster subagent is spawned').toBe(true)
  })

  test('the bar appears once the progress tool is called, showing the reported title', async ($, on) => {
    await boot($, on)
    expect(await hasBar($), 'no bar before anything is reported').toBe(false)

    await $.tool.call({ tool: PROGRESS_TOOL, title: 'Ship the thing' } as never)
    expect(await hasBar($), 'the bar appears once the progress tool is called').toBe(true)
    expect(showsTitle(await barStrings($), 'Ship the thing')).toBe(true)
  })

  // The terminal's element table lists Svg but draws nothing for it, so a band
  // drawn as Svg there showed only its buttons (seen live in Ghostty, 2026-10-10).
  test('on the terminal the bar shows its title, status and percent as text, not as a drawing', async ($, on) => {
    await boot($, on)
    await $.tool.call({ tool: PROGRESS_TOOL, title: 'Ship the thing', total: 2, phase: 'delegate' } as never)

    const ui = await mountBand($, 'terminal')
    const elements = await ui.findAll({})
    await ui.unmount()

    expect(elements.filter(el => el.type === 'Svg'), 'no Svg in the terminal band').toEqual([])
    const texts = elements.filter(el => el.type === 'Text').map(el => el.text)
    expect(texts.some(t => t.includes('Ship the thing')), 'the title is visible text').toBe(true)
    // The delegate phase reads as task progress, as the progress tool answers it.
    expect(texts.some(t => t.includes('Tasks 0/2')), 'the status is visible text').toBe(true)
    expect(texts.some(t => t.includes('0%')), 'the percent is visible text').toBe(true)
  })

  test('a bar triggered by a roster subagent with no reported title is titled autobots', async ($, on) => {
    await boot($, on)
    await spawnSubagent($, 'planner')
    const strings = await barStrings($)
    expect(showsTitle(strings, 'autobots')).toBe(true)
    expect(strings.filter(t => t.includes('savvy-flow'))).toEqual([])
  })
})

const PLAN = [
  { title: 'Write the specs', role: 'spec-test-writer' },
  { title: 'Make them pass', role: 'coding-worker', after: [1] },
]

describe('planned tasks', () => {
  test('the progress tool schema takes a role on each planned task and no longer a tier', async ($, on) => {
    const h = await boot($, on)
    const progress = h.registeredTools.find(t => t.name === 'progress')
    const taskProps = progress?.inputSchema?.properties?.tasks?.items?.properties
    expect(taskProps).toBeDefined()
    expect(taskProps.role).toBeDefined()
    expect(taskProps.tier).toBeUndefined()
  })

  test('planned tasks reported with roles show that role in the agents panel', async ($, on) => {
    const h = await boot($, on)
    await $.tool.call({ tool: PROGRESS_TOOL, title: 'Build it', total: 2, phase: 'delegate', tasks: PLAN } as never)

    // Reporting a plan may open the panel unasked; either way the panel's id is the one the mod opened.
    if (h.openedPanes.length === 0) await $.command.run({ command: 'agents-info', args: '' } as never)
    expect(h.openedPanes.length).toBeGreaterThan(0)

    const pane = await $.ui.mount({
      plugin: 'autobots-progress',
      surface: 'terminal',
      component: 'Pane',
      requestId: h.openedPanes[0],
      props: {
        title: 'Agents',
        isFocused: false,
        bodyColumns: 100,
        placement: 'inline',
        scroll: { offset: 0, bodyRows: 30 },
        view: {},
      },
    })
    const shown = (await pane.findAll({})).map(el => el.text)
    await pane.unmount()

    // Some element shows a task together with its own role and neither of the other task's.
    const rowShowing = (title: string, role: string, otherTitle: string, otherRole: string) =>
      shown.some(t => t.includes(title) && t.includes(role) && !t.includes(otherTitle) && !t.includes(otherRole))
    expect(rowShowing('Write the specs', 'spec-test-writer', 'Make them pass', 'coding-worker'), 'first task with its role').toBe(true)
    expect(rowShowing('Make them pass', 'coding-worker', 'Write the specs', 'spec-test-writer'), 'second task with its role').toBe(true)
  })

  test('planned tasks reported with roles are kept in state with that role', async ($, on) => {
    const h = await boot($, on)
    await $.tool.call({ tool: PROGRESS_TOOL, title: 'Build it', total: 2, phase: 'delegate', tasks: PLAN } as never)

    // The latest value the mod wrote that holds a list of planned tasks.
    type Plan = { tasks: { title: string; role: string }[] }
    const plans = h.stateWrites.map(w => w.value as Plan | null).filter((v): v is Plan => Array.isArray(v?.tasks))
    expect(plans.length, 'the mod keeps the plan in state').toBeGreaterThan(0)
    expect(plans.at(-1)?.tasks.map(t => [t.title, t.role])).toEqual([
      ['Write the specs', 'spec-test-writer'],
      ['Make them pass', 'coding-worker'],
    ])
  })
})

describe('state', () => {
  test('every value the mod keeps in $.state lives under the plugin name autobots-progress', async ($, on) => {
    const h = await boot($, on)
    await $.tool.call({ tool: PROGRESS_TOOL, title: 'State check', total: 1, tasks: [{ title: 'one', role: 'planner' }] } as never)
    await spawnSubagent($, 'planner', 'one')

    expect(h.stateWrites.length).toBeGreaterThan(0)
    expect([...new Set(h.stateWrites.map(w => w.plugin))]).toEqual(['autobots-progress'])
  })
})

describe('role normalization in planned tasks', () => {
  // The latest plan the mod wrote to state, as [title, role] pairs.
  const keptTasks = (h: Harness): string[][] => {
    type Plan = { tasks: { title: string; role: string }[] }
    const plans = h.stateWrites.map(w => w.value as Plan | null).filter((v): v is Plan => Array.isArray(v?.tasks))
    expect(plans.length, 'the mod keeps the plan in state').toBeGreaterThan(0)
    return plans.at(-1)?.tasks.map(t => [t.title, t.role]) ?? []
  }

  test('a planned task whose role is given as autobots:planner is kept in state with role planner', async ($, on) => {
    const h = await boot($, on)
    await $.tool.call({ tool: PROGRESS_TOOL, title: 'Plan it', total: 1, tasks: [{ title: 'Draft the plan', role: 'autobots:planner' }] } as never)
    expect(keptTasks(h)).toEqual([['Draft the plan', 'planner']])
  })

  test('a planned task whose role is not in the roster is kept in state with role other', async ($, on) => {
    const h = await boot($, on)
    await $.tool.call({ tool: PROGRESS_TOOL, title: 'Plan it', total: 1, tasks: [{ title: 'Do something', role: 'general-purpose' }] } as never)
    expect(keptTasks(h)).toEqual([['Do something', 'other']])
  })
})

describe('agents panel', () => {
  // Opens the agents panel (the command toggles it) and returns the text of every element in it.
  async function panelStrings($: Engine, h: Harness): Promise<string[]> {
    if (h.openedPanes.length === 0) await $.command.run({ command: 'agents-info', args: '' } as never)
    expect(h.openedPanes.length, 'the agents panel is open').toBeGreaterThan(0)
    const pane = await $.ui.mount({
      plugin: 'autobots-progress',
      surface: 'terminal',
      component: 'Pane',
      requestId: h.openedPanes[0],
      props: {
        title: 'Agents',
        isFocused: false,
        bodyColumns: 100,
        placement: 'inline',
        scroll: { offset: 0, bodyRows: 30 },
        view: {},
      },
    })
    const shown = (await pane.findAll({})).map(el => el.text).filter(Boolean)
    await pane.unmount()
    return shown
  }

  // What a coding-worker on `model` reports for its one model request. The hooks stand beneath the
  // mod, so they are registered before the session starts (the engine owns the response).
  function workerOn(on: On, model: string, tokens: { input: number; output: number }) {
    const usage = {
      input_tokens: tokens.input,
      output_tokens: tokens.output,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      model,
    }
    on('turn.step', async function* (_$, e) {
      yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage }
    })
    // Runs the worker: spawned, then its one model request.
    return async ($: Engine): Promise<void> => {
      await spawnSubagent($, 'coding-worker', 'a task', model)
      const step = $.turn.step({ turnId: 'turn-1', index: 0, model, messageCount: 3, agentId: 'agent-coding-worker' })
      for await (const _chunk of step) {
        // drain the stream
      }
      await step.result
    }
  }

  // A percentage figure as the panel might show it, not part of a longer number.
  const showsPercent = (strings: string[], percent: number): boolean =>
    strings.some(s => new RegExp(`(^|[^\\d.])${percent}%`).test(s))
  const showsDollars = (strings: string[], amount: string): boolean =>
    strings.some(s => new RegExp(`\\$${amount.replace('.', '\\.')}(?!\\d)`).test(s))

  test('a subagent on Claude Haiku 5.5 has a 1,000,000-token context window', async ($, on) => {
    const run = workerOn(on, 'claude-haiku-5-5', { input: 100_000, output: 0 })
    const h = await boot($, on)
    await run($)
    // 100,000 of 1,000,000 tokens is 10%.
    expect(showsPercent(await panelStrings($, h), 10), 'the context figure is 10%').toBe(true)
  })

  test('a subagent on Claude Haiku 4.5 has a 200,000-token context window', async ($, on) => {
    const run = workerOn(on, 'claude-haiku-4-5', { input: 100_000, output: 0 })
    const h = await boot($, on)
    await run($)
    // 100,000 of 200,000 tokens is 50%.
    expect(showsPercent(await panelStrings($, h), 50), 'the context figure is 50%').toBe(true)
  })

  test('the cost estimate for Claude Haiku 5.5 charges $0.10 per million input tokens', async ($, on) => {
    const run = workerOn(on, 'claude-haiku-5-5', { input: 100_000, output: 0 })
    const h = await boot($, on)
    await run($)
    // 100,000 input tokens at $0.10 per million is $0.01.
    expect(showsDollars(await panelStrings($, h), '0.01'), 'the cost is $0.01').toBe(true)
  })

  test('the cost estimate for Claude Haiku 5.5 charges $0.50 per million output tokens', async ($, on) => {
    const run = workerOn(on, 'claude-haiku-5-5', { input: 0, output: 100_000 })
    const h = await boot($, on)
    await run($)
    // 100,000 output tokens at $0.50 per million is $0.05.
    expect(showsDollars(await panelStrings($, h), '0.05'), 'the cost is $0.05').toBe(true)
  })

  test('a non-roster subagent that runs while the panel is shown appears in the panel under its own type name', async ($, on) => {
    const h = await boot($, on)
    await $.command.run({ command: 'agents-info', args: '' } as never)
    await spawnSubagent($, 'Explore', 'scan the repository')
    const shown = await panelStrings($, h)
    expect(shown.some(t => t.includes('Explore'))).toBe(true)
  })
})

// What each subagent is doing is observed by the mod from the tool uses of each model step; the
// agents report nothing. Every test reads the agents panel on the terminal and on the desktop.
describe('agent activity in the agents panel', () => {
  const SURFACES = ['terminal', 'desktop'] as const
  type Surface = (typeof SURFACES)[number]
  type ToolUse = { name: string; input: unknown }

  // The test is the model API beneath the mod: it decides the tool uses of the next response, and
  // answers the end of a subagent's run. Hooks beneath the plugins are registered before the session starts.
  async function stage($: Engine, on: On) {
    const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' }
    let toolUses: ToolUse[] = []
    on('turn.step', async function* (_$, e) {
      yield { kind: 'stop' as const, stopReason: 'tool_use' as const, usage }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses, stopReason: 'tool_use' as const, usage }
    })
    on('turn.complete', async (_$, e) => ({ text: e.answer }))
    on('classic.SubagentStop', async () => ({}))
    const h = await boot($, on)

    let index = 0
    return {
      h,
      // One model request of the loop `agentId` (the orchestrator's own when absent), answered with these tool uses.
      async step(agentId: string | undefined, uses: ToolUse[]): Promise<void> {
        toolUses = uses
        const stream = $.turn.step({
          turnId: 'turn-1',
          index: index++,
          model: 'claude-sonnet-5-5',
          messageCount: 3,
          ...(agentId ? { agentId } : {}),
        })
        for await (const _chunk of stream) {
          // drain the stream
        }
        await stream.result
      },
      // The end of the subagent's run, as the engine raises it.
      async finish(agentId: string, agentType: string): Promise<void> {
        await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 'turn-1', agentId })
        await $.classic.SubagentStop({ stop_hook_active: false, agent_id: agentId, agent_transcript_path: '', agent_type: agentType })
      },
      // Everything the open panel draws on a surface: element text, and the description of a drawing
      // (the kit does not expose a drawing's pixels or markup).
      async panel(surface: Surface): Promise<string[]> {
        if (h.openedPanes.length === 0) await $.command.run({ command: 'agents-info', args: '' } as never)
        expect(h.openedPanes.length, 'the agents panel is open').toBeGreaterThan(0)
        const pane = await $.ui.mount({
          plugin: 'autobots-progress',
          surface,
          component: 'Pane',
          requestId: h.openedPanes[0],
          props: {
            title: 'Agents',
            isFocused: false,
            bodyColumns: 100,
            placement: 'inline',
            scroll: { offset: 0, bodyRows: 30 },
            view: {},
          },
        })
        const strings = (await pane.findAll({})).flatMap(el => [el.text, typeof el.props.alt === 'string' ? el.props.alt : ''])
        await pane.unmount()
        return strings.filter(Boolean)
      },
    }
  }

  const WORKER = 'agent-coding-worker'
  const read = (file: string): ToolUse => ({ name: 'Read', input: { file_path: file } })

  const showsCalls = (strings: string[], n: number): boolean =>
    strings.some(t => (n === 1 ? /(^|\D)1 call(?!s)/ : new RegExp(`(^|\\D)${n} calls`)).test(t))
  const shows = (strings: string[], text: string): boolean => strings.some(t => t.includes(text))
  // A "<N>s/m/h ago" figure, which a running subagent shows and a finished one does not.
  const AGO = /\d+[smh] ago/
  // Whether the substring appears anywhere in what the panel draws.
  const hides = (strings: string[], text: string): boolean => !strings.some(t => t.includes(text))

  // ----- 1. call count

  test('a subagent row shows its total tool calls summed across steps', async ($, on) => {
    const w = await stage($, on)
    await spawnSubagent($, 'coding-worker')
    await w.step(WORKER, [read('/w/a.rb'), read('/w/b.rb')])
    await w.step(WORKER, [read('/w/c.rb')])
    for (const surface of SURFACES) expect(showsCalls(await w.panel(surface), 3), `3 calls on the ${surface}`).toBe(true)
  })

  test('a subagent row with exactly one tool call says 1 call', async ($, on) => {
    const w = await stage($, on)
    await spawnSubagent($, 'coding-worker')
    await w.step(WORKER, [read('/w/a.rb')])
    for (const surface of SURFACES) {
      const strings = await w.panel(surface)
      expect(showsCalls(strings, 1), `1 call on the ${surface}`).toBe(true)
      expect(strings.some(t => /(^|\D)1 calls/.test(t)), `not "1 calls" on the ${surface}`).toBe(false)
    }
  })

  test('a step with no tool uses changes neither the call count nor the last tool', async ($, on) => {
    const w = await stage($, on)
    await spawnSubagent($, 'coding-worker')
    await w.step(WORKER, [read('/w/a.rb'), { name: 'Grep', input: { pattern: 'needle' } }])
    await w.step(WORKER, [])
    for (const surface of SURFACES) {
      const strings = await w.panel(surface)
      expect(showsCalls(strings, 2), `still 2 calls on the ${surface}`).toBe(true)
      expect(shows(strings, 'Grep needle'), `still Grep needle on the ${surface}`).toBe(true)
    }
  })

  // ----- 2. the most recent tool and its short target

  for (const tool of ['Read', 'Edit', 'Write', 'NotebookEdit']) {
    test(`the row shows the last ${tool} call as ${tool} and the file basename, never the directory`, async ($, on) => {
      const w = await stage($, on)
      await spawnSubagent($, 'coding-worker')
      await w.step(WORKER, [{ name: tool, input: { file_path: '/Users/x/private/a.rb' } }])
      for (const surface of SURFACES) {
        const strings = await w.panel(surface)
        expect(shows(strings, `${tool} a.rb`), `${tool} a.rb on the ${surface}`).toBe(true)
        expect(hides(strings, 'private'), `no directory on the ${surface}`).toBe(true)
        expect(hides(strings, '/Users'), `no path on the ${surface}`).toBe(true)
      }
    })
  }

  test('the row shows the most recent tool, not an earlier one', async ($, on) => {
    const w = await stage($, on)
    await spawnSubagent($, 'coding-worker')
    await w.step(WORKER, [{ name: 'Edit', input: { file_path: '/w/first.rb' } }])
    await w.step(WORKER, [{ name: 'Write', input: { file_path: '/w/older.rb' } }, { name: 'Read', input: { file_path: '/w/newest.rb' } }])
    for (const surface of SURFACES) {
      const strings = await w.panel(surface)
      expect(shows(strings, 'Read newest.rb'), `the last tool of the last step on the ${surface}`).toBe(true)
      expect(hides(strings, 'first.rb'), `no earlier step on the ${surface}`).toBe(true)
      expect(hides(strings, 'older.rb'), `no earlier tool of the same step on the ${surface}`).toBe(true)
    }
  })

  test('the row shows a Glob call as Glob and its pattern', async ($, on) => {
    const w = await stage($, on)
    await spawnSubagent($, 'coding-worker')
    await w.step(WORKER, [{ name: 'Glob', input: { pattern: 'src/**/*.rb' } }])
    for (const surface of SURFACES) expect(shows(await w.panel(surface), 'Glob src/**/*.rb'), `Glob src/**/*.rb on the ${surface}`).toBe(true)
  })

  test('the row shows a Grep call as Grep and its pattern, the shown pattern at most 24 characters', async ($, on) => {
    const w = await stage($, on)
    await spawnSubagent($, 'coding-worker')
    // 36 characters; the 25th is the capital Y.
    await w.step(WORKER, [{ name: 'Grep', input: { pattern: 'abcdefghijklmnopqrstuvwxYZ0123456789' } }])
    for (const surface of SURFACES) {
      const strings = await w.panel(surface)
      expect(shows(strings, 'Grep abcdefghijklmnop'), `the pattern leads on the ${surface}`).toBe(true)
      expect(hides(strings, 'abcdefghijklmnopqrstuvwxY'), `no more than 24 characters on the ${surface}`).toBe(true)
    }
  })

  test('the row shows a Bash call as Bash and the first word of the command only', async ($, on) => {
    const w = await stage($, on)
    await spawnSubagent($, 'coding-worker')
    await w.step(WORKER, [{ name: 'Bash', input: { command: 'git push --force origin main' } }])
    for (const surface of SURFACES) {
      const strings = await w.panel(surface)
      expect(shows(strings, 'Bash git'), `Bash git on the ${surface}`).toBe(true)
      for (const secret of ['push', 'force', 'origin']) expect(hides(strings, secret), `no "${secret}" on the ${surface}`).toBe(true)
    }
  })

  // The privacy rule for Bash: environment assignments are skipped, the shown word is the basename of the
  // first remaining token with surrounding quotes removed, at most 24 characters; nothing remaining: just Bash.
  async function bashRow($: Engine, on: On, command: string) {
    const w = await stage($, on)
    await spawnSubagent($, 'coding-worker')
    await w.step(WORKER, [{ name: 'Bash', input: { command } }])
    return w
  }

  test('a Bash call skips leading environment assignments and shows the command word', async ($, on) => {
    const w = await bashRow($, on, 'API_KEY=sk-live-123456 curl https://x.example/y')
    for (const surface of SURFACES) {
      const strings = await w.panel(surface)
      expect(shows(strings, 'Bash curl'), `Bash curl on the ${surface}`).toBe(true)
      for (const secret of ['API_KEY', 'sk-live', '123456', 'x.example']) expect(hides(strings, secret), `no "${secret}" on the ${surface}`).toBe(true)
    }
  })

  test('a Bash call that is only an environment assignment shows Bash with nothing from the command', async ($, on) => {
    const w = await bashRow($, on, 'ZQXVAR=zqxsecret')
    for (const surface of SURFACES) {
      const strings = await w.panel(surface)
      expect(shows(strings, 'Bash'), `Bash on the ${surface}`).toBe(true)
      for (const secret of ['ZQXVAR', 'zqxsecret']) expect(hides(strings, secret), `no "${secret}" on the ${surface}`).toBe(true)
    }
  })

  test('a Bash call skips a leading assignment whose quoted value has spaces, never showing the value', async ($, on) => {
    const w = await bashRow($, on, 'TOKEN="Bearer zqxsecret" curl https://x.example/y')
    for (const surface of SURFACES) {
      const strings = await w.panel(surface)
      expect(shows(strings, 'Bash curl'), `Bash curl on the ${surface}`).toBe(true)
      for (const secret of ['zqxsecret', 'Bearer', 'TOKEN', 'x.example']) expect(hides(strings, secret), `no "${secret}" on the ${surface}`).toBe(true)
    }
  })

  test('a Bash call skips several leading assignments, quoted or not, before the command path', async ($, on) => {
    // The values are distinctive so they cannot collide with other row text.
    const w = await bashRow($, on, "A='zqxone zqxtwo' B=zqxthree ./bin/run.sh")
    for (const surface of SURFACES) {
      const strings = await w.panel(surface)
      expect(shows(strings, 'Bash run.sh'), `Bash run.sh on the ${surface}`).toBe(true)
      for (const secret of ['zqxone', 'zqxtwo', 'zqxthree', 'bin']) expect(hides(strings, secret), `no "${secret}" on the ${surface}`).toBe(true)
    }
  })

  test('a Bash call to a path shows the basename of the command, never its directories', async ($, on) => {
    const w = await bashRow($, on, '/Users/x/client-acme/scripts/deploy.sh prod')
    for (const surface of SURFACES) {
      const strings = await w.panel(surface)
      expect(shows(strings, 'Bash deploy.sh'), `Bash deploy.sh on the ${surface}`).toBe(true)
      for (const secret of ['client-acme', '/Users', 'scripts', 'prod']) expect(hides(strings, secret), `no "${secret}" on the ${surface}`).toBe(true)
    }
  })

  test('a Bash call to a relative path shows the basename of the command, never its directories', async ($, on) => {
    const w = await bashRow($, on, './secret-dir/run.sh')
    for (const surface of SURFACES) {
      const strings = await w.panel(surface)
      expect(shows(strings, 'Bash run.sh'), `Bash run.sh on the ${surface}`).toBe(true)
      expect(hides(strings, 'secret-dir'), `no directory on the ${surface}`).toBe(true)
    }
  })

  test('a Bash call shows at most 24 characters of the command word', async ($, on) => {
    // 60 characters with no slash; the 25th is the capital Y.
    const w = await bashRow($, on, `abcdefghijklmnopqrstuvwx${'Y'.repeat(36)} --flag`)
    for (const surface of SURFACES) {
      const strings = await w.panel(surface)
      expect(shows(strings, 'Bash abcdefghijklmnop'), `the word leads on the ${surface}`).toBe(true)
      expect(hides(strings, 'abcdefghijklmnopqrstuvwxY'), `no more than 24 characters on the ${surface}`).toBe(true)
    }
  })

  test('the row shows a WebFetch call as WebFetch and the URL host only', async ($, on) => {
    const w = await stage($, on)
    await spawnSubagent($, 'coding-worker')
    await w.step(WORKER, [{ name: 'WebFetch', input: { url: 'https://example.com/secret/x?token=abc' } }])
    for (const surface of SURFACES) {
      const strings = await w.panel(surface)
      expect(shows(strings, 'WebFetch example.com'), `WebFetch example.com on the ${surface}`).toBe(true)
      for (const secret of ['secret', 'token=', 'abc', 'https']) expect(hides(strings, secret), `no "${secret}" on the ${surface}`).toBe(true)
    }
  })

  test('the row shows a WebSearch call as WebSearch only, never the query', async ($, on) => {
    const w = await stage($, on)
    await spawnSubagent($, 'coding-worker')
    await w.step(WORKER, [{ name: 'WebSearch', input: { query: 'how to rotate leaked credentials' } }])
    for (const surface of SURFACES) {
      const strings = await w.panel(surface)
      expect(shows(strings, 'WebSearch'), `WebSearch on the ${surface}`).toBe(true)
      for (const secret of ['rotate', 'leaked', 'credentials']) expect(hides(strings, secret), `no "${secret}" on the ${surface}`).toBe(true)
    }
  })

  test('the row shows any other tool by its name only, nothing from its input', async ($, on) => {
    const w = await stage($, on)
    await spawnSubagent($, 'coding-worker')
    await w.step(WORKER, [{ name: 'TodoWrite', input: { todos: [{ content: 'ship the hidden plan', status: 'pending' }] } }])
    for (const surface of SURFACES) {
      const strings = await w.panel(surface)
      expect(shows(strings, 'TodoWrite'), `TodoWrite on the ${surface}`).toBe(true)
      for (const secret of ['hidden', 'ship the', 'pending']) expect(hides(strings, secret), `no "${secret}" on the ${surface}`).toBe(true)
    }
  })

  test('a running subagent shows no call count and no ago before its first tool call', async ($, on) => {
    const w = await stage($, on)
    await spawnSubagent($, 'coding-worker')
    await w.step(WORKER, [])
    await w.step(WORKER, [])
    await w.h.clock.advance(9_000)
    for (const surface of SURFACES) {
      const strings = await w.panel(surface)
      expect(hides(strings, 'call'), `no call count on the ${surface}`).toBe(true)
      expect(strings.some(t => AGO.test(t)), `no ago on the ${surface}`).toBe(false)
    }
  })

  // ----- 3. time since the last model step

  test('a running subagent shows seconds since its last model step as <N>s ago under a minute', async ($, on) => {
    const w = await stage($, on)
    await spawnSubagent($, 'coding-worker')
    await w.step(WORKER, [read('/w/a.rb')])
    await w.h.clock.advance(12_000)
    for (const surface of SURFACES) {
      const strings = await w.panel(surface)
      expect(shows(strings, '12s ago'), `12s ago on the ${surface}`).toBe(true)
      expect(strings.some(t => /\dm ago|\dh ago/.test(t)), `no minutes or hours on the ${surface}`).toBe(false)
    }
  })

  test('a running subagent shows minutes since its last model step as <N>m ago under an hour', async ($, on) => {
    const w = await stage($, on)
    await spawnSubagent($, 'coding-worker')
    await w.step(WORKER, [read('/w/a.rb')])
    await w.h.clock.advance(125_000)
    for (const surface of SURFACES) {
      const strings = await w.panel(surface)
      expect(shows(strings, '2m ago'), `2m ago on the ${surface}`).toBe(true)
      expect(strings.some(t => /\ds ago|\dh ago/.test(t)), `no seconds or hours on the ${surface}`).toBe(false)
    }
  })

  test('a running subagent shows hours since its last model step as <N>h ago from an hour on', async ($, on) => {
    const w = await stage($, on)
    await spawnSubagent($, 'coding-worker')
    await w.step(WORKER, [read('/w/a.rb')])
    await w.h.clock.advance(2 * 3_600_000 + 5 * 60_000)
    for (const surface of SURFACES) {
      const strings = await w.panel(surface)
      expect(shows(strings, '2h ago'), `2h ago on the ${surface}`).toBe(true)
      expect(strings.some(t => /\dm ago|\ds ago/.test(t)), `no minutes or seconds on the ${surface}`).toBe(false)
    }
  })

  // ----- 4. a finished subagent

  test('a finished subagent keeps its call count and last tool but shows no ago', async ($, on) => {
    const w = await stage($, on)
    await spawnSubagent($, 'coding-worker')
    await w.step(WORKER, [read('/w/a.rb'), read('/w/b.rb')])
    await w.step(WORKER, [{ name: 'Edit', input: { file_path: '/w/last.rb' } }])
    await w.h.clock.advance(30_000)
    expect((await w.panel('terminal')).some(t => AGO.test(t)), 'still running: shows ago').toBe(true)

    await w.finish(WORKER, 'coding-worker')
    for (const surface of SURFACES) {
      const strings = await w.panel(surface)
      expect(showsCalls(strings, 3), `3 calls on the ${surface}`).toBe(true)
      expect(shows(strings, 'Edit last.rb'), `Edit last.rb on the ${surface}`).toBe(true)
      expect(strings.some(t => AGO.test(t)), `no ago on the ${surface}`).toBe(false)
    }
  })

  // ----- 5. the orchestrator's own steps

  test('steps of the orchestrator itself do not change any subagent row', async ($, on) => {
    const w = await stage($, on)
    await spawnSubagent($, 'coding-worker')
    await w.step(WORKER, [read('/w/a.rb')])
    await w.h.clock.advance(5_000)
    await w.step(undefined, [{ name: 'Bash', input: { command: 'ls' } }, { name: 'Edit', input: { file_path: '/w/orchestrator.rb' } }])
    for (const surface of SURFACES) {
      const strings = await w.panel(surface)
      expect(showsCalls(strings, 1), `still 1 call on the ${surface}`).toBe(true)
      expect(shows(strings, 'Read a.rb'), `still Read a.rb on the ${surface}`).toBe(true)
      expect(hides(strings, 'orchestrator.rb'), `no orchestrator tool on the ${surface}`).toBe(true)
      expect(shows(strings, '5s ago'), `the subagent's own last step is still 5s ago on the ${surface}`).toBe(true)
    }
  })

  // ----- 6. markup characters in a file name

  test('a file name containing markup characters is shown as text, not markup', async ($, on) => {
    const w = await stage($, on)
    await spawnSubagent($, 'coding-worker')
    await w.step(WORKER, [{ name: 'Edit', input: { file_path: '/w/a<b>.rb' } }])

    // The terminal shows the name itself.
    expect(shows(await w.panel('terminal'), 'Edit a<b>.rb'), 'the file name as text on the terminal').toBe(true)

    // The desktop still draws (a refused drawing rejects the mount), says the name as text, and holds no element named b.
    const desktop = await w.panel('desktop')
    expect(shows(desktop, 'Edit a<b>.rb'), 'the file name as text on the desktop').toBe(true)
    for (const surface of SURFACES) {
      const pane = await $.ui.mount({
        plugin: 'autobots-progress',
        surface,
        component: 'Pane',
        requestId: w.h.openedPanes[0],
        props: { title: 'Agents', isFocused: false, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
      })
      const elements = await pane.findAll({})
      await pane.unmount()
      expect(elements.filter(el => el.type.toLowerCase() === 'b'), `no b element on the ${surface}`).toEqual([])
    }
  })

  // ----- 7. non-roster subagents

  test('a non-roster subagent such as Explore gets the same activity display', async ($, on) => {
    const w = await stage($, on)
    await $.command.run({ command: 'agents-info', args: '' } as never)
    await spawnSubagent($, 'Explore', 'scan the repository')
    await w.step('agent-Explore', [read('/w/a.rb')])
    await w.step('agent-Explore', [{ name: 'Grep', input: { pattern: 'needle' } }])
    await w.h.clock.advance(7_000)
    for (const surface of SURFACES) {
      const strings = await w.panel(surface)
      expect(showsCalls(strings, 2), `2 calls on the ${surface}`).toBe(true)
      expect(shows(strings, 'Grep needle'), `Grep needle on the ${surface}`).toBe(true)
      expect(shows(strings, '7s ago'), `7s ago on the ${surface}`).toBe(true)
    }
  })
})

// The owner wants the terminal agents panel to look as close as possible to the desktop one: the
// crab per row, the three stat tiles, a status mark per row. These tests read the panel on the
// terminal; the desktop is read only as the reference for what the terminal must also show.
describe('terminal agents panel matches the desktop', () => {
  type Found = Awaited<ReturnType<Awaited<ReturnType<Engine['ui']['mount']>>['findAll']>>[number]

  // The test is the model API beneath the mod: every model request reports `tokens`, and the end
  // of a subagent's run is answered. Hooks beneath the plugins are registered before the session starts.
  async function stage($: Engine, on: On) {
    const usage = { input_tokens: 100_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' }
    on('turn.step', async function* (_$, e) {
      yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage }
    })
    on('turn.complete', async (_$, e) => ({ text: e.answer }))
    on('classic.SubagentStop', async () => ({}))
    const h = await boot($, on)

    let index = 0
    return {
      h,
      // The subagent makes one model request.
      async work(type: string): Promise<void> {
        const step = $.turn.step({ turnId: 'turn-1', index: index++, model: 'claude-sonnet-5-5', messageCount: 3, agentId: `agent-${type}` })
        for await (const _chunk of step) {
          // drain the stream
        }
        await step.result
      },
      // The end of the subagent's run, as the engine raises it.
      async finish(type: string): Promise<void> {
        await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 'turn-1', agentId: `agent-${type}` })
        await $.classic.SubagentStop({ stop_hook_active: false, agent_id: `agent-${type}`, agent_transcript_path: '', agent_type: type })
      },
      // Every element the open panel draws on a surface, in document order.
      async elements(surface: 'terminal' | 'desktop'): Promise<Found[]> {
        if (h.openedPanes.length === 0) await $.command.run({ command: 'agents-info', args: '' } as never)
        expect(h.openedPanes.length, 'the agents panel is open').toBeGreaterThan(0)
        const pane = await $.ui.mount({
          plugin: 'autobots-progress',
          surface,
          component: 'Pane',
          requestId: h.openedPanes[0],
          props: { title: 'Agents', isFocused: false, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
        })
        const found = await pane.findAll({})
        await pane.unmount()
        return found
      },
    }
  }

  const textsOf = (els: Found[]): string[] => els.filter(el => el.type === 'Text').map(el => el.text)
  const imagesOf = (els: Found[]): Found[] => els.filter(el => el.type === 'Image')

  // Descriptions that no other text of the panel contains, one per subagent.
  const TITLES = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima']

  // A row is a crab Image and the texts that follow it, up to the next crab.
  type Row = { image: Found; texts: string[] }
  const rowsOf = (els: Found[]): Row[] => {
    const rows: Row[] = []
    for (const el of els) {
      if (el.type === 'Image') rows.push({ image: el, texts: [] })
      else if (rows.length > 0 && el.type === 'Text') rows.at(-1)?.texts.push(el.text)
    }
    return rows
  }

  // Spawns one running subagent per type, titled alpha, bravo, ..., and returns the crab each row
  // draws, by type.
  async function crabsOf($: Engine, on: On, types: string[]): Promise<Record<string, string>> {
    const w = await stage($, on)
    await $.command.run({ command: 'agents-info', args: '' } as never)
    for (const [i, type] of types.entries()) await spawnSubagent($, type, TITLES[i])
    const els = await w.elements('terminal')

    const rows = rowsOf(els)
    const crabs: Record<string, string> = {}
    for (const [i, type] of types.entries()) {
      const row = rows.find(r => r.texts.some(t => t.includes(TITLES[i]!)))
      expect(row, `a crab Image is drawn in the row of the ${type} subagent`).toBeDefined()
      crabs[type] = JSON.stringify(row?.image.props.source)
      expect(crabs[type], `the crab of the ${type} subagent has a source`).not.toBe(undefined)
    }
    return crabs
  }

  // ----- 1 and 2. the crab

  test('each subagent row, running or finished, shows a crab as an Image instead of the ▣ glyph', async ($, on) => {
    const w = await stage($, on)
    await spawnSubagent($, 'coding-worker', 'alpha')
    await spawnSubagent($, 'reviewer', 'bravo')
    await w.finish('reviewer')

    const els = await w.elements('terminal')
    expect(imagesOf(els), 'one crab Image for the running row and one for the finished row').toHaveLength(2)
    expect(textsOf(els).filter(t => t.includes('▣')), 'no ▣ glyph drawn as text').toEqual([])
  })

  test('every crab Image has the alt text ▣', async ($, on) => {
    const w = await stage($, on)
    await spawnSubagent($, 'coding-worker', 'alpha')
    await spawnSubagent($, 'reviewer', 'bravo')
    await w.finish('reviewer')

    const images = imagesOf(await w.elements('terminal'))
    expect(images, 'the rows draw crab Images').toHaveLength(2)
    expect(images.map(el => el.props.alt)).toEqual(['▣', '▣'])
  })

  // ----- 3. each type has its own crab

  // The eleven roster roles and the non-roster Explore type.
  const ALL_TYPES: string[] = [...ROSTER, 'Explore']

  test('each of the 12 types (11 roster roles and Explore) draws a crab distinct from all 11 others', async ($, on) => {
    const crabs = await crabsOf($, on, ALL_TYPES)
    const sharing: string[] = []
    for (const [i, a] of ALL_TYPES.entries()) {
      for (const b of ALL_TYPES.slice(i + 1)) if (crabs[a] === crabs[b]) sharing.push(`${a} and ${b}`)
    }
    expect(sharing, 'pairs of types that wear the same crab').toEqual([])
  })

  test('two running subagents of the same type, with different titles, draw the same crab', async ($, on) => {
    const w = await stage($, on)
    await $.command.run({ command: 'agents-info', args: '' } as never)
    const titles = ALL_TYPES.map(type => [`first/${type}`, `second/${type}`] as const)
    for (const [i, type] of ALL_TYPES.entries()) {
      await spawnSubagent($, type, titles[i]![0])
      await spawnSubagent($, type, titles[i]![1])
    }

    const rows = rowsOf(await w.elements('terminal'))
    for (const [i, type] of ALL_TYPES.entries()) {
      const [first, second] = titles[i]!.map(title => rows.find(r => r.texts.some(t => t.includes(title))))
      expect(first, `a crab Image is drawn in the row of the first ${type} subagent`).toBeDefined()
      expect(second, `a crab Image is drawn in the row of the second ${type} subagent`).toBeDefined()
      expect(first, `the two ${type} subagents are two rows`).not.toBe(second)
      expect(JSON.stringify(second?.image.props.source) === JSON.stringify(first?.image.props.source), `both ${type} subagents wear the same crab`).toBe(true)
    }
  })

  // ----- 3b. planned tasks draw a dimmed crab too

  // Tasks planned through the progress tool, one per roster role, titled plan/<role>.
  const PLANNED = ROSTER.map(role => ({ title: `plan/${role}`, role }))
  const plan = ($: Engine) =>
    $.tool.call({ tool: PROGRESS_TOOL, title: 'Crabs', total: PLANNED.length, phase: 'delegate', tasks: PLANNED } as never)

  test('each planned row shows a crab Image with the alt ▢, drawn before the row title', async ($, on) => {
    const w = await stage($, on)
    await plan($)

    const els = await w.elements('terminal')
    const rows = rowsOf(els)
    const seen = new Set<unknown>()
    for (const { title } of PLANNED) {
      const row = rows.find(r => r.texts.some(t => t.includes(title)))
      expect(row, `a crab Image comes before the title ${title}`).toBeDefined()
      expect(row?.image.props.alt, `the crab of ${title}`).toBe('▢')
      expect(seen.has(row), `the title ${title} has a crab of its own`).toBe(false)
      seen.add(row)
    }
    expect(textsOf(els).filter(t => t.includes('▢')), 'no ▢ glyph drawn as text').toEqual([])
  })

  test('a planned task draws a different crab from a running subagent of the same role', async ($, on) => {
    const w = await stage($, on)
    await plan($)
    // Different descriptions from the planned titles: these runs are not the planned tasks.
    for (const { role } of PLANNED) await spawnSubagent($, role, `run/${role}`)

    const rows = rowsOf(await w.elements('terminal'))
    const crabOf = (title: string) => rows.find(r => r.texts.some(t => t.includes(title)))?.image
    for (const { role } of PLANNED) {
      const planned = crabOf(`plan/${role}`)
      const running = crabOf(`run/${role}`)
      expect(planned, `a crab Image is drawn in the planned row of ${role}`).toBeDefined()
      expect(running, `a crab Image is drawn in the running row of ${role}`).toBeDefined()
      expect(planned?.props.alt, `the planned row of ${role} has a ▢ crab, not a ▣ one`).toBe('▢')
      expect(running?.props.alt, `the running row of ${role} is running`).toBe('▣')
      expect(JSON.stringify(planned?.props.source) === JSON.stringify(running?.props.source), `planned and running ${role} wear different crabs`).toBe(false)
    }
  })

  test('planned tasks of different roles draw pairwise distinct crabs, and two planned tasks of the same role draw equal crabs', async ($, on) => {
    const w = await stage($, on)
    // Two tasks per roster role, titled so that no title contains another.
    const tasks = ROSTER.flatMap(role => [
      { title: `plan-a/${role}`, role },
      { title: `plan-b/${role}`, role },
    ])
    await $.tool.call({ tool: PROGRESS_TOOL, title: 'Crabs', total: tasks.length, phase: 'delegate', tasks } as never)

    const rows = rowsOf(await w.elements('terminal'))
    const crabOf = (title: string): string | undefined => {
      const row = rows.find(r => r.texts.some(t => t.includes(title)))
      expect(row, `a crab Image comes before the planned title ${title}`).toBeDefined()
      return JSON.stringify(row?.image.props.source)
    }
    const crabs: Record<string, string | undefined> = {}
    for (const role of ROSTER) {
      const a = crabOf(`plan-a/${role}`)
      const b = crabOf(`plan-b/${role}`)
      expect(a === b, `the two planned ${role} tasks wear the same crab`).toBe(true)
      crabs[role] = a
    }
    const sharing: string[] = []
    for (const [i, a] of ROSTER.entries()) {
      for (const b of ROSTER.slice(i + 1)) if (crabs[a] === crabs[b]) sharing.push(`${a} and ${b}`)
    }
    expect(sharing, 'pairs of planned roles that wear the same crab').toEqual([])
  })

  // ----- 4. the stat tiles

  test('the panel shows tiles labeled Cost, Tokens and Time, each with its value', async ($, on) => {
    const w = await stage($, on)
    await spawnSubagent($, 'coding-worker', 'alpha')
    await w.work('coding-worker')
    await w.h.clock.advance(47_000)

    const texts = textsOf(await w.elements('terminal'))
    const shown = (re: RegExp) => texts.some(t => re.test(t))
    // Labels are capitalized words of their own; the value formats are the panel's: ≈$0.28, 293k, 0:47.
    expect(shown(/\bCost\b/), 'the Cost label').toBe(true)
    expect(shown(/\bTokens\b/), 'the Tokens label').toBe(true)
    expect(shown(/\bTime\b/), 'the Time label').toBe(true)
    expect(shown(/≈\$\d+\.\d{1,2}/), 'a cost value').toBe(true)
    expect(shown(/\b\d+(\.\d)?[kM]\b/), 'a tokens value').toBe(true)
    expect(shown(/\b\d+:\d{2}\b/), 'a time value').toBe(true)
  })

  // ----- 5. the status mark

  // Running and finished rows side by side. A row's texts run from its title to the next row's title.
  async function markedRows($: Engine, on: On): Promise<Record<string, string[]>> {
    const w = await stage($, on)
    await spawnSubagent($, 'coding-worker', 'alpha')
    await spawnSubagent($, 'reviewer', 'bravo')
    await w.finish('reviewer')

    const rows: Record<string, string[]> = {}
    let current: string[] | undefined
    for (const t of textsOf(await w.elements('terminal'))) {
      if (t === 'alpha' || t === 'bravo') current = rows[t] = []
      else current?.push(t)
    }
    expect(Object.keys(rows).sort(), 'both rows are drawn, titled by their descriptions').toEqual(['alpha', 'bravo'])
    return rows
  }

  test('a running subagent row ends with ● and shows no ✓', async ($, on) => {
    const rows = await markedRows($, on)
    expect(rows.alpha!.some(t => t.includes('●')), 'the running row shows ●').toBe(true)
    expect(rows.alpha!.some(t => t.includes('✓')), 'the running row shows no ✓').toBe(false)
  })

  test('a finished subagent row ends with ✓ and shows no ●', async ($, on) => {
    const rows = await markedRows($, on)
    expect(rows.bravo!.some(t => t.includes('✓')), 'the finished row shows ✓').toBe(true)
    expect(rows.bravo!.some(t => t.includes('●')), 'the finished row shows no ●').toBe(false)
  })

  // ----- 6. parity with the desktop

  test('every agent title and role name the desktop panel shows is also shown as text on the terminal', async ($, on) => {
    const w = await stage($, on)
    await $.tool.call({ tool: PROGRESS_TOOL, title: 'Build it', total: 2, phase: 'delegate', tasks: PLAN } as never)
    await spawnSubagent($, 'planner', 'Sketch the design')
    await spawnSubagent($, 'reviewer', 'Check the diff')
    await w.finish('reviewer')
    await spawnSubagent($, 'Explore', 'Scan the repository')

    // What the desktop shows is its text and the alt of its drawings; the kit does not expose the
    // pixels or markup, so the role names it draws are the roles of the state built above.
    const desktop = (await w.elements('desktop')).flatMap(el => [el.text, typeof el.props.alt === 'string' ? el.props.alt : ''])
    const titles = ['Sketch the design', 'Check the diff', 'Scan the repository', ...PLAN.map(t => t.title)]
    const roles = ['planner', 'reviewer', 'Explore', ...PLAN.map(t => t.role)]
    for (const title of titles) expect(desktop.some(s => s.includes(title)), `the desktop shows the title ${title}`).toBe(true)

    // As text: an Image's alt does not count on the terminal.
    const terminal = textsOf(await w.elements('terminal'))
    for (const title of titles) expect(terminal.some(t => t.includes(title)), `the terminal shows the title ${title} as text`).toBe(true)
    for (const role of roles) expect(terminal.some(t => t.includes(role)), `the terminal shows the role ${role} as text`).toBe(true)
  })
})
