#!/usr/bin/env python3
"""Submit a prompt to the local bridge and print ChatGPT's complete response."""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

BASE_URL = "http://127.0.0.1:8765"


class BridgeError(RuntimeError):
    pass


class BridgeClient:
    def __init__(self, base_url: str = BASE_URL):
        self.base_url = base_url.rstrip("/")

    def _request(self, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self.base_url + path,
            data=data,
            headers={"Content-Type": "application/json; charset=utf-8"} if data is not None else {},
            method="POST" if data is not None else "GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            try:
                detail = json.loads(body).get("error", body)
            except json.JSONDecodeError:
                detail = body
            raise BridgeError(f"Bridge HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise BridgeError(
                f"Cannot reach {self.base_url}. Start the bridge with `python bridge.py`."
            ) from exc
        try:
            return json.loads(raw) if raw else {}
        except json.JSONDecodeError as exc:
            raise BridgeError("The bridge returned invalid JSON.") from exc

    def health(self) -> dict[str, Any]:
        return self._request("/health")

    def submit(self, prompt: str) -> str:
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError("prompt must be a non-empty string")
        return str(self._request("/jobs", {"prompt": prompt})["id"])

    def get_job(self, job_id: str) -> dict[str, Any]:
        return self._request(f"/jobs/{job_id}")["job"]

    def wait(self, job_id: str, timeout: float = 600, poll_interval: float = 1.0) -> str:
        deadline = time.monotonic() + timeout
        while True:
            job = self.get_job(job_id)
            if job["status"] == "done":
                return str(job.get("response", ""))
            if job["status"] == "error":
                raise BridgeError(f"Extension failed: {job.get('error', 'unknown error')}")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                progress = job.get("progress") or {}
                stage = progress.get("stage", "no extension progress received")
                details = progress.get("details", {})
                updated_at = progress.get("updated_at")
                age_text = ""
                if isinstance(updated_at, (int, float)):
                    age_text = f"; progress updated {max(0, int(time.time() - updated_at))}s ago"
                details_text = json.dumps(details, ensure_ascii=False, sort_keys=True)
                advice = ""
                if stage == "waiting_for_answer":
                    if details.get("generating") is False and details.get("assistantMessages") == 0:
                        advice = " ChatGPT is not detected as generating, but the extension found no assistant message; this is a DOM-selector issue, not a reason to increase --timeout."
                    elif details.get("assistantMessages", 0) > 0 and details.get("currentTextChars", 0) == 0:
                        advice = " The extension sees assistant nodes but extracts no text; the DOM text selector needs adjustment."
                    else:
                        advice = " ChatGPT may still be generating; allow more time only if the progress details support that."
                raise TimeoutError(
                    f"Timed out waiting for job {job_id}; status={job['status']}; "
                    f"last extension stage={stage}{age_text}; details={details_text}.{advice}"
                )
            time.sleep(min(poll_interval, remaining))

    def ask(self, prompt: str, timeout: float = 600) -> str:
        return self.wait(self.submit(prompt), timeout=timeout)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--prompt", help="Prompt text to send")
    source.add_argument("--file", type=Path, help="Read the prompt from a UTF-8 text file")
    parser.add_argument("--timeout", type=float, default=600, help="Maximum wait in seconds (default: 600)")
    parser.add_argument("--output", type=Path, help="Also write the response to this UTF-8 file")
    parser.add_argument("--base-url", default=BASE_URL, help="Bridge base URL")
    args = parser.parse_args()

    try:
        prompt = args.prompt if args.prompt is not None else args.file.read_text(encoding="utf-8")
        response = BridgeClient(args.base_url).ask(prompt, timeout=args.timeout)
    except (OSError, BridgeError, TimeoutError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    if args.output:
        args.output.write_text(response, encoding="utf-8")
    sys.stdout.write(response)
    if not response.endswith("\n"):
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
