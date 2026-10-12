// Spec tests for Autobots Mode, requirements 8 to 12: what counts as a direct edit.
// Source of truth: docs/requirements/autobots-mode.md.
// Each test starts a flow with the autobots skill, makes the calls, and reads the band. The tests
// of edits that must not count end with a control edit: it is the first counted edit of the flow,
// so it gets the reminder and makes the count 1. Without it they would pass before the feature exists.
import { describe, expect, test } from 'claude-code/testing'
import {
  CWD,
  HOME,
  PROJECT_FILE,
  SUBAGENT,
  TMP,
  TOOL_OUTPUT,
  expectBand,
  remindersOf,
  setup,
  showsEdits,
} from './autobots-mode-kit'
import type { Kit, Reply } from './autobots-mode-kit'

describe('R8 only an edit that ran, made by the main agent, counts', () => {
  test('a call whose tool returned an error is not counted', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    k.outcome('error')
    const reply = await k.edit(PROJECT_FILE)
    expect(reply.isError, 'the fixture made the call fail').toBe(true)
    expect(remindersOf(reply)).toEqual([])
    k.outcome('ran')
    expect(remindersOf(await k.edit(PROJECT_FILE)), 'the first call that ran gets the reminder').toHaveLength(1)
    await expectBand(k, 1, 'only the edit that ran')
  })

  test('a call the engine refused is not counted', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    k.outcome('deny')
    const reply = await k.edit(PROJECT_FILE)
    expect(reply.deny, 'the fixture refused the call').toBe('refused beneath the mod')
    expect(remindersOf(reply)).toEqual([])
    k.outcome('ran')
    expect(remindersOf(await k.edit(PROJECT_FILE)), 'the first call that ran gets the reminder').toHaveLength(1)
    await expectBand(k, 1, 'only the edit that ran')
  })

  test('a Bash write that errored or was refused is not counted either', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    k.outcome('error')
    await k.bash('echo x > notes.txt')
    k.outcome('deny')
    await k.bash('echo x > notes.txt')
    k.outcome('ran')
    expect(remindersOf(await k.bash('echo x > notes.txt')), 'the first Bash call that ran gets the reminder').toHaveLength(1)
    await expectBand(k, 1, 'only the Bash call that ran')
  })

  test('a call from a subagent loop (the event carries an agentId) is not counted', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    const reply = await k.edit(PROJECT_FILE, SUBAGENT)
    await k.write(`${CWD}/src/new.rb`, SUBAGENT)
    await k.bash('echo x > notes.txt', SUBAGENT)
    expect(k.reached.map(r => r.agentId), 'the calls reached the tool in the subagent loop').toEqual([SUBAGENT, SUBAGENT, SUBAGENT])
    expect(reply.result, "the subagent's call ran, with its own output").toBe(TOOL_OUTPUT)
    expect(remindersOf(reply), 'no reminder for a subagent').toEqual([])
    expect(remindersOf(await k.edit(PROJECT_FILE)), 'the main agent gets the reminder').toHaveLength(1)
    await expectBand(k, 1, 'only the main agent edit')
  })
})

describe('R9 Edit, Write and NotebookEdit', () => {
  const tools: [string, (k: Kit, path: string) => Promise<Reply>, string][] = [
    ['Edit', (k, p) => k.edit(p), `${CWD}/src/deep/er/file.rb`],
    ['Write', (k, p) => k.write(p), `${CWD}/src/deep/er/new.rb`],
    ['NotebookEdit', (k, p) => k.notebook(p), `${CWD}/notebooks/analysis.ipynb`],
  ]
  for (const [tool, run, inside] of tools) {
    test(`a ${tool} call on a file inside the working directory counts once per call`, async ($, on) => {
      const k = await setup($, on)
      await k.skill('autobots')
      await run(k, inside)
      await expectBand(k, 1, `one ${tool}`)
      await run(k, inside)
      await expectBand(k, 2, `two ${tool} calls, even on the same file`)
    })

    for (const path of ['/elsewhere/a.rb', '/workshop/a.rb', `${HOME}/.claude/settings.json`, '/tmp/a.rb']) {
      test(`a ${tool} call on ${path}, outside the working directory ${CWD}, is not counted`, async ($, on) => {
        const k = await setup($, on)
        await k.skill('autobots')
        expect(remindersOf(await run(k, path)), 'no reminder for an uncounted edit').toEqual([])
        expect(remindersOf(await k.edit(PROJECT_FILE)), 'the edit inside gets the reminder').toHaveLength(1)
        await expectBand(k, 1, `only the edit inside ${CWD}`)
      })
    }
  }
})

// Requirement 10: each counts once, however many files it writes.
const COUNTED_BASH = [
  'echo x > notes.txt',
  'echo x >> notes.txt',
  "cat <<'EOF' > notes.txt\nhello\nEOF",
  'cat a | tee out.txt',
  'cat a | tee -a out.txt',
  "sed -i '' 's/a/b/' f.rb",
  "sed -i 's/a/b/' f.rb",
  "perl -pi -e 's/a/b/' f.rb",
  "ruby -i -pe '$_.sub!(\"a\", \"b\")' f.rb",
  'cp a b',
  'mv a b',
  'rm a',
  'git apply p.diff',
  'patch -p1 < p.diff',
  'git checkout -- f.rb',
  'git restore f.rb',
  `echo x > ${CWD}/src/notes.txt`,
]

// Requirement 11, plus read-only commands.
const UNCOUNTED_BASH = [
  'bundle exec rake > /tmp/log.txt',
  'bundle exec rake >> /private/tmp/claude-501/scratchpad/log.txt',
  'echo x > /private/tmp/out.txt',
  'rm /tmp/old.log',
  `echo x > ${TMP}/out.txt`,
  'echo x > $TMPDIR/out.txt',
  'echo x > "${TMPDIR}/out.txt"',
  'cat a | tee $TMPDIR/out.txt',
  'ls > /dev/null',
  'bundle exec rake 2>&1',
  'bundle exec rake 2>&1 | tail -20',
  'ls > /dev/null 2>&1',
  `cp a ${HOME}/.claude/f`,
  'echo x > ~/.claude/notes.md',
  'echo x > $HOME/.claude/notes.md',
  'echo x > /elsewhere/f',
  'cp a /elsewhere/b',
  'rm /elsewhere/old',
  'ls',
  'git status',
  'grep -r foo .',
  'cat f.rb',
]

describe('R10 Bash writes that count', () => {
  for (const command of COUNTED_BASH) {
    test(`the Bash command ${JSON.stringify(command)} counts as one direct edit`, async ($, on) => {
      const k = await setup($, on)
      await k.skill('autobots')
      const reply = await k.bash(command)
      expect(reply.result, "the command ran, with the tool's own output").toBe(TOOL_OUTPUT)
      expect(remindersOf(reply), 'the first counted edit carries the reminder').toHaveLength(1)
      await expectBand(k, 1, 'one command')
    })
  }

  test('a compound command that writes several files counts once', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    await k.bash("echo a > one.txt && echo b > two.txt && cp one.txt three.txt && sed -i 's/a/b/' four.txt; rm five.txt")
    await expectBand(k, 1, 'one compound command')
  })

  test('two separate commands count as two direct edits', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    await k.bash('echo a > one.txt')
    await k.bash('cp one.txt two.txt')
    await expectBand(k, 2, 'two commands')
  })

  test('a command that writes both a temporary file and a project file counts once', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    await k.bash('bundle exec rake > /tmp/log.txt 2>&1 && echo done > notes.txt')
    await expectBand(k, 1, 'one command with a project write')
  })
})

describe('R11 Bash commands that never count', () => {
  for (const command of UNCOUNTED_BASH) {
    test(`the Bash command ${JSON.stringify(command)} is not counted`, async ($, on) => {
      const k = await setup($, on)
      await k.skill('autobots')
      const reply = await k.bash(command)
      expect(reply.result, 'the command ran').toBe(TOOL_OUTPUT)
      expect(remindersOf(reply), 'no reminder for an uncounted command').toEqual([])
      expect(remindersOf(await k.edit(PROJECT_FILE)), 'the edit that follows gets the reminder').toHaveLength(1)
      await expectBand(k, 1, 'only the edit that follows')
    })
  }
})

describe('R12 the mod keeps only the count', () => {
  test('neither the command, nor the path, nor the file name of a counted edit is kept in state or shown', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    const command = 'echo x > bash-marker-4419.txt'
    await k.edit(`${CWD}/src/edit-marker-7731.rb`)
    await k.write(`${CWD}/src/write-marker-2208.rb`)
    await k.bash(command)
    await k.progress({ title: 'Marker check', total: 1, done: 1, phase: 'review', finished: true })
    expect(showsEdits(await k.band('terminal'), 3), 'the three edits were counted').toBe(true)

    const kept = JSON.stringify(k.stateWrites.map(w => w.value))
    const shown = JSON.stringify([
      ...(await k.band('terminal')),
      ...(await k.band('desktop')),
      ...(await k.panel('terminal')),
      ...(await k.panel('desktop')),
    ])
    for (const marker of ['edit-marker-7731', 'write-marker-2208', 'bash-marker-4419', command]) {
      expect(kept.includes(marker), `state does not keep ${marker}`).toBe(false)
      expect(shown.includes(marker), `the band and panel do not show ${marker}`).toBe(false)
    }
  })
})
