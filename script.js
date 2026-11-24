// Lightweight active-nav-link highlighting based on scroll position.
// No dependencies, no build step.
(function () {
  var sections = document.querySelectorAll("main section[id], .hero[id]");
  var navLinks = document.querySelectorAll(".nav-links a");

  if (!sections.length || !navLinks.length || !("IntersectionObserver" in window)) {
    return;
  }

  var linkFor = {};
  navLinks.forEach(function (link) {
    var id = link.getAttribute("href").replace("#", "");
    linkFor[id] = link;
  });

  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        var link = linkFor[entry.target.id];
        if (!link) return;
        if (entry.isIntersecting) {
          navLinks.forEach(function (l) {
            l.removeAttribute("aria-current");
          });
          link.setAttribute("aria-current", "true");
        }
      });
    },
    { rootMargin: "-40% 0px -55% 0px" }
  );

  sections.forEach(function (section) {
    observer.observe(section);
  });
})();

// Populate "What I'm Listening To" with the most recent music track and the
// most recent podcast episode, kept fresh by a scheduled GitHub Action (see
// scripts/fetch-latest-podcast.js). Each line is dropped if it is over 14
// days old; the card falls back silently to the static placeholder if the
// data file is missing or nothing in it is recent.
(function () {
  var card = document.getElementById("spotify-card");
  if (!card) return;

  var MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

  function timeAgo(ms) {
    var minutes = Math.floor(ms / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return minutes + (minutes === 1 ? " minute ago" : " minutes ago");
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
    var days = Math.floor(hours / 24);
    return days + (days === 1 ? " day ago" : " days ago");
  }

  function ageOf(entry) {
    return Math.max(0, Date.now() - Date.parse(entry.playedAt));
  }

  fetch("data/currently-listening.json", { cache: "no-store" })
    .then(function (res) {
      if (!res.ok) throw new Error("no data yet");
      return res.json();
    })
    .then(function (data) {
      if (!data) return;
      // Older files held a single entry rather than { music, podcast }.
      var entries = data.title
        ? [data]
        : [data.music, data.podcast];
      entries = entries.filter(function (entry) {
        return entry && entry.title && ageOf(entry) < MAX_AGE_MS;
      });
      if (!entries.length) return;

      // The card is one link, so it goes to whichever was played last.
      var newest = entries.slice().sort(function (a, b) {
        return ageOf(a) - ageOf(b);
      })[0];
      if (newest.url) card.href = newest.url;

      var valueEl = card.querySelector(".currently-value");
      if (valueEl) valueEl.remove();
      entries.forEach(function (entry) {
        var line = document.createElement("span");
        line.className = "currently-line";
        var label = document.createElement("span");
        label.className = "currently-label";
        label.textContent = entry.type === "episode" ? "Podcast" : "Music";
        var value = document.createElement("span");
        value.className = "currently-value";
        value.textContent = entry.show ? entry.show + " — " + entry.title : entry.title;
        var timeEl = document.createElement("span");
        timeEl.className = "currently-time";
        timeEl.textContent = timeAgo(ageOf(entry));
        line.append(label, value, timeEl);
        card.appendChild(line);
      });
    })
    .catch(function () {
      // Leave the static placeholder in place.
    });
})();

// Populate "What I'm Reading" with up to 3 books from the currently-reading
// shelf, edited by hand in data/currently-reading.json (checked by
// scripts/validate-currently-reading.js). Falls back silently to the static
// profile link if the data file is missing or empty.
(function () {
  var list = document.getElementById("reading-list");
  if (!list) return;

  fetch("data/currently-reading.json", { cache: "no-store" })
    .then(function (res) {
      if (!res.ok) throw new Error("no data yet");
      return res.json();
    })
    .then(function (books) {
      if (!Array.isArray(books) || !books.length) return;

      list.innerHTML = "";
      books.forEach(function (book) {
        if (!book || !book.title || !book.url) return;
        var li = document.createElement("li");
        li.className = "reading-item";
        var a = document.createElement("a");
        a.href = book.url;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = book.title;
        if (book.author) {
          a.append(document.createTextNode(" "));
          var authorEl = document.createElement("span");
          authorEl.className = "reading-author";
          authorEl.textContent = "— " + book.author;
          a.appendChild(authorEl);
        }
        li.appendChild(a);
        list.appendChild(li);
      });
    })
    .catch(function () {
      // Leave the static placeholder in place.
    });
})();
