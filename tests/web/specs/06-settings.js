// Settings: PDF report has its own section; the report downloads.
module.exports = async (t, { server }) => {
  const w = await t.loadPage(server, "settings.html");
  const d = w.document;
  t.noErrors(w, "settings.html");
  const headings = [...d.querySelectorAll(".panel-heading h2")].map(h => h.textContent.trim());
  t.ok("PDF Report section", headings.includes("PDF Report"));
  t.ok("Export & Import section", headings.includes("Export & Import"));
  t.ok("report button not inside Export & Import",
    !d.getElementById("export-button").closest("section").contains(d.getElementById("report-button")));
  w.close();
  const response = await fetch(server.base + "/api/report.pdf?days=7");
  const type = response.headers.get("content-type") || "";
  t.ok("PDF report generates", response.ok && type.includes("pdf"), `${response.status} ${type}`);
};
