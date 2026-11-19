// Food diary: suggested foods, the dot toggles a food on and off for the chosen day.
module.exports = async (t, { server }) => {
  let w = await t.loadPage(server, "food.html");
  let d = w.document;
  t.noErrors(w, "food.html");
  t.ok("suggested foods section shown", !d.getElementById("food-suggested").hidden);
  t.ok("suggested groups have pink headers", d.querySelectorAll("#food-groups .food-results-label").length >= 4);

  const banana = () => d.querySelector('#food-groups [data-food="Banana"]');
  t.ok("Banana row starts unticked", banana() && banana().getAttribute("aria-pressed") === "false");
  banana().click();
  await t.sleep(700);
  let foods = (await t.api(server, "/api/entries")).body.filter(e => e.food === "Banana");
  t.ok("tapping the dot logs Banana", foods.length === 1);
  t.ok("Banana row now ticked", banana().getAttribute("aria-pressed") === "true");
  t.ok("Banana listed under Recent", !!d.querySelector('#food-results [data-food="Banana"]'));

  banana().click();
  await t.sleep(700);
  foods = (await t.api(server, "/api/entries")).body.filter(e => e.food === "Banana");
  t.ok("tapping again removes it", foods.length === 0);

  const search = d.getElementById("food-search");
  search.value = "mang";
  search.dispatchEvent(new w.Event("input"));
  t.ok("search shows results", !!d.querySelector('#food-results [data-food="Mango"]'));
  t.ok("suggested hidden while searching", d.getElementById("food-suggested").hidden);
  w.close();
};
