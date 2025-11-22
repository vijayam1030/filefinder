import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Search, File, Loader2, RefreshCw, Database, Zap, HardDrive, Clock } from "lucide-react";
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
  const [searchTime, setSearchTime] = useState(0);
  const [rootPath] = useState("C:/");

  useEffect(() => {
    initIndex();

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

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (query.length > 0 && indexStats?.indexed) {
        setSearching(true);
        const startTime = performance.now();
        try {
          const res = await invoke<string[]>("search_index", { query });
          const endTime = performance.now();
          setSearchTime(endTime - startTime);
          setResults(res);
        } catch (error) {
          console.error("Search failed", error);
          setResults([]);
        } finally {
          setSearching(false);
        }
      } else {
        setResults([]);
        setSearchTime(0);
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [query, indexStats]);

  const formatBytes = (bytes: number) => {
    const avg = bytes * 300; // Rough estimate: 300 bytes per path
    if (avg < 1024) return `${avg.toFixed(0)} B`;
    if (avg < 1024 * 1024) return `${(avg / 1024).toFixed(1)} KB`;
    return `${(avg / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  };

  return (
    <main className="container">
      <div className="header">
        <h1>
          <Zap size={32} />
          Antigravity Search
        </h1>
        <div className="app-version">v1.0.0</div>
      </div>

      {/* Stats Grid */}
      {indexStats?.indexed && (
        <div className="stats-grid fade-in">
          <div className="stat-card">
            <div className="stat-label">Total Files</div>
            <div className="stat-value">
              {indexStats.total_files.toLocaleString()}
              <span className="stat-unit">files</span>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-label">Index Size</div>
            <div className="stat-value">
              {formatBytes(indexStats.total_files)}
            </div>
            <div className="stat-subtitle">in memory</div>
          </div>

          {searchTime > 0 && (
            <div className="stat-card">
              <div className="stat-label">Search Time</div>
              <div className="stat-value">
                {searchTime.toFixed(1)}
                <span className="stat-unit">ms</span>
              </div>
              <div className="stat-subtitle">{results.length} results</div>
            </div>
          )}

          {indexStats.last_indexed && (
            <div className="stat-card">
              <div className="stat-label">Last Indexed</div>
              <div className="stat-value" style={{ fontSize: "1.25rem" }}>
                {formatTime(indexStats.last_indexed)}
              </div>
              <div className="stat-subtitle">
                {new Date(indexStats.last_indexed).toLocaleString()}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Index Status */}
      <div className="index-status fade-in">
        {indexing ? (
          <div className="indexing-container">
            <div className="status-icon indexing-icon">
              <Loader2 className="spin" size={24} />
            </div>
            <div className="indexed-info">
              <div className="progress-text">Indexing in progress...</div>
              <div className="last-indexed">
                <HardDrive size={14} />
                {indexProgress.toLocaleString()} files scanned
              </div>
            </div>
          </div>
        ) : indexStats?.indexed ? (
          <>
            <div className="indexed-status">
              <div className="status-icon">
                <Database size={24} />
              </div>
              <div className="indexed-info">
                <h3>Index Ready</h3>
                <div className="last-indexed">
                  <Clock size={14} />
                  Updated {indexStats.last_indexed && formatTime(indexStats.last_indexed)}
                </div>
              </div>
            </div>
            <button onClick={() => buildIndex(true)} className="refresh-btn">
              <RefreshCw size={16} />
              Rebuild
            </button>
          </>
        ) : (
          <button onClick={() => buildIndex(false)} className="build-index-btn">
            <Database size={18} />
            Build Index
          </button>
        )}
      </div>

      {/* Search Input */}
      <div className="search-container fade-in">
        <Search className="search-icon" size={22} />
        <input
          className="search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            indexStats?.indexed
              ? 'Search with regex (e.g., "\\.txt$") or plain text...'
              : "Build index to start searching"
          }
          disabled={!indexStats?.indexed || indexing}
          autoFocus={indexStats?.indexed}
        />
      </div>

      {/* Results */}
      {query && results.length > 0 && (
        <div className="results-header fade-in">
          <span className="results-count">
            {results.length.toLocaleString()} results • {searchTime.toFixed(1)}ms
          </span>
        </div>
      )}

      <div className="results-list fade-in">
        {searching && (
          <div className="loading">
            <div className="loading-spinner"></div>
            <p>Searching...</p>
          </div>
        )}

        {!searching && !indexStats?.indexed && !indexing && (
          <div className="empty-state">
            <Database size={64} style={{ opacity: 0.3 }} />
            <p style={{ fontSize: "1.125rem", color: "#888" }}>
              Click "Build Index" to start indexing your files
            </p>
            <p style={{ fontSize: "0.875rem", color: "#666" }}>
              First-time indexing may take 30-60 seconds for a full drive scan
            </p>
          </div>
        )}

        {!searching && results.length === 0 && query && indexStats?.indexed && (
          <div className="empty-state">
            <p style={{ fontSize: "1.125rem", color: "#888" }}>No results found</p>
            <p style={{ fontSize: "0.875rem", color: "#666" }}>
              Try a different search term or regex pattern
            </p>
          </div>
        )}

        {!searching &&
          results.map((path, index) => (
            <div
              key={index}
              className="result-item"
              onClick={async () => {
                try {
                  await invoke("open_file", { path });
                } catch (error) {
                  console.error("Failed to open file:", error);
                }
              }}
            >
              <File className="result-icon" size={20} />
              <span className="result-path">{path}</span>
            </div>
          ))}
      </div>

      <div className="footer">
        Searching in <strong>{rootPath}</strong> • Results limited to 2,000 files
      </div>
    </main>
  );
}

export default App;
