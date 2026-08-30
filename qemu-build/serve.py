#!/usr/bin/env python3
"""COOP/COEP static server for the Beagle boot-test (SharedArrayBuffer needs cross-origin isolation)."""
import http.server, socketserver, sys, os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8791
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), "out/htdocs"))

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H) as httpd:
    print(f"serving htdocs on http://127.0.0.1:{PORT}")
    httpd.serve_forever()
