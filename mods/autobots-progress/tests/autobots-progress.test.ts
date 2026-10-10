// Spec tests for the autobots-progress mod. They describe the behavior the
// mod must have once adapted to this repo's subagent roster; they say nothing
// about how the mod is built. The pane id, state keys and tool short names are
// discovered from what the mod does, not assumed.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

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
}

// Boots the mod in a session. Only what the mod does not own sits beneath it:
// the clock, the environment, the pane list, and the engine's own drawing.
async function boot($: Engine, on: On): Promise<Harness> {
  const h: Harness = { registeredTools: [], registeredCommands: [], stateWrites: [], openedPanes: [], closedPanes: [] }
  const open = new Set<string>()
  mock.env(on, {})
  mock.clock(on, { now: 1_000_000 })

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
  on('agent.spawn', async (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: `agent-${e.subagentType}` }))
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
  test('the model-callable tools are mcp__autobots-progress__progress and mcp__autobots-progress__step', async ($, on) => {
    const h = await boot($, on)
    // Registered by short name; the engine names them mcp__<plugin>__<name>.
    expect(h.registeredTools.map(t => t.name).sort()).toEqual(['progress', 'step'])

    // A call to a tool name nothing answers rejects, so these resolving means the mod serves both names.
    await expect($.tool.call({ tool: PROGRESS_TOOL, title: 'Identity check' } as never)).resolves.toBeDefined()
    await expect($.tool.call({ tool: STEP_TOOL, done: 1 } as never)).resolves.toBeDefined()
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
