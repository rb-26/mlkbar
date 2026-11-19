// Light / Dark / System (Settings > Appearance), per browser. Runs in <head> so there's no flash.
(function () {
  var value = "system";
  try {
    value = window.localStorage.getItem("mlkbar.theme") || "system";
  } catch (error) {}
  if (value === "light" || value === "dark") {
    document.documentElement.setAttribute("data-theme", value);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
})();
