import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, SquarePen } from 'lucide-react'
import type { ExternalEditStatus, RemoteEntry } from '@shared/types'
import { api } from '../api'
import { Sheet, formatBytes } from '../ui'

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i
export const isImage = (entry: Pick<RemoteEntry, 'name' | 'type'>): boolean => entry.type === 'file' && IMAGE_NAME.test(entry.name)

/** Shows a picture of the server. The arrow keys go through the other pictures of the folder. */
export function ImagePreview(props: { sid: string; images: RemoteEntry[]; start: RemoteEntry; onDownload: (entry: RemoteEntry) => void; close: () => void }) {
  const [index, setIndex] = useState(() => Math.max(0, props.images.findIndex((i) => i.path === props.start.path)))
  const entry = props.images[index] ?? props.start
  const [shown, setShown] = useState<{ path: string; dataUrl: string } | null>(null)
  const [error, setError] = useState('')
  const [pixels, setPixels] = useState('')
  const many = props.images.length > 1
  const step = (by: number): void => setIndex((i) => (i + by + props.images.length) % props.images.length)

  useEffect(() => {
    let current = true
    setError('')
    setPixels('')
    api.files
      .readImage(props.sid, entry.path)
      .then((r) => current && setShown({ path: entry.path, dataUrl: r.dataUrl }))
      .catch((e) => current && setError((e as Error).message))
    return () => {
      current = false
    }
  }, [props.sid, entry.path])

  useEffect(() => {
    if (!many) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowLeft') step(-1)
      else if (e.key === 'ArrowRight') step(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [many, props.images.length])

  const loading = !error && shown?.path !== entry.path
  return (
    <Sheet
      size="xwide"
      title={entry.name}
      eyebrow={many ? `Picture ${index + 1} of ${props.images.length}` : 'Picture'}
      onClose={props.close}
      footer={
        <>
          {many && (
            <span style={{ marginRight: 'auto', display: 'flex', gap: 6 }}>
              <button className="btn" onClick={() => step(-1)} aria-label="Previous picture">
                <ChevronLeft size={15} /> Previous
              </button>
              <button className="btn" onClick={() => step(1)} aria-label="Next picture">
                Next <ChevronRight size={15} />
              </button>
            </span>
          )}
          <button className="btn" onClick={() => props.onDownload(entry)}>
            Download…
          </button>
          <button className="btn prominent" onClick={props.close} autoFocus>
            Close
          </button>
        </>
      }
    >
      <div className="image-preview">
        {error ? (
          <p role="alert">{error}</p>
        ) : (
          shown && <img src={shown.dataUrl} alt={shown.path === entry.path ? entry.name : ''} className={loading ? 'stale' : ''} onLoad={(e) => setPixels(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight} pixels`)} />
        )}
        {loading && <div className="spinner" aria-hidden="true" />}
      </div>
      <p className="caption" role="status" aria-live="polite">
        {loading ? 'Loading the picture' : error ? '' : [pixels, formatBytes(entry.size)].filter(Boolean).join(', ')}
      </p>
    </Sheet>
  )
}

/** The files of this session that are open in a program on this computer. */
export function ExternalBar(props: { edits: ExternalEditStatus[] }) {
  if (!props.edits.length) return null
  return (
    <div className="watch-bar" role="status" aria-live="polite">
      {props.edits.map((e) => (
        <div key={e.id} className="watch">
          <SquarePen size={15} />
          <span className="what">
            <span className="mono">{e.remote}</span> is open in your editor.{' '}
            {e.state === 'uploading'
              ? 'Uploading what you saved.'
              : e.uploads > 0
                ? `Uploaded ${e.uploads === 1 ? 'once' : `${e.uploads} times`}. Every save is uploaded.`
                : 'Every save is uploaded.'}
            {(e.state === 'conflict' || e.state === 'error') && <span className="problem"> Not uploaded: {e.lastError}</span>}
          </span>
          {(e.state === 'conflict' || e.state === 'error') && (
            <button className="btn small" onClick={() => void api.files.externalUpload(e.id)} aria-label={`Upload ${e.name} anyway and replace the file on the server`}>
              {e.state === 'conflict' ? 'Upload Anyway' : 'Try Again'}
            </button>
          )}
          <button className="btn small" onClick={() => void api.files.externalStop(e.id)} aria-label={`Stop uploading ${e.name}`}>
            Stop
          </button>
        </div>
      ))}
    </div>
  )
}
