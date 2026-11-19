// Feed reminders: settings save per browser; the Add page shows "Next feed due" from the fixed or learned gap.
module.exports = async (t) => {
  // Own server so feeds logged by other specs don't count.
  const server = await t.startServer({ port: 5196 });
  // Settings page writes the preference.
  let w = await t.loadPage(server, "settings.html");
  let d = w.document;
  t.noErrors(w, "settings.html");
  t.ok("options hidden while off", d.getElementById("reminder-options").hidden);
  d.getElementById("reminder-enabled").checked = true;
  d.getElementById("reminder-enabled").dispatchEvent(new w.Event("change"));
  t.ok("options shown when on", !d.getElementById("reminder-options").hidden);
  const saved = JSON.parse(w.localStorage.getItem("mlkbar.feedReminder"));
  t.ok("preference saved", saved.enabled === true && saved.gapMinutes === 180);
  w.close();

  // Three feeds 2h apart, the last one 30 min ago.
  const now = Date.now();
  for (const [i, minsAgo] of [270, 150, 30].entries()) {
    const ts = new Date(now - minsAgo * 60000).toISOString();
    await t.api(server, "/api/entries", { method: "POST", body: JSON.stringify({ id: `rem-${i}`, milkMl: 100, timestamp: ts, createdAt: ts }) });
  }
  const set = prefs => win => win.localStorage.setItem("mlkbar.feedReminder", JSON.stringify(prefs));

  w = await t.loadPage(server, "index.html", { before: set({ enabled: true, mode: "fixed", gapMinutes: 180 }) });
  let line = w.document.getElementById("next-feed");
  t.noErrors(w, "index.html");
  t.ok("fixed: next feed shown", !line.hidden && /Next feed due/.test(line.textContent), line.textContent);
  t.ok("fixed: due in about 2h 30m", /in 2h 30m/.test(line.textContent), line.textContent);
  w.close();

  w = await t.loadPage(server, "index.html", { before: set({ enabled: true, mode: "learned", gapMinutes: 180 }) });
  line = w.document.getElementById("next-feed");
  t.ok("learned: uses the 2h average (due in 1h 30m)", /in 1h 30m/.test(line.textContent), line.textContent);
  w.close();

  w = await t.loadPage(server, "index.html", { before: set({ enabled: false, mode: "fixed", gapMinutes: 180 }) });
  t.ok("hidden when off", w.document.getElementById("next-feed").hidden);
  w.close();
};
