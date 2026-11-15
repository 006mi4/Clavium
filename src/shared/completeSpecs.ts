// What the terminal suggestions know about common commands: subcommands, options and what kind
// of argument comes next. Plain data, no code runs from here.

/** Lists that are asked from the server when they are needed. */
export const DYNAMIC_KINDS = ['git-branch', 'git-remote', 'systemd-unit', 'docker-container', 'docker-image', 'ssh-host', 'process', 'user', 'interface'] as const
export type DynamicKind = (typeof DYNAMIC_KINDS)[number]

/** `path`: files and folders, `dir`: folders only, `command`: a program, an array: fixed values. */
export type ArgSource = 'path' | 'dir' | 'command' | DynamicKind | readonly string[]

export interface CommandSpec {
  /** one line shown next to the name */
  d?: string
  sub?: Record<string, CommandSpec>
  opts?: Record<string, string>
  /** what the arguments are; left out: files and folders. An empty list: nothing to suggest. */
  args?: readonly ArgSource[]
}

const SIGNALS = ['-HUP', '-INT', '-TERM', '-KILL', '-USR1', '-USR2', '-STOP', '-CONT', '-9', '-15'] as const
const PATHS: readonly ArgSource[] = ['path']
const NONE: readonly ArgSource[] = []

const unit = (d: string): CommandSpec => ({ d, args: ['systemd-unit'] })
const container = (d: string, opts?: Record<string, string>): CommandSpec => ({ d, args: ['docker-container'], opts })
const branch = (d: string, opts?: Record<string, string>): CommandSpec => ({ d, args: ['git-branch'], opts })
const leaf = (d: string, opts?: Record<string, string>, args: readonly ArgSource[] = NONE): CommandSpec => ({ d, opts, args })

const APT: CommandSpec = {
  d: 'Package manager',
  sub: {
    update: leaf('Refresh the package lists'),
    upgrade: leaf('Install available updates', { '-y': 'Answer yes to all questions' }),
    'full-upgrade': leaf('Update, removing packages if needed', { '-y': 'Answer yes to all questions' }),
    install: leaf('Install packages', { '-y': 'Answer yes to all questions', '--no-install-recommends': 'Skip recommended packages', '--reinstall': 'Install again' }),
    remove: leaf('Remove packages', { '-y': 'Answer yes to all questions', '--purge': 'Also remove configuration files' }),
    purge: leaf('Remove packages and their configuration', { '-y': 'Answer yes to all questions' }),
    autoremove: leaf('Remove packages nobody needs any more', { '-y': 'Answer yes to all questions' }),
    search: leaf('Search in package descriptions'),
    show: leaf('Show details of a package'),
    list: leaf('List packages', { '--installed': 'Only installed packages', '--upgradable': 'Only packages with updates' }),
    clean: leaf('Delete downloaded package files')
  }
}

const DNF: CommandSpec = {
  d: 'Package manager',
  sub: {
    install: leaf('Install packages', { '-y': 'Answer yes to all questions' }),
    remove: leaf('Remove packages', { '-y': 'Answer yes to all questions' }),
    update: leaf('Install available updates', { '-y': 'Answer yes to all questions' }),
    upgrade: leaf('Install available updates', { '-y': 'Answer yes to all questions' }),
    search: leaf('Search for packages'),
    info: leaf('Show details of a package'),
    list: leaf('List packages', { '--installed': 'Only installed packages' }),
    'check-update': leaf('Look for updates'),
    autoremove: leaf('Remove packages nobody needs any more'),
    clean: leaf('Delete cached data', undefined, [['all', 'packages', 'metadata']])
  }
}

const COMPOSE: CommandSpec = {
  d: 'Run applications made of several containers',
  opts: { '-f': 'Compose file', '-p': 'Project name' },
  sub: {
    up: leaf('Create and start', { '-d': 'Run in the background', '--build': 'Build images first', '--force-recreate': 'Create containers again', '--remove-orphans': 'Remove containers of removed services' }),
    down: leaf('Stop and remove', { '-v': 'Also remove volumes', '--remove-orphans': 'Remove containers of removed services' }),
    ps: leaf('List containers', { '-a': 'Include stopped ones' }),
    logs: leaf('Show output', { '-f': 'Follow', '--tail': 'Number of lines from the end', '-t': 'Show timestamps' }),
    pull: leaf('Download images'),
    build: leaf('Build images', { '--no-cache': 'Do not use the cache', '--pull': 'Always download base images' }),
    restart: leaf('Restart services'),
    start: leaf('Start services'),
    stop: leaf('Stop services'),
    exec: leaf('Run a command in a service', { '-T': 'No terminal', '-u': 'User' }),
    run: leaf('Run a one-off command', { '--rm': 'Remove the container afterwards' }),
    config: leaf('Check and show the configuration'),
    top: leaf('Show running processes'),
    images: leaf('List images')
  }
}

const PKG_SCRIPTS: CommandSpec = {
  d: 'JavaScript package manager',
  sub: {
    install: leaf('Install dependencies', { '--save-dev': 'As a development dependency', '-g': 'For the whole system', '--production': 'Without development dependencies' }),
    ci: leaf('Install exactly what the lockfile says'),
    run: leaf('Run a script of package.json'),
    start: leaf('Run the start script'),
    test: leaf('Run the test script'),
    build: leaf('Run the build script'),
    update: leaf('Update dependencies'),
    uninstall: leaf('Remove a dependency'),
    outdated: leaf('List outdated dependencies'),
    audit: leaf('Check for known vulnerabilities', undefined, [['fix']]),
    init: leaf('Create a package.json', { '-y': 'Accept the defaults' }),
    list: leaf('List installed packages', { '-g': 'For the whole system', '--depth': 'How deep to show' }),
    link: leaf('Link a local package'),
    publish: leaf('Publish the package'),
    version: leaf('Raise the version', undefined, [['patch', 'minor', 'major']]),
    cache: leaf('Work with the cache', undefined, [['clean', 'verify']])
  }
}

export const SPECS: Record<string, CommandSpec> = {
  // ---- files -----------------------------------------------------------
  ls: { d: 'List a folder', opts: { '-l': 'Long format', '-a': 'Include hidden files', '-la': 'Long format with hidden files', '-lh': 'Long format, readable sizes', '-lah': 'Everything, readable sizes', '-t': 'Newest first', '-r': 'Reverse order', '-R': 'Include subfolders', '-S': 'Largest first', '-d': 'Folders themselves, not their contents', '-1': 'One name per line' } },
  cd: { d: 'Change the folder', args: ['dir'] },
  pwd: leaf('Show the current folder'),
  cat: { d: 'Print files', opts: { '-n': 'Number the lines', '-A': 'Show invisible characters' } },
  less: { d: 'Read a file page by page', opts: { '-N': 'Show line numbers', '-S': 'Do not wrap long lines', '+F': 'Follow like tail -f' } },
  head: { d: 'First lines of a file', opts: { '-n': 'Number of lines', '-c': 'Number of bytes' } },
  tail: { d: 'Last lines of a file', opts: { '-f': 'Follow the file', '-F': 'Follow, also after rotation', '-n': 'Number of lines' } },
  cp: { d: 'Copy', opts: { '-r': 'Copy folders with contents', '-a': 'Keep everything (archive)', '-i': 'Ask before overwriting', '-v': 'Say what is done', '-p': 'Keep times and permissions', '-u': 'Only newer files' } },
  mv: { d: 'Move or rename', opts: { '-i': 'Ask before overwriting', '-v': 'Say what is done', '-n': 'Never overwrite' } },
  rm: { d: 'Delete', opts: { '-r': 'Delete folders with contents', '-f': 'Never ask', '-rf': 'Folders with contents, never ask', '-i': 'Ask for every file', '-v': 'Say what is done' } },
  mkdir: { d: 'Create a folder', opts: { '-p': 'Create parent folders too', '-m': 'Permissions' }, args: ['dir'] },
  rmdir: { d: 'Remove an empty folder', args: ['dir'] },
  touch: { d: 'Create a file or update its time' },
  ln: { d: 'Create a link', opts: { '-s': 'Symbolic link', '-f': 'Replace an existing link', '-sf': 'Symbolic, replace existing' } },
  chmod: { d: 'Change permissions', opts: { '-R': 'Include subfolders', '+x': 'Make executable', '644': 'Owner writes, all read', '755': 'Owner writes, all read and run', '600': 'Owner only', '700': 'Owner only, with run' } },
  chown: { d: 'Change the owner', opts: { '-R': 'Include subfolders' }, args: ['user', 'path'] },
  find: { d: 'Search for files', opts: { '-name': 'Name pattern', '-iname': 'Name pattern, any case', '-type': 'f for files, d for folders', '-size': 'Size, e.g. +100M', '-mtime': 'Changed n days ago', '-maxdepth': 'How deep to look', '-exec': 'Run a command per hit', '-delete': 'Delete the hits', '-newer': 'Newer than a file', '-user': 'Owned by a user', '-empty': 'Empty files and folders' } },
  grep: { d: 'Search in text', opts: { '-r': 'Include subfolders', '-i': 'Ignore case', '-n': 'Show line numbers', '-v': 'Lines that do not match', '-l': 'Only file names', '-c': 'Count the hits', '-E': 'Extended pattern', '-F': 'Plain text, no pattern', '-w': 'Whole words', '-A': 'Lines after a hit', '-B': 'Lines before a hit', '-C': 'Lines around a hit', '--include': 'Only files like this', '--exclude-dir': 'Skip folders like this', '--color': 'Highlight the hits' } },
  du: { d: 'Size of folders', opts: { '-h': 'Readable sizes', '-s': 'Only the total', '-sh': 'Readable total', '-a': 'Include files', '-d': 'How deep to show', '--max-depth': 'How deep to show' } },
  df: { d: 'Free disk space', opts: { '-h': 'Readable sizes', '-T': 'Show the file system type', '-i': 'Show inodes' } },
  tar: { d: 'Pack and unpack archives', opts: { '-czf': 'Create a .tar.gz', '-xzf': 'Unpack a .tar.gz', '-tzf': 'List a .tar.gz', '-cjf': 'Create a .tar.bz2', '-xjf': 'Unpack a .tar.bz2', '-cJf': 'Create a .tar.xz', '-xJf': 'Unpack a .tar.xz', '-xf': 'Unpack any archive', '-tf': 'List any archive', '-C': 'Unpack into this folder', '-v': 'Say what is done', '--exclude': 'Skip files like this' } },
  zip: { d: 'Create a zip archive', opts: { '-r': 'Include subfolders', '-e': 'Protect with a password', '-q': 'Quiet' } },
  unzip: { d: 'Unpack a zip archive', opts: { '-l': 'Only list the contents', '-d': 'Unpack into this folder', '-o': 'Overwrite without asking', '-q': 'Quiet' } },
  gzip: { d: 'Compress a file', opts: { '-d': 'Decompress', '-k': 'Keep the original', '-9': 'Best compression' } },
  gunzip: { d: 'Decompress a file', opts: { '-k': 'Keep the original' } },
  wc: { d: 'Count lines, words and bytes', opts: { '-l': 'Lines', '-w': 'Words', '-c': 'Bytes' } },
  sort: { d: 'Sort lines', opts: { '-n': 'By number', '-r': 'Reverse', '-u': 'Without duplicates', '-k': 'By column', '-h': 'By readable size' } },
  diff: { d: 'Compare files', opts: { '-u': 'Unified format', '-r': 'Include subfolders', '-q': 'Only say whether they differ', '-w': 'Ignore white space' } },
  stat: { d: 'Details of a file' },
  file: { d: 'Guess the type of a file' },
  nano: { d: 'Simple text editor' },
  vim: { d: 'Text editor' },
  vi: { d: 'Text editor' },
  source: { d: 'Run a script in this shell' },
  bash: { d: 'Run a shell script', opts: { '-c': 'Run a command', '-x': 'Print every command', '-e': 'Stop at the first error' } },
  sh: { d: 'Run a shell script', opts: { '-c': 'Run a command' } },
  python3: { d: 'Python', opts: { '-m': 'Run a module', '-c': 'Run a command', '-V': 'Show the version' } },
  python: { d: 'Python', opts: { '-m': 'Run a module', '-c': 'Run a command', '-V': 'Show the version' } },
  node: { d: 'Node.js', opts: { '-e': 'Run a script given as text', '-v': 'Show the version', '--inspect': 'Allow a debugger' } },
  rsync: { d: 'Copy and synchronise', opts: { '-a': 'Keep everything (archive)', '-v': 'Say what is done', '-z': 'Compress on the way', '-avz': 'Archive, verbose, compressed', '-n': 'Only show what would happen', '--delete': 'Delete what is gone at the source', '--progress': 'Show progress', '-P': 'Progress, resume partial files', '--exclude': 'Skip files like this', '-e': 'Remote shell to use' } },
  scp: { d: 'Copy over SSH', opts: { '-r': 'Include subfolders', '-P': 'Port', '-i': 'Key file', '-p': 'Keep times and permissions' } },

  // ---- system ----------------------------------------------------------
  sudo: { d: 'Run as administrator', opts: { '-u': 'As this user', '-i': 'Login shell', '-s': 'Shell', '-E': 'Keep the environment', '-l': 'List what is allowed' }, args: ['command'] },
  su: { d: 'Become another user', opts: { '-': 'With a login shell', '-c': 'Run one command' }, args: ['user'] },
  man: { d: 'Read the manual of a command', args: ['command'] },
  which: { d: 'Where a command lives', args: ['command'] },
  ps: { d: 'List processes', opts: { aux: 'All processes, with details', '-ef': 'All processes, full format', '-u': 'Of a user', '--forest': 'Show as a tree', '-o': 'Columns to show' }, args: NONE },
  top: leaf('Live view of processes', { '-u': 'Of a user', '-p': 'Only this process id' }),
  htop: leaf('Live view of processes', { '-u': 'Of a user' }),
  kill: { d: 'Send a signal to a process', opts: Object.fromEntries(SIGNALS.map((s) => [s, 'Signal'])), args: NONE },
  killall: { d: 'Send a signal by program name', opts: Object.fromEntries(SIGNALS.map((s) => [s, 'Signal'])), args: ['process'] },
  pkill: { d: 'Send a signal by pattern', opts: { '-f': 'Match the whole command line', '-u': 'Of a user', '-9': 'Kill' }, args: ['process'] },
  pgrep: { d: 'Find processes by pattern', opts: { '-f': 'Match the whole command line', '-l': 'Show the names', '-u': 'Of a user' }, args: ['process'] },
  free: leaf('Memory in use', { '-h': 'Readable sizes', '-m': 'In mebibytes' }),
  uptime: leaf('How long the system runs, and the load'),
  uname: leaf('System information', { '-a': 'Everything', '-r': 'Kernel version' }),
  hostnamectl: leaf('Name and system details', undefined, [['status', 'set-hostname']]),
  timedatectl: leaf('Time and time zone', undefined, [['status', 'set-timezone', 'list-timezones', 'set-ntp']]),
  reboot: leaf('Restart the server'),
  shutdown: leaf('Shut down or restart', { '-h': 'Halt', '-r': 'Restart', '-c': 'Cancel a planned shutdown', now: 'Immediately' }),
  crontab: { d: 'Scheduled commands', opts: { '-e': 'Edit', '-l': 'List', '-r': 'Remove all', '-u': 'Of a user' } },
  history: leaf('Commands typed before', { '-c': 'Clear' }),
  export: leaf('Set an environment variable'),
  env: leaf('Show the environment'),
  echo: leaf('Print text', { '-n': 'No line break at the end', '-e': 'Understand \\n and friends' }),
  clear: leaf('Clear the screen'),
  exit: leaf('End the session'),
  whoami: leaf('Who am I logged in as'),
  id: { d: 'User and group ids', args: ['user'] },
  passwd: { d: 'Change a password', args: ['user'] },
  useradd: { d: 'Create a user', opts: { '-m': 'With a home folder', '-s': 'Login shell', '-G': 'Additional groups', '-r': 'System account' }, args: NONE },
  usermod: { d: 'Change a user', opts: { '-aG': 'Add to groups', '-s': 'Login shell', '-L': 'Lock', '-U': 'Unlock' }, args: ['user'] },
  userdel: { d: 'Delete a user', opts: { '-r': 'With the home folder' }, args: ['user'] },
  systemctl: {
    d: 'Control services',
    opts: { '--user': 'Services of the user', '--now': 'Also start or stop now', '--no-pager': 'Do not page the output', '--failed': 'Only failed units' },
    sub: {
      status: unit('Show the state'),
      start: unit('Start'),
      stop: unit('Stop'),
      restart: unit('Restart'),
      reload: unit('Load the configuration again'),
      enable: unit('Start at boot'),
      disable: unit('Do not start at boot'),
      'is-active': unit('Whether it runs'),
      'is-enabled': unit('Whether it starts at boot'),
      mask: unit('Make it impossible to start'),
      unmask: unit('Allow starting again'),
      cat: unit('Show the unit file'),
      edit: unit('Edit an override'),
      show: unit('Show all properties'),
      'daemon-reload': leaf('Read changed unit files'),
      'list-units': leaf('List loaded units', { '--type': 'Kind of unit', '--state': 'Only this state', '--all': 'Include inactive ones' }),
      'list-unit-files': leaf('List installed units', { '--type': 'Kind of unit', '--state': 'Only this state' }),
      'list-timers': leaf('List timers', { '--all': 'Include inactive ones' }),
      'reset-failed': unit('Forget a failure'),
      reboot: leaf('Restart the server'),
      poweroff: leaf('Switch the server off')
    }
  },
  service: { d: 'Control a service (old style)', args: ['systemd-unit', ['start', 'stop', 'restart', 'reload', 'status']] },
  journalctl: { d: 'Read the system log', opts: { '-u': 'Of a unit', '-f': 'Follow', '-n': 'Number of lines', '-e': 'Jump to the end', '-x': 'With explanations', '-b': 'Since the last boot', '-k': 'Kernel messages', '-p': 'Priority, e.g. err', '--since': 'From a time, e.g. "1 hour ago"', '--until': 'Up to a time', '--no-pager': 'Do not page the output', '-r': 'Newest first', '--disk-usage': 'Space the log uses', '--vacuum-time': 'Delete entries older than this' }, args: ['systemd-unit'] },
  apt: APT,
  'apt-get': APT,
  dnf: DNF,
  yum: DNF,
  dpkg: { d: 'Low level package tool', opts: { '-i': 'Install a .deb file', '-l': 'List installed packages', '-L': 'Files of a package', '-S': 'Which package owns a file', '-r': 'Remove', '--configure': 'Finish an installation' } },
  snap: { d: 'Snap packages', sub: { install: leaf('Install'), remove: leaf('Remove'), list: leaf('List installed snaps'), refresh: leaf('Update'), find: leaf('Search'), info: leaf('Show details') } },
  mount: { d: 'Attach a file system', opts: { '-a': 'Everything in fstab', '-o': 'Options', '-t': 'File system type' } },
  umount: { d: 'Detach a file system', opts: { '-l': 'As soon as it is free', '-f': 'Force' } },
  lsblk: leaf('List disks and partitions', { '-f': 'With file systems' }),

  // ---- network ---------------------------------------------------------
  ssh: { d: 'Log in to another server', opts: { '-p': 'Port', '-i': 'Key file', '-L': 'Forward a local port', '-R': 'Forward a remote port', '-D': 'SOCKS proxy', '-J': 'Jump host', '-A': 'Forward the agent', '-v': 'Verbose', '-N': 'No command, only forwarding', '-t': 'Force a terminal' }, args: ['ssh-host'] },
  'ssh-keygen': leaf('Create SSH keys', { '-t': 'Type, e.g. ed25519', '-C': 'Comment', '-f': 'File', '-b': 'Bits', '-R': 'Remove a host from known_hosts', '-l': 'Show the fingerprint' }, PATHS),
  'ssh-copy-id': { d: 'Install your key on a server', opts: { '-i': 'Key file', '-p': 'Port' }, args: ['ssh-host'] },
  curl: { d: 'Transfer data from a URL', opts: { '-o': 'Write to this file', '-O': 'Keep the remote file name', '-L': 'Follow redirects', '-I': 'Only the headers', '-s': 'Silent', '-S': 'Show errors when silent', '-f': 'Fail on HTTP errors', '-fsSL': 'Quiet, fail on errors, follow redirects', '-X': 'Request method', '-H': 'Header', '-d': 'Data to send', '-u': 'User and password', '-k': 'Skip certificate checks', '-v': 'Verbose', '--max-time': 'Give up after seconds' } },
  wget: { d: 'Download files', opts: { '-O': 'Write to this file', '-q': 'Quiet', '-c': 'Continue a partial download', '-r': 'Recursive', '-P': 'Save into this folder', '--no-check-certificate': 'Skip certificate checks' } },
  ping: leaf('Test whether a host answers', { '-c': 'Number of packets', '-i': 'Seconds between packets', '-4': 'IPv4 only', '-6': 'IPv6 only' }, ['ssh-host']),
  ip: {
    d: 'Network configuration',
    opts: { '-4': 'IPv4 only', '-6': 'IPv6 only', '-br': 'Brief', '-c': 'With colours' },
    sub: {
      addr: leaf('Addresses', undefined, [['show', 'add', 'del']]),
      a: leaf('Addresses'),
      link: leaf('Interfaces', undefined, [['show', 'set']]),
      route: leaf('Routes', undefined, [['show', 'add', 'del', 'get']]),
      r: leaf('Routes'),
      neigh: leaf('Neighbours (ARP)')
    }
  },
  ss: leaf('Sockets and open ports', { '-tulpn': 'Listening ports with programs', '-t': 'TCP', '-u': 'UDP', '-l': 'Listening', '-p': 'Show the program', '-n': 'Numbers, no names' }),
  netstat: leaf('Network connections', { '-tulpn': 'Listening ports with programs' }),
  dig: leaf('Ask the DNS', { '+short': 'Only the answer', '-x': 'Reverse lookup' }, [['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME']]),
  nslookup: leaf('Ask the DNS'),
  traceroute: leaf('Show the way to a host'),
  ufw: {
    d: 'Firewall',
    sub: {
      status: leaf('Show the rules', undefined, [['verbose', 'numbered']]),
      enable: leaf('Switch on'),
      disable: leaf('Switch off'),
      allow: leaf('Allow a port or service'),
      deny: leaf('Block a port or service'),
      delete: leaf('Remove a rule'),
      reload: leaf('Load the rules again'),
      reset: leaf('Remove all rules')
    }
  },
  nginx: leaf('Web server', { '-t': 'Test the configuration', '-s': 'Send a signal: reload, stop, quit, reopen', '-T': 'Test and print the configuration', '-v': 'Show the version' }),
  certbot: { d: 'TLS certificates', sub: { certonly: leaf('Only obtain a certificate'), renew: leaf('Renew certificates', { '--dry-run': 'Only test' }), certificates: leaf('List certificates'), delete: leaf('Delete a certificate') }, opts: { '--nginx': 'Configure nginx', '--apache': 'Configure Apache', '-d': 'Domain' } },

  // ---- development -----------------------------------------------------
  git: {
    d: 'Version control',
    opts: { '-C': 'Run in this folder', '--version': 'Show the version' },
    sub: {
      status: leaf('What changed', { '-s': 'Short', '-b': 'Show the branch' }),
      add: leaf('Stage changes', { '-A': 'Everything', '-p': 'Choose parts', '-u': 'Only tracked files' }, PATHS),
      commit: leaf('Record staged changes', { '-m': 'Message', '-a': 'Stage tracked files first', '-am': 'Stage tracked files, with message', '--amend': 'Change the last commit', '--no-edit': 'Keep the message' }),
      push: { d: 'Send commits', opts: { '-u': 'Remember the upstream', '--tags': 'Also send tags', '--force-with-lease': 'Overwrite, unless someone else pushed', '--dry-run': 'Only show what would happen' }, args: ['git-remote', 'git-branch'] },
      pull: { d: 'Fetch and integrate', opts: { '--rebase': 'Rebase instead of merge', '--ff-only': 'Only fast-forward' }, args: ['git-remote', 'git-branch'] },
      fetch: { d: 'Download commits', opts: { '--all': 'From all remotes', '--prune': 'Forget deleted branches', '--tags': 'Also tags' }, args: ['git-remote'] },
      checkout: branch('Switch branches or restore files', { '-b': 'Create a branch', '--': 'What follows are files' }),
      switch: branch('Switch branches', { '-c': 'Create a branch', '-': 'Back to the previous branch' }),
      branch: branch('List, create or delete branches', { '-a': 'Include remote branches', '-d': 'Delete', '-D': 'Delete, even unmerged', '-m': 'Rename', '-v': 'With the last commit' }),
      merge: branch('Join a branch into this one', { '--no-ff': 'Always create a merge commit', '--abort': 'Give up the merge', '--squash': 'As one change' }),
      rebase: branch('Replay commits onto another base', { '--continue': 'Go on after a conflict', '--abort': 'Give up', '--onto': 'New base' }),
      log: branch('Show the history', { '--oneline': 'One line per commit', '--graph': 'Draw the branches', '-n': 'Number of commits', '-p': 'With changes', '--stat': 'With changed files', '--all': 'All branches' }),
      diff: { d: 'Show changes', opts: { '--staged': 'What is staged', '--stat': 'Only a summary', '--name-only': 'Only file names' }, args: ['git-branch', 'path'] },
      show: branch('Show a commit'),
      stash: leaf('Put changes aside', undefined, [['push', 'pop', 'list', 'apply', 'drop', 'show']]),
      reset: branch('Move the branch, unstage changes', { '--hard': 'Discard all changes', '--soft': 'Keep changes staged', 'HEAD~1': 'One commit back' }),
      restore: leaf('Discard changes in files', { '--staged': 'Unstage', '--source': 'Take from this commit' }, PATHS),
      rm: leaf('Remove files', { '--cached': 'Only stop tracking', '-r': 'Folders with contents' }, PATHS),
      mv: leaf('Move or rename files', undefined, PATHS),
      clone: leaf('Copy a repository', { '--depth': 'Only the newest commits', '--branch': 'Check out this branch' }),
      init: leaf('Create a repository'),
      remote: { d: 'Manage remotes', opts: { '-v': 'With addresses' }, args: [['add', 'remove', 'rename', 'set-url', 'show', 'prune'], 'git-remote'] },
      tag: leaf('List or create tags', { '-a': 'Annotated tag', '-d': 'Delete', '-l': 'List', '-m': 'Message' }),
      'cherry-pick': branch('Apply a commit here', { '--continue': 'Go on after a conflict', '--abort': 'Give up' }),
      revert: leaf('Undo a commit with a new commit'),
      clean: leaf('Delete untracked files', { '-n': 'Only show what would happen', '-fd': 'Files and folders', '-x': 'Also ignored files' }),
      blame: leaf('Who changed which line', undefined, PATHS),
      config: leaf('Read and change settings', { '--global': 'For this user', '--list': 'Show all' }, [['user.name', 'user.email', 'core.editor', 'pull.rebase', 'init.defaultBranch']]),
      worktree: leaf('Several working folders', undefined, [['add', 'list', 'remove', 'prune']]),
      bisect: leaf('Find the commit that broke something', undefined, [['start', 'good', 'bad', 'reset']])
    }
  },
  docker: {
    d: 'Containers',
    sub: {
      ps: leaf('List containers', { '-a': 'Include stopped ones', '-q': 'Only ids', '--format': 'Columns to show' }),
      images: leaf('List images', { '-a': 'Include intermediate ones', '-q': 'Only ids' }),
      run: { d: 'Create and start a container', opts: { '-d': 'Run in the background', '-it': 'Interactive, with a terminal', '--rm': 'Remove when it ends', '--name': 'Name', '-p': 'Publish a port, host:container', '-v': 'Mount, host:container', '-e': 'Environment variable', '--restart': 'Restart policy', '--network': 'Network', '--env-file': 'File with variables' }, args: ['docker-image'] },
      exec: container('Run a command in a container', { '-it': 'Interactive, with a terminal', '-u': 'User', '-w': 'Working folder', '-e': 'Environment variable' }),
      logs: container('Show the output', { '-f': 'Follow', '--tail': 'Number of lines from the end', '-t': 'Show timestamps', '--since': 'From a time, e.g. 10m' }),
      start: container('Start'),
      stop: container('Stop'),
      restart: container('Restart'),
      rm: container('Remove a container', { '-f': 'Even when running', '-v': 'With its volumes' }),
      rmi: { d: 'Remove an image', opts: { '-f': 'Force' }, args: ['docker-image'] },
      inspect: container('Show all details'),
      stats: container('Live use of resources', { '--no-stream': 'Only once' }),
      top: container('Processes of a container'),
      kill: container('Kill a container'),
      pull: { d: 'Download an image', args: ['docker-image'] },
      push: { d: 'Upload an image', args: ['docker-image'] },
      build: leaf('Build an image', { '-t': 'Name and tag', '-f': 'Dockerfile', '--no-cache': 'Do not use the cache', '--pull': 'Always download the base image' }, ['dir']),
      tag: { d: 'Give an image another name', args: ['docker-image'] },
      cp: container('Copy files from or to a container'),
      compose: COMPOSE,
      network: leaf('Networks', undefined, [['ls', 'create', 'rm', 'inspect', 'connect', 'disconnect', 'prune']]),
      volume: leaf('Volumes', undefined, [['ls', 'create', 'rm', 'inspect', 'prune']]),
      system: leaf('The whole installation', { '-a': 'Also unused images', '--volumes': 'Also volumes' }, [['df', 'prune', 'info']]),
      login: leaf('Log in to a registry'),
      info: leaf('Details of the installation'),
      version: leaf('Show the version')
    }
  },
  'docker-compose': COMPOSE,
  npm: PKG_SCRIPTS,
  pnpm: PKG_SCRIPTS,
  yarn: PKG_SCRIPTS,
  npx: { d: 'Run a package without installing it', args: NONE },
  pip: { d: 'Python packages', sub: { install: leaf('Install', { '-r': 'From a requirements file', '-U': 'Upgrade', '--user': 'For this user only', '-e': 'Editable, from a folder' }, PATHS), uninstall: leaf('Remove', { '-y': 'Do not ask' }), list: leaf('List installed packages', { '--outdated': 'Only outdated ones' }), freeze: leaf('Print installed packages as requirements'), show: leaf('Show details') } },
  pip3: { d: 'Python packages', sub: { install: leaf('Install', { '-r': 'From a requirements file', '-U': 'Upgrade' }, PATHS), uninstall: leaf('Remove'), list: leaf('List installed packages'), freeze: leaf('Print installed packages as requirements'), show: leaf('Show details') } },
  make: { d: 'Build with a Makefile', opts: { '-j': 'Jobs at the same time', '-C': 'Run in this folder', '-f': 'Makefile', '-n': 'Only show what would happen' }, args: NONE },
  pm2: { d: 'Process manager for Node.js', sub: { start: leaf('Start an app', { '--name': 'Name', '-i': 'Number of instances' }, PATHS), stop: leaf('Stop'), restart: leaf('Restart'), reload: leaf('Restart without downtime'), delete: leaf('Remove'), list: leaf('List apps'), logs: leaf('Show output', { '--lines': 'Number of lines' }), monit: leaf('Live view'), save: leaf('Remember the running apps'), startup: leaf('Start at boot') } },
  kubectl: {
    d: 'Kubernetes',
    opts: { '-n': 'Namespace', '-A': 'All namespaces', '-o': 'Output format: wide, yaml, json', '--context': 'Cluster context' },
    sub: {
      get: leaf('List resources', { '-w': 'Watch', '-l': 'Label selector' }, [['pods', 'deployments', 'services', 'nodes', 'namespaces', 'ingress', 'configmaps', 'secrets', 'jobs', 'cronjobs', 'statefulsets', 'daemonsets', 'pv', 'pvc', 'events', 'all']]),
      describe: leaf('Details of a resource', undefined, [['pod', 'deployment', 'service', 'node', 'ingress', 'job']]),
      logs: leaf('Output of a pod', { '-f': 'Follow', '--tail': 'Number of lines from the end', '-c': 'Container', '-p': 'Previous instance' }),
      apply: leaf('Apply a configuration', { '-f': 'File or folder', '-k': 'Kustomize folder', '--dry-run': 'Only test' }, PATHS),
      delete: leaf('Delete resources', { '-f': 'File or folder' }, [['pod', 'deployment', 'service', 'job', 'ingress']]),
      exec: leaf('Run a command in a pod', { '-it': 'Interactive, with a terminal', '-c': 'Container' }),
      rollout: leaf('Manage a rollout', undefined, [['status', 'restart', 'undo', 'history']]),
      scale: leaf('Change the number of replicas', { '--replicas': 'Number' }),
      'port-forward': leaf('Forward a local port to a pod'),
      top: leaf('Use of resources', undefined, [['pods', 'nodes']]),
      config: leaf('Contexts and clusters', undefined, [['get-contexts', 'use-context', 'current-context', 'view']])
    }
  },
  screen: leaf('Keep programs running', { '-S': 'Start with this name', '-r': 'Reattach', '-ls': 'List', '-x': 'Attach together with others', '-dmS': 'Start detached with this name' }),
  tmux: { d: 'Terminal multiplexer', sub: { new: leaf('New session', { '-s': 'Name' }), attach: leaf('Attach', { '-t': 'Session' }), ls: leaf('List sessions'), 'kill-session': leaf('End a session', { '-t': 'Session' }) } },
  mysql: leaf('MySQL client', { '-u': 'User', '-p': 'Ask for the password', '-h': 'Host', '-P': 'Port', '-e': 'Run a statement' }),
  psql: leaf('PostgreSQL client', { '-U': 'User', '-h': 'Host', '-p': 'Port', '-d': 'Database', '-c': 'Run a statement', '-l': 'List databases' }),
  watch: { d: 'Run a command again and again', opts: { '-n': 'Seconds between runs', '-d': 'Highlight changes' }, args: ['command'] },
  xargs: { d: 'Build commands from input', opts: { '-n': 'Arguments per command', '-I': 'Placeholder', '-0': 'Input is separated by NUL', '-P': 'Commands at the same time' }, args: ['command'] },
  nohup: { d: 'Keep running after logout', args: ['command'] },
  time: { d: 'Measure how long a command takes', args: ['command'] }
}

/** Shell builtins: they are not files in PATH, so the server does not list them. */
export const BUILTINS = ['cd', 'echo', 'exit', 'export', 'alias', 'unalias', 'source', 'history', 'pwd', 'set', 'unset', 'type', 'fg', 'bg', 'jobs', 'wait', 'exec', 'umask', 'ulimit', 'read', 'test', 'true', 'false']

/** After these the next word is again a command. */
export const PREFIX_COMMANDS = new Set(['sudo', 'doas', 'nohup', 'time', 'exec', 'command', 'builtin', 'watch', 'xargs', 'nice', 'env'])

/** Options of those commands that are followed by a value ("sudo -u user"), by their letter. */
export const PREFIX_VALUE_OPTIONS: Record<string, string> = { sudo: 'ughpCTrtDR', doas: 'uC', nice: 'n', watch: 'n', xargs: 'nIPLsdE', env: 'uCS', time: 'fo' }
