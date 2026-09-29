#!/usr/bin/env python3
"""Bounded metadata caching and duplicate-request checks without network use."""
from concurrent.futures import ThreadPoolExecutor
import copy
import importlib.util
import json
from pathlib import Path
import threading
import time
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('kpip_fast', Path(__file__).parent / 'guest' / 'kpip_fast.py')
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)
BASE = 'http://127.0.0.1:12345'
DOCUMENT = {'meta': {'api-version': '1.0'}, 'name': 'demo', 'files': []}


class MetadataCacheTests(unittest.TestCase):
    def setUp(self):
        self.index = adapter.PackageIndex(lambda *_args, **_kwargs: None)

    def test_concurrent_duplicate_requests_share_rewrite_and_serialization(self):
        entered, release = threading.Event(), threading.Event()
        calls = []

        def produce(project, base_url):
            calls.append((project, base_url))
            entered.set()
            self.assertTrue(release.wait(3))
            return copy.deepcopy(DOCUMENT)

        self.index.read_project = produce
        with ThreadPoolExecutor(max_workers=4) as executor:
            with mock.patch.object(adapter.json, 'dumps', wraps=json.dumps) as dumps:
                tasks = [executor.submit(self.index.project_response, 'demo', BASE, True) for _ in range(4)]
                self.assertTrue(entered.wait(3))
                time.sleep(0.02)
                release.set()
                results = [task.result(timeout=3) for task in tasks]
                self.assertEqual(dumps.call_count, 1)
        self.assertEqual(calls, [('demo', BASE)])
        self.assertTrue(all(result == results[0] for result in results))
        self.assertEqual(json.loads(results[0][1]), DOCUMENT)

    def test_finished_bytes_survive_retry_without_reprocessing(self):
        self.index.read_project = mock.Mock(return_value=copy.deepcopy(DOCUMENT))
        first = self.index.project_response('demo', BASE, True)
        second = self.index.project_response('demo', BASE, True)
        self.assertIs(first[1], second[1])
        self.index.read_project.assert_called_once_with('demo', BASE)

    def test_lru_eviction_respects_total_encoded_byte_budget(self):
        calls = []

        def produce(project, _base_url):
            calls.append(project)
            return {**DOCUMENT, 'name': project}

        self.index.read_project = produce
        one_size = len(json.dumps({**DOCUMENT, 'name': 'a'}, ensure_ascii=True, separators=(',', ':')).encode())
        with mock.patch.object(adapter, 'MAX_METADATA_CACHE_BYTES', one_size * 2):
            for project in ('a', 'b', 'a', 'c', 'a', 'b'):
                self.index.project_response(project, BASE, True)
                self.assertLessEqual(self.index.response_bytes, one_size * 2)
        self.assertEqual(calls, ['a', 'b', 'c', 'b'])

    def test_failed_producer_releases_waiters_and_allows_a_fresh_attempt(self):
        entered, release = threading.Event(), threading.Event()
        attempts = []

        def produce(_project, _base_url):
            attempts.append(1)
            entered.set()
            self.assertTrue(release.wait(3))
            raise adapter.AdapterError(502, 'broken metadata')

        self.index.read_project = produce
        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(self.index.project_response, 'demo', BASE, True)
            self.assertTrue(entered.wait(3))
            second = executor.submit(self.index.project_response, 'demo', BASE, True)
            time.sleep(0.02)
            release.set()
            for task in (first, second):
                with self.assertRaises(adapter.AdapterError) as caught:
                    task.result(timeout=3)
                self.assertEqual(caught.exception.status, 502)
        self.assertEqual(len(attempts), 1)
        self.index.read_project = mock.Mock(return_value=copy.deepcopy(DOCUMENT))
        self.assertEqual(self.index.project_response('demo', BASE, True)[0], adapter.JSON_TYPE)
        self.index.read_project.assert_called_once()

    def test_format_and_loopback_origin_are_part_of_the_cache_key(self):
        self.index.read_project = mock.Mock(return_value=copy.deepcopy(DOCUMENT))
        json_response = self.index.project_response('demo', BASE, True)
        html_response = self.index.project_response('demo', BASE, False)
        other_origin = self.index.project_response('demo', 'http://127.0.0.1:23456', True)
        self.assertEqual(self.index.read_project.call_count, 3)
        self.assertEqual(json_response[0], adapter.JSON_TYPE)
        self.assertEqual(html_response[0], adapter.HTML_TYPE)
        self.assertEqual(other_origin[0], adapter.JSON_TYPE)
        self.assertIn(b'<html>', html_response[1])

    def test_oversized_encoded_metadata_fails_explicitly_without_caching(self):
        self.index.read_project = mock.Mock(return_value={**DOCUMENT, 'extra': 'x' * 200})
        with mock.patch.object(adapter, 'MAX_ENCODED_METADATA_BYTES', 100):
            with self.assertRaises(adapter.AdapterError) as caught:
                self.index.project_response('demo', BASE, True)
        self.assertEqual(caught.exception.status, 502)
        self.assertEqual(self.index.response_bytes, 0)

    def test_response_larger_than_cache_budget_still_serves_without_growing_cache(self):
        self.index.read_project = mock.Mock(return_value=copy.deepcopy(DOCUMENT))
        with mock.patch.object(adapter, 'MAX_METADATA_CACHE_BYTES', 1):
            result = self.index.project_response('demo', BASE, True)
        self.assertEqual(json.loads(result[1]), DOCUMENT)
        self.assertEqual(self.index.response_bytes, 0)

    def test_installer_uses_an_explicit_bounded_metadata_timeout(self):
        environment = adapter.installer_environment(BASE, {'UV_HTTP_TIMEOUT': '999999', 'PATH': '/usr/bin'})
        self.assertEqual(environment['UV_HTTP_TIMEOUT'], '180')
        self.assertEqual(environment['UV_CONCURRENT_DOWNLOADS'], '4')


if __name__ == '__main__':
    unittest.main(verbosity=2)
