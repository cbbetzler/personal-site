#!/usr/bin/env node
// Runs on a schedule via .github/workflows/update-goodreads.yml. Fetches the
// public "currently-reading" shelf RSS feed for a Goodreads profile and
// writes up to 3 books to data/currently-reading.json for the static site
// to fetch client-side.
//
// Goodreads retired API access for new developers in 2020, but a public
// profile's shelf RSS feed (review/list_rss) still works with no auth —
// that's the data source here. The user ID below is a public identifier
// (visible in the profile URL), not a secret.

const fs = require("fs");
const path = require("path");

const GOODREADS_USER_ID = "123192008";
const SHELF = "currently-reading";
const MAX_BOOKS = 3;

const FEED_URL = `https://www.goodreads.com/review/list_rss/${GOODREADS_USER_ID}?shelf=${SHELF}`;
const OUTPUT_PATH = path.join(__dirname, "..", "data", "currently-reading.json");

function extractField(itemXml, tag) {
  const match = itemXml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`));
  return match ? match[1].trim() : null;
}

async function main() {
  const res = await fetch(FEED_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; personal-site-bot/1.0)" },
  });
  if (!res.ok) {
    throw new Error(`Goodreads RSS request failed: ${res.status} ${await res.text()}`);
  }

  const xml = await res.text();
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];

  const books = items.slice(0, MAX_BOOKS).map((item) => ({
    title: extractField(item, "title"),
    author: extractField(item, "author_name"),
    url: extractField(item, "link"),
    image: extractField(item, "book_image_url"),
  }));

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(books, null, 2) + "\n");
  console.log("Wrote", OUTPUT_PATH, books);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
