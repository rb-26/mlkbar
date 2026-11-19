// CSV export: header, entry rows in local time, formula-safe cells.
module.exports = async (t, { server }) => {
  const ts = new Date().toISOString();
  await t.api(server, "/api/entries", { method: "POST", body: JSON.stringify({ id: "csv-note", notes: "=SUM(A1)", timestamp: ts, createdAt: ts }) });
  const response = await fetch(server.base + "/api/export.csv");
  const text = (await response.text()).replace(/^﻿/, "");
  const lines = text.trim().split(/\r?\n/);
  t.ok("CSV downloads", response.ok && (response.headers.get("content-type") || "").includes("text/csv"));
  t.ok("header row", lines[0] === "Date,Time,Type,Amount,Unit,Duration (min),Details");
  t.ok("bottle feed rows with ml", lines.some(l => /,Bottle feed,\d+,ml,/.test(l)));
  t.ok("medicine row", lines.some(l => l.includes(",Medicine,") && l.includes("Vitamin D 400 IU")));
  t.ok("formula text neutralised", lines.some(l => l.includes("'=SUM(A1)")));
  const w = await t.loadPage(server, "settings.html");
  t.ok("Export CSV button in Settings", !!w.document.getElementById("export-csv-button"));
  w.close();
};
