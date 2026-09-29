#!/usr/bin/env python3
"""Binary-safe browser downloads over Karkhana's bounded 9p mailbox."""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import sys
import tempfile
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


class Response:
    """One slot stays locked until EOF or close; consumers provide backpressure."""
    def __init__(self, url, headers=None, method='GET', timeout=120):
        if not 1 <= timeout <= 600:
            raise BridgeError('timeout must be between 1 and 600 seconds')
        self.deadline = time.monotonic() + timeout
        self.lock = None
        self.slot = None
        self.closed = False
        self.finished = False
        self.seq = 0
        self.root = Path(os.environ.get('KARKHANA_FETCH_ROOT', '/persist/.karkhana-net'))
        try:
            config = json.loads(_read(self.root / 'config.json', 16384))
            if config.get('protocol') != 1 or not 1 <= config['slots'] <= 4:
                raise BridgeError('unsupported bridge configuration')
            self.generation = config['generation']
            self.chunk_bytes = config['chunkBytes']
            if not isinstance(self.generation, str) or len(self.generation) > 64 or not 1 <= self.chunk_bytes <= 262144:
                raise BridgeError('invalid bridge configuration')
            self.id = uuid.uuid4().hex
            self.token = f'{self.generation}:{self.id}'
            header_pairs = headers.items() if hasattr(headers, 'items') else (headers or [])
            request = json.dumps({'protocol': 1, 'generation': self.generation,
                'id': self.id, 'url': url, 'method': method, 'headers': list(header_pairs),
                'timeoutMs': int(timeout * 1000)})
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
                    self.lock = lock
                    self.slot = self.root / str(index)
                    break
                if self.lock is None:
                    self._pause()
            _write(self.slot / 'cancel', '')
            _write(self.slot / 'ack', '')
            _write(self.slot / 'request', request)
            _write(self.slot / 'request-ready', self.token)
            frame = self._frame()
            if frame['kind'] != 'headers':
                raise BridgeError('expected response headers')
            self.status = frame['status']
            self.headers = frame['headers']
            self.url = frame['url']
            self._ack()
        except BaseException:
            self.close()
            raise

    def _pause(self):
        if time.monotonic() >= self.deadline:
            raise BridgeError('request timed out (browser unavailable or transfer stalled)', 'timeout')
        time.sleep(0.01)

    def _frame(self):
        while True:
            try:
                frame = json.loads(_read(self.slot / 'ready', 16384))
            except (ValueError, OSError):
                self._pause()
                continue
            if (frame.get('generation'), frame.get('id'), frame.get('seq')) == (self.generation, self.id, self.seq):
                if frame.get('kind') == 'error':
                    raise BridgeError(frame.get('error', 'browser request failed'), frame.get('code', 'network'))
                return frame
            self._pause()

    def _ack(self):
        _write(self.slot / 'ack', f'{self.token}:{self.seq}')
        self.seq += 1

    def iter_chunks(self):
        try:
            while not self.finished:
                frame = self._frame()
                if frame['kind'] == 'done':
                    self.finished = True
                    self._ack()
                    return
                if frame['kind'] != 'chunk' or not 0 < frame.get('size', 0) <= self.chunk_bytes:
                    raise BridgeError('invalid response frame')
                chunk = _read(self.slot / 'chunk', self.chunk_bytes)
                if len(chunk) != frame['size']:
                    raise BridgeError('truncated response chunk')
                # Yield before ACK: a slow consumer cannot accumulate new chunks.
                yield chunk
                self._ack()
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.closed:
            return
        self.closed = True
        if self.slot is not None:
            if not self.finished:
                with contextlib.suppress(OSError):
                    _write(self.slot / 'cancel', self.token)
        if self.lock is not None:
            self.lock.close()
            self.lock = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def fetch(url, headers=None, method='GET', timeout=120):
    return Response(url, headers=headers, method=method, timeout=timeout)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Download HTTPS PyPI files through browser fetch; no guest external TCP/TLS. CORS applies.')
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
