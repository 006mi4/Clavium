// The commands that fetch what the terminal suggestions need from a server. All of them only
// read. They run through "sh -c", so they work the same whatever login shell the user has.
import type { CompletionContext } from '@shared/types'
import { parseNames, type CompletionNeed } from '@shared/complete'
import { shellQuote } from './screens'

const sh = (script: string): string => `sh -c ${shellQuote(script)}`

const MARK = '__clavium_ctx__'

/**
 * Finds the shell of the terminal: the process with a terminal whose parent is the sshd of this
 * connection. Then the folder of whatever is in the foreground of that terminal. Needs a ps
 * that knows -o, and /proc or lsof; elsewhere the folder simply stays unknown.
 */
const FIND_SHELL = [
  'p=$$; s=',
  'while [ "${p:-1}" -gt 1 ] 2>/dev/null; do',
  '  c=$(ps -o comm= -p "$p" 2>/dev/null)',
  '  case "$c" in sshd*|*/sshd*) s=$p; break;; esac',
  '  p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d " ")',
  'done',
  'sh_pid=; fg=; cwd=; name=',
  'if [ -n "$s" ]; then',
  `  sh_pid=$(ps -e -o pid= -o ppid= -o tty= 2>/dev/null | awk -v s="$s" '$2 == s && $3 != "?" && $3 != "??" { print $1; exit }')`,
  'fi',
  'if [ -n "$sh_pid" ]; then',
  '  fg=$(ps -o tpgid= -p "$sh_pid" 2>/dev/null | tr -d " ")',
  '  case "$fg" in ""|-*|0) fg=$sh_pid;; esac',
  '  name=$(ps -o comm= -p "$fg" 2>/dev/null)',
  '  cwd=$(readlink "/proc/$fg/cwd" 2>/dev/null)',
  // macOS and the BSDs have no /proc
  `  [ -n "$cwd" ] || cwd=$(lsof -a -d cwd -p "$fg" -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)`,
  'fi'
].join('\n')

export const CONTEXT_COMMAND = sh(`${FIND_SHELL}\nprintf '%s\\n%s\\n%s\\n%s\\n' ${MARK} "$name" "$cwd" "$HOME"`)

const SHELLS = /^-?(ba|z|da|k|a|fi|tc|c)?sh$/

export function parseContext(stdout: string): CompletionContext {
  const lines = stdout.split('\n')
  const at = lines.indexOf(MARK)
  if (at < 0) return { cwd: '', home: '', busy: false }
  const name = (lines[at + 1] ?? '').trim().replace(/^.*\//, '')
  const clean = (v: string | undefined): string => (v && v.startsWith('/') && !/[\x00-\x1f\x7f]/.test(v) ? v : '')
  return {
    cwd: clean(lines[at + 2]),
    home: clean(lines[at + 3]),
    // Something else than a shell is in the foreground (an editor, a database client, another ssh):
    // what is typed there is not a command line.
    busy: name !== '' && !SHELLS.test(name)
  }
}

const NAME = /^[A-Za-z0-9_.+-]{1,64}$/

/** The command for one list. `need.path` and `need.cwd` are quoted, never pasted in as they are. */
export function listCommand(need: CompletionNeed): string {
  switch (need.kind) {
    case 'commands':
      return sh('IFS=:; for d in $PATH; do ls -1 "$d" 2>/dev/null; done | sort -u | head -n 5000')
    case 'dir': {
      // "~" is expanded here; everything else is taken literally
      const home = need.path === '~' || need.path.startsWith('~/')
      const rest = home ? need.path.slice(1) : need.path
      const target = home ? `"$HOME"${shellQuote(rest)}` : shellQuote(rest)
      return sh(`cd ${target} 2>/dev/null && ls -1Ap 2>/dev/null | head -n 2000`)
    }
    case 'git-branch':
      return sh(`cd ${shellQuote(need.cwd || '.')} 2>/dev/null && git branch -a --format='%(refname:short)' 2>/dev/null | head -n 500`)
    case 'git-remote':
      return sh(`cd ${shellQuote(need.cwd || '.')} 2>/dev/null && git remote 2>/dev/null | head -n 50`)
    case 'systemd-unit':
      return sh(`systemctl list-unit-files --no-legend --no-pager --type=service,timer,socket 2>/dev/null | awk '{print $1}' | head -n 1000`)
    case 'docker-container':
      return sh(`docker ps -a --format '{{.Names}}' 2>/dev/null | head -n 500`)
    case 'docker-image':
      return sh(`docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -v '<none>' | head -n 500`)
    case 'ssh-host':
      return sh(`awk 'tolower($1) == "host" { for (i = 2; i <= NF; i++) if ($i !~ /[*?!]/) print $i }' ~/.ssh/config 2>/dev/null | head -n 500`)
    case 'process':
      return sh(`ps -e -o comm= 2>/dev/null | sed 's|.*/||' | sort -u | head -n 500`)
    case 'user':
      return sh(`cut -d: -f1 /etc/passwd 2>/dev/null | head -n 500`)
    case 'interface':
      return sh(`ls -1 /sys/class/net 2>/dev/null | head -n 100`)
  }
}

export function parseList(need: CompletionNeed, stdout: string): string[] {
  if (need.kind === 'dir') return parseNames(stdout, 2000)
  const names = parseNames(stdout, need.kind === 'commands' ? 5000 : 1000)
  // Branch names may contain slashes; everything else is a plain name.
  if (need.kind === 'git-branch') return names.filter((n) => /^[A-Za-z0-9_.+\-/@]{1,200}$/.test(n))
  if (need.kind === 'docker-image') return names.filter((n) => /^[A-Za-z0-9_.+\-/:@]{1,255}$/.test(n))
  if (need.kind === 'systemd-unit') return names.filter((n) => /^[A-Za-z0-9_.+\-@:\\]{1,255}$/.test(n))
  if (need.kind === 'commands') return names
  return names.filter((n) => NAME.test(n))
}

/** The last commands of the history files of the usual shells. */
export const HISTORY_COMMAND = sh(
  'for f in "$HOME/.bash_history" "$HOME/.zsh_history" "${HISTFILE:-}" "$HOME/.local/share/fish/fish_history"; do [ -f "$f" ] && tail -n 400 "$f" 2>/dev/null; done; true'
)
