#!/usr/bin/env node
// Runs on a schedule via .github/workflows/update-spotify.yml. Refreshes a
// Spotify access token and writes the most recent music track and the most
// recent podcast episode to data/currently-listening.json:
//
//   { "music": {...} | null, "podcast": {...} | null, "fetchedAt": "..." }
//
// Music comes from GET /v1/me/player/recently-played plus whatever is playing
// now. Spotify's recently-played doesn't include podcast episodes, so
// episodes come from two places:
//   1. GET /v1/me/player?additional_types=episode: an episode playing (or
//      paused) right now.
//   2. Listening progress: for every saved show, the latest episodes'
//      resume_point is compared with the previous run's, stored in
//      state/spotify-episode-positions.json (not deployed). An episode whose
//      position moved forward was listened to since the last run, so it is
//      dated to this run. This only covers shows you follow/save.
//
// Each slot is only replaced by something newer, never cleared, so an empty
// or failed result can't overwrite good data. fetchedAt is when the file last
// changed; unchanged runs write nothing and make no commit.
//
// Temporary Spotify errors (429/5xx) are retried; if they persist the run
// logs a warning and exits 0 without writing. Real errors (bad credentials,
// missing scopes, unexpected responses) exit non-zero.

const fs = require("fs");
const path = require("path");

const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN } = process.env;

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !SPOTIFY_REFRESH_TOKEN) {
  console.error("Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET / SPOTIFY_REFRESH_TOKEN");
  process.exit(1);
}

const ROOT = path.join(__dirname, "..");
const OUTPUT_PATH = path.join(ROOT, "data", "currently-listening.json");
const STATE_PATH = path.join(ROOT, "state", "spotify-episode-positions.json");
// Must match SCOPE in scripts/spotify-auth.js.
const REQUIRED_SCOPES = [
  "user-read-playback-state",
  "user-read-recently-played",
  "user-library-read",
  "user-read-playback-position",
];
const EPISODES_PER_SHOW = 5;
const MAX_ATTEMPTS = 4;

class TransientError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// fetch with retries for 429 and 5xx (and network errors). Throws
// TransientError if Spotify is still unavailable after MAX_ATTEMPTS.
async function fetchWithRetry(url, options, label) {
  let last;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (err) {
      last = `network error: ${err.message}`;
    }
    if (res && res.status !== 429 && res.status < 500) return res;
    if (res) last = `${res.status} ${(await res.text()).slice(0, 200)}`;
    if (attempt < MAX_ATTEMPTS) {
      const retryAfter = res && Number(res.headers.get("retry-after"));
      const wait = retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 2000 * 2 ** (attempt - 1);
      console.log(`${label} failed (${last}), retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw new TransientError(`${label} still failing after ${MAX_ATTEMPTS} attempts: ${last}`);
}

async function getAccessToken() {
  const res = await fetchWithRetry(
    "https://accounts.spotify.com/api/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: SPOTIFY_REFRESH_TOKEN,
      }),
    },
    "Token refresh"
  );
  const data = await res.json();
  if (data.error === "invalid_grant") {
    throw new Error("Spotify refresh token expired or revoked (invalid_grant): re-run scripts/spotify-auth.js and update the SPOTIFY_REFRESH_TOKEN secret");
  }
  if (!data.access_token) {
    throw new Error(`Failed to refresh access token: ${res.status} ${data.error || "no access_token in response"}`);
  }
  const granted = (data.scope || "").split(" ");
  const missing = REQUIRED_SCOPES.filter((scope) => !granted.includes(scope));
  if (missing.length) {
    throw new Error(`Spotify token is missing scope(s) ${missing.join(", ")}: re-run scripts/spotify-auth.js and update the SPOTIFY_REFRESH_TOKEN secret`);
  }
  return data.access_token;
}

// Returns parsed JSON, or null for 204 (Spotify's "nothing to report").
async function spotifyGet(accessToken, urlPath) {
  const res = await fetchWithRetry(
    `https://api.spotify.com/v1${urlPath}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    `GET ${urlPath}`
  );
  if (res.status === 204) return null;
  if (!res.ok) {
    throw new Error(`GET ${urlPath} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Maps a Spotify track or episode to the data file's shape. For a track,
// `show` holds the artists so the site can render both types the same way.
// `show` can be passed in for episodes from /shows/{id}/episodes, which
// don't embed their show.
function toEntry(item, playedAt, showName) {
  if (!item || !item.name) return null;
  const isEpisode = item.type === "episode";
  const images = (isEpisode ? item.images : item.album && item.album.images) || [];
  let show = null;
  if (isEpisode) {
    show = item.show ? item.show.name : showName || null;
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
  // Logged on every run so a missed podcast can be diagnosed from the
  // Actions log instead of guessed at.
  console.log(
    "Player state:",
    state
      ? JSON.stringify({
          is_playing: state.is_playing,
          currently_playing_type: state.currently_playing_type,
          item_type: state.item ? state.item.type : null,
          item_name: state.item ? state.item.name : null,
          device: state.device ? state.device.type : null,
          timestamp: state.timestamp ? new Date(state.timestamp).toISOString() : null,
        })
      : "204 (no active device)"
  );
  if (!state) return null;

  const reportedType = state.currently_playing_type;
  if (reportedType === "ad") return null;

  // Spotify sometimes reports "unknown" for episodes, and sometimes returns
  // a null item for them, so trust the item's own type when there is one and
  // otherwise ask the queue endpoint.
  let item = state.item;
  if (!item && (reportedType === "episode" || reportedType === "unknown")) {
    try {
      const queue = await spotifyGet(accessToken, "/me/player/queue");
      item = queue && queue.currently_playing;
    } catch (err) {
      if (err instanceof TransientError) throw err;
      console.log(`Queue fallback failed: ${err.message}`);
    }
  }
  if (!item || (item.type !== "track" && item.type !== "episode")) return null;

  if (state.is_playing) return toEntry(item, now);

  // A paused episode is still the most recent thing listened to, which is
  // a common case for podcasts. state.timestamp is when playback state last
  // changed, so it is roughly when it was paused. Paused tracks are left to
  // recently-played, which already covers them.
  if (item.type === "episode" && state.timestamp) {
    return toEntry(item, new Date(Math.min(state.timestamp, Date.parse(now))).toISOString());
  }
  return null;
}

async function getLastPlayed(accessToken) {
  const history = await spotifyGet(accessToken, "/me/player/recently-played?limit=1");
  const last = history && history.items && history.items[0];
  return last ? toEntry(last.track, last.played_at) : null;
}

async function getSavedShows(accessToken) {
  const shows = [];
  let next = "/me/shows?limit=50";
  while (next) {
    const page = await spotifyGet(accessToken, next);
    if (!page || !Array.isArray(page.items)) throw new Error("GET /me/shows returned no items array");
    for (const { show } of page.items) if (show && show.id) shows.push(show);
    next = page.next ? page.next.replace("https://api.spotify.com/v1", "") : null;
  }
  return shows;
}

// Compares each saved show's latest episodes' resume points against the
// previous run. Returns { entry, positions }: the episode that progressed
// (newest release first if several did) and the new positions to store.
// Shows not seen before are only recorded, never reported, so following a
// show doesn't make one of its old episodes look freshly played.
async function getProgressedEpisode(accessToken, previous, now) {
  const shows = await getSavedShows(accessToken);
  const positions = {};
  const progressed = [];

  for (const show of shows) {
    const page = await spotifyGet(accessToken, `/shows/${show.id}/episodes?limit=${EPISODES_PER_SHOW}`);
    const episodes = ((page && page.items) || []).filter((ep) => ep && ep.id);
    const before = previous[show.id];
    positions[show.id] = {};

    for (const ep of episodes) {
      if (!ep.resume_point) {
        throw new Error("Episode has no resume_point: the token needs the user-read-playback-position scope");
      }
      const pos = ep.resume_point.resume_position_ms || 0;
      const done = Boolean(ep.resume_point.fully_played);
      positions[show.id][ep.id] = [pos, done];
      if (!before) continue;

      const old = before[ep.id];
      const moved = old ? pos > old[0] || (done && !old[1]) : pos > 0 || done;
      if (moved) progressed.push({ ep, showName: show.name });
    }
  }

  progressed.sort((a, b) => (b.ep.release_date || "").localeCompare(a.ep.release_date || ""));
  if (progressed.length) {
    console.log("Episodes with new progress:", progressed.map((p) => `${p.showName} — ${p.ep.name}`).join("; "));
  }
  const top = progressed[0];
  return { entry: top ? toEntry({ ...top.ep, type: "episode" }, now, top.showName) : null, positions };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

// Reads the data file, upgrading the old single-entry shape
// ({ type, title, ... }) to { music, podcast }. `legacy` marks a file that
// still needs rewriting in the new shape.
function readExisting() {
  const data = readJson(OUTPUT_PATH);
  if (!data) return { music: null, podcast: null, legacy: false };
  if ("music" in data || "podcast" in data) {
    return { music: data.music || null, podcast: data.podcast || null, legacy: false };
  }
  const { fetchedAt, updatedAt, ...entry } = data;
  if (!entry.playedAt) entry.playedAt = updatedAt || fetchedAt;
  if (entry.type === "episode") return { music: null, podcast: entry, legacy: true };
  if (entry.type === "track") return { music: entry, podcast: null, legacy: true };
  return { music: null, podcast: null, legacy: true };
}

const newest = (entries) =>
  entries.filter(Boolean).sort((a, b) => Date.parse(b.playedAt) - Date.parse(a.playedAt))[0] || null;

const isNewer = (candidate, current) =>
  Boolean(candidate) && (!current || Date.parse(candidate.playedAt) > Date.parse(current.playedAt));

async function main() {
  const accessToken = await getAccessToken();
  const now = new Date().toISOString();

  const nowPlaying = await getNowPlaying(accessToken, now);
  const lastPlayed = await getLastPlayed(accessToken);
  const previousPositions = readJson(STATE_PATH);
  const { entry: progressedEpisode, positions } = await getProgressedEpisode(accessToken, previousPositions || {}, now);

  const isType = (type) => (entry) => entry && entry.type === type;
  const music = newest([nowPlaying, lastPlayed].filter(isType("track")));
  const podcast = newest([nowPlaying, progressedEpisode].filter(isType("episode")));

  // Positions are saved every run they change, so the next run compares
  // against the latest snapshot. Not deployed: deploy.yml only syncs data/.
  if (JSON.stringify(positions) !== JSON.stringify(previousPositions)) {
    writeJson(STATE_PATH, positions);
    console.log(`Saved listening positions for ${Object.keys(positions).length} show(s)`);
  }

  const existing = readExisting();
  const next = {
    music: isNewer(music, existing.music) ? music : existing.music,
    podcast: isNewer(podcast, existing.podcast) ? podcast : existing.podcast,
  };
  if (!existing.legacy && next.music === existing.music && next.podcast === existing.podcast) {
    console.log("Nothing newer than the existing data — leaving it as-is.");
    return;
  }

  const payload = { ...next, fetchedAt: now };
  writeJson(OUTPUT_PATH, payload);
  console.log("Wrote", OUTPUT_PATH, payload);
}

main().catch((err) => {
  if (err instanceof TransientError) {
    // Spotify outage, not a problem with this repo: keep existing data and
    // don't fail the run.
    console.log(`::warning::Spotify temporarily unavailable, existing data left as-is. ${err.message}`);
    return;
  }
  console.error(err.message);
  process.exit(1);
});
