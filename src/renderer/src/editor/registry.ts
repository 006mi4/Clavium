import type { EditorEdit } from '@shared/types'

/** What one file session offers to AI clients (through the MCP server) about its editor. */
export interface SessionEditorApi {
  hostId: string
  /** Open a file in this session's editor and wait until its text is loaded. */
  open(path: string): Promise<void>
  list(): { path: string; name: string; unsaved: boolean }[]
  read(path: string): { text: string; unsaved: boolean }
  /** Change the text in the editor (not on the server). Returns the number of replaced places. */
  edit(path: string, edit: EditorEdit): number
}

const sessions = new Set<SessionEditorApi>()

export function registerEditorSession(api: SessionEditorApi): () => void {
  sessions.add(api)
  return () => {
    sessions.delete(api)
  }
}

export function editorSessions(hostId?: string): SessionEditorApi[] {
  return [...sessions].filter((s) => !hostId || s.hostId === hostId)
}
