// chat.ts
import { Router, Request, Response } from "express";

const RAW_BASE = process.env.GRADIENT_API_URL || "https://inference.do-ai.run";
// Normalize & detect mode
const BASE = RAW_BASE.replace(/\/+$/, "").replace(/\/(api|v1)$/, "");
const IS_AGENT = /\.agents\.do-ai\.run$/.test(new URL(BASE).host);
const CHAT_PATH = IS_AGENT
  ? "/api/v1/chat/completions"
  : "/v1/chat/completions";
const URL_CHAT = `${BASE}${CHAT_PATH}`;

const API_KEY =
  process.env.DIGITALOCEAN_AGENT_KEY || process.env.DIGITALOCEAN_INFERENCE_KEY;
// Optional; agents usually ignore `model`
const MODEL = process.env.GRADIENT_MODEL || "meta-llama/llama-3.1-70b-instruct";

console.log("[gradient] URL_CHAT =", URL_CHAT); // should print: https://<agent>.agents.do-ai.run/api/v1/chat/completions
console.log(
  "[gradient] using key =",
  process.env.DIGITALOCEAN_AGENT_KEY ? "AGENT_KEY" : "MISSING"
);

function compactSnapshot(s: any) {
  const topN = (a: any[], n: number) => (Array.isArray(a) ? a.slice(0, n) : []);
  return {
    generatedAt: s?.generatedAt,
    profile: s?.profile && {
      id: s.profile.id,
      displayName: s.profile.displayName,
      country: s.profile.country,
    },
    topTracks: topN(s?.topTracks || [], 25).map((t: any) => ({
      id: t.id,
      name: t.name,
      uri: t.uri,
      artists: t.artists,
    })),
    topArtists: topN(s?.topArtists || [], 20).map((a: any) => ({
      id: a.id,
      name: a.name,
      genres: a.genres,
      popularity: a.popularity,
    })),
    recent: topN(s?.recent || [], 20).map((r: any) => ({
      played_at: r.played_at,
      id: r.id,
      name: r.name,
      artists: r.artists,
    })),
  };
}

export function chatRouter() {
  const router = Router();

  router.get("/test", async (_req, res) => {
    try {
      const r = await fetch(URL_CHAT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Say 'pong' only." }],
          temperature: 0,
        }),
      });
      const text = await r.text();
      res.status(r.status).type("application/json").send(text);
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "test failed" });
    }
  });

  router.post("/", async (req: Request, res: Response) => {
    try {
      const { question, snapshot } = req.body || {};
      if (!question || !snapshot)
        return res.status(400).json({ error: "Missing question or snapshot" });
      if (!API_KEY)
        return res
          .status(500)
          .json({ error: "Missing DIGITALOCEAN_AGENT_KEY (or INFERENCE_KEY)" });

      const slim = compactSnapshot(snapshot);

      const r = await fetch(URL_CHAT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // Agents typically ignore 'model', but harmless to include:
          model: MODEL,
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content:
                "You are a friendly music analyst. Use ONLY the JSON snapshot provided.",
            },
            {
              role: "user",
              content: `SNAPSHOT:
\`\`\`json
${JSON.stringify(slim)}
\`\`\`
QUESTION: ${question}`,
            },
          ],
        }),
      });

      const text = await r.text();
      if (!r.ok) return res.status(r.status).json({ error: text });
      const json = JSON.parse(text);
      res.json({ answer: json.choices?.[0]?.message?.content ?? "" });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "chat failed" });
    }
  });

  return router;
}
