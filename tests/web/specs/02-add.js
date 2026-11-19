// Add page: quick feed and wee save straight away and update today's total.
module.exports = async (t, { server }) => {
  const before = (await t.api(server, "/api/entries")).body.length;
  const w = await t.loadPage(server, "index.html");
  const d = w.document;
  t.noErrors(w, "index.html");
  t.ok("quick add buttons shown", d.querySelectorAll("[data-quick]").length >= 8);

  d.getElementById("quick-wee").click();
  await t.sleep(600);
  d.getElementById("quick-feed").click();
  await t.sleep(800);

  const entries = (await t.api(server, "/api/entries")).body;
  t.ok("two entries saved", entries.length === before + 2, `${before} -> ${entries.length}`);
  t.ok("today's milk total updated", /[1-9]\d* ml/.test(d.getElementById("today-total").textContent), d.getElementById("today-total").textContent);
  t.ok("toast shown", (d.getElementById("toast-message")?.textContent || "").length > 0);
  w.close();
};
