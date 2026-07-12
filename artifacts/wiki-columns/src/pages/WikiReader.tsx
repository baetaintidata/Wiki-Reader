import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, BookOpen, ArrowRight, X, Columns3, Clock, ExternalLink, ShoppingBag, Search, FlaskConical, ChevronDown, FileText, Type } from "lucide-react";

interface WikiArticle {
  title: string;
  html: string;
}

interface LinkPreview {
  title: string;
  extract: string;
  thumbnail?: string;
  pageUrl: string;
  x: number;
  y: number;
}

interface HistoryItem {
  title: string;
  url: string;
  visitedAt: number;
}

const HISTORY_KEY = "wiki-column-history";
const MAX_HISTORY = 10;

function loadHistory(): HistoryItem[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveToHistory(title: string, url: string) {
  const items = loadHistory().filter((h) => h.url !== url);
  const updated: HistoryItem[] = [
    { title, url, visitedAt: Date.now() },
    ...items,
  ].slice(0, MAX_HISTORY);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
}

function extractArticleName(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (!parsed.hostname.includes("wikipedia.org")) return null;
    const match = parsed.pathname.match(/\/wiki\/(.+)/);
    if (!match) return null;
    return decodeURIComponent(match[1]);
  } catch {
    const match = url.trim().match(/\/wiki\/([^/?#]+)/);
    if (match) return decodeURIComponent(match[1]);
    return null;
  }
}

function isUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

function getLangFromUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    const subdomain = parsed.hostname.split(".")[0];
    return subdomain || "en";
  } catch {
    return "en";
  }
}

function getLangFromHref(href: string): string {
  try {
    const parsed = new URL(href);
    return parsed.hostname.split(".")[0] || "en";
  } catch {
    return "en";
  }
}

function cleanWikiHtml(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;

  div.querySelectorAll(".mw-editsection").forEach((el) => el.remove());
  div.querySelectorAll("#toc, .toc").forEach((el) => el.remove());
  div.querySelectorAll(".navbox, .navbox-inner, .sistersitebox, .hatnote, .portal, .portalbox").forEach((el) => el.remove());
  div.querySelectorAll(".dmbox, .disambiguation").forEach((el) => el.remove());
  div.querySelectorAll(".mw-hidden-catlinks, #catlinks").forEach((el) => el.remove());
  div.querySelectorAll(".references-small").forEach((el) => el.remove());
  // Hide backlinks (↑ arrows) and edit section links inside references — keep the text
  div.querySelectorAll(".mw-cite-backlink").forEach((el) => el.remove());
  div.querySelectorAll("h2, h3").forEach((heading) => {
    const text = heading.textContent?.trim().toLowerCase() ?? "";
    // Only strip navigation/external sections; keep references, notes, bibliography
    if (["see also", "external links", "further reading"].includes(text)) {
      let next = heading.nextElementSibling;
      while (next && next.tagName !== "H2") {
        const toRemove = next;
        next = next.nextElementSibling;
        toRemove.remove();
      }
      heading.remove();
    }
  });
  div.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src");
    if (src && src.startsWith("//")) img.setAttribute("src", "https:" + src);
  });
  // Move `title` on footnote anchors to data-cite-short so browser tooltip doesn't compete
  div.querySelectorAll("sup.reference a[title]").forEach((el) => {
    const a = el as HTMLAnchorElement;
    a.setAttribute("data-cite-short", a.getAttribute("title") ?? "");
    a.removeAttribute("title");
  });
  div.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("/wiki/")) {
      a.setAttribute("href", `https://en.wikipedia.org${href}`);
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    } else if (href.startsWith("#")) {
      // Preserve cite_note anchors for footnote hover; blank everything else
      if (!href.startsWith("#cite_note-")) {
        a.setAttribute("href", "#");
      }
    }
  });

  // Wrap data tables (wikitable) in a column-spanning div so they don't
  // bleed across column boundaries in multi-column layout.
  div.querySelectorAll("table.wikitable").forEach((table) => {
    const wrapper = document.createElement("div");
    wrapper.className = "wiki-table-wrap";
    table.parentNode!.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  });

  return div.innerHTML;
}

const COLUMN_LABELS: Record<number, string> = { 1: "1", 2: "2", 3: "3", 4: "4", 5: "5" };

interface ArticleSection {
  heading: string | null;
  html: string;
}

function splitIntoSections(html: string): ArticleSection[] {
  const container = document.createElement("div");
  container.innerHTML = html;
  const root = container.querySelector(".mw-parser-output") ?? container;

  const sections: ArticleSection[] = [];
  let currentHeading: string | null = null;
  let currentNodes: Node[] = [];

  const flush = () => {
    const wrapper = document.createElement("div");
    currentNodes.forEach((n) => wrapper.appendChild(n.cloneNode(true)));
    const content = wrapper.innerHTML.trim();
    if (content) sections.push({ heading: currentHeading, html: content });
  };

  for (const child of Array.from(root.childNodes)) {
    const el = child as Element;
    const isSectionBreak =
      child.nodeType === Node.ELEMENT_NODE &&
      (el.tagName === "H2" || el.classList?.contains("mw-heading2"));

    if (isSectionBreak) {
      flush();
      const h2 = el.tagName === "H2" ? el : el.querySelector("h2");
      currentHeading = h2?.innerHTML ?? el.innerHTML;
      currentNodes = [];
    } else {
      currentNodes.push(child);
    }
  }
  flush();
  return sections;
}

// ── Citation parsing & APA / Turabian formatting ────────────────────────────

function apifyAuthors(raw: string): string {
  const parts = raw.split(/;\s+/);
  const fmt = parts.map((a) => {
    const m = a.match(/^([^,]+),\s+(.+)$/);
    if (!m) return a;
    const initials = m[2].split(/\s+/).map((g) => (g[0] ?? "").toUpperCase() + ".").join(" ");
    return `${m[1]}, ${initials}`;
  });
  if (fmt.length === 1) return fmt[0];
  if (fmt.length === 2) return `${fmt[0]}, & ${fmt[1]}`;
  const last = fmt.pop()!;
  return `${fmt.join("; ")}, & ${last}`;
}

interface ParsedCite {
  type: "article" | "book";
  authors: string; year: string; title: string; source: string;
  volume?: string; issue?: string; pages?: string; doi?: string; edition?: string;
}

function parseCite(text: string): ParsedCite | null {
  const t = text.replace(/\s+/g, " ").trim();
  const baseM = t.match(/^(.+?)\s+\((\d{4}[a-z]?)\)\.\s+(.+)$/s);
  if (!baseM) return null;
  const [, authorsRaw, year, rest] = baseM;
  const authors = authorsRaw.trim();
  const editionM = rest.match(/\((\d+(?:st|nd|rd|th)\s+ed\.?)\)/i);

  // Journal article: title in double-quotes
  const articleM = rest.match(/^"([^"]+)"\.\s+(.+)$/s);
  if (articleM) {
    const title = articleM[1];
    const remaining = articleM[2];
    const journalEnd = remaining.search(/\.\s+(?:[A-Z]?\d|doi:|ISBN|hdl:|JSTOR|PMID|Archived|Retrieved)/);
    const source = (journalEnd > 0 ? remaining.slice(0, journalEnd) : remaining.split(".")[0]).trim();
    const volM = remaining.match(/\b([A-Z]?\d+)\s*\((\d+[–\-]?\d*)\)\s*:\s*([\d,\s–\-]+)/);
    const doiM = remaining.match(/doi:([\S]+)/i);
    return { type: "article", authors, year, title, source,
      volume: volM?.[1], issue: volM?.[2], pages: volM?.[3]?.trim(), doi: doiM?.[1] };
  }

  // Book: plain title. Publisher. …
  const bookM = rest.match(/^(.+?)\.\s+(.+)$/s);
  if (bookM) {
    const rawTitle = bookM[1].replace(/\s*\([^)]+ed\.?\)/i, "").trim();
    const sourceRest = bookM[2];
    const publisherEnd = sourceRest.search(/\.\s+(?:p\.|pp\.|ISBN|doi:|Retrieved)/i);
    const source = (publisherEnd > 0 ? sourceRest.slice(0, publisherEnd) : sourceRest.split(".")[0]).trim();
    const pagesM = sourceRest.match(/\bpp?\.\s*([\d–\-]+)/);
    return { type: "book", authors, year, title: rawTitle, source,
      edition: editionM?.[1], pages: pagesM?.[1] };
  }

  return null;
}

function formatCite(text: string, style: CitationStyle): string {
  const p = parseCite(text);
  if (!p) return text;

  if (p.type === "article") {
    const { authors, year, title, source, volume, issue, pages, doi } = p;
    if (style === "APA") {
      const auth = apifyAuthors(authors);
      let loc = source;
      if (volume) loc += `, ${volume}`;
      if (issue) loc += `(${issue})`;
      if (pages) loc += `, ${pages}`;
      const doiStr = doi ? ` https://doi.org/${doi}` : "";
      return `${auth} (${year}). ${title}. ${loc}.${doiStr}`;
    } else {
      const vol = volume ?? "";
      const iss = issue ? `, no. ${issue}` : "";
      const pg = pages ? `: ${pages}` : "";
      return `${authors}. "${title}." ${source} ${vol}${iss} (${year})${pg}.`;
    }
  }

  if (p.type === "book") {
    const { authors, year, title, source, edition, pages } = p;
    const ed = edition ? ` (${edition})` : "";
    const pg = pages ? `, ${pages}` : "";
    if (style === "APA") {
      return `${apifyAuthors(authors)} (${year}). ${title}${ed}. ${source}${pg}.`;
    } else {
      return `${authors}. ${title}${ed}. ${source}, ${year}${pg}.`;
    }
  }

  return text;
}

// ── Inline citation replacement ──────────────────────────────────────────────
// Produces "(Author, Year)" / "(Author Year)" from a parsed reference

function buildInlineCite(rawText: string, style: CitationStyle): string {
  const parsed = parseCite(rawText);
  if (!parsed) {
    // Fallback: grab first word + year
    const yearM = rawText.match(/\b(1[89]\d\d|20\d\d)\b/);
    const firstWord = rawText.split(/[\s,]/)[0] ?? "";
    if (firstWord && yearM) {
      return style === "APA" ? `(${firstWord}, ${yearM[1]})` : `(${firstWord} ${yearM[1]})`;
    }
    return `(${rawText.slice(0, 30).trim()})`;
  }
  const lastName = parsed.authors.split(/;\s+/)[0].split(",")[0].trim();
  const { year, pages } = parsed;
  const pg = pages ? (style === "APA" ? `, p. ${pages}` : `, ${pages}`) : "";
  return style === "APA" ? `(${lastName}, ${year}${pg})` : `(${lastName} ${year}${pg})`;
}

// Transform sup.reference[n] → <span class="inline-cite">(Author, Year)</span>
function applyInlineCitations(html: string, style: CitationStyle): string {
  const div = document.createElement("div");
  div.innerHTML = html;

  // Build refId → full citation text map
  const refMap = new Map<string, string>();
  div.querySelectorAll("li[id^='cite_note-']").forEach((li) => {
    const id = li.getAttribute("id") ?? "";
    const text = li.querySelector(".reference-text")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (id && text) refMap.set(id, text);
  });

  if (refMap.size === 0) return html; // no references to expand

  div.querySelectorAll("sup.reference").forEach((sup) => {
    const a = sup.querySelector("a[href^='#cite_note-']") as HTMLAnchorElement | null;
    if (!a) return;
    const refId = (a.getAttribute("href") ?? "").slice(1);
    const rawText = refMap.get(refId) ?? "";
    const inlineText = rawText ? buildInlineCite(rawText, style) : (a.textContent?.trim() ?? "");

    const span = document.createElement("span");
    span.className = "inline-cite";
    span.setAttribute("data-ref-id", refId);
    // Store full formatted citation for hover popup
    span.setAttribute("data-cite-full", rawText ? formatCite(rawText, style) : rawText);
    span.setAttribute("data-cite-short", a.getAttribute("data-cite-short") ?? "");
    span.textContent = inlineText;
    sup.replaceWith(span);
  });

  return div.innerHTML;
}

// Replace with your real Amazon Associates tag once approved
const AMAZON_TAG = "wikireader-placeholder-20";

const GENERIC_SECTIONS = new Set([
  "overview", "introduction", "background", "history", "definition",
  "etymology", "summary", "general", "description", "contents",
]);

function buildAmazonUrl(articleTitle: string, sectionHeading: string | null): string {
  const cleanSection = sectionHeading
    ? new DOMParser().parseFromString(sectionHeading, "text/html").body.textContent?.trim() ?? ""
    : "";
  const cleanArticle = articleTitle.trim();
  const sectionLower = cleanSection.toLowerCase();
  const keywords = !cleanSection || GENERIC_SECTIONS.has(sectionLower)
    ? `${cleanArticle} books`
    : `${cleanSection} ${cleanArticle} books`;
  return `https://www.amazon.com/s?k=${encodeURIComponent(keywords)}&i=stripbooks&tag=${AMAZON_TAG}`;
}

// ── Research Papers ──────────────────────────────────────────────────────────

type CitationStyle = "APA" | "Turabian";

interface ArxivPaper {
  id: string;
  title: string;
  /** Raw CrossRef authors: [{given, family}] */
  rawAuthors: { given: string; family: string }[];
  authors: string[];
  year: string;
  journal: string;
  volume: string;
  issue: string;
  pages: string;
  pdfUrl: string;
  absUrl: string;
}

function buildResearchQuery(articleTitle: string, sectionHeading: string | null): string {
  const cleanSection = sectionHeading
    ? new DOMParser().parseFromString(sectionHeading, "text/html").body.textContent?.trim() ?? ""
    : "";
  const sectionLower = cleanSection.toLowerCase();
  return !cleanSection || GENERIC_SECTIONS.has(sectionLower)
    ? articleTitle
    : `${articleTitle} ${cleanSection}`;
}

function buildScholarUrl(query: string) {
  const q = encodeURIComponent(query);
  return {
    googleScholar: `https://scholar.google.com/scholar?q=${q}`,
    semanticScholar: `https://www.semanticscholar.org/search?q=${q}&sort=Relevance`,
    scopus: `https://www.scopus.com/results/results.uri?query=${q}&search_type=kws`,
    pubmed: `https://pubmed.ncbi.nlm.nih.gov/?term=${q}`,
  };
}

async function fetchCrossRefPapers(query: string): Promise<ArxivPaper[]> {
  const url =
    `https://api.crossref.org/works?query=${encodeURIComponent(query)}` +
    `&rows=4&filter=type:journal-article` +
    `&select=title,author,published,DOI,container-title,volume,issue,page`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CrossRef ${res.status}`);
  const json = await res.json();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (json.message?.items ?? []).map((item: any) => {
    const title: string = (item.title?.[0] ?? "").replace(/\s+/g, " ").trim();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawAuthors = (item.author ?? []).slice(0, 6).map((a: any) => ({
      given: (a.given ?? "").trim(),
      family: (a.family ?? "").trim(),
    })).filter((a: { given: string; family: string }) => a.family);
    const authors: string[] = rawAuthors
      .slice(0, 3)
      .map((a: { given: string; family: string }) => [a.given, a.family].filter(Boolean).join(" "));
    const year: string = String(item.published?.["date-parts"]?.[0]?.[0] ?? "");
    const journal: string = (item["container-title"]?.[0] ?? "").trim();
    const volume: string = (item.volume ?? "").trim();
    const issue: string = (item.issue ?? "").trim();
    const pages: string = (item.page ?? "").trim();
    const absUrl = item.DOI ? `https://doi.org/${item.DOI}` : "";
    return { id: item.DOI ?? title, title, rawAuthors, authors, year, journal, volume, issue, pages, pdfUrl: absUrl, absUrl };
  }).filter((p: ArxivPaper) => p.title && p.absUrl);
}

/** APA 7: Last, F. M., & Last, F. M. (Year). Title. Journal, volume(issue), pages. https://doi.org/... */
function formatAPA(p: ArxivPaper): string {
  const authorStr = (() => {
    const all = p.rawAuthors;
    if (!all.length) return "";
    const fmt = (a: { given: string; family: string }) => {
      const initials = a.given.split(/\s+/).map(n => n[0] ? n[0] + "." : "").join(" ");
      return `${a.family}, ${initials}`.trim();
    };
    if (all.length === 1) return fmt(all[0]);
    if (all.length <= 6) return all.slice(0, -1).map(fmt).join(", ") + ", & " + fmt(all[all.length - 1]);
    return all.slice(0, 6).map(fmt).join(", ") + ", . . . " + fmt(all[all.length - 1]);
  })();
  const parts: string[] = [];
  if (authorStr) parts.push(authorStr);
  if (p.year) parts.push(`(${p.year})`);
  if (p.title) parts.push(`${p.title}.`);
  if (p.journal) {
    let journalPart = `*${p.journal}*`;
    if (p.volume) journalPart += `, *${p.volume}*`;
    if (p.issue) journalPart += `(${p.issue})`;
    if (p.pages) journalPart += `, ${p.pages}`;
    parts.push(journalPart + ".");
  }
  parts.push(p.absUrl);
  return parts.join(" ");
}

/** Turabian Notes-Bibliography: Last, First, and First Last. "Title." Journal volume, no. issue (Year): pages. https://doi.org/... */
function formatTurabian(p: ArxivPaper): string {
  const authorStr = (() => {
    const all = p.rawAuthors;
    if (!all.length) return "";
    const fmtFirst = (a: { given: string; family: string }) => `${a.family}, ${a.given}`.trim();
    const fmtRest = (a: { given: string; family: string }) => `${a.given} ${a.family}`.trim();
    if (all.length === 1) return fmtFirst(all[0]);
    if (all.length <= 3) return [fmtFirst(all[0]), ...all.slice(1).map(fmtRest)].join(", and ");
    return fmtFirst(all[0]) + " et al.";
  })();
  const parts: string[] = [];
  if (authorStr) parts.push(authorStr + ".");
  if (p.title) parts.push(`"${p.title}."`);
  if (p.journal) {
    let journalPart = `*${p.journal}*`;
    if (p.volume) journalPart += ` ${p.volume}`;
    if (p.issue) journalPart += `, no. ${p.issue}`;
    if (p.year) journalPart += ` (${p.year})`;
    if (p.pages) journalPart += `: ${p.pages}`;
    parts.push(journalPart + ".");
  } else if (p.year) {
    parts.push(`${p.year}.`);
  }
  parts.push(p.absUrl);
  return parts.join(" ");
}

function SectionResearch({ articleTitle, sectionHeading, amazonUrl, amazonLabel, citationStyle, onStyleChange }: {
  articleTitle: string;
  sectionHeading: string | null;
  amazonUrl: string;
  amazonLabel: string;
  citationStyle: CitationStyle;
  onStyleChange: (s: CitationStyle) => void;
}) {
  const [open, setOpen] = useState(false);
  const [papers, setPapers] = useState<ArxivPaper[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const query = buildResearchQuery(articleTitle, sectionHeading);
  const links = buildScholarUrl(query);
  const sectionLabel = sectionHeading ?? articleTitle;

  const handleOpen = async () => {
    setOpen((v) => !v);
    if (papers !== null || fetching) return;
    setFetching(true);
    setFetchError(null);
    try {
      const results = await fetchCrossRefPapers(query);
      setPapers(results);
    } catch {
      setFetchError("Could not load papers. Use a search link below.");
      setPapers([]);
    } finally {
      setFetching(false);
    }
  };

  return (
    <div className="mt-3 text-xs">
      {/* Single row: Research Papers toggle + Books link */}
      <div className="flex items-center gap-2">
        <div className="flex-1 h-px bg-border/60" />
        <button
          type="button"
          onClick={handleOpen}
          className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition shrink-0"
        >
          <FlaskConical className="w-3 h-3 text-primary/70" />
          <span>Researches on &ldquo;{sectionLabel}&rdquo;</span>
          <ChevronDown className={`w-3 h-3 transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
        </button>
        <div className="w-px h-3 bg-border/60 shrink-0" />
        <a
          href={amazonUrl}
          target="_blank"
          rel="noopener noreferrer sponsored"
          className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition shrink-0"
        >
          <ShoppingBag className="w-3 h-3" />
          <span>{amazonLabel} →</span>
        </a>
        <div className="flex-1 h-px bg-border/60" />
      </div>

      {/* Expanded panel */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="panel"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className="mt-2 border border-border/50 rounded-md bg-card px-3 py-3 space-y-3">
              {/* Header */}
              <div className="flex items-center gap-1.5">
                <span className="font-semibold text-foreground/80 text-xs">Research Papers</span>
                <span className="text-muted-foreground/60 text-[10px]">via CrossRef · {citationStyle}</span>
              </div>

              {/* Paper results */}
              <div>
                {fetching && (
                  <div className="flex items-center gap-1.5 text-muted-foreground py-1">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    <span>Searching academic literature…</span>
                  </div>
                )}
                {fetchError && <p className="text-destructive/80 text-[11px]">{fetchError}</p>}
                {papers && papers.length === 0 && !fetchError && (
                  <p className="text-muted-foreground text-[11px]">No papers found for this topic. Try a database below.</p>
                )}
                {papers && papers.length > 0 && (
                  <ul className="space-y-2.5">
                    {papers.map((p) => {
                      const citation = citationStyle === "APA" ? formatAPA(p) : formatTurabian(p);
                      // Split citation at the DOI URL to make it a link
                      const doiIdx = citation.lastIndexOf("https://doi.org/");
                      const citationText = doiIdx > 0 ? citation.slice(0, doiIdx).trim() : citation;
                      const doiUrl = doiIdx > 0 ? citation.slice(doiIdx) : "";
                      // Render *italic* markers
                      const renderCitation = (text: string) =>
                        text.split(/(\*[^*]+\*)/).map((part, i) =>
                          part.startsWith("*") && part.endsWith("*")
                            ? <em key={i}>{part.slice(1, -1)}</em>
                            : part
                        );
                      return (
                        <li key={p.id} className="flex gap-2 items-start">
                          <FileText className="w-3 h-3 text-primary/60 mt-0.5 shrink-0" />
                          <p className="text-[11px] text-foreground/80 leading-relaxed">
                            {renderCitation(citationText)}{" "}
                            {doiUrl && (
                              <a href={p.absUrl} target="_blank" rel="noopener noreferrer"
                                className="text-primary/80 hover:text-primary break-all">
                                {doiUrl}
                              </a>
                            )}
                          </p>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {/* Database search links */}
              <div className="border-t border-border/40 pt-2">
                <p className="text-muted-foreground/70 mb-1.5 text-[11px]">Search in academic databases:</p>
                <div className="flex flex-wrap gap-2">
                  {[
                    { label: "Google Scholar", href: links.googleScholar },
                    { label: "Semantic Scholar", href: links.semanticScholar },
                    { label: "PubMed", href: links.pubmed },
                    { label: "Scopus", href: links.scopus },
                  ].map(({ label, href }) => (
                    <a
                      key={label}
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-border hover:border-primary/50 hover:text-primary text-muted-foreground transition"
                    >
                      <ExternalLink className="w-2.5 h-2.5" />
                      {label}
                    </a>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function WikiReader() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [article, setArticle] = useState<WikiArticle | null>(null);
  const [columns, setColumns] = useState(3);
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>(loadHistory);
  const [showHistory, setShowHistory] = useState(false);
  const [suggestions, setSuggestions] = useState<{ title: string; url: string }[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [citationStyle, setCitationStyle] = useState<CitationStyle>("APA");
  // Keep a ref so hover/click callbacks always see the current style without re-binding
  const citationStyleRef = useRef<CitationStyle>(citationStyle);
  citationStyleRef.current = citationStyle;

  // Reading-font selector
  type ReadingFont =
    | "Literata" | "Merriweather" | "Source Serif 4" | "Charter" | "Inter"
    | "Open Sans" | "Lexend" | "Georgia" | "Roboto" | "Atkinson Hyperlegible"
    | "Helvetica" | "San Francisco" | "Linux Libertine" | "Times"
    | "Montserrat" | "Baskerville" | "Garamond";

  const [readingFont, setReadingFont] = useState<ReadingFont>(() => {
    const isAndroid = typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
    const defaultFont = isAndroid ? "Roboto" : "Literata";
    try { return (localStorage.getItem("wiki-reader-font") as ReadingFont) ?? defaultFont; } catch { return defaultFont; }
  });
  useEffect(() => {
    try { localStorage.setItem("wiki-reader-font", readingFont); } catch {}
    document.body.setAttribute("data-reading-font", readingFont);
  }, [readingFont]);

  // Pre-process article HTML: replace [n] with (Author, Year) spans; re-runs when style changes
  const processedSections = useMemo(() => {
    if (!article) return [];
    const html = applyInlineCitations(article.html, citationStyle);
    return splitIntoSections(html);
  }, [article, citationStyle]);

  const inputRef = useRef<HTMLInputElement>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewCacheRef = useRef<Map<string, LinkPreview | null>>(new Map());
  const activeHrefRef = useRef<string | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchSuggestions = useCallback(async (query: string) => {
    if (!query.trim() || isUrl(query)) { setSuggestions([]); setShowSuggestions(false); return; }
    try {
      const res = await fetch(
        `https://en.wikipedia.org/w/api.php?action=opensearch&format=json&origin=*&search=${encodeURIComponent(query)}&limit=6&namespace=0`
      );
      const [, titles, , urls] = await res.json() as [string, string[], string[], string[]];
      const items = titles.map((t, i) => ({ title: t, url: urls[i] }));
      setSuggestions(items);
      setShowSuggestions(items.length > 0);
    } catch {
      setSuggestions([]);
    }
  }, []);

  const handleInputChange = useCallback((value: string) => {
    setUrl(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!isUrl(value) && value.trim().length > 1) {
      setShowHistory(false);
      searchTimerRef.current = setTimeout(() => fetchSuggestions(value), 250);
    } else {
      setSuggestions([]);
      setShowSuggestions(false);
      if (!value.trim()) setShowHistory(history.length > 0);
    }
  }, [fetchSuggestions, history.length]);

  const fetchArticle = useCallback(async (inputUrl: string) => {
    const name = extractArticleName(inputUrl);
    if (!name) {
      setError("Please enter a valid Wikipedia URL (e.g. https://en.wikipedia.org/wiki/Example)");
      return;
    }
    const lang = getLangFromUrl(inputUrl);
    setLoading(true);
    setError(null);
    setArticle(null);
    setShowHistory(false);
    setShowSuggestions(false);

    try {
      const apiUrl = `https://${lang}.wikipedia.org/w/api.php?action=parse&format=json&origin=*&page=${encodeURIComponent(name)}&prop=text|displaytitle&disablelimitreport=1&disableeditsection=1`;
      const res = await fetch(apiUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();

      if (json.error) {
        if (json.error.code === "missingtitle") {
          throw new Error(`Article "${name.replace(/_/g, " ")}" not found on Wikipedia.`);
        }
        throw new Error(json.error.info ?? "Wikipedia returned an error.");
      }

      const rawHtml = json.parse?.text?.["*"] ?? "";
      const displayTitle = json.parse?.displaytitle ?? name.replace(/_/g, " ");
      const cleanHtml = cleanWikiHtml(rawHtml);
      setArticle({ title: displayTitle, html: cleanHtml });

      const cleanTitle = new DOMParser().parseFromString(displayTitle, "text/html").body.textContent ?? displayTitle;
      saveToHistory(cleanTitle, inputUrl);
      setHistory(loadHistory());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch article.");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    setShowSuggestions(false);
    setShowHistory(false);

    if (isUrl(trimmed)) {
      fetchArticle(trimmed);
    } else {
      // Search phrase — fetch first opensearch result
      setLoading(true);
      setError(null);
      setArticle(null);
      try {
        const res = await fetch(
          `https://en.wikipedia.org/w/api.php?action=opensearch&format=json&origin=*&search=${encodeURIComponent(trimmed)}&limit=1&namespace=0`
        );
        const [, titles, , urls] = await res.json() as [string, string[], string[], string[]];
        if (!titles.length) throw new Error(`No Wikipedia article found for "${trimmed}".`);
        setLoading(false);
        fetchArticle(urls[0]);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Search failed.");
        setLoading(false);
      }
    }
  }, [url, fetchArticle]);

  const handleClear = () => {
    setArticle(null);
    setError(null);
    setUrl("");
    setSuggestions([]);
    setShowSuggestions(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  // Link hover preview logic via event delegation
  const handleMouseOver = useCallback(async (e: React.MouseEvent) => {
    // ── Inline-cite span hover ───────────────────────────────────────────────
    const inlineEl = (e.target as HTMLElement).closest("span.inline-cite") as HTMLElement | null;
    if (inlineEl) {
      const refId = inlineEl.getAttribute("data-ref-id") ?? "";
      const href = `#${refId}`;
      if (activeHrefRef.current === href) return;
      activeHrefRef.current = href;
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);

      const rect = inlineEl.getBoundingClientRect();
      const popupHeight = 220;
      const x = rect.left;
      const spaceBelow = window.innerHeight - rect.bottom;
      const y = spaceBelow >= popupHeight + 8 ? rect.bottom + 6 : rect.top - popupHeight - 6;

      const fullCite = inlineEl.getAttribute("data-cite-full") ?? "";
      const shortCite = inlineEl.getAttribute("data-cite-short") ?? inlineEl.textContent?.trim() ?? "";
      if (fullCite) setPreview({ title: shortCite || refId, extract: fullCite, pageUrl: href, x, y });
      return;
    }

    const target = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
    if (!target) return;

    const href = target.getAttribute("href") ?? "";

    // ── Citation footnote hover (anchor fallback in References list) ─────────
    if (href.startsWith("#cite_note-")) {
      if (activeHrefRef.current === href) return;
      activeHrefRef.current = href;
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);

      const rect = target.getBoundingClientRect();
      const popupHeight = 220;
      const x = rect.left;
      const spaceBelow = window.innerHeight - rect.bottom;
      const y = spaceBelow >= popupHeight + 8 ? rect.bottom + 6 : rect.top - popupHeight - 6;

      const refId = href.slice(1);
      const refEl = document.getElementById(refId);
      const rawText = refEl?.querySelector(".reference-text")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
      const shortCite = target.getAttribute("data-cite-short") ?? target.textContent?.trim() ?? "";

      if (rawText) {
        const style = citationStyleRef.current;
        const formatted = formatCite(rawText, style);
        // title carries the short ref + style badge (encoded in pageUrl for detection)
        setPreview({ title: shortCite || refId, extract: formatted, pageUrl: href, x, y });
      }
      return;
    }

    if (!href.includes("wikipedia.org/wiki/")) return;

    // Don't re-fetch if same link
    if (activeHrefRef.current === href) return;
    activeHrefRef.current = href;

    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);

    const rect = target.getBoundingClientRect();
    // Fixed positioning is viewport-relative — no scroll offset needed
    const popupHeight = 160;
    const x = rect.left;
    const spaceBelow = window.innerHeight - rect.bottom;
    const y = spaceBelow >= popupHeight + 8
      ? rect.bottom + 6          // show below link
      : rect.top - popupHeight - 6; // flip above link when near bottom

    // Check cache
    if (previewCacheRef.current.has(href)) {
      const cached = previewCacheRef.current.get(href);
      if (cached) setPreview({ ...cached, x, y });
      return;
    }

    previewTimerRef.current = setTimeout(async () => {
      try {
        const lang = getLangFromHref(href);
        const titleMatch = href.match(/\/wiki\/([^#?]+)/);
        if (!titleMatch) return;
        const title = titleMatch[1];

        const res = await fetch(
          `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
        );
        if (!res.ok) { previewCacheRef.current.set(href, null); return; }
        const data = await res.json();

        const item: LinkPreview = {
          title: data.title ?? title.replace(/_/g, " "),
          extract: data.extract ?? "",
          thumbnail: data.thumbnail?.source,
          pageUrl: href,
          x,
          y,
        };
        previewCacheRef.current.set(href, item);

        // Only show if still hovering the same link
        if (activeHrefRef.current === href) setPreview(item);
      } catch {
        previewCacheRef.current.set(href, null);
      }
    }, 300);
  }, []);

  const handleMouseOut = useCallback((e: React.MouseEvent) => {
    const related = e.relatedTarget as HTMLElement | null;
    if (related?.closest?.(".link-preview-popup")) return;
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    activeHrefRef.current = null;
    setPreview(null);
  }, []);

  // Click on inline cite or [n] anchor → smooth-scroll to reference entry + highlight
  const handleArticleClick = useCallback((e: React.MouseEvent) => {
    // Inline-cite span click
    const inlineEl = (e.target as HTMLElement).closest("span.inline-cite") as HTMLElement | null;
    if (inlineEl) {
      e.preventDefault();
      setPreview(null);
      activeHrefRef.current = null;
      const refId = inlineEl.getAttribute("data-ref-id") ?? "";
      const refEl = refId ? document.getElementById(refId) : null;
      if (!refEl) return;
      refEl.scrollIntoView({ behavior: "smooth", block: "center" });
      refEl.classList.add("cite-target-highlight");
      setTimeout(() => refEl.classList.remove("cite-target-highlight"), 2000);
      return;
    }
    // Fallback: plain anchor cite link
    const target = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
    if (!target) return;
    const href = target.getAttribute("href") ?? "";
    if (!href.startsWith("#cite_note-")) return;
    e.preventDefault();
    setPreview(null);
    activeHrefRef.current = null;
    const refEl = document.getElementById(href.slice(1));
    if (!refEl) return;
    refEl.scrollIntoView({ behavior: "smooth", block: "center" });
    refEl.classList.add("cite-target-highlight");
    setTimeout(() => refEl.classList.remove("cite-target-highlight"), 2000);
  }, []);

  // Close history dropdown on outside click
  useEffect(() => {
    if (!showHistory) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".history-dropdown")) {
        setShowHistory(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showHistory]);

  return (
    <div className="min-h-screen bg-background">
      {/* Header bar */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="max-w-screen-2xl mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 shrink-0">
            <Columns3 className="w-5 h-5 text-primary" />
            <span className="font-semibold text-sm tracking-tight hidden sm:block text-foreground">
              Wiki Column Reader
            </span>
          </div>

          <form onSubmit={handleSubmit} className="flex-1 flex items-center gap-2 min-w-0">
            <div className="relative flex-1 min-w-0">
              <input
                ref={inputRef}
                type="text"
                value={url}
                onChange={(e) => handleInputChange(e.target.value)}
                onFocus={() => { if (!url.trim() && history.length > 0) setShowHistory(true); }}
                onKeyDown={(e) => { if (e.key === "Escape") { setShowSuggestions(false); setShowHistory(false); } }}
                placeholder="Paste a Wikipedia URL or search by topic…"
                className="w-full h-9 pl-3 pr-8 rounded-md border border-input bg-card text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition"
                autoFocus
                autoComplete="off"
              />
              {url && (
                <button
                  type="button"
                  onClick={() => handleInputChange("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition"
                  tabIndex={-1}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}

              {/* Unified dropdown: search suggestions OR history */}
              <AnimatePresence>
                {(showSuggestions || showHistory) && (
                  <motion.div
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.12 }}
                    className="history-dropdown absolute left-0 right-0 top-full mt-1 z-50 bg-card border border-border rounded-md shadow-md overflow-hidden"
                  >
                    {showSuggestions ? (
                      <>
                        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border">
                          <Search className="w-3 h-3 text-muted-foreground" />
                          <span className="text-xs text-muted-foreground font-medium">Wikipedia articles</span>
                        </div>
                        {suggestions.map((s) => (
                          <button
                            key={s.url}
                            type="button"
                            onMouseDown={(e) => { e.preventDefault(); setUrl(s.title); setShowSuggestions(false); fetchArticle(s.url); }}
                            className="w-full text-left px-3 py-2 text-sm text-foreground hover:bg-muted transition flex items-center gap-2"
                          >
                            <Search className="w-3 h-3 text-muted-foreground shrink-0" />
                            <span className="flex-1 truncate">{s.title}</span>
                          </button>
                        ))}
                      </>
                    ) : (
                      <>
                        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border">
                          <Clock className="w-3 h-3 text-muted-foreground" />
                          <span className="text-xs text-muted-foreground font-medium">Recent articles</span>
                        </div>
                        {history.map((item) => (
                          <button
                            key={item.url}
                            type="button"
                            onMouseDown={(e) => { e.preventDefault(); setUrl(item.title); setShowHistory(false); fetchArticle(item.url); }}
                            className="w-full text-left px-3 py-2 text-sm text-foreground hover:bg-muted transition flex items-center gap-2"
                          >
                            <Clock className="w-3 h-3 text-muted-foreground shrink-0" />
                            <span className="flex-1 truncate">{item.title}</span>
                            <span className="text-xs text-muted-foreground shrink-0">{new Date(item.visitedAt).toLocaleDateString()}</span>
                          </button>
                        ))}
                      </>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <button
              type="submit"
              disabled={loading || !url.trim()}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium flex items-center gap-1.5 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition shrink-0"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : isUrl(url) ? (
                <><span>Load</span><ArrowRight className="w-3.5 h-3.5" /></>
              ) : (
                <><Search className="w-3.5 h-3.5" /><span>Search</span></>
              )}
            </button>
            {article && (
              <button
                type="button"
                onClick={handleClear}
                className="h-9 px-3 rounded-md border border-border text-sm text-muted-foreground hover:text-foreground hover:border-foreground/30 transition shrink-0"
              >
                Clear
              </button>
            )}
          </form>

          {/* Column slider */}
          <div className="flex items-center gap-2 shrink-0 border-l border-border pl-3 ml-1">
            <span className="text-xs text-muted-foreground hidden sm:block whitespace-nowrap">Columns</span>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-mono w-3 text-center text-foreground">{COLUMN_LABELS[columns]}</span>
              <input
                type="range"
                min={1}
                max={5}
                step={1}
                value={columns}
                onChange={(e) => setColumns(Number(e.target.value))}
                className="w-20 h-1.5 accent-primary cursor-pointer"
                aria-label="Number of columns"
              />
            </div>
          </div>

          {/* Font selector for best reading */}
          <div className="flex items-center gap-2 shrink-0 border-l border-border pl-3 ml-1">
            <Type className="w-4 h-4 text-muted-foreground hidden sm:block" />
            <select
              value={readingFont}
              onChange={(e) => setReadingFont(e.target.value as ReadingFont)}
              className="text-xs bg-card border border-border rounded px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer"
              aria-label="Reading font"
              title="Choose a font optimized for long-form reading"
            >
              <optgroup label="Best for screen reading">
                <option value="Literata">Literata</option>
                <option value="Lexend">Lexend</option>
                <option value="Atkinson Hyperlegible">Atkinson Hyperlegible</option>
                <option value="Roboto">Roboto</option>
                <option value="Inter">Inter</option>
              </optgroup>
              <optgroup label="Classic serifs">
                <option value="Merriweather">Merriweather</option>
                <option value="Source Serif 4">Source Serif 4</option>
                <option value="Charter">Charter</option>
                <option value="Georgia">Georgia</option>
                <option value="Linux Libertine">Linux Libertine</option>
                <option value="Times">Times</option>
                <option value="Baskerville">Baskerville</option>
                <option value="Garamond">Garamond</option>
              </optgroup>
              <optgroup label="Sans-serif">
                <option value="Open Sans">Open Sans</option>
                <option value="Montserrat">Montserrat</option>
                <option value="Helvetica">Helvetica</option>
                <option value="San Francisco">San Francisco</option>
              </optgroup>
            </select>
          </div>

          {/* Citation style toggle */}
          <div className="flex items-center gap-2 shrink-0 border-l border-border pl-3 ml-1">
            <span className="text-xs text-muted-foreground hidden sm:block whitespace-nowrap">Citation</span>
            <div className="flex items-center rounded border border-border overflow-hidden text-xs font-medium">
              {(["APA", "Turabian"] as CitationStyle[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setCitationStyle(s)}
                  className={`px-2.5 py-1 transition ${citationStyle === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-screen-2xl mx-auto px-4 pb-16">
        <AnimatePresence mode="wait">
          {/* Error */}
          {error && !loading && (
            <motion.div key="error" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-8 max-w-lg mx-auto text-center">
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-5 text-sm text-destructive">{error}</div>
            </motion.div>
          )}

          {/* Loading skeleton */}
          {loading && (
            <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mt-8">
              <div className="h-8 w-64 bg-muted rounded animate-pulse mb-6" />
              <div className={`wiki-content cols-${columns}`} style={{ columnCount: columns, columnGap: "2rem", columnRule: "1px solid hsl(var(--border))" }}>
                {Array.from({ length: 18 }).map((_, i) => (
                  <div key={i} className="h-4 bg-muted rounded animate-pulse mb-3" style={{ width: `${65 + Math.random() * 35}%` }} />
                ))}
              </div>
            </motion.div>
          )}

          {/* Article */}
          {article && !loading && (
            <motion.article
              key={article.title}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="mt-6"
              onMouseOver={handleMouseOver}
              onMouseOut={handleMouseOut}
              onClick={handleArticleClick}
            >
              <h1
                className="text-3xl font-bold text-foreground mb-1 font-sans"
                dangerouslySetInnerHTML={{ __html: article.title }}
              />
              <div className="h-px bg-border mb-5" />

              {(() => {
                const plainTitle = new DOMParser()
                  .parseFromString(article.title, "text/html")
                  .body.textContent ?? article.title;
                return processedSections.map((section, i) => {
                  const amazonUrl = buildAmazonUrl(plainTitle, section.heading);
                  const plainSection = section.heading
                    ? new DOMParser().parseFromString(section.heading, "text/html").body.textContent ?? ""
                    : null;
                  const label = plainSection
                    ? `Books on "${plainSection}"`
                    : `Books on "${plainTitle}"`;

                  return (
                    <div key={i} className="mb-10">
                      {section.heading && (
                        <h2
                          className="text-lg font-semibold font-sans text-foreground border-b border-border pb-1 mb-3"
                          dangerouslySetInnerHTML={{ __html: section.heading }}
                        />
                      )}
                      <div
                        className={`wiki-content cols-${columns}`}
                        style={{ columnCount: columns, columnGap: "2rem", columnRule: "1px solid hsl(var(--border))" }}
                        dangerouslySetInnerHTML={{ __html: section.html }}
                      />

                      {/* Research papers + Books — combined row */}
                      <SectionResearch
                        articleTitle={plainTitle}
                        sectionHeading={plainSection}
                        amazonUrl={amazonUrl}
                        amazonLabel={label}
                        citationStyle={citationStyle}
                        onStyleChange={setCitationStyle}
                      />
                    </div>
                  );
                });
              })()}
              {/* FTC affiliate disclosure */}
              <p className="text-xs text-muted-foreground/60 mt-4 pb-2 text-center">
                As an Amazon Associate I earn from qualifying purchases.
              </p>
            </motion.article>
          )}

          {/* Empty state */}
          {!article && !loading && !error && (
            <motion.div key="empty" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-24 text-center">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-accent mb-5">
                <BookOpen className="w-8 h-8 text-accent-foreground" />
              </div>
              <h2 className="text-xl font-semibold text-foreground mb-2">Paste a Wikipedia URL to get started</h2>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                Enter any Wikipedia article URL above to read it in a comfortable multi-column newspaper layout.
              </p>

              {history.length > 0 && (
                <div className="mt-8">
                  <p className="text-xs text-muted-foreground mb-3 flex items-center justify-center gap-1.5">
                    <Clock className="w-3 h-3" /> Recently read
                  </p>
                  <div className="flex flex-wrap justify-center gap-2 max-w-lg mx-auto">
                    {history.slice(0, 6).map((item) => (
                      <button
                        key={item.url}
                        onClick={() => { setUrl(item.url); fetchArticle(item.url); }}
                        className="text-xs px-3 py-1.5 rounded-full border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition"
                      >
                        {item.title}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-6">
                <p className="text-xs text-muted-foreground mb-3">Try an example</p>
                <div className="flex flex-wrap justify-center gap-2">
                  {["https://en.wikipedia.org/wiki/Coffee", "https://en.wikipedia.org/wiki/Jazz", "https://en.wikipedia.org/wiki/Photosynthesis"].map((example) => (
                    <button
                      key={example}
                      onClick={() => { setUrl(example); fetchArticle(example); }}
                      className="text-xs px-3 py-1.5 rounded-full border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition"
                    >
                      {example.split("/wiki/")[1].replace(/_/g, " ")}
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Link hover preview popup */}
      <AnimatePresence>
        {preview && (
          <motion.div
            key={preview.pageUrl}
            initial={{ opacity: 0, y: 4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.97 }}
            transition={{ duration: 0.12 }}
            className="link-preview-popup fixed z-50 w-80 bg-card border border-border rounded-lg shadow-lg overflow-hidden pointer-events-none"
            style={{
              left: Math.min(Math.max(preview.x, 8), window.innerWidth - 340),
              top: preview.y,
            }}
            onMouseLeave={() => setPreview(null)}
          >
            <div className="flex gap-3 p-3">
              {preview.thumbnail && (
                <img
                  src={preview.thumbnail}
                  alt=""
                  className="w-16 h-16 object-cover rounded shrink-0"
                />
              )}
              <div className="min-w-0">
                {preview.pageUrl.startsWith("#cite_note-") ? (
                  <>
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-sm font-semibold text-foreground leading-tight truncate">{preview.title}</p>
                      <span className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 uppercase tracking-wide">{citationStyle}</span>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed line-clamp-6">{preview.extract}</p>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-semibold text-foreground leading-tight mb-1 truncate">{preview.title}</p>
                    <p className="text-xs text-muted-foreground leading-relaxed line-clamp-4">{preview.extract}</p>
                  </>
                )}
              </div>
            </div>
            <div className="border-t border-border px-3 py-1.5 flex items-center gap-1 text-xs text-primary">
              <ExternalLink className="w-3 h-3" />
              <span>{preview.pageUrl.startsWith("#cite_note-") ? "Click footnote to jump to References" : "Click to open on Wikipedia"}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
