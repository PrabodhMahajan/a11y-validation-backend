/**
 * Accessibility Validation Platform — Backend
 * MongoDB storage, Playwright + axe-core live crawl, human-in-the-loop sessions.
 */

import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import { v4 as uuidv4 } from "uuid";
import { WCAG_CRITERIA, DISABILITIES, getCriteriaForDisability } from "./wcag-criteria.js";
import { crawlSite } from "./crawler.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ─── MongoDB connection ─────────────────────────────────────────────────────

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("MONGO_URI environment variable is required");
  process.exit(1);
}

await mongoose.connect(MONGO_URI, { dbName: "a11y_validation" });
console.log("Connected to MongoDB");

// ─── Session schema ─────────────────────────────────────────────────────────

const sessionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  siteUrl: String,
  auditorName: String,
  createdAt: String,
  updatedAt: String,
  completedAt: String,
  status: { type: String, default: "in_progress" },
  auditJson: mongoose.Schema.Types.Mixed,
  automatedViolations: { type: Array, default: [] },
  humanConfirmed: { type: Array, default: [] },
  humanDisputed: { type: Array, default: [] },
  humanAdded: { type: Array, default: [] },
  checklistResponses: { type: mongoose.Schema.Types.Mixed, default: {} },
  participants: { type: Array, default: [] },
  metrics: { type: mongoose.Schema.Types.Mixed, default: { X: 0, Y: 0, Z: 0, N: 0, falsePositiveRate: 0 } },
}, { strict: false });

const Session = mongoose.model("Session", sessionSchema);

// ─── Helpers ────────────────────────────────────────────────────────────────

function computeMetrics(session) {
  const X = session.auditJson?.siteSummary?.totalViolationInstances || 0;
  const Y = (session.humanConfirmed || []).length;
  const Z = (session.humanAdded || []).length;
  const disputed = (session.humanDisputed || []).length;
  const total = Y + Z;
  const N = total > 0 ? Math.round((X / total) * 100) : 0;
  const falsePositiveRate = X > 0 ? Math.round((disputed / X) * 100) : 0;
  return { X, Y, Z, N, falsePositiveRate, disputed };
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Routes ─────────────────────────────────────────────────────────────────

app.get("/", (req, res) => res.json({ status: "ok", service: "a11y-validation-platform" }));

// GET /criteria
app.get("/criteria", (req, res) => {
  res.json({ disabilities: DISABILITIES, criteria: WCAG_CRITERIA });
});

app.get("/criteria/disability/:id", (req, res) => {
  res.json({ criteria: getCriteriaForDisability(req.params.id) });
});

// POST /crawl — live Playwright + axe-core audit with SSE progress stream
app.post("/crawl", async (req, res) => {
  const { url, maxPages = 8 } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  function send(type, data) {
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  }

  try {
    send("status", "Starting live Playwright + axe-core audit...");
    const result = await crawlSite(url, {
      maxPages,
      onProgress: (msg) => send("progress", msg),
    });
    send("status", "Crawl complete — processing results...");
    send("complete", result);
    res.end();
  } catch (err) {
    send("error", err.message);
    res.end();
  }
});

// POST /sessions — create session
app.post("/sessions", async (req, res) => {
  const { siteUrl, auditorName, auditJson } = req.body;
  if (!siteUrl) return res.status(400).json({ error: "siteUrl is required" });

  const session = new Session({
    id: uuidv4(),
    siteUrl,
    auditorName: auditorName || "Unknown",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "in_progress",
    auditJson: auditJson || null,
    automatedViolations: auditJson?.ruleAggregate || [],
    humanConfirmed: [],
    humanDisputed: [],
    humanAdded: [],
    checklistResponses: {},
    participants: [],
  });

  session.metrics = computeMetrics(session);
  await session.save();

  res.status(201).json({
    sessionId: session.id,
    url: `/sessions/${session.id}`,
    message: "Session created. Share this URL with validators.",
  });
});

// GET /sessions/:id
app.get("/sessions/:id", async (req, res) => {
  const session = await Session.findOne({ id: req.params.id }).lean();
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(session);
});

// PATCH /sessions/:id
app.patch("/sessions/:id", async (req, res) => {
  const session = await Session.findOne({ id: req.params.id });
  if (!session) return res.status(404).json({ error: "Session not found" });

  const allowed = ["humanConfirmed", "humanDisputed", "humanAdded", "checklistResponses", "participants", "status", "auditorName"];
  allowed.forEach((f) => { if (req.body[f] !== undefined) session[f] = req.body[f]; });

  session.metrics = computeMetrics(session);
  session.updatedAt = new Date().toISOString();
  session.markModified("humanConfirmed");
  session.markModified("humanDisputed");
  session.markModified("humanAdded");
  session.markModified("checklistResponses");
  session.markModified("participants");
  await session.save();

  res.json({ ok: true, metrics: session.metrics });
});

// POST /sessions/:id/complete
app.post("/sessions/:id/complete", async (req, res) => {
  const session = await Session.findOne({ id: req.params.id });
  if (!session) return res.status(404).json({ error: "Session not found" });
  session.status = "completed";
  session.completedAt = new Date().toISOString();
  session.updatedAt = new Date().toISOString();
  await session.save();
  res.json({ ok: true, sessionId: session.id });
});

// GET /sessions — list all
app.get("/sessions", async (req, res) => {
  const sessions = await Session.find({}, {
    id: 1, siteUrl: 1, auditorName: 1, status: 1,
    createdAt: 1, metrics: 1, participants: 1,
  }).lean().sort({ createdAt: -1 });

  res.json(sessions.map((s) => ({
    ...s,
    participantCount: (s.participants || []).length,
  })));
});

// GET /sessions/:id/report — HTML report
app.get("/sessions/:id/report", async (req, res) => {
  const session = await Session.findOne({ id: req.params.id }).lean();
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.setHeader("Content-Type", "text/html");
  res.send(generateReport(session));
});

// ─── Report generator ────────────────────────────────────────────────────────

function generateReport(session) {
  const { metrics, siteUrl, auditorName, humanConfirmed, humanDisputed, humanAdded, checklistResponses, participants, createdAt, completedAt } = session;
  const checkedCriteria = Object.entries(checklistResponses || {});
  const failedCriteria = checkedCriteria.filter(([, r]) => r.status === "fail" || r.status === "partial");
  const passedCriteria = checkedCriteria.filter(([, r]) => r.status === "pass");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Validation Report — ${escapeHtml(siteUrl)}</title>
<style>
  :root { --ink:#1a1a1a;--ink-soft:#545454;--paper:#fdfcfa;--line:#e3ddd2;--accent:#185FA5;--critical:#A32D2D;--critical-bg:#FCEBEB;--serious:#B5530E;--serious-bg:#FCEFE3;--success:#3B6D11;--success-bg:#EAF3DE;--disability:#6B3FA0;--disability-bg:#F3EBFA; }
  *{box-sizing:border-box;} body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--paper);color:var(--ink);margin:0;line-height:1.6;}
  .wrap{max-width:1020px;margin:0 auto;padding:3rem 1.5rem 6rem;}
  header{border-bottom:2px solid var(--ink);padding-bottom:1.5rem;margin-bottom:2rem;}
  .eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--ink-soft);margin-bottom:8px;}
  h1{font-size:26px;font-weight:600;margin:0 0 6px;}
  h2{font-size:18px;font-weight:600;margin:0 0 8px;}
  .meta{font-size:13px;color:var(--ink-soft);display:flex;flex-wrap:wrap;gap:16px;margin-top:10px;}
  .metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:2rem;}
  .mc{background:white;border:1px solid var(--line);border-radius:10px;padding:14px 16px;}
  .mc .l{font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:var(--ink-soft);margin-bottom:2px;}
  .mc .v{font-size:28px;font-weight:700;}
  .mc .s{font-size:11px;color:var(--ink-soft);margin-top:2px;}
  .formula-box{background:white;border:1px solid var(--line);border-radius:12px;padding:20px 24px;margin-bottom:2rem;}
  .formula{font-family:ui-monospace,monospace;font-size:14px;background:#f0eee8;padding:10px 14px;border-radius:8px;margin:10px 0;}
  section{margin-bottom:2rem;}
  .card{background:white;border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:8px;}
  .pill{display:inline-block;font-size:11px;padding:2px 8px;border-radius:99px;font-weight:600;margin-right:4px;}
  .pill-added{background:var(--disability-bg);color:var(--disability);}
  .pill-confirmed{background:var(--success-bg);color:var(--success);}
  .pill-disputed{background:#FFF8E1;color:#B8860B;}
  table{width:100%;border-collapse:collapse;font-size:13px;}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:var(--ink-soft);padding:8px 10px;border-bottom:1px solid var(--ink);}
  td{padding:10px;border-bottom:1px solid var(--line);vertical-align:top;}
  .code-block{font-family:ui-monospace,monospace;font-size:11px;background:#1e1e1e;color:#d4d4d4;padding:10px 12px;border-radius:8px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;margin-top:6px;}
  footer{margin-top:3rem;padding-top:1.5rem;border-top:1px solid var(--line);font-size:12px;color:var(--ink-soft);line-height:1.7;}
  @media print{body{background:white;}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <p class="eyebrow">Human-in-the-Loop Validation Report · ${session.status === "completed" ? "Completed" : "In Progress"}</p>
    <h1>${escapeHtml(siteUrl)}</h1>
    <div class="meta">
      <span>🕒 ${new Date(createdAt).toLocaleString("en-GB")}</span>
      ${completedAt ? `<span>✅ Completed: ${new Date(completedAt).toLocaleString("en-GB")}</span>` : ""}
      <span>👤 ${escapeHtml(auditorName)}</span>
      <span>👥 ${(participants || []).length} participant(s)</span>
    </div>
  </header>

  <div class="metric-grid">
    <div class="mc"><div class="l">X — Automated</div><div class="v" style="color:var(--critical)">${metrics.X}</div><div class="s">violation instances (axe-core)</div></div>
    <div class="mc"><div class="l">Y — Confirmed</div><div class="v" style="color:var(--serious)">${metrics.Y}</div><div class="s">validated as real by humans</div></div>
    <div class="mc"><div class="l">Z — Added</div><div class="v" style="color:var(--disability)">${metrics.Z}</div><div class="s">barriers missed by automation</div></div>
    <div class="mc"><div class="l">N% — Coverage</div><div class="v" style="color:var(--accent)">${metrics.N}%</div><div class="s">automated coverage of real barriers</div></div>
    <div class="mc"><div class="l">False positive rate</div><div class="v">${metrics.falsePositiveRate || 0}%</div><div class="s">automated findings disputed</div></div>
  </div>

  <div class="formula-box">
    <h2>📐 Accuracy formula</h2>
    <div class="formula">N% = X ÷ (Y + Z) = ${metrics.X} ÷ (${metrics.Y} + ${metrics.Z}) = ${metrics.N}%</div>
    <p style="font-size:13px;color:var(--ink-soft);margin:0">
      Automated testing (Playwright + axe-core, Deque Systems) detected <strong>${metrics.X} violation instances</strong>.
      Human validation confirmed <strong>${metrics.Y}</strong> as genuine barriers and identified <strong>${metrics.Z} additional barriers</strong> invisible to automation.
      Automated tools captured approximately <strong>${metrics.N}% of total real barriers</strong>.
      Reference: GDS (2017) benchmark — best automated tool detects 40% of barriers.
      This session: ${metrics.N}% ${metrics.N > 40 ? "(above benchmark)" : metrics.N < 40 ? "(below benchmark)" : "(matches benchmark)"}.
    </p>
  </div>

  ${(humanAdded || []).length > 0 ? `
  <section>
    <h2>🆕 Barriers found only by human validation (Z = ${humanAdded.length})</h2>
    <p style="font-size:13px;color:var(--ink-soft);margin-bottom:1rem">These barriers were missed entirely by automated testing — the core evidence for why human-in-the-loop validation is necessary.</p>
    ${humanAdded.map((b) => {
      const criterion = WCAG_CRITERIA.find((c) => c.id === b.wcagCriterionId);
      const disability = DISABILITIES.find((d) => d.id === b.disabilityId);
      return `<div class="card">
        <span class="pill pill-added">Human-identified</span>
        <span class="pill" style="background:var(--critical-bg);color:var(--critical)">${escapeHtml(b.severity || "")}</span>
        <strong style="font-size:14px;display:block;margin:6px 0 2px">${escapeHtml(b.title)}</strong>
        <p style="font-size:12px;color:var(--ink-soft);margin:0 0 8px">${disability ? disability.icon + " " + disability.label : ""} ${criterion ? "· WCAG " + criterion.id + " " + criterion.title : ""}</p>
        <p style="font-size:13px;margin:0 0 4px"><strong>Where:</strong> ${escapeHtml(b.whereFound || "Not specified")}</p>
        <p style="font-size:13px;margin:0 0 4px"><strong>Description:</strong> ${escapeHtml(b.description)}</p>
        ${criterion ? `<p style="font-size:13px;margin:0 0 4px"><strong>How to fix:</strong> ${escapeHtml(criterion.howToImplement)}</p><div class="code-block">${escapeHtml(criterion.codeExample)}</div>` : ""}
      </div>`;
    }).join("")}
  </section>` : ""}

  ${(humanConfirmed || []).length > 0 ? `
  <section>
    <h2>✅ Automated violations confirmed by humans (Y = ${humanConfirmed.length})</h2>
    ${humanConfirmed.map((c) => `<div class="card"><span class="pill pill-confirmed">✓ Confirmed</span> <strong>${escapeHtml(c.violationId)}</strong>${c.note ? `<p style="font-size:12px;color:var(--ink-soft);margin:4px 0 0">${escapeHtml(c.note)}</p>` : ""}</div>`).join("")}
  </section>` : ""}

  ${(humanDisputed || []).length > 0 ? `
  <section>
    <h2>⚠ Automated findings disputed (${humanDisputed.length})</h2>
    ${humanDisputed.map((d) => `<div class="card"><span class="pill pill-disputed">⚠ Disputed</span> <strong>${escapeHtml(d.violationId)}</strong>${d.reason ? `<p style="font-size:12px;color:var(--ink-soft);margin:4px 0 0">${escapeHtml(d.reason)}</p>` : ""}</div>`).join("")}
  </section>` : ""}

  ${checkedCriteria.length > 0 ? `
  <section>
    <h2>📋 WCAG checklist results (${failedCriteria.length} failures, ${passedCriteria.length} passes, ${checkedCriteria.length} reviewed)</h2>
    <table>
      <thead><tr><th>Criterion</th><th>Level</th><th>Status</th><th>Tested by</th><th>Notes</th></tr></thead>
      <tbody>
        ${checkedCriteria.sort((a, b) => {
          const o = { fail: 0, partial: 1, not_tested: 2, pass: 3 };
          return (o[a[1].status] || 2) - (o[b[1].status] || 2);
        }).map(([cid, r]) => {
          const c = WCAG_CRITERIA.find((x) => x.id === cid);
          const sl = { pass: "✓ Pass", fail: "✗ Fail", partial: "~ Partial", not_tested: "— Not tested" };
          const sc = { pass: "color:var(--success)", fail: "color:var(--critical)", partial: "color:var(--serious)", not_tested: "color:var(--ink-soft)" };
          return `<tr><td><strong>${escapeHtml(cid)}</strong>${c ? ` — ${escapeHtml(c.title)}` : ""}</td><td>${c?.level || "?"}</td><td style="${sc[r.status] || ""};font-weight:600">${sl[r.status] || r.status}</td><td>${escapeHtml(r.testedBy || "—")}</td><td>${escapeHtml(r.note || "—")}</td></tr>`;
        }).join("")}
      </tbody>
    </table>
  </section>` : ""}

  <footer>
    <p><strong>Methodology:</strong> Automated audit via Playwright (real headless Chromium) + axe-core v4.9 (Deque Systems), the engine used by GDS, WebAIM, and BarrierBreak. Human validation adds lived-experience evidence. N% = X/(Y+Z) measures automated tool coverage of real barriers. Session ID: ${session.id}.</p>
    <p style="margin-top:6px">Generated for: "Nothing About Us Without Us: Participatory Governance and AI as Tools for Digital Accessibility Reform in India and the UK" — UCL STEaPP MPA Individual Project.</p>
  </footer>
</div>
</body>
</html>`;
}

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
