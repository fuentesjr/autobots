// Spec tests for Autobots Mode, requirements 1 to 7: when a counting flow starts, continues and ends.
// Source of truth: docs/requirements/autobots-mode.md.
import { describe, expect, test } from 'claude-code/testing'
import { PROJECT_FILE, SUBAGENT, SURFACES, expectBand, remindersOf, setup, showsDirectEdits, showsNoDirectEdits, showsTitle } from './autobots-mode-kit'

describe('R1 the flow window', () => {
  test('an edit made before any flow has started is not counted into the flow that starts later', async ($, on) => {
    const k = await setup($, on)
    expect(remindersOf(await k.edit(PROJECT_FILE)), 'no reminder outside a flow').toEqual([])
    await k.skill('autobots')
    expect(showsTitle(await k.band('desktop'), 'autobots'), 'the skill started a flow, so the band is drawn').toBe(true)
    await expectBand(k, 0, 'the earlier edit is not in the count')
  })

  test('counting ends at the progress call with finished: true: a later edit is not counted and gets no reminder', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    await k.progress({ title: 'Ship it', total: 1, done: 1, phase: 'review', finished: true })
    expect(remindersOf(await k.edit(PROJECT_FILE)), 'no reminder after the flow finished').toEqual([])
    await expectBand(k, 0, 'an edit after finished')
    // Control: a new flow counts again.
    await k.skill('autobots')
    expect(remindersOf(await k.edit(PROJECT_FILE)), 'the next flow reminds on its first counted edit').toHaveLength(1)
    await expectBand(k, 1, 'the next flow counts')
  })
})

describe('R2 what starts a counting flow', () => {
  for (const skill of ['autobots', 'autobots:autobots', 'skills:autobots']) {
    test(`a main-agent Skill call for ${skill} starts a counting flow`, async ($, on) => {
      const k = await setup($, on)
      await k.skill(skill)
      expect(remindersOf(await k.edit(PROJECT_FILE)), 'the first counted edit carries the reminder').toHaveLength(1)
      await expectBand(k, 1, `after Skill ${skill}`)
    })
  }

  for (const skill of ['my-autobots', 'autobots:planner', 'autobots-lite']) {
    test(`a Skill call for ${skill} does not start a flow`, async ($, on) => {
      const k = await setup($, on)
      await k.skill(skill)
      expect(remindersOf(await k.edit(PROJECT_FILE)), 'no reminder: no flow is active').toEqual([])
      // Control: the real skill starts a flow, and the next edit is the first counted of it.
      await k.skill('autobots')
      expect(remindersOf(await k.edit(PROJECT_FILE)), 'the autobots skill starts a flow').toHaveLength(1)
      await expectBand(k, 1, 'only the edit after the autobots skill counts')
    })
  }

  test('a Skill call for autobots made by a subagent does not start a flow', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots', SUBAGENT)
    expect(remindersOf(await k.edit(PROJECT_FILE)), 'no reminder: no flow is active').toEqual([])
    await k.skill('autobots')
    expect(remindersOf(await k.edit(PROJECT_FILE)), 'the main agent starting the skill does start a flow').toHaveLength(1)
    await expectBand(k, 1, 'only the edit after the main agent started the flow')
  })

  for (const text of ['/autobots fix the flaky test', '/autobots']) {
    test(`an owner prompt "${text}" starts a counting flow`, async ($, on) => {
      const k = await setup($, on)
      await k.prompt(text)
      expect(showsTitle(await k.band('desktop'), 'autobots'), 'the prompt started a flow titled autobots').toBe(true)
      expect(remindersOf(await k.edit(PROJECT_FILE)), 'the first counted edit carries the reminder').toHaveLength(1)
      await expectBand(k, 1, `after the prompt "${text}"`)
    })
  }

  for (const text of ['please run /autobots on this', 'autobots fix it']) {
    test(`an owner prompt "${text}" does not start a flow, as it does not start with /autobots`, async ($, on) => {
      const k = await setup($, on)
      await k.prompt(text)
      expect(remindersOf(await k.edit(PROJECT_FILE)), 'no reminder: no flow is active').toEqual([])
      // Control: a prompt starting with /autobots does start one.
      await k.prompt('/autobots go')
      expect(remindersOf(await k.edit(PROJECT_FILE)), 'a prompt starting with /autobots starts a flow').toHaveLength(1)
      await expectBand(k, 1, 'only the edit after the /autobots prompt counts')
    })
  }

  test('the first progress call starts a counting flow', async ($, on) => {
    const k = await setup($, on)
    await k.progress({ title: 'Ship it', total: 2, phase: 'delegate' })
    expect(remindersOf(await k.edit(PROJECT_FILE)), 'the first counted edit carries the reminder').toHaveLength(1)
    await expectBand(k, 1, 'after the first progress call')
  })

  test('a progress call after finished: true starts a new counting flow, at 0', async ($, on) => {
    const k = await setup($, on)
    await k.progress({ title: 'Ship it', total: 1, phase: 'delegate' })
    await k.edit(PROJECT_FILE)
    await k.edit(PROJECT_FILE)
    await expectBand(k, 2, 'two edits in the first flow')
    await k.progress({ title: 'Ship it', total: 1, done: 1, phase: 'review', finished: true })

    await k.progress({ title: 'Ship it', total: 1, phase: 'delegate' })
    await expectBand(k, 0, 'the new flow starts at 0')
    expect(remindersOf(await k.edit(PROJECT_FILE)), 'the new flow reminds on its first counted edit').toHaveLength(1)
    await expectBand(k, 1, 'the new flow counts')
  })

  test('a progress call with a different title starts a new counting flow, at 0', async ($, on) => {
    const k = await setup($, on)
    await k.progress({ title: 'First job', total: 1, phase: 'delegate' })
    await k.edit(PROJECT_FILE)
    await k.edit(PROJECT_FILE)
    await expectBand(k, 2, 'two edits in the first flow')

    await k.progress({ title: 'Second job', total: 1, phase: 'delegate' })
    await expectBand(k, 0, 'the different title started a flow at 0')
    expect(remindersOf(await k.edit(PROJECT_FILE)), 'the new flow reminds on its first counted edit').toHaveLength(1)
    await expectBand(k, 1, 'the new flow counts')
  })

  test('a progress call with the same title continues the flow and keeps its count', async ($, on) => {
    const k = await setup($, on)
    await k.progress({ title: 'Ship it', total: 2, phase: 'delegate' })
    await k.edit(PROJECT_FILE)
    await k.edit(PROJECT_FILE)
    await k.progress({ title: 'Ship it', total: 2, done: 1, phase: 'review' })
    await expectBand(k, 2, 'the same title keeps the count')
  })
})

describe('R3 and R4 a flow started by the autobots skill', () => {
  test('the band is titled autobots on both surfaces and shows no edit mark at the start', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    for (const surface of SURFACES) {
      const strings = await k.band(surface)
      expect(showsTitle(strings, 'autobots'), `the ${surface} band is titled autobots; it draws ${JSON.stringify(strings)}`).toBe(true)
    }
    await expectBand(k, 0, 'a new flow starts at 0')
  })

  test('a new flow starts the count at 0: after finished: true, the next autobots skill shows no mark and 0 direct edits', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    await k.edit(PROJECT_FILE)
    await k.edit(PROJECT_FILE)
    await k.progress({ title: 'Ship it', total: 1, done: 1, phase: 'review', finished: true })
    await k.skill('autobots')
    await expectBand(k, 0, 'the count restarts')
    for (const surface of SURFACES) {
      const strings = await k.panel(surface)
      expect(showsDirectEdits(strings, 0), `the ${surface} panel shows 0 direct edits; it draws ${JSON.stringify(strings)}`).toBe(true)
    }
  })

  test('an autobots Skill call during a counting flow starts a new flow with the count at 0, and a new reminder', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    await k.edit(PROJECT_FILE)
    await k.edit(PROJECT_FILE)
    await expectBand(k, 2, 'two edits')
    await k.skill('autobots')
    await expectBand(k, 0, 'the second Skill call restarted the count')
    expect(remindersOf(await k.edit(PROJECT_FILE)), 'the new flow reminds on its first counted edit').toHaveLength(1)
    await expectBand(k, 1, 'the new flow counts')
  })

  test('a /autobots prompt during a counting flow starts a new flow with the count at 0', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    await k.edit(PROJECT_FILE)
    await expectBand(k, 1, 'one edit')
    await k.prompt('/autobots again')
    await expectBand(k, 0, 'the prompt restarted the count')
    expect(remindersOf(await k.edit(PROJECT_FILE)), 'the new flow reminds on its first counted edit').toHaveLength(1)
  })

  test('the first progress call after a flow started by the autobots skill sets the title and keeps the count', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    await k.edit(PROJECT_FILE)
    await k.edit(PROJECT_FILE)
    await k.progress({ title: 'Ship it', total: 2, phase: 'delegate' })
    for (const surface of SURFACES) {
      const strings = await k.band(surface)
      expect(showsTitle(strings, 'Ship it'), `the ${surface} band takes the reported title; it draws ${JSON.stringify(strings)}`).toBe(true)
    }
    await expectBand(k, 2, 'the count is kept')
  })

  test('after that continuing call, a progress call with a different title starts a new flow at 0', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    await k.edit(PROJECT_FILE)
    await k.progress({ title: 'Ship it', total: 2, phase: 'delegate' })
    await expectBand(k, 1, 'the first progress call kept the count')
    await k.progress({ title: 'Another job', total: 1, phase: 'delegate' })
    await expectBand(k, 0, 'a different title starts a new flow')
  })
})

describe('R5 a flow started only by a roster subagent spawn', () => {
  test('does not count edits, gives no reminder, and shows no count on the band or in the panel', async ($, on) => {
    const k = await setup($, on)
    await k.spawn('planner')
    expect(showsTitle(await k.band('desktop'), 'autobots'), 'the spawn started a flow, so the band is drawn').toBe(true)
    expect(remindersOf(await k.edit(PROJECT_FILE)), 'no reminder').toEqual([])
    await expectBand(k, 0, 'a spawn-started flow shows no edit mark')
    for (const surface of SURFACES) {
      expect(showsNoDirectEdits(await k.panel(surface)), `the ${surface} panel shows no direct edit count`).toBe(true)
    }
    // Control, so this does not pass on a mod that counts nothing: a progress call starts counting (below).
    await k.progress({ title: 'Ship it', total: 1, phase: 'delegate' })
    expect(remindersOf(await k.edit(PROJECT_FILE)), 'after a progress call the first counted edit gets the reminder').toHaveLength(1)
  })

  test('a progress call during such a flow starts counting, with the count at 0', async ($, on) => {
    const k = await setup($, on)
    await k.spawn('planner')
    await k.edit(PROJECT_FILE)
    await k.progress({ title: 'Ship it', total: 1, phase: 'delegate' })
    await expectBand(k, 0, 'the edit made before the progress call is not counted')
    for (const surface of SURFACES) {
      expect(showsDirectEdits(await k.panel(surface), 0), `the ${surface} panel now shows 0 direct edits`).toBe(true)
    }
    expect(remindersOf(await k.edit(PROJECT_FILE)), 'the first counted edit carries the reminder').toHaveLength(1)
    await expectBand(k, 1, 'counting started')
  })
})

describe('R6 dismissing the band', () => {
  test('ends counting for that flow: a later edit gets no reminder and is not counted', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    await k.dismiss()
    expect(remindersOf(await k.edit(PROJECT_FILE)), 'no reminder after the band was dismissed').toEqual([])
    await expectBand(k, 0, 'the dismissed flow does not count')
    // Control: a new flow counts.
    await k.skill('autobots')
    expect(remindersOf(await k.edit(PROJECT_FILE)), 'a new flow reminds on its first counted edit').toHaveLength(1)
    await expectBand(k, 1, 'the new flow counts')
  })
})

describe('R7 outside a counting flow', () => {
  test('no edit is counted: no reminder, and nothing carries into a flow that starts later', async ($, on) => {
    const k = await setup($, on)
    expect(remindersOf(await k.edit(PROJECT_FILE))).toEqual([])
    expect(remindersOf(await k.bash('echo x > notes.txt'))).toEqual([])
    await k.skill('autobots')
    await expectBand(k, 0, 'edits made outside a flow are not carried in')
    for (const surface of SURFACES) {
      expect(showsDirectEdits(await k.panel(surface), 0), `the ${surface} panel shows 0 direct edits`).toBe(true)
    }
  })

  test('once the flow finished, later edits are not added to the count it keeps', async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    await k.edit(PROJECT_FILE)
    await k.edit(PROJECT_FILE)
    await k.progress({ title: 'Ship it', total: 1, done: 1, phase: 'review', finished: true })
    await k.edit(PROJECT_FILE)
    await expectBand(k, 2, 'the third edit came after the flow finished')
  })
})
