/** One open issue, cut down to what the pane counts. */
export type SlimIssue = {
  number: number
  /** GitHub's issue type, else one read off a `bug` / `enhancement` label, else "No type". */
  type: string
  /** GitHub logins; empty when nobody is assigned. */
  assignees: string[]
}

/** An issue type the repo defines, with GitHub's colour name for it (RED, BLUE, ...). */
export type IssueTypeInfo = { name: string; color: string }

export type Snapshot = {
  /** owner/name */
  repo: string
  fetchedAt: number
  /** Every open issue in the repo, as GitHub counts them. */
  totalOpen: number
  /** The most recently updated open issues, capped: `totalOpen` can be larger. */
  issues: SlimIssue[]
  types: IssueTypeInfo[]
}

declare module 'claude-code' {
  interface PluginState {
    'repo-issues': {
      snapshot: Snapshot | null
      lastError: string | null
      isLoading: boolean
    }
  }
}
