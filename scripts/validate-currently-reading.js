#!/usr/bin/env node
// Runs via .github/workflows/update-goodreads.yml whenever
// data/currently-reading.json changes. Checks that the file is valid JSON
// holding 1-3 books, each with a title, author, link and cover image, so a
// bad hand edit fails CI instead of breaking the "What I'm Reading" card.
//
// The file is maintained by hand. It used to be generated from the Goodreads
// shelf RSS feed (review/list_rss), but that endpoint has returned 404 since
// 2026-10-27 and the HTML shelf now requires sign-in.
//
// Usage: node scripts/validate-currently-reading.js [path]

const fs = require("fs");
const path = require("path");

const MAX_BOOKS = 3;
const REQUIRED_FIELDS = ["title", "author", "url", "image"];
const URL_FIELDS = ["url", "image"];

const DATA_PATH = process.argv[2] || path.join(__dirname, "..", "data", "currently-reading.json");

function validate(books) {
  if (!Array.isArray(books)) return ["Top level must be an array of books"];
  if (books.length === 0) return ["No books listed (expected 1-" + MAX_BOOKS + ")"];
  if (books.length > MAX_BOOKS) return [`${books.length} books listed (expected at most ${MAX_BOOKS})`];

  const errors = [];
  books.forEach((book, i) => {
    const label = `Book ${i + 1}`;
    if (!book || typeof book !== "object" || Array.isArray(book)) {
      errors.push(`${label}: must be an object`);
      return;
    }
    for (const field of REQUIRED_FIELDS) {
      const value = book[field];
      if (typeof value !== "string" || value.trim() === "") {
        errors.push(`${label}: missing "${field}"`);
      } else if (URL_FIELDS.includes(field) && !value.startsWith("https://")) {
        errors.push(`${label}: "${field}" must start with https://`);
      }
    }
  });
  return errors;
}

async function main() {
  let books;
  try {
    books = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  } catch (err) {
    throw new Error(`Could not read ${DATA_PATH}: ${err.message}`);
  }

  const errors = validate(books);
  if (errors.length) {
    throw new Error(`Invalid ${DATA_PATH}:\n  - ${errors.join("\n  - ")}`);
  }
  console.log(`OK: ${DATA_PATH} lists ${books.length} book(s):`);
  for (const book of books) console.log(`  - ${book.title} by ${book.author}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
