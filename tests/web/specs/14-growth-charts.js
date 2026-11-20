// Growth charts: 3 WHO charts with 5 percentile curves and a dot per measurement; build number in Settings.
module.exports = async (t) => {
  const server = await t.startServer({ port: 5191 });
  const settings = (await t.api(server, "/api/settings")).body;
  const dob = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  await t.api(server, "/api/settings", { method: "POST", body: JSON.stringify({ ...settings, babyDob: dob, babySex: "boy" }) });
  const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const add = (id, date, body) => t.api(server, "/api/measurements", { method: "POST", body: JSON.stringify({ id, date, createdAt: new Date().toISOString(), ...body }) });
  await add("g1", day(118), { weightGrams: 3500, lengthCm: 50, headCm: 35 });
  await add("g2", day(60), { weightGrams: 5200, lengthCm: 57 });
  await add("g3", day(2), { weightGrams: 6600, lengthCm: 63, headCm: 41 });

  let w = await t.loadPage(server, "measurements.html", { wait: 1500 });
  const d = w.document;
  t.noErrors(w, "measurements.html");
  const charts = [...d.querySelectorAll(".growth-chart")];
  t.ok("3 charts", charts.length === 3, String(charts.length));
  t.ok("5 curves each", charts.every(c => c.querySelectorAll("path.growth-curve").length === 5));
  t.ok("dots per measurement (3, 3, 2)", charts.map(c => c.querySelectorAll(".growth-dot").length).join() === "3,3,2",
    charts.map(c => c.querySelectorAll(".growth-dot").length).join());
  t.ok("charts after Latest", d.getElementById("measure-latest").closest("section").nextElementSibling.contains(d.getElementById("growth-charts")));
  w.close();

  w = await t.loadPage(server, "settings.html", { wait: 600 });
  t.ok("build number shown", /build \d{8}[a-z]/.test(w.document.getElementById("build-info").textContent), w.document.getElementById("build-info").textContent);
  w.close();
};
