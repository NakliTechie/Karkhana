#!/usr/bin/env python3
"""Karkhana coding agent — runs inside the VM, talks OpenAI protocol to
http://api.karkhana.internal (the browser-side bridge). The BYOK key is injected
by the service worker outside the VM; this process never sees it.

Tiers (naklios bifurcation): the bridge endpoint may be a real BYOK endpoint
(agent tier) or 'builtin:nano' (GP tier, on-device Gemini Nano — fine for
questions, not for tool use)."""
import json
import os
import subprocess
import sys
import urllib.request

API = "http://api.karkhana.internal/v1/chat/completions"
MODEL = os.environ.get("KARKHANA_MODEL", "default")
MAX_ROUNDS = 10

TOOLS = [
    {"type": "function", "function": {
        "name": "run_command",
        "description": "Run a shell command in the VM and return stdout+stderr (truncated to 4000 chars).",
        "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}},
    {"type": "function", "function": {
        "name": "write_file",
        "description": "Write content to a file (overwrites).",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}},
    {"type": "function", "function": {
        "name": "read_file",
        "description": "Read a file's content (truncated to 8000 chars).",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "list_directory",
        "description": "List a directory.",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
]

def run_tool(name, args):
    try:
        if name == "run_command":
            p = subprocess.run(args["command"], shell=True, capture_output=True, text=True, timeout=120)
            return (p.stdout + p.stderr)[:4000] or "(no output)"
        if name == "write_file":
            with open(args["path"], "w") as f:
                f.write(args["content"])
            return "wrote %d bytes to %s" % (len(args["content"]), args["path"])
        if name == "read_file":
            with open(args["path"]) as f:
                return f.read()[:8000]
        if name == "list_directory":
            return "\n".join(sorted(os.listdir(args["path"])))
        return "unknown tool: " + name
    except Exception as e:  # noqa: BLE001 — the model needs the error text
        return "ERROR: %s" % e

def call_llm(messages, with_tools=True):
    payload = {"model": MODEL, "messages": messages}
    if with_tools:
        payload["tools"] = TOOLS
    req = urllib.request.Request(API, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:  # proxy env routes this to the bridge
        return json.loads(r.read())

def one_turn(messages):
    for _ in range(MAX_ROUNDS):
        resp = call_llm(messages)
        if "error" in resp:
            print("bridge error:", resp["error"])
            return
        msg = resp["choices"][0]["message"]
        calls = msg.get("tool_calls") or []
        if not calls:
            print(msg.get("content") or "(empty reply)")
            return
        messages.append(msg)
        for c in calls:
            fn = c["function"]
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except ValueError:
                args = {}
            print("· %s %s" % (fn["name"], json.dumps(args)[:120]))
            out = run_tool(fn["name"], args)
            messages.append({"role": "tool", "tool_call_id": c.get("id", "0"), "content": out})
    print("(stopped after %d tool rounds)" % MAX_ROUNDS)

def main():
    system = {"role": "system", "content":
              "You are Karkhana, a coding agent inside a Debian VM running in a browser tab. "
              "The working directory is /root; /workspace holds the user's files when mounted. "
              "Use tools to act; be concise."}
    if len(sys.argv) > 1:
        one_turn([system, {"role": "user", "content": " ".join(sys.argv[1:])}])
        return
    print("karkhana agent — type a task, Ctrl-D to exit")
    history = [system]
    while True:
        try:
            line = input("agent> ").strip()
        except EOFError:
            break
        if not line:
            continue
        history.append({"role": "user", "content": line})
        one_turn(history)

if __name__ == "__main__":
    main()
