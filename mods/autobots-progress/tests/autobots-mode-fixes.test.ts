// Regression tests for the review fixes to Autobots Mode (docs/requirements/autobots-mode.md).
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { PROJECT_FILE, expectBand, remindersOf, setup } from './autobots-mode-kit'

describe('a finishing call with a different title', () => {
  test("keeps the counting flow's count and states it in the result", async ($, on) => {
    const k = await setup($, on)
    await k.skill('autobots')
    await k.progress({ title: 'Ship it', total: 1, phase: 'delegate' })
    for (let i = 0; i < 3; i++) await k.edit(PROJECT_FILE)
    const text = String((await k.progress({ title: 'Ship the fix', finished: true })).result)
    expect(text).toMatch(/^ok: Done/)
    expect(text).toMatch(/(^|\D)3 direct edits/)
    await expectBand(k, 3, 'the finishing call kept the count')
  })
})

// Each is checked against a control edit, which must be the flow's first counted one.
const UNCOUNTED = [
  'git apply --check p.diff',
  'git apply --stat p.diff',
  'git apply --numstat p.diff',
  'git apply --summary p.diff',
  'git restore --staged f.rb',
  'git restore -S f.rb',
  // A subshell's `cd` lasts until its `)`; inside it, the redirect is to a temporary file.
  '(cd /tmp && echo x > f) && ls',
]

const COUNTED = [
  'git restore --staged --worktree f.rb',
  'git restore --staged -W f.rb',
  "for f in a.rb; do sed -i 's/a/b/' a.rb; done",
  "if true; then sed -i 's/a/b/' a.rb; fi",
  "sudo sed -i 's/a/b/' f.rb",
  "env X=1 sed -i 's/a/b/' f.rb",
  "time nohup sed -i 's/a/b/' f.rb",
  '(cd /tmp && make) && echo x > f',
]

describe('Bash forms fixed after review', () => {
  for (const command of UNCOUNTED) {
    test(`the Bash command ${JSON.stringify(command)} is not counted`, async ($, on) => {
      const k = await setup($, on)
      await k.skill('autobots')
      expect(remindersOf(await k.bash(command)), 'no reminder for an uncounted command').toEqual([])
      expect(remindersOf(await k.edit(PROJECT_FILE)), 'the edit that follows gets the reminder').toHaveLength(1)
      await expectBand(k, 1, 'only the edit that follows')
    })
  }

  for (const command of COUNTED) {
    test(`the Bash command ${JSON.stringify(command)} counts as one direct edit`, async ($, on) => {
      const k = await setup($, on)
      await k.skill('autobots')
      expect(remindersOf(await k.bash(command)), 'the first counted edit carries the reminder').toHaveLength(1)
      await expectBand(k, 1, 'one command')
    })
  }
})

const submit = ($: Engine, text: string, kind: string) =>
  $.prompt.submit({ text, wait: false, origin: { kind } } as never)

describe('only an owner prompt starts a flow', () => {
  for (const kind of ['task-notification', 'peer', 'peer-send-message', 'scheduled-trigger', 'coordinator']) {
    test(`a /autobots prompt from a ${kind} origin does not start a flow`, async ($, on) => {
      const k = await setup($, on)
      await submit($, '/autobots go', kind)
      expect(remindersOf(await k.edit(PROJECT_FILE)), 'no reminder: no flow is active').toEqual([])
      // Control: the owner's own prompt does start one.
      await k.prompt('/autobots go')
      expect(remindersOf(await k.edit(PROJECT_FILE)), 'the owner prompt started a flow').toHaveLength(1)
      await expectBand(k, 1, 'only the edit after the owner prompt')
    })
  }

  for (const kind of ['bridge', 'sdk']) {
    test(`a /autobots prompt from a ${kind} origin starts a flow`, async ($, on) => {
      const k = await setup($, on)
      await submit($, '/autobots go', kind)
      expect(remindersOf(await k.edit(PROJECT_FILE)), 'the first counted edit carries the reminder').toHaveLength(1)
    })
  }
})
