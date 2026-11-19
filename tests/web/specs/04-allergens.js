// Allergens: ticking a circle saves a try.
module.exports = async (t, { server }) => {
  const w = await t.loadPage(server, "allergens.html");
  const d = w.document;
  t.noErrors(w, "allergens.html");
  const dot = d.querySelector('[data-allergen][data-try="0"]');
  t.ok("allergen circles shown", !!dot);
  const key = dot.getAttribute("data-allergen");
  dot.click();
  await t.sleep(700);
  const list = (await t.api(server, "/api/allergens")).body;
  const record = (Array.isArray(list) ? list : list?.allergens || []).find(a => a.key === key);
  t.ok(`try saved for ${key}`, !!record && Array.isArray(record.tries) && !!record.tries[0], JSON.stringify(record));
  w.close();
};
