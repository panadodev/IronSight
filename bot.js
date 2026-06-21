import "dotenv/config";

const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!TOKEN) {
  console.error("DISCORD_BOT_TOKEN is not set");
  process.exit(1);
}

const DISCORD_API = "https://discord.com/api/v10";
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const API_URL = process.env.API_URL ?? "http://localhost:3000";

const INTENT_GUILD_MEMBERS = 1 << 1;
const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_MESSAGE_CONTENT = 1 << 15;

const DM_MESSAGE =
  "👋 **IronSight Notice**\n\n" +
  "This server uses **IronSight**, a staff moderation panel for Rust game servers. " +
  "Staff members may review Discord messages and take moderation actions " +
  "(timeouts, kicks, bans) through the panel.\n\n" +
  "**What we collect:** Messages sent in this server are stored for up to 30 days " +
  "for moderation review, then permanently deleted. Your Discord ID and username " +
  "are stored as long as you remain a member.\n\n" +
  "**Privacy Policy:** https://ironsight.panado.dev/privacy\n\n" +
  "_If you have questions, contact a server administrator._";

let ws;
let heartbeatTimer;
let sessionId = null;
let resumeGatewayUrl = null;
let seq = null;
let acked = true;
let reconnecting = false;

function send(data) {
  ws.send(JSON.stringify(data));
}

function reconnect(resume = false) {
  if (reconnecting) return;
  reconnecting = true;
  clearInterval(heartbeatTimer);
  console.log(`[IronSight Bot] Reconnecting in 5s (resume=${resume})`);
  try {
    ws.close();
  } catch {}
  setTimeout(() => {
    reconnecting = false;
    connect(resume);
  }, 5000);
}

function heartbeat() {
  if (!acked) {
    console.warn(
      "[IronSight Bot] Heartbeat not acknowledged — zombie connection, reconnecting",
    );
    reconnect(true);
    return;
  }
  acked = false;
  send({ op: 1, d: seq });
}

async function dmUser(userId) {
  const chRes = await fetch(`${DISCORD_API}/users/@me/channels`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recipient_id: userId }),
  });
  if (!chRes.ok) return;
  const { id: channelId } = await chRes.json();

  await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content: DM_MESSAGE }),
  });
}

function connect(resume = false) {
  const url = resume && resumeGatewayUrl ? resumeGatewayUrl : GATEWAY_URL;
  console.log(`[IronSight Bot] Connecting to gateway (resume=${resume})`);
  const socket = new WebSocket(url);
  ws = socket;

  socket.addEventListener("open", () => {
    if (resume && sessionId) {
      console.log("[IronSight Bot] Sending RESUME");
      socket.send(JSON.stringify({ op: 6, d: { token: TOKEN, session_id: sessionId, seq } }));
    }
  });

  socket.addEventListener("message", async ({ data }) => {
    const { op, d, s, t } = JSON.parse(data);
    if (s != null) seq = s;

    switch (op) {
      case 10: // HELLO
        clearInterval(heartbeatTimer);
        acked = true;
        heartbeatTimer = setInterval(heartbeat, d.heartbeat_interval);
        if (!resume || !sessionId) {
          console.log("[IronSight Bot] Sending IDENTIFY");
          send({
            op: 2, // IDENTIFY
            d: {
              token: TOKEN,
              intents:
                INTENT_GUILD_MEMBERS |
                INTENT_GUILD_MESSAGES |
                INTENT_MESSAGE_CONTENT,
              properties: {
                os: "linux",
                browser: "ironsight",
                device: "ironsight",
              },
            },
          });
        }
        break;

      case 11: // HEARTBEAT ACK
        acked = true;
        break;

      case 7: // RECONNECT
        reconnect(true);
        break;

      case 9: // INVALID SESSION — d indicates if resumable
        if (!d) {
          sessionId = null;
          seq = null;
        }
        setTimeout(() => connect(!!d), 5000);
        break;

      case 0: // DISPATCH
        if (t === "READY") {
          sessionId = d.session_id;
          resumeGatewayUrl = d.resume_gateway_url;
          console.log(`[IronSight Bot] Ready as ${d.user.username}`);
        } else if (t === "RESUMED") {
          console.log("[IronSight Bot] Session resumed");
        } else if (t === "GUILD_MEMBER_ADD") {
          if (!d.user?.bot) {
            console.log(
              `[IronSight Bot] New member: ${d.user.username} (${d.user.id}) in guild ${d.guild_id}`,
            );
            dmUser(d.user.id).catch((err) =>
              console.error(`[IronSight Bot] DM failed for ${d.user.id}:`, err),
            );
          }
        } else if (t === "MESSAGE_CREATE") {
          if (d.guild_id && !d.author?.bot && !d.webhook_id) {
            fetch(`${API_URL}/api/internal/discord/message`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bot ${TOKEN}`,
              },
              body: JSON.stringify({
                messageId: d.id,
                guildId: d.guild_id,
                channelId: d.channel_id,
                channelName: "",
                authorId: d.author.id,
                authorUsername: d.author.global_name ?? d.author.username,
                content: d.content ?? "",
                attachments: d.attachments ?? [],
                timestamp: d.timestamp,
              }),
            }).then((r) => {
              if (!r.ok) console.warn(`[IronSight Bot] Ingest failed (${r.status}) for message ${d.id}`);
            }).catch((err) =>
              console.error(`[IronSight Bot] Ingest error for message ${d.id}:`, err.message),
            );
          }
        }
        break;
    }
  });

  socket.addEventListener("close", ({ code }) => {
    clearInterval(heartbeatTimer);
    console.log(`[IronSight Bot] Gateway closed (code ${code})`);
    if (code === 4004) {
      console.error("[IronSight Bot] Invalid token — exiting");
      process.exit(1);
    }
    if (code === 4014) {
      console.error(
        "[IronSight Bot] GUILD_MEMBERS intent not approved in the Developer Portal — exiting",
      );
      process.exit(1);
    }
    if (!reconnecting) {
      reconnect(code !== 4007 && code !== 4009);
    }
  });

  socket.addEventListener("error", (err) =>
    console.error("[IronSight Bot] WebSocket error:", err),
  );
}

connect();
