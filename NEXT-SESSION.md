# Karkhana — Next Session Notes

## Where we left off

The agent prototype works end-to-end:
- Alpine Linux 3.18 (i686) with Python 3.11 running in browser via v86
- Agent harness at `/usr/bin/agent` — Python script injected via 9P at boot
- LLM calls routed through: agent (urllib) → kproxy (localhost:8888) → kfetch file bridge → browser fetch() → API
- Tool calling works: `write_file`, `run_command`, `list_directory` all confirmed with GPT-4o-mini via OpenRouter
- Settings changes write to VM via serial (not Aj — Aj writes are invisible to VM kernel after boot)

## What to do next: Local model (Gemma 4 E4B)

### Goal
Run the agent using an in-browser Gemma 4 E4B model (no API key needed). The model runs in browser WebGPU, the agent runs in the VM, they communicate through kproxy.

### Why E4B not E2B
Empirical testing shows E4B produces significantly better tool calls. It's ~4.9 GB but downloads once and caches in browser Cache Storage.

### Architecture

```
User types prompt in VM terminal
  → Python agent sends request via kproxy → kfetch → browser
  → Browser routes to LOCAL Transformers.js worker (not external API)
  → Gemma 4 E4B generates text with <tool_call> blocks
  → Response sent back through kfetch → kproxy → agent
  → Agent parses <tool_call> XML from text
  → Agent executes tools (run_command, write_file, etc.)
  → Agent sends tool results back to model
  → Model generates final response
```

### Implementation steps

#### 1. Wire Transformers.js worker (browser side)

The worker code is already stubbed in `index.html` as `LLM_WORKER_SRC`. Need to:

- **Add Gemma 4 E4B to model registry** (`LOCAL_MODELS` in index.html):
  ```javascript
  'gemma4-e4b': { 
    id: 'onnx-community/gemma-4-E4B-it-ONNX', 
    dtype: 'q4f16', 
    type: 'multimodal'  // uses Gemma4ForConditionalGeneration + AutoProcessor
  }
  ```

- **Update worker source** to support multimodal generation (Gemma 4 uses different imports):
  - Import `AutoProcessor`, `Gemma4ForConditionalGeneration` (not `AutoModelForCausalLM`)
  - `processor.apply_chat_template()` returns a string, not tokens
  - `processor(prompt, null, null, { add_special_tokens: false })` — positional args for modalities
  - Generation params: `temperature: 1.0, top_k: 64, top_p: 0.95`

- **Reference implementation**: LocalMind at `/Users/chiragpatnaik/Code/Browser/LocalMind/index.html`
  - Worker source: search for `generateMultimodal` or `Gemma4ForConditionalGeneration`
  - Model loading: search for `loadMultimodal`

#### 2. Route local model responses through kproxy bridge

When Settings has "In-Browser" mode selected and model is loaded:

- The bridge's `executeRequest` already has local LLM routing (`executeLocal` method)
- Need to update `executeLocal` to use the Gemma 4 worker
- The response must be formatted so the agent can parse it
- Key: Gemma 4 outputs `<tool_call>{"name":"...", "arguments":{...}}</tool_call>` blocks in text

The flow when agent POST arrives at kproxy → kfetch → browser:
1. Browser bridge detects local mode is active
2. Instead of `fetch()` to external API, posts to Transformers.js worker
3. Collects all tokens until generation complete
4. Returns the full text as a fake API response to kfetch → kproxy → agent

#### 3. Add tool call parser to Python agent (VM side)

The agent currently expects OpenAI `tool_calls` JSON. For local models, it receives raw text with `<tool_call>` blocks.

Add to the agent harness:
```python
import re

def parse_tool_calls(text):
    """Extract <tool_call> blocks from model output text."""
    calls = []
    pattern = r'<tool_call>\s*([\s\S]*?)\s*</tool_call>'
    for match in re.finditer(pattern, text):
        try:
            parsed = repair_json(match.group(1).strip())
            if parsed and ('name' in parsed or 'function' in parsed):
                name = parsed.get('name') or parsed.get('function')
                args = parsed.get('arguments', {})
                calls.append({'name': name, 'arguments': args})
        except: pass
    clean = re.sub(pattern, '', text).strip()
    return calls, clean

def repair_json(s):
    """Fix common LLM JSON mistakes."""
    try: return json.loads(s)
    except: pass
    s = re.sub(r',\s*([}\]])', r'\1', s)  # trailing commas
    s = s.replace("'", '"')                # single quotes
    s = re.sub(r'(\w+)\s*:', r'"\1":', s)  # unquoted keys
    try: return json.loads(s)
    except: return None
```

Reference: LocalMind's `_adapterParseToolCalls` and `_adapterRepairJSON` functions.

#### 4. Add tool prompt to system message

When using local model, inject tool definitions in the system prompt:
```
You have access to these tools:
<tools>
[{"type":"function","function":{"name":"run_command","description":"Execute a shell command","parameters":{...}}}]
</tools>

To call a tool, output:
<tool_call>
{"name": "function_name", "arguments": {"arg1": "value1"}}
</tool_call>
```

#### 5. Update agent conversation loop

The `llm_call` function needs dual-mode:
- **API mode** (OpenAI format): current code, expects `tool_calls` in response JSON
- **Local mode** (text format): parse `<tool_call>` blocks from response text

Detection: check `cfg.get("mode")` — `"local"` vs `"api"`.

For local mode, the response from kproxy will be:
```json
{
  "status": 200,
  "body": {
    "choices": [{
      "message": {
        "content": "Let me list the files.\n<tool_call>\n{\"name\": \"list_directory\", \"arguments\": {\"path\": \"/workspace\"}}\n</tool_call>"
      }
    }]
  }
}
```

The agent parses `content` text for `<tool_call>` blocks instead of looking at `tool_calls` array.

### Files to modify

| File | What to change |
|---|---|
| `index.html` | Wire Transformers.js worker for Gemma 4, update `executeLocal`, add E4B to model registry |
| `index.html` (agent harness) | Add `parse_tool_calls`, `repair_json`, dual-mode `llm_call` |
| `index.html` (settings) | Add E4B to local model dropdown |

### Key patterns from LocalMind to reuse

1. **`_adapterParseToolCalls`** — 3-tier tool call parser (XML tags → bare JSON → intent regex)
2. **`_adapterRepairJSON`** — JSON fixer for LLM output
3. **`_adapterBuildToolPrompt`** — system prompt with `<tools>` XML and format instructions
4. **`_adapterFormatToolResultMessage`** — `<tool_response>` XML for feeding results back
5. **`generateMultimodal`** — Gemma 4 worker generation with AutoProcessor
6. **`isModelCached`** — Cache Storage check before download

### Known issues to fix

1. **hello.py not showing in sidebar** — agent writes to VM's 9P root (`/workspace/hello.py`), but sidebar shows FSA workspace (host folder). These are separate. Fix: sidebar should show VM files via serial `ls` command, not FSA scan.

2. **chmod timing** — tools installed via Aj at boot need manual `chmod +x` because 9P doesn't preserve execute bits and the serial chmod runs before files are fully visible. Fix: increase delay, or run chmod in a loop until files exist.

3. **Boot config sync** — `emulator.Aj()` writes to 9P are invisible to VM kernel after boot. All browser→VM communication must use serial commands. This is fundamental to the Alpine 9P-root architecture.

4. **kproxy HTTPS** — agent sends `http://` URLs to kproxy, bridge upgrades known hosts to `https://`. Need to expand the upgrade list or make it universal.

### Test plan

1. Boot VM, switch to In-Browser mode, select Gemma 4 E4B, click Load Model
2. Wait for model download + warmup (~5 min first time, instant from cache)
3. Run `agent` in VM terminal
4. Type: `list files in /workspace`
5. Expect: agent sends request → browser runs Gemma 4 → model outputs `<tool_call>` → agent parses → executes `list_directory` → sends result back → model summarizes
6. Type: `create hello.py that prints hello world and run it`
7. Expect: `write_file` + `run_command` tool calls in sequence

### Reference files

- LocalMind: `/Users/chiragpatnaik/Code/Browser/LocalMind/index.html`
  - Tool call parser: search `_adapterParseToolCalls`
  - Tool prompt builder: search `_adapterBuildToolPrompt`
  - Gemma 4 worker: search `generateMultimodal` or `Gemma4ForConditionalGeneration`
  - Model registry: search `MODELS` or `gemma4-e4b`
- VaultMind: `/Users/chiragpatnaik/Code/Browser/VaultMind/index.html`
  - Similar worker pattern, simpler (no tool calling)
- Karkhana spec: `/Users/chiragpatnaik/Downloads/karkhana-spec-001.md`
- CONV.md patterns: `/Users/chiragpatnaik/Code/Browser/CONV.md` — search "In-browser LLM provider pattern"
- AICHAT.md: `/Users/chiragpatnaik/Code/Browser/AICHAT.md` — full chat module reference
