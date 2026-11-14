import { useEffect, useState } from 'react'
import type { PromptRequest } from '@shared/types'
import { api, on } from '../api'
import { Modal } from '../ui'

/** Shows dialogs the main process asks for: host keys, keyboard-interactive logins and AI approvals. */
export function PromptHost() {
  const [queue, setQueue] = useState<PromptRequest[]>([])

  useEffect(() => {
    const offReq = on('prompt:request', (req: PromptRequest) => setQueue((q) => [...q, req]))
    const offCancel = on('prompt:cancel', (id: string) => setQueue((q) => q.filter((r) => r.id !== id)))
    return () => {
      offReq()
      offCancel()
    }
  }, [])

  const current = queue[0]
  if (!current) return null
  const done = (): void => setQueue((q) => q.filter((r) => r.id !== current.id))

  if (current.kind === 'hostKey') return <HostKeyDialog key={current.id} req={current} done={done} />
  if (current.kind === 'keyboardInteractive') return <KbdDialog key={current.id} req={current} done={done} />
  return <McpDialog key={current.id} req={current} done={done} pending={queue.length - 1} />
}

function HostKeyDialog({ req, done }: { req: Extract<PromptRequest, { kind: 'hostKey' }>; done: () => void }) {
  const changed = !!req.previousFingerprint
  const answer = (accept: boolean): void => {
    void api.prompt.respond(req.id, { kind: 'hostKey', accept })
    done()
  }
  return (
    <Modal
      className={changed ? 'alert' : ''}
      title={changed ? '⚠ Host key has CHANGED' : 'Unknown host key'}
      onClose={() => answer(false)}
      footer={
        <>
          <button className="btn" onClick={() => answer(false)} autoFocus>
            Cancel
          </button>
          <button className={`btn ${changed ? 'danger' : 'primary'}`} onClick={() => answer(true)}>
            {changed ? 'Replace stored key and connect' : 'Trust and connect'}
          </button>
        </>
      }
    >
      {changed ? (
        <div className="callout danger">
          The identity of <b>{req.host}</b> is different from the last connection. Someone could be intercepting
          the connection (man-in-the-middle), or the server was reinstalled. Only continue if you know the key was
          changed on purpose.
        </div>
      ) : (
        <div className="muted">
          This is the first connection to <b>{req.host}</b>. Compare the fingerprint with the one shown by the server
          administrator (e.g. <span className="mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</span>).
        </div>
      )}
      <div className="stack">
        <div className="small muted">Key type: {req.keyType}</div>
        {changed && (
          <div>
            <div className="small muted">Previously stored</div>
            <div className="code">{req.previousFingerprint}</div>
          </div>
        )}
        <div>
          <div className="small muted">{changed ? 'Presented now' : 'Fingerprint'}</div>
          <div className="code">{req.fingerprint}</div>
        </div>
      </div>
    </Modal>
  )
}

function KbdDialog({ req, done }: { req: Extract<PromptRequest, { kind: 'keyboardInteractive' }>; done: () => void }) {
  const [answers, setAnswers] = useState<string[]>(req.prompts.map(() => ''))
  const send = (ok: boolean): void => {
    void api.prompt.respond(req.id, { kind: 'keyboardInteractive', answers: ok ? answers : null })
    done()
  }
  return (
    <Modal
      title={`Login: ${req.host}`}
      onClose={() => send(false)}
      footer={
        <>
          <button className="btn" onClick={() => send(false)}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => send(true)}>
            Continue
          </button>
        </>
      }
    >
      {req.name && <b>{req.name}</b>}
      {req.instructions && <div className="muted">{req.instructions}</div>}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          send(true)
        }}
      >
        {req.prompts.map((p, i) => (
          <label className="field" key={i}>
            {p.prompt}
            <input
              className="input"
              autoFocus={i === 0}
              type={p.echo ? 'text' : 'password'}
              value={answers[i]}
              onChange={(e) => setAnswers((a) => a.map((v, j) => (j === i ? e.target.value : v)))}
            />
          </label>
        ))}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

function McpDialog({
  req,
  done,
  pending
}: {
  req: Extract<PromptRequest, { kind: 'mcpConfirm' }>
  done: () => void
  pending: number
}) {
  const [left, setLeft] = useState(Math.round(req.timeoutMs / 1000))
  useEffect(() => {
    const t = setInterval(() => setLeft((l) => Math.max(0, l - 1)), 1000)
    return () => clearInterval(t)
  }, [])
  const answer = (allow: boolean): void => {
    void api.prompt.respond(req.id, { kind: 'mcpConfirm', allow })
    done()
  }
  return (
    <Modal
      className="ai wide"
      title={
        <>
          <span className="badge accent">AI request</span> {req.summary}
        </>
      }
      onClose={() => answer(false)}
      footer={
        <>
          <span className="muted small grow">
            Auto-deny in {left}s{pending > 0 ? ` · ${pending} more waiting` : ''}
          </span>
          <button className="btn" onClick={() => answer(false)} autoFocus>
            Deny
          </button>
          <button className={`btn ${req.destructive ? 'danger' : 'primary'}`} onClick={() => answer(true)}>
            Allow once
          </button>
        </>
      }
    >
      <div className="row">
        <span className="badge">host: {req.hostName}</span>
        <span className="badge">tool: {req.tool}</span>
        {req.destructive && <span className="badge warn">changes the server</span>}
      </div>
      <div className="code" style={{ maxHeight: 340 }}>
        {req.detail}
      </div>
      <div className="small muted">
        An AI client connected through MCP wants to perform this action. Read it carefully — AI agents can be
        manipulated by content they read (prompt injection).
      </div>
    </Modal>
  )
}
