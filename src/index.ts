import dotenv from 'dotenv'
dotenv.config({ path: '.env' })

// server/index.ts
import express from "express";
import cookieParser from "cookie-parser";
import crypto from "crypto";

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REDIRECT_URI, // e.g. https://your-app.com/auth/callback
  SESSION_SECRET, // any random string
} = process.env;

const app = express();
app.use(cookieParser(SESSION_SECRET));

const SPOTIFY_AUTH = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN = "https://accounts.spotify.com/api/token";
const SPOTIFY_API = "https://api.spotify.com/v1";

const SCOPES = [
  "user-read-email",
  "user-top-read",
  "user-read-recently-played",
  "playlist-modify-private",
].join(" ");

app.get("/", (req, res) => {
    console.log("process.env.SPOTIFY_CLIENT_ID", process.env.SPOTIFY_CLIENT_ID);
    res.send("Hello World")
});

app.get("/auth/login", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie("spotify_auth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
  });

  const url = new URL(SPOTIFY_AUTH);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", SPOTIFY_CLIENT_ID!);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("redirect_uri", SPOTIFY_REDIRECT_URI!);
  url.searchParams.set("state", state);

  res.redirect(url.toString());
});

app.get("/auth/callback", async (req, res) => {
  const { code, state } = req.query as { code: string; state: string };
  const cookieState = req.cookies["spotify_auth_state"];
  if (!state || state !== cookieState)
    return res.status(400).send("State mismatch");

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
  const tokens: any = await r.json(); // { access_token, refresh_token, expires_in, token_type, scope }

  // TODO: persist refresh_token in your DB keyed to the user
  res.cookie("spotify_access_token", tokens.access_token, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
  });
  res.cookie("spotify_refresh_token", tokens.refresh_token, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
  });

  res.redirect("/app"); // your frontend route
});

// Refresh flow (when 401/expired)
app.get("/auth/refresh", async (req, res) => {
  const refresh_token = req.cookies["spotify_refresh_token"];
  if (!refresh_token) return res.status(401).send("No refresh token");

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
  const json: any = await r.json();
  res.cookie("spotify_access_token", json.access_token, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
  });
  res.json({ ok: true });
});

// Helper: Spotify fetch with token from cookie
async function sfetch(req: express.Request, path: string) {
  let access = req.cookies["spotify_access_token"];
  const doFetch = () =>
    fetch(`${SPOTIFY_API}${path}`, {
      headers: { Authorization: `Bearer ${access}` },
    });

  let resp = await doFetch();
  if (resp.status === 401) {
    await fetch(`${req.protocol}://${req.get("host")}/auth/refresh`);
    access = req.cookies["spotify_access_token"]; // simplistic; better: centralize refresh
    resp = await doFetch();
  }
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

// Example data endpoints
app.get("/spotify/me", async (req, res) => res.json(await sfetch(req, "/me")));
app.get("/spotify/top-tracks", async (req, res) =>
  res.json(await sfetch(req, "/me/top/tracks?time_range=medium_term&limit=50"))
);
app.get("/spotify/top-artists", async (req, res) =>
  res.json(await sfetch(req, "/me/top/artists?time_range=medium_term&limit=50"))
);
app.get("/spotify/recent", async (req, res) =>
  res.json(await sfetch(req, "/me/player/recently-played?limit=50"))
);
app.get("/spotify/features", async (req, res) => {
  // get audio features for a list of track IDs (?ids=)
  const ids = (req.query.ids as string) ?? "";
  res.json(await sfetch(req, `/audio-features?ids=${ids}`));
});

app.listen(8080, () => {
    console.log("process.env.SPOTIFY_CLIENT_ID", process.env.SPOTIFY_CLIENT_ID);
    console.log("Server on :8080")});
