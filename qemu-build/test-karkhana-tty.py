#!/usr/bin/env python3
"""Guest terminal-size hook on a real pty; no browser, VM, or network.

Drives an interactive bash through the same PROMPT_COMMAND the page puts in
/pack/info, and reads the pty size from the master side with TIOCGWINSZ.
KARKHANA_TTY_BASH picks the shell (the guest ships bash 5.2). To run under the
guest's own userland:
  docker run --rm --init -v "$PWD:/w" karkhana-debian:amd64 python3 /w/qemu-build/test-karkhana-tty.py
"""
import fcntl
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time
import unittest

SCRIPT = Path(os.environ.get('KARKHANA_TTY_SCRIPT', Path(__file__).parent / 'guest' / 'karkhana-tty.sh'))
BASH = os.environ.get('KARKHANA_TTY_BASH', 'bash')
PROMPT = 'KKPROMPT> '
ESCAPES = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]')


def winsize(fd):
    rows, cols, _, _ = struct.unpack('HHHH', fcntl.ioctl(fd, termios.TIOCGWINSZ, b'\0' * 8))
    return rows, cols


def watchers(owner):
    """Pids of live watcher processes serving shell `owner`."""
    ps = subprocess.run(['ps', '-A', '-o', 'pid=,stat=,command='], capture_output=True, text=True, check=True)
    found = set()
    for line in ps.stdout.splitlines():
        fields = line.split(None, 2)
        # A process caught mid-exec can list an empty command.
        if len(fields) == 3 and f'karkhana-tty.sh watch {owner} ' in fields[2] and not fields[1].startswith('Z'):
            found.add(int(fields[0]))
    return found


class Shell:
    """Interactive bash on a fresh pty whose size starts at 0x0, as in the guest."""

    def __init__(self, root):
        self.root = root
        (root / 'inputrc').write_text('set enable-bracketed-paste off\n')
        env = {
            'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
            'HOME': str(root), 'TERM': 'xterm-256color', 'PS1': PROMPT,
            'KARKHANA_TTY_ROOT': str(root), 'TMPDIR': str(root), 'INPUTRC': str(root / 'inputrc'),
            'PROMPT_COMMAND': f'. {root}/karkhana-tty.sh',
        }
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.execvpe(BASH, [BASH, '--norc', '--noprofile', '-i'], env)
        self.out = ''

    def read_until(self, needle, timeout=10):
        deadline = time.monotonic() + timeout
        while needle not in self.out:
            left = deadline - time.monotonic()
            if left <= 0:
                raise AssertionError(f'timed out waiting for {needle!r}; output:\n{self.out}')
            ready, _, _ = select.select([self.fd], [], [], left)
            if ready:
                try:
                    chunk = os.read(self.fd, 4096)
                except OSError:
                    chunk = b''
                if not chunk:
                    raise AssertionError(f'shell exited before {needle!r}; output:\n{self.out}')
                self.out += chunk.decode(errors='replace')
        head, _, self.out = self.out.partition(needle)
        return head

    def run(self, command, timeout=10):
        marker = f'__done_{time.monotonic_ns()}__'
        # The echo splits the marker so the echoed command line cannot match it.
        split = f'{marker[:4]}""{marker[4:]}'
        os.write(self.fd, f'{command}; echo {split}\r'.encode())
        # Typeahead can be echoed twice (tty, then readline); take the last copy.
        head = self.read_until(marker + '\r\n', timeout).rsplit(split, 1)[-1]
        return ESCAPES.sub('', head).replace('\r', '')

    def send(self, data):
        os.write(self.fd, data)

    def wait_exit(self, timeout=10):
        """Exit status; keeps reading, since macOS holds an exit until output drains."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                return os.waitstatus_to_exitcode(status)
            if select.select([self.fd], [], [], 0.05)[0]:
                try:
                    os.read(self.fd, 4096)
                except OSError:
                    pass
        raise AssertionError('shell did not exit')

    def close(self):
        try:
            os.kill(self.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        # macOS can block closing a master whose slave has unread output.
        os.close(self.fd)
        os.waitpid(self.pid, 0)


def wait_for(predicate, timeout=5, message='condition'):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError(f'timed out waiting for {message}')
        time.sleep(0.05)


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


class PublishedCopy(unittest.TestCase):
    def test_published_script_matches_the_guest_source(self):
        published = Path(__file__).resolve().parent.parent / 'karkhana-tty.sh'
        source = Path(__file__).resolve().parent / 'guest' / 'karkhana-tty.sh'
        self.assertEqual(published.read_bytes(), source.read_bytes(),
                         'the page fetches the repo-root copy; it must match qemu-build/guest')


class GuestTtySize(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / 'karkhana-tty.sh').write_text(SCRIPT.read_text())
        self.shells = []

    def tearDown(self):
        for shell in self.shells:
            shell.close()
        self.tmp.cleanup()

    def stage(self, text):
        (self.root / 'size').write_text(text)

    def shell(self):
        shell = Shell(self.root)
        self.shells.append(shell)
        return shell

    def watcher(self, shell):
        """Pid recorded in the shell's lock file, after checking it is alive."""
        lock = self.root / f'.karkhana-tty.{shell.pid}'
        wait_for(lambda: lock.exists() and lock.read_text().strip(), message='watcher lock')
        pid = int(lock.read_text())
        self.assertTrue(alive(pid), 'the lock must name a live watcher')
        return pid

    def test_first_prompt_carries_the_staged_size_without_a_job_notice(self):
        self.stage('rows 49 cols 180\n')
        shell = self.shell()
        before = shell.read_until(PROMPT)
        self.assertEqual(winsize(shell.fd), (49, 180), 'size must be set before the first prompt prints')
        self.assertNotRegex(before, r'\[\d+\] \d+', 'starting the watcher must not announce a job')
        self.assertEqual(shell.run('stty size').strip(), '49 180')
        self.assertEqual(shell.run('echo "$COLUMNS"').strip(), '180')

    def test_watcher_applies_a_resize_while_the_shell_waits_at_the_prompt(self):
        self.stage('rows 49 cols 180\n')
        shell = self.shell()
        shell.read_until(PROMPT)
        self.stage('rows 30 cols 101\n')
        wait_for(lambda: winsize(shell.fd) == (30, 101), message='watcher resize at the prompt')
        self.assertEqual(shell.run('stty size').strip(), '30 101')

    def test_foreground_program_receives_sigwinch_with_the_new_size(self):
        self.stage('rows 49 cols 180\n')
        shell = self.shell()
        shell.read_until(PROMPT)
        shell.send(b"""bash -c 'trap "echo WINCH-\\$(stty size); exit" WINCH; echo READY; while :; do sleep 0.1; done'\r""")
        shell.read_until('READY\r\n')
        self.stage('rows 25 cols 90\n')
        shell.read_until('WINCH-25 90')

    def test_malformed_or_absent_sizes_leave_the_pty_unchanged(self):
        shell = self.shell()
        shell.read_until(PROMPT)
        self.assertEqual(winsize(shell.fd), (0, 0), 'absent size file must not change the pty')
        self.stage('rows 40 cols 120\n')
        wait_for(lambda: winsize(shell.fd) == (40, 120), message='first valid size')
        for bad in ['rows 0 cols 80\n', 'rows 40 cols\n', 'cols 80 rows 40\n', 'rows 40 cols 80; reboot\n', 'rows 99999 cols 80\n', '']:
            self.stage(bad)
            shell.run('true')
            time.sleep(1.2)
            self.assertEqual(winsize(shell.fd), (40, 120), f'malformed size {bad!r} must be ignored')

    def test_interrupts_during_the_prompt_hook_leave_exactly_one_watcher(self):
        self.stage('rows 49 cols 180\n')
        shell = self.shell()
        shell.read_until(PROMPT)
        watcher = self.watcher(shell)
        # Each Ctrl-C lands while PROMPT_COMMAND runs, the window where a
        # watcher sharing the shell's process group used to die mid-start.
        for _ in range(20):
            shell.run('true')
            shell.send(b'\x03')
            shell.read_until(PROMPT)
        shell.run('true')
        self.assertEqual(self.watcher(shell), watcher, 'Ctrl-C must not force a watcher restart')
        self.assertEqual(watchers(shell.pid), {watcher}, 'exactly one watcher may serve a shell')
        self.stage('rows 33 cols 111\n')
        wait_for(lambda: winsize(shell.fd) == (33, 111), message='resize after Ctrl-C')

    def test_one_watcher_that_exits_with_its_shell(self):
        self.stage('rows 49 cols 180\n')
        shell = self.shell()
        shell.read_until(PROMPT)
        watcher = self.watcher(shell)
        for _ in range(3):
            shell.run('true')
        self.assertEqual(self.watcher(shell), watcher, 'each prompt must reuse the live watcher')
        self.assertEqual(watchers(shell.pid), {watcher})
        self.assertEqual(shell.run('echo "PC=${PROMPT_COMMAND-unset}"; bash -c \'echo "CHILD=${PROMPT_COMMAND-unset}"\'').split(),
                         ['PC=__karkhana_tty_prompt', 'CHILD=unset'])
        shell.send(b'exit\r')
        self.assertEqual(shell.wait_exit(), 0)
        self.shells.remove(shell)
        os.close(shell.fd)
        wait_for(lambda: not watchers(shell.pid), timeout=5, message='watcher exit after its shell')
        self.assertFalse((self.root / f'.karkhana-tty.{shell.pid}').exists(), 'the watcher must remove its lock')


if __name__ == '__main__':
    unittest.main()
