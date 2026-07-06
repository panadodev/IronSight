// Low-level RCON WebSocket command execution against Rust game servers.
// Pure relocation from api.js; no DB/Redis/env deps.

export function executeRconCommand(rconUrl, command) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let commandSent = false;
    const consoleLogs = [];

    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };

    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      settle(reject, new Error("RCON connection timed out"));
    }, 10000);

    const ws = new WebSocket(rconUrl);
    const requestId = Math.floor(Math.random() * 100000) + 1;

    ws.addEventListener("open", () => {
      commandSent = true;
      ws.send(
        JSON.stringify({
          Identifier: requestId,
          Message: command,
          Name: "WebRcon",
        }),
      );
    });

    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.Identifier === requestId) {
          settle(resolve, { response: String(msg.Message ?? ""), consoleLogs });
          try {
            ws.close(1000, "Done");
          } catch {
            /* noop */
          }
        } else if (msg.Identifier === -1 && commandSent) {
          consoleLogs.push(String(msg.Message ?? ""));
        }
      } catch {
        // ignore non-JSON messages
      }
    });

    ws.addEventListener("error", (event) => {
      const detail =
        event?.message || event?.error?.message || event?.error?.code || "";
      settle(
        reject,
        new Error(
          detail
            ? `RCON connection failed: ${detail}`
            : "RCON connection failed",
        ),
      );
    });

    ws.addEventListener("close", ({ code }) => {
      if (code !== 1000 && code !== 1001) {
        settle(reject, new Error(`RCON disconnected (${code})`));
      }
    });
  });
}

// Run several commands over a SINGLE RCON connection, sequentially. Rust's
// WebRcon refuses rapid reconnects, so opening one socket per command (as the
// single-shot helper does) is unreliable when issuing many commands in a burst.
// Admin-provisioning commands (moderatorid / usergroup) don't need their output,
// so we fire each, give the server a brief moment, then close cleanly.
export function executeRconCommandSequence(rconUrl, commands) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      settle(reject, new Error("RCON connection timed out"));
    }, 10000);

    const ws = new WebSocket(rconUrl);

    ws.addEventListener("open", () => {
      try {
        commands.forEach((cmd, i) => {
          ws.send(
            JSON.stringify({
              Identifier: 2000 + i,
              Message: cmd,
              Name: "WebRcon",
            }),
          );
        });
      } catch (err) {
        settle(reject, err instanceof Error ? err : new Error(String(err)));
        return;
      }
      // Let the server process the queued commands before closing.
      setTimeout(() => {
        try {
          ws.close(1000, "Done");
        } catch {
          /* noop */
        }
        settle(resolve, true);
      }, 750);
    });

    ws.addEventListener("error", (event) => {
      const detail =
        event?.message || event?.error?.message || event?.error?.code || "";
      settle(
        reject,
        new Error(
          detail
            ? `RCON connection failed: ${detail}`
            : "RCON connection failed",
        ),
      );
    });

    ws.addEventListener("close", ({ code }) => {
      if (code !== 1000 && code !== 1001) {
        settle(reject, new Error(`RCON disconnected (${code})`));
      }
    });
  });
}
