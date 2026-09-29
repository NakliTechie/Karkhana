#!/usr/bin/env python3
"""Opt-in, wheel-only PyPI installs over Karkhana's browser fetch bridge.

The adapter exposes a temporary loopback index to uv. It is also uv's mandatory
HTTP proxy: requests outside this exact loopback index fail closed, including
direct URL dependencies declared by packages. No guest TLS is used for PyPI.
"""

import argparse
import os
import re
import subprocess
import sys
import tempfile
import uuid
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit


JSON_TYPE = "application/vnd.pypi.simple.v1+json"
HTML_TYPE = "application/vnd.pypi.simple.v1+html"
MAX_ENCODED_METADATA_BYTES = 32 * 1024 * 1024
HTTP_TIMEOUT_SECONDS = 180
CHUNK_BYTES = 64 * 1024
NAME = r"[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?"
PROJECT_RE = re.compile(rf"{NAME}\Z")
EXTRAS = rf"(?:\[\s*{NAME}(?:\s*,\s*{NAME})*\s*\])?"
SPECIFIER = r"(?:===|~=|==|!=|<=|>=|<|>)\s*[A-Za-z0-9*+!._-]+"
SPECIFIERS = rf"{SPECIFIER}(?:\s*,\s*{SPECIFIER})*"
REQUIREMENT_RE = re.compile(rf"{NAME}\s*{EXTRAS}\s*(?:{SPECIFIERS}|\(\s*{SPECIFIERS}\s*\))?\s*\Z")
MARKER_RE = re.compile(r"[A-Za-z0-9_ .<>=!~'\"()\[\],-]+\Z")


class AdapterError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def normalize_project(name):
    if not PROJECT_RE.fullmatch(name):
        raise AdapterError(400, "Invalid project name")
    return re.sub(r"[-_.]+", "-", name).lower()


def validate_requirement(value):
    """Accept named PEP 508 requirements, never paths, URLs, or uv options."""
    if any(character in value for character in "@:/\\\r\n\x00"):
        raise argparse.ArgumentTypeError("Use a PyPI package name; URLs and paths are unsupported")
    requirement, separator, marker = value.partition(";")
    if not REQUIREMENT_RE.fullmatch(requirement.strip()):
        raise argparse.ArgumentTypeError("Expected a named requirement, for example 'httpx[http2]>=0.27,<1'")
    if separator and not MARKER_RE.fullmatch(marker.strip()):
        raise argparse.ArgumentTypeError("Unsupported environment marker syntax")
    return value


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        prog="kpip-fast",
        allow_abbrev=False,
        description="Install public PyPI wheels through the Karkhana browser fetch bridge.",
        epilog=("Quote version ranges, extras, and markers. This opt-in command supports named "
                "requirements only. Source builds, URL/VCS/local dependencies, requirements files, "
                "private indexes, credentials, and custom uv options are unsupported. "
                "Dependencies requiring external URLs fail closed. Use kpip for the existing path."),
    )
    for flag, aliases, help_text in (
        ("upgrade", ["-U"], "Allow upgrading installed packages"),
        ("reinstall", [], "Reinstall resolved packages"),
        ("no-deps", [], "Install only the named requirements"),
        ("pre", [], "Allow prerelease versions"),
        ("dry-run", [], "Resolve without installing packages"),
        ("no-cache", [], "Avoid cached artifacts for a cold install measurement"),
        ("verbose", ["-v"], "Show uv diagnostics"),
        ("quiet", ["-q"], "Reduce uv output"),
    ):
        parser.add_argument("--" + flag, *aliases, action="store_true", help=help_text)
    parser.add_argument("requirements", nargs="+", type=validate_requirement, metavar="PACKAGE")
    return parser.parse_args(argv)


def installer_command(args, base_url):
    command = [
        "uv", "--no-config", "--no-python-downloads", "pip", "install",
        "--system", "--break-system-packages", "--index-url", base_url + "/simple/",
        "--only-binary", ":all:", "--keyring-provider", "disabled",
    ]
    for flag in ("upgrade", "reinstall", "no-deps", "pre", "dry-run", "no-cache", "verbose", "quiet"):
        if getattr(args, flag.replace("-", "_")):
            command.append("--" + flag)
    return command + ["--"] + args.requirements


def installer_environment(base_url, environ=None):
    source = os.environ if environ is None else environ
    env = {key: value for key, value in source.items()
           if not key.upper().startswith(("UV_", "PIP_"))
           and key.upper() not in {"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"}}
    # Every installer HTTP connection must traverse this proxy. In particular,
    # NO_PROXY must stay empty: transitive URL dependencies cannot bypass it.
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        env[key] = env[key.lower()] = base_url
    env["NO_PROXY"] = env["no_proxy"] = ""
    env["UV_CONCURRENT_DOWNLOADS"] = "4"
    # Keep a bounded timeout for browser metadata and mailbox backpressure.
    env["UV_HTTP_TIMEOUT"] = str(HTTP_TIMEOUT_SECONDS)
    env["UV_PYTHON_DOWNLOADS"] = "never"
    return env


def _safe_file_url(url):
    try:
        parsed = urlsplit(url)
        valid = (
            parsed.scheme == "https" and parsed.hostname == "files.pythonhosted.org"
            and parsed.port in (None, 443) and parsed.username is None
            and parsed.password is None and not parsed.query
            and parsed.path.startswith("/packages/")
            and not any(part in (".", "..") for part in unquote(parsed.path).split("/"))
            and not any(character in url for character in "\\\r\n\x00")
        )
    except (TypeError, ValueError):
        valid = False
    if not valid:
        raise AdapterError(403, "Blocked download origin or path in PyPI metadata")
    return parsed


class PackageIndex:
    """Forward browser-owned metadata and session-authorized file streams."""
    def __init__(self, fetch):
        self.fetch = fetch
        self.session = uuid.uuid4().hex

    def request(self, operation, base_url, **fields):
        return {"operation": operation, "session": self.session,
                "baseUrl": base_url, **fields}

    def project_response(self, project, base_url, wants_json):
        return self.fetch("https://pypi.org/simple/" + project + "/", timeout=120,
                          pypi=self.request("project", base_url, project=project,
                                            format="json" if wants_json else "html"))

    def file_response(self, path, base_url, head):
        return self.fetch("https://files.pythonhosted.org" + path[len("/files"):],
                          method="HEAD" if head else "GET", timeout=120,
                          pypi=self.request("file", base_url, path=path))

    def close(self, base_url):
        # Explicit release is best-effort if the browser vanished. Its bounded
        # idle expiry also reclaims abandoned sessions after guest termination.
        try:
            with self.fetch("https://pypi.org/", timeout=5,
                            pypi=self.request("close", base_url)) as response:
                for _ in response.iter_chunks():
                    pass
        except Exception:
            pass

    @staticmethod
    def check_status(status):
        if status == 404:
            raise AdapterError(404, "Package or file is missing on PyPI")
        if status in (401, 403):
            raise AdapterError(403, "PyPI refused this request")
        if status != 200:
            raise AdapterError(502, "PyPI request failed with HTTP " + str(status))


class IndexServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False
    request_queue_size = 64

    def __init__(self, index):
        self.index = index
        self.slots = threading.BoundedSemaphore(4)
        self.stopping = threading.Event()
        super().__init__(("127.0.0.1", 0), IndexHandler)
        self.base_url = "http://127.0.0.1:" + str(self.server_port)

    def process_request(self, request, client_address):
        # Stop accepting while all four workers are busy. Pending clients stay
        # in the bounded socket backlog instead of consuming guest threads or
        # receiving transient 503s during uv's parallel metadata resolution.
        while not self.stopping.is_set():
            if self.slots.acquire(timeout=0.1):
                break
        else:
            self.shutdown_request(request)
            return
        request.settimeout(120)
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def shutdown(self):
        self.stopping.set()
        super().shutdown()


class IndexHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "kpip-fast"

    def log_message(self, *_args):
        pass  # Never print dependency URLs, proxy credentials, or user headers.

    def do_GET(self):
        self.handle_request(False)

    def do_HEAD(self):
        self.handle_request(True)

    def do_CONNECT(self):
        self.fail(403, "External URL dependencies are unsupported by kpip-fast")

    def do_POST(self):
        self.fail(405, "Only GET and HEAD are supported")

    def request_path(self):
        target = urlsplit(self.path)
        authority = self.server.base_url.removeprefix("http://")
        if self.headers.get("Host") != authority:
            raise AdapterError(403, "Blocked loopback Host header")
        # uv's mandatory proxy uses absolute-form targets; direct loopback
        # requests use origin-form. Both must address this exact adapter.
        if target.scheme or target.netloc:
            if target.scheme != "http" or target.netloc != authority:
                raise AdapterError(403, "External URL dependencies are unsupported by kpip-fast")
        if target.query or target.fragment or not target.path.startswith("/"):
            raise AdapterError(400, "Unsupported index request target")
        return target.path

    def handle_request(self, head):
        self.close_connection = True
        self.response_started = False
        try:
            path = self.request_path()
            if path.startswith("/simple/"):
                name = path[len("/simple/"):].removesuffix("/")
                project = normalize_project(name)
                wants_json = JSON_TYPE in self.headers.get("Accept", "")
                with self.server.index.project_response(project, self.server.base_url, wants_json) as response:
                    self.server.index.check_status(response.status)
                    if response.url != "https://pypi.org/simple/" + project + "/":
                        raise AdapterError(403, "Blocked PyPI metadata redirect")
                    self.send_response(200)
                    self.send_header("Content-Type", JSON_TYPE if wants_json else HTML_TYPE)
                    self.begin_stream(head)
                    if not head:
                        self.write_stream(response, MAX_ENCODED_METADATA_BYTES)
            elif path.startswith("/files/"):
                self.stream_file(path, head)
            else:
                raise AdapterError(404, "Unknown kpip-fast route")
        except AdapterError as error:
            if not self.response_started:
                self.fail(error.status, str(error))
        except (BrokenPipeError, ConnectionResetError):
            pass  # Exiting the fetch context cancels the browser request.
        except Exception as error:
            if not self.response_started:
                code = getattr(error, "code", "")
                if isinstance(error, TimeoutError) or code in ("timeout", "TIMEOUT"):
                    self.fail(504, "Browser fetch timed out")
                elif isinstance(error, PermissionError) or code in ("blocked", "BLOCKED"):
                    self.fail(403, "Browser fetch blocked this request")
                elif code == "capacity":
                    self.fail(503, "Browser PyPI metadata exceeds session capacity")
                elif isinstance(error, FileNotFoundError):
                    self.fail(404, "Browser fetch resource is missing")
                else:
                    self.fail(502, "Browser fetch failed; check that the Karkhana bridge is running")

    def stream_file(self, path, head):
        # Deliberately ignore Range: uv can fall back to a full 200 response.
        # The browser authorizes this exact route against this install session.
        with self.server.index.file_response(path, self.server.base_url, head) as response:
            self.server.index.check_status(response.status)
            _safe_file_url(response.url)
            self.send_response(200)
            for key, value in response.headers:
                if key.lower() in ("content-type", "etag", "last-modified", "cache-control"):
                    if not any(character in str(value) for character in "\r\n"):
                        self.send_header(key, value)
            self.begin_stream(head)
            if not head:
                self.write_stream(response)

    def begin_stream(self, head):
        self.send_header("Connection", "close")
        if not head:
            self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        self.response_started = True

    def write_stream(self, response, maximum=None):
        size = 0
        for chunk in response.iter_chunks():
            size += len(chunk)
            if maximum is not None and size > maximum:
                raise AdapterError(502, "Encoded PyPI metadata exceeds 32 MiB")
            for offset in range(0, len(chunk), CHUNK_BYTES):
                part = chunk[offset:offset + CHUNK_BYTES]
                self.wfile.write(f"{len(part):X}\r\n".encode("ascii"))
                self.wfile.write(part)
                self.wfile.write(b"\r\n")
        # Only a successful bridge EOF permits the HTTP chunk terminator.
        self.wfile.write(b"0\r\n\r\n")

    def fail(self, status, message):
        body = ("kpip-fast: " + message + "\n").encode("utf-8")
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)


def main(argv=None):
    args = parse_args(argv)
    try:
        from kfetch import fetch
    except ImportError:
        print("kpip-fast: kfetch is missing; this command needs the browser fetch bridge", file=sys.stderr)
        return 1
    with IndexServer(PackageIndex(fetch)) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            # An empty working directory prevents a named requirement matching
            # a local source directory. --no-config disables uv configuration.
            with tempfile.TemporaryDirectory(prefix="kpip-fast-") as directory:
                return subprocess.run(installer_command(args, server.base_url),
                                      env=installer_environment(server.base_url), cwd=directory).returncode
        except FileNotFoundError:
            print("kpip-fast: uv is missing", file=sys.stderr)
            return 1
        except KeyboardInterrupt:
            return 130
        finally:
            server.shutdown()
            thread.join()
            server.index.close(server.base_url)


if __name__ == "__main__":
    sys.exit(main())
