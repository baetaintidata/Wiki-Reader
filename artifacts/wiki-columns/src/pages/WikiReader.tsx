import { useState, useRef, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, BookOpen, ArrowRight, X, Columns3, Clock, ExternalLink } from "lucide-react";

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
  div.querySelectorAll(".references").forEach((el) => el.remove());
  div.querySelectorAll("sup.reference, .reflist, .references-small").forEach((el) => el.remove());
  div.querySelectorAll("h2, h3").forEach((heading) => {
    const text = heading.textContent?.trim().toLowerCase() ?? "";
    if (["see also", "references", "notes", "external links", "further reading", "bibliography"].includes(text)) {
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
  div.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("/wiki/")) {
      a.setAttribute("href", `https://en.wikipedia.org${href}`);
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    } else if (href.startsWith("#")) {
      a.setAttribute("href", "#");
    }
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

export default function WikiReader() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [article, setArticle] = useState<WikiArticle | null>(null);
  const [columns, setColumns] = useState(3);
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>(loadHistory);
  const [showHistory, setShowHistory] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewCacheRef = useRef<Map<string, LinkPreview | null>>(new Map());
  const activeHrefRef = useRef<string | null>(null);

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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetchArticle(url);
  };

  const handleClear = () => {
    setArticle(null);
    setError(null);
    setUrl("");
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  // Link hover preview logic via event delegation
  const handleMouseOver = useCallback(async (e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
    if (!target) return;

    const href = target.getAttribute("href") ?? "";
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
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onFocus={() => history.length > 0 && setShowHistory(true)}
                placeholder="https://en.wikipedia.org/wiki/..."
                className="w-full h-9 pl-3 pr-8 rounded-md border border-input bg-card text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition"
                autoFocus
                autoComplete="off"
              />
              {url && (
                <button
                  type="button"
                  onClick={() => setUrl("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition"
                  tabIndex={-1}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}

              {/* History dropdown */}
              <AnimatePresence>
                {showHistory && history.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.12 }}
                    className="history-dropdown absolute left-0 right-0 top-full mt-1 z-50 bg-card border border-border rounded-md shadow-md overflow-hidden"
                  >
                    <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border">
                      <Clock className="w-3 h-3 text-muted-foreground" />
                      <span className="text-xs text-muted-foreground font-medium">Recent articles</span>
                    </div>
                    {history.map((item) => (
                      <button
                        key={item.url}
                        type="button"
                        onClick={() => {
                          setUrl(item.url);
                          setShowHistory(false);
                          fetchArticle(item.url);
                        }}
                        className="w-full text-left px-3 py-2 text-sm text-foreground hover:bg-muted transition flex items-center gap-2 group"
                      >
                        <span className="flex-1 truncate">{item.title}</span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {new Date(item.visitedAt).toLocaleDateString()}
                        </span>
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <button
              type="submit"
              disabled={loading || !url.trim()}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium flex items-center gap-1.5 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition shrink-0"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : (
                <><span>Load</span><ArrowRight className="w-3.5 h-3.5" /></>
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
              <div className="wiki-content" style={{ columnCount: columns, columnGap: "2rem", columnRule: "1px solid hsl(var(--border))" }}>
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
            >
              <h1
                className="text-3xl font-bold text-foreground mb-1 font-sans"
                dangerouslySetInnerHTML={{ __html: article.title }}
              />
              <div className="h-px bg-border mb-5" />

              {splitIntoSections(article.html).map((section, i) => (
                <div key={i} className="mb-8">
                  {section.heading && (
                    <h2
                      className="text-lg font-semibold font-sans text-foreground border-b border-border pb-1 mb-3"
                      dangerouslySetInnerHTML={{ __html: section.heading }}
                    />
                  )}
                  <div
                    className="wiki-content"
                    style={{ columnCount: columns, columnGap: "2rem", columnRule: "1px solid hsl(var(--border))" }}
                    dangerouslySetInnerHTML={{ __html: section.html }}
                  />
                </div>
              ))}
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
                <p className="text-sm font-semibold text-foreground leading-tight mb-1 truncate">{preview.title}</p>
                <p className="text-xs text-muted-foreground leading-relaxed line-clamp-4">{preview.extract}</p>
              </div>
            </div>
            <div className="border-t border-border px-3 py-1.5 flex items-center gap-1 text-xs text-primary">
              <ExternalLink className="w-3 h-3" />
              <span>Click to open on Wikipedia</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
