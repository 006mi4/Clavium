import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import type { PromptRequest } from '@shared/types'
import { api, on } from '../api'
import { Note, Sheet } from '../ui'

/** Shows the sheets the main process asks for: host keys, interactive logins and AI approvals. */
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

  if (current.kind === 'hostKey') return <HostKeySheet key={current.id} req={current} done={done} />
  if (current.kind === 'keyboardInteractive') return <LoginSheet key={current.id} req={current} done={done} />
  return <AiRequestSheet key={current.id} req={current} done={done} waiting={queue.length - 1} />
}

function HostKeySheet({ req, done }: { req: Extract<PromptRequest, { kind: 'hostKey' }>; done: () => void }) {
  const changed = !!req.previousFingerprint
  const answer = (accept: boolean): void => {
    void api.prompt.respond(req.id, { kind: 'hostKey', accept })
    done()
  }
  return (
    <Sheet
      title={changed ? 'The Host Key Has Changed' : 'Verify Host Key'}
      eyebrow={req.host}
      onClose={() => answer(false)}
      footer={
        <>
          <button className="btn" onClick={() => answer(false)} autoFocus>
            Cancel
          </button>
          <button className={`btn ${changed ? 'destructive' : 'prominent'}`} onClick={() => answer(true)}>
            {changed ? 'Replace Key and Connect' : 'Trust and Connect'}
          </button>
        </>
      }
    >
      {changed ? (
        <Note kind="danger">
          This server identified itself with a different key than last time. Someone may be intercepting the
          connection, or the server was reinstalled. Continue only if you know the key was changed on purpose.
        </Note>
      ) : (
        <p>
          You’re connecting to this server for the first time. Compare the fingerprint with the one your server
          shows, for example with <span className="mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</span>.
        </p>
      )}
      {changed && (
        <div>
          <div className="caption">Stored fingerprint</div>
          <div className="code">{req.previousFingerprint}</div>
        </div>
      )}
      <div>
        <div className="caption">
          {changed ? 'Fingerprint presented now' : 'Fingerprint'} · {req.keyType}
        </div>
        <div className="code">{req.fingerprint}</div>
      </div>
    </Sheet>
  )
}

function LoginSheet({ req, done }: { req: Extract<PromptRequest, { kind: 'keyboardInteractive' }>; done: () => void }) {
  const [answers, setAnswers] = useState<string[]>(req.prompts.map(() => ''))
  const send = (ok: boolean): void => {
    void api.prompt.respond(req.id, { kind: 'keyboardInteractive', answers: ok ? answers : null })
    done()
  }
  return (
    <Sheet
      size="narrow"
      title={req.name || 'Sign In'}
      eyebrow={req.host}
      onClose={() => send(false)}
      footer={
        <>
          <button className="btn" onClick={() => send(false)}>
            Cancel
          </button>
          <button className="btn prominent" onClick={() => send(true)}>
            Continue
          </button>
        </>
      }
    >
      {req.instructions && <p>{req.instructions}</p>}
      <form
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        onSubmit={(e) => {
          e.preventDefault()
          send(true)
        }}
      >
        {req.prompts.map((p, i) => (
          <label key={i} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="caption">{p.prompt.replace(/:\s*$/, '')}</span>
            <input
              className="field"
              autoFocus={i === 0}
              type={p.echo ? 'text' : 'password'}
              value={answers[i]}
              onChange={(e) => setAnswers((a) => a.map((v, j) => (j === i ? e.target.value : v)))}
            />
          </label>
        ))}
        <button type="submit" hidden />
      </form>
    </Sheet>
  )
}

function AiRequestSheet({
  req,
  done,
  waiting
}: {
  req: Extract<PromptRequest, { kind: 'mcpConfirm' }>
  done: () => void
  waiting: number
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
    <Sheet
      size="wide"
      title={req.summary}
      eyebrow={
        <>
          <Sparkles size={13} /> AI request · {req.tool}
        </>
      }
      onClose={() => answer(false)}
      footer={
        <>
          <span className="lead">
            Denies automatically in {left} s{waiting > 0 ? ` · ${waiting} more waiting` : ''}
          </span>
          <button className="btn" onClick={() => answer(false)} autoFocus>
            Deny
          </button>
          <button className="btn prominent" onClick={() => answer(true)}>
            Allow Once
          </button>
        </>
      }
    >
      <div className="code" style={{ maxHeight: 320 }}>
        {req.detail}
      </div>
      <p className="caption">
        {req.destructive ? 'This can change the server. ' : ''}
        Read it before you allow it — an AI can be misled by text it reads on a server.
      </p>
    </Sheet>
  )
}
