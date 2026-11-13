#!/usr/bin/env python3
"""Droid hook that posts a compact session event to droid-mcp's POST /events.

Python 3 stdlib only. Never prints and always exits 0: Droid shows hook stdout
in transcripts and waits for the hook to finish.
"""

import json
import os
import socket
import sys
import urllib.request

TAIL_BYTES = 512 * 1024
TIMEOUT_S = 3
TRANSCRIPT_SUFFIX = ".jsonl"


def home_dir():
    return os.environ.get("DROID_MCP_HOOK_HOME") or os.path.expanduser("~")


def read_json(path):
    try:
        with open(path, "rb") as f:
            return json.loads(f.read().decode("utf-8"))
    except Exception:
        return None


def string(value):
    return value if isinstance(value, str) else ""


def load_config(home):
    cfg = read_json(os.path.join(home, ".factory", "droid-mcp", "hook.json"))
    if not isinstance(cfg, dict):
        return None
    url, token = string(cfg.get("url")), string(cfg.get("token"))
    if not url.startswith(("http://", "https://")) or not token:
        return None
    return url, token


def classify(event):
    name = event.get("hook_event_name")
    if name == "Stop":
        return "stop", ""
    if name == "Notification":
        kind = {"permission_prompt": "permission", "elicitation_dialog": "question"}.get(event.get("notification_type"))
        return (kind, string(event.get("message"))) if kind else None
    if name == "SessionEnd":
        return "ended", string(event.get("reason"))
    return None


def text_of(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = [b.get("text") for b in content if isinstance(b, dict) and b.get("type") == "text"]
    return "\n".join(p for p in parts if isinstance(p, str))


def last_assistant_text(path):
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            start = max(0, f.tell() - TAIL_BYTES)
            f.seek(start)
            data = f.read()
    except Exception:
        return ""
    lines = data.split(b"\n")
    if start > 0:
        lines = lines[1:]  # starts mid-line
    for raw in reversed(lines):
        if b'"type":"message"' not in raw:
            continue
        try:
            entry = json.loads(raw.decode("utf-8", "replace"))
        except Exception:
            continue
        msg = entry.get("message") if isinstance(entry, dict) else None
        if not isinstance(msg, dict) or msg.get("role") != "assistant":
            continue
        text = text_of(msg.get("content"))
        if text.strip():
            return text
    return ""


def stop_event(text):
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if line.lstrip().startswith("QUESTION:"):
            return "question", "\n".join(lines[i:]).strip()
    return "finished", text.strip()[-300:]


def read_header(path):
    try:
        with open(path, "rb") as f:
            header = json.loads(f.readline(1 << 20).decode("utf-8"))
        return header if isinstance(header, dict) else {}
    except Exception:
        return {}


def read_tags(transcript):
    if not transcript.endswith(TRANSCRIPT_SUFFIX):
        return []
    settings = read_json(transcript[: -len(TRANSCRIPT_SUFFIX)] + ".settings.json")
    tags = settings.get("tags") if isinstance(settings, dict) else None
    if not isinstance(tags, list):
        return []
    names = [t.get("name") for t in tags if isinstance(t, dict)]
    return [n for n in names if isinstance(n, str) and n][:20]


def build_payload(event, kind, text, home):
    transcript = string(event.get("transcript_path"))
    if kind == "stop":
        kind, text = stop_event(last_assistant_text(transcript))
    header = read_header(transcript) if transcript else {}
    payload = {}
    computer = read_json(os.path.join(home, ".factory", "computer.json"))
    computer_id = computer.get("computerId") if isinstance(computer, dict) else None
    if isinstance(computer_id, str) and computer_id:
        payload["computerId"] = computer_id
    payload.update(
        host=socket.gethostname(),
        sessionId=string(event.get("session_id")),
        kind=kind,
        title=string(header.get("title"))[:200],
        text=text[:1000],
        cwd=(string(event.get("cwd")) or string(header.get("cwd")))[:500],
        tags=read_tags(transcript) if transcript else [],
    )
    return payload


def deliver(event, kind, text, home, url, token):
    try:
        body = json.dumps(build_payload(event, kind, text, home), separators=(",", ":"), ensure_ascii=False)
        req = urllib.request.Request(
            url,
            data=body.encode("utf-8"),
            method="POST",
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            resp.read(65536)
    except Exception:
        pass


def detach():
    # Droid waits until every holder of the hook's stdio pipes closes them, so the
    # child must leave the session and drop the inherited descriptors.
    os.setsid()
    null = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(null, fd)
    if null > 2:
        os.close(null)


def main():
    try:
        event = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    except Exception:
        return
    if not isinstance(event, dict):
        return
    classified = classify(event)
    if not classified:
        return
    home = home_dir()
    cfg = load_config(home)
    if not cfg:
        return
    kind, text = classified
    if hasattr(os, "fork"):
        try:
            pid = os.fork()
        except OSError:
            pid = -1
        if pid > 0:
            return
        if pid == 0:
            try:
                detach()
                deliver(event, kind, text, home, *cfg)
            finally:
                os._exit(0)
    deliver(event, kind, text, home, *cfg)


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        pass
    os._exit(0)
