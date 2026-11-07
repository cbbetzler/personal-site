#!/usr/bin/env node
// Runs on a schedule via .github/workflows/update-spotify.yml. Refreshes a
// Spotify access token, works out the most recent thing played, and writes
// it to data/currently-listening.json for the static site to fetch
// client-side.
//
// Two sources, newest wins:
//   1. GET /v1/me/player?additional_types=episode: whatever is playing right
//      now, music or podcast. If `item` is null for an episode, falls back
//      to the `currently_playing` field of GET /v1/me/player/queue.
//   2. GET /v1/me/player/recently-played: finished tracks. Spotify doesn't
//      include podcast episodes here, so an episode is only captured if it's
//      playing at the moment this runs.
//
// The file is only rewritten when something newer turns up, so an empty
// result can never replace good data and unchanged runs make no commit. A
// captured episode also stays up for PODCAST_HOLD_MS even if music was played
// after it, because episodes are the harder thing to catch.
// Real errors exit non-zero so the workflow run fails visibly.

const fs = require("fs");
const path = require("path");

const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN } = process.env;

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !SPOTIFY_REFRESH_TOKEN) {
  console.error("Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET / SPOTIFY_REFRESH_TOKEN");
  process.exit(1);
}

const OUTPUT_PATH = path.join(__dirname, "..", "data", "currently-listening.json");
const PODCAST_HOLD_MS = 3 * 24 * 60 * 60 * 1000;

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
  if (data.error === "invalid_grant") {
    // Refresh tokens last 6 months from authorization, and refreshing doesn't
    // extend that.
    throw new Error("Spotify refresh token expired or revoked (invalid_grant): re-run scripts/spotify-auth.js and update the SPOTIFY_REFRESH_TOKEN secret");
  }
  if (!data.access_token) {
    throw new Error(`Failed to refresh access token: ${res.status} ${data.error || "no access_token in response"}`);
  }
  return data.access_token;
}

// Returns parsed JSON, or null for 204 (Spotify's "nothing to report").
async function spotifyGet(accessToken, urlPath) {
  const res = await fetch(`https://api.spotify.com/v1${urlPath}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    throw new Error(`GET ${urlPath} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Maps a Spotify track or episode to the data file's shape. For a track,
// `show` holds the artists so the site can render both types the same way.
function toEntry(item, playedAt) {
  if (!item || !item.name) return null;
  const isEpisode = item.type === "episode";
  const images = (isEpisode ? item.images : item.album && item.album.images) || [];
  let show = null;
  if (isEpisode) {
    show = item.show ? item.show.name : null;
  } else if (item.artists && item.artists.length) {
    show = item.artists.map((artist) => artist.name).join(", ");
  }
  return {
    type: isEpisode ? "episode" : "track",
    title: item.name,
    show,
    url: item.external_urls ? item.external_urls.spotify : null,
    image: images[0] ? images[0].url : null,
    playedAt,
  };
}

async function getNowPlaying(accessToken, now) {
  const state = await spotifyGet(accessToken, "/me/player?additional_types=episode");
  if (!state || !state.is_playing) return null;

  const type = state.currently_playing_type;
  if (type !== "track" && type !== "episode") return null; // ad or unknown

  let item = state.item;
  if (!item && type === "episode") {
    const queue = await spotifyGet(accessToken, "/me/player/queue");
    item = queue && queue.currently_playing;
  }
  return toEntry(item, now);
}

async function getLastPlayed(accessToken) {
  const history = await spotifyGet(accessToken, "/me/player/recently-played?limit=1");
  const last = history && history.items && history.items[0];
  return last ? toEntry(last.track, last.played_at) : null;
}

function readExisting() {
  try {
    return JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function main() {
  const accessToken = await getAccessToken();
  const now = new Date().toISOString();

  const entry = (await getNowPlaying(accessToken, now)) || (await getLastPlayed(accessToken));
  if (!entry) {
    console.log("Spotify returned nothing playing and no history — leaving existing data as-is.");
    return;
  }

  // updatedAt is the pre-playedAt field, kept here so the first run after the
  // schema change can still compare against the old file.
  const existing = readExisting();
  const existingTime = existing ? Date.parse(existing.playedAt || existing.updatedAt) : NaN;
  if (Date.parse(entry.playedAt) <= existingTime) {
    console.log(`Nothing newer than ${existing.playedAt || existing.updatedAt} — leaving existing data as-is.`);
    return;
  }
  if (entry.type === "track" && existing && existing.type === "episode" && Date.now() - existingTime < PODCAST_HOLD_MS) {
    console.log(`Keeping episode from ${existing.playedAt} over newer music — leaving existing data as-is.`);
    return;
  }

  const payload = { ...entry, fetchedAt: now };
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2) + "\n");
  console.log("Wrote", OUTPUT_PATH, payload);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
