/**
 * Accessibility Validation Platform — Backend
 * Handles session creation, updates, and report generation.
 *
 * Research project: "Nothing About Us Without Us: Participatory Governance
 * and AI as Tools for Digital Accessibility Reform in India and the UK"
 */

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import { WCAG_CRITERIA, DISABILITIES, getCriteriaForDisability } from "./wcag-criteria.js";
import { crawlSite } from "./crawler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = path.join(__dirname, "sessions");

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ─── Helpers ───────────────────────────────────────────────────────────────

function sessionPath(id) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

function loadSession(id) {
  const p = sessionPath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveSession(session) {
  fs.writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2));
}

// ─── Routes ────────────────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => res.json({ status: "ok", service: "a11y-validation-platform" }));

// POST /crawl — run a live Playwright + axe-core crawl
// Returns SSE stream so the client can show progress in real time
// Body: { url, maxPages }
app.post("/crawl", async (req, res) => {
  const { url, maxPages = 8 } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  // Server-Sent Events for real-time progress
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  function send(type, data) {
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  }

  try {
    send("status", "Starting crawl...");

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

// GET /criteria — return all WCAG criteria + disabilities
app.get("/criteria", (req, res) => {
  res.json({ disabilities: DISABILITIES, criteria: WCAG_CRITERIA });
});

// GET /criteria/disability/:id — criteria for one disability
app.get("/criteria/disability/:id", (req, res) => {
  const criteria = getCriteriaForDisability(req.params.id);
  res.json({ criteria });
});

// POST /sessions — create a new session
// Body: { siteUrl, auditorName, auditJson (optional — if not provided, client should crawl first) }
app.post("/sessions", (req, res) => {
  const { siteUrl, auditorName, auditJson } = req.body;

  if (!siteUrl) return res.status(400).json({ error: "siteUrl is required" });

  const session = {
    id: uuidv4(),
    siteUrl,
    auditorName: auditorName || "Unknown",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "in_progress", // in_progress | completed
    auditJson: auditJson || null,

    // Core data structure:
    // automatedViolations: from axe-core (X)
    // humanConfirmed: subset of automated that humans validated as real (Y)
    // humanDisputed: automated findings humans say are false positives
    // humanAdded: new barriers humans found that automation missed (Z)
    // This produces: N% = X / (Y + Z) automated coverage rate

    automatedViolations: auditJson?.ruleAggregate || [],
    humanConfirmed: [],   // { violationId, confirmedBy, note, timestamp }
    humanDisputed: [],    // { violationId, disputedBy, reason, timestamp }
    humanAdded: [],       // { id, title, disabilityId, wcagCriterionId, description, whereFound, severity, confirmedBy, timestamp }

    // Checklist responses per criterion
    checklistResponses: {}, // criterionId -> { status: "pass"|"fail"|"partial"|"not_tested", note, testedBy, timestamp }

    // Session participants
    participants: [], // { name, role, disabilityId (if PwD), addedAt }

    // Metrics (computed on save)
    metrics: {
      X: 0, // automated violation instances
      Y: 0, // human confirmed
      Z: 0, // human added
      N: 0, // automated coverage %
      falsePositiveRate: 0,
    },
  };

  // Pre-populate X from the audit JSON
  if (auditJson?.siteSummary) {
    session.metrics.X = auditJson.siteSummary.totalViolationInstances || 0;
  }

  saveSession(session);

  res.status(201).json({
    sessionId: session.id,
    url: `/sessions/${session.id}`,
    message: "Session created. Share this URL with validators.",
  });
});

// GET /sessions/:id — load session state
app.get("/sessions/:id", (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(session);
});

// PATCH /sessions/:id — update session (incremental saves during facilitation)
app.patch("/sessions/:id", (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const allowed = [
    "humanConfirmed", "humanDisputed", "humanAdded",
    "checklistResponses", "participants", "status", "auditorName",
  ];

  allowed.forEach((field) => {
    if (req.body[field] !== undefined) {
      session[field] = req.body[field];
    }
  });

  // Recompute metrics
  const X = session.metrics.X;
  const Y = session.humanConfirmed.length;
  const Z = session.humanAdded.length;
  const total = Y + Z;
  const N = total > 0 ? Math.round((X / total) * 100) : 0;
  const disputed = session.humanDisputed.length;
  const falsePositiveRate = X > 0 ? Math.round((disputed / X) * 100) : 0;

  session.metrics = { X, Y, Z, N, falsePositiveRate, disputed };
  session.updatedAt = new Date().toISOString();

  saveSession(session);
  res.json({ ok: true, metrics: session.metrics });
});

// POST /sessions/:id/complete — mark session as complete
app.post("/sessions/:id/complete", (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  session.status = "completed";
  session.completedAt = new Date().toISOString();
  session.updatedAt = new Date().toISOString();
  saveSession(session);
  res.json({ ok: true, sessionId: session.id });
});

// GET /sessions/:id/report — generate HTML report
app.get("/sessions/:id/report", (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const html = generateReport(session);
  res.setHeader("Content-Type", "text/html");
  res.send(html);
});

// GET /sessions — list all sessions (for admin view)
app.get("/sessions", (req, res) => {
  const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  const sessions = files.map((f) => {
    const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8"));
    return {
      id: s.id,
      siteUrl: s.siteUrl,
      auditorName: s.auditorName,
      status: s.status,
      createdAt: s.createdAt,
      metrics: s.metrics,
      participantCount: s.participants?.length || 0,
    };
  });
  res.json(sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

// ─── Report Generator ──────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function severityColor(sev) {
  return { Critical: "#A32D2D", Serious: "#B5530E", Moderate: "#185FA5", Minor: "#3B6D11" }[sev] || "#888";
}

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
<title>Validation Session Report — ${escapeHtml(siteUrl)}</title>
<style>
  :root {
    --ink: #1a1a1a; --ink-soft: #545454; --paper: #fdfcfa; --line: #e3ddd2;
    --accent: #185FA5; --critical: #A32D2D; --serious: #B5530E;
    --moderate: #185FA5; --minor: #3B6D11; --disability: #6B3FA0;
    --success: #3B6D11; --success-bg: #EAF3DE;
    --warning: #B5530E; --warning-bg: #FCEFE3;
  }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--paper); color: var(--ink); margin: 0; line-height: 1.6; }
  .wrap { max-width: 1020px; margin: 0 auto; padding: 3rem 1.5rem 6rem; }

  header { border-bottom: 2px solid var(--ink); padding-bottom: 1.5rem; margin-bottom: 2rem; }
  .eyebrow { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-soft); margin-bottom: 8px; }
  h1 { font-size: 26px; font-weight: 600; margin: 0 0 6px; word-break: break-word; }
  .meta-row { font-size: 13px; color: var(--ink-soft); display: flex; flex-wrap: wrap; gap: 16px; margin-top: 10px; }

  .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 2.5rem; }
  .metric-card { border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; background: white; }
  .metric-card .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-soft); margin-bottom: 4px; }
  .metric-card .value { font-size: 28px; font-weight: 700; }
  .metric-card .sub { font-size: 11px; color: var(--ink-soft); margin-top: 2px; }

  .accuracy-box { background: white; border: 1px solid var(--line); border-radius: 12px; padding: 20px 24px; margin-bottom: 2.5rem; }
  .accuracy-formula { font-family: ui-monospace, monospace; font-size: 14px; background: #f0eee8; padding: 10px 14px; border-radius: 8px; margin: 10px 0; }
  .accuracy-interpretation { font-size: 13px; color: var(--ink-soft); margin-top: 8px; }

  section { margin-bottom: 2.5rem; }
  h2 { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
  .section-sub { font-size: 13px; color: var(--ink-soft); margin-bottom: 1rem; }

  .finding-card { border: 1px solid var(--line); border-radius: 10px; background: white; margin-bottom: 10px; overflow: hidden; }
  .finding-head { padding: 12px 16px; display: flex; align-items: flex-start; gap: 12px; }
  .finding-body { border-top: 1px solid var(--line); padding: 12px 16px; background: #fcfbf9; font-size: 13px; }
  .finding-title { font-size: 14px; font-weight: 600; margin: 0 0 3px; }
  .finding-sub { font-size: 12px; color: var(--ink-soft); margin: 0; }
  .pill { font-size: 11px; padding: 2px 8px; border-radius: 99px; font-weight: 600; white-space: nowrap; display: inline-block; margin-right: 4px; }
  .pill-confirmed { background: var(--success-bg); color: var(--success); }
  .pill-disputed { background: #FFF8E1; color: #B8860B; }
  .pill-added { background: #F3EBFA; color: var(--disability); }
  .pill-severity { color: white; }
  .note-box { background: #f7f5f0; border-left: 3px solid var(--line); padding: 8px 12px; border-radius: 0 6px 6px 0; margin-top: 8px; font-size: 12px; color: var(--ink-soft); }
  code.inline { font-family: ui-monospace, monospace; font-size: 11px; background: #f0eee8; padding: 1px 5px; border-radius: 4px; }
  .code-block { font-family: ui-monospace, monospace; font-size: 11px; background: #1e1e1e; color: #d4d4d4; padding: 10px 12px; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; margin-top: 8px; }

  .checklist-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .checklist-table th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-soft); padding: 8px 10px; border-bottom: 1px solid var(--ink); }
  .checklist-table td { padding: 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .status-pass { color: var(--success); font-weight: 600; }
  .status-fail { color: var(--critical); font-weight: 600; }
  .status-partial { color: var(--warning); font-weight: 600; }
  .status-not_tested { color: var(--ink-soft); }

  .participant-list { display: flex; flex-wrap: wrap; gap: 8px; }
  .participant-chip { background: white; border: 1px solid var(--line); border-radius: 99px; padding: 4px 12px; font-size: 12px; }

  footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--line); font-size: 12px; color: var(--ink-soft); line-height: 1.7; }

  @media print {
    body { background: white; }
    .no-print { display: none; }
    .finding-body { display: block !important; }
  }
</style>
</head>
<body>
<div class="wrap">

  <header>
    <p class="eyebrow">Human-in-the-Loop Validation Report · ${session.status === "completed" ? "Completed" : "In Progress"}</p>
    <h1>${escapeHtml(siteUrl)}</h1>
    <div class="meta-row">
      <span>🕒 Session started: ${new Date(createdAt).toLocaleString("en-GB")}</span>
      ${completedAt ? `<span>✅ Completed: ${new Date(completedAt).toLocaleString("en-GB")}</span>` : ""}
      <span>👤 Led by: ${escapeHtml(auditorName)}</span>
      <span>👥 ${participants.length} participant${participants.length !== 1 ? "s" : ""}</span>
    </div>
  </header>

  <!-- Accuracy Metrics -->
  <div class="metric-grid">
    <div class="metric-card">
      <div class="label">X — Automated violations</div>
      <div class="value" style="color:var(--critical)">${metrics.X}</div>
      <div class="sub">instances found by axe-core</div>
    </div>
    <div class="metric-card">
      <div class="label">Y — Human confirmed</div>
      <div class="value" style="color:var(--serious)">${metrics.Y}</div>
      <div class="sub">automated findings validated as real</div>
    </div>
    <div class="metric-card">
      <div class="label">Z — Human added</div>
      <div class="value" style="color:var(--disability)">${metrics.Z}</div>
      <div class="sub">barriers missed by automation</div>
    </div>
    <div class="metric-card">
      <div class="label">N% — Automation coverage</div>
      <div class="value" style="color:var(--accent)">${metrics.N}%</div>
      <div class="sub">of real barriers caught automatically</div>
    </div>
    <div class="metric-card">
      <div class="label">False positive rate</div>
      <div class="value">${metrics.falsePositiveRate || 0}%</div>
      <div class="sub">automated findings disputed by humans</div>
    </div>
  </div>

  <div class="accuracy-box">
    <h2 style="margin:0 0 8px">📐 Accuracy formula</h2>
    <div class="accuracy-formula">N% = X ÷ (Y + Z) = ${metrics.X} ÷ (${metrics.Y} + ${metrics.Z}) = ${metrics.N}%</div>
    <p class="accuracy-interpretation">
      Automated testing detected <strong>${metrics.X} violation instances</strong>.
      Human validation confirmed <strong>${metrics.Y} of those</strong> as genuine barriers
      and identified <strong>${metrics.Z} additional barriers</strong> invisible to automation.
      Automated tools therefore captured approximately <strong>${metrics.N}% of total real barriers</strong>,
      with the remaining <strong>${100 - metrics.N}% requiring human or lived-experience validation</strong>.
      ${metrics.falsePositiveRate > 0 ? `Additionally, <strong>${metrics.falsePositiveRate}% of automated findings were disputed</strong> by human reviewers as potential false positives.` : ""}
    </p>
    <p class="accuracy-interpretation" style="margin-top:6px;font-style:italic">
      Reference: GDS (2017) found the best automated tool detects 40% of known accessibility barriers.
      This session's finding of ${metrics.N}% ${metrics.N > 40 ? "exceeds" : metrics.N < 40 ? "is below" : "matches"} that benchmark.
    </p>
  </div>

  <!-- Participants -->
  ${participants.length > 0 ? `
  <section>
    <h2>👥 Session participants</h2>
    <div class="participant-list">
      ${participants.map((p) => `
        <span class="participant-chip">
          ${escapeHtml(p.name)}
          ${p.role ? `· ${escapeHtml(p.role)}` : ""}
          ${p.disabilityLabel ? `· ${escapeHtml(p.disabilityLabel)}` : ""}
        </span>`).join("")}
    </div>
  </section>` : ""}

  <!-- Human-Added Barriers (Z) -->
  ${humanAdded.length > 0 ? `
  <section>
    <h2>🆕 Barriers found only by human validation (Z = ${humanAdded.length})</h2>
    <p class="section-sub">These accessibility barriers were identified by human reviewers and missed entirely by automated testing. This is the core evidence for why human-in-the-loop validation is necessary.</p>
    ${humanAdded.map((b) => {
      const criterion = WCAG_CRITERIA.find((c) => c.id === b.wcagCriterionId);
      const disability = DISABILITIES.find((d) => d.id === b.disabilityId);
      return `
      <div class="finding-card">
        <div class="finding-head">
          <div style="flex:1">
            <p class="finding-title">${escapeHtml(b.title)}</p>
            <p class="finding-sub">${disability ? disability.icon + " " + disability.label : ""} ${criterion ? "· WCAG " + criterion.id + " " + criterion.title : ""}</p>
            <span class="pill pill-added">Human-identified</span>
            <span class="pill" style="background:#FCEBEB;color:#A32D2D">${escapeHtml(b.severity || "Not rated")}</span>
          </div>
        </div>
        <div class="finding-body">
          <p><strong>Where found:</strong> ${escapeHtml(b.whereFound || "Not specified")}</p>
          <p><strong>Description:</strong> ${escapeHtml(b.description)}</p>
          ${criterion ? `<p><strong>How to fix:</strong> ${escapeHtml(criterion.howToImplement)}</p>
          <div class="code-block">${escapeHtml(criterion.codeExample)}</div>` : ""}
          <p><strong>Identified by:</strong> ${escapeHtml(b.confirmedBy || "Unknown")}</p>
        </div>
      </div>`;
    }).join("")}
  </section>` : ""}

  <!-- Confirmed Violations (Y) -->
  ${humanConfirmed.length > 0 ? `
  <section>
    <h2>✅ Automated violations confirmed by humans (Y = ${humanConfirmed.length})</h2>
    <p class="section-sub">These violations were detected by axe-core and subsequently confirmed as genuine barriers by human reviewers.</p>
    ${humanConfirmed.map((c) => `
      <div class="finding-card">
        <div class="finding-head">
          <div style="flex:1">
            <p class="finding-title">${escapeHtml(c.violationId)}</p>
            <span class="pill pill-confirmed">✓ Confirmed</span>
          </div>
        </div>
        ${c.note ? `<div class="finding-body"><div class="note-box">${escapeHtml(c.note)}</div></div>` : ""}
      </div>`).join("")}
  </section>` : ""}

  <!-- Disputed Violations -->
  ${humanDisputed.length > 0 ? `
  <section>
    <h2>⚠ Automated findings disputed by humans (${humanDisputed.length})</h2>
    <p class="section-sub">These axe-core findings were challenged by human reviewers as potential false positives or context-dependent non-issues. They require further investigation.</p>
    ${humanDisputed.map((d) => `
      <div class="finding-card">
        <div class="finding-head">
          <div style="flex:1">
            <p class="finding-title">${escapeHtml(d.violationId)}</p>
            <span class="pill pill-disputed">⚠ Disputed</span>
          </div>
        </div>
        ${d.reason ? `<div class="finding-body"><div class="note-box"><strong>Reason:</strong> ${escapeHtml(d.reason)}</div></div>` : ""}
      </div>`).join("")}
  </section>` : ""}

  <!-- Checklist Results -->
  ${checkedCriteria.length > 0 ? `
  <section>
    <h2>📋 WCAG checklist results</h2>
    <p class="section-sub">${failedCriteria.length} failures / ${passedCriteria.length} passes / ${checkedCriteria.length - failedCriteria.length - passedCriteria.length} partial or not tested out of ${checkedCriteria.length} criteria reviewed.</p>
    <table class="checklist-table">
      <thead><tr><th>Criterion</th><th>Status</th><th>Tested by</th><th>Notes</th></tr></thead>
      <tbody>
        ${checkedCriteria.sort((a, b) => {
          const order = { fail: 0, partial: 1, not_tested: 2, pass: 3 };
          return (order[a[1].status] || 2) - (order[b[1].status] || 2);
        }).map(([criterionId, response]) => {
          const criterion = WCAG_CRITERIA.find((c) => c.id === criterionId);
          const statusClass = `status-${response.status}`;
          const statusLabel = { pass: "✓ Pass", fail: "✗ Fail", partial: "~ Partial", not_tested: "— Not tested" }[response.status] || response.status;
          return `
          <tr>
            <td><strong>${escapeHtml(criterionId)}</strong>${criterion ? ` — ${escapeHtml(criterion.title)}` : ""}<br><code class="inline">Level ${criterion?.level || "?"}</code></td>
            <td class="${statusClass}">${statusLabel}</td>
            <td>${escapeHtml(response.testedBy || "—")}</td>
            <td>${escapeHtml(response.note || "—")}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  </section>` : ""}

  <footer>
    <p><strong>Methodology note:</strong> This report combines automated accessibility testing (Playwright + axe-core, Deque Systems) with structured human validation. Automated findings represent programmatically detectable violations. Human-added findings represent lived-experience barriers requiring manual assessment. The accuracy formula X/(Y+Z) measures what proportion of total real barriers automated tools detected, providing an empirical basis for the claim that automation alone is insufficient for comprehensive accessibility assessment.</p>
    <p style="margin-top:6px">Generated for: "Nothing About Us Without Us: Participatory Governance and AI as Tools for Digital Accessibility Reform in India and the UK" — UCL STEaPP MPA Individual Project. Session ID: ${session.id}.</p>
  </footer>

</div>
</body>
</html>`;
}

// ─── Start ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Accessibility Validation Platform backend running on port ${PORT}`);
  console.log(`Sessions stored in: ${SESSIONS_DIR}`);
});
