# Running as a service

Run droid-mcp over HTTP when your agent is on another computer, or when you want wake-ups. Only HTTP mode has the `/events` endpoint the plugin rings.

## HTTP mode

Generate a token and start the server:

```sh
openssl rand -hex 32
DROID_MCP_TOKEN=<token> node src/main.ts --http 127.0.0.1:37999
```

`--http` refuses to start without `DROID_MCP_TOKEN`. Every MCP request must send `Authorization: Bearer <token>`. The server answers MCP on any path except `POST /events`, so use `http://127.0.0.1:37999/mcp` as the endpoint:

```sh
droid mcp add droid-mcp http://127.0.0.1:37999/mcp --type http --header "Authorization: Bearer <token>"
claude mcp add --transport http droid-mcp http://127.0.0.1:37999/mcp -H "Authorization: Bearer <token>"
```

A request with an `Origin` header gets 403, so browsers cannot call the server. Each request gets a fresh MCP server; sessions, subscriptions and the event log are shared across requests. At startup droid-mcp removes `DROID_MCP_TOKEN`, `DROID_MCP_EVENTS_TOKEN` and `DROID_MCP_WEBHOOK_KEY` from its environment, so the sessions it starts do not inherit them.

Treat `DROID_MCP_TOKEN` like a password: it grants every tool.

Many service managers start programs with a minimal `PATH`. droid-mcp needs `droid`, `git` and `rg` on it, so set `PATH` in each setup below.

On macOS, `FACTORY_API_KEY`, `DROID_MCP_WEBHOOK_URL` and `DROID_MCP_WEBHOOK_KEY` can live in the Keychain instead of the environment. On Linux and Windows they must come from the environment. See [Configuration](tools.md#configuration).

## macOS (launchd)

Tested on macOS.

Create the directory, readable only by you:

```sh
mkdir -p -m 700 ~/.droid-mcp
```

Create `~/.droid-mcp/run.sh`:

```sh
#!/bin/sh
export PATH=/path/to/bin:/usr/bin:/bin
export DROID_MCP_TOKEN=<token>
cd /path/to/droid-mcp
exec node src/main.ts --http 127.0.0.1:37999
```

Make it executable and private, so the token is not readable by others:

```sh
chmod 700 ~/.droid-mcp/run.sh
```

Create `~/Library/LaunchAgents/com.example.droid-mcp.plist`. launchd does not expand `~`, so use full paths:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.droid-mcp</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/<you>/.droid-mcp/run.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>/Users/<you>/.droid-mcp/server.log</string>
</dict>
</plist>
```

Load it, and restart it after changes:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.droid-mcp.plist
launchctl kickstart -k gui/$(id -u)/com.example.droid-mcp
```

## Linux (systemd user unit)

Unverified on Linux. Treat this as a starting point.

Create the directory, and make sure only you can read it even if it existed:

```sh
mkdir -p ~/.droid-mcp && chmod 700 ~/.droid-mcp
umask 077
```

Put the environment in `~/.droid-mcp/env`. Leave out the key lines you do not use:

```sh
PATH=/path/to/bin:/usr/bin:/bin
DROID_MCP_TOKEN=<token>
FACTORY_API_KEY=<key>
DROID_MCP_WEBHOOK_URL=<url>
DROID_MCP_WEBHOOK_KEY=<key>
```

```sh
chmod 600 ~/.droid-mcp/env
mkdir -p ~/.config/systemd/user
```

Create `~/.config/systemd/user/droid-mcp.service`:

```ini
[Unit]
Description=droid-mcp

[Service]
EnvironmentFile=%h/.droid-mcp/env
WorkingDirectory=/path/to/droid-mcp
ExecStart=/path/to/node /path/to/droid-mcp/src/main.ts --http 127.0.0.1:37999
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now droid-mcp
```

A user unit stops when you log out unless lingering is on (`loginctl enable-linger`).

## Windows (Task Scheduler)

Unverified on Windows. Treat this as a starting point.

Create `%USERPROFILE%\.droid-mcp\run.cmd`, and make it readable only by you, since it holds the token:

```bat
@echo off
set PATH=C:\path\to\bin;%PATH%
set DROID_MCP_TOKEN=<token>
set FACTORY_API_KEY=<key>
cd /d C:\path\to\droid-mcp
node src\main.ts --http 127.0.0.1:37999 2>> "%USERPROFILE%\.droid-mcp\server.log"
```

Register it to start when you log on:

```bat
schtasks /Create /TN droid-mcp /SC ONLOGON /TR "\"%USERPROFILE%\.droid-mcp\run.cmd\""
schtasks /Run /TN droid-mcp
```

`DROID_MCP_ROOTS` is split on `:`, which collides with drive letters such as `C:\`. Windows roots are unverified.

## Reach it from other computers

Put the server behind `tailscale serve`:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:37999
```

The MCP endpoint is then `https://<host>.<tailnet>.ts.net:8443/mcp`, and the bearer token is still required. For wake-ups, set `DROID_MCP_EVENTS_URL=https://<host>.<tailnet>.ts.net:8443/events` so `droid_setup` and the paste line give other computers an address they can reach. A Factory cloud computer needs a network route to that URL too.

Behind a proxy, every ring arrives from the proxy's address and shares its limit of 60 rings a minute. The `x-droid-mcp-computer` header in each curlrc still tells computers apart. See [Wake-ups](wake-ups.md).
