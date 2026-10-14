# Lean ChatGPT Bridge v1.8.0

A small local HTTP bridge connecting a Python client to an open ChatGPT tab through a Chrome extension. It does not require an API key; a signed-in ChatGPT tab must remain open.

## Installation

1. Extract this archive to a permanent directory.
2. Open `chrome://extensions`, remove older copies of Lean ChatGPT Bridge, enable Developer mode, and choose **Load unpacked**.
3. Select this folder's `extension/` directory. The popup should show version `1.8.0`.
4. Reload `https://chatgpt.com/` and keep the tab open.
5. Terminal 1: `python3 bridge.py`
6. Terminal 2: `python3 client.py --prompt 'Réponds uniquement par OKk.' --timeout 30`

## v1.8 response extraction fix

The content script now prefers the inner assistant-message node and its `.markdown`/`.prose` content The diagnostic showed that `[data-conversation-role="assistant"]` matched but produced zero characters. This version prioritizes the current rendered-message marker `[data-markdown-text-style="assistant-message"]` for both locating and extracting the assistant body. Prompt insertion and sending logic is unchanged from v1.7.

The JavaScript/Python syntax, manifest, and ZIP archive are checked in build preparation. The extension still needs a runtime test in the user's signed-in browser because this environment cannot inspect that authenticated tab's DOM.

## Integration from Python

```python
from client import BridgeClient

client = BridgeClient()
response = client.ask("Réponds uniquement par OKk.", timeout=30)
print(response)
```
