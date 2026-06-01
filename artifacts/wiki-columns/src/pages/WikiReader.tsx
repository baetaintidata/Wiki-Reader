import { useState, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, BookOpen, ArrowRight, X, Columns3 } from "lucide-react";

interface WikiArticle {
  title: string;
  html: string;
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

function cleanWikiHtml(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;

  // Remove edit section links
  div.querySelectorAll(".mw-editsection").forEach((el) => el.remove());
  // Remove TOC
  div.querySelectorAll("#toc, .toc").forEach((el) => el.remove());
  // Remove navboxes / hatnotes / portal boxes
  div.querySelectorAll(".navbox, .navbox-inner, .sistersitebox, .hatnote, .portal, .portalbox").forEach((el) => el.remove());
  // Remove disambiguation notices
  div.querySelectorAll(".dmbox, .disambiguation").forEach((el) => el.remove());
  // Remove hidden categories
  div.querySelectorAll(".mw-hidden-catlinks, #catlinks").forEach((el) => el.remove());
  // Remove references section title (keep text)
  div.querySelectorAll(".references").forEach((el) => el.remove());
  div.querySelectorAll("sup.reference, .reflist, .references-small").forEach((el) => el.remove());
  // Remove "See also", "References", "Notes", "External links" header sections
  div.querySelectorAll("h2, h3").forEach((heading) => {
    const text = heading.textContent?.trim().toLowerCase() ?? "";
    if (
      ["see also", "references", "notes", "external links", "further reading", "bibliography"].includes(text)
    ) {
      // Remove the heading and all following siblings until next h2
      let next = heading.nextElementSibling;
      while (next && next.tagName !== "H2") {
        const toRemove = next;
        next = next.nextElementSibling;
        toRemove.remove();
      }
      heading.remove();
    }
  });
  // Fix image src paths
  div.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src");
    if (src && src.startsWith("//")) {
      img.setAttribute("src", "https:" + src);
    }
  });
  // Fix anchor hrefs to point to wikipedia
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

export default function WikiReader() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [article, setArticle] = useState<WikiArticle | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
      const title = json.parse?.displaytitle ?? name.replace(/_/g, " ");
      const cleanHtml = cleanWikiHtml(rawHtml);
      setArticle({ title, html: cleanHtml });
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

  return (
    <div className="min-h-screen bg-background">
      {/* Header bar */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="max-w-screen-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="flex items-center gap-2 shrink-0">
            <Columns3 className="w-5 h-5 text-primary" />
            <span className="font-semibold text-sm tracking-tight hidden sm:block text-foreground">
              Wiki Column Reader
            </span>
          </div>

          <form
            onSubmit={handleSubmit}
            className="flex-1 flex items-center gap-2 max-w-2xl"
          >
            <div className="relative flex-1">
              <input
                ref={inputRef}
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://en.wikipedia.org/wiki/..."
                className="w-full h-9 pl-3 pr-8 rounded-md border border-input bg-card text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition"
                autoFocus
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
            </div>
            <button
              type="submit"
              disabled={loading || !url.trim()}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium flex items-center gap-1.5 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition shrink-0"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  <span>Load</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </>
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
        </div>
      </header>

      <main className="max-w-screen-2xl mx-auto px-4 pb-16">
        <AnimatePresence mode="wait">
          {/* Error */}
          {error && !loading && (
            <motion.div
              key="error"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-8 max-w-lg mx-auto text-center"
            >
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-5 text-sm text-destructive">
                {error}
              </div>
            </motion.div>
          )}

          {/* Loading skeleton */}
          {loading && (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="mt-8"
            >
              <div className="h-8 w-64 bg-muted rounded animate-pulse mb-6" />
              <div className="wiki-columns">
                {Array.from({ length: 18 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-4 bg-muted rounded animate-pulse mb-3"
                    style={{ width: `${65 + Math.random() * 35}%` }}
                  />
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
            >
              {/* Title */}
              <h1
                className="text-3xl font-bold text-foreground mb-1 font-sans"
                dangerouslySetInnerHTML={{ __html: article.title }}
              />
              <div className="h-px bg-border mb-5" />

              {/* Columned content */}
              <div
                className="wiki-columns wiki-content"
                dangerouslySetInnerHTML={{ __html: article.html }}
              />
            </motion.article>
          )}

          {/* Empty state */}
          {!article && !loading && !error && (
            <motion.div
              key="empty"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-24 text-center"
            >
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-accent mb-5">
                <BookOpen className="w-8 h-8 text-accent-foreground" />
              </div>
              <h2 className="text-xl font-semibold text-foreground mb-2">
                Paste a Wikipedia URL to get started
              </h2>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                Enter any Wikipedia article URL above to read it in a comfortable multi-column newspaper layout.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {[
                  "https://en.wikipedia.org/wiki/Coffee",
                  "https://en.wikipedia.org/wiki/Jazz",
                  "https://en.wikipedia.org/wiki/Photosynthesis",
                ].map((example) => (
                  <button
                    key={example}
                    onClick={() => {
                      setUrl(example);
                      fetchArticle(example);
                    }}
                    className="text-xs px-3 py-1.5 rounded-full border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition"
                  >
                    {example.split("/wiki/")[1].replace(/_/g, " ")}
                  </button>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
