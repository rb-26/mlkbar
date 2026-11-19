// Every page loads with app.js and no script errors.
const PAGES = ["index.html", "log.html", "food.html", "allergens.html", "measurements.html", "settings.html", "customise.html"];

module.exports = async (t, { server }) => {
  for (const page of PAGES) {
    const w = await t.loadPage(server, page, { wait: 600 });
    t.noErrors(w, page);
    t.ok(`${page}: has content`, w.document.querySelectorAll("main .panel").length > 0);
    t.ok(`${page}: bottom bar`, !!w.document.querySelector(".bottom-nav #menu-button"));
    w.close();
  }
};
