#!/usr/bin/env python3
"""Real-file mailbox lifecycle checks; no browser, VM, or external network."""
import concurrent.futures
import contextlib
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock
import uuid


CLIENT = Path(os.environ.get('KFETCH_TEST_CLIENT', Path(__file__).parent / 'guest' / 'kfetch.py'))
SPEC = importlib.util.spec_from_file_location('kfetch_test_client', CLIENT)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)
URL = 'https://files.pythonhosted.org/packages/test.whl'


class ObservedFile:
    def __init__(self, stream, path, buffering, fixture):
        self.stream, self.path, self.buffering, self.fixture = stream, path, buffering, fixture
        self.read_sizes = []
        self.write_calls = 0
        self.close_calls = 0
        self.read_error = None
        self.write_result = 'normal'
        self.close_error = False
        self.before_close = None
        self.read_gate = None

    @property
    def closed(self):
        return self.stream.closed

    def seek(self, offset):
        return self.stream.seek(offset)

    def read(self, size):
        self.read_sizes.append(size)
        if self.read_gate:
            started, release = self.read_gate
            started.set()
            if not release.wait(3):
                raise RuntimeError('test did not release blocked read')
        if self.read_error == 'none':
            return None
        if self.read_error:
            raise self.read_error
        return self.stream.read(min(size, self.fixture.read_size or size))

    def write(self, data):
        self.write_calls += 1
        if isinstance(self.write_result, BaseException):
            raise self.write_result
        if self.write_result != 'normal':
            return self.write_result
        return self.stream.write(data[:self.fixture.write_size or len(data)])

    def truncate(self, length):
        return self.stream.truncate(length)

    def close(self):
        self.close_calls += 1
        if self.before_close:
            self.before_close()
        self.stream.close()
        if self.close_error:
            raise OSError('injected descriptor close failure')

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class Mailbox:
    """Publish the next frame only after the matching real-file acknowledgement."""
    def __init__(self, test, slots=4, chunk_bytes=128):
        self.test = test
        self.directory = tempfile.TemporaryDirectory(prefix='kfetch-test-')
        self.root = Path(self.directory.name)
        self.slots, self.chunk_bytes = slots, chunk_bytes
        self.generation = uuid.uuid4().hex
        self.generations = []
        self.handles = []
        self.tasks = {}
        self.payloads = {}
        self.read_size = self.write_size = None
        self.open_error = None
        self.pause_hook = None
        self.pump_lock = threading.Lock()
        self.waiter = threading.Event()
        self.reset(self.generation)
        self.environment = mock.patch.dict(os.environ, KARKHANA_FETCH_ROOT=str(self.root))
        self.environment.start()
        self.path_open = Path.open
        self.original_pause = bridge.Response._pause

        def observed_open(path, mode='r', buffering=-1, *args, **kwargs):
            name = path.name
            watched = path.parent.parent == self.root and (
                (name in ('ready', 'chunk') and mode == 'rb') or (name == 'ack' and mode == 'wb'))
            if watched and self.open_error == name:
                raise OSError('injected open failure')
            stream = self.path_open(path, mode, buffering, *args, **kwargs)
            if watched:
                stream = ObservedFile(stream, path, buffering, self)
                self.handles.append(stream)
            return stream

        def pause(response):
            if response.slot is None:
                self.waiter.set()
            if self.pause_hook:
                self.pause_hook(response)
            else:
                self.pump()
            return self.original_pause(response)

        self.open_patch = mock.patch.object(Path, 'open', observed_open)
        self.pause_patch = mock.patch.object(bridge.Response, '_pause', pause)
        self.open_patch.start()
        self.pause_patch.start()
        test.addCleanup(self.close)

    def write(self, path, value):
        with open(path, 'wb') as stream:
            stream.write(value if isinstance(value, bytes) else value.encode())

    def text(self, path):
        with open(path, 'r') as stream:
            return stream.read()

    def reset(self, generation, replace=False):
        self.generation = generation
        self.generations.append(generation)
        self.tasks.clear()
        self.write(self.root / 'config.json', json.dumps({
            'protocol': 1, 'generation': generation, 'slots': self.slots,
            'chunkBytes': self.chunk_bytes, 'pypiMetadata': 1}))
        for index in range(self.slots):
            slot = self.root / str(index)
            slot.mkdir(exist_ok=True)
            for name in ('ready', 'chunk', 'ack', 'request', 'request-ready', 'cancel'):
                path = slot / name
                if replace:
                    path.unlink()
                self.write(path, '')

    def pump(self):
        with self.pump_lock:
            for index in range(self.slots):
                slot = self.root / str(index)
                token = self.text(slot / 'request-ready')
                if not token:
                    continue
                task = self.tasks.get(index)
                if task is None or task['token'] != token:
                    request = json.loads(self.text(slot / 'request'))
                    frames = [{'kind': 'headers', 'status': 200, 'headers': [], 'url': request['url']}]
                    frames += [{'kind': 'chunk', 'size': len(data), 'bytes': data}
                               for data in self.payloads.get(request['url'], [b'payload'])]
                    frames.append({'kind': 'done'})
                    task = {'token': token, 'generation': request['generation'], 'id': request['id'],
                            'seq': 0, 'frames': frames}
                    self.tasks[index] = task
                elif self.text(slot / 'cancel') == token:
                    continue
                elif (self.text(slot / 'ack') == f"{token}:{task['seq']}"
                      and task['seq'] + 1 < len(task['frames'])):
                    task['seq'] += 1
                else:
                    continue
                fields = dict(task['frames'][task['seq']])
                if 'bytes' in fields:
                    self.write(slot / 'chunk', fields.pop('bytes'))
                self.write(slot / 'ready', json.dumps({
                    'generation': task['generation'], 'id': task['id'], 'seq': task['seq'], **fields}))

    def fetch(self, url=URL):
        response = bridge.fetch(url, timeout=2)
        self.test.addCleanup(response.close)
        return response

    def handle(self, name, slot=None):
        return next(handle for handle in reversed(self.handles)
                    if handle.path.name == name and (slot is None or handle.path.parent == slot))

    def assert_released(self, response):
        self.test.assertTrue(response.closed)
        self.test.assertIsNone(response.lock)
        for handle in self.handles:
            if handle.path.parent == response.slot:
                self.test.assertTrue(handle.closed, str(handle.path))
        self.assert_slot_unlocked(response.slot.name, response.generation)

    def assert_slot_unlocked(self, index, generation=None):
        with open(f'/tmp/karkhana-fetch-{generation or self.generation}-{index}.lock', 'a+b') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def close(self):
        self.pause_patch.stop()
        self.open_patch.stop()
        self.environment.stop()
        for handle in self.handles:
            handle.stream.close()
        self.directory.cleanup()
        for generation in self.generations:
            for index in range(self.slots):
                with contextlib.suppress(FileNotFoundError):
                    Path(f'/tmp/karkhana-fetch-{generation}-{index}.lock').unlink()


class ResponseTests(unittest.TestCase):
    def test_reuses_three_unbuffered_handles_and_releases_at_eof(self):
        mailbox = Mailbox(self)
        payload = [bytes([index, 0, 255]) * (30 if index % 2 else 1) for index in range(12)]
        mailbox.payloads[URL] = payload
        response = mailbox.fetch()
        lock = response.lock
        self.assertEqual(list(response.iter_chunks()), payload)
        self.assertTrue(response.finished)
        mailbox.assert_released(response)
        self.assertTrue(lock.closed)
        self.assertCountEqual([handle.path.name for handle in mailbox.handles], ['ready', 'chunk', 'ack'])
        self.assertTrue(all(handle.buffering == 0 for handle in mailbox.handles))
        self.assertEqual(mailbox.text(response.slot / 'ack'), f'{response.token}:13')
        self.assertEqual(mailbox.text(response.slot / 'cancel'), '')
        self.assertEqual(list(response.iter_chunks()), [])
        response.close()
        self.assertTrue(all(handle.close_calls == 1 for handle in mailbox.handles))

    def test_partial_reads_and_writes_preserve_binary_and_sequence_growth(self):
        mailbox = Mailbox(self)
        mailbox.read_size, mailbox.write_size = 7, 3
        mailbox.payloads[URL] = [bytes(range(128))] * 11 + [b'\x00\xff']
        response = mailbox.fetch()
        self.assertEqual(list(response.iter_chunks()), mailbox.payloads[URL])
        self.assertEqual(mailbox.text(response.slot / 'ack'), f'{response.token}:13')
        self.assertGreater(mailbox.handle('ack').write_calls, 14)
        self.assertLessEqual(max(mailbox.handle('chunk').read_sizes), 129)
        mailbox.assert_released(response)

    def test_shrinking_ack_truncates_existing_bytes(self):
        mailbox = Mailbox(self)
        response = mailbox.fetch()
        response._write_ack(response.token + ':12345')
        response._write_ack(response.token + ':6')
        self.assertEqual(mailbox.text(response.slot / 'ack'), response.token + ':6')
        response._write_ack('')
        self.assertEqual(mailbox.text(response.slot / 'ack'), '')

    def test_closed_iterator_cannot_ack_or_cancel_successor(self):
        mailbox = Mailbox(self, slots=1)
        first = mailbox.fetch()
        iterator = first.iter_chunks()
        self.assertEqual(next(iterator), b'payload')
        self.assertEqual(mailbox.text(first.slot / 'ack'), first.token + ':0')
        first.close()
        mailbox.assert_released(first)
        self.assertEqual(mailbox.text(first.slot / 'cancel'), first.token)
        successor = mailbox.fetch()
        before = {name: mailbox.text(successor.slot / name) for name in ('ack', 'cancel', 'request-ready')}
        opened = len(mailbox.handles)
        with self.assertRaisesRegex(bridge.BridgeError, 'closed') as raised:
            next(iterator)
        self.assertEqual(raised.exception.code, 'cancelled')
        self.assertEqual(len(mailbox.handles), opened)
        self.assertEqual({name: mailbox.text(successor.slot / name) for name in before}, before)
        self.assertEqual(list(successor.iter_chunks()), [b'payload'])

    def test_close_before_iteration_and_generator_close_release_resources(self):
        mailbox = Mailbox(self)
        response = mailbox.fetch()
        response.close()
        with self.assertRaisesRegex(bridge.BridgeError, 'closed'):
            next(response.iter_chunks())
        response = mailbox.fetch()
        iterator = response.iter_chunks()
        next(iterator)
        iterator.close()
        self.assertFalse(response.finished)
        self.assertEqual(mailbox.text(response.slot / 'ack'), response.token + ':0')
        self.assertEqual(mailbox.text(response.slot / 'cancel'), response.token)
        mailbox.assert_released(response)

    def test_empty_response_closes_without_opening_chunk(self):
        mailbox = Mailbox(self)
        mailbox.payloads[URL] = []
        response = mailbox.fetch()
        self.assertEqual(list(response.iter_chunks()), [])
        self.assertCountEqual([handle.path.name for handle in mailbox.handles], ['ready', 'ack'])
        mailbox.assert_released(response)

    def test_four_same_process_responses_and_fifth_waiter_are_isolated(self):
        mailbox = Mailbox(self)
        urls = [URL + str(index) for index in range(5)]
        for index, url in enumerate(urls):
            mailbox.payloads[url] = [bytes([index]) * (91 - index), bytes([255 - index])]
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            first = list(pool.map(mailbox.fetch, urls[:4]))
            self.assertEqual(len({response.slot for response in first}), 4)
            fifth = pool.submit(mailbox.fetch, urls[4])
            self.assertTrue(mailbox.waiter.wait(1))
            self.assertFalse(fifth.done())
            first[0].close()
            replacement = fifth.result(timeout=2)
            self.assertEqual(replacement.slot, first[0].slot)
            active = first[1:] + [replacement]
            results = list(pool.map(lambda response: list(response.iter_chunks()), active))
        for response, result in zip(active, results):
            self.assertEqual(result, mailbox.payloads[response.url])
            mailbox.assert_released(response)

    def test_stale_identity_and_generation_frames_do_not_advance(self):
        mailbox = Mailbox(self)
        response = mailbox.fetch()
        for overrides in ({'generation': 'retired'}, {'id': 'b' * 32}, {'seq': 99}):
            frame = {'generation': response.generation, 'id': response.id, 'seq': response.seq,
                     'kind': 'error', 'error': 'stale frame must be ignored', **overrides}
            mailbox.write(response.slot / 'ready', json.dumps(frame))
            mailbox.pause_hook = lambda _response: (_ for _ in ()).throw(RuntimeError('stale frame ignored'))
            with self.assertRaisesRegex(RuntimeError, 'stale frame ignored'):
                response._frame()
            self.assertEqual(response.seq, 1)
        mailbox.pause_hook = None
        self.assertEqual(list(response.iter_chunks()), [b'payload'])

    def test_new_generation_and_replaced_inodes_get_fresh_handles(self):
        mailbox = Mailbox(self)
        first = mailbox.fetch()
        self.assertEqual(list(first.iter_chunks()), [b'payload'])
        original = list(mailbox.handles)
        mailbox.reset(uuid.uuid4().hex, replace=True)
        mailbox.payloads[URL] = [b'new generation']
        second = mailbox.fetch()
        self.assertNotEqual(second.generation, first.generation)
        self.assertEqual(list(second.iter_chunks()), [b'new generation'])
        self.assertTrue(all(handle.closed for handle in original))
        self.assertEqual(len(mailbox.handles), 6)

    def test_generation_reset_during_transfer_times_out_without_stale_bytes(self):
        mailbox = Mailbox(self)
        response = mailbox.fetch()
        mailbox.reset(uuid.uuid4().hex)
        mailbox.write(response.slot / 'ready', json.dumps({
            'generation': mailbox.generation, 'id': response.id, 'seq': response.seq,
            'kind': 'chunk', 'size': 4}))
        mailbox.write(response.slot / 'chunk', b'fake')
        mailbox.pause_hook = lambda pending: setattr(pending, 'deadline', 0)
        with self.assertRaises(bridge.BridgeError) as raised:
            list(response.iter_chunks())
        self.assertEqual(raised.exception.code, 'timeout')
        self.assertFalse(response.finished)
        mailbox.assert_released(response)

    def test_constructor_failure_closes_acquired_handles_and_lock(self):
        mailbox = Mailbox(self, slots=1)
        original_write = bridge._write
        def fail_request(path, value):
            if path.name == 'request-ready':
                raise OSError('request publish failure')
            return original_write(path, value)
        response = bridge.Response.__new__(bridge.Response)
        with mock.patch.object(bridge, '_write', fail_request):
            with self.assertRaisesRegex(OSError, 'request publish failure'):
                response.__init__(URL)
        mailbox.assert_released(response)
        self.assertEqual(mailbox.text(response.slot / 'cancel'), response.token)
        self.assertEqual(list(mailbox.fetch().iter_chunks()), [b'payload'])

    def test_failed_ack_open_releases_slot(self):
        mailbox = Mailbox(self, slots=1)
        mailbox.open_error = 'ack'
        response = bridge.Response.__new__(bridge.Response)
        with self.assertRaisesRegex(OSError, 'open failure'):
            response.__init__(URL)
        mailbox.assert_released(response)
        mailbox.open_error = None
        self.assertEqual(list(mailbox.fetch().iter_chunks()), [b'payload'])

    def test_unexpected_flock_failure_closes_unassigned_lock_file(self):
        mailbox = Mailbox(self)
        locks = []
        def fail_lock(stream, _operation):
            locks.append(stream)
            raise OSError('lock operation failed')
        response = bridge.Response.__new__(bridge.Response)
        with mock.patch.object(bridge.fcntl, 'flock', fail_lock):
            with self.assertRaisesRegex(OSError, 'lock operation failed'):
                response.__init__(URL)
        self.assertEqual(len(locks), 1)
        self.assertTrue(locks[0].closed)
        self.assertTrue(response.closed)
        self.assertIsNone(response.lock)
        self.assertIsNone(response.slot)
        self.assertEqual(mailbox.handles, [])

    def test_header_failure_cancels_and_preserves_browser_error(self):
        mailbox = Mailbox(self)
        def publish_error(response):
            mailbox.write(response.slot / 'ready', json.dumps({
                'generation': response.generation, 'id': response.id, 'seq': 0,
                'kind': 'error', 'error': 'upstream failed', 'code': 'blocked'}))
        mailbox.pause_hook = publish_error
        response = bridge.Response.__new__(bridge.Response)
        with self.assertRaisesRegex(bridge.BridgeError, 'upstream failed') as raised:
            response.__init__(URL)
        self.assertEqual(raised.exception.code, 'blocked')
        self.assertEqual(response.seq, 0)
        mailbox.assert_released(response)

    def test_ready_read_limit_remains_bounded(self):
        mailbox = Mailbox(self)
        mailbox.write(mailbox.root / '0' / 'ready', b'x' * 20000)
        response = bridge.Response.__new__(bridge.Response)
        with self.assertRaisesRegex(bridge.BridgeError, 'size limit'):
            response.__init__(URL)
        self.assertEqual(mailbox.handle('ready').read_sizes, [16385])
        mailbox.assert_released(response)

    def test_chunk_bounds_truncation_and_read_failure_never_ack(self):
        mailbox = Mailbox(self)
        cases = [('oversized', b'x' * 129, 128), ('truncated', b'x', 2),
                 ('invalid size', b'x', 0), ('read failure', b'x', 1), ('none read', b'x', 1)]
        for name, data, size in cases:
            with self.subTest(name=name):
                response = mailbox.fetch()
                mailbox.write(response.slot / 'chunk', data)
                mailbox.write(response.slot / 'ready', json.dumps({
                    'generation': response.generation, 'id': response.id, 'seq': 1,
                    'kind': 'chunk', 'size': size}))
                if name in ('read failure', 'none read'):
                    response._read_mailbox('chunk', response.chunk_bytes)
                    mailbox.handle('chunk').read_error = OSError('read failed') if name == 'read failure' else 'none'
                with self.assertRaises((bridge.BridgeError, OSError)):
                    list(response.iter_chunks())
                self.assertEqual(response.seq, 1)
                self.assertFalse(response.finished)
                self.assertEqual(mailbox.text(response.slot / 'ack'), response.token + ':0')
                mailbox.assert_released(response)

    def test_zero_none_and_failed_ack_writes_cancel_without_advancing(self):
        mailbox = Mailbox(self)
        for result in (0, None, OSError('write failed')):
            with self.subTest(result=result):
                response = mailbox.fetch()
                iterator = response.iter_chunks()
                next(iterator)
                mailbox.handle('ack').write_result = result
                with self.assertRaises(OSError):
                    next(iterator)
                self.assertEqual(response.seq, 1)
                self.assertFalse(response.finished)
                self.assertEqual(mailbox.text(response.slot / 'cancel'), response.token)
                mailbox.assert_released(response)

    def test_done_ack_failure_is_not_successful_eof(self):
        mailbox = Mailbox(self)
        mailbox.payloads[URL] = []
        response = mailbox.fetch()
        mailbox.handle('ack').write_result = OSError('done ack failed')
        with self.assertRaisesRegex(OSError, 'done ack failed'):
            list(response.iter_chunks())
        self.assertFalse(response.finished)
        self.assertEqual(response.seq, 1)
        self.assertEqual(mailbox.text(response.slot / 'cancel'), response.token)
        mailbox.assert_released(response)

    def test_timeout_waiting_for_slot_does_not_close_active_response(self):
        mailbox = Mailbox(self, slots=1)
        first = mailbox.fetch()
        mailbox.pause_hook = lambda response: setattr(response, 'deadline', 0)
        pending = bridge.Response.__new__(bridge.Response)
        with self.assertRaises(bridge.BridgeError) as raised:
            pending.__init__(URL)
        self.assertEqual(raised.exception.code, 'timeout')
        self.assertTrue(pending.closed)
        self.assertIsNone(pending.lock)
        self.assertIsNone(pending.slot)
        self.assertFalse(first.closed)
        self.assertTrue(all(not handle.closed for handle in mailbox.handles))
        mailbox.pause_hook = None
        self.assertEqual(list(first.iter_chunks()), [b'payload'])

    def test_close_failure_still_closes_other_handles_and_releases_lock(self):
        mailbox = Mailbox(self)
        response = mailbox.fetch()
        iterator = response.iter_chunks()
        next(iterator)
        mailbox.handle('ready').close_error = True
        with self.assertRaisesRegex(OSError, 'descriptor close failure'):
            response.close()
        mailbox.assert_released(response)
        iterator.close()
        self.assertTrue(all(handle.close_calls == 1 for handle in mailbox.handles))

    def test_every_descriptor_closes_before_slot_unlock(self):
        mailbox = Mailbox(self)
        response = mailbox.fetch()
        iterator = response.iter_chunks()
        next(iterator)
        checked = []
        def check_locked():
            with self.assertRaises(BlockingIOError):
                mailbox.assert_slot_unlocked(response.slot.name)
            checked.append(True)
        for handle in mailbox.handles:
            handle.before_close = check_locked
        response.close()
        self.assertEqual(len(checked), 3)
        mailbox.assert_released(response)
        iterator.close()

    def test_cleanup_errors_preserve_transfer_failure(self):
        mailbox = Mailbox(self)
        response = mailbox.fetch()
        iterator = response.iter_chunks()
        next(iterator)
        mailbox.handle('ready').close_error = True
        mailbox.handle('ack').write_result = OSError('original transfer failure')
        original_write = bridge._write
        def fail_cancel(path, value):
            if path.name == 'cancel':
                raise OSError('cancel write failed')
            return original_write(path, value)
        with mock.patch.object(bridge, '_write', fail_cancel):
            with self.assertRaisesRegex(OSError, 'original transfer failure'):
                next(iterator)
        mailbox.assert_released(response)

    def test_concurrent_close_waits_for_inflight_io_before_releasing_slot(self):
        mailbox = Mailbox(self, slots=1)
        response = mailbox.fetch()
        response._read_mailbox('chunk', response.chunk_bytes)
        started, release, closing = threading.Event(), threading.Event(), threading.Event()
        mailbox.handle('chunk').read_gate = (started, release)
        iterator = response.iter_chunks()
        def close_response():
            closing.set()
            response.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            read = pool.submit(next, iterator)
            try:
                self.assertTrue(started.wait(1))
                closed = pool.submit(close_response)
                self.assertTrue(closing.wait(1))
                self.assertFalse(closed.done())
                with self.assertRaises(BlockingIOError):
                    mailbox.assert_slot_unlocked('0')
            finally:
                release.set()
            self.assertEqual(read.result(timeout=2), b'payload')
            closed.result(timeout=2)
        mailbox.assert_released(response)
        with self.assertRaisesRegex(bridge.BridgeError, 'closed'):
            next(iterator)


if __name__ == '__main__':
    unittest.main()
