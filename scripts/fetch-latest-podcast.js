#!/usr/bin/env node
// Runs on a schedule via .github/workflows/update-spotify.yml. Refreshes a
// Spotify access token, checks what's currently playing, and — if it's a
// podcast episode — writes it to data/currently-listening.json for the
// static site to fetch client-side.
//
// Spotify's `recently-played` history endpoint does not reliably surface
// podcast episodes (confirmed empirically: it kept returning only music
// tracks even during active podcast playback). `currently-playing` does
// support episodes via `currently_playing_type`, so that's the source of
// truth here — which means this only captures an episode if you happen to
// be actively listening at the moment this runs. The workflow runs every
// 15 minutes to make that reasonably likely. If nothing's playing, or
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

  const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 204) {
    console.log("Nothing currently playing — leaving existing data as-is.");
    return;
  }
  if (!res.ok) {
    throw new Error(`currently-playing request failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();

  if (data.currently_playing_type !== "episode" || !data.item) {
    // TEMP DEBUG: currently_playing_type has come back "episode" with a
    // falsy item before — dump the raw response to see why.
    console.log("TEMP DEBUG raw currently-playing response:", JSON.stringify(data, null, 2));
    console.log(`Currently playing "${data.currently_playing_type}", not a podcast — leaving existing data as-is.`);
    return;
  }

  const episode = data.item;
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
