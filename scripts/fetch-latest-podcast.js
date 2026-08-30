#!/usr/bin/env node
// Runs on a schedule via .github/workflows/update-spotify.yml. Refreshes a
// Spotify access token, checks what's currently playing, and — if it's a
// podcast episode — writes it to data/currently-listening.json for the
// static site to fetch client-side.
//
// Two-step lookup, found empirically:
//   1. GET /v1/me/player tells us whether something is playing and whether
//      it's an episode (currently_playing_type), but its own `item` field
//      comes back null for podcast episodes — a known Spotify API gap,
//      reproduced across scopes and devices.
//   2. GET /v1/me/player/queue's `currently_playing` field returns the same
//      episode with full metadata (title, show, url, images), so that's
//      the actual data source once step 1 confirms an episode is playing.
//
// This only captures an episode if you're actively listening at the moment
// this runs (every 15 min — see the workflow). If nothing's playing, or
// you're playing music, the existing data file is left untouched so the
// site keeps showing the last episode it caught.

const fs = require("fs");
const path = require("path");

const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN } = process.env;

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !SPOTIFY_REFRESH_TOKEN) {
  console.error("Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET / SPOTIFY_REFRESH_TOKEN");
  process.exit(1);
}

const OUTPUT_PATH = path.join(__dirname, "..", "data", "currently-listening.json");

async function getAccessToken() {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: SPOTIFY_REFRESH_TOKEN,
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error("Failed to refresh access token: " + JSON.stringify(data));
  }
  return data.access_token;
}

async function main() {
  const accessToken = await getAccessToken();
  const authHeader = { Authorization: `Bearer ${accessToken}` };

  const stateRes = await fetch("https://api.spotify.com/v1/me/player", { headers: authHeader });

  if (stateRes.status === 204) {
    console.log("Nothing currently playing — leaving existing data as-is.");
    return;
  }
  if (!stateRes.ok) {
    throw new Error(`player state request failed: ${stateRes.status} ${await stateRes.text()}`);
  }

  const state = await stateRes.json();

  if (!state.is_playing || state.currently_playing_type !== "episode") {
    console.log(`Currently playing "${state.currently_playing_type}", not an active podcast — leaving existing data as-is.`);
    return;
  }

  const queueRes = await fetch("https://api.spotify.com/v1/me/player/queue", { headers: authHeader });
  if (!queueRes.ok) {
    throw new Error(`queue request failed: ${queueRes.status} ${await queueRes.text()}`);
  }

  const episode = (await queueRes.json()).currently_playing;
  if (!episode) {
    console.log("Queue endpoint returned no currently_playing episode — leaving existing data as-is.");
    return;
  }

  const payload = {
    title: episode.name,
    show: episode.show ? episode.show.name : null,
    url: episode.external_urls ? episode.external_urls.spotify : null,
    image: episode.images && episode.images[0] ? episode.images[0].url : null,
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2) + "\n");
  console.log("Wrote", OUTPUT_PATH, payload);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
