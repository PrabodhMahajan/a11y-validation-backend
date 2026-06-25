/**
 * Live accessibility crawler — same engine as the local sandbox
 * but wrapped as an async function the Express server can call.
 *
 * Uses Playwright (real headless Chromium) + axe-core (Deque Systems).
 * Results are identical in structure to the local SITE_*.json reports.
 */

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const axeSource = fs.readFileSync(
  path.join(__dirname, "node_modules/axe-core/axe.min.js"),
  "utf8"
);

const WCAG_TAGS = {
  wcag2a: "WCAG 2.0 Level A",
  wcag2aa: "WCAG 2.0 Level AA",
  wcag21a: "WCAG 2.1 Level A",
  wcag21aa: "WCAG 2.1 Level AA",
  wcag22aa: "WCAG 2.2 Level AA",
  "best-practice": "Best Practice",
};

// RPWD disability mapping per axe-core rule
const DISABILITY_MAP = {
  "color-contrast": ["Low vision", "Colour blindness"],
  "image-alt": ["Blindness", "Low vision", "Deaf-blindness"],
  "link-name": ["Blindness", "Low vision"],
  "label": ["Blindness", "Low vision", "Cerebral palsy / motor"],
  "button-name": ["Blindness", "Low vision"],
  "html-has-lang": ["Blindness", "Low vision", "Speech and language disability"],
  "document-title": ["Blindness", "Low vision", "Cognitive / learning disabilities"],
  "heading-order": ["Blindness", "Low vision", "Cognitive / learning disabilities"],
  "landmark-one-main": ["Blindness", "Low vision", "Cerebral palsy / motor"],
  "region": ["Blindness", "Low vision"],
  "duplicate-id": ["Blindness", "Low vision"],
  "tabindex": ["Cerebral palsy / motor", "Muscular dystrophy", "Blindness"],
  "aria-required-attr": ["Blindness", "Low vision"],
  "aria-hidden-focus": ["Blindness", "Low vision", "Cerebral palsy / motor"],
  "aria-allowed-role": ["Blindness", "Deaf-blindness"],
  "aria-required-children": ["Blindness", "Low vision"],
  "aria-required-parent": ["Blindness", "Low vision"],
  "presentation-role-conflict": ["Blindness", "Low vision"],
  "landmark-unique": ["Blindness", "Low vision"],
  "list": ["Blindness", "Low vision"],
  "target-size": ["Cerebral palsy / motor", "Muscular dystrophy"],
  "frame-title": ["Blindness", "Low vision"],
  "select-name": ["Blindness", "Low vision", "Cerebral palsy / motor"],
  "video-caption": ["Deafness", "Hard of hearing"],
};

const HEURISTIC_KEYWORDS = [
  { pattern: /apply|application/i, weight: 10 },
  { pattern: /form/i, weight: 9 },
  { pattern: /complain|grievance|feedback/i, weight: 10 },
  { pattern: /register|registration/i, weight: 8 },
  { pattern: /login|signin/i, weight: 7 },
  { pattern: /download|document|circular/i, weight: 7 },
  { pattern: /scheme|benefit|service/i, weight: 8 },
  { pattern: /certificate|udid/i, weight: 9 },
  { pattern: /contact/i, weight: 6 },
  { pattern: /about/i, weight: 4 },
  { pattern: /faq|help/i, weight: 5 },
  { pattern: /accessibility|sitemap/i, weight: 6 },
];

function impactToSeverity(impact) {
  return { critical: "Critical", serious: "Serious", moderate: "Moderate", minor: "Minor" }[impact] || "Unknown";
}

function safeName(url) {
  return url.replace(/^https?:\/\//, "").replace(/[^a-z0-9]/gi, "_").slice(0, 60);
}

function isSameOrigin(base, candidate) {
  try {
    return new URL(candidate, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

function scoreUrl(url, linkText = "") {
  let score = 0;
  const combined = `${url} ${linkText}`;
  for (const { pattern, weight } of HEURISTIC_KEYWORDS) {
    if (pattern.test(combined)) score += weight;
  }
  let isNonLatinSlug = false;
  try { isNonLatinSlug = /[^\x00-\x7F]/.test(decodeURIComponent(url)); } catch { }
  return { score, isNonLatinSlug };
}

async function auditPage(url, browser, onProgress) {
  onProgress?.(`Auditing: ${url}`);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
  });
  const page = await context.newPage();
  let loadError = null;

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  } catch (err) {
    loadError = err.message;
  }

  await page.evaluate(axeSource);

  const axeResults = await page.evaluate(async () => {
    return await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
      resultTypes: ["violations", "incomplete", "passes"],
    });
  });

  // Discover internal links
  const rawLinks = await page.$$eval("a[href]", (els) =>
    els.map((e) => ({ href: e.href, text: (e.textContent || "").trim().slice(0, 100) }))
  ).catch(() => []);

  const title = await page.title().catch(() => "Unknown");
  const lang = await page.getAttribute("html", "lang").catch(() => null);
  await context.close();

  const violations = axeResults.violations.map((v) => ({
    ruleId: v.id,
    description: v.description,
    help: v.help,
    helpUrl: v.helpUrl,
    impact: v.impact,
    severity: impactToSeverity(v.impact),
    wcagTags: v.tags.filter((t) => WCAG_TAGS[t]).map((t) => WCAG_TAGS[t]),
    disabilitiesAffected: DISABILITY_MAP[v.id] || [],
    nodeCount: v.nodes.length,
    nodes: v.nodes.slice(0, 5).map((n) => ({
      target: n.target.join(" "),
      html: n.html.slice(0, 300),
      failureSummary: n.failureSummary,
    })),
  }));

  const totalViolationInstances = violations.reduce((s, v) => s + v.nodeCount, 0);
  const totalChecks = axeResults.violations.length + axeResults.passes.length + axeResults.incomplete.length;
  const passRate = totalChecks > 0 ? Math.round((axeResults.passes.length / totalChecks) * 100) : null;

  // Clean internal links
  const seen = new Set();
  const links = [];
  for (const { href, text } of rawLinks) {
    try {
      const norm = new URL(href).toString().split("#")[0];
      if (!isSameOrigin(url, norm)) continue;
      if (/\.(pdf|jpg|jpeg|png|gif|zip|doc|docx|mp4|mp3)$/i.test(norm)) continue;
      if (seen.has(norm)) continue;
      seen.add(norm);
      links.push({ url: norm, text });
    } catch { }
  }

  return {
    url,
    pageTitle: title,
    htmlLangAttribute: lang,
    loadError,
    engine: "axe-core",
    engineVersion: axeResults.testEngine.version,
    summary: {
      rulesViolated: violations.length,
      totalViolationInstances,
      rulesPassed: axeResults.passes.length,
      rulesIncomplete: axeResults.incomplete.length,
      automatedPassRate: passRate,
    },
    violations,
    incompleteChecks: axeResults.incomplete.map((i) => ({
      ruleId: i.id,
      description: i.description,
      help: i.help,
      nodeCount: i.nodes.length,
    })),
    discoveredLinks: links,
  };
}

/**
 * Main crawl function.
 * @param {string} startUrl - Homepage URL to crawl
 * @param {object} opts - { maxPages (default 8), onProgress (callback) }
 * @returns {object} - Site-wide audit result in SITE_*.json format
 */
export async function crawlSite(startUrl, { maxPages = 8, onProgress } = {}) {
  onProgress?.(`Starting crawl: ${startUrl}`);
  const browser = await chromium.launch({ headless: true });

  try {
    // Audit homepage
    const homeResult = await auditPage(startUrl, browser, onProgress);
    const pageResults = [{ ...homeResult, selectionReason: { matchedCategories: ["Homepage"] } }];

    onProgress?.(`Homepage done: ${homeResult.summary.rulesViolated} rules violated, ${homeResult.discoveredLinks.length} links found`);

    // Score and select pages
    const scored = homeResult.discoveredLinks
      .filter((l) => l.url !== startUrl)
      .map((l) => ({ ...l, ...scoreUrl(l.url, l.text) }))
      .sort((a, b) => b.score - a.score);

    const selected = scored.slice(0, maxPages - 1);

    onProgress?.(`Selected ${selected.length} additional pages via heuristic sampling`);

    // Audit selected pages
    for (const link of selected) {
      const result = await auditPage(link.url, browser, onProgress);
      pageResults.push({
        ...result,
        selectionReason: {
          heuristicScore: link.score,
          nonLatinUrl: link.isNonLatinSlug,
        },
      });
      await new Promise((r) => setTimeout(r, 800)); // polite delay
    }

    await browser.close();

    // Aggregate results
    const allViolations = pageResults.flatMap((p) =>
      (p.violations || []).map((v) => ({ ...v, pageUrl: p.url }))
    );

    const ruleAggregateMap = {};
    allViolations.forEach((v) => {
      if (!ruleAggregateMap[v.ruleId]) {
        ruleAggregateMap[v.ruleId] = {
          ruleId: v.ruleId,
          help: v.help,
          helpUrl: v.helpUrl,
          severity: v.severity,
          wcagTags: v.wcagTags,
          disabilitiesAffected: v.disabilitiesAffected,
          pagesAffected: new Set(),
          totalInstances: 0,
          exampleNodes: [],
        };
      }
      ruleAggregateMap[v.ruleId].pagesAffected.add(v.pageUrl);
      ruleAggregateMap[v.ruleId].totalInstances += v.nodeCount;
      if (ruleAggregateMap[v.ruleId].exampleNodes.length < 5) {
        (v.nodes || []).forEach((n) => {
          if (ruleAggregateMap[v.ruleId].exampleNodes.length < 5) {
            ruleAggregateMap[v.ruleId].exampleNodes.push({ pageUrl: v.pageUrl, target: n.target, html: n.html });
          }
        });
      }
    });

    const ruleAggregate = Object.values(ruleAggregateMap)
      .map((r) => ({ ...r, pagesAffected: Array.from(r.pagesAffected) }))
      .sort((a, b) => b.totalInstances - a.totalInstances);

    // Disability aggregate
    const disabilityMap = {};
    ruleAggregate.forEach((r) => {
      (r.disabilitiesAffected || []).forEach((d) => {
        if (!disabilityMap[d]) disabilityMap[d] = { disability: d, totalInstances: 0, rulesInvolved: 0 };
        disabilityMap[d].totalInstances += r.totalInstances;
        disabilityMap[d].rulesInvolved += 1;
      });
    });

    const totalInstances = pageResults.reduce((s, p) => s + (p.summary?.totalViolationInstances || 0), 0);

    return {
      siteUrl: startUrl,
      auditTimestamp: new Date().toISOString(),
      engine: "Playwright + axe-core (Deque Systems)",
      crawlStrategy: `purposive heuristic sampling: homepage + up to ${maxPages - 1} citizen-facing functional pages`,
      pagesAudited: pageResults.length,
      pagesWithErrors: pageResults.filter((p) => p.loadError).length,
      standardsCovered: ["WCAG 2.0 A/AA", "WCAG 2.1 A/AA", "WCAG 2.2 AA"],
      siteSummary: {
        totalRulesViolatedAcrossSite: ruleAggregate.length,
        totalViolationInstances: totalInstances,
        averageViolationsPerPage: Math.round((totalInstances / pageResults.length) * 10) / 10,
      },
      ruleAggregate,
      disabilityAggregate: Object.values(disabilityMap).sort((a, b) => b.totalInstances - a.totalInstances),
      pages: pageResults.map((p) => ({
        url: p.url,
        pageTitle: p.pageTitle,
        htmlLangAttribute: p.htmlLangAttribute,
        loadError: p.loadError,
        selectionReason: p.selectionReason,
        summary: p.summary,
        violations: p.violations,
        incompleteChecks: p.incompleteChecks,
      })),
    };
  } catch (err) {
    await browser.close();
    throw err;
  }
}
