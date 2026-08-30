#!/usr/bin/env node
// Runs on a schedule via .github/workflows/update-spotify.yml. Refreshes a
// Spotify access token, finds the most recently played podcast episode
// (filtering out music tracks), and writes it to
// data/currently-listening.json for the static site to fetch client-side.
//
// Leaves the existing data file untouched if no episode is found in the
// recent history window, so the site never regresses to empty on a quiet day.

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

function isEpisode(item) {
  // The recently-played history nests the played item under `track`
  // regardless of whether it's a music track or a podcast episode. Episodes
  // carry `type: "episode"` and a `show` object instead of `album`/`artists`.
  const t = item.track;
  return Boolean(t && (t.type === "episode" || t.show));
}

async function main() {
  const accessToken = await getAccessToken();

  const res = await fetch("https://api.spotify.com/v1/me/player/recently-played?limit=50", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();

  const items = data.items || [];

  // TEMP DEBUG: remove once we've confirmed episodes show up here.
  console.log(
    "recently-played raw items:",
    JSON.stringify(
      items.map((i) => ({
        name: i.track && i.track.name,
        type: i.track && i.track.type,
        hasShow: Boolean(i.track && i.track.show),
        hasAlbum: Boolean(i.track && i.track.album),
        playedAt: i.played_at,
      })),
      null,
      2
    )
  );

  const latestEpisode = items.find(isEpisode);

  if (!latestEpisode) {
    console.log("No podcast episode found in recent listening history — leaving existing data as-is.");
    return;
  }

  const episode = latestEpisode.track;
  const payload = {
    title: episode.name,
    show: episode.show ? episode.show.name : null,
    url: episode.external_urls ? episode.external_urls.spotify : null,
    image: episode.images && episode.images[0] ? episode.images[0].url : null,
    playedAt: latestEpisode.played_at,
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
