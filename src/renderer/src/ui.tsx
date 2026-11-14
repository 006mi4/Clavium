import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from 'react'
import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideProps } from 'lucide-react'

export type IconType = ComponentType<LucideProps>

// --------------------------------------------------------------- toasts --

interface Toast {
  id: number
  kind: 'info' | 'error' | 'ok'
  text: string
}

const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => undefined)

function ToastHost({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'ok' ? <CircleCheck size={15} /> : t.kind === 'error' ? <CircleAlert size={15} /> : <Info size={15} />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  )
}

export function useToast() {
  const push = useContext(ToastCtx)
  return {
    info: (t: string) => push('info', t),
    ok: (t: string) => push('ok', t),
    error: (e: unknown) => push('error', e instanceof Error ? e.message : String(e))
  }
}

// -------------------------------------------------------------- confirm --

export interface ConfirmOptions {
  title: string
  message?: string
  confirmLabel: string
  destructive?: boolean
}

const ConfirmCtx = createContext<(o: ConfirmOptions) => Promise<boolean>>(() => Promise.resolve(false))

/** Promise-based confirmation sheet: `if (await confirm({...})) …` */
export function useConfirm() {
  return useContext(ConfirmCtx)
}

/** Toasts + confirmation dialogs for the whole app. */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null)

  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t.slice(-2), { id, kind, text }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 2800)
  }, [])

  const confirm = useCallback(
    (o: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...o, resolve })),
    []
  )
  const answer = (v: boolean): void => {
    pending?.resolve(v)
    setPending(null)
  }

  return (
    <ToastCtx.Provider value={push}>
      <ConfirmCtx.Provider value={confirm}>
        {children}
        {pending && (
          <Sheet
            size="narrow"
            title={pending.title}
            onClose={() => answer(false)}
            footer={
              <>
                <button className="btn" onClick={() => answer(false)} autoFocus>
                  Cancel
                </button>
                <button className={`btn ${pending.destructive ? 'destructive filled' : 'prominent'}`} onClick={() => answer(true)}>
                  {pending.confirmLabel}
                </button>
              </>
            }
          >
            {pending.message && <p>{pending.message}</p>}
          </Sheet>
        )}
        <ToastHost toasts={toasts} />
      </ConfirmCtx.Provider>
    </ToastCtx.Provider>
  )
}

// ---------------------------------------------------------------- sheet --

export function Sheet(props: {
  title: ReactNode
  eyebrow?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  onClose?: () => void
  size?: 'narrow' | 'regular' | 'wide'
}) {
  useEffect(() => {
    if (!props.onClose) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        props.onClose?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])
  return (
    <div className="scrim">
      <div className={`sheet ${props.size === 'regular' ? '' : (props.size ?? '')}`} role="dialog" aria-modal="true">
        <header>
          {props.eyebrow && <div className="eyebrow">{props.eyebrow}</div>}
          <h2>{props.title}</h2>
        </header>
        <div className="body">{props.children}</div>
        {props.footer && <footer>{props.footer}</footer>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- menus --

export type MenuItem =
  | { label: string; icon?: IconType; onSelect: () => void; destructive?: boolean; disabled?: boolean; /** keyboard shortcut shown on the right */ hint?: string }
  | 'separator'

interface MenuState {
  x: number
  y: number
  align: 'left' | 'right'
  items: MenuItem[]
}

function MenuPopover({ menu, close }: { menu: MenuState; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: menu.x, top: menu.y, ready: false })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let left = menu.align === 'right' ? menu.x - r.width : menu.x
    let top = menu.y
    left = Math.max(8, Math.min(left, window.innerWidth - r.width - 8))
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - r.height - 8)
    setPos({ left, top, ready: true })
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [menu])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
        buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
      }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [close])

  return (
    <div ref={ref} className="menu" role="menu" style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}>
      {menu.items.map((item, i) =>
        item === 'separator' ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={item.destructive ? 'destructive' : ''}
            disabled={item.disabled}
            onClick={() => {
              close()
              item.onSelect()
            }}
          >
            {item.icon && <item.icon size={15} />}
            {item.label}
            {item.hint && <span className="hint">{item.hint}</span>}
          </button>
        )
      )}
    </div>
  )
}

/** One menu at a time: `const menu = useMenu()` → `menu.openAt(event, items)` and render `{menu.element}`. */
export function useMenu() {
  const [state, setState] = useState<MenuState | null>(null)
  const close = useCallback(() => setState(null), [])
  return {
    /** Context menu at the pointer position. */
    openAt(e: ReactMouseEvent, items: MenuItem[]): void {
      e.preventDefault()
      setState({ x: e.clientX, y: e.clientY, align: 'left', items })
    },
    /** Pull-down menu attached to the clicked button. */
    openBelow(e: ReactMouseEvent<HTMLElement>, items: MenuItem[], align: 'left' | 'right' = 'right'): void {
      const r = e.currentTarget.getBoundingClientRect()
      setState({ x: align === 'right' ? r.right : r.left, y: r.bottom + 4, align, items })
    },
    element: state ? <MenuPopover menu={state} close={close} /> : null
  }
}

// ------------------------------------------------------------- controls --

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className="switch" onClick={() => onChange(!on)} />
}

export function Segmented<T extends string>(props: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  label?: string
}) {
  return (
    <div className="segmented" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === props.value} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Select<T extends string | number>(props: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  label?: string
  width?: number
}) {
  const numeric = typeof props.value === 'number'
  return (
    <select
      className="field"
      aria-label={props.label}
      style={props.width ? { width: props.width } : { width: 'auto' }}
      value={props.value}
      onChange={(e) => props.onChange((numeric ? Number(e.target.value) : e.target.value) as T)}
    >
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function IconButton(props: {
  icon: IconType
  label: string
  onClick?: (e: ReactMouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
  /** for toggle buttons */
  pressed?: boolean
}) {
  return (
    <button type="button" className="icon-btn" title={props.label} aria-label={props.label} aria-pressed={props.pressed} disabled={props.disabled} onClick={props.onClick}>
      <props.icon size={16} />
    </button>
  )
}

// ---------------------------------------------------------------- forms --

export function Group({ title, caption, children }: { title?: string; caption?: ReactNode; children: ReactNode }) {
  return (
    <>
      {title && <h3 className="group-title">{title}</h3>}
      <div className="group">{children}</div>
      {caption && <p className="caption">{caption}</p>}
    </>
  )
}

/**
 * One line of a grouped form: label on the left, control on the right.
 * With a single input/select/switch inside, the whole row is a <label> (clicking the text focuses it).
 * Use `multi` for rows that contain several controls (segmented, buttons).
 */
export function Row(props: { label: string; hint?: ReactNode; children?: ReactNode; multi?: boolean; stacked?: boolean }) {
  const inner = (
    <>
      <span className="row-label">
        {props.label}
        {props.hint && <span className="hint">{props.hint}</span>}
      </span>
      <span className="row-control">{props.children}</span>
    </>
  )
  const cls = `row${props.stacked ? ' stacked' : ''}`
  return props.multi ? (
    <div className={cls} role="group" aria-label={props.label}>
      {inner}
    </div>
  ) : (
    <label className={cls}>{inner}</label>
  )
}

/** Read-only line: label left, value right. */
export function ValueRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <span className="row-value">{children}</span>
    </div>
  )
}

export function Note({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'danger'; children: ReactNode }) {
  return (
    <div className={`note ${kind === 'info' ? '' : kind}`}>
      {kind === 'info' ? <Info size={15} /> : <TriangleAlert size={15} />}
      <div>{children}</div>
    </div>
  )
}

export function Empty(props: { icon: IconType; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <props.icon size={34} strokeWidth={1.4} />
      <h2>{props.title}</h2>
      {props.children && <p>{props.children}</p>}
      {props.action}
    </div>
  )
}

// --------------------------------------------------------------- layout --

/** Unified toolbar of a view. It is also the window's drag region. */
export function Toolbar(props: { title: ReactNode; subtitle?: ReactNode; lead?: ReactNode; children?: ReactNode }) {
  return (
    <div className="toolbar drag">
      {props.lead}
      <div className="titles">
        <span className="title">{props.title}</span>
        {props.subtitle && <span className="subtitle">{props.subtitle}</span>}
      </div>
      {props.children}
    </div>
  )
}

// -------------------------------------------------------------- helpers --

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

export function formatDate(ms: number): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** Tracks the system appearance so non-CSS consumers (the terminal) can follow it. */
export function useDarkMode(): boolean {
  const query = '(prefers-color-scheme: dark)'
  const [dark, setDark] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = (): void => setDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return dark
}
