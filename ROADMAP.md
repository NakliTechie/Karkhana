# Karkhana Roadmap

## Shipped

### M1 — Boot + Terminal
- [x] v86 boots Buildroot Linux 6.8 (i686) in the browser
- [x] xterm.js serial console with Karkhana dark theme
- [x] Boot overlay with progress bar, auto-fade on shell prompt
- [x] 10 MB disk image cached in IndexedDB after first download

### M2 — Storage
- [x] 9P filesystem server bridging VM ↔ host
- [x] File System Access API — user picks a folder, files sync bidirectionally
- [x] OPFS fallback when FSA is declined
- [x] Workspace handle persisted in IndexedDB, auto-restores on reload
- [x] `/workspace` symlink to `/mnt/` created at boot

### M3 — Networking + Agent
- [x] HTTP bridge: VM writes request to file, browser polls + fetches + writes response
- [x] Multi-provider settings: Anthropic, OpenRouter, OpenAI, LM Studio, Ollama presets
- [x] Model discovery with CORS detection and helpful error messages
- [x] In-browser LLM via Transformers.js (Qwen 0.5B–1.5B, SmolLM 1.7B)
- [x] BYOK API keys stored in localStorage, injected by bridge, never visible inside VM
- [x] Agent harness (Python) injected at boot via 9P — blocked on Python in VM

### M5 — Polish
- [x] File browser sidebar with tree view, auto-refresh, click-to-preview
- [x] Right-click context menus (preview, open in terminal, download, delete)
- [x] Toast notifications for boot, workspace sync, file operations
- [x] Keyboard shortcuts (Ctrl+B sidebar, Ctrl+, settings, F1 help, Esc close)
- [x] `window.karkhana` JS API (fs, shell, config, snapshot/restore)
- [x] Embed mode (iframe + postMessage bridge)
- [x] MCP Service Worker with bearer token auth and copyable config block
- [x] Tabbed help modal (Overview, Features, Shortcuts, JS API, Architecture)
- [x] Landing page with feature chips and Launch button
- [x] Collapsible settings sections
- [x] Unified color scheme across all panels
- [x] Panel state persistence (sidebar + settings remembered across sessions)

---

## Next up

### Custom disk image (critical path)
- [ ] Build Alpine Linux bzImage via Docker (`tools/docker/alpine/` in v86 repo)
- [ ] Include Python 3, sqlite3, pip, coreutils
- [ ] Replace Buildroot image URL in Karkhana config
- [ ] Test agent harness end-to-end with real LLM calls

### Agent harness
- [ ] Shell script agent (works with stock Buildroot, no Python needed)
- [ ] Python agent with three-layer learning loop (MEMORY.md + skills/ + sessions.db)
- [ ] Multi-provider bridge testing (Anthropic, OpenAI, Ollama end-to-end)

### Sample projects
- [ ] `/workspace/examples/` with weather, todo, scraper, calculator
- [ ] Each runnable with Python only (`python3 main.py`)

---

## Future

### Terminal improvements
- [ ] Split panes / tabs
- [ ] Command history search (Ctrl+R)
- [ ] Terminal themes (user-configurable colors)

### File browser
- [ ] Drag-drop file upload from host
- [ ] Rename, new file, new folder
- [ ] File type icons

### MCP enhancements
- [ ] `karkhana.ask_agent` tool (send prompt, get response)
- [ ] `karkhana.snapshot` tool (save VM state)
- [ ] Streaming responses

### In-browser LLM
- [ ] Wire full Transformers.js generation worker (currently UI-only)
- [ ] Multimodal support (Gemma 4 E2B/E4B)
- [ ] Token streaming in bridge responses

### Other
- [ ] Monaco/CodeMirror editor pane
- [ ] Cloud backup (optional, user-hosted)
- [ ] Custom disk image builder (in-browser or via CI)
- [ ] Virtual networking (curl/wget via JS API bridge)
