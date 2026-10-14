(() => {
  if (window.__leanChatGptBridgeInstalled) return;
  window.__leanChatGptBridgeInstalled = true;

  const CONNECTED_POLL_MS = 1200;
  const DISCONNECTED_POLL_MS = 5000;
  const RESPONSE_TIMEOUT_MS = 90 * 1000;
  const RESPONSE_STABLE_MS = 4500;
  const ACTIVE_GENERATION_STABLE_MS = 6000;
  const PROGRESS_REPORT_MS = 1800;
  let processingJob = false;
  let polling = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function visible(element) {
    return Boolean(element && element.isConnected && element.getClientRects().length);
  }

  function findComposer() {
    // Prefer the visible, active composer at the bottom of the current page.
    const selectors = [
      '#prompt-textarea',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      'textarea[placeholder]',
      'textarea'
    ];
    const candidates = [];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!visible(element) || element.disabled || element.getAttribute('aria-disabled') === 'true') continue;
        if (element.closest('[aria-hidden="true"]')) continue;
        if (!candidates.includes(element)) candidates.push(element);
      }
      if (candidates.length) break;
    }
    // If a selector matches duplicate/hidden composers, use the one lowest on the page.
    candidates.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    return candidates[0] || null;
  }

  async function waitForComposer(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const composer = findComposer();
      if (composer) return composer;
      await sleep(250);
    }
    throw new Error("Could not find the ChatGPT message input. Ensure the page is fully loaded and you are signed in.");
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor?.set) descriptor.set.call(element, value);
    else element.value = value;
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: value
    }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setEditableText(element, value) {
    element.focus();
    // Avoid replaceChildren(): ChatGPT's editor is React-controlled and replacing
    // its internal DOM can break the composer on existing conversations.
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    const inserted = document.execCommand('insertText', false, value);

    let current = (element.innerText || element.textContent || '').replace(/\r\n/g, '\n').trimEnd();
    const expected = value.replace(/\r\n/g, '\n').trimEnd();
    if (!inserted || current !== expected) {
      // Second attempt: clear via the editor command and insert text while the
      // editor is focused, preserving its existing DOM structure.
      element.focus();
      document.execCommand('selectAll', false);
      document.execCommand('delete', false);
      document.execCommand('insertText', false, value);
      current = (element.innerText || element.textContent || '').replace(/\r\n/g, '\n').trimEnd();
    }
    if (current !== expected) {
      throw new Error(`Could not insert the full prompt into ChatGPT's composer (inserted ${current.length}/${expected.length} characters). Click the message box once and retry.`);
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  }

  function findSendButton() {
    const directSelectors = [
      'button[data-testid="send-button"]',
      'button[data-testid*="send" i]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Envoyer" i]',
      'button[aria-label*="Submit" i]',
      'button[aria-label*="Envoyer le message" i]'
    ];
    for (const selector of directSelectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (visible(element) && !element.disabled) return element;
      }
    }

    const buttons = [...document.querySelectorAll("button")].filter(visible);
    return buttons.find((button) => {
      const label = `${button.getAttribute("aria-label") || ""} ${button.title || ""} ${button.dataset.testid || ""}`;
      return /send|envoyer|submit/i.test(label) && !button.disabled;
    }) || null;
  }

  async function waitForSendButton(timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const button = findSendButton();
      if (button) return button;
      await sleep(150);
    }
    return null;
  }

  function pressEnterToSend(composer) {
    composer.focus();
    const eventOptions = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    };
    composer.dispatchEvent(new KeyboardEvent("keydown", eventOptions));
    composer.dispatchEvent(new KeyboardEvent("keypress", eventOptions));
    composer.dispatchEvent(new KeyboardEvent("keyup", eventOptions));
  }

  function getNodeText(node) {
    if (!node) return '';
    const inner = typeof node.innerText === 'string' ? node.innerText : '';
    if (inner.trim()) return inner;
    return typeof node.textContent === 'string' ? node.textContent : '';
  }

  function cleanAssistantText(value) {
    const uiLabel = /^(?:chatgpt said:?|you said:?|assistant said:?|chatgpt a dit\s*:?|vous avez dit\s*:?|assistant\s*:?|you\s*:?|chatgpt\s*:?|copilot said:?)$/i;
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => !uiLabel.test(line.trim()))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function extractAssistantText(node) {
    if (!node) return '';

    // A turn wrapper can contain a screen-reader heading such as "ChatGPT said:".
    // Prefer the actual assistant message element, then its rendered text body.
    const roleSelectors = [
      '[data-message-author-role="assistant"]',
      '[data-role="assistant"]',
      '[data-message-author="assistant"]'
    ];
    let message = node;
    if (!roleSelectors.some((selector) => node.matches?.(selector))) {
      for (const selector of roleSelectors) {
        const nested = node.querySelector?.(selector);
        if (nested) { message = nested; break; }
      }
    }

    const contentSelectors = [
      // Current ChatGPT transcript renderer: this marks the rendered assistant body,
      // whereas data-conversation-role identifies a surrounding logical turn marker.
      '[data-markdown-text-style="assistant-message"]',
      '.markdown', '.prose', '[data-testid*="message-content"]',
      '[data-message-content]', '[class*="markdown"]'
    ];
    let content = null;
    for (const selector of contentSelectors) {
      const candidate = message.matches?.(selector) ? message : message.querySelector?.(selector);
      if (candidate && cleanAssistantText(getNodeText(candidate))) { content = candidate; break; }
    }
    content ||= message;

    const clone = content.cloneNode(true);
    clone.querySelectorAll([
      'button', '[role="toolbar"]', '[aria-hidden="true"]', '.sr-only',
      '[class~="sr-only"]', '[class*="sr-only"]',
      '[data-testid*="copy" i]', '[aria-label*="copy" i]'
    ].join(',')).forEach((element) => element.remove());

    clone.querySelectorAll('pre').forEach((pre) => {
      const code = pre.querySelector('code');
      if (code) {
        const block = document.createElement('div');
        block.textContent = getNodeText(code).replace(/\n+$/, '');
        pre.replaceWith(block);
      }
    });

    return cleanAssistantText(getNodeText(clone));
  }

  // Prefer the message body node. The generic data-turn selector catches both
  // section and article turn wrappers when the inner role attribute is absent.
  const ASSISTANT_SELECTORS = [
    // Current ChatGPT renders answer text inside this marker. Prefer the body,
    // not the outer data-conversation-role turn marker which may contain no text.
    '[data-markdown-text-style="assistant-message"]',
    '[data-message-author-role="assistant"]',
    '[data-conversation-role="assistant"]',
    '[data-role="assistant"]',
    '[data-message-author="assistant"]',
    '[data-turn="assistant"]',
    '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
    '[data-turn-key]:has([data-conversation-role="assistant"], [data-chatgpt-agent-turn-start])',
    '.agent-turn'
  ];

  // If the site stops exposing role attributes, assistant prose is commonly
  // still rendered inside .markdown/.prose blocks inside <main>. These are
  // deliberately last-resort selectors and are only used when no semantic
  // assistant-turn selector matches.
  const RESPONSE_CONTENT_FALLBACKS = [
    '[data-markdown-text-style="assistant-message"]',
    'main .markdown',
    'main .prose',
    'main [class*="markdown"]',
    'main [data-message-id]',
    '.markdown',
    '.prose',
    '[class*="markdown"]'
  ];

  let lastAssistantSelectorDiagnostics = [];

  function isHiddenInTree(element) {
    // Do not use getClientRects() here: some ChatGPT message wrappers use
    // display: contents and therefore have zero rects despite visible text.
    if (!element || !element.isConnected) return true;
    for (let current = element; current && current.nodeType === Node.ELEMENT_NODE; current = current.parentElement) {
      if (current.getAttribute('aria-hidden') === 'true') return true;
      const style = window.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.contentVisibility === 'hidden') {
        return true;
      }
    }
    return false;
  }

  function assistantSelectorDiagnostics() {
    return ASSISTANT_SELECTORS.map((selector) => {
      try {
        return { selector, matches: document.querySelectorAll(selector).length };
      } catch (error) {
        return { selector, error: String(error) };
      }
    }).filter((item) => item.matches || item.error);
  }

  function assistantMessages() {
    const diagnosticRows = [];

    // First use semantic assistant-turn markers; this is the reliable path.
    for (const selector of ASSISTANT_SELECTORS) {
      let raw = [];
      try {
        raw = [...document.querySelectorAll(selector)];
      } catch (error) {
        diagnosticRows.push({ selector, error: String(error) });
        continue;
      }
      diagnosticRows.push({ selector, matches: raw.length });
      const found = raw.filter((node) => !isHiddenInTree(node));
      if (!found.length) continue;
      lastAssistantSelectorDiagnostics = diagnosticRows;
      return found.filter((node) => !found.some((other) => other !== node && other.contains(node)));
    }

    // Fallback for UI variants that no longer publish an explicit author role.
    // Prefer markdown/prose roots in the conversation's main area. A fallback
    // node is still checked against the submitted prompt before acceptance.
    for (const selector of RESPONSE_CONTENT_FALLBACKS) {
      let raw = [];
      try {
        raw = [...document.querySelectorAll(selector)];
      } catch (error) {
        diagnosticRows.push({ selector, error: String(error) });
        continue;
      }
      const found = raw.filter((node) => {
        if (isHiddenInTree(node)) return false;
        const text = extractAssistantText(node);
        return Boolean(text);
      });
      diagnosticRows.push({ selector, matches: raw.length, usable: found.length, fallback: true });
      if (!found.length) continue;
      lastAssistantSelectorDiagnostics = diagnosticRows;
      return found.filter((node) => !found.some((other) => other !== node && other.contains(node)));
    }

    lastAssistantSelectorDiagnostics = diagnosticRows;
    return [];
  }

  function isGenerating() {
    const stopSelectors = [
      'button[data-testid="stop-button"]',
      'button[data-testid*="stop" i]',
      'button[aria-label*="Stop" i]',
      'button[aria-label*="Arrêter" i]',
      'button[aria-label*="Interrompre" i]',
      'button[title*="Stop" i]',
      'button[title*="Arrêter" i]'
    ];
    return stopSelectors.some((selector) => {
      const element = document.querySelector(selector);
      return visible(element) && !element.disabled;
    });
  }

  async function waitForFinalAnswer(beforeCount, beforeNode, beforeText, jobId, submittedPrompt) {
    const startedAt = Date.now();
    let responseNode = null;
    let lastText = "";
    let lastChangedAt = 0;
    let sawGeneration = false;
    let lastProgressAt = 0;
    let maxObservedTextLength = 0;
    let lastObservedMessageCount = beforeCount;
    let lastObservedGenerating = false;

    while (Date.now() - startedAt < RESPONSE_TIMEOUT_MS) {
      const messages = assistantMessages();
      const node = messages[messages.length - 1] || null;
      const text = node ? extractAssistantText(node) : "";
      const isNewNode = Boolean(node && node !== beforeNode);
      const isNewMessage = messages.length > beforeCount;
      const isChanged = Boolean(text && text !== beforeText);
      const normalizedPrompt = String(submittedPrompt || "").replace(/\r\n/g, "\n").trim();
      const looksLikeSubmittedPrompt = Boolean(normalizedPrompt && text.trim() === normalizedPrompt);
      const generating = isGenerating();

      if (generating) sawGeneration = true;
      lastObservedMessageCount = messages.length;
      lastObservedGenerating = generating;
      maxObservedTextLength = Math.max(maxObservedTextLength, text.length);

      // Send progress to Python periodically. This makes client-side timeouts
      // useful even if DOM extraction never finds the answer.
      if (Date.now() - lastProgressAt >= PROGRESS_REPORT_MS) {
        lastProgressAt = Date.now();
        void reportProgress(jobId, "waiting_for_answer", {
          assistantMessages: messages.length,
          previousAssistantMessages: beforeCount,
          currentTextChars: text.length,
          maxObservedTextChars: maxObservedTextLength,
          generating,
          selectorMatchCounts: lastAssistantSelectorDiagnostics,
          elapsedSeconds: Math.round((Date.now() - startedAt) / 1000)
        });
      }

      // Only consider a turn that appeared or changed after this prompt was sent.
      if (text && !looksLikeSubmittedPrompt && (isNewNode || isNewMessage || isChanged)) {
        if (node !== responseNode || text !== lastText) {
          responseNode = node;
          lastText = text;
          lastChangedAt = Date.now();
        }

        const stableFor = Date.now() - lastChangedAt;
        // Do not trust the Stop button alone: it can be missing or stale in the
        // web UI. A quiet text period is the primary completion signal.
        const requiredStableTime = generating || sawGeneration
          ? ACTIVE_GENERATION_STABLE_MS
          : RESPONSE_STABLE_MS;
        if (stableFor >= requiredStableTime) {
          await reportProgress(jobId, "answer_captured", {
            responseChars: text.length,
            stableForMs: stableFor,
            generating,
            elapsedSeconds: Math.round((Date.now() - startedAt) / 1000)
          });
          return text;
        }
      }
      await sleep(250);
    }

    const messages = assistantMessages();
    const node = messages[messages.length - 1] || null;
    const finalText = node ? extractAssistantText(node) : "";
    const details = {
      assistantMessages: messages.length,
      previousAssistantMessages: beforeCount,
      currentTextChars: finalText.length,
      maxObservedTextChars: maxObservedTextLength,
      generating: lastObservedGenerating,
      selectorMatchCounts: lastAssistantSelectorDiagnostics,
      diagnosis: messages.length === 0
        ? "No supported assistant-turn selector matched a usable node; this is DOM detection, not evidence that generation is still running."
        : (finalText.length === 0
          ? "An assistant turn was found, but no text could be extracted from it."
          : "Assistant text was found but did not satisfy the stability rule."),
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      selector: node
        ? `${node.tagName.toLowerCase()}${node.getAttribute("data-message-author-role") ? '[data-message-author-role="' + node.getAttribute("data-message-author-role") + '"]' : node.getAttribute("data-turn") ? '[data-turn="' + node.getAttribute("data-turn") + '"]' : ""}`
        : "no assistant node found",
      currentUrl: location.href,
      diagnostics: lastAssistantSelectorDiagnostics
    };
    await reportProgress(jobId, "response_timeout", details);
    throw new Error(`Could not capture ChatGPT's answer. ${details.diagnosis} Diagnostics: ${JSON.stringify(details)}`);
  }

  async function sendPromptAndWait(prompt, jobId) {
    await reportProgress(jobId, "finding_composer", { url: location.href });
    const beforeMessages = assistantMessages();
    const beforeCount = beforeMessages.length;
    const beforeNode = beforeMessages[beforeMessages.length - 1] || null;
    const beforeText = beforeNode ? extractAssistantText(beforeNode) : "";

    const composer = await waitForComposer();
    await reportProgress(jobId, "inserting_prompt", {
      composerTag: composer.tagName.toLowerCase(),
      previousAssistantMessages: beforeCount
    });
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      setNativeValue(composer, prompt);
    } else {
      setEditableText(composer, prompt);
    }

    // Let React update the composer and enable the send control.
    await reportProgress(jobId, "prompt_inserted", { promptChars: prompt.length });
    await sleep(350);
    const sendButton = await waitForSendButton();
    if (sendButton) {
      await reportProgress(jobId, "sending_prompt", {
        sendButtonTestId: sendButton.getAttribute("data-testid") || null,
        sendButtonLabel: sendButton.getAttribute("aria-label") || sendButton.title || null
      });
      sendButton.click();
    } else {
      // Button labels/selectors change across ChatGPT UI versions and locales.
      // Enter is the standard submit shortcut when the composer has focus.
      console.warn("Lean ChatGPT Bridge: Send button not found; trying the composer form and Enter shortcut.");
      const form = composer.closest('form');
      if (form && typeof form.requestSubmit === 'function') {
        form.requestSubmit();
      } else {
        pressEnterToSend(composer);
      }
      await sleep(700);
      if (!isGenerating() && assistantMessages().length <= beforeCount) {
        const current = (composer.innerText || composer.value || composer.textContent || "").trim();
        throw new Error(`Could not submit prompt: no enabled Send button and Enter did not start a response (composer has ${current.length} characters).`);
      }
    }
    await reportProgress(jobId, "prompt_sent", { promptChars: prompt.length });
    const response = await waitForFinalAnswer(beforeCount, beforeNode, beforeText, jobId, prompt);
    if (!response) throw new Error("ChatGPT finished without a readable assistant response.");
    return response;
  }

  async function reportProgress(jobId, stage, details = {}) {
    if (!jobId) return;
    try {
      await chrome.runtime.sendMessage({
        type: "JOB_PROGRESS",
        jobId,
        stage,
        details
      });
    } catch (error) {
      // Progress is diagnostic only; a failure to report it must not abort a job.
      console.debug("Lean ChatGPT Bridge: progress update failed", error);
    }
  }

  async function reportError(job, error) {
    try {
      await chrome.runtime.sendMessage({
        type: "JOB_ERROR",
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error)
      });
    } catch (reportFailure) {
      console.error("Lean ChatGPT Bridge: could not report job error", reportFailure);
    }
  }

  async function processJob(job) {
    if (processingJob) return;
    processingJob = true;
    try {
      if (!job || typeof job.id !== "string" || typeof job.prompt !== "string") {
        throw new Error("The local bridge returned an invalid job.");
      }
      await reportProgress(job.id, "job_started", { promptChars: job.prompt.length });
      const response = await sendPromptAndWait(job.prompt, job.id);
      const report = await chrome.runtime.sendMessage({
        type: "JOB_RESULT",
        jobId: job.id,
        response
      });
      if (!report?.ok) throw new Error(report?.error || "Could not deliver the response to the local bridge.");
      console.info(`Lean ChatGPT Bridge: job ${job.id} completed (${response.length} characters).`);
    } catch (error) {
      console.error("Lean ChatGPT Bridge job failed:", error);
      await reportError(job, error);
    } finally {
      processingJob = false;
    }
  }

  async function poll() {
    if (polling || processingJob || document.visibilityState === "prerender") return;
    polling = true;
    let delay = CONNECTED_POLL_MS;
    try {
      const result = await chrome.runtime.sendMessage({ type: "POLL_JOB" });
      if (!result?.ok) {
        delay = DISCONNECTED_POLL_MS;
      } else if (result.job) {
        await processJob(result.job);
      }
    } catch {
      delay = DISCONNECTED_POLL_MS;
    } finally {
      polling = false;
      window.setTimeout(poll, delay);
    }
  }

  console.info("Lean ChatGPT Bridge v1.8.0: prioritize the current ChatGPT assistant-body marker.");
  window.setTimeout(poll, 800);
})();
