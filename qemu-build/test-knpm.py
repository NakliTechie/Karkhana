#!/usr/bin/env python3
"""knpm checks: fake browser bridge, real loopback HTTP, no registry use."""

import http.client
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest

SPEC = importlib.util.spec_from_file_location("knpm", Path(__file__).parent / "guest" / "knpm.py")
knpm = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(knpm)

TARBALL = b"\x1f\x8b fake tarball bytes" * 4000


def doc(name, version):
    short = name.split("/")[-1]
    return {"name": name, "dist-tags": {"latest": version}, "versions": {version: {
        "name": name, "version": version,
        "dist": {"tarball": f"https://registry.npmjs.org/{name}/-/{short}-{version}.tgz", "integrity": "sha512-x"}}}}


class FakeResponse:
    def __init__(self, status, body):
        self.status, self.body = status, body

    def iter_chunks(self):
        for at in range(0, len(self.body), 1000):
            yield self.body[at:at + 1000]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class FakeFetch:
    """Stands in for kfetch.fetch: answers registry URLs, records each call."""
    def __init__(self):
        self.calls = []

    def __call__(self, url, headers=None, method="GET", timeout=120, npm=None):
        self.calls.append((url, headers, npm))
        if url == "https://registry.npmjs.org/@s%2Fextra":
            return FakeResponse(200, json.dumps(doc("@s/extra", "2.0.0")).encode())
        if url.endswith(".tgz"):
            return FakeResponse(200, TARBALL)
        return FakeResponse(404, b"{}")


class Loopback(unittest.TestCase):
    def setUp(self):
        self.fetch = FakeFetch()
        bundle = {"format": 1, "packuments": {"top": doc("top", "1.0.0")}}
        self.server = knpm.Server(knpm.Registry(self.fetch, bundle))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def get(self, path):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.request("GET", path)
        response = connection.getresponse()
        return response.status, response.read()

    def test_bundled_documents_answer_without_the_bridge(self):
        status, body = self.get("/top")
        self.assertEqual(status, 200)
        tarball = json.loads(body)["versions"]["1.0.0"]["dist"]["tarball"]
        self.assertEqual(tarball, f"http://127.0.0.1:{self.port}/-/t/top/-/top-1.0.0.tgz")
        self.assertEqual(self.fetch.calls, [], "bundle hits never touch the bridge")
        self.assertEqual(self.get("/top")[1], body)
        self.assertEqual(self.server.registry.stats["bundled"], 1, "encoded once")

    def test_other_documents_and_tarballs_go_through_the_bridge(self):
        status, body = self.get("/@s%2fextra")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["versions"]["2.0.0"]["dist"]["tarball"],
                         f"http://127.0.0.1:{self.port}/-/t/@s/extra/-/extra-2.0.0.tgz")
        url, headers, _ = self.fetch.calls[0]
        self.assertEqual(url, "https://registry.npmjs.org/@s%2Fextra")
        self.assertTrue(headers[0][1].startswith("application/vnd.npm.install-v1+json"))
        status, body = self.get("/-/t/@s/extra/-/extra-2.0.0.tgz")
        self.assertEqual((status, body), (200, TARBALL))
        self.assertEqual(self.fetch.calls[-1][0], "https://registry.npmjs.org/@s/extra/-/extra-2.0.0.tgz")

    def test_unknown_audit_and_traversal_paths(self):
        self.assertEqual(self.get("/nothing-here")[0], 404)
        self.assertEqual(self.get("/-/npm/v1/security/advisories/bulk")[0], 404)
        self.assertEqual(self.get("/-/t/../secret")[0], 403)
        self.assertEqual(self.get("/-/ping")[0], 200)


class GlobalLayout(unittest.TestCase):
    def test_staging_moves_into_npms_global_layout_and_links_commands(self):
        with tempfile.TemporaryDirectory() as prefix:
            lib = Path(prefix, "lib", "node_modules")
            staging = lib / ".knpm-x" / "node_modules"
            files = {"@s/tool/package.json": json.dumps({"name": "@s/tool", "bin": {"tool": "bin/cli.js"}}),
                     "@s/tool/bin/cli.js": "#!/usr/bin/env node\n", "@s/helper/index.js": "", "dep/index.js": "",
                     "dep/node_modules/inner/index.js": "", ".package-lock.json": "{}"}
            for path, text in files.items():
                Path(staging, path).parent.mkdir(parents=True, exist_ok=True)
                Path(staging, path).write_text(text)
            (staging / ".bin").mkdir()
            os.symlink("../@s/tool/bin/cli.js", staging / ".bin" / "tool")
            os.symlink("../dep/index.js", staging / ".bin" / "dep")
            target = str(lib / "@s" / "tool")
            knpm._move_tree(str(staging), "@s/tool", target)
            self.assertEqual(sorted(os.listdir(Path(target, "node_modules"))), [".bin", "@s", "dep"])
            self.assertTrue(Path(target, "node_modules", "@s", "helper", "index.js").exists())
            self.assertTrue(Path(target, "node_modules", "dep", "node_modules", "inner", "index.js").exists())
            self.assertEqual(os.listdir(Path(target, "node_modules", ".bin")), ["dep"], "the package's own links are dropped")
            self.assertEqual(knpm._link_bins(prefix, "@s/tool", target), ["tool"])
            link = Path(prefix, "bin", "tool")
            self.assertEqual(os.readlink(link), "../lib/node_modules/@s/tool/bin/cli.js")
            self.assertTrue(os.access(link, os.X_OK))

    def test_npm_style_tarball_paths_reach_the_bridge(self):
        fetch = FakeFetch()
        server = knpm.Server(knpm.Registry(fetch, {}))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=10)
            connection.request("GET", "/@s/extra/-/extra-2.0.0.tgz")
            response = connection.getresponse()
            self.assertEqual((response.status, response.read()), (200, TARBALL))
            self.assertEqual(fetch.calls[-1][0], "https://registry.npmjs.org/@s/extra/-/extra-2.0.0.tgz")
        finally:
            server.shutdown()
            server.server_close()


class CommandLine(unittest.TestCase):
    def test_specs_come_from_install_commands_only(self):
        self.assertEqual(knpm.install_specs(["install", "-g", "a", "@s/b@^2", "--prefix", "/x", "c@latest"]),
                         ["a", "@s/b@^2", "c@latest"])
        self.assertEqual(knpm.install_specs(["i", "--omit", "dev", "d"]), ["d"])
        self.assertEqual(knpm.install_specs(["run", "build"]), [])
        self.assertEqual(knpm.install_specs([]), [])

    def test_specs_fall_back_to_package_json(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "package.json").write_text(json.dumps({
                "dependencies": {"a": "^1", "b": "file:../b", "c": "npm:real@2"},
                "devDependencies": {"d": "github:x/y", "e": "~3"}}))
            self.assertEqual(knpm.install_specs(["install"], directory), ["a@^1", "real@2", "e@~3"])

    def test_npm_bypasses_the_proxy_for_loopback_only(self):
        env = knpm.npm_environment("http://127.0.0.1:9", {"NO_PROXY": "example.org", "HTTP_PROXY": "http://proxy"})
        self.assertEqual(env["NO_PROXY"], "example.org,127.0.0.1,localhost")
        self.assertEqual(env["HTTP_PROXY"], "http://proxy")
        self.assertEqual(env["npm_config_registry"], "http://127.0.0.1:9/")
        self.assertEqual(env["npm_config_audit"], "false")


if __name__ == "__main__":
    unittest.main()
