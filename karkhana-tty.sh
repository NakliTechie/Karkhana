# Karkhana guest terminal size: apply the page terminal's size to the shell's pty.
#
# QEMU's serial console carries no window size, so the container pty starts at
# 0x0 and readline falls back to 80 columns. A longer command line then wraps
# back over its own row in the wider page terminal. The page writes
# "rows R cols C" to $KARKHANA_TTY_ROOT/size before boot and on every xterm
# resize. /pack/info sets PROMPT_COMMAND to source this file at the first prompt.
#
# Sourced: apply the size before the prompt prints, then keep a per-prompt check
# that also restarts the watcher if it is gone. Executed as
# `karkhana-tty.sh watch OWNER_PID TTY`: re-apply the size within a second of a
# change until OWNER_PID exits. A size change makes the kernel send SIGWINCH to
# the foreground job, so readline and full-screen programs redraw.
#
# Plain bash 3.2+. The watcher forks nothing per tick: one 9p read per second.

__karkhana_tty_root=${KARKHANA_TTY_ROOT:-/persist/.karkhana-tty}

# Apply the staged size to tty $1 when it differs from the last applied size.
__karkhana_tty_apply() {
  local size
  { read -r size < "$__karkhana_tty_root/size"; } 2>/dev/null || return 0
  [[ $size =~ ^rows\ [1-9][0-9]{0,3}\ cols\ [1-9][0-9]{0,3}$ ]] || return 0
  [[ $size == "$__karkhana_tty_applied" ]] && return 0
  # Word splitting of $size is the stty argument list.
  stty $size < "$1" 2>/dev/null && __karkhana_tty_applied=$size
}

if [[ ${BASH_SOURCE[0]} != "$0" ]]; then
  __karkhana_tty_self=${BASH_SOURCE[0]}
  # The watcher records its pid here; the path is keyed by this shell's pid.
  __karkhana_tty_lock=${TMPDIR:-/tmp}/.karkhana-tty.$$
  __karkhana_tty_dev=$(tty 2>/dev/null) || __karkhana_tty_dev=

  __karkhana_tty_prompt() {
    [[ -n $__karkhana_tty_dev ]] || return 0
    __karkhana_tty_apply "$__karkhana_tty_dev"
    local pid=
    { read -r pid < "$__karkhana_tty_lock"; } 2>/dev/null
    [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null && return 0
    # `set -m` gives the watcher its own process group, so a Ctrl-C at the
    # prompt cannot reach it. The subshell keeps bash from announcing a job.
    ( set -m; "$BASH" "$__karkhana_tty_self" watch "$$" "$__karkhana_tty_dev" \
        </dev/null >/dev/null 2>&1 & )
  }

  # Nested shells and child programs must not inherit a hook they cannot run.
  PROMPT_COMMAND=__karkhana_tty_prompt
  export -n PROMPT_COMMAND
  __karkhana_tty_prompt
  return 0
fi

[[ $1 == watch && -n $2 && -n $3 ]] || { echo "usage: $0 watch OWNER_PID TTY" >&2; exit 2; }
owner=$2
dev=$3
lock=${TMPDIR:-/tmp}/.karkhana-tty.$owner
# Ignoring SIGTTOU lets stty change the pty from a background process group.
trap '' INT QUIT TSTP TTIN TTOU HUP

# One watcher per shell. The link publishes the lock with its pid in one step.
echo $$ > "$lock.$$" || exit 1
if ! ln "$lock.$$" "$lock" 2>/dev/null; then
  other=
  { read -r other < "$lock"; } 2>/dev/null
  if [[ -n $other ]] && kill -0 "$other" 2>/dev/null; then
    rm -f "$lock.$$"
    exit 0
  fi
  mv -f "$lock.$$" "$lock" || exit 1
fi
rm -f "$lock.$$"
trap 'other=; { read -r other < "$lock"; } 2>/dev/null; [[ $other == $$ ]] && rm -f "$lock"' EXIT

# A FIFO opened read-write never sees EOF, so `read -t` sleeps without a fork.
fifo=$lock.fifo.$$
mkfifo -m 600 "$fifo" || exit 1
exec 3<>"$fifo" || exit 1
rm -f "$fifo"
while kill -0 "$owner" 2>/dev/null; do
  __karkhana_tty_apply "$dev"
  read -r -t 1 -u 3 _
done
