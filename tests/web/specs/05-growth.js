// Growth: with a birth date and sex set, the latest card shows a pink percentile.
module.exports = async (t, { server }) => {
  const settings = (await t.api(server, "/api/settings")).body || {};
  const dob = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
  const saved = await t.api(server, "/api/settings", { method: "POST", body: JSON.stringify({ ...settings, babyDob: dob, babySex: "girl" }) });
  t.ok("settings saved", saved.status === 200, JSON.stringify(saved.body));
  const today = new Date().toISOString().slice(0, 10);
  const m = await t.api(server, "/api/measurements", { method: "POST", body: JSON.stringify({ id: "test-m1", date: today, weightGrams: 5000, createdAt: new Date().toISOString() }) });
  t.ok("measurement saved", m.status === 200 || m.status === 201, JSON.stringify(m.body));

  const w = await t.loadPage(server, "measurements.html");
  t.noErrors(w, "measurements.html");
  const pct = w.document.querySelector(".percentile");
  t.ok("percentile shown in pink span", !!pct && /percentile/.test(pct.textContent), pct ? pct.textContent : "none");
  w.close();
};
