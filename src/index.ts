// server/index.ts
import dotenv from "dotenv";
dotenv.config({ path: ".env" });

import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import crypto from "crypto";

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REDIRECT_URI,
  SESSION_SECRET,
} = process.env;

if (!SESSION_SECRET) throw new Error("SESSION_SECRET is required");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());
app.use(cors({ origin: "http://127.0.0.1:4200", credentials: true }));

const SPOTIFY_AUTH = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN = "https://accounts.spotify.com/api/token";
const SPOTIFY_API = "https://api.spotify.com/v1";

const SCOPES = [
  "user-read-email",
  "user-top-read",
  "user-read-recently-played",
  "playlist-modify-private",
].join(" ");

const ACCESS_MS = 60 * 60 * 1000;
const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;

const baseCookieOpts = (req: express.Request) => ({
  httpOnly: true as const,
  sameSite: "lax" as const,
  secure: req.protocol === "https", // false on http://127.0.0.1
  path: "/",
});

// --- Stateless signed state helpers ---
type StatePayload = { n: string; rt?: string; exp: number };

function signState(p: StatePayload) {
  const body = Buffer.from(JSON.stringify(p)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", SESSION_SECRET!)
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}
function verifyState(state: string | undefined): StatePayload | null {
  if (!state) return null;
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const expected = crypto
    .createHmac("sha256", SESSION_SECRET!)
    .update(body)
    .digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
    return null;
  const payload = JSON.parse(
    Buffer.from(body, "base64url").toString("utf8")
  ) as StatePayload;
  if (Date.now() > payload.exp) return null;
  return payload;
}

// --- OAuth start ---
app.get("/auth/login", (req, res) => {
  const nonce = crypto.randomBytes(16).toString("hex");
  const returnTo =
    (req.query.return_to as string | undefined) || "http://127.0.0.1:4200";
  const payload: StatePayload = {
    n: nonce,
    rt: returnTo,
    exp: Date.now() + 10 * 60 * 1000,
  };
  const state = signState(payload);

  const url = new URL(SPOTIFY_AUTH);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", SPOTIFY_CLIENT_ID!);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("redirect_uri", SPOTIFY_REDIRECT_URI!);
  url.searchParams.set("state", state);

  res.redirect(url.toString());
});

// --- OAuth callback (verify stateless state, no cookie needed) ---
app.get("/auth/callback", async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };
  const verified = verifyState(state);

  if (!code || !verified) {
    return res.status(400).send("State mismatch or missing code.");
  }

  // Exchange code for tokens
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: SPOTIFY_REDIRECT_URI!,
    client_id: SPOTIFY_CLIENT_ID!,
    client_secret: SPOTIFY_CLIENT_SECRET!,
  });

  const r = await fetch(SPOTIFY_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok)
    return res.status(500).send(`Token exchange failed: ${await r.text()}`);
  const tokens: any = await r.json();
  console.log("[spotify] granted scopes:", tokens.scope);

  if (tokens.access_token)
    res.cookie("spotify_access_token", tokens.access_token, {
      ...baseCookieOpts(req),
      maxAge: ACCESS_MS,
    });
  if (tokens.refresh_token)
    res.cookie("spotify_refresh_token", tokens.refresh_token, {
      ...baseCookieOpts(req),
      maxAge: REFRESH_MS,
    });

  return res.redirect(verified.rt || "/connected");
});

// --- Refresh & proxy helpers (unchanged patterns) ---
async function refreshAccessToken(req: express.Request, res: express.Response) {
  const refresh_token = req.cookies["spotify_refresh_token"];
  if (!refresh_token) return null;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token,
    client_id: SPOTIFY_CLIENT_ID!,
    client_secret: SPOTIFY_CLIENT_SECRET!,
  });

  const r = await fetch(SPOTIFY_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) return null;

  const json: any = await r.json();
  if (json.access_token)
    res.cookie("spotify_access_token", json.access_token, {
      ...baseCookieOpts(req),
      maxAge: ACCESS_MS,
    });
  if (json.refresh_token)
    res.cookie("spotify_refresh_token", json.refresh_token, {
      ...baseCookieOpts(req),
      maxAge: REFRESH_MS,
    });
  return json.access_token as string | null;
}

async function sfetch(
  req: express.Request,
  res: express.Response,
  path: string
) {
  let access = req.cookies["spotify_access_token"];
  const doFetch = () =>
    fetch(`${SPOTIFY_API}${path}`, {
      headers: { Authorization: `Bearer ${access}` },
    });

  let resp = await doFetch();
  if (resp.status === 401) {
    access = (await refreshAccessToken(req, res)) || undefined;
    if (!access) throw new Error("Unauthorized and refresh failed");
    resp = await doFetch();
  }
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

app.get("/debug/tokens", (req, res) => {
  res.json({
    hasAccess: !!req.cookies["spotify_access_token"],
    hasRefresh: !!req.cookies["spotify_refresh_token"],
  });
});

app.get("/spotify/me", async (req, res) => {
  try {
    res.json(await sfetch(req, res, "/me"));
  } catch (e: any) {
    res.status(500).send(e.message || "Error");
  }
});

app.get("/spotify/top-tracks", async (req, res) => {
  try {
    const time_range = (req.query.time_range as string) || "medium_term";
    const limit = (req.query.limit as string) || "50";
    res.json(
      await sfetch(
        req,
        res,
        `/me/top/tracks?time_range=${time_range}&limit=${limit}`
      )
    );
  } catch (e: any) {
    res.status(500).send(e.message || "Error");
  }
});

app.get("/spotify/top-artists", async (req, res) => {
  try {
    const time_range = (req.query.time_range as string) || "medium_term";
    const limit = (req.query.limit as string) || "50";
    res.json(
      await sfetch(
        req,
        res,
        `/me/top/artists?time_range=${time_range}&limit=${limit}`
      )
    );
  } catch (e: any) {
    res.status(500).send(e.message || "Error");
  }
});

app.get("/spotify/recent", async (req, res) => {
  try {
    const limit = (req.query.limit as string) || "50";
    const before = (req.query.before as string) || "";
    const after = (req.query.after as string) || "";
    const q = new URLSearchParams({
      limit,
      ...(before && { before }),
      ...(after && { after }),
    });
    res.json(
      await sfetch(req, res, `/me/player/recently-played?${q.toString()}`)
    );
  } catch (e: any) {
    res.status(500).send(e.message || "Error");
  }
});

// server route: /enriched/top-tracks
app.get("/enriched/top-tracks", async (req, res) => {
  try {
    const time_range = (req.query.time_range as string) || "medium_term";
    const limit = (req.query.limit as string) || "50";

    const top = await sfetch(
      req,
      res,
      `/me/top/tracks?time_range=${time_range}&limit=${limit}`
    );

    // unique artist IDs (<=50 per /artists call)
    const artistIds = Array.from(
      new Set(
        (top.items as any[]).flatMap((t) =>
          (t.artists ?? []).map((a: any) => a.id)
        )
      )
    );

    const batched: any[] = [];
    for (let i = 0; i < artistIds.length; i += 50) {
      const ids = artistIds.slice(i, i + 50).join(",");
      const resp = await sfetch(req, res, `/artists?ids=${ids}`);
      batched.push(...(resp.artists || []));
    }
    const genresByArtist = new Map(batched.map((a) => [a.id, a.genres || []]));

    const items = (top.items as any[]).map((t) => ({
      id: t.id,
      name: t.name,
      uri: t.uri,
      popularity: t.popularity,
      duration_ms: t.duration_ms,
      explicit: t.explicit,
      album: {
        id: t.album?.id,
        name: t.album?.name,
        release_date: t.album?.release_date,
      },
      artists: (t.artists || []).map((a: any) => ({
        id: a.id,
        name: a.name,
        genres: genresByArtist.get(a.id) || [],
      })),
    }));

    res.json({ items });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "failed" });
  }
});

app.get("/debug/topcounts", async (req, res) => {
  try {
    const [shortT, medT, longT] = await Promise.all([
      sfetch(req, res, "/me/top/tracks?time_range=short_term&limit=50"),
      sfetch(req, res, "/me/top/tracks?time_range=medium_term&limit=50"),
      sfetch(req, res, "/me/top/tracks?time_range=long_term&limit=50"),
    ]);
    res.json({
      short: shortT.items?.length || 0,
      medium: medT.items?.length || 0,
      long: longT.items?.length || 0,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message || "failed" });
  }
});

// ---- Chat route (mounted under /chat) ----
import { chatRouter } from "./chat";
app.use("/chat", chatRouter());

app.listen(8080, () => console.log("Server on :8080"));

