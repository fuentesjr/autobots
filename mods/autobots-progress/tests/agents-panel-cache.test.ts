// Spec tests for the cache view of the agents panel, requirements 1 to 16.
// Source of truth: docs/requirements/agents-panel-cache.md.
//
// The tests say nothing about how the mod is built. They read the panel the way a person sees it:
// the text of each row, the crab (the terminal's still image, the desktop's drawing), the desktop
// strip and its hover text, and when the panel redraws. Every number below is chosen by the test and
// worked out from the requirement it names.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const MODEL = 'claude-sonnet-5-5'
const OTHER_MODEL = 'claude-haiku-5-5'
const MINUTE = 60_000
const TTL = 5 * MINUTE

type Surface = 'terminal' | 'desktop'
const SURFACES: Surface[] = ['terminal', 'desktop']
type ToolUse = { name: string; input: unknown }

// One model step of a subagent, as the engine's usage report gives it.
type Step = { read: number; write: number; input?: number; output?: number; model?: string; tools?: ToolUse[] }

// ---------------------------------------------------------------------------
// Drawing: what the panel draws, read as plain data.

type Drawn = string | { type: string; props: Record<string, any>; children?: Drawn[] }
type Found = Awaited<ReturnType<Awaited<ReturnType<Engine['ui']['mount']>>['findAll']>>[number]

// A row of the terminal panel: the crab Image (or the ▣ glyph where no image is drawn) and the texts after it.
type Row = { crab: Found; texts: string[] }

const rowsOf = (els: Found[]): Row[] => {
  const rows: Row[] = []
  for (const el of els) {
    const isCrab = el.type === 'Image' || (el.type === 'Text' && /^[▣▢]$/.test(el.text.trim()))
    if (isCrab) rows.push({ crab: el, texts: [] })
    else if (rows.length > 0 && el.type === 'Text') rows.at(-1)?.texts.push(el.text)
  }
  return rows
}

// The text inside an SVG source: its <text> elements only, with the CSS and the hover titles left out.
const svgTexts = (source: string): string[] =>
  [...source.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map(m => m[1]!.replace(/<[^>]*>/g, ''))
// The hover text of an SVG: the content of its <title> elements.
const svgTitles = (source: string): string[] => [...source.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/g)].map(m => m[1]!.replace(/<[^>]*>/g, ''))
// What an SVG draws apart from its CSS, its texts and its hover titles.
const svgShapes = (source: string): string =>
  source.replace(/<style\b[\s\S]*?<\/style>/g, '').replace(/<text\b[\s\S]*?<\/text>/g, '').replace(/<title\b[\s\S]*?<\/title>/g, '')
const svgCss = (source: string): string => [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n')

// The pixels of an Image source: straight RGBA, base64, row by row.
type Pixels = { width: number; height: number; bytes: number[] }
const pixelsOf = (img: Found): Pixels => {
  const { rgba, width, height } = img.props.source as { rgba: string; width: number; height: number }
  return { width, height, bytes: [...atob(rgba)].map(ch => ch.charCodeAt(0)) }
}
const opaqueOf = (p: Pixels): number[][] => {
  const out: number[][] = []
  for (let i = 0; i < p.bytes.length; i += 4) if (p.bytes[i + 3]! > 0) out.push(p.bytes.slice(i, i + 3))
  return out
}
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)
// How colorful a crab is: the mean over its visible pixels of max(R,G,B) - min(R,G,B). 0 for a grey crab.
const colorfulness = (p: Pixels): number => mean(opaqueOf(p).map(([r, g, b]) => Math.max(r!, g!, b!) - Math.min(r!, g!, b!)))
// How blue a crab is: the mean blue minus the mean red over its visible pixels.
const blueness = (p: Pixels): number => {
  const px = opaqueOf(p)
  return mean(px.map(c => c[2]!)) - mean(px.map(c => c[0]!))
}
const sameImage = (a: Found, b: Found): boolean => JSON.stringify(a.props.source) === JSON.stringify(b.props.source)

// ---------------------------------------------------------------------------
// Widths on the terminal (copied from the band's width measure in autobots-progress.test.ts, with the
// Image added): the kit draws no terminal text, so a row's width is measured from the tree the mod draws.

function cells(text: string): number {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (/\p{M}/u.test(ch) || c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) continue
    const isWide =
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd)
    n += isWide ? 2 : 1
  }
  return n
}

function measure(node: Drawn, columns: number): { width: number; lines: number } {
  if (typeof node === 'string') return { width: cells(node), lines: node.split('\n').length }
  const { type, props } = node
  const kids = (node.children ?? []).map(child => measure(child, columns))
  if (type === 'Image') return { width: props.columns, lines: props.rows }
  if (type === 'Button') {
    const label = String(props.label ?? '')
    return { width: cells(props.plain ? (props.hotkey ? `${props.hotkey}: ${label}` : label) : `[ ${label} ]`), lines: 1 }
  }
  if (type === 'Text') return { width: kids.reduce((w, k) => w + k.width, 0), lines: kids.reduce((l, k) => l + k.lines - 1, 1) }
  if (type !== 'Box') throw new Error(`the panel draws an element of type ${type}, whose width this measure does not know`)
  if (props.display === 'none') return { width: 0, lines: 0 }
  const side = (name: 'Left' | 'Right', base: 'padding' | 'margin'): number => props[`${base}${name}`] ?? props[`${base}X`] ?? props[base] ?? 0
  const extra = side('Left', 'padding') + side('Right', 'padding') + side('Left', 'margin') + side('Right', 'margin') + (props.borderStyle ? 2 : 0)
  const isColumn = props.flexDirection === 'column' || props.flexDirection === 'column-reverse'
  const shown = kids.filter(k => k.lines > 0)
  const gap = (isColumn ? props.rowGap : props.columnGap) ?? props.gap ?? 0
  const natural = isColumn ? Math.max(0, ...shown.map(k => k.width)) : shown.reduce((w, k) => w + k.width, 0) + gap * Math.max(0, shown.length - 1)
  const lines = isColumn
    ? shown.reduce((l, k) => l + k.lines, 0) + gap * Math.max(0, shown.length - 1)
    : shown.length === 0 ? 0 : Math.max(...shown.map(k => k.lines))
  let fixed: number | undefined
  if (typeof props.width === 'number') fixed = props.width
  else if (typeof props.width === 'string') {
    const pct = /^(\d+(?:\.\d+)?)%$/.exec(props.width)
    if (!pct) throw new Error(`the panel draws a Box of width ${props.width}, which this measure does not know`)
    fixed = Math.floor((columns * Number(pct[1])) / 100)
  }
  return { width: (fixed ?? natural) + (fixed === undefined ? extra : 0), lines }
}

const textNodes = (node: Drawn): string[] => {
  if (typeof node === 'string') return []
  const own = node.type === 'Text' ? [textInside(node)] : []
  return [...own, ...(node.children ?? []).flatMap(textNodes)]
}
const textInside = (node: Drawn): string => (typeof node === 'string' ? node : (node.children ?? []).map(textInside).join(''))

// The deepest element holding a text matching each of `res`.
function deepestHolding(node: Drawn, res: RegExp[]): Drawn | undefined {
  if (typeof node === 'string') return undefined
  const texts = textNodes(node)
  if (!res.every(re => texts.some(t => re.test(t)))) return undefined
  for (const child of node.children ?? []) {
    const inner = deepestHolding(child, res)
    if (inner) return inner
  }
  return node
}

// The element above `target` that holds a crab Image directly, with the crab's width and the gap beside it.
function crabBeside(node: Drawn, target: Drawn): { crabColumns: number; gap: number } | undefined {
  if (typeof node === 'string') return undefined
  const kids = node.children ?? []
  const holdsTarget = (k: Drawn): boolean => k === target || (typeof k !== 'string' && (k.children ?? []).some(holdsTarget))
  if (!kids.some(holdsTarget)) return undefined
  for (const child of kids) {
    const inner = crabBeside(child, target)
    if (inner) return inner
  }
  const image = kids.find(k => typeof k !== 'string' && k.type === 'Image') as Exclude<Drawn, string> | undefined
  return image ? { crabColumns: image.props.columns, gap: node.props.columnGap ?? node.props.gap ?? 0 } : undefined
}

// ---------------------------------------------------------------------------
// The session: only what the mod does not own sits beneath it (the clock, the environment, the pane list,
// the engine's model API and its drawing).

async function stage($: Engine, on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, {})
  const openedPanes: string[] = []
  const open = new Set<string>()
  const redraws = { stateWrites: 0, invalidations: 0 }
  const spawned = new Map<string, number>()
  let nextStep: Step = { read: 0, write: 0 }
  let hold: Promise<void> | undefined

  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', async (_$, e) => ({ value: { tool: e.name } }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.panes', async () => ({ value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
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
    if (e.plugin === 'autobots-progress') redraws.stateWrites++
    return next(e)
  })
  on('ui.invalidate', async (_$, e, next) => {
    redraws.invalidations++
    return next(e)
  })
  on('tool.call', { tool: 'Agent' }, async () => ({ result: 'started' }))
  on('agent.spawn', async (_$, e) => {
    const n = (spawned.get(e.subagentType) ?? 0) + 1
    spawned.set(e.subagentType, n)
    return { model: MODEL, agentId: n === 1 ? `agent-${e.subagentType}` : `agent-${e.subagentType}-${n}` }
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return Box({ key: 'engine-own-band' } as never)
  })
  // The model API beneath the mod: each request reports the usage of `nextStep`, and answers when `hold` lets it.
  on('turn.step', async function* (_$, e) {
    const s = nextStep
    const usage = {
      input_tokens: s.input ?? 0,
      output_tokens: s.output ?? 0,
      cache_read_input_tokens: s.read,
      cache_creation_input_tokens: s.write,
      model: s.model ?? MODEL,
    }
    if (hold) await hold
    yield { kind: 'stop' as const, stopReason: 'tool_use' as const, usage }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: s.tools ?? [], stopReason: 'tool_use' as const, usage }
  })
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('classic.SubagentStop', async () => ({}))

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  let index = 0
  const stepRequest = (agentId: string, s: Step) => {
    nextStep = s
    return $.turn.step({ turnId: 'turn-1', index: index++, model: s.model ?? MODEL, messageCount: 3, agentId })
  }
  const drain = async (agentId: string, s: Step): Promise<void> => {
    const stream = stepRequest(agentId, s)
    for await (const _chunk of stream) {
      // drain the stream
    }
    await stream.result
  }

  const w = {
    clock,
    redraws,
    // Starts a subagent as the engine does; returns its agent id.
    async spawn(type: string, description: string): Promise<string> {
      await $.tool.call({ tool: 'Agent', subagent_type: type, description, prompt: 'go' } as never)
      await $.agent.spawn({
        tool_use_id: 'toolu-spawn',
        prompt: 'go',
        description,
        subagentType: type,
        provider: { plugin: 'engine', tier: 'core' },
        parentModel: MODEL,
        background: false,
        fork: false,
      })
      const n = spawned.get(type)!
      return n === 1 ? `agent-${type}` : `agent-${type}-${n}`
    },
    // One model step that completes at once.
    step: drain,
    // Many identical steps, one after the other.
    // A model step that has started and not yet answered: `end()` lets it answer.
    async begin(agentId: string, s: Step): Promise<{ end(): Promise<void> }> {
      let release!: () => void
      hold = new Promise<void>(resolve => (release = resolve))
      const running = drain(agentId, s)
      await clock.settle()
      hold = undefined
      return {
        async end() {
          release()
          await running
        },
      }
    },
    // The end of the subagent's run, as the engine raises it.
    async finish(agentId: string, type: string): Promise<void> {
      await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 'turn-1', agentId })
      await $.classic.SubagentStop({ stop_hook_active: false, agent_id: agentId, agent_transcript_path: '', agent_type: type })
    },
    async openPanel(): Promise<void> {
      if (openedPanes.length === 0) await $.command.run({ command: 'agents-info', args: '' } as never)
      expect(openedPanes.length, 'the agents panel is open').toBeGreaterThan(0)
    },
    // The open panel drawn on a surface; the caller unmounts it.
    async mount(surface: Surface, bodyColumns = 100) {
      await w.openPanel()
      return $.ui.mount({
        plugin: 'autobots-progress',
        surface,
        component: 'Pane',
        requestId: openedPanes[0],
        props: { title: 'Agents', isFocused: false, bodyColumns, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
      })
    },
    // Every element the open panel draws on a surface, in document order.
    async elements(surface: Surface, bodyColumns = 100): Promise<Found[]> {
      const pane = await w.mount(surface, bodyColumns)
      const found = await pane.findAll({})
      await pane.unmount()
      return found
    },
    // The tree the open panel draws on the terminal.
    async tree(bodyColumns = 100): Promise<Drawn> {
      const pane = await w.mount('terminal', bodyColumns)
      const tree = (await pane.drawn()) as Drawn
      await pane.unmount()
      return tree
    },
    // The row of the subagent titled `title`, on a surface.
    async row(surface: Surface, title: string, bodyColumns = 100): Promise<RowView> {
      return rowIn(surface, await w.elements(surface, bodyColumns), title)
    },
    // What the progress band draws on a surface.
    async band(surface: Surface): Promise<string[]> {
      const ui = await $.ui.mount({
        plugin: 'autobots-progress',
        surface,
        component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
      })
      const els = await ui.findAll({})
      await ui.unmount()
      return els.flatMap(el => [el.text, typeof el.props.alt === 'string' ? el.props.alt : '']).filter(Boolean)
    },
    async plan(tasks: { title: string; role: string }[]): Promise<void> {
      await $.tool.call({ tool: 'mcp__autobots-progress__progress', title: 'Plan', total: tasks.length, phase: 'delegate', tasks } as never)
    },
  }
  return w
}
type Stage = Awaited<ReturnType<typeof stage>>

// What a surface shows of one row, in the form the tests read it.
type RowView = {
  surface: Surface
  // Every text the row shows, in order (on the desktop: the <text> elements of its drawing, not its description).
  texts: string[]
  // The terminal's crab (an Image, or the ▣ glyph where no image is drawn).
  crab?: Found
  // The desktop's drawing of the row.
  svg?: Found
  source: string
}

function rowIn(surface: Surface, els: Found[], title: string): RowView {
  if (surface === 'terminal') {
    const row = rowsOf(els).find(r => r.texts.some(t => t === title))
    expect(row, `the terminal draws a row titled ${title}`).toBeDefined()
    return { surface, texts: row!.texts, crab: row!.crab, source: '' }
  }
  const svg = els.find(el => el.type === 'Svg' && String(el.props.alt ?? '').startsWith(`${title}:`))
  expect(svg, `the desktop draws a row titled ${title}`).toBeDefined()
  const source = String(svg!.props.source ?? '')
  return { surface, texts: svgTexts(source), svg, source }
}

const joined = (row: RowView): string => row.texts.join(' ')

// ---------------------------------------------------------------------------
// Worked data. A coding-worker's steps, as a real session reports them.

const FIRST: Step = { read: 0, write: 10_000, input: 1_000 }
// Reads exactly what the step before it read and wrote: an ordinary step.
const after = (prev: Step, write = 1_000, input = 100): Step => ({ read: prev.read + prev.write, write, input })

// Runs `steps` as one coding-worker titled `title`, with no time between them.
async function run(w: Stage, title: string, steps: Step[], type = 'coding-worker'): Promise<string> {
  const id = await w.spawn(type, title)
  for (const s of steps) await w.step(id, s)
  return id
}

// ---------------------------------------------------------------------------

describe('data', () => {
  test('cache R1 the hit rate sums reads, writes and uncached input over every step the subagent has made', async ($, on) => {
    const w = await stage($, on)
    // Reads 0 + 10,000 + 13,000 = 23,000; writes 10,000 + 3,000 + 2,000 = 15,000; uncached 1,000 + 500 + 700 = 2,200.
    // 23,000 / 40,200 = 57.2%. The mean of the three steps' own rates is 52%, the rate without uncached input 61%,
    // and the last step alone 83%; output tokens (4,000 a step) are not input.
    await run(w, 'alpha', [
      { read: 0, write: 10_000, input: 1_000, output: 4_000 },
      { read: 10_000, write: 3_000, input: 500, output: 4_000 },
      { read: 13_000, write: 2_000, input: 700, output: 4_000 },
    ])
    for (const surface of SURFACES) {
      const row = joined(await w.row(surface, 'alpha'))
      expect(row, `cache 57% on the ${surface}`).toContain('cache 57%')
    }
  })

  test('cache R1 each subagent keeps its own steps: two subagents show their own hit rates', async ($, on) => {
    const w = await stage($, on)
    await run(w, 'alpha', [{ read: 0, write: 10_000, input: 1_000 }, { read: 10_000, write: 1_000, input: 1_000 }]) // 10,000 / 23,000 = 43%
    await run(w, 'bravo', [{ read: 0, write: 3_000, input: 1_000 }, { read: 3_000, write: 500, input: 500 }]) // 3,000 / 8,000 = 38%
    for (const surface of SURFACES) {
      const els = await w.elements(surface)
      expect(joined(rowIn(surface, els, 'alpha')), `alpha on the ${surface}`).toContain('cache 43%')
      expect(joined(rowIn(surface, els, 'bravo')), `bravo on the ${surface}`).toContain('cache 38%')
    }
  })
})

// A rebuild is told by the steam on a running subagent's crab (requirement 10). The terminal's crab is a
// still image, so it is compared with today's crab: the crab of a running subagent that has made no step yet,
// which has no cache temperature. Every subagent below is read at the moment its last step ended, when
// requirement 7 says the temperature has not touched the crab, so any difference is the steam.
describe('rebuild', () => {
  const todaysCrab = async (w: Stage): Promise<Found> => {
    await w.spawn('coding-worker', 'today')
    return rowIn('terminal', await w.elements('terminal'), 'today').crab!
  }
  // A subagent that certainly rebuilt: its second step reads nothing though the first wrote 10,000.
  const SURE_REBUILD: Step[] = [FIRST, { read: 0, write: 10_000, input: 100 }]
  const PRIOR_TOTAL = FIRST.read + FIRST.write // 10,000

  // Runs `steps` next to a subagent that certainly rebuilt; returns the crabs of both and today's.
  async function crabs(w: Stage, steps: Step[]) {
    const today = await todaysCrab(w)
    await run(w, 'reference', SURE_REBUILD)
    await run(w, 'candidate', steps)
    const els = await w.elements('terminal')
    return { today, reference: rowIn('terminal', els, 'reference').crab!, candidate: rowIn('terminal', els, 'candidate').crab! }
  }

  test('cache R2 a step is a rebuild when its cache read is more than 1,024 tokens below the previous cache read plus cache write', async ($, on) => {
    const w = await stage($, on)
    // The previous step read 0 and wrote 10,000. This step reads 8,975: 1,025 below 10,000.
    const c = await crabs(w, [FIRST, { read: PRIOR_TOTAL - 1_025, write: 1_025, input: 100 }])
    expect(sameImage(c.reference, c.today), 'a certain rebuild draws a crab unlike today (steam)').toBe(false)
    expect(sameImage(c.candidate, c.today), 'the 1,025-token drop draws a crab unlike today (steam)').toBe(false)
  })

  test('cache R2 a step whose cache read is exactly 1,024 tokens below the previous total is not a rebuild', async ($, on) => {
    const w = await stage($, on)
    const c = await crabs(w, [FIRST, { read: PRIOR_TOTAL - 1_024, write: 1_024, input: 100 }])
    expect(sameImage(c.reference, c.today), 'a certain rebuild draws a crab unlike today (steam)').toBe(false)
    expect(sameImage(c.candidate, c.today), 'the 1,024-token drop draws today\'s crab').toBe(true)
  })

  test('cache R2 the previous step counts its cache write too: a read equal to the previous read, far below read plus write, is a rebuild', async ($, on) => {
    const w = await stage($, on)
    // The previous step read 10,000 and wrote 20,000 (total 30,000). This step reads 10,000 again: the same read
    // as before, 20,000 below the total. Only a comparison with read plus write sees the rebuild.
    const c = await crabs(w, [FIRST, { read: 10_000, write: 20_000, input: 100 }, { read: 10_000, write: 20_000, input: 100 }])
    expect(sameImage(c.reference, c.today), 'a certain rebuild draws a crab unlike today (steam)').toBe(false)
    expect(sameImage(c.candidate, c.today), 'the step draws a crab unlike today (steam)').toBe(false)
  })

  test('cache R2 a read below the previous read but within 1,024 tokens of the previous total is not a rebuild', async ($, on) => {
    const w = await stage($, on)
    // The previous step read 10,000 and wrote 0 (total 10,000). This step reads 9,500: 500 below.
    const c = await crabs(w, [FIRST, { read: 10_000, write: 0, input: 100 }, { read: 9_500, write: 500, input: 100 }])
    expect(sameImage(c.reference, c.today), 'a certain rebuild draws a crab unlike today (steam)').toBe(false)
    expect(sameImage(c.candidate, c.today), 'the 500-token drop draws today\'s crab').toBe(true)
  })

  test('cache R2 a subagent whose first step reads nothing from the cache is not a rebuild', async ($, on) => {
    const w = await stage($, on)
    const c = await crabs(w, [FIRST])
    expect(sameImage(c.reference, c.today), 'a certain rebuild draws a crab unlike today (steam)').toBe(false)
    expect(sameImage(c.candidate, c.today), 'a first step draws today\'s crab').toBe(true)
  })

  test('cache R2 a step on a different model from the previous step is never a rebuild, however far its read falls', async ($, on) => {
    const w = await stage($, on)
    const c = await crabs(w, [FIRST, { read: 0, write: 10_000, input: 100, model: OTHER_MODEL }])
    expect(sameImage(c.reference, c.today), 'a certain rebuild draws a crab unlike today (steam)').toBe(false)
    expect(sameImage(c.candidate, c.today), 'a change of model draws today\'s crab').toBe(true)
  })

  test('cache R2 after a change of model, a later step is a rebuild against the step before it, on the same model', async ($, on) => {
    const w = await stage($, on)
    // Step 2 is on another model (never a rebuild). Step 3 is on the same model as step 2 and reads 0 after step 2 wrote 10,000.
    const c = await crabs(w, [
      FIRST,
      { read: 0, write: 10_000, input: 100, model: OTHER_MODEL },
      { read: 0, write: 10_000, input: 100, model: OTHER_MODEL },
    ])
    expect(sameImage(c.reference, c.today), 'a certain rebuild draws a crab unlike today (steam)').toBe(false)
    expect(sameImage(c.candidate, c.today), 'the step draws a crab unlike today (steam)').toBe(false)
  })
})

describe('text on each row', () => {
  test('cache R3 once a subagent has a step its row shows cache N%, N rounded to a whole percent, on the terminal and the desktop', async ($, on) => {
    const w = await stage($, on)
    // 2,000 / (2,000 + 500 + 500) = 66.7%: 67, not 66.
    await run(w, 'alpha', [{ read: 2_000, write: 500, input: 500 }])
    for (const surface of SURFACES) expect(joined(await w.row(surface, 'alpha')), `cache 67% on the ${surface}`).toContain('cache 67%')
  })

  test('cache R3 a first step that read nothing from the cache shows cache 0%', async ($, on) => {
    const w = await stage($, on)
    await run(w, 'alpha', [FIRST])
    for (const surface of SURFACES) expect(joined(await w.row(surface, 'alpha')), `cache 0% on the ${surface}`).toContain('cache 0%')
  })

  test('cache R3 before its first step a subagent shows no cache text, and neither does a planned task', async ($, on) => {
    const w = await stage($, on)
    await w.plan([{ title: 'planned task', role: 'qa-engineer' }])
    await w.spawn('reviewer', 'waiting')
    await run(w, 'stepped', [FIRST])
    for (const surface of SURFACES) {
      const els = await w.elements(surface)
      expect(joined(rowIn(surface, els, 'stepped')), `the subagent with a step shows cache text on the ${surface}`).toContain('cache 0%')
      const waiting = joined(rowIn(surface, els, 'waiting'))
      for (const word of ['cache', 'warm', 'cold']) expect(waiting, `no "${word}" before the first step on the ${surface}`).not.toContain(word)
    }
    // A planned task has a row of its own; its text is the title and its role.
    const planned = rowsOf(await w.elements('terminal')).find(r => r.texts.some(t => t.includes('planned task')))
    expect(planned, 'the planned task has a row').toBeDefined()
    for (const word of ['cache', 'warm', 'cold']) expect(planned!.texts.join(' '), `no "${word}" in a planned row`).not.toContain(word)
  })

  test('cache R4 a subagent is warm for 5 minutes after its last step: the row shows warm m:ss after the hit rate, counting down', async ($, on) => {
    const w = await stage($, on)
    await run(w, 'alpha', [FIRST])
    // 0 / 11,000: cache 0%.
    const warm = (m: number, ss: string) => new RegExp(`cache 0%[^\\d\\n]*warm ${m}:${ss}(?!\\d)`)
    for (const surface of SURFACES) expect(joined(await w.row(surface, 'alpha')), `warm 5:00 at the end of the step on the ${surface}`).toMatch(warm(5, '00'))
    await w.clock.advance(30_000)
    for (const surface of SURFACES) expect(joined(await w.row(surface, 'alpha')), `warm 4:30 after 30 s on the ${surface}`).toMatch(warm(4, '30'))
    await w.clock.advance(1_000)
    for (const surface of SURFACES) expect(joined(await w.row(surface, 'alpha')), `warm 4:29 after 31 s on the ${surface}`).toMatch(warm(4, '29'))
    await w.clock.advance(264_000) // 295 s in
    for (const surface of SURFACES) expect(joined(await w.row(surface, 'alpha')), `warm 0:05 after 295 s on the ${surface}`).toMatch(warm(0, '05'))
  })

  test('cache R4 after 5 minutes the subagent is cold: the row shows cold after the hit rate and no countdown', async ($, on) => {
    const w = await stage($, on)
    await run(w, 'alpha', [FIRST])
    await w.clock.advance(TTL + 1_000)
    for (const surface of SURFACES) {
      const row = joined(await w.row(surface, 'alpha'))
      expect(row, `cache 0% then cold on the ${surface}`).toMatch(/cache 0%[^\d\n]*cold/)
      expect(row, `no countdown on the ${surface}`).not.toContain('warm')
    }
  })

  test('cache R4 a warm subagent does not show cold', async ($, on) => {
    const w = await stage($, on)
    await run(w, 'alpha', [FIRST])
    await w.clock.advance(TTL - 1_000)
    for (const surface of SURFACES) {
      const row = joined(await w.row(surface, 'alpha'))
      expect(row, `warm 0:01 on the ${surface}`).toMatch(/warm 0:01(?!\d)/)
      expect(row, `not cold on the ${surface}`).not.toContain('cold')
    }
  })

  test('cache R4 a new step starts the countdown again from 5:00', async ($, on) => {
    const w = await stage($, on)
    const id = await run(w, 'alpha', [FIRST])
    await w.clock.advance(100_000)
    await w.step(id, after(FIRST))
    for (const surface of SURFACES) expect(joined(await w.row(surface, 'alpha')), `warm 5:00 on the ${surface}`).toMatch(/warm 5:00(?!\d)/)
  })

  test('cache R4 a cold subagent is warm again when it makes a step', async ($, on) => {
    const w = await stage($, on)
    const id = await run(w, 'alpha', [FIRST])
    await w.clock.advance(TTL + 60_000)
    expect(joined(await w.row('terminal', 'alpha')), 'cold after 6 minutes').toContain('cold')
    await w.step(id, { read: 0, write: 11_000, input: 100 })
    for (const surface of SURFACES) {
      const row = joined(await w.row(surface, 'alpha'))
      expect(row, `warm again on the ${surface}`).toMatch(/warm 5:00(?!\d)/)
      expect(row, `no longer cold on the ${surface}`).not.toContain('cold')
    }
  })

  test('cache R4 a subagent whose step is in progress is warm, even when its last finished step was over 5 minutes ago', async ($, on) => {
    const w = await stage($, on)
    const id = await run(w, 'alpha', [FIRST])
    await w.clock.advance(TTL + 2 * MINUTE)
    expect(joined(await w.row('terminal', 'alpha')), 'cold while it waits').toContain('cold')

    const inProgress = await w.begin(id, after(FIRST))
    for (const surface of SURFACES) {
      const row = joined(await w.row(surface, 'alpha'))
      expect(row, `warm while the step is in progress on the ${surface}`).toMatch(/cache \d+%[^\d\n]*warm \d+:\d{2}/)
      expect(row, `not cold while the step is in progress on the ${surface}`).not.toContain('cold')
    }
    await inProgress.end()
  })

  test('cache R5 on the terminal the cache text follows the existing stats', async ($, on) => {
    const w = await stage($, on)
    await run(w, 'alpha', [FIRST])
    const row = joined(await w.row('terminal', 'alpha'))
    // The existing stats read "ctx N% · <tokens> ≈$<cost> <m:ss>".
    expect(row).toMatch(/ctx \d+%.*≈\$[\d.]+.*\d+:\d{2}.*cache 0%/)
  })

  describe('width', () => {
    // A running coding-worker with an activity summary ("3 calls · Edit a.rb · 5s ago") and cache text.
    async function crowded($: Engine, on: On): Promise<Stage> {
      const w = await stage($, on)
      const id = await w.spawn('coding-worker', 'alpha')
      await w.step(id, { ...FIRST, tools: [{ name: 'Read', input: { file_path: '/w/a.rb' } }, { name: 'Read', input: { file_path: '/w/b.rb' } }] })
      await w.step(id, { ...after(FIRST), tools: [{ name: 'Edit', input: { file_path: '/w/a.rb' } }] })
      await w.clock.advance(5_000)
      return w
    }
    // What the row at `columns` wide shows, and whether the line holding it fits beside the crab.
    async function lineAt(w: Stage, columns: number) {
      const tree = await w.tree(columns)
      const hasActivity = textNodes(tree).some(t => /\bcalls?\b/.test(t))
      const hasCache = textNodes(tree).some(t => /cache \d+%/.test(t))
      const wanted = [/ctx \d+%/, ...(hasCache ? [/cache \d+%/] : []), ...(hasActivity ? [/\bcalls?\b/] : [])]
      const line = deepestHolding(tree, wanted)
      expect(line, `the row draws its stats at ${columns} columns`).toBeDefined()
      const beside = crabBeside(tree, line!)
      expect(beside, `the row's crab sits beside its text at ${columns} columns`).toBeDefined()
      const available = columns - beside!.crabColumns - beside!.gap
      return { hasActivity, hasCache, fits: measure(line!, columns).width <= available }
    }

    test('cache R5 when the row is too narrow the activity summary drops first, then the cache text, and what is shown fits the row', async ($, on) => {
      const w = await crowded($, on)
      const seen: { columns: number; hasActivity: boolean; hasCache: boolean; fits: boolean }[] = []
      for (let columns = 24; columns <= 110; columns++) seen.push({ columns, ...(await lineAt(w, columns)) })

      const widest = seen.at(-1)!
      expect(widest.hasCache && widest.hasActivity, 'at 110 columns the row shows its cache text and its activity').toBe(true)
      for (const s of seen) {
        if (s.hasActivity) expect(s.hasCache, `the activity is shown only with the cache text (${s.columns} columns)`).toBe(true)
        if (s.hasCache) expect(s.fits, `the cache text is shown only when the line fits (${s.columns} columns)`).toBe(true)
      }
      // Wider never shows less.
      for (const [i, s] of seen.entries()) {
        const next = seen[i + 1]
        if (!next) continue
        if (s.hasCache) expect(next.hasCache, `the cache text stays once shown (${s.columns} to ${next.columns} columns)`).toBe(true)
        if (s.hasActivity) expect(next.hasActivity, `the activity stays once shown (${s.columns} to ${next.columns} columns)`).toBe(true)
      }
      expect(seen.some(s => s.hasCache && !s.hasActivity), 'some width shows the cache text with the activity dropped').toBe(true)
      expect(seen.some(s => !s.hasCache && !s.hasActivity), 'some width drops both').toBe(true)
    })
  })

  test('cache R6 the terminal shows the cache text next to a still-image crab, and the desktop shows it too', async ($, on) => {
    const w = await stage($, on)
    await run(w, 'alpha', [FIRST])
    const terminal = await w.row('terminal', 'alpha')
    expect(terminal.crab?.type, 'the terminal draws its crab as an Image').toBe('Image')
    expect(joined(terminal), 'the terminal row shows the cache text').toMatch(/cache 0%[^\d\n]*warm 5:00/)
    expect(joined(await w.row('desktop', 'alpha')), 'the desktop row shows the cache text').toMatch(/cache 0%[^\d\n]*warm 5:00/)
  })

  // The kit cannot switch the terminal's image support off, so this is the nearest observable form: where the
  // terminal draws no image, the Image draws its alt text, so the crab there is the alt (▣) and nothing but
  // the row's own text can tell the temperature (R12). The alt must stay the plain glyph; the text carries the cache.
  test('cache R6 the cache text is row text, and the crab\'s alt stays the plain ▣ glyph, so a terminal without images still shows it', async ($, on) => {
    const w = await stage($, on)
    await run(w, 'alpha', [FIRST])
    await w.clock.advance(TTL + 1_000)
    const row = await w.row('terminal', 'alpha')
    expect(row.crab?.props.alt, 'the alt of a cold crab is the plain glyph').toBe('▣')
    expect(joined(row), 'the cache text is shown').toMatch(/cache 0%[^\d\n]*cold/)
  })
})

// ---------------------------------------------------------------------------
// Reading a desktop row's drawing. The desktop draws each row as one SVG; these read it as data.

type Attrs = Record<string, string>
const attrsOf = (tag: string): Attrs => Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(m => [m[1]!, m[2]!]))
const withoutStyle = (source: string): string => source.replace(/<style\b[\s\S]*?<\/style>/g, '')
const tagsOf = (source: string, name: string): Attrs[] => [...withoutStyle(source).matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map(m => attrsOf(m[0]))
const SHAPE_TAGS = ['rect', 'path', 'circle', 'ellipse', 'line', 'polygon', 'polyline', 'use', 'image']
// How many things the drawing draws, whatever they are, plus snowflake glyphs written as text.
const shapeCount = (source: string): number =>
  SHAPE_TAGS.reduce((n, tag) => n + tagsOf(source, tag).length, 0) + svgTexts(source).join('').replace(/[^❄❅❆]/g, '').length
const hasArea = (a: Attrs): boolean => Number(a.width ?? 0) * Number(a.height ?? 0) > 0
const rectsOf = (source: string): Attrs[] => tagsOf(source, 'rect').filter(hasArea)
const keyOf = (a: Attrs): string => JSON.stringify(Object.entries(a).sort(([x], [y]) => x.localeCompare(y)))
// The rects in `a` that `b` does not have, counting repeats.
function minus(a: Attrs[], b: Attrs[]): Attrs[] {
  const left = new Map<string, number>()
  for (const r of b) left.set(keyOf(r), (left.get(keyOf(r)) ?? 0) + 1)
  return a.filter(r => {
    const n = left.get(keyOf(r)) ?? 0
    if (n > 0) left.set(keyOf(r), n - 1)
    return n === 0
  })
}

// The rules of the drawing's CSS that apply always (media blocks left out), as class name to declarations.
function cssClasses(source: string): Map<string, string> {
  const css = svgCss(source).replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '')
  const out = new Map<string, string>()
  for (const m of css.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) out.set(m[1]!, `${out.get(m[1]!) ?? ''};${m[2]}`)
  return out
}
const declared = (decls: string, prop: string): string | undefined => new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(decls)?.[1]?.trim()

// How dark an element's fill looks on a white page, 0 (white) to 255 (black); undefined for no fill.
function darkness(a: Attrs, classes: Map<string, string>): number | undefined {
  const fromClass = (a.class ?? '').split(/\s+/).map(c => declared(classes.get(c) ?? '', 'fill')).filter(Boolean).at(-1)
  const fill = (a.fill ?? declared(a.style ?? '', 'fill') ?? fromClass ?? '').trim()
  let rgb: number[] | undefined
  let alpha = 1
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(fill)?.[1]
  if (hex) {
    const full = hex.length === 3 ? [...hex].map(c => c + c).join('') : hex
    rgb = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16))
  }
  const fn = /^rgba?\(([^)]*)\)$/i.exec(fill)?.[1]
  if (fn) {
    const parts = fn.split(/[\s,/]+/).filter(Boolean).map(Number)
    rgb = parts.slice(0, 3)
    if (parts[3] !== undefined) alpha = parts[3]
  }
  if (!rgb) return undefined
  alpha *= Number(a['fill-opacity'] ?? declared(a.style ?? '', 'fill-opacity') ?? 1) * Number(a.opacity ?? declared(a.style ?? '', 'opacity') ?? 1)
  const shown = rgb.map(c => alpha * c + (1 - alpha) * 255)
  return 255 - (0.2126 * shown[0]! + 0.7152 * shown[1]! + 0.0722 * shown[2]!)
}
// The mean darkness of some rects, each weighed by its area.
function weighedDarkness(rects: Attrs[], source: string): number {
  const classes = cssClasses(source)
  const parts = rects.map(r => ({ area: Number(r.width) * Number(r.height), dark: darkness(r, classes) })).filter(p => p.dark !== undefined)
  const total = parts.reduce((n, p) => n + p.area, 0)
  return total === 0 ? Number.NaN : parts.reduce((n, p) => n + p.area * p.dark!, 0) / total
}
// Every distinct paint (fill or stroke) the drawing names, by value or by class.
function paints(source: string): Set<string> {
  const classes = cssClasses(source)
  const out = new Set<string>()
  for (const tag of [...SHAPE_TAGS, 'g']) {
    for (const a of tagsOf(source, tag)) {
      for (const prop of ['fill', 'stroke'] as const) {
        const own = a[prop] ?? declared(a.style ?? '', prop)
        if (own && own !== 'none') out.add(`${prop}:${own}`)
        for (const c of (a.class ?? '').split(/\s+/)) {
          const viaClass = declared(classes.get(c) ?? '', prop)
          if (viaClass && viaClass !== 'none') out.add(`${prop}:${viaClass}`)
        }
      }
    }
  }
  return out
}
const inkCount = (source: string): number => shapeCount(source) + paints(source).size

// The reduced-motion rules of a drawing's CSS, and the selectors it animates outside them.
function motionOf(source: string): { animated: string[]; stoppedBy: string; smil: boolean } {
  const css = svgCss(source)
  const reduced = [...css.matchAll(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{((?:[^{}]*\{[^}]*\})*[^}]*)\}/g)].map(m => m[1]).join('\n')
  const plain = css.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '')
  const animated: string[] = []
  for (const m of plain.matchAll(/([^{}@]+)\{([^}]*)\}/g)) {
    if (/(^|;)\s*animation\s*:/.test(m[2]!)) animated.push(...m[1]!.split(',').map(x => x.trim()))
  }
  const inline = [...SHAPE_TAGS, 'g'].flatMap(t => tagsOf(source, t)).filter(a => /animation/.test(a.style ?? '')).map(a => `[inline ${keyOf(a)}]`)
  return { animated: [...animated, ...inline], stoppedBy: reduced, smil: /<(animate|animateTransform|animateMotion|set)\b/.test(withoutStyle(source)) }
}

// Every element a drawing draws (the <style> left out), whatever its tag, as its tag and attributes.
const elementsOf = (source: string): Array<Attrs & { tag: string }> =>
  [...withoutStyle(source).matchAll(/<([a-zA-Z][\w:-]*)\b[^>]*>/g)].map(m => ({ ...attrsOf(m[0]), tag: m[1]! }))
// What the last compound of a selector asks of an element: a tag (or none) and some classes.
function lastCompound(selector: string): { tag: string; classes: string[] } {
  const last = selector.trim().split(/[\s>+~]+/).at(-1) ?? ''
  return { tag: /^[a-zA-Z][\w-]*/.exec(last)?.[0] ?? '', classes: last.match(/\.[\w-]+/g)?.map(c => c.slice(1)) ?? [] }
}
const classesOf = (e: { class?: string }): string[] => (e.class ?? '').split(/\s+/).filter(Boolean)
const selectedBy = (selector: string, e: { tag: string; class?: string }): boolean => {
  const { tag, classes } = lastCompound(selector)
  return (tag === '' || tag === e.tag) && classes.every(c => classesOf(e).includes(c)) && (tag !== '' || classes.length > 0)
}
// The elements `source` draws that `baseline` does not, which an animation moves, each with whether
// prefers-reduced-motion stops it. An element is moved by a rule of the always-on CSS that selects it, or by an inline
// animation; it is stopped by a reduced-motion rule that turns animation off for a class it has (or for everything),
// and an inline animation only by one marked !important.
function animatedDrawn(source: string, baseline: string): Array<{ element: string; stopped: boolean }> {
  const { animated, stoppedBy } = motionOf(source)
  const reducedRules = [...stoppedBy.matchAll(/([^{}@]+)\{([^}]*)\}/g)]
    .filter(m => /animation(-name)?\s*:\s*none/.test(m[2]!))
    .map(m => ({ selectors: m[1]!.split(',').map(x => x.trim()), important: /animation(-name)?\s*:\s*none\s*!important/.test(m[2]!) }))
  const animatedSelectors = animated.filter(sel => !sel.startsWith('[inline'))
  const fresh = minus(elementsOf(source) as Attrs[], elementsOf(baseline) as Attrs[]) as Array<Attrs & { tag: string }>
  return fresh.flatMap(e => {
    const inline = /animation/.test(e.style ?? '')
    if (!inline && !animatedSelectors.some(sel => selectedBy(sel, e))) return []
    const stopsIt = (important: boolean): boolean =>
      reducedRules.some(r => (!important || r.important) && r.selectors.some(sel => sel === '*' || (lastCompound(sel).classes.length > 0 && selectedBy(sel, e))))
    return [{ element: `<${e.tag} class="${e.class ?? ''}">`, stopped: stopsIt(inline) }]
  })
}

// ---------------------------------------------------------------------------
// The crab: the terminal draws it as an Image, so its pixels are read; the desktop draws it in the SVG.

describe('the crab on the terminal', () => {
  // Today's crab: that of a running coding-worker that has made no step, which has no cache temperature.
  async function todaysCrab(w: Stage): Promise<Pixels> {
    await w.spawn('coding-worker', 'today')
    return pixelsOf(rowIn('terminal', await w.elements('terminal'), 'today').crab!)
  }
  const crabOf = async (w: Stage, title: string): Promise<Pixels> => pixelsOf((await w.row('terminal', title)).crab!)
  const equal = (a: Pixels, b: Pixels): boolean => a.bytes.length === b.bytes.length && a.bytes.every((v, i) => v === b.bytes[i])

  test('cache R7 a crab whose step is in progress looks as it does today, even after a fade and after it went cold', async ($, on) => {
    const w = await stage($, on)
    const today = await todaysCrab(w)
    const id = await run(w, 'alpha', [FIRST])
    await w.clock.advance(150_000)
    // Control: with no step in progress, the crab 150 s after its step has faded.
    expect(colorfulness(await crabOf(w, 'alpha')), 'the crab fades once its step is over').toBeLessThan(colorfulness(today) * 0.9)

    const first = await w.begin(id, after(FIRST))
    expect(equal(await crabOf(w, 'alpha'), today), 'while a step is in progress after a fade').toBe(true)
    await first.end()
    expect(equal(await crabOf(w, 'alpha'), today), 'at the moment that step ends').toBe(true)

    await w.clock.advance(TTL + 1_000)
    expect(blueness(await crabOf(w, 'alpha')), 'the crab is frosted once cold').toBeGreaterThan(blueness(today) + 20)
    const second = await w.begin(id, after(after(FIRST)))
    expect(equal(await crabOf(w, 'alpha'), today), 'while a step is in progress after going cold').toBe(true)
    await second.end()
  })

  test('cache R7 at the moment a step ends, the crab is the one it looks like today, after a first step and after a step that follows a cold spell', async ($, on) => {
    const w = await stage($, on)
    const today = await todaysCrab(w)
    const id = await run(w, 'alpha', [FIRST])
    expect(equal(await crabOf(w, 'alpha'), today), 'after the first step').toBe(true)
    await w.clock.advance(TTL + 60_000)
    expect(blueness(await crabOf(w, 'alpha')), 'cold in between').toBeGreaterThan(blueness(today) + 20)
    await w.step(id, after(FIRST))
    expect(equal(await crabOf(w, 'alpha'), today), 'after a step that ended a cold spell').toBe(true)
  })

  for (const finished of [false, true]) {
    test(`cache R8 after a step the crab of a ${finished ? 'finished' : 'running'} subagent fades steadily from its full colors toward grey: unchanged at 0 s, fully grey by 5 minutes`, async ($, on) => {
      const w = await stage($, on)
      const today = await todaysCrab(w)
      const id = await run(w, 'alpha', [FIRST])
      if (finished) await w.finish(id, 'coding-worker')
      const full = colorfulness(today)
      const seen: number[] = []
      let elapsed = 0
      for (const at of [0, 60, 120, 150, 180, 240, 299]) {
        await w.clock.advance((at - elapsed) * 1000)
        elapsed = at
        const crab = await crabOf(w, 'alpha')
        seen.push(colorfulness(crab) / full)
        expect(opaqueOf(crab).length, `the crab keeps its shape at ${at} s`).toBe(opaqueOf(today).length)
        if (at === 0 && !finished) expect(equal(crab, today), 'the crab is unchanged when the step ends').toBe(true)
      }
      const [r0, r60, r120, r150, r180, r240, r299] = seen as [number, number, number, number, number, number, number]
      expect(Math.abs(r0 - 1), 'the full colors at 0 s').toBeLessThan(1e-6)
      expect(r0 > r60 && r60 > r120 && r120 > r150 && r150 > r180 && r180 > r240 && r240 > r299, `the colors fade at every sample (${seen.map(x => x.toFixed(2)).join(', ')})`).toBe(true)
      expect(r150, 'about half the color is left at the half way mark').toBeGreaterThan(0.3)
      expect(r150, 'about half the color is left at the half way mark').toBeLessThan(0.7)
      expect(r299, 'next to no color is left a second before 5 minutes').toBeLessThan(0.1)
    })
  }

  test('cache R9 when cold the terminal crab is frosted: tinted blue-white, and it stays so', async ($, on) => {
    const w = await stage($, on)
    const today = await todaysCrab(w)
    await run(w, 'alpha', [FIRST])
    await w.clock.advance(299_000)
    const greyest = await crabOf(w, 'alpha')
    await w.clock.advance(2_000) // 301 s
    const cold = await crabOf(w, 'alpha')
    // Blueness is mean blue minus mean red over the crab's visible pixels: the orange crab is far below 0, grey near 0.
    expect(blueness(cold), 'cold is bluer than the grey it faded to').toBeGreaterThan(blueness(greyest) + 5)
    expect(blueness(cold), 'cold is bluer than today\'s crab').toBeGreaterThan(blueness(today) + 20)
    await w.clock.advance(600_000)
    expect(blueness(await crabOf(w, 'alpha')), 'it stays frosted').toBeGreaterThan(blueness(greyest) + 5)
  })

  test('cache R10 a running subagent\'s crab shows steam while its latest step is a rebuild, and not once an ordinary step follows', async ($, on) => {
    const w = await stage($, on)
    const today = await todaysCrab(w)
    const id = await run(w, 'alpha', [FIRST, { read: 0, write: 10_000, input: 100 }])
    expect(equal(await crabOf(w, 'alpha'), today), 'the rebuilt step draws a crab unlike today (steam)').toBe(false)
    await w.step(id, { read: 0, write: 10_000, input: 100 })
    // read 0 after a step that wrote 10,000 is a rebuild again: still steaming
    expect(equal(await crabOf(w, 'alpha'), today), 'a second rebuild keeps the steam').toBe(false)
    await w.step(id, { read: 10_000, write: 500, input: 100 })
    expect(equal(await crabOf(w, 'alpha'), today), 'an ordinary step takes the steam away').toBe(true)
  })

  test('cache R10 a finished subagent shows no steam, whatever its last step was', async ($, on) => {
    const w = await stage($, on)
    const today = await todaysCrab(w)
    // Control: the same rebuild, running, steams.
    await run(w, 'running', [FIRST, { read: 0, write: 10_000, input: 100 }])
    expect(equal(await crabOf(w, 'running'), today), 'a running rebuilt subagent steams').toBe(false)
    const rebuilt = await run(w, 'rebuilt', [FIRST, { read: 0, write: 10_000, input: 100 }])
    const ordinary = await run(w, 'ordinary', [FIRST, after(FIRST)])
    await w.finish(rebuilt, 'coding-worker')
    await w.finish(ordinary, 'coding-worker')
    expect(equal(await crabOf(w, 'rebuilt'), await crabOf(w, 'ordinary')), 'a finished rebuilt subagent\'s crab is a finished ordinary one\'s').toBe(true)
  })

  test('cache R11 a planned task keeps its dimmed crab with no temperature, however long the others run', async ($, on) => {
    const w = await stage($, on)
    await w.plan([{ title: 'planned task', role: 'qa-engineer' }])
    const dimmed = (await w.elements('terminal')).filter(e => e.type === 'Image' && e.props.alt === '▢')
    expect(dimmed.length, 'one planned crab').toBe(1)
    const before = pixelsOf(dimmed[0]!)
    const today = await todaysCrab(w)
    await run(w, 'alpha', [FIRST])
    await w.clock.advance(TTL + 120_000)
    // Control: the running subagents' crabs did change with the time.
    expect(blueness(await crabOf(w, 'alpha')), 'the subagent with a step is frosted').toBeGreaterThan(blueness(today) + 20)
    const later = (await w.elements('terminal')).filter(e => e.type === 'Image' && e.props.alt === '▢')
    expect(later.length, 'still one planned crab').toBe(1)
    expect(equal(pixelsOf(later[0]!), before), 'the planned crab is as it was').toBe(true)
  })
})

describe('the crab on the desktop', () => {
  const bodyOf = (row: RowView): string => svgShapes(row.source)

  test('cache R7 a crab whose step is in progress is not touched by the time that passes', async ($, on) => {
    const w = await stage($, on)
    const id = await run(w, 'alpha', [FIRST])
    await w.clock.advance(150_000)
    const faded = bodyOf(await w.row('desktop', 'alpha'))
    const inProgress = await w.begin(id, after(FIRST))
    const a = bodyOf(await w.row('desktop', 'alpha'))
    await w.clock.advance(100_000)
    const b = bodyOf(await w.row('desktop', 'alpha'))
    expect(b, 'while a step is in progress the drawing does not change').toBe(a)
    // Control: after the previous step ended, 150 s later, the crab had faded, so it was drawn otherwise.
    expect(a, 'the crab in progress is not the faded one').not.toBe(faded)
    await inProgress.end()
  })

  test('cache R8 after a step the desktop crab fades as the TTL runs down: the drawing differs at 0 s, 150 s and 299 s', async ($, on) => {
    const w = await stage($, on)
    await run(w, 'alpha', [FIRST])
    const t0 = bodyOf(await w.row('desktop', 'alpha'))
    await w.clock.advance(150_000)
    const t150 = bodyOf(await w.row('desktop', 'alpha'))
    await w.clock.advance(149_000)
    const t299 = bodyOf(await w.row('desktop', 'alpha'))
    expect(t150, '150 s differs from 0 s').not.toBe(t0)
    expect(t299, '299 s differs from 150 s').not.toBe(t150)
    expect(t299, '299 s differs from 0 s').not.toBe(t0)
  })

  test('cache R9 when cold the desktop crab is frosted and shows a snowflake: its drawing differs from the fully faded one and has more in it', async ($, on) => {
    const w = await stage($, on)
    await run(w, 'alpha', [FIRST])
    await w.clock.advance(299_000)
    const greyest = await w.row('desktop', 'alpha')
    await w.clock.advance(2_000)
    const cold = await w.row('desktop', 'alpha')
    expect(bodyOf(cold), 'cold is drawn otherwise than the grey before it').not.toBe(bodyOf(greyest))
    expect(shapeCount(cold.source), 'the snowflake adds something to the drawing').toBeGreaterThan(shapeCount(greyest.source))
  })

  test('cache R10 a running subagent\'s desktop crab shows steam while its latest step is a rebuild, and a finished one does not', async ($, on) => {
    const w = await stage($, on)
    // Two subagents with the same two steps but for the second step's read: 500 after a step of 2,000 is a rebuild; 1,000 is not.
    const one: Step = { read: 1_000, write: 1_000 }
    const rebuilt = await run(w, 'rebuilt', [one, { read: 500, write: 500 }])
    const ordinary = await run(w, 'ordinary', [one, { read: 1_000, write: 500 }])
    const running = { rebuilt: (await w.row('desktop', 'rebuilt')).source, ordinary: (await w.row('desktop', 'ordinary')).source }
    await w.finish(rebuilt, 'coding-worker')
    await w.finish(ordinary, 'coding-worker')
    const done = { rebuilt: (await w.row('desktop', 'rebuilt')).source, ordinary: (await w.row('desktop', 'ordinary')).source }
    // Whatever a rebuild adds to the strip stays when the subagent finishes; the steam goes. So the rebuilt row has
    // more drawn in it than the ordinary one by more while running than after.
    const runningExtra = inkCount(running.rebuilt) - inkCount(running.ordinary)
    const doneExtra = inkCount(done.rebuilt) - inkCount(done.ordinary)
    expect(runningExtra, 'the steam is drawn while running').toBeGreaterThan(doneExtra)
  })

  test('cache R12 whatever the frost and the steam animate is stopped by prefers-reduced-motion', async ($, on) => {
    const w = await stage($, on)
    await w.spawn('coding-worker', 'today')
    const baseline = (await w.row('desktop', 'today')).source
    await run(w, 'rebuilt', [FIRST, { read: 0, write: 10_000, input: 100 }])
    await run(w, 'frosted', [FIRST])
    const steaming = (await w.row('desktop', 'rebuilt')).source
    await w.clock.advance(TTL + 1_000)
    const frosted = (await w.row('desktop', 'frosted')).source
    // Control: the cold crab is drawn, so the feature is there to be checked.
    expect(shapeCount(frosted), 'a frosted crab draws something more than a cold-less one').toBeGreaterThan(shapeCount(baseline))
    for (const [what, source] of [['frost', frosted], ['steam', steaming]] as const) {
      const motion = motionOf(source)
      expect(motion.smil, `${what} is not drawn with SMIL animation, which prefers-reduced-motion cannot stop`).toBe(false)
      // Control: the frost and the steam do move something that is drawn (not only what the stylesheet names), so this checks.
      const moving = animatedDrawn(source, baseline)
      expect(moving.length, `an animated element of the ${what} is drawn, so there is something to stop`).toBeGreaterThan(0)
      for (const { element, stopped } of moving) {
        expect(stopped, `the animation of ${element} (${what}) is stopped under prefers-reduced-motion`).toBe(true)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// The strip (desktop only). Every subagent below makes steps of at most 4,000 tokens in all, so the row's
// context bar is the same (empty) for any of them and only the strip tells their rows apart.

describe('the strip on the desktop', () => {
  const SMALL: Step = { read: 750, write: 250 } // 1,000 tokens; the next step reading 750 is 250 below it
  // The finished row of a subagent, read at once so nothing has faded.
  async function finished(w: Stage, title: string, steps: Step[]): Promise<RowView> {
    const id = await run(w, title, steps)
    await w.finish(id, 'coding-worker')
    return w.row('desktop', title)
  }

  test('cache R13 each step adds one bar, drawn in two parts: every added step adds the same number of shapes, at least two', async ($, on) => {
    const w = await stage($, on)
    const counts: number[] = []
    for (const n of [1, 2, 3, 4]) counts.push(rectsOf((await finished(w, `steps-${n}`, Array(n).fill(SMALL))).source).length)
    const added = counts.slice(1).map((c, i) => c - counts[i]!)
    expect(added.every(d => d === added[0]), `each step adds the same (${added.join(', ')})`).toBe(true)
    expect(added[0], 'a bar is two parts: read and write').toBeGreaterThanOrEqual(2)
  })

  test('cache R13 a bar shows the step\'s cache read darker and its cache write lighter', async ($, on) => {
    const w = await stage($, on)
    // Two subagents with one step each, 2,000 tokens, split 1,500 / 500 one way and 500 / 1,500 the other. Their rows
    // differ in the strip only; what is in one and not the other is the parts of the one bar.
    const readHeavy = await finished(w, 'read-heavy', [{ read: 1_500, write: 500 }])
    const writeHeavy = await finished(w, 'write-heavy', [{ read: 500, write: 1_500 }])
    const a = minus(rectsOf(readHeavy.source), rectsOf(writeHeavy.source))
    const b = minus(rectsOf(writeHeavy.source), rectsOf(readHeavy.source))
    expect(a.length, 'the read-heavy bar has parts of its own').toBeGreaterThanOrEqual(2)
    expect(b.length, 'the write-heavy bar has parts of its own').toBeGreaterThanOrEqual(2)
    // 3/4 of the first bar is read and 1/4 write; the second is the other way: if read is darker, the first is darker.
    expect(weighedDarkness(a, readHeavy.source), 'read is drawn darker than write').toBeGreaterThan(weighedDarkness(b, writeHeavy.source))
  })

  test('cache R13 the bars are scaled to the largest step in the strip: the same steps at twice the size are drawn the same', async ($, on) => {
    const w = await stage($, on)
    const small = await finished(w, 'half', [{ read: 125, write: 125 }, { read: 375, write: 375 }])
    const big = await finished(w, 'whole', [{ read: 250, write: 250 }, { read: 750, write: 750 }])
    const none = await finished(w, 'none', [])
    expect(rectsOf(big.source).length - rectsOf(none.source).length, 'the strip is drawn at all').toBeGreaterThanOrEqual(4)
    expect(svgShapes(small.source), 'twice the tokens, the same drawing').toBe(svgShapes(big.source))
  })

  test('cache R13 the bars run oldest first: the later step\'s bar lies to the right of the earlier one', async ($, on) => {
    const w = await stage($, on)
    // Both subagents read 2,000 on both steps and write 500 then 1,000, or 1,000 then 500: the larger bar (3,000 tokens)
    // is the later one in the first row and the earlier one in the second.
    const up = await finished(w, 'up', [{ read: 2_000, write: 500 }, { read: 2_000, write: 1_000 }])
    const down = await finished(w, 'down', [{ read: 2_000, write: 1_000 }, { read: 2_000, write: 500 }])
    const a = minus(rectsOf(up.source), rectsOf(down.source))
    const b = minus(rectsOf(down.source), rectsOf(up.source))
    expect(a.length, 'the first row has parts of its own').toBeGreaterThanOrEqual(2)
    expect(b.length, 'the second row has parts of its own').toBeGreaterThanOrEqual(2)
    // Where the weight of what differs lies, left to right: the row with the larger later step weighs to the right.
    const centre = (rects: Attrs[]): number => {
      const area = (r: Attrs) => Number(r.width) * Number(r.height)
      return rects.reduce((n, r) => n + area(r) * (Number(r.x) + Number(r.width) / 2), 0) / rects.reduce((n, r) => n + area(r), 0)
    }
    expect(centre(a), 'the row whose later step is the larger weighs further to the right').toBeGreaterThan(centre(b))
  })

  test('cache R13 the terminal draws no strip', async ($, on) => {
    const w = await stage($, on)
    const id = await run(w, 'alpha', Array(4).fill(SMALL))
    await w.finish(id, 'coding-worker')
    // Control: the desktop does draw one.
    expect(rectsOf((await w.row('desktop', 'alpha')).source).length, 'the desktop row has a strip').toBeGreaterThan(rectsOf((await finished(w, 'none', [])).source).length)
    const row = await w.row('terminal', 'alpha')
    expect(row.texts.join('').match(/[▁▂▃▄▅▆▇]/g) ?? [], 'no bar glyphs on the terminal').toEqual([])
    const els = await w.elements('terminal')
    expect(els.filter(e => e.type === 'Svg').length, 'no drawing on the terminal').toBe(0)
    expect(els.filter(e => e.type === 'Image').length, 'one crab Image per row and no more').toBe(2)
  })

  test('cache R14 a rebuild step\'s bar is marked so it stands out from the others', async ($, on) => {
    const w = await stage($, on)
    // The same two steps but for the second step's read: 500 after a step of 2,000 is a rebuild; 1,000 is not.
    const rebuilt = await finished(w, 'rebuilt', [{ read: 1_000, write: 1_000 }, { read: 500, write: 500 }])
    const ordinary = await finished(w, 'ordinary', [{ read: 1_000, write: 1_000 }, { read: 1_000, write: 500 }])
    const moreShapes = shapeCount(rebuilt.source) > shapeCount(ordinary.source)
    const moreColors = paints(rebuilt.source).size > paints(ordinary.source).size
    expect(moreShapes || moreColors, 'the rebuild bar is drawn with a mark, an added shape or an added color').toBe(true)
  })

  test('cache R14 a rebuild bar\'s hover text gives the minutes since the previous step and the tokens rewritten', async ($, on) => {
    const w = await stage($, on)
    const id = await w.spawn('coding-worker', 'alpha')
    await w.step(id, { read: 0, write: 10_000, input: 100 })
    await w.clock.advance(7 * MINUTE)
    await w.step(id, { read: 0, write: 23_000, input: 100 })
    const titles = svgTitles((await w.row('desktop', 'alpha')).source)
    const tokens = /\b(23k|23\.0k|23,000|23000)\b/
    const minutes = /\b7(\.0+)?\s*(m|min|mins|minutes?)\b/i
    expect(titles.some(t => tokens.test(t) && minutes.test(t)), `a hover text names 7 minutes and 23k tokens (titles: ${JSON.stringify(titles)})`).toBe(true)
  })

  test('cache R15 when there are more steps than fit, the strip shows the most recent ones', async ($, on) => {
    const w = await stage($, on)
    // 500 steps of 1,000 tokens each do not fit in a row 792 pixels wide. Each subagent's steps are the same in the end, but
    // for how the first three divide their 1,000 tokens (and the last step for the third), so the row is the same
    // for the first two if and only if the oldest bars are not drawn.
    const tail = (n: number): Step[] => Array.from({ length: n }, () => ({ ...SMALL }))
    const lengthy = await finished(w, 'lengthy', tail(500))
    const otherStart = await finished(w, 'other-start', [{ read: 500, write: 500 }, { read: 500, write: 500 }, { read: 500, write: 500 }, ...tail(497)])
    const otherEnd = await finished(w, 'other-end', [...tail(499), { read: 500, write: 500 }])
    const short = await finished(w, 'short', tail(4))
    expect(rectsOf(lengthy.source).length - rectsOf(short.source).length, 'the strip is cut short of all 500 bars').toBeLessThan(2 * 496)
    expect(rectsOf(lengthy.source).length, 'the strip has bars').toBeGreaterThan(rectsOf(short.source).length - 1)
    expect(svgShapes(otherStart.source), 'the oldest steps are not shown').toBe(svgShapes(lengthy.source))
    expect(svgShapes(otherEnd.source), 'the latest step is shown').not.toBe(svgShapes(lengthy.source))
  })
})

// ---------------------------------------------------------------------------
// Redraws

describe('redraws', () => {
  const redrawsOf = (w: Stage): number => w.redraws.stateWrites + w.redraws.invalidations
  const clockText = (remaining: number): string => `warm ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`

  for (const surface of SURFACES) {
    test(`cache R16 the ${surface} row of a finished subagent redraws every second as its countdown runs down, until it is cold`, async ($, on) => {
      const w = await stage($, on)
      const id = await run(w, 'alpha', [FIRST])
      await w.finish(id, 'coding-worker')
      const pane = await w.mount(surface)
      const read = async (): Promise<string> => {
        const els = await pane.findAll({})
        return rowIn(surface, els, 'alpha').texts.join(' ')
      }
      expect(await read(), 'the row shows 5:00 at the start').toContain('warm 5:00')
      for (let s = 1; s <= 299; s++) {
        const before = redrawsOf(w)
        await w.clock.advance(1_000)
        expect(redrawsOf(w) - before, `a redraw is asked for in second ${s}`).toBeGreaterThanOrEqual(1)
        if ([1, 59, 60, 150, 299].includes(s)) expect(await read(), `the countdown at ${s} s without remounting`).toContain(clockText(300 - s))
      }
      await w.clock.advance(2_000)
      expect(await read(), 'cold').toContain('cold')
      await pane.unmount()
    })
  }

  test('cache R16 the terminal crab of a finished subagent fades on the open panel until it is cold', async ($, on) => {
    const w = await stage($, on)
    const id = await run(w, 'alpha', [FIRST])
    await w.finish(id, 'coding-worker')
    const pane = await w.mount('terminal')
    const colors = async (): Promise<number> => {
      const els = await pane.findAll({})
      return colorfulness(pixelsOf(rowIn('terminal', els, 'alpha').crab!))
    }
    const at0 = await colors()
    await w.clock.advance(100_000)
    const at100 = await colors()
    await w.clock.advance(100_000)
    const at200 = await colors()
    expect(at100, 'the crab on the open panel faded by 100 s').toBeLessThan(at0 * 0.8)
    expect(at200, 'and further by 200 s').toBeLessThan(at100 * 0.8)
    await pane.unmount()
  })

  test('cache R16 a finished subagent that has gone cold asks for no redraw, however long the time passes', async ($, on) => {
    const w = await stage($, on)
    const id = await run(w, 'alpha', [FIRST])
    await w.finish(id, 'coding-worker')
    // Control: while warm it asks for redraws.
    const warmBefore = redrawsOf(w)
    await w.clock.advance(10_000)
    expect(redrawsOf(w) - warmBefore, 'a warm finished subagent asks for redraws').toBeGreaterThanOrEqual(10)
    await w.clock.advance(TTL)
    const before = redrawsOf(w)
    await w.clock.advance(10 * MINUTE)
    expect(redrawsOf(w) - before, 'redraws asked for in ten minutes while cold').toBe(0)
  })
})

describe('where the cache view is', () => {
  test('cache decision the cache view is in the agents panel only: the progress band shows no cache text', async ($, on) => {
    const w = await stage($, on)
    await w.plan([{ title: 'alpha', role: 'coding-worker' }])
    await run(w, 'alpha', [FIRST])
    expect(joined(await w.row('terminal', 'alpha')), 'the panel shows the cache text').toContain('cache 0%')
    for (const surface of SURFACES) {
      const band = (await w.band(surface)).join(' ')
      expect(band.length, `the ${surface} band is drawn`).toBeGreaterThan(0)
      for (const word of ['cache', 'warm', 'cold']) expect(band, `no "${word}" in the ${surface} band`).not.toContain(word)
    }
  })
})
