const BRIDGE_URL = "http://127.0.0.1:8765";
let activeTabId = null;

async function bridgeFetch(path, options = {}) {
  const response = await fetch(`${BRIDGE_URL}${path}`, {
    cache: "no-store",
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(options.body ? { "Content-Type": "application/json" } : {})
    }
  });

  if (response.status === 204) return null;
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Bridge returned invalid JSON (HTTP ${response.status}).`);
    }
  }
  if (!response.ok) {
    throw new Error(payload?.error || `Bridge HTTP error ${response.status}.`);
  }
  return payload;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId) activeTabId = null;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "BRIDGE_HEALTH") {
    bridgeFetch("/health")
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "POLL_JOB") {
    const tabId = sender.tab?.id;
    if (typeof tabId !== "number") {
      sendResponse({ ok: false, error: "The request did not come from a tab." });
      return false;
    }

    // Only one ChatGPT tab consumes the queue at a time, preventing concurrent
    // prompts from being injected into different tabs accidentally.
    if (activeTabId === null) activeTabId = tabId;
    if (activeTabId !== tabId) {
      sendResponse({ ok: true, job: null, owner: false });
      return false;
    }

    bridgeFetch("/next")
      .then((data) => sendResponse({ ok: true, job: data?.job || null, owner: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "JOB_PROGRESS") {
    bridgeFetch("/progress", {
      method: "POST",
      body: JSON.stringify({
        id: message.jobId,
        stage: message.stage,
        details: message.details || {}
      })
    })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "JOB_RESULT") {
    bridgeFetch("/result", {
      method: "POST",
      body: JSON.stringify({
        id: message.jobId,
        response: message.response
      })
    })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "JOB_ERROR") {
    bridgeFetch("/result", {
      method: "POST",
      body: JSON.stringify({
        id: message.jobId,
        error: message.error || "Unknown extension error."
      })
    })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
