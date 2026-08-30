#!/usr/bin/env node
// One-time local helper: run this yourself to get a Spotify refresh token.
//
//   1. Create an app at https://developer.spotify.com/dashboard
//      - Add redirect URI: http://127.0.0.1:8888/callback
//      - Copy the Client ID and Client Secret
//   2. Run:
//        SPOTIFY_CLIENT_ID=xxx SPOTIFY_CLIENT_SECRET=yyy node scripts/spotify-auth.js
//   3. Open the printed URL, log in, approve access.
//   4. Copy the refresh token this script prints into your GitHub repo's
//      Settings → Secrets and variables → Actions, as SPOTIFY_REFRESH_TOKEN
//      (overwrite the existing value if you're re-running this after a
//      scope change).
//
// Never commit your client secret or refresh token to the repo.

const http = require("http");
const { URL } = require("url");

const PORT = 8888;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPE = "user-read-playback-state";

const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET env vars first.");
  process.exit(1);
}

const authUrl = new URL("https://accounts.spotify.com/authorize");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("scope", SCOPE);

console.log("\nOpen this URL in your browser and approve access:\n");
console.log(authUrl.toString());
console.log(`\nWaiting for redirect on ${REDIRECT_URI} ...\n`);

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, REDIRECT_URI);
  if (reqUrl.pathname !== "/callback") {
    res.writeHead(404);
    res.end();
    return;
  }

  const code = reqUrl.searchParams.get("code");
  if (!code) {
    res.writeHead(400);
    res.end("Missing authorization code");
    return;
  }

  try {
    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });

    const data = await tokenRes.json();

    if (data.refresh_token) {
      console.log("\nSuccess. Your refresh token is:\n");
      console.log(data.refresh_token);
      console.log("\nAdd this as the SPOTIFY_REFRESH_TOKEN secret in your GitHub repo settings.\n");
      res.end("Done — check your terminal. You can close this tab.");
    } else {
      console.error("\nSomething went wrong:", data);
      res.end("Something went wrong — check your terminal.");
    }
  } catch (err) {
    console.error(err);
    res.end("Request failed — check your terminal.");
  } finally {
    server.close();
  }
});

server.listen(PORT);
