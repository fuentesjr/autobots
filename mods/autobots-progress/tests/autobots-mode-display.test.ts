// Spec tests for Autobots Mode, requirements 13 to 20: what the owner and the main agent are shown.
// Source of truth: docs/requirements/autobots-mode.md.
import { describe, expect, test } from 'claude-code/testing'
import { CWD, PROJECT_FILE, SUBAGENT, SURFACES, TOOL_OUTPUT, expectBand, remindersOf, setup, showsDirectEdits } from './autobots-mode-kit'
import type { Kit, Reply } from './autobots-mode-kit'

const FINISH = { title: 'Ship it', total: 1, done: 1, phase: 'review', finished: true }

describe('R13 the band shows the count', () => {
  test('while the count is above 0 the band shows the mark and N on the terminal and the desktop, beside the phase label', async ($, on) => {
    const k = await setup($, on)
    await k.progress({ title: 'Ship it', total: 2, phase: 'delegate' })
    await k.edit(PROJECT_FILE)
    await k.write(`${CWD}/src/new.rb`)
    await k.bash('echo x > notes.txt')
    await expectBand(k, 3, 'three counted edits')
    expect((await k.band('terminal')).some(s => s.includes('Tasks 0/2')), 'the terminal band keeps its phase label').toBe(true)
  })

  test('the count follows each counted edit: 1, then 2', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    await k.edit(PROJECT_FILE)
    await expectBand(k, 1, 'after one edit')
    await k.edit(PROJECT_FILE)
    await expectBand(k, 2, 'after two edits')
  })

  test('at 0 the band shows no edit mark', async ($, on) => {
    const k = await setup($, on)
    await k.progress({ title: 'Ship it', total: 2, phase: 'delegate' })
    await expectBand(k, 0, 'no edits yet')
    // Control: one counted edit makes the mark appear where it was absent.
    await k.edit(PROJECT_FILE)
    await expectBand(k, 1, 'after one edit')
  })
})

describe('R14 the agents panel header shows the count', () => {
  for (const [n, text] of [[3, '3 direct edits'], [1, '1 direct edit'], [0, '0 direct edits']] as const) {
    test(`it shows ${text} on the terminal and on the desktop`, async ($, on) => {
      const k = await setup($, on)
      await k.skill('autobots')
      for (let i = 0; i < n; i++) await k.edit(PROJECT_FILE)
      for (const surface of SURFACES) {
        const strings = await k.panel(surface)
        expect(showsDirectEdits(strings, n), `the ${surface} panel shows ${text}; it draws ${JSON.stringify(strings)}`).toBe(true)
      }
    })
  }
})

// R15 (the count's text is English only) is covered by the English assertions of R13, R14 and R19.

describe('R16 the count stays after finished: true', () => {
  test('it stays on the band and in the panel, on both surfaces', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    await k.edit(PROJECT_FILE)
    await k.edit(PROJECT_FILE)
    await k.progress(FINISH)
    await expectBand(k, 2, 'after finished')
    for (const surface of SURFACES) {
      const strings = await k.panel(surface)
      expect(showsDirectEdits(strings, 2), `the ${surface} panel still shows 2 direct edits; it draws ${JSON.stringify(strings)}`).toBe(true)
    }
  })

  test('it stays until a new flow starts, which shows 0', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    await k.edit(PROJECT_FILE)
    await k.progress(FINISH)
    await expectBand(k, 1, 'after finished')
    await k.skill('autobots')
    await expectBand(k, 0, 'a new flow has started')
  })

  test('it stays until the band is dismissed, which removes it', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    await k.edit(PROJECT_FILE)
    await k.progress(FINISH)
    await expectBand(k, 1, 'after finished')
    await k.dismiss()
    await expectBand(k, 0, 'after the band was dismissed')
  })
})

describe('R17 the reminder on the first counted edit', () => {
  const firstEdit: [string, (k: Kit) => Promise<Reply>][] = [
    ['Edit', k => k.edit(PROJECT_FILE)],
    ['Write', k => k.write(`${CWD}/src/new.rb`)],
    ['NotebookEdit', k => k.notebook(`${CWD}/n.ipynb`)],
    ['Bash', k => k.bash('echo x > notes.txt')],
  ]
  for (const [tool, run] of firstEdit) {
    test(`the first counted ${tool} call returns one reminder: an autobots flow is active and edits belong to the roster`, async ($, on) => {
      const k = await setup($, on)
      await k.skill('autobots')
      const reminders = remindersOf(await run(k))
      expect(reminders, 'exactly one reminder').toHaveLength(1)
      expect(reminders[0], 'it names the autobots flow').toMatch(/autobots/i)
      expect(reminders[0], 'it says the edits belong to the roster').toMatch(/roster/i)
    })
  }

  test("the tool's own output is unchanged and the call is not refused", async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    const reply = await k.edit(PROJECT_FILE)
    expect(remindersOf(reply), 'the reminder is there').toHaveLength(1)
    expect(reply.result).toBe(TOOL_OUTPUT)
    expect(reply.deny, 'not refused').toBeUndefined()
    expect(reply.isError, 'not an error').toBeUndefined()
    expect(k.reached.length, 'the call reached the tool').toBe(1)
  })
})

describe('R18 later counted edits carry no reminder', () => {
  test('whichever tool makes them', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    expect(remindersOf(await k.edit(PROJECT_FILE))).toHaveLength(1)
    expect(remindersOf(await k.edit(PROJECT_FILE)), 'second Edit').toEqual([])
    expect(remindersOf(await k.write(`${CWD}/src/new.rb`)), 'Write').toEqual([])
    expect(remindersOf(await k.bash('echo x > notes.txt')), 'Bash').toEqual([])
    await expectBand(k, 4, 'all four counted')
  })

  test('a new flow reminds again on its first counted edit', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    expect(remindersOf(await k.edit(PROJECT_FILE))).toHaveLength(1)
    await k.progress(FINISH)
    await k.skill('autobots')
    expect(remindersOf(await k.edit(PROJECT_FILE)), 'the second flow').toHaveLength(1)
  })
})

describe('R19 the closing summary', () => {
  test('the finished: true result starts with ok: Done and states 3 direct edits', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    for (let i = 0; i < 3; i++) await k.edit(PROJECT_FILE)
    const text = String((await k.progress(FINISH)).result)
    expect(text).toMatch(/^ok: Done/)
    expect(text).toMatch(/(^|\D)3 direct edits/)
  })

  test('at one edit the result states 1 direct edit', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    await k.edit(PROJECT_FILE)
    const text = String((await k.progress(FINISH)).result)
    expect(text).toMatch(/^ok: Done/)
    expect(text).toMatch(/(^|\D)1 direct edit(?!s)/)
  })

  test('at 0 the result says the main agent made no direct edits', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    const text = String((await k.progress(FINISH)).result)
    expect(text).toMatch(/^ok: Done/)
    expect(text).toContain('no direct edits')
  })

  test('a subagent edit is not in the count the result states', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    await k.edit(PROJECT_FILE)
    await k.edit(PROJECT_FILE, SUBAGENT)
    await k.write(`${CWD}/src/new.rb`, SUBAGENT)
    expect(String((await k.progress(FINISH)).result)).toMatch(/(^|\D)1 direct edit(?!s)/)
  })

  test('a finished: true call in a flow started only by a roster spawn does not start counting, and its result is unchanged: ok: Done, no direct edits text', async ($, on) => {
    const k = await setup($, on)
    await k.spawn('planner')
    await k.edit(PROJECT_FILE)
    const reply = await k.progress(FINISH)
    expect(reply.result).toBe('ok: Done')
    await expectBand(k, 0, 'the finishing call did not start counting')
    // Control: the same sequence in a flow started by the autobots skill states its count.
    await k.skill('autobots')
    await k.edit(PROJECT_FILE)
    expect(String((await k.progress(FINISH)).result)).toMatch(/(^|\D)1 direct edit(?!s)/)
  })
})

describe('R20 other progress calls', () => {
  test('the result of a progress call that is not finished is the same with and without counted edits', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    const args = { title: 'Ship it', total: 2, done: 1, phase: 'review' }
    const before = await k.progress(args)
    expect(String(before.result)).toMatch(/^ok: /)
    await k.edit(PROJECT_FILE)
    await k.edit(PROJECT_FILE)
    await expectBand(k, 2, 'two counted edits')
    const after = await k.progress(args)
    expect(after.result, 'the same result as with no edits').toEqual(before.result)
    expect(String(after.result).includes('direct edit'), 'no mention of the count').toBe(false)
    expect(remindersOf(after), 'no reminder on a progress call').toEqual([])
  })
})
