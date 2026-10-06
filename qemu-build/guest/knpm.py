#!/usr/bin/env python3
"""npm installs resolved in the browser, through Karkhana's fetch bridge.

npm looks up registry documents one at a time, and from the guest each lookup
costs about a second. knpm first asks the page for the whole dependency tree
of the named packages: the browser fetches the documents many at a time,
outside the emulated CPU, and hands back one bundle. knpm then runs npm against
a loopback registry that answers from that bundle in milliseconds. Documents
outside the bundle, and every package tarball, go through kfetch on demand.

Usage: knpm <any npm command line>, e.g. knpm install -g opencode-ai
"""

import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote, urlsplit

REGISTRY = "https://registry.npmjs.org"
CORGI = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*"
INSTALL_COMMANDS = {"i", "install", "add", "in", "ins", "inst", "insta", "instal", "isnt", "isntall", "update", "up", "ci"}
# npm options that take a separate value; their values are not package specs.
VALUE_OPTIONS = {"--prefix", "--cache", "--tag", "--workspace", "-w", "--omit", "--include",
                 "--install-strategy", "--userconfig", "--globalconfig", "--registry", "-C", "--before"}
TIMEOUT_SECONDS = 600


def install_specs(argv, cwd="."):
    """The registry packages an npm command line installs: named specs, else package.json's."""
    if not argv or argv[0] not in INSTALL_COMMANDS:
        return []
    specs, skip = [], False
    for arg in argv[1:]:
        if skip:
            skip = False
            continue
        if arg in VALUE_OPTIONS:
            skip = True
            continue
        if arg.startswith("-"):
            continue
        specs.append(arg)
    if specs:
        return specs
    try:
        with open(os.path.join(cwd, "package.json"), encoding="utf-8") as stream:
            manifest = json.load(stream)
    except (OSError, ValueError):
        return []
    for field in ("dependencies", "devDependencies", "optionalDependencies"):
        for name, value in (manifest.get(field) or {}).items():
            if isinstance(value, str) and not value.startswith(("file:", "link:", "git", "http", "workspace:")):
                specs.append(value[4:] if value.startswith("npm:") else f"{name}@{value}")
    return specs[:32]


def rewrite(doc, base):
    """Point registry tarballs at the loopback registry, so they go through kfetch too."""
    for manifest in (doc.get("versions") or {}).values():
        dist = manifest.get("dist") or {}
        tarball = dist.get("tarball")
        if isinstance(tarball, str) and tarball.startswith(REGISTRY + "/"):
            dist["tarball"] = base + "/-/t/" + tarball[len(REGISTRY) + 1:]
    return doc


class Registry:
    """Registry documents by name, rewritten for the loopback address and encoded once."""
    def __init__(self, fetch, bundle=None):
        self.fetch = fetch
        self.base = None
        self.docs = dict((bundle or {}).get("packuments") or {})
        self.encoded = {}
        self.lock = threading.Lock()
        self.stats = {"bundled": 0, "fetched": 0, "tarballs": 0, "missing": 0}

    def body(self, name):
        with self.lock:
            if name in self.encoded:
                return self.encoded[name]
            bundled = name in self.docs
        doc = self.docs[name] if bundled else self._fetch(name)
        if doc is None:
            return None
        body = json.dumps(rewrite(doc, self.base)).encode()
        with self.lock:
            self.encoded[name] = body
            self.stats["bundled" if bundled else "fetched"] += 1
        return body

    def _fetch(self, name):
        url = REGISTRY + "/" + quote(name, safe="@")
        with self.fetch(url, [["Accept", CORGI]], "GET", TIMEOUT_SECONDS) as response:
            body = b"".join(response.iter_chunks())
            if response.status == 404:
                self.stats["missing"] += 1
                return None
            if response.status != 200:
                raise OSError(f"registry answered {response.status} for {name}")
        return json.loads(body)


class Handler(BaseHTTPRequestHandler):
    server_version = "knpm"

    def log_message(self, *args):
        pass

    def _send(self, status, body=b"", kind="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        registry = self.server.registry
        path = urlsplit(self.path).path
        try:
            if path in ("/", "/-/ping"):
                return self._send(200, b"{}")
            # npm may also swap this registry's host into registry tarball URLs.
            tarball = path.startswith("/-/t/") or ("/-/" in path[1:] and path.endswith(".tgz"))
            if tarball:
                rest = path[len("/-/t/"):] if path.startswith("/-/t/") else unquote(path[1:])
                if ".." in rest.split("/") or not rest:
                    return self._send(403, b'{"error":"blocked tarball path"}')
                registry.stats["tarballs"] += 1
                with registry.fetch(REGISTRY + "/" + rest, [], "GET", TIMEOUT_SECONDS) as response:
                    self.send_response(response.status)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    for chunk in response.iter_chunks():
                        if self.command != "HEAD":
                            self.wfile.write(chunk)
                self.close_connection = True
                return None
            if path.startswith("/-/"):
                # Audit, search and login endpoints: knpm serves installs only.
                return self._send(404, b'{"error":"not served by knpm"}')
            body = registry.body(unquote(path[1:]))
            if body is None:
                return self._send(404, b'{"error":"Not found"}')
            return self._send(200, body)
        except (OSError, ValueError) as error:
            try:
                return self._send(502, json.dumps({"error": f"knpm: {error}"}).encode())
            except OSError:
                return None


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, registry):
        super().__init__(("127.0.0.1", 0), Handler)
        self.registry = registry
        self.base = registry.base = f"http://127.0.0.1:{self.server_address[1]}"


def global_prefix(env):
    configured = env.get("npm_config_prefix") or env.get("NPM_CONFIG_PREFIX")
    if configured:
        return configured
    result = subprocess.run(["npm", "prefix", "-g"], env=env, capture_output=True, text=True)
    return result.stdout.strip() or "/usr/local"


def package_name(spec):
    at = spec.find("@", 1)
    return spec if at == -1 else spec[:at]


def _move_tree(staging_modules, name, target):
    """npm's global layout: the package at lib/node_modules/<name>, its
    dependencies in its own node_modules. Moves within one filesystem."""
    if os.path.lexists(target):
        shutil.rmtree(target) if os.path.isdir(target) and not os.path.islink(target) else os.unlink(target)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    os.rename(os.path.join(staging_modules, name), target)
    modules = os.path.join(target, "node_modules")
    os.makedirs(modules, exist_ok=True)
    for entry in os.listdir(staging_modules):
        source = os.path.join(staging_modules, entry)
        if entry in (".package-lock.json", ".bin"):
            continue
        if entry.startswith("@"):
            for sub in os.listdir(source):
                if f"{entry}/{sub}" != name:
                    os.makedirs(os.path.join(modules, entry), exist_ok=True)
                    os.rename(os.path.join(source, sub), os.path.join(modules, entry, sub))
        elif entry != name:
            os.rename(source, os.path.join(modules, entry))
    links = os.path.join(staging_modules, ".bin")
    if os.path.isdir(links):
        own = f"../{name}/"
        os.makedirs(os.path.join(modules, ".bin"), exist_ok=True)
        for link in os.listdir(links):
            path = os.path.join(links, link)
            if os.path.islink(path) and not os.readlink(path).startswith(own):
                os.rename(path, os.path.join(modules, ".bin", link))


def _link_bins(prefix, name, target):
    with open(os.path.join(target, "package.json"), encoding="utf-8") as stream:
        manifest = json.load(stream)
    bins = manifest.get("bin") or {}
    if isinstance(bins, str):
        bins = {name.split("/")[-1]: bins}
    directory = os.path.join(prefix, "bin")
    os.makedirs(directory, exist_ok=True)
    linked = []
    for command, path in bins.items():
        if "/" in command or command in (".", ".."):
            continue
        executable = os.path.normpath(os.path.join(target, path))
        if not executable.startswith(target + os.sep):
            continue
        os.chmod(executable, os.stat(executable).st_mode | 0o111)
        link = os.path.join(directory, command)
        if os.path.lexists(link):
            os.unlink(link)
        os.symlink(os.path.relpath(executable, directory), link)
        linked.append(command)
    return linked


def install_global(spec, lockfile, prefix, env, extra=()):
    """`npm ci` from the browser's plan, then npm's global layout. Returns npm's exit code."""
    name = package_name(spec)
    lib = os.path.join(prefix, "lib", "node_modules")
    os.makedirs(lib, exist_ok=True)
    staging = os.path.join(lib, f".knpm-{uuid.uuid4().hex[:12]}")
    os.makedirs(staging)
    try:
        with open(os.path.join(staging, "package.json"), "w", encoding="utf-8") as stream:
            json.dump({"name": lockfile.get("name", "knpm-install"), "private": True,
                       "dependencies": lockfile["packages"][""]["dependencies"]}, stream)
        base = env["npm_config_registry"].rstrip("/")
        for entry in lockfile["packages"].values():
            resolved = entry.get("resolved")
            if isinstance(resolved, str) and resolved.startswith(REGISTRY + "/"):
                entry["resolved"] = base + "/-/t/" + resolved[len(REGISTRY) + 1:]
        with open(os.path.join(staging, "package-lock.json"), "w", encoding="utf-8") as stream:
            json.dump(lockfile, stream)
        result = subprocess.run(["npm", "ci", *extra], cwd=staging, env=env)
        if result.returncode:
            return result.returncode
        target = os.path.join(lib, name)
        _move_tree(os.path.join(staging, "node_modules"), name, target)
        linked = _link_bins(prefix, name, target)
        print(f"knpm: installed {name} into {target}" + (f"; commands: {', '.join(linked)}" if linked else ""), file=sys.stderr)
        return 0
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def npm_environment(base, environ=None):
    env = dict(os.environ if environ is None else environ)
    # The loopback registry must not go through the guest's HTTP proxy; any
    # other URL npm fetches keeps the normal path.
    for key in ("NO_PROXY", "no_proxy"):
        current = env.get(key, "")
        env[key] = ",".join(part for part in (current, "127.0.0.1", "localhost") if part)
    env["npm_config_noproxy"] = env["NO_PROXY"]
    env["npm_config_registry"] = base + "/"
    env["npm_config_audit"] = "false"
    env["npm_config_fund"] = "false"
    env["npm_config_update_notifier"] = "false"
    return env


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    try:
        from kfetch import BridgeError, fetch
    except ImportError:
        print("knpm: kfetch is missing; this command needs the browser fetch bridge", file=sys.stderr)
        return 1
    bundle = None
    specs = install_specs(argv)
    if specs:
        started = time.monotonic()
        try:
            plan = argv[0] in INSTALL_COMMANDS and ("-g" in argv or "--global" in argv)
            with fetch(REGISTRY + "/", [], "GET", TIMEOUT_SECONDS, npm={"specs": specs, "plan": plan}) as response:
                body = b"".join(response.iter_chunks())
            if response.status != 200:
                raise BridgeError(f"HTTP {response.status}")
            bundle = json.loads(body)
            missing = bundle.get("missing") or []
            print(f"knpm: {bundle.get('packages', 0)} packages resolved in the browser in "
                  f"{time.monotonic() - started:.0f} s ({len(body) // 1024} KB)"
                  + (f"; {len(missing)} not found" if missing else ""), file=sys.stderr)
        except (BridgeError, OSError, ValueError) as error:
            print(f"knpm: browser resolution failed ({error}); npm resolves on its own", file=sys.stderr)
    server = Server(Registry(fetch, bundle))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        env = npm_environment(server.base)
        plans = (bundle or {}).get("plans") or {}
        if specs and plans and all(spec in plans for spec in specs):
            # Global installs skip npm's resolver: `npm ci` from the browser's plan.
            prefix = global_prefix(env)
            extra = [arg for arg in argv[1:] if arg in ("--ignore-scripts", "--omit=optional", "--foreground-scripts")]
            for spec in specs:
                code = install_global(spec, plans[spec], prefix, env, extra)
                if code:
                    return code
            return 0
        for spec, error in ((bundle or {}).get("planErrors") or {}).items():
            print(f"knpm: no install plan for {spec} ({error}); npm resolves it", file=sys.stderr)
        result = subprocess.run(["npm", *argv], env=env)
        stats = server.registry.stats
        print(f"knpm: served {stats['bundled']} documents from the bundle, fetched {stats['fetched']} more, "
              f"{stats['tarballs']} tarballs", file=sys.stderr)
        return result.returncode
    except KeyboardInterrupt:
        return 130
    finally:
        server.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
