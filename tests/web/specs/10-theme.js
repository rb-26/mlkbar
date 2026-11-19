// Appearance: Settings changes the theme straight away and theme.js applies the saved choice on load.
module.exports = async (t, { server }) => {
  let w = await t.loadPage(server, "settings.html");
  const d = w.document;
  t.noErrors(w, "settings.html");
  const select = d.getElementById("theme-select");
  t.ok("appearance setting shown, System by default", !!select && select.value === "system");
  select.value = "dark";
  select.dispatchEvent(new w.Event("change"));
  t.ok("dark applied immediately", d.documentElement.getAttribute("data-theme") === "dark");
  t.ok("choice saved", w.localStorage.getItem("mlkbar.theme") === "dark");
  select.value = "system";
  select.dispatchEvent(new w.Event("change"));
  t.ok("system removes the override", !d.documentElement.hasAttribute("data-theme"));
  w.close();

  w = await t.loadPage(server, "index.html", { before: win => win.localStorage.setItem("mlkbar.theme", "light") });
  t.ok("theme.js applies the saved choice", w.document.documentElement.getAttribute("data-theme") === "light");
  w.close();

  const css = await (await fetch(server.base + "/style.css")).text();
  t.ok("stylesheet has dark tokens", css.includes(':root[data-theme="dark"]') && css.includes("prefers-color-scheme: dark"));
  const themeJs = await fetch(server.base + "/theme.js");
  t.ok("theme.js is served", themeJs.ok);
};
