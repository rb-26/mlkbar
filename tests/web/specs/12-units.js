// Imperial + US wording: shown and typed in oz/lb/in, stored metric; Poop/Pee; food spellings count as one.
module.exports = async (t) => {
  const server = await t.startServer({ port: 5194 });
  const settings = (await t.api(server, "/api/settings")).body;
  t.ok("metric by default", settings.units === "metric");
  const saved = await t.api(server, "/api/settings", { method: "POST", body: JSON.stringify({ ...settings, babyDob: "2026-09-01", babySex: "girl", units: "imperial" }) });
  t.ok("units saved", saved.status === 200);
  const after = (await t.api(server, "/api/settings")).body;
  t.ok("other settings kept", after.units === "imperial" && after.babyDob === "2026-09-01");
  const bad = await t.api(server, "/api/settings", { method: "POST", body: JSON.stringify({ ...after, units: "furlongs" }) });
  t.ok("bad units rejected", bad.status === 400);

  const ts = new Date(Date.now() - 3600000).toISOString();
  await t.api(server, "/api/entries", { method: "POST", body: JSON.stringify({ id: "u-feed", milkMl: 120, timestamp: ts, createdAt: ts }) });
  await t.api(server, "/api/measurements", { method: "POST", body: JSON.stringify({ id: "u-m", date: new Date().toISOString().slice(0, 10), weightGrams: 4200, lengthCm: 55, createdAt: ts }) });

  // As in a real browser after the first visit: settings already cached (no reload needed).
  const cached = { before: win => win.localStorage.setItem("littletrack-cache:settings", JSON.stringify(after)) };
  let w = await t.loadPage(server, "index.html", { wait: 1500, ...cached });
  let d = w.document;
  t.noErrors(w, "index.html");
  t.ok("today total in oz", /oz/.test(d.getElementById("today-total").textContent), d.getElementById("today-total").textContent);
  t.ok("Poop / Pee buttons", d.querySelector("#quick-poo .quick-add-label").textContent === "Poop" && d.querySelector("#quick-wee .quick-add-label").textContent === "Pee");
  t.ok("quick feed in oz", /4\.1 oz feed/.test(d.querySelector("#quick-feed .quick-add-label").textContent), d.querySelector("#quick-feed .quick-add-label").textContent);
  // Custom feed typed in oz, stored in ml.
  d.getElementById("quick-custom-feed").click();
  await t.sleep(200);
  t.ok("feed popup asks for oz", /\(oz\)/.test(d.getElementById("feed-dialog-ml").closest("label").textContent));
  d.getElementById("feed-dialog-ml").value = "4";
  d.getElementById("feed-dialog-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await t.sleep(700);
  const entries = (await t.api(server, "/api/entries")).body;
  t.ok("4 oz stored as 118 ml", entries.some(e => e.milkMl === 118));
  w.close();

  // Editing without changing keeps the exact ml.
  w = await t.loadPage(server, "log.html", { wait: 1500, ...cached });
  d = w.document;
  t.noErrors(w, "log.html");
  t.ok("log shows oz", /4\.1 oz/.test(d.body.textContent));
  w.close();

  w = await t.loadPage(server, "measurements.html", { wait: 1500, ...cached });
  d = w.document;
  t.noErrors(w, "measurements.html");
  t.ok("weight in lb oz", /9 lb 4\.2 oz/.test(d.body.textContent), d.querySelector("main").textContent.replace(/\s+/g, " ").slice(0, 160));
  t.ok("length in inches", /21\.7 in/.test(d.body.textContent));
  w.close();

  // Food: Yoghurt (logged before) and Yogurt count as one.
  const day = new Date(); day.setHours(0, 0, 0, 0);
  await t.api(server, "/api/entries", { method: "POST", body: JSON.stringify({ id: "u-yog", food: "Yoghurt", timestamp: day.toISOString(), createdAt: day.toISOString() }) });
  w = await t.loadPage(server, "food.html", { wait: 1500, ...cached });
  d = w.document;
  t.ok("suggested shows US spelling", !!d.querySelector('#food-groups [data-food="Yogurt"]'));
  t.ok("logged Yoghurt ticks Yogurt", d.querySelector('#food-groups [data-food="Yogurt"]')?.getAttribute("aria-pressed") === "true");
  w.close();

  const csv = await (await fetch(server.base + "/api/export.csv")).text();
  t.ok("CSV in oz", /Bottle feed,4\.1,oz/.test(csv));

  await t.api(server, "/api/settings", { method: "POST", body: JSON.stringify({ ...after, units: "metric" }) });
  const raw = (await t.api(server, "/api/entries")).body.find(e => e.id === "u-feed");
  t.ok("data still metric after switching back", raw.milkMl === 120);
};
