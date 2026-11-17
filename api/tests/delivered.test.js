// POST /help/<id>/delivered: the responder arrived. Closes the request and tells the resident what was brought.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { makeServer } = require("./helper");

const s = makeServer();
before(() => s.start());
after(() => s.cleanup());

test("delivered: assigned, then delivered; the resident is told; the request leaves the open and assigned lists", async () => {
  const help = s.R("watch-0012", "l6-flint-face", "button", { button: "help" });
  assert.strictEqual((await s.post("/ingest", help)).status, 200);
  const id = encodeURIComponent(help.id);
  assert.strictEqual((await s.post(`/help/${id}/assign`, { to: "rover-01" })).status, 200);

  const r = await s.post(`/help/${id}/delivered`, { by: "rover-01", note: "med kit" });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.body.delivered.status, r.body.delivered.delivered_by, r.body.delivered.note, r.body.delivered.assigned_to],
    ["delivered", "rover-01", "med kit", "rover-01"]);
  assert.ok(!Number.isNaN(Date.parse(r.body.delivered.delivered_at)));

  assert.deepStrictEqual((await s.get("/help")).map((x) => x.id), [], "no longer open");
  assert.deepStrictEqual((await s.get("/help?status=assigned")).map((x) => x.id), [], "no longer on the way");
  const done = await s.get("/help?status=delivered");
  assert.deepStrictEqual(done.map((x) => [x.id, x.status, x.delivered_by]), [[help.id, "delivered", "rover-01"]]);
  assert.strictEqual((await s.get("/help?status=all")).length, 1);

  const inbox = await s.get("/inbox?device=watch-0012");
  const told = inbox.find((a) => a.values.responder === "rover-01" && /reached/.test(a.values.text));
  assert.ok(told, "the resident's watch is told the rover arrived");
  assert.match(told.values.text, /^rover-01 reached watch-0012 in l6-flint-face: med kit$/);
  assert.deepStrictEqual(told.values.to, ["watch-0012"]);

  assert.strictEqual((await s.post(`/help/${id}/delivered`, { by: "rover-01" })).status, 409, "never twice");
  assert.strictEqual((await s.post(`/help/${id}/assign`, { to: "rover-02" })).status, 409, "a delivered request cannot be reassigned");
});

test("delivered works on an open request (the responder went without being assigned) and survives a restart", async () => {
  const help = s.R("watch-0013", "l8-bore-bend", "button", { button: "help" });
  await s.post("/ingest", help);
  const id = encodeURIComponent(help.id);
  const r = await s.post(`/help/${id}/delivered`, { by: "rover-01" });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.body.delivered.status, r.body.delivered.assigned_to, r.body.delivered.note], ["delivered", "rover-01", null]);
  await s.restart();
  const after = (await s.get("/help?status=all")).find((x) => x.id === help.id);
  assert.deepStrictEqual([after.status, after.delivered_by], ["delivered", "rover-01"], "remembered across a restart");
});

test("delivered: bad requests are refused with a reason", async () => {
  const help = s.R("watch-0014", "l7-chalk-cut", "button", { button: "help" });
  await s.post("/ingest", help);
  const id = encodeURIComponent(help.id);
  assert.strictEqual((await s.post(`/help/${id}/delivered`, {})).status, 400, "no by");
  assert.strictEqual((await s.post(`/help/${id}/delivered`, { by: "rover-01", note: 5 })).status, 400, "note not a string");
  assert.strictEqual((await s.post(`/help/no-such-id/delivered`, { by: "rover-01" })).status, 404);
});
