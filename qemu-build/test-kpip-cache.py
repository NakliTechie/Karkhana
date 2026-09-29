#!/usr/bin/env python3
"""Guest forwarding regressions. Browser cache coverage lives in test-pypi-metadata.mjs."""
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location('kpip_fast', Path(__file__).parent / 'guest' / 'kpip_fast.py')
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)
BASE = 'http://127.0.0.1:12345'


class ForwardingTests(unittest.TestCase):
    def test_project_bytes_are_streamed_without_guest_parse_cache_or_rewrite(self):
        calls = []
        response = object()

        def fetch(url, **kwargs):
            calls.append((url, kwargs))
            return response

        index = adapter.PackageIndex(fetch)
        self.assertIs(index.project_response('demo', BASE, True), response)
        self.assertIs(index.project_response('demo', BASE, True), response)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][1]['pypi'], {
            'operation': 'project', 'session': index.session,
            'baseUrl': BASE, 'project': 'demo', 'format': 'json'})
        self.assertFalse(hasattr(index, 'files'))
        self.assertFalse(hasattr(index, 'responses'))

    def test_each_install_has_a_separate_browser_authorization_session(self):
        first = adapter.PackageIndex(None)
        second = adapter.PackageIndex(None)
        self.assertNotEqual(first.session, second.session)
        self.assertEqual(len(first.session), 32)

    def test_file_authorization_is_delegated_with_the_exact_route_and_origin(self):
        calls = []
        index = adapter.PackageIndex(lambda *args, **kwargs: calls.append((args, kwargs)))
        route = '/files/packages/a/demo.whl.metadata'
        index.file_response(route, BASE, True)
        self.assertEqual(calls[0][0], ('https://files.pythonhosted.org/packages/a/demo.whl.metadata',))
        self.assertEqual(calls[0][1]['method'], 'HEAD')
        self.assertEqual(calls[0][1]['pypi'], {
            'operation': 'file', 'session': index.session, 'baseUrl': BASE, 'path': route})

    def test_close_is_best_effort_and_uses_a_short_bounded_control_request(self):
        calls = []

        def unavailable(url, **kwargs):
            calls.append((url, kwargs))
            raise TimeoutError()

        index = adapter.PackageIndex(unavailable)
        index.close(BASE)
        self.assertEqual(calls[0][0], 'https://pypi.org/')
        self.assertEqual(calls[0][1]['timeout'], 5)
        self.assertEqual(calls[0][1]['pypi']['operation'], 'close')

    def test_installer_uses_a_bounded_timeout_and_four_downloads(self):
        environment = adapter.installer_environment(BASE, {'UV_HTTP_TIMEOUT': '999999', 'PATH': '/usr/bin'})
        self.assertEqual(environment['UV_HTTP_TIMEOUT'], '180')
        self.assertEqual(environment['UV_CONCURRENT_DOWNLOADS'], '4')


if __name__ == '__main__':
    unittest.main(verbosity=2)
