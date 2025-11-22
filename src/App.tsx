import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Search, File, Loader2, RefreshCw, Database } from "lucide-react";
import "./App.css";

interface IndexStats {
  total_files: number;
  indexed: boolean;
  last_indexed: string | null;
}

function App() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [indexProgress, setIndexProgress] = useState(0);
  const [indexStats, setIndexStats] = useState<IndexStats | null>(null);
  const [rootPath] = useState("C:/"); // Default to C drive

  // Load index on mount
  useEffect(() => {
    initIndex();

    // Listen for index progress events
    const unlistenProgress = listen<number>("index-progress", (event) => {
      setIndexProgress(event.payload);
    });

    const unlistenComplete = listen<number>("index-complete", (event) => {
      setIndexing(false);
      setIndexProgress(event.payload);
      loadIndexStats();
    });

    return () => {
      unlistenProgress.then((fn) => fn());
      unlistenComplete.then((fn) => fn());
    };
  }, []);

  const initIndex = async () => {
    try {
      const stats = await invoke<IndexStats | null>("init_index");
      if (stats) {
        setIndexStats(stats);
      }
    } catch (error) {
      console.error("Failed to init index", error);
    }
  };

  const loadIndexStats = async () => {
    try {
      const stats = await invoke<IndexStats>("get_index_stats");
      setIndexStats(stats);
    } catch (error) {
      console.error("Failed to load index stats", error);
    }
  };

  const buildIndex = async (forceRebuild = false) => {
    setIndexing(true);
    setIndexProgress(0);
    try {
      await invoke("build_index", { rootPath, forceRebuild });
    } catch (error) {
      console.error("Indexing failed", error);
      setIndexing(false);
    }
  };

  // Search with debounce
  useEffect(() => {
    const timer = setTimeout(async () => {
      if (query.length > 0 && indexStats?.indexed) {
        setSearching(true);
        try {
          const res = await invoke<string[]>("search_index", { query });
          setResults(res);
        } catch (error) {
          console.error("Search failed", error);
          setResults([]);
        } finally {
          setSearching(false);
        }
      } else {
        setResults([]);
      }
    }, 150); // Faster debounce since we're searching in memory

    return () => clearTimeout(timer);
  }, [query, indexStats]);

  return (
    <main className="container">
      <h1>Antigravity Search</h1>

      {/* Index Status Bar */}
      <div className="index-status">
        {indexing ? (
          <div className="indexing-container">
            <Loader2 className="spin" size={16} />
            <span>Indexing... {indexProgress.toLocaleString()} files found</span>
          </div>
        ) : indexStats?.indexed ? (
          <div className="indexed-status">
            <Database size={16} />
            <div className="indexed-info">
              <span>{indexStats.total_files.toLocaleString()} files indexed</span>
              {indexStats.last_indexed && (
                <span className="last-indexed">
                  Last updated: {new Date(indexStats.last_indexed).toLocaleString()}
                </span>
              )}
            </div>
            <button onClick={() => buildIndex(true)} className="refresh-btn" title="Rebuild Index">
              <RefreshCw size={14} />
            </button>
          </div>
        ) : (
          <button onClick={() => buildIndex(false)} className="build-index-btn">
            <Database size={16} />
            Build Index
          </button>
        )}
      </div>

      {/* Search Input */}
      <div className="search-container">
        <Search className="search-icon" size={20} />
        <input
          className="search-input"
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            indexStats?.indexed
              ? "Search files with Regex (e.g. \\.txt$)..."
              : "Build index first to search"
          }
          disabled={!indexStats?.indexed || indexing}
          autoFocus={indexStats?.indexed}
        />
      </div>

      {/* Results List */}
      <div className="results-list">
        {searching && (
          <div className="loading">
            <Loader2 className="spin" style={{ margin: "0 auto" }} />
            <p>Searching...</p>
          </div>
        )}

        {!searching && !indexStats?.indexed && !indexing && (
          <div className="empty-state">
            <Database size={48} style={{ margin: "0 auto 1rem" }} />
            <p>Click "Build Index" to start indexing your files</p>
            <p style={{ fontSize: "0.9rem", color: "#888" }}>
              This may take 30-60 seconds for a full drive scan
            </p>
          </div>
        )}

        {!searching && results.length === 0 && query && indexStats?.indexed && (
          <div className="empty-state">No results found</div>
        )}

        {!searching &&
          results.map((path, index) => (
            <div
              key={index}
              className="result-item"
              title={path}
              onClick={async () => {
                try {
                  await invoke("open_file", { path });
                } catch (error) {
                  console.error("Failed to open file:", error);
                }
              }}
            >
              <File className="result-icon" size={16} />
              <span>{path}</span>
            </div>
          ))}
      </div>

      <div style={{ marginTop: "1rem", fontSize: "0.8rem", color: "#666", textAlign: "center" }}>
        {indexStats?.indexed
          ? `Searching in ${rootPath} • Results limited to 2000`
          : `Ready to index ${rootPath}`}
      </div>
    </main>
  );
}

export default App;
