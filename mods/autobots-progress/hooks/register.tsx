import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Flow, Panel, Phase, PlannedTask } from '../types'

const flow = atom({ plugin: 'autobots-progress', key: 'flow' } as const, null)
const agents = atom({ plugin: 'autobots-progress', key: 'agents' } as const, [])
const panel = atom({ plugin: 'autobots-progress', key: 'panel' } as const, {
  isCompact: false,
  isDoneCollapsed: false,
  autoOpenedFor: '',
})
const now = atom({ plugin: 'autobots-progress', key: 'now' } as const, 0)
const cwd = atom({ plugin: 'autobots-progress', key: 'cwd' } as const, '')

const TOOL = 'mcp__autobots-progress__progress'
const PANE = 'autobots-agents'
const PHASES: readonly Phase[] = ['plan', 'design', 'delegate', 'review', 'close']
const ACCENT = '#8f8cf4'
const DONE = '#5fbf8f'

type ProgressInput = {
  title?: string
  total?: number
  done?: number
  phase?: Phase
  finished?: boolean
  tasks?: { title?: string; role?: string; after?: number[] }[]
}

const directEdits = (n: number): string => `${n} direct ${n === 1 ? 'edit' : 'edits'}`

const TEXT = {
  pane: 'Agents',
  cost: 'Cost',
  tokens: 'Tokens',
  time: 'Time',
  collapse: 'Collapse',
  expand: 'Expand',
  running: 'Running',
  finished: 'Finished',
  planned: 'Planned',
  empty: 'No subagents yet.',
  round: 'round',
  failed: 'error',
  after: 'after',
  tokensWord: 'tokens',
  agentsCount: 'agents',
  isRunning: 'running',
  isFinished: 'finished',
  isPlanned: 'planned',
  opened: 'Agents panel opened.',
  closed: 'Agents panel closed.',
  done: 'Done',
  plan: 'Plan',
  design: 'Design',
  tasks: 'Tasks',
  review: 'Review',
  busy: 'running',
  calls: (n: number) => `${n} ${n === 1 ? 'call' : 'calls'}`,
  ago: 'ago',
  units: ['s', 'm', 'h'],
  mainAgent: (n: number) => `Main agent: ${directEdits(n)}`,
  reminder:
    'An autobots flow is active: file edits belong to the roster. This direct edit was counted and the owner sees the count. ' +
    'Delegate further changes to a roster subagent instead of editing files yourself.',
  closing: (n: number) =>
    n
      ? `main agent made ${directEdits(n)} during this flow; include this count in your closing summary`
      : 'main agent made no direct edits during this flow; include this in your closing summary',
} as const

const blank = (): Flow => ({
  title: 'autobots',
  total: 0,
  done: 0,
  running: 0,
  phase: 'plan',
  isFinished: false,
  tasks: [],
})

// The first progress call after the autobots skill started a flow continues it, whatever its title.
const isNewFlow = (prev: Flow | null, input: ProgressInput): boolean =>
  !prev ||
  prev.isFinished ||
  (!prev.isSkillStarted && input.title !== undefined && input.title.trim() !== prev.title)

// Autobots Mode counts the main agent's direct edits from the flow's start until finished: true.
const isCounting = (f: Flow | null): f is Flow & { edits: number } => !!f && !f.isFinished && f.edits !== undefined

const cleanTasks = (tasks: ProgressInput['tasks']): PlannedTask[] | undefined =>
  tasks
    ?.filter(t => t.title?.trim())
    .map(t => ({
      title: (t.title ?? '').trim(),
      role: roleOf((t.role ?? '').trim()),
      after: (t.after ?? []).filter(n => Number.isInteger(n) && n > 0),
    }))

const merge = (prev: Flow | null, input: ProgressInput): Flow => {
  // A new title means a new flow: never carry counters over from an earlier one.
  const base = isNewFlow(prev, input) || !prev ? blank() : { ...blank(), ...prev }
  const tasks = cleanTasks(input.tasks) ?? base.tasks
  const total = Math.max(0, Math.round(input.total ?? (input.tasks ? tasks.length : base.total)))
  const done = Math.min(total || Infinity, Math.max(0, Math.round(input.done ?? base.done)))
  const phase = input.phase && PHASES.includes(input.phase) ? input.phase : base.phase
  const { isSkillStarted: _, ...rest } = base
  return {
    ...rest,
    title: input.title?.trim() || base.title,
    total,
    done,
    phase: input.finished ? 'close' : phase,
    isFinished: input.finished === true,
    tasks,
    // A progress call starts counting at 0, or keeps the count; finished: true never starts it,
    // and keeps the counting flow's count even under a new title.
    ...(input.finished ? (isCounting(prev) ? { edits: prev.edits } : {}) : { edits: base.edits ?? 0 }),
  }
}

const label = (f: Flow): string => {
  if (f.isFinished) return TEXT.done
  if (f.phase === 'plan') return TEXT.plan
  if (f.phase === 'design') return TEXT.design
  const count = f.total ? `${f.done}/${f.total}` : `${f.running} ${TEXT.busy}`
  return `${f.phase === 'review' ? TEXT.review : TEXT.tasks} ${count}`
}

// The band's edit mark: shown once the count is above 0.
const editMark = (f: Flow): string => (f.edits ? `✎ ${f.edits}` : '')

const ratio = (f: Flow): number => (f.isFinished ? 1 : f.total ? f.done / f.total : 0)

// Deterministic noise so the dither does not shimmer between redraws.
const noise = (x: number, y: number): number => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

// The whole row is one SVG: the desktop wraps sibling elements onto new lines,
// so title, bar, percent and the crab live in one drawing; only the count and
// the dismiss are Buttons beside it.
const H = 22
const BAR_H = 16
const CRAB_W = 26
const CELL = 3
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

// Counts code points, so a cut never splits a surrogate pair.
const clip = (s: string, max: number): string => {
  const chars = [...s]
  return chars.length > max ? chars.slice(0, Math.max(1, max - 1)).join('') + '…' : s
}

// Rough advance of system UI text, in em; good enough to size the title's slot.
const charEm = (ch: string): number =>
  /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-Zmw@%]/.test(ch) ? 0.72 : 0.56

const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

// Cuts `s` to fit `maxW` pixels, with an ellipsis when it had to cut.
const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

const rowSvg = (f: Flow, W: number, isWorking: boolean): string => {
  // The title takes what it needs, up to 40% of the row; the bar takes the rest.
  const title = fitText(f.title, 13, Math.max(60, W * 0.4))
  const BAR_X = Math.round(16 + textWidth(title, 13) + 12)
  const BAR_W = Math.max(60, W - BAR_X - 46 - CRAB_W)
  const color = f.isFinished ? DONE : ACCENT
  const y0 = (H - BAR_H) / 2
  const fillW = Math.round(BAR_W * ratio(f))
  const runW = f.total ? Math.round((BAR_W * Math.min(f.total, f.done + f.running)) / f.total) : 0
  const dots: string[] = []

  // Dithered fill: sparse at the start, dense toward the head.
  const cols = Math.floor(fillW / CELL)
  const rows = Math.floor(BAR_H / CELL)
  for (let c = 0; c < cols; c++) {
    const density = 0.35 + 0.6 * Math.pow(c / Math.max(1, cols), 1.2)
    for (let r = 0; r < rows; r++) {
      if (noise(c, r) < density) dots.push(`<rect class="t${Math.floor(noise(r, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="2" height="2"/>`)
    }
  }
  // Handed to workers, not yet accepted: a faint second layer.
  const faint: string[] = []
  for (let c = cols; c < Math.floor(runW / CELL); c++) {
    for (let r = 0; r < rows; r++) {
      if (noise(c + 7, r + 3) < 0.2) faint.push(`<rect class="t${Math.floor(noise(r + 5, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="1.7" height="1.7"/>`)
    }
  }

  const ticks: string[] = []
  for (let i = 1; i < f.total; i++) {
    const x = Math.round((BAR_W * i) / f.total)
    if (x > fillW + 4) ticks.push(`<rect x="${x}" y="${BAR_H / 2 - 4}" width="1.5" height="8" rx="0.75"/>`)
  }

  const text = [label(f), editMark(f)].filter(Boolean).join(' · ')
  const pillW = Math.round(18 + text.length * 6.6)
  const pillX = Math.max(0, Math.min(BAR_W - pillW, fillW - pillW))
  const percent = `${Math.round(ratio(f) * 100)}%`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>
.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e4e4e2}.tk{fill:#b4b4b0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2c2c2c}.tk{fill:#5a5a5a}}
/* Pixels twinkle in four out-of-phase groups; a finished bar settles to a slow glow. */
.t0,.t1,.t2,.t3{animation:tw ${f.isFinished ? 3.2 : 2.2}s ease-in-out infinite}
.t1{animation-duration:${f.isFinished ? 3.8 : 2.8}s;animation-delay:-.7s}.t2{animation-duration:${f.isFinished ? 4.4 : 1.9}s;animation-delay:-1.3s}.t3{animation-duration:${f.isFinished ? 3.5 : 3.3}s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:${f.isFinished ? 0.8 : 0.3}}}
@media (prefers-reduced-motion: reduce){.t0,.t1,.t2,.t3{animation:none}}
</style>
<defs><clipPath id="c"><rect x="0" y="0" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath></defs>
<circle cx="5" cy="${H / 2}" r="4" fill="${color}"/>
<text class="t" x="16" y="${H / 2 + 4.5}" font-family="${FONT}" font-size="13" font-weight="500">${xml(title)}</text>
<g transform="translate(${BAR_X},${y0})">
<rect class="k" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<g clip-path="url(#c)">
<g fill="${color}">${dots.join('')}</g>
<g fill="${color}" opacity="0.45">${faint.join('')}</g>
<g class="tk">${ticks.join('')}</g>
</g>
<rect x="${pillX}" width="${pillW}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${color}"/>
<text x="${pillX + pillW / 2}" y="${BAR_H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="#ffffff">${xml(text)}</text>
</g>
<text class="m" x="${W - CRAB_W - 6}" y="${H / 2 + 4.5}" text-anchor="end" font-family="${FONT}" font-size="12.5" font-variant-numeric="tabular-nums">${percent}</text>
${CRAB_CSS}${crab(W - CRAB_W + 1, 0, 'other', false, isWorking, 0.8)}
</svg>`
}

const barText = (f: Flow, width: number): string => {
  const filled = Math.round(width * ratio(f))
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

// ---------------------------------------------------------------------------
// Agents panel: every subagent of the session, plus the tasks the flow planned.

// The autobots roster: the subagent types the dispatcher delegates to.
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

// Mid-tone hues that read on both light and dark backgrounds; anything off the roster is grey.
const ROLE_COLOR: Record<string, string> = {
  planner: '#7F77DD',
  advisor: '#A35BC2',
  'coding-worker': '#378ADD',
  'qa-engineer': '#1B9AAA',
  'fast-coding-worker': '#1D9E75',
  'doc-reviewer': '#6F9A2E',
  'helper-worker': '#BA7517',
  'forensic-analyst': '#9C6B4E',
  reviewer: '#D85A30',
  'edge-case-analyst': '#C2477E',
  'spec-test-writer': '#A88B1A',
}

const colorOf = (role: string): string => ROLE_COLOR[role] ?? '#888780'

// USD per million tokens: input, output, cache read, cache write (5-minute TTL).
// The engine reports tokens, not money, so the panel's cost is an estimate.
const PRICES: [RegExp, [number, number, number, number]][] = [
  [/fable|mythos/, [10, 50, 0.25, 12.5]],
  [/opus-5-5/, [4, 20, 0.2, 5]],
  [/opus/, [5, 25, 0.5, 6.25]],
  [/sonnet/, [2, 10, 0.2, 2.5]],
  // Haiku 5.5: cache read/write derived with the standard 0.1x / 1.25x multipliers.
  // Its higher rate above 100K-token prompts is ignored: the cost is an estimate.
  [/haiku-5-5/, [0.1, 0.5, 0.01, 0.125]],
  [/haiku/, [1, 5, 0.1, 1.25]],
]

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const priceOf = (model: string): [number, number, number, number] =>
  PRICES.find(([re]) => re.test(model.toLowerCase()))?.[1] ?? [4, 20, 0.2, 5]

const costOf = (model: string, u: Usage): number => {
  const [i, o, r, w] = priceOf(model)
  return (
    ((u.input_tokens || 0) * i +
      (u.output_tokens || 0) * o +
      (u.cache_read_input_tokens || 0) * r +
      (u.cache_creation_input_tokens || 0) * w) /
    1e6
  )
}

// 200K for Haiku 4.x and older (claude-haiku-4-5, claude-3-5-haiku-…); 1M for
// everything else, Haiku 5.5 included. `(?!\d)` keeps a date suffix from reading as a version.
const windowOf = (model: string): number => {
  if (!/haiku/i.test(model)) return 1_000_000
  const major = Number(/haiku-(\d{1,2})(?!\d)/i.exec(model)?.[1] ?? 0)
  return major >= 5 ? 1_000_000 : 200_000
}

// `reviewer`, or `autobots:reviewer` when the agents ship in a plugin. Exact names only.
const roleOf = (type: string): string => {
  const bare = type.replace(/^[^:]*:/, '')
  return (ROSTER as readonly string[]).includes(bare) ? bare : 'other'
}

const isRole = (type: string): boolean => roleOf(type) !== 'other'

const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`

const fmtCost = (usd: number): string => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const elapsed = (a: AgentRun, at: number): number => (a.endedAt ?? Math.max(at, a.startedAt)) - a.startedAt

// Leading shell assignments: `NAME=value`, the value bare, "double-quoted" or 'single-quoted'.
const ASSIGNMENTS = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"']*)(?:\s+|$))*/

// Shapes of a key or secret inside a search pattern. A heuristic, so each line names what it catches.
const SECRET_SHAPES: RegExp[] = [
  // Known key prefixes, at a word start so that `task-runner` or `kiosk-mode` is not `sk-`.
  /\b(?:sk-|[sr]k_(?:live|test)_|gh[pousr]_|github_pat_|xox[abeprs]-|xapp-|glpat-|whsec_|AIza)[A-Za-z0-9_-]{8,}/,
  // npm and Hugging Face tokens; a long tail, so that `npm_package_version` or `hf_hub_download` is not one.
  /\b(?:npm_|hf_)[A-Za-z0-9]{16,}/,
  // An AWS access key id, and a 40-character AWS secret access key standing alone.
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}/,
  /(?<![A-Za-z0-9\/+])[A-Za-z0-9\/+]{40}(?![A-Za-z0-9\/+])/,
  // A PEM private-key header, and a JWT.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[\w-]+\.eyJ[\w-]+\./,
  // Credentials in a URL: `//user:password@`.
  /\/\/[^\s\/@:]+:[^\s\/@]+@/,
  // A sensitive name, with any suffix (`secret_key`, `x-api-key`), then `=` or `:` and a value: the
  // match runs over the whole value, past a `Bearer` or `Basic` scheme, to its closing quote or the
  // end of its word. A quote never closed runs to the end of the text.
  /(?:password|passwd|secret|token|api[_-]?key|authorization)[\w-]*["']?\s*[:=]\s*(?:(?:bearer|basic)\s+)?(?:"[^\s"'][^"]*"?|'[^\s"'][^']*'?|[^\s"']\S*)/i,
  // A bearer token.
  /\bbearer\s+[A-Za-z0-9._~+\/-]{8,}/i,
]

// The shapes again, global, to find every match in a text.
const SECRET_SPANS = SECRET_SHAPES.map(shape => new RegExp(shape.source, `${shape.flags}g`))

// Whether a search pattern looks like it holds a key or secret: one of the shapes above, or a
// long random-looking run of letters and digits (hex digests included). A pattern over 512
// characters counts as secret unread, which also bounds the regexes' running time.
// A bare short password with nothing naming it passes.
const looksSecret = (s: string): boolean =>
  s.length > 512 ||
  SECRET_SHAPES.some(shape => shape.test(s)) ||
  (s.match(/[A-Za-z0-9]{20,}/g) ?? []).some(run => /\d/.test(run) && /[A-Za-z]/.test(run))

// Text the model wrote (a title or description) as shown: each word that looks like a key or
// secret becomes •••. A shape can span words (`api_key: abc123`, `Bearer <token>`), so every word
// a shape's match touches is masked too, and a run of masked words reads as one •••. For display
// only: state keeps the raw text, which planned tasks and runs are matched by.
const maskSecrets = (s: string): string => {
  if (s.length > 512) return '•••'
  const spans = SECRET_SPANS.flatMap(shape => [...s.matchAll(shape)].map((m): [number, number] => [m.index, m.index + m[0].length]))
  const touched = (at: number, end: number) => spans.some(([a, b]) => a < end && at < b)
  return s
    .replace(/\S+/g, (word, at: number) => (looksSecret(word) || touched(at, at + word.length) ? '•••' : word))
    .replace(/•••(?:\s+•••)+/g, '•••')
}

// A tool call as the panel may show it: the tool's name and at most a short,
// non-sensitive target. Never a full command, URL, query or path.
const summarizeTool = (name: string, input: unknown): string => {
  const field = (key: string): string => {
    const v = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined
    return typeof v === 'string' ? v : ''
  }
  let target = ''
  if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(name)) target = field('file_path').split(/[\\/]/).pop() ?? ''
  else if (name === 'Grep' || name === 'Glob') {
    // Glob shows only its pattern's last segment, never a directory. Either is checked whole,
    // before the cut, so a secret past the 24th character still hides it.
    const pattern = name === 'Glob' ? field('pattern').split(/[\\/]/).pop() ?? '' : field('pattern')
    target = looksSecret(pattern) ? '' : clip(pattern, 24)
  }
  else if (name === 'Bash') {
    // The command's file name only: past any `NAME=value` prefixes (values bare or quoted,
    // spaces and all), unquoted, without directories. An assignment the pattern cannot close,
    // such as an unterminated quote, leaves just `Bash`: never part of its value.
    const rest = field('command').trimStart().replace(ASSIGNMENTS, '')
    const word = /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest) ? '' : (rest.split(/\s/)[0] ?? '')
    const file = word.replace(/^['"]+|['"]+$/g, '').split(/[\\/]/).pop() ?? ''
    target = looksSecret(file) ? '' : clip(file, 24)
  }
  else if (name === 'WebFetch') {
    try {
      target = new URL(field('url')).host
    } catch {
      // Not a URL: the tool name alone.
    }
  }
  // Control characters would drive the terminal, and bidi or zero-width ones would disguise
  // the text; none of them print. The cap bounds what reaches state and the alt text.
  return clip(`${name} ${target}`.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim(), 40)
}

const fmtAge = (ms: number): string => {
  const [sec, min, hr] = TEXT.units
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}${sec}`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}${min}` : `${Math.floor(m / 60)}${hr}`
}

// What the agent is doing, observed from its steps: nothing before its first tool call;
// how long ago its last step was, only while it runs.
const activityOf = (a: AgentRun, at: number): string => {
  if (!a.toolCalls) return ''
  const parts = [TEXT.calls(a.toolCalls), a.lastTool ?? '']
  if (a.status === 'running' && a.lastStepAt !== undefined) parts.push(`${fmtAge(at - a.lastStepAt)} ${TEXT.ago}`)
  return parts.filter(Boolean).join(' · ')
}

type Planned = PlannedTask & { n: number }

const plannedOf = (f: Flow | null, list: AgentRun[]): Planned[] => {
  if (!f || f.isFinished) return []
  const started = new Set(list.map(a => norm(a.description)))
  // Matched by the raw title, then masked for display.
  return (f.tasks ?? [])
    .map((t, i) => ({ ...t, n: i + 1 }))
    .filter(t => !started.has(norm(t.title)))
    .map(t => ({ ...t, title: maskSecrets(t.title) }))
}

const totals = (list: AgentRun[], at: number) => {
  const cost = list.reduce((s, a) => s + a.costUsd, 0)
  const tokens = list.reduce((s, a) => s + a.tokens, 0)
  const start = Math.min(...list.map(a => a.startedAt))
  const end = Math.max(...list.map(a => a.endedAt ?? Math.max(at, a.startedAt)))
  return { cost, tokens, time: list.length ? end - start : 0 }
}

// --- desktop drawings: each row is one SVG, as the band above the prompt is.

const PANE_CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.m{fill:#9a9a96}.k{fill:#ecebe8}.ln{stroke:#e4e4e1}.tile{fill:#f4f3f0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.m{fill:#7d7d79}.k{fill:#2c2c2b}.ln{stroke:#333331}.tile{fill:#262625}}
.live{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.3}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
</style>`

// Pixel Clawd from DockCrab (Clawdy): a 24×18 crab on a 30×28 grid, one costume per role.
// The body keeps the brand clay; the role's color lives in the costume's accent.
const CLAY = '#D97757'
const INK = '#1F1E1D'

// `cls` puts a pixel in a named group: `bd` (the default) is the body and its
// costume, `la`/`lb` the leg pairs, anything else a prop with its own motion.
type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void

const stamp = (f: Fill, x: number, y: number, rows: string[], map: Record<string, string>, cls?: string): void =>
  rows.forEach((row, dy) => [...row].forEach((ch, dx) => map[ch] && f(x + dx, y + dy, 1, 1, map[ch] ?? '', cls)))

// `armCls` lets a raised claw travel with the prop it holds.
const crabBody = (f: Fill, armFront = 0, armCls?: string): void => {
  f(7, 10, 16, 12, CLAY)
  f(3, 14, 4, 4, CLAY)
  f(23, 14 + armFront, 4, 4, CLAY, armCls)
  f(9, 12, 2, 2, INK)
  f(19, 12, 2, 2, INK)
  f(7, 22, 2, 4, CLAY, 'la')
  f(17, 22, 2, 4, CLAY, 'la')
  f(11, 22, 2, 4, CLAY, 'lb')
  f(21, 22, 2, 4, CLAY, 'lb')
}

// Pure CSS, run by the compositor: no redraws. Periods divide one second, so the
// once-a-second redraw of a running row restarts them in phase. Every crab walks;
// some costumes add their prop's own motion on top.
const CRAB_CSS = `<style>
.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.125s}
.run g{transform-box:fill-box}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
@keyframes blink{50%{opacity:.15}}
.c-forensic-analyst.run .it,.c-reviewer.run .it{animation:scan 1s steps(1) infinite}
.c-forensic-analyst.run .gl{animation:blink 1s steps(1) infinite -.5s}
@keyframes scan{25%{transform:translate(-1px,1px)}50%{transform:translate(-2px,2px)}75%{transform:translate(-1px,1px)}}
.c-coding-worker.run .it{transform-origin:100% 100%;animation:twist .5s ease-in-out infinite}
@keyframes twist{50%{transform:rotate(-35deg)}}
.c-fast-coding-worker.run .la{animation-duration:.25s}.c-fast-coding-worker.run .lb{animation-duration:.25s;animation-delay:-.125s}
.c-fast-coding-worker.run .star,.c-edge-case-analyst.run .star,.c-helper-worker.run .star{animation:blink .5s steps(1) infinite -.25s}
.c-explore.run .it,.c-qa-engineer.run .it{transform-origin:50% 100%;animation:fence .5s ease-in-out infinite}
@keyframes fence{50%{transform:rotate(25deg)}}
@media (prefers-reduced-motion: reduce){.run,.run g{animation:none!important}}
</style>`

// One costume per role, keyed by its name, plus `explore`; anything else is the plain crab.
// `t` is the role's color. The terminal shows these at about 6×3 cells: bold props, few pixels.
const COSTUMES: Record<string, (f: Fill, t: string) => void> = {
  // Planner: holds up a rolled blueprint, unfurled between its two rolls.
  planner: (f, t) => {
    crabBody(f, -4)
    stamp(f, 19, 0, ['crrrrrrrrrc', 'crrrrrrrrrc', '.bbbbbbbbb.', '.bwwwwwbwb.', '.bwbbbwbwb.', '.bwbbbwwwb.', '.bwwwwwbbb.', 'crrrrrrrrrc', 'crrrrrrrrrc'], { r: '#2F6DB5', b: '#5B93D6', w: '#F8F6F1', c: t })
  },
  // Advisor: a graduation cap; the tassel hangs in the role's color.
  advisor: (f, t) => {
    crabBody(f)
    stamp(f, 3, 4, ['...........kk...........', 'kkkkkkkkkkkkkkkkkkkkkkkk', '..kkkkkkkkkkkkkkkkkkkk..', '......kkkkkkkkkkkk......', '......kkkkkkkkkkkk......'], { k: '#2A2A2C' })
    f(14, 4, 2, 1, t); f(16, 5, 9, 1, t); f(25, 5, 1, 6, t); f(24, 11, 3, 2, t)
  },
  // Coding worker: engineer in a hard hat; the wrench turns a bolt.
  'coding-worker': (f, t) => {
    crabBody(f)
    stamp(f, 6, 4, ['.....yyyyyyyy.....', '...yyyyyhhyyyyy...', '..yyyyyyhhyyyyyy..', '..yyyyyyhhyyyyyy..', '.yyyyyyyhhyyyyyyy.', 'dddddddddddddddddd'], { y: '#F5C542', h: '#FBE08A', d: '#C99A1E' })
    f(13, 5, 4, 2, t)
    stamp(f, 0, 6, ['s...s', 'ss.ss', 'sssss', '.sss.', '..s..', '.sss.', '.sss.', '.sss.'], { s: '#B4B8BF' }, 'it')
  },
  // Fast coding worker: a headband whose tails stream back, and speed lines; runs at double pace.
  'fast-coding-worker': (f, t) => {
    crabBody(f)
    f(7, 9, 16, 2, t); f(1, 8, 6, 2, t); f(2, 11, 5, 1, t)
    for (const y of [15, 19]) f(0, y, 2, 1, '#F8F6F1', 'star')
    f(0, 13, 3, 1, '#F8F6F1', 'star'); f(0, 21, 5, 1, '#F8F6F1', 'star')
  },
  // Helper worker: holds up a flashlight; its beam lights the way ahead and flickers.
  'helper-worker': (f, t) => {
    crabBody(f, -4)
    stamp(f, 19, 5, ['.kk.......', 'ykk.......', 'ykkgggtggg', 'ykkgggtggg', 'ykkgggtggg', 'ykk.......', '.kk.......'], { y: '#FFFBE0', k: '#C9CCD2', g: '#3A3A3C', t })
    stamp(f, 1, 0, ['ccc...............', 'ccccbbb...........', 'ccccbbbbb.........', 'ccccbbbbbaaa......', 'ccccbbbbbaaaaa....', 'ccccbbbbbaaaaaaaa.', 'ccccbbbbbaaaaaaaaa', 'ccccbbbbbaaaaaaaaa', 'ccccbbbbbaaaaaaaaa', 'ccccbbbbbaaaaaaaaa'], { a: 'rgba(255,230,110,.75)', b: 'rgba(255,230,110,.5)', c: 'rgba(255,230,110,.28)' }, 'star')
  },
  // Forensic analyst: detective with a deerstalker; the magnifier sweeps and glints.
  'forensic-analyst': (f, t) => {
    crabBody(f, -4, 'it')
    stamp(f, 6, 3, ['......bbbbbb......', '....bbcbbcbbbb....', '...bbbbbbbbbbbb...', '..bcbbcbbcbbcbbb..', '.bbbbbbbbbbbbbbbb.', 'dddddddddddddddddd'], { b: '#7A4A26', c: '#A0703F', d: '#5A3519' })
    f(6, 9, 18, 1, t)
    stamp(f, 23, 1, ['.kkk.', 'k...k', 'k...k', 'k...k', '.kkk.'], { k: '#3A3A3C' }, 'it')
    f(24, 2, 3, 3, 'rgba(169,214,245,.7)', 'it'); f(25, 6, 1, 4, '#7A4A26', 'it'); f(24, 2, 1, 1, '#fff', 'gl')
  },
  // Doc reviewer: reading glasses and an open book held in both claws.
  'doc-reviewer': (f, t) => {
    crabBody(f)
    stamp(f, 7, 10, ['tttt......tttt', 't..tttttttt..t', 't..t......t..t', 'tttt......tttt'], { t })
    stamp(f, 4, 15, ['.wwwwwwwkwwwwwwww.', 'wgggwwwwkwwgggwwww', 'wwwwwwwwkwwwwwwwww', 'wgggggwwkwwgggggww', 'wwwwwwwwkwwwwwwwww', 'cccccccccccccccccc'], { w: '#F8F6F1', g: '#9A9A96', k: '#C9CCD2', c: t })
  },
  // Reviewer: a gold monocle on its chain, and a red pen at the ready.
  reviewer: (f, t) => {
    crabBody(f, -4, 'it')
    stamp(f, 17, 10, ['.ooo.', 'o...o', 'o...o', 'o...o', '.ooo.'], { o: '#F5C542' })
    f(17, 15, 1, 1, '#F5C542'); f(16, 16, 1, 1, '#F5C542'); f(16, 18, 1, 1, '#F5C542')
    stamp(f, 23, 0, ['..k.', '.rrr', '.rrr', '.www', '.rrr', '.rrr', '.rrr', '.rrr', '.rrr', '.ttt'], { k: INK, r: '#D0312D', w: '#F8F6F1', t }, 'it')
  },
  // QA engineer: goggles pushed up, and a bug net to catch them with.
  'qa-engineer': (f, t) => {
    crabBody(f)
    f(7, 9, 16, 1, INK)
    stamp(f, 8, 6, ['.tttt..tttt.', 'tggggttggggt', 'tggggttggggt', '.tttt..tttt.'], { t, g: 'rgba(169,214,245,.9)' })
    stamp(f, 0, 0, ['.wwwww.', 'wm.m.mw', 'w.m.m.w', 'wm.m.mw', '.wm.mw.', '..www..'], { w: '#F8F6F1', m: '#C9CCD2' }, 'it')
    f(3, 6, 1, 9, '#7A4A26', 'it')
  },
  // Edge-case analyst: a caution cone for a hat; its stripes flash.
  'edge-case-analyst': (f, t) => {
    crabBody(f)
    stamp(f, 8, 0, ['......oo......', '.....oooo.....', '.....wwww.....', '....oooooo....', '....oooooo....', '...wwwwwwww...', '...oooooooo...', '..oooooooooo..', 'tttttttttttttt', 'tttttttttttttt'], { o: '#F07A1E', w: '#F8F6F1', t })
    f(11, 2, 8, 1, '#F8F6F1', 'star'); f(11, 5, 8, 1, '#F8F6F1', 'star')
  },
  // Spec-test writer: a checklist on a clipboard, a pencil behind the ear.
  'spec-test-writer': (f, t) => {
    crabBody(f, -4)
    stamp(f, 20, 0, ['...ss...', 'bbbssbbb', 'bwwwwwwb', 'bwcwkkwb', 'bwwwwwwb', 'bwcwkkwb', 'bwwwwwwb', 'bwcwkkwb', 'bwwwwwwb', 'bbbbbbbb'], { s: '#8E929A', b: '#9C6B3E', w: '#F8F6F1', c: t, k: '#9A9A96' })
    stamp(f, 3, 7, ['ppgyyyyyyyyyyyee.', 'ppgyyyyyyyyyyyeeek'], { p: '#E88FA0', g: '#C9CCD2', y: '#F5C542', e: '#E8C9A0', k: INK })
  },
  // Explore: pirate scouting the code; the cutlass fences.
  explore: f => {
    crabBody(f)
    stamp(f, 5, 3, ['.kk..............kk.', '.kkk....kkkk....kkk.', '..kkkkkkkwwkkkkkkk..', '..kkkkkkkkkkkkkkkk..', '.gggggggggggggggggg.'], { k: '#55514C', w: '#F8F6F1', g: '#F5C542' })
    f(7, 11, 11, 1, INK); f(18, 11, 4, 3, INK)
    f(27, 6, 1, 9, '#C9CCD2', 'it'); f(26, 15, 3, 1, '#7A4A26', 'it')
  },
}

// What a crab is drawn as: a role, `explore`, or `other`, the plain crab.
const costumeOf = (type: string): string => (type === 'Explore' ? 'explore' : roleOf(type))

const CRAB_SCALE = 1.1

type Rect = [x: number, y: number, w: number, h: number, c: string]

// A costume's pixels by group, in paint order: the body (`bd`) first, then each
// prop, then the leg pairs `la` and `lb`. Both the SVG crab and the terminal's
// image are painted from this.
const crabRects = (costume: string): [string, Rect[]][] => {
  const groups = new Map<string, Rect[]>([['bd', []]])
  const f: Fill = (x, y, w, h, c, cls = 'bd') => {
    if (!groups.has(cls)) groups.set(cls, [])
    groups.get(cls)?.push([x, y, w, h, c])
  }
  const draw = COSTUMES[costume] ?? ((g: Fill) => crabBody(g))
  draw(f, colorOf(costume))
  const legs = ['la', 'lb']
  return [...[...groups].filter(([cls]) => !legs.includes(cls)), ...legs.map((cls): [string, Rect[]] => [cls, groups.get(cls) ?? []])]
}

// A planned crab is drawn at this opacity, on both surfaces.
const DIM = 0.45

// Body and props nest inside `bd` so a prop rides the bob and adds its own motion;
// legs stay outside it and step on their own.
const crab = (x: number, y: number, costume: string, dim = false, isWalking = false, scale = CRAB_SCALE): string => {
  const groups = crabRects(costume)
  const rects = (list: Rect[]) => list.map(([cx, cy, w, h, c]) => `<rect x="${cx}" y="${cy}" width="${w}" height="${h}" fill="${c}"/>`).join('')
  const group = ([cls, list]: [string, Rect[]]) => `<g class="${cls}">${rects(list)}</g>`
  const [[, bd = []] = [], ...props] = groups.slice(0, -2)
  const body = `<g class="bd">${rects(bd)}${props.map(group).join('')}</g>`
  return `<g transform="translate(${x},${y}) scale(${scale})" opacity="${dim ? DIM : 1}" shape-rendering="crispEdges"><g class="c-${costume}${isWalking ? ' run' : ''}">${body}${groups.slice(-2).map(group).join('')}</g></g>`
}

// The terminal's crab: the same pixels as an RGBA image of the 30×28 grid, still.
const CRAB_GRID = { width: 30, height: 28 }
const crabImages = new Map<string, { rgba: string; width: number; height: number }>()

const rgbaOf = (c: string): number[] => {
  const m = /^rgba\(([\d.]+),([\d.]+),([\d.]+),([\d.]+)\)$/.exec(c)
  if (m) return m.slice(1).map(Number)
  if (!/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(c)) throw new Error(`crab color ${c}: not #rgb, #rrggbb or rgba()`)
  const hex = c.length === 4 ? [...c.slice(1)].map(d => d + d).join('') : c.slice(1)
  return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).concat(1)
}

// One per costume and dimness; a dimmed crab is the whole image at DIM opacity, as the SVG group is.
const crabImage = (costume: string, dim = false) => {
  const key = `${costume}:${dim}`
  const cached = crabImages.get(key)
  if (cached) return cached
  const { width, height } = CRAB_GRID
  const buf = new Float64Array(width * height * 4) // straight RGB 0-255, alpha 0-1
  for (const [, list] of crabRects(costume)) {
    for (const [x, y, w, h, c] of list) {
      const [r = 0, g = 0, b = 0, a = 1] = rgbaOf(c)
      for (let row = Math.max(0, y); row < Math.min(height, y + h); row++) {
        for (let col = Math.max(0, x); col < Math.min(width, x + w); col++) {
          // Source over, as the SVG paints a translucent rect over what lies beneath.
          const i = (row * width + col) * 4
          const da = (buf[i + 3] ?? 0) * (1 - a)
          const oa = a + da
          ;[r, g, b].forEach((v, k) => (buf[i + k] = (v * a + (buf[i + k] ?? 0) * da) / oa))
          buf[i + 3] = oa
        }
      }
    }
  }
  // A dimmed alpha scales the undimmed crab's rounded alpha, so both images agree pixel for pixel.
  const bytes = Uint8Array.from(buf, (v, i) => (i % 4 === 3 ? Math.round(Math.round(v * 255) * (dim ? DIM : 1)) : Math.round(v)))
  const image = { rgba: btoa(String.fromCharCode(...bytes)), width, height }
  crabImages.set(key, image)
  return image
}

const statusMark = (x: number, y: number, status: string, color: string): string => {
  if (status === 'running') return `<circle class="live" cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`
  if (status === 'done') return `<path d="M${x - 5} ${y}l3.5 3.5 6.5-7" fill="none" stroke="#3B9C5F" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  if (status === 'failed') return `<path d="M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8" stroke="#D0453F" stroke-width="1.8" stroke-linecap="round"/>`
  return `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="#9a9a96" stroke-width="1.4"/><path d="M${x} ${y - 2.5}v2.8l1.8 1.2" fill="none" stroke="#9a9a96" stroke-width="1.4" stroke-linecap="round"/>`
}

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${PANE_CSS}${CRAB_CSS}${body}</svg>`

// The pane's own title already says "Agents": the header names the flow, if any.
const headerSvg = (W: number, title: string, t: ReturnType<typeof totals>): string => {
  const gap = 6
  const tw = (W - gap * 2) / 3
  const top = title ? 28 : 0
  const tile = (i: number, k: string, v: string) =>
    `<rect class="tile" x="${i * (tw + gap)}" y="${top}" width="${tw}" height="40" rx="8"/>
<text class="s" x="${i * (tw + gap) + 9}" y="${top + 16}" font-family="${FONT}" font-size="11">${k}</text>
<text class="t" x="${i * (tw + gap) + 9}" y="${top + 33}" font-family="${FONT}" font-size="15" font-weight="600" font-variant-numeric="tabular-nums">${v}</text>`
  return svg(
    W,
    headerHeight(title),
    `${title ? `<text class="t" x="0" y="15" font-family="${FONT}" font-size="14" font-weight="600">${xml(fitText(title, 14, W))}</text>` : ''}
${tile(0, TEXT.cost, '≈' + fmtCost(t.cost))}${tile(1, TEXT.tokens, fmtTokens(t.tokens))}${tile(2, TEXT.time, fmtTime(t.time))}`,
  )
}

const headerHeight = (title: string): number => (title ? 72 : 44)

// A finished run is full; a running one has no progress of its own, only its context fill.
const progressOf = (a: AgentRun): number | null => (a.status === 'done' ? 1 : null)

const ctxOf = (a: AgentRun): number => (a.contextMax ? Math.min(100, Math.round((a.contextTokens / a.contextMax) * 100)) : 0)

const agentSvg = (W: number, a: AgentRun, at: number): string => {
  const role = roleOf(a.type)
  const color = colorOf(role)
  const ctx = ctxOf(a)
  const textW = W - 42 - 22
  const meta = [a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model)]
  if (a.round > 1) meta.push(`${TEXT.round} ${a.round}`)
  if (a.status === 'failed') meta.push(TEXT.failed)
  const barW = textW
  const progress = progressOf(a)
  const stats = `ctx ${ctx}% · ${fmtTokens(a.contextTokens)}  ≈${fmtCost(a.costUsd)}  ${fmtTime(elapsed(a, at))}`
  const activity = activityOf(a, at)
  const activityW = Math.max(0, barW - textWidth(stats, 11) - 12)
  // A running agent's bar is its context fill, drawn grey.
  const fillW = Math.round(barW * (progress ?? ctx / 100))
  return svg(
    W,
    66,
    `${crab(0, 14, costumeOf(a.type), false, a.status === 'running')}
<text class="t" x="42" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(a.description || a.type, 13, textW))}</text>
<text x="42" y="34" font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(role === 'other' ? a.type : role)}</tspan><tspan class="s">  ${xml(meta.join('  ·  '))}</tspan></text>
${activity && activityW > 30 ? `<text class="t" x="42" y="49" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(fitText(activity, 11, activityW))}</text>` : ''}
<text class="s" x="${42 + barW}" y="49" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${stats}</text>
<rect class="k" x="42" y="55" width="${barW}" height="4" rx="2"/><rect${progress === null ? ' class="m"' : ''} x="42" y="55" width="${fillW}" height="4" rx="2"${progress === null ? '' : ` fill="${color}"`}/>
${statusMark(W - 8, 16, a.status, color)}
<line class="ln" x1="0" y1="65.5" x2="${W}" y2="65.5"/>`,
  )
}

const plannedSvg = (W: number, p: Planned): string => {
  const role = roleOf(p.role)
  const color = colorOf(role)
  const textW = W - 42 - 22
  const meta: string[] = []
  if (p.after.length) meta.push(`${TEXT.after} ${p.after.join(', ')}`)
  return svg(
    W,
    46,
    `${crab(0, 6, role, true)}
<text class="s" x="42" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(`${p.n}. ${p.title}`, 13, textW))}</text>
<text x="42" y="34" font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(role)}</tspan><tspan class="m">  ${xml(meta.filter(Boolean).join('  ·  '))}</tspan></text>
${statusMark(W - 8, 16, 'planned', color)}
<line class="ln" x1="0" y1="45.5" x2="${W}" y2="45.5"/>`,
  )
}

// `runs` comes in the panel's order: running, then finished, each newest first.
const compactSvg = (W: number, runs: AgentRun[], planned: Planned[], t: ReturnType<typeof totals>): string => {
  const icons = [
    ...runs.map(a => ({ k: costumeOf(a.type), c: colorOf(roleOf(a.type)), s: a.status, dim: false })),
    ...planned.map(p => ({ k: roleOf(p.role), c: colorOf(roleOf(p.role)), s: 'planned', dim: true })),
  ]
  const fit = Math.max(1, Math.floor((W - 150) / 36))
  const shown = icons.slice(0, fit)
  const more = icons.length - shown.length
  const body = shown
    // The running dot sits at the slot's bottom right, beside the legs, where no costume draws.
    .map((ic, i) => crab(i * 36, 0, ic.k, ic.dim, ic.s === 'running') + (ic.s === 'running' ? `<circle class="live" cx="${i * 36 + 31}" cy="26" r="3" fill="${ic.c}"/>` : ''))
    .join('')
  const x = shown.length * 36 + (more ? 4 : 0)
  return svg(
    W,
    32,
    `${body}${more ? `<text class="s" x="${x}" y="21" font-family="${FONT}" font-size="12">+${more}</text>` : ''}
<text class="s" x="${W}" y="21" text-anchor="end" font-family="${FONT}" font-size="12" font-variant-numeric="tabular-nums">≈${fmtCost(t.cost)} · ${fmtTokens(t.tokens)} · ${fmtTime(t.time)}</text>`,
  )
}

// --- terminal drawing: the same rows in text.

const ctxBar = (pct: number, width: number): string => {
  const filled = Math.round((width * pct) / 100)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

const STATUS_GLYPH: Record<string, string> = { running: '●', done: '✓', failed: '✗', planned: '◷' }

// ---------------------------------------------------------------------------
// Autobots Mode: which of the main agent's tool calls are direct edits of project files.
// Only the verdict leaves here: no command, path or file name is kept or shown.

// `autobots`, or `<plugin>:autobots` when the skill ships in a plugin.
const isAutobotsSkill = (skill: string): boolean => /^(?:[^:]*:)?autobots$/.test(skill)

// `/autobots`, alone or followed by its arguments; not `/autobots-lite`.
const isAutobotsPrompt = (text: string): boolean => /^\/autobots(?![\w-])/.test(text)

// Prompt origins that are a person's own prompt (PromptOrigin in the API types).
const OWNER_ORIGINS: readonly string[] = ['composer', 'bridge', 'sdk']

// The session's working directory, and the directories whose files never count.
type Places = { cwd: string; home: string; tmp: string; never: string[] }

// `p` made absolute against `base`, with `.` and `..` resolved.
const resolvePath = (base: string, p: string): string => {
  const parts: string[] = []
  for (const seg of (p.startsWith('/') ? p : `${base}/${p}`).split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return `/${parts.join('/')}`
}

const isUnder = (path: string, dir: string): boolean => dir === '/' || path === dir || path.startsWith(`${dir}/`)

async function placesOf($: EngineInterface): Promise<Places> {
  const [dir, home = '', tmp = ''] = await Promise.all([read($, cwd), $.env.get('HOME'), $.env.get('TMPDIR')])
  // Temporary directories (the scratchpad among them), devices and ~/.claude; on macOS /tmp and
  // $TMPDIR also go by their /private path.
  const never = ['/tmp', '/dev', tmp, home && `${home}/.claude`]
    .filter(Boolean)
    .map(dir => resolvePath('/', dir))
    .flatMap(dir => [dir, `/private${dir}`])
  return { cwd: dir && resolvePath('/', dir), home, tmp, never }
}

// A project file: inside the working directory and under none of the `never` directories.
// A relative path is taken against `base`, the working directory unless a `cd` moved it.
// Before the session's start reported its directory, nothing is a project file.
const isProjectPath = (at: Places, path: string, base = at.cwd): boolean => {
  const abs = resolvePath(base, path)
  return at.cwd !== '' && isUnder(abs, at.cwd) && !at.never.some(dir => isUnder(abs, dir))
}

// Expands `~`, `$HOME` and `$TMPDIR` in a Bash word; undefined when the word still holds a
// variable or `~` the mod cannot read, so that the target is unknown and does not count.
const expandWord = (at: Places, word: string): string | undefined => {
  const out = word
    .replace(/^~(?=\/|$)/, at.home || '~')
    .replace(/\$(?:\{(HOME|TMPDIR)\}|(HOME|TMPDIR)(?![A-Za-z0-9_]))/g, (_, a?: string, b?: string) => ((a ?? b) === 'HOME' ? at.home : at.tmp) || '$')
  return /^~|\$/.test(out) ? undefined : out
}

// Heredoc bodies are text, not commands: a `>` inside one is no redirect.
const stripHeredocs = (command: string): string => {
  const out: string[] = []
  const ends: string[] = []
  for (const line of command.split('\n')) {
    if (ends.length) {
      if (line.trim() === ends[0]) ends.shift()
      continue
    }
    out.push(line)
    for (const m of line.matchAll(/(?<!<)<<-?(?!<)\s*(['"]?)([A-Za-z_][\w-]*)\1/g)) ends.push(m[2] ?? '')
  }
  return out.join('\n')
}

type ShellToken = { word: string; op?: undefined } | { op: string; word?: undefined }

// A rough shell lexer: words, unquoted, and the operators that split commands or redirect. Enough
// to find write targets; not a shell. `$(…)`, globs and nested `bash -c` scripts are not parsed.
const lexShell = (s: string): ShellToken[] => {
  const tokens: ShellToken[] = []
  let word: string | null = null
  const flush = () => {
    if (word !== null) tokens.push({ word })
    word = null
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? ''
    if (c === "'") {
      const end = s.indexOf("'", i + 1)
      const stop = end < 0 ? s.length : end
      word = (word ?? '') + s.slice(i + 1, stop)
      i = stop
    } else if (c === '"') {
      let j = i + 1
      let buf = ''
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) j++
        buf += s[j++]
      }
      word = (word ?? '') + buf
      i = j
    } else if (c === '\\') {
      word = (word ?? '') + (s[++i] ?? '')
    } else if (c === ' ' || c === '\t') {
      flush()
    } else {
      const op = /^(?:&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<&|<|\|\||\||&&|&|;;|;|\n|\(|\))/.exec(s.slice(i))?.[0]
      if (!op) {
        word = (word ?? '') + c
        continue
      }
      // `2>`: digits right before a redirect name its file descriptor, not a word.
      if (word !== null && /^\d+$/.test(word) && /^[<>]/.test(op)) word = null
      flush()
      tokens.push({ op })
      i += op.length - 1
    }
  }
  flush()
  return tokens
}

const PREFIXES = ['do', 'then', 'else', '{', '!', 'sudo', 'env', 'time', 'nohup', 'command']

// Files one simple command writes, by the program it runs (requirement 10). In-place editors write
// their last operand, `cp` its destination; `patch` and `git apply` write the working tree.
const commandTargets = (words: string[]): string[] => {
  // Past leading assignments, shell keywords and wrappers that run the command after them;
  // `env` takes assignments of its own.
  const isAssignment = (w: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)
  let start = 0
  while (start < words.length && (isAssignment(words[start] ?? '') || PREFIXES.includes(words[start] ?? ''))) start++
  const [cmd = '', ...args] = words.slice(start)
  const operands = args.filter(a => a && !a.startsWith('-'))
  switch (cmd.split('/').pop()) {
    case 'tee':
    case 'mv':
    case 'rm':
      return operands
    case 'cp':
      return operands.slice(-1)
    case 'sed':
      return args.some(a => /^-[nEsrz]*i|^--in-place/.test(a)) ? operands.slice(-1) : []
    case 'perl':
    case 'ruby':
      return args.some(a => /^-[0-9adlnpsvwcWTX]*i/.test(a)) ? operands.slice(-1) : []
    case 'patch':
      return ['.']
    case 'git': {
      // Past the global options; `-C <dir>` moves where the command runs.
      let base = '.'
      let j = 0
      for (; j < args.length && (args[j] ?? '').startsWith('-'); j++) {
        if (args[j] === '-C') base = args[++j] ?? base
        else if (args[j] === '-c') j++
      }
      const [sub, ...rest] = args.slice(j)
      const within = (paths: string[]) => paths.map(p => (p.startsWith('/') ? p : `${base}/${p}`))
      // `git apply --check` and its report-only modes write nothing; `git restore --staged`
      // touches only the index unless `--worktree` comes with it.
      if (sub === 'apply') return rest.some(a => ['--check', '--stat', '--numstat', '--summary'].includes(a)) ? [] : [base]
      if (sub === 'restore') {
        const isIndexOnly = rest.some(a => a === '--staged' || a === '-S') && !rest.some(a => a === '--worktree' || a === '-W')
        return isIndexOnly ? [] : within(rest.filter(a => a && !a.startsWith('-')))
      }
      if (sub === 'checkout' && rest.includes('--')) return within(rest.slice(rest.indexOf('--') + 1))
      return []
    }
    default:
      return []
  }
}

const isWriteRedirect = (op: string): boolean => ['>', '>>', '>|', '&>', '&>>', '>&'].includes(op)

// Whether a Bash command writes a project file (requirements 10 and 11): an output redirect, or a
// program from `commandTargets`, with a target inside the working directory. Follows `cd`.
const isBashWrite = (at: Places, command: string): boolean => {
  const tokens = lexShell(stripHeredocs(command))
  let base: string | undefined = at.cwd
  const bases: (string | undefined)[] = []
  let words: string[] = []
  let targets: string[] = []
  const endCommand = (): boolean => {
    const hit = [...targets, ...commandTargets(words)].some(t => {
      const path = expandWord(at, t)
      return path !== undefined && (path.startsWith('/') || base !== undefined) && isProjectPath(at, path, base ?? at.cwd)
    })
    if (words[0] === 'cd') {
      const dir = words[1] === undefined ? at.home : words[1] === '-' ? undefined : expandWord(at, words[1])
      base = base !== undefined && dir ? resolvePath(base, dir) : undefined
    }
    words = []
    targets = []
    return hit
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t?.word !== undefined) words.push(t.word)
    else if (t && isWriteRedirect(t.op)) {
      const next = tokens[i + 1]?.word
      if (next === undefined) continue
      i++
      // `>&2`, `2>&1`: a copy of another file descriptor, not a file.
      if (!(t.op === '>&' && /^(?:\d+|-)$/.test(next))) targets.push(next)
    } else if (t?.op.startsWith('<')) {
      // An input, a heredoc delimiter or a here-string: never a target.
      if (tokens[i + 1]?.word !== undefined) i++
    } else {
      if (endCommand()) return true
      // A subshell's `cd` ends at its `)`.
      if (t?.op === '(') bases.push(base)
      else if (t?.op === ')' && bases.length) base = bases.pop()
    }
  }
  return endCommand()
}

// Opens the agents pane, or closes it when it is up; true when it ends up open.
async function togglePane($: EngineInterface): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen) {
    await $.ui.close({ id: PANE })
    return false
  }
  const at = await $.clock.now()
  await update($, now, () => at)
  await $.ui.open({ id: PANE, title: TEXT.pane })
  return true
}

// A flow the autobots skill started: titled `autobots`, counting from 0, and continued by the
// first progress call. Like any new flow, it starts with a clean list; agents still running stay.
async function startSkillFlow($: EngineInterface): Promise<void> {
  await update($, agents, list => list.filter(a => a.status === 'running'))
  await update($, flow, () => ({ ...blank(), edits: 0, isSkillStarted: true }))
}

async function autoOpen($: EngineInterface, key: string): Promise<void> {
  const p = await read($, panel)
  if (p.autoOpenedFor === key) return
  await update($, panel, prev => ({ ...prev, autoOpenedFor: key }))
  void $.ui.open({ id: PANE, title: TEXT.pane })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await update($, cwd, () => started.cwd)
    await $.tool.register({
      name: 'progress',
      description:
        'Report autobots dispatcher progress to the progress bar above the prompt and the agents panel. ' +
        'Call it after presenting the plan (title, total, tasks, phase "delegate"), each time a task is accepted (done), ' +
        'when switching phase or re-planning (tasks), and once at the end with finished: true. Fields left out keep their previous value.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name of the overall task, a few words.' },
          total: { type: 'integer', minimum: 0, description: 'Number of planned worker tasks.' },
          done: { type: 'integer', minimum: 0, description: 'Number of tasks accepted after review.' },
          phase: { type: 'string', enum: [...PHASES] },
          finished: { type: 'boolean', description: 'True once the flow is closed.' },
          tasks: {
            type: 'array',
            description:
              'The planned worker tasks in order, numbered from 1. Each title must equal the Agent tool `description` the task will be delegated with, so the panel can match runs to tasks.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'A few words; reused verbatim as the Agent description.' },
                role: { type: 'string', enum: [...ROSTER], description: 'The roster subagent_type the task is delegated to.' },
                after: { type: 'array', items: { type: 'integer' }, description: 'Numbers of the tasks this one waits for.' },
              },
              required: ['title', 'role'],
            },
          },
        },
      },
    })
    await $.command.register({
      name: 'agents-info',
      description: 'Show or hide the panel of subagents: running, finished and planned, with model, context, cost and time',
    })

    // Ticks the running agents' clocks; quiet when nothing runs.
    $.clock.every(1000, () => {
      void (async () => {
        const list = await read($, agents)
        if (!list.some(a => a.status === 'running')) return
        const at = await $.clock.now()
        await update($, now, () => at)
      })()
    })
    return started
  })

  on('command.run', { command: 'agents-info' }, async $ => {
    const isOpen = await togglePane($)
    return { text: isOpen ? TEXT.opened : TEXT.closed }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as ProgressInput
    const prev = await read($, flow)
    if (isNewFlow(prev, input) && input.title !== undefined) {
      // A new flow starts with a clean list; agents still running stay.
      await update($, agents, list => list.filter(a => a.status === 'running'))
    }
    const next = (await update($, flow, p => merge(p, input))) ?? blank()
    if (input.tasks?.length) await autoOpen($, next.title)
    // Autobots Mode: the closing call states the count for the main agent's closing summary.
    const closing = input.finished && next.edits !== undefined ? ` · ${TEXT.closing(next.edits)}` : ''
    return { result: `ok: ${label(next)}${closing}` }
  })

  // Autobots Mode: the autobots skill starts a counting flow, by the main agent's Skill call or an
  // owner prompt. Either, during a flow, starts a new one at 0.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const answer = await next(e)
    if (!e.agentId && answer.deny === undefined && !answer.isError && isAutobotsSkill(e.skill)) await startSkillFlow($)
    return answer
  })

  // Only a person's own prompt: typed at the terminal, sent through Remote Control, or the SDK
  // host's turn. Never a notification, a peer session, a schedule or a relay. Once it entered.
  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    if (entered.drop === undefined && OWNER_ORIGINS.includes(e.origin.kind) && isAutobotsPrompt(e.text)) await startSkillFlow($)
    return entered
  })

  // Autobots Mode: counts a main-agent edit of a project file that ran, during a counting flow;
  // the first of a flow carries one reminder. Never refuses or changes the call.
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit', 'Bash'] }, async ($, e, next) => {
    const answer = await next(e)
    if (e.agentId || answer.deny !== undefined || answer.isError || !isCounting(await read($, flow))) return answer
    const at = await placesOf($)
    const text = (v: unknown): string => (typeof v === 'string' ? v : '')
    const path = text(e.tool === 'NotebookEdit' ? e.notebook_path : e.tool === 'Bash' ? '' : e.file_path)
    const isEdit = e.tool === 'Bash' ? isBashWrite(at, text(e.command)) : path !== '' && isProjectPath(at, path)
    if (!isEdit) return answer
    let isFirst = false
    await update($, flow, f => {
      if (!isCounting(f)) return f
      isFirst = f.edits === 0
      return { ...f, edits: f.edits + 1 }
    })
    return isFirst ? { ...answer, context: [...(answer.context ?? []), TEXT.reminder] } : answer
  })

  // Safety net: worker launches move the faint layer even if the orchestrator forgets to report.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const type = String(e.subagent_type ?? '')
    if (!isRole(type)) return next(e)

    await update($, flow, prev => {
      const base = prev && !prev.isFinished ? { ...blank(), ...prev } : blank()
      return { ...base, running: base.running + 1, phase: base.phase === 'plan' ? 'delegate' : base.phase }
    })
    try {
      return await next(e)
    } finally {
      await update($, flow, prev => (prev ? { ...prev, running: Math.max(0, prev.running - 1) } : prev))
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started

    const at = await $.clock.now()
    await update($, agents, list => {
      const round = 1 + list.filter(a => norm(a.description) === norm(e.description) && e.description).length
      const run: AgentRun = {
        id: started.agentId ?? e.tool_use_id,
        agentId: started.agentId,
        type: e.subagentType,
        description: e.description,
        model: started.model,
        status: 'running',
        startedAt: at,
        contextTokens: 0,
        contextMax: windowOf(started.model),
        tokens: 0,
        costUsd: 0,
        steps: 0,
        round,
        toolCalls: 0,
      }
      return [...list.filter(a => a.id !== run.id), run].slice(-200)
    })
    await update($, now, () => at)
    if (isRole(e.subagentType)) {
      const f = await read($, flow)
      await autoOpen($, f && !f.isFinished ? f.title : blank().title)
    }
    return started
  })

  // Each model request of a subagent: live context, tokens and cost, and its tool calls.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    const usage = result.usage
    if (!agentId || !usage) return result

    const model = usage.model || e.model
    // SubagentHandback is the subagent handing its report back, not work: never shown or counted.
    const uses = result.toolUses.filter(u => u.name !== 'SubagentHandback')
    const last = uses[uses.length - 1]
    const at = await $.clock.now()
    await update($, agents, list =>
      list.map(a =>
        a.agentId !== agentId
          ? a
          : {
              ...a,
              model,
              effort: typeof e.effort === 'string' ? e.effort : a.effort,
              status: 'running',
              endedAt: undefined,
              contextTokens:
                (usage.input_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0) +
                (usage.output_tokens || 0),
              contextMax: windowOf(model),
              tokens:
                a.tokens +
                (usage.input_tokens || 0) +
                (usage.output_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0),
              costUsd: a.costUsd + costOf(model, usage),
              steps: a.steps + 1,
              toolCalls: (a.toolCalls ?? 0) + uses.length,
              lastTool: last ? summarizeTool(last.name, last.input) : a.lastTool,
              lastStepAt: at,
            },
      ),
    )
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      const at = await $.clock.now()
      await update($, agents, list =>
        list.map(a => {
          if (a.agentId !== agentId) return a
          // A run whose steps went unseen still gets the turn's own sum.
          const fallback = a.steps === 0 && e.usage
          return {
            ...a,
            status: e.reason === 'answer' ? 'done' : 'failed',
            endedAt: at,
            ...(fallback && e.usage
              ? {
                  model: e.usage.model || a.model,
                  tokens:
                    e.usage.input_tokens +
                    e.usage.output_tokens +
                    e.usage.cache_read_input_tokens +
                    e.usage.cache_creation_input_tokens,
                  costUsd: costOf(e.usage.model || a.model, e.usage),
                }
              : {}),
          }
        }),
      )
      await update($, now, () => at)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, agents)
    const f = await read($, flow)
    const p: Panel = await read($, panel)
    const at = Math.max(await read($, now), ...list.map(a => a.startedAt), 0)

    // Rows show descriptions masked; `list` stays raw, so planned tasks match runs exactly.
    const shown = list.map(a => ({ ...a, description: maskSecrets(a.description) }))
    const running = shown.filter(a => a.status === 'running').reverse()
    const finished = shown.filter(a => a.status !== 'running').reverse()
    const planned = plannedOf(f, list)
    const t = totals(list, at)
    // The pane's title says "Agents"; inside, only the flow's own name.
    const title = f && !f.isFinished ? maskSecrets(f.title) : ''

    const toggleCompact = (
      <Button
        key="compact"
        label={p.isCompact ? TEXT.expand : TEXT.collapse}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isCompact: !prev.isCompact }))}
      />
    )
    const toggleDone = (
      <Button
        key="done"
        label={`${p.isDoneCollapsed ? '▸' : '▾'} ${TEXT.finished} · ${finished.length}`}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed }))}
      />
    )
    // Autobots Mode: the main agent's direct edits in this flow, kept after finished: true.
    const edits = f?.edits !== undefined && <Text key="edits">{TEXT.mainAgent(f.edits)}</Text>
    const isEmpty = list.length === 0 && planned.length === 0
    const summary = `≈${fmtCost(t.cost)}, ${fmtTokens(t.tokens)} ${TEXT.tokensWord}, ${fmtTime(t.time)}`

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      const withActivity = (text: string, a: AgentRun, at: number): string => {
        const activity = activityOf(a, at)
        return activity ? `${text}, ${activity}` : text
      }
      const section = (key: string, text: string) => (
        <Text key={key} dimColor>
          {text}
        </Text>
      )

      if (p.isCompact) {
        return (
          <Box flexDirection="column" gap={1}>
            <Svg source={compactSvg(W, [...running, ...finished], planned, t)} alt={`${list.length} ${TEXT.agentsCount}, ${summary}`} width={W} height={32} />
            {edits}
            {toggleCompact}
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          <Svg source={headerSvg(W, title, t)} alt={title ? `${title}: ${summary}` : summary} width={W} height={headerHeight(title)} />
          {edits}
          {toggleCompact}
          {isEmpty && <Text dimColor>{TEXT.empty}</Text>}
          {running.length > 0 && section('h-run', `${TEXT.running} · ${running.length}`)}
          {running.map(a => (
            <Svg key={a.id} source={agentSvg(W, a, at)} alt={withActivity(`${a.description}: ${modelName(a.model)}, ${TEXT.isRunning}`, a, at)} width={W} height={66} />
          ))}
          {finished.length > 0 && toggleDone}
          {!p.isDoneCollapsed &&
            finished.map(a => (
              <Svg key={a.id} source={agentSvg(W, a, at)} alt={withActivity(`${a.description}: ${modelName(a.model)}, ${TEXT.isFinished}`, a, at)} width={W} height={66} />
            ))}
          {planned.length > 0 && section('h-plan', `${TEXT.planned} · ${planned.length}`)}
          {planned.map(pl => (
            <Svg key={`plan-${pl.n}`} source={plannedSvg(W, pl)} alt={`${pl.n}. ${pl.title}: ${TEXT.isPlanned}`} width={W} height={46} />
          ))}
        </Box>
      )
    }

    // Terminal: the desktop's layout in cells, the crab as a still image of the same pixels.
    const cols = Math.max(24, e.props.bodyColumns || 40)
    // The crab spans three rows; six columns keep it about square in a 1:2 cell.
    const crabCols = 6
    const barW = Math.max(6, cols - crabCols - 2)
    // One element per row: a shared instance would be one node in several places.
    const rule = () => <Text dimColor wrap="truncate-end">{'─'.repeat(cols)}</Text>
    // ▣ a run's crab, ▢ a planned task's, dimmed.
    const crabCell = (key: string, costume: string, color: string, dim = false) =>
      'Image' in ui ? (
        <ui.Image key={key} source={crabImage(costume, dim)} columns={crabCols} rows={3} alt={dim ? '▢' : '▣'} />
      ) : (
        <Text color={color}>{dim ? '▢' : '▣'}</Text>
      )
    const row = (a: AgentRun) => {
      const role = roleOf(a.type)
      const color = colorOf(role)
      const ctx = ctxOf(a)
      const progress = progressOf(a)
      const model = a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model)
      const activity = activityOf(a, at)
      return (
        <Box key={a.id} flexDirection="column">
          <Box flexDirection="row" gap={1}>
            {crabCell(`crab-${a.id}`, costumeOf(a.type), color)}
            <Box flexDirection="column" flexGrow={1}>
              <Box flexDirection="row" justifyContent="space-between" gap={1}>
                <Text bold wrap="truncate-end">
                  {a.description || a.type}
                </Text>
                <Text color={a.status === 'failed' ? 'red' : a.status === 'done' ? 'green' : color}>{STATUS_GLYPH[a.status]}</Text>
              </Box>
              <Text wrap="truncate-end">
                <Text color={color}>{role === 'other' ? a.type : role}</Text>
                <Text dimColor>
                  {'  '}
                  {model}
                  {a.round > 1 ? ` · ${TEXT.round} ${a.round}` : ''}
                </Text>
              </Text>
              <Box flexDirection="row" justifyContent="space-between" gap={2}>
                <Text wrap="truncate-end">{activity}</Text>
                <Text dimColor wrap="truncate-end">
                  ctx {ctx}% · {fmtTokens(a.contextTokens)} ≈{fmtCost(a.costUsd)} {fmtTime(elapsed(a, at))}
                </Text>
              </Box>
              {progress === null ? <Text dimColor>{ctxBar(ctx, barW)}</Text> : <Text color={color}>{ctxBar(progress * 100, barW)}</Text>}
            </Box>
          </Box>
          {rule()}
        </Box>
      )
    }
    const tile = (label: string, value: string) => (
      <Box key={label} flexDirection="column" flexGrow={1} borderStyle="round" borderDimColor paddingX={1}>
        <Text dimColor>{label}</Text>
        <Text bold>{value}</Text>
      </Box>
    )
    // Collapse: the desktop's strip, a crab per item, under the one-line totals. A slot is the crab,
    // a column for a running crab's ●, and the gap; when not all fit, four columns stay for "+N".
    const strip = [
      ...[...running, ...finished].map(a => ({ key: a.id, costume: costumeOf(a.type), color: colorOf(roleOf(a.type)), dim: false, isRunning: a.status === 'running' })),
      ...planned.map(pl => ({ key: `plan-${pl.n}`, costume: roleOf(pl.role), color: colorOf(roleOf(pl.role)), dim: true, isRunning: false })),
    ]
    const slot = crabCols + 2
    const fit = strip.length * slot <= cols + 1 ? strip.length : Math.max(1, Math.floor((cols - 4) / slot))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold wrap="truncate-end">
            {title}
          </Text>
          {toggleCompact}
        </Box>
        {p.isCompact || cols < 42 ? (
          <Text dimColor>
            ≈{fmtCost(t.cost)} · {fmtTokens(t.tokens)} {TEXT.tokensWord} · {fmtTime(t.time)}
          </Text>
        ) : (
          <Box flexDirection="row" gap={1}>
            {tile(TEXT.cost, `≈${fmtCost(t.cost)}`)}
            {tile(TEXT.tokens, fmtTokens(t.tokens))}
            {tile(TEXT.time, fmtTime(t.time))}
          </Box>
        )}
        {edits}
        {p.isCompact ? (
          <Box flexDirection="row" gap={1}>
            {strip.slice(0, fit).map(c => (
              <Box key={c.key} flexDirection="row">
                {crabCell(`crab-${c.key}`, c.costume, c.color, c.dim)}
                {c.isRunning && <Text color={c.color}>●</Text>}
              </Box>
            ))}
            {strip.length > fit && <Text dimColor>+{strip.length - fit}</Text>}
          </Box>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {isEmpty && <Text dimColor>{TEXT.empty}</Text>}
            {running.length > 0 && <Text dimColor>{TEXT.running} · {running.length}</Text>}
            {running.map(row)}
            {finished.length > 0 && toggleDone}
            {!p.isDoneCollapsed && finished.map(row)}
            {planned.length > 0 && <Text dimColor>{TEXT.planned} · {planned.length}</Text>}
            {planned.map(pl => {
              const role = roleOf(pl.role)
              return (
                <Box key={`plan-${pl.n}`} flexDirection="column">
                  <Box flexDirection="row" gap={1}>
                    {crabCell(`crab-plan-${pl.n}`, role, colorOf(role), true)}
                    <Box flexDirection="column" flexGrow={1}>
                      <Text dimColor wrap="truncate-end">
                        {pl.n}. {pl.title} ◷
                      </Text>
                      <Text dimColor wrap="truncate-end">
                        <Text color={colorOf(role)}>{role}</Text>
                        {pl.after.length ? ` · ${TEXT.after} ${pl.after.join(', ')}` : ''}
                      </Text>
                    </Box>
                  </Box>
                  {rule()}
                </Box>
              )
            })}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const stored = await read($, flow)
    if (stored === null || e.props.hasSurvey) return next(e)
    const f = { ...stored, title: maskSecrets(stored.title) }

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, agents)
    const crew = `×${list.length + plannedOf(f, list).length}`
    const isWorking = list.some(a => a.status === 'running')
    const crewButton = (
      <Button key="autobots-agents" label={crew} plain onPress={() => void togglePane($)} />
    )
    const percent = `${Math.round(ratio(f) * 100)}%`
    const mark = editMark(f)
    const dismiss = (
      <Button
        key="autobots-dismiss"
        label="✕"
        plain
        role="dismiss"
        onPress={() => update($, flow, () => null)}
      />
    )

    // The terminal's table lists Svg too but draws nothing for it.
    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui
      // About 8 CSS px per reported column; the rest is the count, the dismiss
      // and their gaps. No floor above the slot: a row wider than it would wrap.
      const width = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 96))
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Svg source={rowSvg(f, width, isWorking)} alt={`${f.title}: ${[label(f), mark].filter(Boolean).join(' · ')}, ${percent}`} width={width} height={H} />
          {crewButton}
          {dismiss}
        </Box>
      )
    }

    const cols = e.props.bodyColumns
    const titleW = Math.max(8, Math.min(30, f.title.length + 2, Math.floor(cols / 3)))
    // The bar takes what the row leaves: after it come the label, the edit mark if any, the
    // percent, ▣, the crew count and ✕, each one cell per character, with a 2-cell gap before each.
    const after = [label(f), mark, percent, '▣', crew, '✕'].filter(Boolean).reduce((w, s) => w + 2 + [...s].length, 0)
    const width = Math.max(6, Math.min(40, cols - titleW - 2 - after))
    return (
      <Box flexDirection="row" gap={2}>
        <Box width={titleW} flexShrink={0}>
          <Text color={f.isFinished ? DONE : ACCENT}>● </Text>
          <Text wrap="truncate-end">{f.title}</Text>
        </Box>
        <Text color={f.isFinished ? DONE : ACCENT}>{barText(f, width)}</Text>
        <Text bold>{label(f)}</Text>
        {mark !== '' && <Text color={CLAY}>{mark}</Text>}
        <Text dimColor>{percent}</Text>
        <Text color={CLAY}>▣</Text>
        {crewButton}
        {dismiss}
      </Box>
    )
  })
}
