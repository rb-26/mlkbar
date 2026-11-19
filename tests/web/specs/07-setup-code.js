// Fresh server: the first password needs the one-time setup code from the logs.
module.exports = async (t) => {
  const fresh = await t.startServer({ port: 5198, authed: false });
  const match = fresh.log().match(/setup code: ([A-Z0-9]{4}-[A-Z0-9]{4})/);
  t.ok("setup code printed in the logs", !!match, fresh.log().slice(0, 200));

  const w = await t.loadPage(fresh, "login.html");
  t.noErrors(w, "login.html");
  t.ok("setup code field shown", !w.document.getElementById("setup-code-field").hidden);
  w.close();

  const wrong = await t.api(fresh, "/api/auth/setup", { method: "POST", body: JSON.stringify({ password: "password123", setupCode: "AAAA-AAAA" }) });
  t.ok("wrong code rejected", wrong.status === 403);
  const right = await t.api(fresh, "/api/auth/setup", { method: "POST", body: JSON.stringify({ password: "password123", setupCode: match ? match[1] : "" }) });
  t.ok("right code accepted", right.status === 200);
  const again = await t.api(fresh, "/api/auth/setup", { method: "POST", body: JSON.stringify({ password: "password456", setupCode: match ? match[1] : "" }) });
  t.ok("can't set up twice", again.status === 409);
};
