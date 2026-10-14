#!/usr/bin/env python3
"""Local HTTP queue for the Lean ChatGPT Bridge. Uses only the Python stdlib."""
from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

HOST = "127.0.0.1"
PORT = 8765

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

lock = threading.RLock()
queue: deque[str] = deque()
jobs: dict[str, dict[str, Any]] = {}


def public_job(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": job["id"],
        "prompt": job["prompt"],
        "status": job["status"],
        "created_at": job["created_at"],
        "started_at": job.get("started_at"),
        "finished_at": job.get("finished_at"),
        "response": job.get("response"),
        "error": job.get("error"),
        "progress": job.get("progress"),
    }


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = "LeanChatGPTBridge/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        logging.info("%s - %s", self.address_string(), fmt % args)

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.end_headers()

    def send_json(self, status: int, data: dict[str, Any]) -> None:
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Invalid Content-Length.") from exc
        if length <= 0:
            raise ValueError("Expected a JSON request body.")
        if length > 20 * 1024 * 1024:
            raise ValueError("Request body exceeds 20 MiB.")
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("Request body is not valid UTF-8 JSON.") from exc
        if not isinstance(data, dict):
            raise ValueError("JSON body must be an object.")
        return data

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/health":
            with lock:
                queued = sum(1 for job in jobs.values() if job["status"] == "queued")
                running = sum(1 for job in jobs.values() if job["status"] == "running")
            self.send_json(200, {"ok": True, "queued": queued, "running": running})
            return

        if path == "/next":
            with lock:
                while queue:
                    job_id = queue.popleft()
                    job = jobs.get(job_id)
                    if not job or job["status"] != "queued":
                        continue
                    job["status"] = "running"
                    job["started_at"] = time.time()
                    job["progress"] = {
                        "stage": "job_claimed",
                        "details": {"message": "A ChatGPT tab claimed this prompt."},
                        "updated_at": time.time(),
                    }
                    logging.info("Job %s claimed by extension", job_id)
                    self.send_json(200, {"job": {"id": job["id"], "prompt": job["prompt"]}})
                    return
            self.send_json(200, {"job": None})
            return

        if path.startswith("/jobs/"):
            job_id = path.removeprefix("/jobs/")
            with lock:
                job = jobs.get(job_id)
                if job is None:
                    self.send_json(404, {"error": "Unknown job ID."})
                else:
                    self.send_json(200, {"job": public_job(job)})
            return

        self.send_json(404, {"error": "Unknown endpoint."})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            body = self.read_json()
        except ValueError as exc:
            self.send_json(400, {"error": str(exc)})
            return

        if path == "/jobs":
            prompt = body.get("prompt")
            if not isinstance(prompt, str) or not prompt.strip():
                self.send_json(400, {"error": "'prompt' must be a non-empty string."})
                return
            job_id = str(uuid.uuid4())
            created_at = time.time()
            job = {
                "id": job_id,
                "prompt": prompt,
                "status": "queued",
                "created_at": created_at,
                "progress": {
                    "stage": "queued",
                    "details": {"message": "Waiting for the ChatGPT extension."},
                    "updated_at": created_at,
                },
            }
            with lock:
                jobs[job_id] = job
                queue.append(job_id)
            logging.info("Queued job %s (%d prompt characters)", job_id, len(prompt))
            self.send_json(201, {"id": job_id, "status": "queued"})
            return

        if path == "/progress":
            job_id = body.get("id")
            stage = body.get("stage")
            details = body.get("details", {})
            if not isinstance(job_id, str) or not isinstance(stage, str) or not stage.strip():
                self.send_json(400, {"error": "Expected string fields 'id' and 'stage'."})
                return
            if not isinstance(details, (dict, str, int, float, bool, type(None))):
                self.send_json(400, {"error": "'details' must be JSON data."})
                return
            with lock:
                job = jobs.get(job_id)
                if job is None:
                    self.send_json(404, {"error": "Unknown job ID."})
                    return
                if job["status"] in ("done", "error"):
                    self.send_json(409, {"error": "This job already has a final result."})
                    return
                job["progress"] = {
                    "stage": stage.strip()[:100],
                    "details": details,
                    "updated_at": time.time(),
                }
                logging.info("Job %s progress: %s %s", job_id, job["progress"]["stage"], json.dumps(details, ensure_ascii=False)[:300])
                self.send_json(200, {"ok": True, "status": job["status"]})
            return

        if path == "/result":
            job_id = body.get("id")
            if not isinstance(job_id, str):
                self.send_json(400, {"error": "'id' must be a string."})
                return
            with lock:
                job = jobs.get(job_id)
                if job is None:
                    self.send_json(404, {"error": "Unknown job ID."})
                    return
                if job["status"] in ("done", "error"):
                    self.send_json(409, {"error": "This job already has a final result."})
                    return
                if isinstance(body.get("response"), str):
                    job["response"] = body["response"]
                    job["status"] = "done"
                    job["progress"] = {
                        "stage": "done",
                        "details": {"responseChars": len(body["response"])},
                        "updated_at": time.time(),
                    }
                elif isinstance(body.get("error"), str):
                    job["error"] = body["error"]
                    job["status"] = "error"
                    job["progress"] = {
                        "stage": "error",
                        "details": {"message": body["error"][:1000]},
                        "updated_at": time.time(),
                    }
                else:
                    self.send_json(400, {"error": "Expected a string 'response' or 'error'."})
                    return
                job["finished_at"] = time.time()
                logging.info("Job %s finished with status %s", job_id, job["status"])
                self.send_json(200, {"ok": True, "status": job["status"]})
            return

        self.send_json(404, {"error": "Unknown endpoint."})


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), BridgeHandler)
    logging.info("Listening on http://%s:%d", HOST, PORT)
    logging.info("Keep this process running while using the Chrome extension.")
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        logging.info("Shutting down.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
