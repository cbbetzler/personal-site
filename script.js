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

// Populate "What I'm Listening To" with the latest podcast episode, kept
// fresh by a scheduled GitHub Action (see scripts/fetch-latest-podcast.js).
// Falls back silently to the static placeholder if the data file is
// missing or empty (e.g. before the first Action run).
(function () {
  var card = document.getElementById("spotify-card");
  if (!card) return;

  fetch("data/currently-listening.json", { cache: "no-store" })
    .then(function (res) {
      if (!res.ok) throw new Error("no data yet");
      return res.json();
    })
    .then(function (data) {
      if (!data || !data.title) return;
      var valueEl = card.querySelector(".currently-value");
      if (valueEl) {
        valueEl.textContent = data.show ? data.show + " — " + data.title : data.title;
      }
      if (data.url) {
        card.href = data.url;
      }
    })
    .catch(function () {
      // Leave the static placeholder in place.
    });
})();
