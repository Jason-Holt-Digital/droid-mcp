#!/usr/bin/env python3
"""Install or remove the droid-mcp Droid hook on macOS and Linux.

python3 scripts/install_hooks.py --url URL [--token-stdin] [--uninstall] [--home DIR]

The token comes from DROID_MCP_EVENTS_TOKEN, stdin (--token-stdin) or a hidden
prompt. It is written to ~/.factory/droid-mcp/hook.json (mode 600) and never printed.
"""

import argparse
import getpass
import json
import os
import shlex
import shutil
import sys
import tempfile
import time

EVENTS = ("Stop", "Notification", "SessionEnd")
MARKERS = ("droid-mcp/droid_mcp_hook", "droid-mcp\\droid_mcp_hook", "droid-mcp-hook.ps1")
SCRIPT_NAME = "droid_mcp_hook.py"
SOURCE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks", SCRIPT_NAME)
RESTART_NOTE = "Droid snapshots hooks at startup, so new sessions pick this up."


def fail(message):
    print("install_hooks: " + message, file=sys.stderr)
    sys.exit(2)


def is_ours(hook):
    return isinstance(hook, dict) and isinstance(hook.get("command"), str) and any(m in hook["command"] for m in MARKERS)


def group_without_ours(group):
    """Return the group without our commands, or None when only ours were in it."""
    hooks = group.get("hooks") if isinstance(group, dict) else None
    if not isinstance(hooks, list):
        return group
    kept = [h for h in hooks if not is_ours(h)]
    if len(kept) == len(hooks):
        return group
    return dict(group, hooks=kept) if kept else None


def without_ours(config, drop_emptied=True):
    out = {}
    for event, groups in config.items():
        if not isinstance(groups, list):
            out[event] = groups
            continue
        kept = [g for g in map(group_without_ours, groups) if g is not None]
        if kept or not drop_emptied or len(kept) == len(groups):
            out[event] = kept
    return out


def load_hooks(path):
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            config = json.load(f)
    except (OSError, ValueError) as e:
        fail("cannot read %s (%s); left it unchanged" % (path, e))
    if not isinstance(config, dict):
        fail("%s is not a JSON object; left it unchanged" % path)
    return config


def backup(path):
    stamp = time.strftime("%Y%m%d%H%M%S")
    target = "%s.bak-droid-mcp-%s" % (path, stamp)
    n = 1
    while os.path.exists(target):
        target = "%s.bak-droid-mcp-%s-%d" % (path, stamp, n)
        n += 1
    shutil.copy2(path, target)
    return target


def write_atomic(path, text, mode):
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-droid-mcp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def save_hooks(path, before, after):
    """Write `after` if it differs from `before`; return the backup path, '' if new, None if unchanged."""
    if before is not None and before == after:
        return None
    saved = ""
    mode = 0o644
    if before is not None:
        saved = backup(path)
        mode = os.stat(path).st_mode & 0o777
    write_atomic(path, json.dumps(after, indent=2) + "\n", mode)
    return saved


def read_token(from_stdin):
    token = os.environ.get("DROID_MCP_EVENTS_TOKEN", "")
    if not token and from_stdin:
        token = sys.stdin.readline()
    if not token and not from_stdin:
        token = getpass.getpass("droid-mcp events token: ")
    token = token.strip()
    if not token:
        fail("no token (set DROID_MCP_EVENTS_TOKEN, pass --token-stdin, or type it at the prompt)")
    return token


def describe(saved):
    if saved is None:
        return "unchanged"
    return "updated (backup %s)" % saved if saved else "created"


def install(args, dest, hooks_path):
    if not args.url or not args.url.startswith(("http://", "https://")):
        fail("--url must be an http:// or https:// URL")
    if not os.path.isfile(SOURCE):
        fail("hook script not found at " + SOURCE)
    token = read_token(args.token_stdin)
    before = load_hooks(hooks_path)
    os.makedirs(dest, mode=0o700, exist_ok=True)
    os.chmod(dest, 0o700)
    script = os.path.join(dest, SCRIPT_NAME)
    shutil.copyfile(SOURCE, script)
    os.chmod(script, 0o700)
    write_atomic(os.path.join(dest, "hook.json"), json.dumps({"url": args.url, "token": token}) + "\n", 0o600)
    # A versioned interpreter path breaks on the next Python upgrade, so prefer the stable python3 on PATH.
    python = shutil.which("python3") or os.path.abspath(sys.executable)
    command = shlex.quote(python) + " " + shlex.quote(script)
    after = without_ours(before or {}, drop_emptied=False)
    for event in EVENTS:
        groups = after.get(event)
        if not isinstance(groups, list):
            groups = []
        after[event] = groups + [{"hooks": [{"type": "command", "command": command, "timeout": 5}]}]
    saved = save_hooks(hooks_path, before, after)
    print(
        "droid-mcp hook installed in %s for %s; %s %s. %s"
        % (dest, ", ".join(EVENTS), hooks_path, describe(saved), RESTART_NOTE)
    )


def uninstall(dest, hooks_path):
    before = load_hooks(hooks_path)
    saved = save_hooks(hooks_path, before, without_ours(before)) if before is not None else None
    shutil.rmtree(dest, ignore_errors=True)
    print("droid-mcp hook removed from %s; %s %s. %s" % (dest, hooks_path, describe(saved), RESTART_NOTE))


def main():
    parser = argparse.ArgumentParser(description="Install or remove the droid-mcp Droid hook.")
    parser.add_argument("--url", help="droid-mcp POST /events URL")
    parser.add_argument("--token-stdin", action="store_true", help="read the token from stdin")
    parser.add_argument("--uninstall", action="store_true", help="remove the hook")
    parser.add_argument("--home", help="home directory to use instead of ~")
    args = parser.parse_args()
    home = os.path.abspath(args.home or os.path.expanduser("~"))
    factory = os.path.join(home, ".factory")
    dest = os.path.join(factory, "droid-mcp")
    hooks_path = os.path.join(factory, "hooks.json")
    if args.uninstall:
        uninstall(dest, hooks_path)
    else:
        install(args, dest, hooks_path)


if __name__ == "__main__":
    main()
