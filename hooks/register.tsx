import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Snapshot } from '../types'
import { allocate, parsePages, summarise } from './summary'
import type { Slice } from './summary'

const PANE = 'repo-issues'
const TITLE = 'GitHub issues'
const REFRESH_MS = 5 * 60_000
/** 10 pages of 100: a fair picture of any repo in seconds, where all of a huge one takes minutes. */
const MAX_PAGES = 10
const ERROR_COLOR = '#f85149'

const QUERY = `query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    issueTypes(first: 25) { nodes { name color } }
    issues(states: OPEN, first: 100, after: $endCursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        issueType { name }
        labels(first: 20) { nodes { name } }
        assignees(first: 10) { nodes { login } }
      }
    }
  }
}`

const snapshot = atom({ plugin: 'repo-issues', key: 'snapshot' } as const, null)
const lastError = atom({ plugin: 'repo-issues', key: 'lastError' } as const, null)
const isLoading = atom({ plugin: 'repo-issues', key: 'isLoading' } as const, false)

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}

function clockTime(ms: number): string {
  const at = new Date(ms)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

type PageInfo = { data?: { repository?: { issues?: { pageInfo?: { hasNextPage: boolean; endCursor: string | null } } } } }

/** Asks the `gh` CLI (already logged in on this machine) for the repo's open issues. */
async function fetchSnapshot($: EngineInterface): Promise<Snapshot> {
  const view = await $.process.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  if (view.exitCode !== 0) throw new Error(firstLine(view.stderr) || 'this folder is not a GitHub repo')
  const repo = view.stdout.trim()
  const [owner = '', name = ''] = repo.split('/')

  const pages: unknown[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const argv = ['gh', 'api', 'graphql', '-f', `query=${QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`]
    if (cursor !== null) argv.push('-f', `endCursor=${cursor}`)
    const result = await $.process.run(argv, { timeoutMs: 60_000 })
    if (result.exitCode !== 0) throw new Error(firstLine(result.stderr) || `gh exited with code ${result.exitCode}`)

    const parsed = JSON.parse(result.stdout) as PageInfo
    pages.push(parsed)
    const info = parsed.data?.repository?.issues?.pageInfo
    if (!info?.hasNextPage || !info.endCursor) break
    cursor = info.endCursor
  }

  return parsePages(repo, pages, await $.clock.now())
}

// One fetch at a time; a module variable, so a reload never leaves it stuck.
let inFlight: Promise<void> | null = null

async function runRefresh($: EngineInterface): Promise<void> {
  await update($, isLoading, () => true)
  try {
    const fresh = await fetchSnapshot($)
    await update($, snapshot, () => fresh)
    await update($, lastError, () => null)
    $.ui.status(`GitHub: ${fresh.totalOpen} open issues`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, lastError, () => message)
  } finally {
    await update($, isLoading, () => false)
    inFlight = null
  }
}

function refresh($: EngineInterface): Promise<void> {
  inFlight ??= runRefresh($)

  return inFlight
}

/** Opens the pane by itself only in a folder whose issues it could read. */
async function firstLoad($: EngineInterface): Promise<void> {
  await refresh($)
  if ((await read($, lastError)) === null && (await read($, snapshot)) !== null) {
    await $.ui.open({ id: PANE, title: TITLE })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'issues',
      description: "Show this repo's open GitHub issues by type and by person",
    })
    await update($, isLoading, () => false)

    if (e.isInteractive) {
      $.clock.after(1, () => void firstLoad($))
      $.clock.every(REFRESH_MS, () => void refresh($))
    }

    return next(e)
  })

  on('command.run', { command: 'issues' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await refresh($)
    const [fresh, error] = await Promise.all([read($, snapshot), read($, lastError)])

    if (error !== null) return { text: `Couldn't fetch GitHub issues: ${error}` }
    if (fresh === null) return { text: 'No GitHub issues fetched yet.' }

    return { text: `${fresh.totalOpen} open issues in ${fresh.repo}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [fresh, error, loading] = await Promise.all([read($, snapshot), read($, lastError), read($, isLoading)])
    const width = Math.max(24, e.props.bodyColumns)

    const bar = (slices: Slice[], cells: number) => {
      const widths = allocate(
        slices.map(slice => slice.count),
        cells,
      )

      return (
        <Box flexDirection="row">
          {slices.map((slice, i) => (widths[i] ?? 0) > 0 && <Text color={slice.color}>{'█'.repeat(widths[i] ?? 0)}</Text>)}
        </Box>
      )
    }

    const refreshButton = (
      <Button key="refresh" hotkey="r" label={loading ? 'Refreshing…' : 'Refresh'} onPress={() => refresh($)} />
    )
    const errorLine = error !== null && (
      <Text color={ERROR_COLOR} wrap="wrap">
        Couldn't fetch issues: {error}
      </Text>
    )

    if (fresh === null) {
      return (
        <Box flexDirection="column">
          {error === null && <Text dimColor>Fetching open issues from GitHub…</Text>}
          {errorLine}
          {error !== null && <Text dimColor>Check that `gh auth status` works in this folder.</Text>}
          <Box marginTop={1}>{refreshButton}</Box>
        </Box>
      )
    }

    const summary = summarise(fresh)
    const typeNameWidth = Math.max(...summary.byType.map(slice => slice.name.length), 4)
    const personNameWidth = Math.min(16, Math.max(...summary.byPerson.map(row => row.name.length), 4))
    const countWidth = String(summary.total).length
    const personBarWidth = Math.max(4, width - (2 + personNameWidth + 1 + countWidth + 1))
    const largestPerson = Math.max(1, ...summary.byPerson.map(row => row.count))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>{fresh.totalOpen} open issues</Text>
          {refreshButton}
        </Box>
        <Text dimColor wrap="truncate">
          {fresh.repo} · updated {clockTime(fresh.fetchedAt)}
        </Text>
        {errorLine}
        {fresh.totalOpen > summary.total && (
          <Text dimColor wrap="wrap">
            The breakdown below covers the {summary.total} most recently updated.
          </Text>
        )}

        {summary.total === 0 ? (
          <Box marginTop={1}>
            <Text dimColor>No open issues.</Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Box marginTop={1}>
              <Text bold>By type</Text>
            </Box>
            {bar(summary.byType, width)}
            {summary.byType.map(slice => (
              <Box flexDirection="row">
                <Text color={slice.color}>■ </Text>
                <Text>{slice.name.padEnd(typeNameWidth)} </Text>
                <Text bold>{String(slice.count).padStart(countWidth)}</Text>
                <Text dimColor> {String(Math.round((slice.count / summary.total) * 100)).padStart(3)}%</Text>
              </Box>
            ))}

            <Box marginTop={1}>
              <Text bold>By person</Text>
            </Box>
            {bar(summary.byPerson, width)}
            {summary.byPerson.map(row => {
              const typesHeld = row.byType.filter(slice => slice.count > 0).length
              const cells = Math.max(typesHeld, Math.round((row.count / largestPerson) * personBarWidth))

              return (
                <Box flexDirection="row">
                  <Text color={row.color} wrap="truncate">
                    ■ {row.name.slice(0, personNameWidth).padEnd(personNameWidth)}{' '}
                  </Text>
                  <Text bold>{String(row.count).padStart(countWidth)} </Text>
                  {bar(row.byType, cells)}
                </Box>
              )
            })}
            <Text dimColor wrap="wrap">
              Each person's bar is split by issue type, in the colours above.
              {summary.sharedCount > 0
                ? ` ${summary.sharedCount} issue${summary.sharedCount === 1 ? ' has' : 's have'} more than one person, so ${summary.sharedCount === 1 ? 'it counts' : 'they count'} for each.`
                : ''}
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}
