#!/usr/bin/env python3
"""Binary-safe browser downloads over Karkhana's bounded 9p mailbox."""
import argparse
import contextlib
import fcntl
import json
import math
import os
import re
from pathlib import Path
import sys
import tempfile
import threading
import time
import uuid


class BridgeError(RuntimeError):
    def __init__(self, message, code='network'):
        super().__init__(message)
        self.code = code


def _read(path, limit):
    with path.open('rb') as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise BridgeError('bridge file exceeds size limit')
    return data


def _write(path, value):
    with path.open('wb') as stream:
        stream.write(value if isinstance(value, bytes) else value.encode())


def _decode_json(data):
    try:
        return json.loads(data)
    except RecursionError:
        raise BridgeError('bridge JSON exceeds nesting limit') from None


class Response:
    """One slot stays locked until EOF or close; consumers provide backpressure."""
    def __init__(self, url, headers=None, method='GET', timeout=120, pypi=None, npm=None):
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 1 <= timeout <= 600 or not math.isfinite(timeout):
            raise BridgeError('timeout must be between 1 and 600 seconds')
        self.deadline = time.monotonic() + timeout
        self.lock = None
        self.slot = None
        self.closed = False
        self.finished = False
        self.seq = 0
        # Descriptors belong to this transfer, never to the module or slot.
        self._io_lock = threading.RLock()
        self._handles = contextlib.ExitStack()
        self._readers = {}
        self._ack_stream = None
        self._ack_length = 0
        self._iterator_active = False
        self.root = Path(os.environ.get('KARKHANA_FETCH_ROOT', '/persist/.karkhana-net'))
        try:
            config = _decode_json(_read(self.root / 'config.json', 16384))
            if not isinstance(config, dict) or config.get('protocol') != 2:
                raise BridgeError('unsupported bridge protocol; reload Karkhana')
            if config.get('available') is not True:
                raise BridgeError('browser bridge is unavailable', 'cancelled')
            if type(config.get('slots')) is not int or not 1 <= config['slots'] <= 4:
                raise BridgeError('invalid bridge slot configuration')
            if pypi is not None and config.get('pypiMetadata') != 1:
                raise BridgeError('browser PyPI metadata processing is unavailable; reload Karkhana')
            if npm is not None and config.get('npmTree') != 1:
                raise BridgeError('browser npm tree resolution is unavailable; reload Karkhana')
            self.generation = config.get('generation')
            self.chunk_bytes = config.get('chunkBytes')
            if (not isinstance(self.generation, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', self.generation)
                    or type(self.chunk_bytes) is not int or not 1 <= self.chunk_bytes <= 262144):
                raise BridgeError('invalid bridge configuration')
            self.id = uuid.uuid4().hex
            self.token = f'{self.generation}:{self.id}'
            header_pairs = headers.items() if hasattr(headers, 'items') else (headers or [])
            payload = {'protocol': 2, 'generation': self.generation,
                'id': self.id, 'url': url, 'method': method, 'headers': list(header_pairs),
                'timeoutMs': int(timeout * 1000)}
            if pypi is not None:
                payload['pypi'] = pypi
            if npm is not None:
                payload['npm'] = npm
            request = json.dumps(payload)
            if len(request.encode()) > 16384:
                raise BridgeError('request exceeds size limit')
            # Locks live on guest tmpfs. 9p advisory-lock support is unnecessary.
            while self.lock is None:
                for index in range(config['slots']):
                    lock = open(f'/tmp/karkhana-fetch-{self.generation}-{index}.lock', 'a+b')
                    try:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        lock.close()
                        continue
                    except BaseException:
                        with contextlib.suppress(OSError):
                            lock.close()
                        raise
                    self.lock = lock
                    self.slot = self.root / self.generation / str(index)
                    break
                if self.lock is None:
                    self._pause()
            _write(self.slot / 'cancel', '')
            self._write_ack('')
            _write(self.slot / 'request', request)
            _write(self.slot / 'request-ready', self.token)
            frame = self._frame()
            if frame.get('kind') != 'headers':
                raise BridgeError('expected response headers')
            self.status = frame.get('status')
            self.headers = frame.get('headers')
            self.url = frame.get('url')
            if (type(self.status) is not int or not 100 <= self.status <= 599
                    or not isinstance(self.url, str) or not isinstance(self.headers, list)
                    or any(not isinstance(pair, list) or len(pair) != 2
                           or any(not isinstance(value, str) for value in pair) for pair in self.headers)):
                raise BridgeError('invalid response headers')
            self._ack()
        except BaseException:
            with contextlib.suppress(OSError):
                self.close()
            raise

    def _ensure_open(self):
        if self.closed:
            raise BridgeError('response is closed', 'cancelled')
        if time.monotonic() >= self.deadline:
            raise BridgeError('request timed out (browser unavailable or transfer stalled)', 'timeout')

    def _read_mailbox(self, name, limit):
        with self._io_lock:
            self._ensure_open()
            stream = self._readers.get(name)
            if stream is None:
                # Buffered readers can return bytes from an earlier publication.
                stream = self._handles.enter_context((self.slot / name).open('rb', buffering=0))
                self._readers[name] = stream
            stream.seek(0)
            parts = []
            remaining = limit + 1
            while remaining:
                part = stream.read(remaining)
                if part is None:
                    raise OSError('incomplete bridge read')
                if not part:
                    break
                parts.append(part)
                remaining -= len(part)
            data = b''.join(parts)
            if len(data) > limit:
                raise BridgeError('bridge file exceeds size limit')
            return data

    def _write_ack(self, value):
        with self._io_lock:
            self._ensure_open()
            data = value.encode()
            if self._ack_stream is None:
                self._ack_stream = self._handles.enter_context((self.slot / 'ack').open('wb', buffering=0))
            stream = self._ack_stream
            stream.seek(0)
            offset = 0
            while offset < len(data):
                written = stream.write(data[offset:])
                if not written:
                    raise OSError('incomplete bridge acknowledgement write')
                offset += written
            if len(data) < self._ack_length:
                stream.truncate(len(data))
            self._ack_length = len(data)

    def _pause(self):
        if time.monotonic() >= self.deadline:
            raise BridgeError('request timed out (browser unavailable or transfer stalled)', 'timeout')
        time.sleep(0.01)

    def _frame(self):
        while True:
            try:
                frame = _decode_json(self._read_mailbox('ready', 16384))
            except (ValueError, OSError):
                self._pause()
                continue
            if not isinstance(frame, dict):
                raise BridgeError('invalid response frame')
            if type(frame.get('seq')) is not int:
                raise BridgeError('invalid response sequence')
            if (frame.get('generation'), frame.get('id'), frame.get('seq')) == (self.generation, self.id, self.seq):
                if frame.get('kind') == 'error':
                    raise BridgeError(frame.get('error', 'browser request failed'), frame.get('code', 'network'))
                return frame
            self._pause()

    def _ack(self):
        with self._io_lock:
            self._write_ack(f'{self.token}:{self.seq}')
            self.seq += 1

    def iter_chunks(self):
        with self._io_lock:
            if self.finished:
                return
            if self._iterator_active:
                raise BridgeError('response already has an active iterator')
            self._iterator_active = True
        try:
            self._ensure_open()
            while not self.finished:
                frame = self._frame()
                if frame.get('kind') == 'done':
                    with self._io_lock:
                        self._ack()
                        self.finished = True
                        self.close()
                    return
                if (frame.get('kind') != 'chunk' or type(frame.get('size')) is not int
                        or not 0 < frame['size'] <= self.chunk_bytes):
                    raise BridgeError('invalid response frame')
                chunk = self._read_mailbox('chunk', self.chunk_bytes)
                if len(chunk) != frame['size']:
                    raise BridgeError('truncated response chunk')
                # Yield before ACK: a slow consumer cannot accumulate new chunks.
                yield chunk
                self._ack()
        except BaseException:
            with contextlib.suppress(OSError):
                self.close()
            raise
        finally:
            with self._io_lock:
                self._iterator_active = False

    def close(self):
        # Close all descriptors before releasing the slot. A suspended iterator
        # must never reopen a file or ACK after another response owns the slot.
        with self._io_lock:
            if self.closed:
                return
            self.closed = True
            try:
                if self.slot is not None and not self.finished:
                    with contextlib.suppress(OSError):
                        _write(self.slot / 'cancel', self.token)
            finally:
                self._readers.clear()
                self._ack_stream = None
                try:
                    self._handles.close()
                finally:
                    if self.lock is not None:
                        lock, self.lock = self.lock, None
                        lock.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def fetch(url, headers=None, method='GET', timeout=120, pypi=None, npm=None):
    return Response(url, headers=headers, method=method, timeout=timeout, pypi=pypi, npm=npm)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Download HTTPS PyPI and npm registry files through browser fetch; no guest external TCP/TLS. CORS applies.')
    parser.add_argument('url')
    parser.add_argument('-o', '--output', help='write atomically to this file after a complete response')
    parser.add_argument('-I', '--head', action='store_true', help='fetch and print response headers only')
    parser.add_argument('-f', '--fail', action='store_true', help='fail on HTTP errors')
    parser.add_argument('-H', '--header', action='append', default=[], help='request header: Accept, Range, or conditional cache headers')
    parser.add_argument('--max-time', type=float, default=120, help='total timeout in seconds, 1–600')
    args = parser.parse_args(argv)
    headers = []
    for header in args.header:
        if ':' not in header:
            parser.error('headers need Name: value')
        name, value = header.split(':', 1)
        headers.append([name.strip(), value.strip()])
    temporary = None
    try:
        with fetch(args.url, headers, 'HEAD' if args.head else 'GET', args.max_time) as response:
            if args.fail and response.status >= 400:
                raise BridgeError(f'HTTP {response.status}')
            if args.head:
                print(f'HTTP {response.status}')
                for name, value in response.headers:
                    print(f'{name}: {value}')
            destination = sys.stdout.buffer
            if args.output:
                destination = tempfile.NamedTemporaryFile(dir=Path(args.output).resolve().parent, prefix='.kfetch-', delete=False)
                temporary = destination.name
            try:
                for chunk in response.iter_chunks():
                    if not args.head:
                        destination.write(chunk)
            finally:
                if args.output:
                    destination.close()
            if args.output:
                os.replace(temporary, args.output)
                temporary = None
        return 0
    except (BridgeError, OSError, ValueError, KeyboardInterrupt) as error:
        print(f'kfetch: {error}', file=sys.stderr)
        return 1
    finally:
        if temporary:
            with contextlib.suppress(OSError):
                os.unlink(temporary)


if __name__ == '__main__':
    raise SystemExit(main())
