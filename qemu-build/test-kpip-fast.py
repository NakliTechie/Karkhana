#!/usr/bin/env python3
"""Local adapter checks: fake browser bridge, real loopback HTTP, no PyPI use."""

import argparse
import contextlib
import copy
import http.client
import importlib.util
import io
import json
from pathlib import Path
import socket
import threading
import unittest
from urllib.parse import urlsplit
from unittest import mock


SPEC = importlib.util.spec_from_file_location("kpip_fast", Path(__file__).parent / "guest" / "kpip_fast.py")
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)
BRIDGE_SPEC = importlib.util.spec_from_file_location("kfetch", Path(__file__).parent / "guest" / "kfetch.py")
bridge = importlib.util.module_from_spec(BRIDGE_SPEC)
BRIDGE_SPEC.loader.exec_module(bridge)

WHEEL_NAME = "example_pkg-1.2-py3-none-any.whl"
WHEEL_URL = "https://files.pythonhosted.org/packages/ab/cd/123/" + WHEEL_NAME
WHEEL_HASH = "a" * 64
METADATA_HASH = "b" * 64
PROJECT = {
    "meta": {"api-version": "1.1"},
    "name": "example-pkg",
    "versions": ["1.2"],
    "files": [{
        "filename": WHEEL_NAME,
        "url": WHEEL_URL + "#sha256=" + WHEEL_HASH,
        "hashes": {"sha256": WHEEL_HASH},
        "requires-python": ">=3.9,<4",
        "yanked": 'use "1.3" instead',
        "core-metadata": {"sha256": METADATA_HASH},
        "dist-info-metadata": {"sha256": METADATA_HASH},
        "size": 200_000,
    }, {
        "filename": "example_pkg-1.2.tar.gz",
        "url": "https://files.pythonhosted.org/packages/source.tar.gz",
        "hashes": {"sha256": "c" * 64},
    }],
}


class FakeResponse:
    def __init__(self, url, chunks=(), status=200, headers=(), failure=None):
        self.url = url
        self.status = status
        self.headers = headers
        self.chunks = chunks
        self.failure = failure
        self.closed = False
        self.read_count = 0

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.closed = True

    def iter_chunks(self):
        for chunk in self.chunks:
            self.read_count += 1
            yield chunk
        if self.failure:
            raise self.failure


class FakeFetch:
    def __init__(self, project=None, content=None):
        self.project = copy.deepcopy(PROJECT if project is None else project)
        self.content = [b"wheel bytes"] if content is None else content
        self.requests = []
        self.responses = []
        self.status = 200
        self.failure = None
        self.stream_failure = None
        self.redirect = None

    def __call__(self, url, headers=None, method="GET", timeout=120):
        self.requests.append((url, headers, method, timeout))
        if self.failure:
            raise self.failure
        if url.startswith("https://pypi.org/simple/"):
            chunks = [json.dumps(self.project).encode()]
            response_headers = [["Content-Type", adapter.JSON_TYPE]]
        else:
            chunks = self.content
            response_headers = [["Content-Type", "application/octet-stream"],
                                ["Content-Length", "37"], ["Content-Encoding", "gzip"],
                                ["ETag", '"fixture"']]
        response = FakeResponse(self.redirect or url, chunks, self.status, response_headers, self.stream_failure)
        self.responses.append(response)
        return response


class MetadataTests(unittest.TestCase):
    def setUp(self):
        self.index = adapter.PackageIndex(FakeFetch())
        self.base = "http://127.0.0.1:12345"

    def test_json_preserves_hashes_metadata_and_constraints(self):
        result = self.index.rewrite_project("example-pkg", PROJECT, self.base)
        self.assertEqual(len(result["files"]), 1)
        original = PROJECT["files"][0]
        rewritten = result["files"][0]
        self.assertEqual({key: value for key, value in original.items() if key != "url"},
                         {key: value for key, value in rewritten.items() if key != "url"})
        self.assertEqual(urlsplit(rewritten["url"]).fragment, "sha256=" + WHEEL_HASH)
        route = urlsplit(rewritten["url"]).path
        self.assertEqual(self.index.file_url(route), WHEEL_URL)
        self.assertEqual(self.index.file_url(route + ".metadata"), WHEEL_URL + ".metadata")
        self.assertEqual(PROJECT["files"][0]["url"], WHEEL_URL + "#sha256=" + WHEEL_HASH)

    def test_html_escapes_and_preserves_install_selection_metadata(self):
        result = self.index.rewrite_project("example-pkg", PROJECT, self.base)
        body = adapter.project_html(result).decode()
        self.assertIn('data-requires-python="&gt;=3.9,&lt;4"', body)
        self.assertIn('data-yanked="use &quot;1.3&quot; instead"', body)
        self.assertIn('data-core-metadata="sha256=' + METADATA_HASH + '"', body)
        self.assertIn('data-dist-info-metadata="sha256=' + METADATA_HASH + '"', body)
        self.assertIn("#sha256=" + WHEEL_HASH, body)
        self.assertNotIn("tar.gz", body)

    def test_json_hash_becomes_html_fragment_when_original_has_none(self):
        project = copy.deepcopy(PROJECT)
        project["files"][0]["url"] = WHEEL_URL
        result = self.index.rewrite_project("example-pkg", project, self.base)
        self.assertTrue(result["files"][0]["url"].endswith("#sha256=" + WHEEL_HASH))

    def test_empty_yanked_reason_keeps_the_html_attribute(self):
        project = copy.deepcopy(PROJECT)
        project["files"][0]["yanked"] = ""
        result = self.index.rewrite_project("example-pkg", project, self.base)
        self.assertIn(b'data-yanked=""', adapter.project_html(result))

    def test_canonical_wheels_skip_generic_url_work_and_preserve_fragments(self):
        canonical_url = "https://files.pythonhosted.org/packages/ab/cd/" + "e" * 60 + "/" + WHEEL_NAME
        for fragment in ("", "#sha256=" + WHEEL_HASH):
            with self.subTest(fragment=fragment):
                project = copy.deepcopy(PROJECT)
                project["files"][0]["url"] = canonical_url + fragment
                with (mock.patch.object(adapter, "urljoin", side_effect=AssertionError("unexpected generic join")),
                      mock.patch.object(adapter, "_safe_file_url", side_effect=AssertionError("unexpected generic parse")),
                      mock.patch.object(adapter, "urlunsplit", side_effect=AssertionError("unexpected generic serialization"))):
                    result = self.index.rewrite_project("example-pkg", project, self.base)
                rewritten = result["files"][0]
                self.assertEqual(urlsplit(rewritten["url"]).fragment, "sha256=" + WHEEL_HASH)
                route = urlsplit(rewritten["url"]).path
                self.assertEqual(self.index.file_url(route), canonical_url)
                self.assertEqual(self.index.file_url(route + ".metadata"), canonical_url + ".metadata")

    def test_noncanonical_allowed_urls_keep_strict_fallback(self):
        for url in (WHEEL_URL.replace("https://", "//"),
                    WHEEL_URL.replace(".org/", ".org:443/"),
                    WHEEL_URL.replace("example_pkg", "example%5fpkg")):
            with self.subTest(url=url):
                project = copy.deepcopy(PROJECT)
                project["files"][0]["url"] = url
                with mock.patch.object(adapter, "_safe_file_url", wraps=adapter._safe_file_url) as validate:
                    result = self.index.rewrite_project("example-pkg", project, self.base)
                validate.assert_called_once()
                route = urlsplit(result["files"][0]["url"]).path
                expected = "https:" + url if url.startswith("//") else url
                self.assertEqual(self.index.file_url(route), expected)
                self.assertEqual(self.index.file_url(route + ".metadata"), expected + ".metadata")

    def test_metadata_route_requires_advertisement(self):
        project = copy.deepcopy(PROJECT)
        project["files"][0].pop("core-metadata")
        project["files"][0].pop("dist-info-metadata")
        result = self.index.rewrite_project("example-pkg", project, self.base)
        with self.assertRaises(adapter.AdapterError):
            self.index.file_url(urlsplit(result["files"][0]["url"]).path + ".metadata")

    def test_sidecar_uses_one_wheel_record_and_exact_advertised_route(self):
        with mock.patch.object(adapter, "MAX_REGISTERED_WHEELS", 1):
            result = self.index.rewrite_project("example-pkg", PROJECT, self.base)
        route = urlsplit(result["files"][0]["url"]).path
        self.assertEqual(len(self.index.files), 1)
        self.assertEqual(self.index.file_url(route), WHEEL_URL)
        self.assertEqual(self.index.file_url(route + ".metadata"), WHEEL_URL + ".metadata")
        for forbidden in (route + ".metadata.metadata", route + ".metadata/",
                          route.replace("/123/", "/unadvertised/") + ".metadata",
                          route + "%2emetadata"):
            with self.subTest(path=forbidden):
                with self.assertRaises(adapter.AdapterError) as caught:
                    self.index.file_url(forbidden)
                self.assertEqual(caught.exception.status, 403)

    def test_false_metadata_permission_rejects_sidecar_but_allows_wheel(self):
        project = copy.deepcopy(PROJECT)
        project["files"][0]["core-metadata"] = False
        result = self.index.rewrite_project("example-pkg", project, self.base)
        route = urlsplit(result["files"][0]["url"]).path
        self.assertEqual(self.index.file_url(route), WHEEL_URL)
        with self.assertRaises(adapter.AdapterError) as caught:
            self.index.file_url(route + ".metadata")
        self.assertEqual(caught.exception.status, 403)

    def test_cached_advertised_sidecar_survives_a_later_false_flag(self):
        result = self.index.rewrite_project("example-pkg", PROJECT, self.base)
        route = urlsplit(result["files"][0]["url"]).path
        project = copy.deepcopy(PROJECT)
        project["files"][0]["core-metadata"] = False
        self.index.rewrite_project("example-pkg", project, self.base)
        self.assertEqual(len(self.index.files), 1)
        self.assertEqual(self.index.file_url(route + ".metadata"), WHEEL_URL + ".metadata")

    def test_external_origins_credentials_traversal_and_query_are_blocked(self):
        for url in (
            "https://evil.example/packages/" + WHEEL_NAME,
            "http://files.pythonhosted.org/packages/" + WHEEL_NAME,
            "https://files.pythonhosted.org.evil.example/packages/" + WHEEL_NAME,
            "https://secret@files.pythonhosted.org/packages/" + WHEEL_NAME,
            "https://files.pythonhosted.org:8443/packages/" + WHEEL_NAME,
            "https://files.pythonhosted.org/private/" + WHEEL_NAME,
            "https://files.pythonhosted.org/packages/%2e%2e/" + WHEEL_NAME,
            WHEEL_URL + "?token=secret",
        ):
            with self.subTest(url=url):
                project = copy.deepcopy(PROJECT)
                project["files"][0]["url"] = url
                with self.assertRaises(adapter.AdapterError) as caught:
                    self.index.rewrite_project("example-pkg", project, self.base)
                self.assertEqual(caught.exception.status, 403)
        self.assertEqual(self.index.files, {})

    def test_registration_limit_is_checked_before_mutation(self):
        project = copy.deepcopy(PROJECT)
        second = copy.deepcopy(project["files"][0])
        second["url"] = WHEEL_URL.replace("/123/", "/456/")
        project["files"].append(second)
        with mock.patch.object(adapter, "MAX_REGISTERED_WHEELS", 1):
            with self.assertRaises(adapter.AdapterError) as caught:
                self.index.rewrite_project("example-pkg", project, self.base)
        self.assertEqual(caught.exception.status, 503)
        self.assertEqual(self.index.files, {})

    def test_registration_limit_counts_repeated_project_files_once(self):
        with mock.patch.object(adapter, "MAX_REGISTERED_WHEELS", 1):
            self.index.rewrite_project("example-pkg", PROJECT, self.base)
            self.index.rewrite_project("example-pkg", PROJECT, self.base)
            self.assertEqual(len(self.index.files), 1)
            other = copy.deepcopy(PROJECT)
            other["files"][0]["url"] = WHEEL_URL.replace("/123/", "/456/")
            with self.assertRaises(adapter.AdapterError) as caught:
                self.index.rewrite_project("example-pkg", other, self.base)
        self.assertEqual(caught.exception.status, 503)
        self.assertEqual(len(self.index.files), 1)

    def test_over_capacity_update_preserves_existing_sidecar_permission(self):
        with mock.patch.object(adapter, "MAX_REGISTERED_WHEELS", 1):
            result = self.index.rewrite_project("example-pkg", PROJECT, self.base)
            route = urlsplit(result["files"][0]["url"]).path
            project = copy.deepcopy(PROJECT)
            project["files"][0]["core-metadata"] = False
            extra = copy.deepcopy(project["files"][0])
            extra["url"] = WHEEL_URL.replace("/123/", "/456/")
            project["files"].append(extra)
            with self.assertRaises(adapter.AdapterError) as caught:
                self.index.rewrite_project("example-pkg", project, self.base)
        self.assertEqual(caught.exception.status, 503)
        self.assertEqual(len(self.index.files), 1)
        self.assertEqual(self.index.file_url(route + ".metadata"), WHEEL_URL + ".metadata")


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.fetch = FakeFetch()
        self.index = adapter.PackageIndex(self.fetch)
        self.server = adapter.IndexServer(self.index)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()

    def request(self, target, method="GET", headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        connection.request(method, target, headers=headers or {})
        response = connection.getresponse()
        try:
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def register(self):
        status, _headers, body = self.request("/simple/example-pkg/", headers={"Accept": adapter.JSON_TYPE})
        self.assertEqual(status, 200)
        return urlsplit(json.loads(body)["files"][0]["url"]).path

    def test_real_http_serves_canonical_json_and_html(self):
        status, headers, body = self.request("/simple/Example_Pkg/", headers={"Accept": adapter.JSON_TYPE})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], adapter.JSON_TYPE)
        self.assertEqual(json.loads(body)["name"], "example-pkg")
        self.assertEqual(self.fetch.requests[0][0], "https://pypi.org/simple/example-pkg/")
        self.assertEqual(self.fetch.requests[0][1], [["Accept", adapter.JSON_TYPE]])
        status, headers, body = self.request("/simple/example-pkg/")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], adapter.HTML_TYPE)
        self.assertIn(b"data-requires-python", body)

    def test_streams_binary_without_encoded_headers_and_handles_metadata_head(self):
        path = self.register()
        payload = bytes(range(256)) * 1000
        self.fetch.content = [payload[:90_000], payload[90_000:]]
        status, headers, body = self.request(path, headers={"Range": "bytes=0-31", "Authorization": "secret"})
        self.assertEqual(status, 200)
        self.assertEqual(body, payload)
        self.assertEqual(headers["Transfer-Encoding"], "chunked")
        self.assertNotIn("Content-Length", headers)
        self.assertNotIn("Content-Encoding", headers)
        self.assertIsNone(self.fetch.requests[-1][1])
        self.assertTrue(self.fetch.responses[-1].closed)
        status, headers, body = self.request(path + ".metadata", method="HEAD")
        self.assertEqual((status, body), (200, b""))
        self.assertEqual(self.fetch.requests[-1][0], WHEEL_URL + ".metadata")
        self.assertEqual(self.fetch.requests[-1][2], "HEAD")
        self.assertEqual(self.fetch.responses[-1].read_count, 0)
        self.assertTrue(self.fetch.responses[-1].closed)

    def test_wire_chunks_are_bounded_and_binary_exact(self):
        path = self.register()
        self.fetch.content = [b"\x00\xff" * 90_000]
        with socket.create_connection(("127.0.0.1", self.server.server_port), timeout=3) as connection:
            connection.sendall(f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{self.server.server_port}\r\n\r\n".encode())
            parts = []
            while True:
                part = connection.recv(65536)
                if not part:
                    break
                parts.append(part)
        _headers, encoded = b"".join(parts).split(b"\r\n\r\n", 1)
        decoded = bytearray()
        while True:
            size_line, encoded = encoded.split(b"\r\n", 1)
            size = int(size_line, 16)
            if not size:
                self.assertEqual(encoded, b"\r\n")
                break
            self.assertLessEqual(size, adapter.CHUNK_BYTES)
            decoded.extend(encoded[:size])
            self.assertEqual(encoded[size:size + 2], b"\r\n")
            encoded = encoded[size + 2:]
        self.assertEqual(decoded, b"".join(self.fetch.content))

    def test_midstream_bridge_failure_is_an_incomplete_http_body(self):
        path = self.register()
        self.fetch.stream_failure = RuntimeError("bridge disconnected")
        with self.assertRaises(http.client.IncompleteRead):
            self.request(path)
        self.assertTrue(self.fetch.responses[-1].closed)

    def test_proxy_allows_only_its_own_absolute_target(self):
        status, _headers, _body = self.request(self.server.base_url + "/simple/example-pkg/")
        self.assertEqual(status, 200)
        count = len(self.fetch.requests)
        authority = "127.0.0.1:" + str(self.server.server_port)
        for target in ("http://example.com/file.whl", "http://127.0.0.1:1/secret", "https://pypi.org/simple/pkg/"):
            with self.subTest(target=target):
                status, _headers, body = self.request(target, headers={"Host": authority})
                self.assertEqual(status, 403)
                self.assertNotIn(b"example.com", body)
        status, _headers, _body = self.request("example.com:443", method="CONNECT", headers={"Host": authority})
        self.assertEqual(status, 403)
        self.assertEqual(len(self.fetch.requests), count)

    def test_unregistered_download_bad_host_and_path_do_not_fetch(self):
        for target, headers, expected in (
            ("/files/packages/unseen.whl", {}, 403),
            ("/simple/pkg/", {"Host": "evil.example"}, 403),
            ("/simple/../", {}, 400),
            ("/simple/pkg/?index=evil", {}, 400),
            ("/other", {}, 404),
        ):
            status, _response_headers, _body = self.request(target, headers=headers)
            self.assertEqual(status, expected)
        self.assertEqual(self.fetch.requests, [])

    def test_missing_blocked_network_and_timeout_are_distinct(self):
        for status, expected in ((404, 404), (403, 403), (500, 502)):
            self.fetch.status = status
            actual, _headers, _body = self.request("/simple/example-pkg/")
            self.assertEqual(actual, expected)
        self.fetch.status = 200
        for failure, expected in ((RuntimeError("secret diagnostic"), 502), (TimeoutError(), 504), (PermissionError(), 403)):
            self.fetch.failure = failure
            actual, _headers, body = self.request("/simple/example-pkg/")
            self.assertEqual(actual, expected)
            self.assertNotIn(b"secret diagnostic", body)

    def test_project_size_limit_cancels_bridge_response(self):
        with mock.patch.object(adapter, "MAX_PROJECT_BYTES", 20):
            status, _headers, _body = self.request("/simple/example-pkg/")
        self.assertEqual(status, 502)
        self.assertTrue(self.fetch.responses[-1].closed)

    def test_real_bridge_error_codes_map_to_http_status(self):
        for code, expected in (("blocked", 403), ("timeout", 504), ("network", 502), ("cancelled", 502)):
            self.fetch.failure = bridge.BridgeError("private diagnostic", code=code)
            actual, _headers, body = self.request("/simple/example-pkg/")
            self.assertEqual(actual, expected)
            self.assertNotIn(b"private diagnostic", body)

    def test_redirect_outside_allowed_origin_is_blocked(self):
        self.fetch.redirect = "https://evil.example/"
        status, _headers, _body = self.request("/simple/example-pkg/")
        self.assertEqual(status, 403)
        self.assertTrue(self.fetch.responses[-1].closed)

    def test_server_queues_while_active_handlers_are_limited(self):
        for _ in range(4):
            self.assertTrue(self.server.slots.acquire(blocking=False))
        release = threading.Timer(0.05, self.server.slots.release)
        release.start()
        try:
            status, _headers, _body = self.request("/simple/example-pkg/")
            self.assertEqual(status, 200)
        finally:
            release.join()
            for _ in range(3):
                self.server.slots.release()
        self.assertEqual(len(self.fetch.requests), 1)


class ArgumentTests(unittest.TestCase):
    def test_named_requirements_preserve_versions_extras_and_markers(self):
        values = ["httpx[http2]>=0.27,<1", "foo_bar (==1.2.*)", "packaging; python_version >= '3.9'"]
        args = adapter.parse_args(["--upgrade", "--no-cache", *values])
        command = adapter.installer_command(args, "http://127.0.0.1:1234")
        self.assertEqual(command[-3:], values)
        self.assertIn("--no-config", command)
        self.assertIn("--no-python-downloads", command)
        self.assertIn("--only-binary", command)
        self.assertIn("--upgrade", command)
        self.assertIn("--no-cache", command)
        self.assertEqual(command[command.index("--only-binary") + 1], ":all:")

    def test_argument_and_requirement_escape_attempts_are_rejected(self):
        options = ["--index-url", "--extra-index-url", "--find-links", "--config-file", "--python",
                   "--allow-insecure-host", "--no-binary", "--index", "-r", "-e"]
        for option in options:
            with self.subTest(option=option), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                adapter.parse_args(["requests", option, "escape"])
        for value in ("foo @ https://example.com/foo.whl", "git+https://example.com/repo", "./foo", "/tmp/foo",
                      "file:///tmp/foo", "foo.whl/path", "--index-url=evil", "foo\nbar", "foo; @bad"):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                adapter.validate_requirement(value)

    def test_environment_disables_inherited_indexes_and_proxy_bypass(self):
        env = adapter.installer_environment("http://127.0.0.1:1234", {
            "PATH": "/usr/bin", "UV_INDEX_URL": "https://secret@index.example", "PIP_CONFIG_FILE": "/secret",
            "UV_HTTP_HEADERS": "Authorization=secret", "pip_extra_index_url": "https://private.example",
            "HTTPS_PROXY": "http://user:password@proxy", "all_proxy": "socks5://other", "NO_PROXY": "*",
        })
        self.assertEqual(env["PATH"], "/usr/bin")
        self.assertNotIn("UV_INDEX_URL", env)
        self.assertNotIn("UV_HTTP_HEADERS", env)
        self.assertNotIn("PIP_CONFIG_FILE", env)
        self.assertNotIn("pip_extra_index_url", env)
        for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            self.assertEqual(env[key], "http://127.0.0.1:1234")
        self.assertEqual(env["NO_PROXY"], "")
        self.assertEqual(env["no_proxy"], "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
