// Medicine: button opens the popup, saves name + dose, shows a saved chip next time, appears in the Log.
module.exports = async (t, { server }) => {
  let w = await t.loadPage(server, "index.html");
  let d = w.document;
  t.noErrors(w, "index.html");
  t.ok("Medicine quick button shown", !!d.getElementById("quick-medicine") && !d.getElementById("quick-medicine").hidden);

  d.getElementById("quick-medicine").click();
  await t.sleep(400);
  t.ok("popup opens", d.getElementById("medicine-dialog").open);
  d.getElementById("medicine-dialog-name").value = "Vitamin D";
  d.getElementById("medicine-dialog-dose").value = "400 IU";
  d.getElementById("medicine-dialog-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await t.sleep(700);
  const meds = (await t.api(server, "/api/entries")).body.filter(e => e.medicine);
  t.ok("medicine saved with dose", meds.length === 1 && meds[0].medicine === "Vitamin D" && meds[0].medicineDose === "400 IU", JSON.stringify(meds));

  d.getElementById("quick-medicine").click();
  await t.sleep(700);
  const chip = d.querySelector('#medicine-dialog-saved [data-medicine-name="Vitamin D"]');
  t.ok("saved chip offered next time", !!chip);
  chip?.click();
  t.ok("chip fills name and dose", d.getElementById("medicine-dialog-name").value === "Vitamin D" && d.getElementById("medicine-dialog-dose").value === "400 IU");
  w.close();

  w = await t.loadPage(server, "log.html");
  d = w.document;
  t.noErrors(w, "log.html");
  t.ok("shown in the Log", d.body.textContent.includes("Vitamin D · 400 IU"));
  t.ok("counted in the day header", /1 medicine/.test(d.body.textContent));
  w.close();

  const bad = await t.api(server, "/api/entries", { method: "POST", body: JSON.stringify({ id: "m-bad", medicine: "x".repeat(81), timestamp: new Date().toISOString(), createdAt: new Date().toISOString() }) });
  t.ok("over-long name rejected", bad.status === 400);
};
