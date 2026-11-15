// "Type into all terminals": what is typed into one terminal of a tab is handed to the others.
// Every terminal registers a function that takes such input; the terminal that is typed into
// names the panes that should get it. Nothing here knows about tabs or connections.

type Receive = (data: string) => void

const receivers = new Map<string, Receive>()

/** Called by a terminal for as long as it exists. Returns the function that takes it out again. */
export function registerTerminal(paneId: string, receive: Receive): () => void {
  receivers.set(paneId, receive)
  return () => {
    if (receivers.get(paneId) === receive) receivers.delete(paneId)
  }
}

/** Hand typed input to the terminals of these panes. A pane without a terminal is passed over. */
export function sendToTerminals(paneIds: readonly string[], data: string): void {
  for (const id of paneIds) receivers.get(id)?.(data)
}
