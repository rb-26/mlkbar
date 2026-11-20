// Trends page: 7 charts, range buttons, averages over complete days, in the menu.
module.exports = async (t) => {
  const server = await t.startServer({ port: 5193 });
  const day = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return d; };
  const post = body => t.api(server, "/api/entries", { method: "POST", body: JSON.stringify(body) });
  for (const n of [1, 2]) {
    for (const [h, i] of [[0, 0], [3, 1], [6, 2]]) {
      const ts = new Date(day(n).getTime() + h * 3600000).toISOString();
      await post({ id: `t-f${n}-${i}`, milkMl: 100, timestamp: ts, createdAt: ts });
    }
    const ts = day(n).toISOString();
    await post({ id: `t-n${n}`, napMinutes: 90, timestamp: ts, createdAt: ts });
    await post({ id: `t-p${n}`, poo: "2", timestamp: ts, createdAt: ts });
    await post({ id: `t-w${n}`, poo: "wee", timestamp: ts, createdAt: ts });
  }
  const w = await t.loadPage(server, "trends.html", { wait: 1500 });
  const d = w.document;
  t.noErrors(w, "trends.html");
  const cards = [...d.querySelectorAll(".trend-card")];
  t.ok("7 charts", cards.length === 7, String(cards.length));
  const avg = title => cards.find(c => c.querySelector("h3").textContent === title)?.querySelector(".trend-avg").textContent;
  t.ok("milk average 300 ml a day", avg("Milk") === "Avg 300 ml a day", avg("Milk"));
  t.ok("feeds average 3", avg("Feeds") === "Avg 3 a day", avg("Feeds"));
  t.ok("sleep average 1h 30m", avg("Sleep") === "Avg 1h 30m a day", avg("Sleep"));
  t.ok("gap average 3h", avg("Time between feeds") === "Avg 3h", avg("Time between feeds"));
  t.ok("30 bars by default", cards[0].querySelectorAll("rect").length === 30, String(cards[0].querySelectorAll("rect").length));
  d.querySelector('[data-range="7"]').click();
  t.ok("7-day range", d.querySelectorAll(".trend-card")[0].querySelectorAll("rect").length === 7);
  t.ok("range remembered", w.localStorage.getItem("mlkbar.trendsDays") === "7");
  t.ok("Trends in the menu", !!d.querySelector('.menu-link.active[href="/trends.html"]'));
  w.close();
};
