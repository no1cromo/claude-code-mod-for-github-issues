import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { allocate, parsePages, summarise } from '../hooks/summary'

type Issue = ReturnType<typeof issue>

const issue = (number: number, type: string | null, labels: string[], assignees: string[]) => ({
  number,
  issueType: type === null ? null : { name: type },
  labels: { nodes: labels.map(name => ({ name })) },
  assignees: { nodes: assignees.map(login => ({ login })) },
})

const types = { nodes: [{ name: 'Task', color: 'YELLOW' }, { name: 'Bug', color: 'RED' }, { name: 'Feature', color: 'BLUE' }] }

/** One GraphQL response: a page of issues, `next` the cursor of the page after it. */
const page = (nodes: Issue[], totalCount: number, next: string | null) => ({
  data: {
    repository: {
      issueTypes: types,
      issues: { totalCount, pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes },
    },
  },
})

/** A five-issue repo, in two pages. */
const PAGES = [
  page([issue(1, 'Bug', [], ['alice']), issue(2, null, ['enhancement'], []), issue(3, null, ['bug', 'enhancement'], ['alice', 'bob'])], 5, 'x'),
  page([issue(4, 'Task', [], []), issue(5, null, ['question'], [])], 5, null),
]

const ran = (stdout: string, exitCode = 0, stderr = '') => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

type World = { repoView?: ReturnType<typeof ran>; pages?: (cursor: string | null) => unknown }

/**
 * Stands in for the `gh` CLI, and for the surface's pane and status line,
 * beneath the plugin; counts the GraphQL calls and the panes opened.
 */
function fakeWorld(on: On, world: World = {}) {
  const seen = { graphqlCalls: 0, opened: 0 }
  const repoView = world.repoView ?? ran('acme/widgets\n')
  const pages = world.pages ?? (cursor => (cursor === 'x' ? PAGES[1] : PAGES[0]))

  on('process.run', ($, e) => {
    if (e.argv[1] === 'repo') return { value: repoView }
    seen.graphqlCalls++
    const cursor = e.argv.find(arg => arg.startsWith('endCursor='))?.slice('endCursor='.length) ?? null
    return { value: ran(JSON.stringify(pages(cursor))) }
  })
  on('ui.open', () => {
    seen.opened++
    return { value: { isPlaced: true } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  return seen
}

const runIssues = ($: Engine) =>
  $.command.run({
    command: 'issues',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

const PANE = {
  component: 'Pane',
  requestId: 'repo-issues',
  props: {
    title: 'GitHub issues',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

describe('summary', () => {
  test('counts by type, with bug / enhancement labels standing in for a missing type', () => {
    const summary = summarise(parsePages('acme/widgets', PAGES, 0))

    expect(summary.total).toBe(5)
    // The repo's own type order, "No type" last; label "bug" wins over "enhancement".
    expect(summary.byType.map(slice => [slice.name, slice.count])).toEqual([
      ['Task', 1],
      ['Bug', 2],
      ['Feature', 1],
      ['No type', 1],
    ])
    expect(summary.byType[1]?.color).toBe('#f85149')
  })

  test('counts by person, a shared issue once for each, unassigned last', () => {
    const summary = summarise(parsePages('acme/widgets', PAGES, 0))

    expect(summary.byPerson.map(row => [row.name, row.count])).toEqual([
      ['alice', 2],
      ['bob', 1],
      ['Unassigned', 3],
    ])
    expect(summary.sharedCount).toBe(1)
    expect(summary.byPerson[0]?.byType.find(slice => slice.name === 'Bug')?.count).toBe(2)
    // Each person gets their own colour; nobody shares the "nothing set" grey.
    const colors = summary.byPerson.map(row => row.color)
    expect(new Set(colors).size).toBe(3)
  })

  test('past eight people, the rest share one "others" row', () => {
    const logins = ['p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07', 'p08', 'p09', 'p10']
    // p01 has 10 issues, p02 has 9, ... p10 has 1; issue 99 is shared by p09 and p10.
    const nodes = logins.flatMap((login, i) =>
      Array.from({ length: logins.length - i }, (_, k) => issue(i * 100 + k, null, [], [login])),
    )
    nodes.push(issue(99, 'Bug', [], ['p09', 'p10']))
    const summary = summarise(parsePages('acme/widgets', [page(nodes, nodes.length, null)], 0))

    expect(summary.byPerson.map(row => row.name)).toEqual(['p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07', 'p08', '2 others'])
    // p09's 2 + 1 shared, p10's 1 + the same shared one: 3 issues, the shared one once.
    expect(summary.byPerson.at(-1)?.count).toBe(4)
    expect(new Set(summary.byPerson.map(row => row.color)).size).toBe(9)
  })

  test("a user-owned repo has no issue types and still counts", () => {
    const userRepo = { data: { repository: { issueTypes: null, issues: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [issue(1, null, ['bug'], [])] } } } }
    const summary = summarise(parsePages('someone/thing', [userRepo], 0))

    expect(summary.byType.map(slice => [slice.name, slice.count, slice.color])).toEqual([['Bug', 1, '#f85149']])
  })

  test('a GraphQL error is reported, not counted as zero issues', () => {
    expect(() => parsePages('acme/widgets', [{ errors: [{ message: 'Bad credentials' }] }], 0)).toThrow('Bad credentials')
  })

  test('bars fill their width and never drop a non-zero colour', () => {
    const cells = allocate([123, 4, 2], 40)

    expect(cells.reduce((sum, cell) => sum + cell, 0)).toBe(40)
    expect(cells.every(cell => cell >= 1)).toBe(true)
    expect(allocate([0, 0], 10)).toEqual([0, 0])
    expect(allocate([5, 0, 5], 10)).toEqual([5, 0, 5])
  })
})

describe('/issues and the pane', () => {
  test('/issues answers with the count and the pane draws both breakdowns', async ($, on) => {
    mock.clock(on, { now: Date.UTC(2026, 9, 4, 12, 0) })
    const seen = fakeWorld(on)

    expect((await runIssues($)).text).toBe('5 open issues in acme/widgets.')
    expect(seen.graphqlCalls).toBe(2)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'repo-issues', surface, ...PANE })
      expect(await ui.find({ type: 'Text', text: '5 open issues' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'By type' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'By person' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /alice/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /more than one person/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /most recently updated/ })).toBeUndefined()
      expect(await ui.find({ key: 'refresh' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a huge repo stops after 1,000 issues but still shows its true total', async ($, on) => {
    mock.clock(on)
    // Every page says there is another one after it.
    const seen = fakeWorld(on, {
      pages: cursor => {
        const n = cursor === null ? 0 : Number(cursor)
        return page([issue(n, 'Bug', [], [])], 18613, String(n + 1))
      },
    })

    expect((await runIssues($)).text).toBe('18613 open issues in acme/widgets.')
    expect(seen.graphqlCalls).toBe(10)

    const ui = await $.ui.mount({ plugin: 'repo-issues', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: '18613 open issues' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /covers the 10 most recently updated/ })).toBeDefined()
    await ui.unmount()
  })

  test('a folder that is not a GitHub repo shows the reason instead of a count', async ($, on) => {
    mock.clock(on)
    fakeWorld(on, { repoView: ran('', 1, 'no git remotes found\n') })

    expect((await runIssues($)).text).toBe("Couldn't fetch GitHub issues: no git remotes found")

    const ui = await $.ui.mount({ plugin: 'repo-issues', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /no git remotes found/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /open issues/ })).toBeUndefined()
    await ui.unmount()
  })

  test('at start, in a GitHub repo, the pane opens by itself', async ($, on) => {
    const clock = mock.clock(on)
    const seen = fakeWorld(on)
    await $.session.start({ cwd: '/work/widgets', surface: 'terminal', isInteractive: true })
    await clock.advance(1)
    expect(seen.opened).toBe(1)
  })

  test('at start, outside a GitHub repo, the pane stays shut', async ($, on) => {
    const clock = mock.clock(on)
    const seen = fakeWorld(on, { repoView: ran('', 1, 'not a git repository\n') })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await clock.advance(1)
    expect(seen.opened).toBe(0)
  })
})
