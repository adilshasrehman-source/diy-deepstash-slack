// Coach: answers @mentions in Slack threads using Gemini (free tier).
// Cloudflare Worker. Secrets needed: SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, GEMINI_API_KEY
// Optional variable: GEMINI_MODEL (default: gemini-flash-lite-latest)

const SYSTEM_PROMPT = `You are Coach, a friendly guide in a shared Slack workspace.
Members read short daily cards on sales psychology, AI/tech news, GTM automation (Make, n8n, Zapier, Clay, Claude), the UAE job market, and Java (fundamentals and interview questions), then ask you follow-up questions. For Java, give correct, modern code (Java 21+) when it helps.
Rules:
- Answer the question directly first. Keep it short: under 150 words unless asked to go deeper.
- Plain, human, a bit warm. Use simple bullets if it helps. One clear example is enough.
- Explain the idea itself. Do NOT tailor it to anyone's job, work or campaigns. No "for your GTM work", no "line you can use in a brief", no assumptions about who is asking.
- Never use em dashes. No corporate filler.
- If you are not sure about a fact, say so. Never invent stats, quotes or studies.
- Base your answer on the card or messages provided. When someone says "above", "this" or "the article", they mean a card in the context.
- If you can't find the card or item they refer to in the context, do NOT guess. Say you can't see it and ask them to reply inside that card's thread and mention you there.`;

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("Coach is running.");

    const body = await request.text();
    if (!(await verifySlack(request, body, env.SLACK_SIGNING_SECRET))) {
      return new Response("Invalid signature", { status: 401 });
    }

    const payload = JSON.parse(body);

    // Slack checks the URL once when you connect it
    if (payload.type === "url_verification") {
      return new Response(payload.challenge, { headers: { "Content-Type": "text/plain" } });
    }

    // Ignore Slack's automatic retries so we never answer twice
    if (request.headers.get("X-Slack-Retry-Num")) return new Response("ok");

    const event = payload.event;
    if (payload.type === "event_callback" && event?.type === "app_mention" && !event.bot_id) {
      ctx.waitUntil(handleMention(event, env)); // reply to Slack now, do the work after
    }
    return new Response("ok");
  },
};

async function handleMention(event, env) {
  const channel = event.channel;
  const threadTs = event.thread_ts || event.ts;

  try {
    await slack("reactions.add", { channel, timestamp: event.ts, name: "eyes" }, env);

    // Get context: the card's thread, or recent channel messages if asked outside a thread
    let context;
    if (event.thread_ts) {
      const replies = await slack("conversations.replies", { channel, ts: threadTs, limit: 30 }, env, "GET");
      context = `This question was asked in a thread. Thread so far (the first message is the card):\n\n${format(replies.messages)}`;
    } else {
      const hist = await slack("conversations.history", { channel, latest: event.ts, inclusive: false, limit: 8 }, env, "GET");
      context = `This question was asked in the channel, not in a thread. Recent channel messages, oldest first:\n\n${format((hist.messages || []).reverse())}`;
    }

    const question = clean(event.text);
    const prompt = `${context}\n\nQuestion: ${question}`;

    const answer = await askGemini(prompt, env);
    await slack("chat.postMessage", { channel, thread_ts: threadTs, text: toSlack(answer) }, env);
  } catch (err) {
    await slack("chat.postMessage", {
      channel,
      thread_ts: threadTs,
      text: `Sorry, I hit a problem: ${String(err.message || err).slice(0, 200)}`,
    }, env).catch(() => {});
  } finally {
    await slack("reactions.remove", { channel, timestamp: event.ts, name: "eyes" }, env).catch(() => {});
  }
}

async function askGemini(prompt, env) {
  // Flash-Lite is the fastest Gemini model; Cloudflare's free plan stops background work after ~30s
  const model = env.GEMINI_MODEL || "gemini-flash-lite-latest";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 22000);
  let res;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 600 },
        }),
      }
    );
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Gemini took too long. Try asking again.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json();
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${data.error?.message || "unknown error"}`);
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
  if (!text) throw new Error("Gemini returned an empty answer");
  return text;
}

async function slack(method, params, env, httpMethod = "POST") {
  const url = new URL(`https://slack.com/api/${method}`);
  const init = { headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } };
  if (httpMethod === "GET") {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  } else {
    init.method = "POST";
    init.headers["Content-Type"] = "application/json; charset=utf-8";
    init.body = JSON.stringify(params);
  }
  const res = await fetch(url, init);
  const data = await res.json();
  if (!data.ok && data.error !== "already_reacted" && data.error !== "no_reaction") {
    throw new Error(`Slack ${method}: ${data.error}`);
  }
  return data;
}

// Turn Slack messages into readable text, skipping join/system notices
function format(messages = []) {
  return messages
    .filter((m) => !m.subtype || m.subtype === "bot_message" || m.subtype === "thread_broadcast")
    .map((m) => `${m.bot_id ? "Coach" : "Card or member"}: ${clean(m.text)}`)
    .join("\n\n---\n\n") || "(no messages found)";
}

// Remove <@USERID> mentions and tidy whitespace
function clean(text = "") {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

// Gemini writes Markdown; Slack uses *bold* and no # headings
function toSlack(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\s*—\s*/g, ", ");
}

async function verifySlack(request, body, secret) {
  const ts = request.headers.get("X-Slack-Request-Timestamp");
  const sig = request.headers.get("X-Slack-Signature");
  if (!ts || !sig || !secret) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${body}`));
  const expected = "v0=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");

  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}
