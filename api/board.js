// Tiny serverless function: checks the team passcode and saves the board in Redis (Upstash).
const crypto = require("crypto");

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TASKS = "msft:tasks";
const META = "msft:meta";

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || "redis error");
  return j.result;
}

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
function passcodeOk(given) {
  const want = process.env.TEAM_PASSCODE;
  if (!want) return null; // not configured
  return crypto.timingSafeEqual(sha(given || ""), sha(want));
}

const str = (v, max) => (typeof v === "string" && v.length <= max ? v : null);
function cleanTask(d) {
  if (!d || typeof d !== "object") return null;
  const assignee = str(d.assignee ?? "", 60), due = str(d.due ?? "", 60), notes = str(d.notes ?? "", 600);
  if (assignee === null || due === null || notes === null) return null;
  return { done: !!d.done, assignee, due, notes };
}
const KEY_RE = /^[A-Za-z0-9]{3,12}-[0-9]$/;
const pairs = (flat) => { const o = {}; for (let i = 0; i < (flat || []).length; i += 2) o[flat[i]] = flat[i + 1]; return o; };

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!REDIS_URL || !REDIS_TOKEN) return res.status(500).json({ error: "Database is not connected yet." });
    const ok = passcodeOk(req.headers["x-passcode"]);
    if (ok === null) return res.status(500).json({ error: "TEAM_PASSCODE is not set." });
    if (!ok) { await new Promise((r) => setTimeout(r, 400)); return res.status(401).json({ error: "Wrong passcode" }); }

    if (req.method === "GET") {
      const [t, m] = await Promise.all([redis(["HGETALL", TASKS]), redis(["HGETALL", META])]);
      const tasks = {};
      for (const [k, v] of Object.entries(pairs(t))) { try { tasks[k] = JSON.parse(v); } catch (_) {} }
      const meta = pairs(m);
      let roster = null; try { roster = meta.roster ? JSON.parse(meta.roster) : null; } catch (_) {}
      return res.status(200).json({ tasks, week: meta.week === undefined ? null : meta.week, roster });
    }

    if (req.method === "POST") {
      const b = req.body || {};
      if (b.op === "task") {
        const data = cleanTask(b.data);
        if (!KEY_RE.test(b.k || "") || !data) return res.status(400).json({ error: "Bad task" });
        await redis(["HSET", TASKS, b.k, JSON.stringify(data)]);
        return res.status(200).json({ ok: true });
      }
      if (b.op === "week") {
        const v = str(b.value, 40); if (v === null) return res.status(400).json({ error: "Bad week" });
        await redis(["HSET", META, "week", v]);
        return res.status(200).json({ ok: true });
      }
      if (b.op === "roster") {
        const names = Array.isArray(b.names) ? b.names : null;
        if (!names || names.length > 40 || names.some((n) => str(n, 40) === null || !n.trim())) return res.status(400).json({ error: "Bad roster" });
        await redis(["HSET", META, "roster", JSON.stringify(names)]);
        return res.status(200).json({ ok: true });
      }
      if (b.op === "reset") {
        const entries = Object.entries(b.tasks || {});
        if (entries.length > 200) return res.status(400).json({ error: "Too many tasks" });
        const cmd = ["HSET", TASKS];
        for (const [k, v] of entries) {
          const d = cleanTask(v);
          if (!KEY_RE.test(k) || !d) return res.status(400).json({ error: "Bad task" });
          cmd.push(k, JSON.stringify(d));
        }
        if (entries.length) await redis(cmd);
        await redis(["HSET", META, "week", ""]);
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: "Unknown request" });
    }
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
};
