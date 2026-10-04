import type { IssueTypeInfo, SlimIssue, Snapshot } from '../types'

export const NO_TYPE = 'No type'
export const UNASSIGNED = 'Unassigned'

const NOTHING_SET = '#8b949e'

/** GitHub's issue-type colour names, as hex. */
const GITHUB_COLORS: Record<string, string> = {
  GRAY: NOTHING_SET,
  BLUE: '#4493f8',
  GREEN: '#3fb950',
  YELLOW: '#d29922',
  ORANGE: '#db6d28',
  RED: '#f85149',
  PINK: '#db61a2',
  PURPLE: '#ab7df8',
}

/** Used for a label-derived type the repo does not define itself. */
const DEFAULT_TYPE_COLORS: Record<string, string> = { Bug: 'RED', Feature: 'BLUE', Task: 'YELLOW' }

/** Picked to stay clear of the red / blue / yellow the issue types use. */
const PERSON_COLORS = ['#2dd4bf', '#e879f9', '#a3e635', '#fb923c', '#818cf8', '#22d3ee', '#f472b6', '#c084fc']
/** Past one colour each, people are grouped into one "others" row. */
const OTHERS_COLOR = '#c9a26b'

export type Slice = { name: string; color: string; count: number }
export type PersonRow = Slice & { byType: Slice[] }
export type Summary = {
  total: number
  byType: Slice[]
  byPerson: PersonRow[]
  /** Issues with more than one assignee: they count once per person. */
  sharedCount: number
}

type GraphqlPage = {
  data?: {
    repository?: {
      issueTypes?: { nodes?: ({ name: string; color: string } | null)[] } | null
      issues: {
        totalCount?: number
        nodes: ({
          number: number
          issueType?: { name: string } | null
          labels?: { nodes?: ({ name: string } | null)[] } | null
          assignees?: { nodes?: ({ login: string } | null)[] } | null
        } | null)[]
      }
    } | null
  }
  errors?: { message: string }[]
}

/** The type an issue counts under: GitHub's own field first, then the two default labels. */
function typeOf(issueType: string | undefined, labels: string[]): string {
  if (issueType) return issueType
  const lower = labels.map(label => label.toLowerCase())
  if (lower.includes('bug')) return 'Bug'
  if (lower.includes('enhancement')) return 'Feature'
  return NO_TYPE
}

/** Reads the GraphQL responses, one per page of up to 100 issues. */
export function parsePages(repo: string, responses: unknown[], fetchedAt: number): Snapshot {
  const pages = responses as GraphqlPage[]
  const firstError = pages.flatMap(page => page.errors ?? [])[0]
  if (firstError) throw new Error(firstError.message)

  const types: IssueTypeInfo[] = []
  const issues: SlimIssue[] = []
  for (const page of pages) {
    const repository = page.data?.repository
    if (!repository) throw new Error(`GitHub returned no repository for ${repo}`)
    for (const node of repository.issueTypes?.nodes ?? []) {
      if (node && !types.some(type => type.name === node.name)) types.push(node)
    }
    for (const node of repository.issues.nodes) {
      if (!node) continue
      const labels = (node.labels?.nodes ?? []).flatMap(label => (label ? [label.name] : []))
      issues.push({
        number: node.number,
        type: typeOf(node.issueType?.name, labels),
        assignees: (node.assignees?.nodes ?? []).flatMap(person => (person ? [person.login] : [])),
      })
    }
  }

  const totalOpen = pages[0]?.data?.repository?.issues.totalCount ?? issues.length

  return { repo, fetchedAt, totalOpen, issues, types }
}

function typeColor(name: string, types: IssueTypeInfo[]): string {
  if (name === NO_TYPE) return NOTHING_SET
  const named = types.find(type => type.name === name)?.color ?? DEFAULT_TYPE_COLORS[name] ?? 'GRAY'
  return GITHUB_COLORS[named] ?? NOTHING_SET
}

function countBy(names: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  return counts
}

export function summarise(snapshot: Snapshot): Summary {
  const { issues, types } = snapshot

  // The repo's own type order, then any other type, then "No type" last.
  const typeCounts = countBy(issues.map(issue => issue.type))
  const typeOrder = [
    ...types.map(type => type.name).filter(name => typeCounts.has(name)),
    ...[...typeCounts.keys()].filter(name => name !== NO_TYPE && !types.some(type => type.name === name)).sort(),
    ...(typeCounts.has(NO_TYPE) ? [NO_TYPE] : []),
  ]
  const slicesOf = (subset: SlimIssue[]): Slice[] => {
    const counts = countBy(subset.map(issue => issue.type))
    return typeOrder.map(name => ({ name, color: typeColor(name, types), count: counts.get(name) ?? 0 }))
  }

  // The people with the most issues get a row and a colour each; colours go
  // in alphabetical order so they stay put between refreshes.
  const perPerson = countBy(issues.flatMap(issue => issue.assignees))
  const shown = [...perPerson.keys()]
    .sort((a, b) => (perPerson.get(b) ?? 0) - (perPerson.get(a) ?? 0) || a.localeCompare(b))
    .slice(0, PERSON_COLORS.length)
  const colorOf = new Map(
    [...shown].sort((a, b) => a.localeCompare(b)).map((login, i) => [login, PERSON_COLORS[i] ?? NOTHING_SET]),
  )
  const byPerson: PersonRow[] = shown.map(login => {
    const theirs = issues.filter(issue => issue.assignees.includes(login))
    return { name: login, color: colorOf.get(login) ?? NOTHING_SET, count: theirs.length, byType: slicesOf(theirs) }
  })
  const othersCount = perPerson.size - shown.length
  if (othersCount > 0) {
    const theirs = issues.filter(issue => issue.assignees.some(login => !colorOf.has(login)))
    byPerson.push({
      name: `${othersCount} other${othersCount === 1 ? '' : 's'}`,
      color: OTHERS_COLOR,
      count: theirs.length,
      byType: slicesOf(theirs),
    })
  }
  const unassigned = issues.filter(issue => issue.assignees.length === 0)
  if (unassigned.length > 0) {
    byPerson.push({ name: UNASSIGNED, color: NOTHING_SET, count: unassigned.length, byType: slicesOf(unassigned) })
  }

  return {
    total: issues.length,
    byType: slicesOf(issues),
    byPerson,
    sharedCount: issues.filter(issue => issue.assignees.length > 1).length,
  }
}

/**
 * Splits `width` cells between the counts in proportion, every non-zero count
 * getting at least one cell so no colour disappears from a bar.
 */
export function allocate(counts: number[], width: number): number[] {
  const total = counts.reduce((sum, count) => sum + count, 0)
  if (total === 0 || width <= 0) return counts.map(() => 0)

  const exact = counts.map(count => (count / total) * width)
  const cells = exact.map((cell, i) => ((counts[i] ?? 0) > 0 ? Math.max(1, Math.floor(cell)) : 0))
  let left = width - cells.reduce((sum, cell) => sum + cell, 0)

  const byRemainder = counts
    .map((count, i) => ({ i, count, remainder: (exact[i] ?? 0) - Math.floor(exact[i] ?? 0) }))
    .filter(entry => entry.count > 0)
    .sort((a, b) => b.remainder - a.remainder)
  for (let k = 0; left > 0 && byRemainder.length > 0; k++) {
    const entry = byRemainder[k % byRemainder.length]
    if (entry) cells[entry.i] = (cells[entry.i] ?? 0) + 1
    left--
  }
  // The one-cell minimum can overshoot: take back from the widest segments.
  while (left < 0) {
    let widest = -1
    cells.forEach((cell, i) => {
      if (cell > 1 && (widest < 0 || cell > (cells[widest] ?? 0))) widest = i
    })
    if (widest < 0) break
    cells[widest] = (cells[widest] ?? 0) - 1
    left++
  }

  return cells
}
