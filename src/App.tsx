import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Search, File, Loader2, RefreshCw, Database, Zap, HardDrive, Clock, Folder, FileText, Copy } from "lucide-react";
import "./App.css";

interface IndexStats {
  total_files: number;
  indexed: boolean;
  last_indexed: string | null;
}

interface FileResult {
  path: string;
  fileName: string;
  directory: string;
  extension: string;
}

function App() {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [results, setResults] = useState<FileResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [indexProgress, setIndexProgress] = useState(0);
  const [indexStats, setIndexStats] = useState<IndexStats | null>(null);
  const [searchTime, setSearchTime] = useState(0);
  const [rootPath] = useState("C:/");
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const searchAbortController = useRef<AbortController | null>(null);

  // Copy path to clipboard
  const copyToClipboard = async (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(path);
      setCopiedPath(path);
      setTimeout(() => setCopiedPath(null), 2000);
    } catch (error) {
      console.error("Failed to copy:", error);
    }
  };

  // Parse file path into structured data
  const parseFilePath = (path: string): FileResult => {
    const normalizedPath = path.replace(/\\/g, '/');
    const parts = normalizedPath.split('/');
    const fileName = parts[parts.length - 1] || '';
    const directory = parts.slice(0, -1).join('/') || '/';
    const extension = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() || '' : '';
    
    return {
      path: normalizedPath,
      fileName,
      directory,
      extension
    };
  };

  // Get file icon based on extension
  const getFileIcon = (extension: string) => {
    const docTypes = ['txt', 'doc', 'docx', 'pdf', 'md', 'rtf'];
    if (docTypes.includes(extension)) {
      return <FileText className="result-icon" size={22} />;
    }
    return <File className="result-icon" size={22} />;
  };

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

  const performSearch = async (searchQuery: string) => {
    // Cancel any ongoing search
    if (searchAbortController.current) {
      searchAbortController.current.abort();
    }
    
    if (searchQuery.length > 0 && indexStats?.indexed) {
      setSearching(true);
      searchAbortController.current = new AbortController();
      const startTime = performance.now();
      
      try {
        const res = await invoke<string[]>("search_index", { query: searchQuery });
        
        // Check if this search was cancelled
        if (searchAbortController.current?.signal.aborted) {
          return;
        }
        
        const endTime = performance.now();
        setSearchTime(endTime - startTime);
        // Parse results into structured data
        const parsedResults = res.map(path => parseFilePath(path));
        setResults(parsedResults);
      } catch (error) {
        if (searchAbortController.current?.signal.aborted) {
          return; // Ignore errors from cancelled requests
        }
        console.error("Search failed", error);
        setResults([]);
      } finally {
        setSearching(false);
      }
    } else {
      setResults([]);
      setSearchTime(0);
      setSearching(false);
    }
  };

  // Debounce the query separately from the input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
    }, 250);

    return () => clearTimeout(timer);
  }, [query]);

  // Search when debounced query changes
  useEffect(() => {
    if (debouncedQuery.trim() === '') {
      setResults([]);
      setSearchTime(0);
      setSearching(false);
      return;
    }

    if (indexStats?.indexed) {
      performSearch(debouncedQuery);
    }
  }, [debouncedQuery, indexStats]);

  // Manual search trigger (Enter key or button)
  const handleSearch = (e?: React.FormEvent) => {
    e?.preventDefault();
    performSearch(query);
  };

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
      <form onSubmit={handleSearch} className="search-container">
        <Search className="search-icon" size={22} />
        <input
          className="search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            indexStats?.indexed
              ? 'Super flexible search: try "app config", "appconfig", "app-config", or regex...'
              : "Build index to start searching"
          }
          disabled={!indexStats?.indexed || indexing}
          autoFocus={indexStats?.indexed}
        />
        <button
          type="submit"
          className="search-btn"
          disabled={!indexStats?.indexed || indexing || !query}
          title="Search (Enter)"
        >
          <Search size={18} />
        </button>
      </form>

      {/* Results */}
      {query && results.length > 0 && (
        <div className="results-header fade-in">
          <span className="results-count">
            <Database size={16} />
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
          results.map((fileResult, index) => (
            <div
              key={index}
              className="result-item"
              onClick={async () => {
                try {
                  await invoke("open_file", { path: fileResult.path });
                } catch (error) {
                  console.error("Failed to open file:", error);
                }
              }}
            >
              {getFileIcon(fileResult.extension)}
              <div className="result-content">
                <div className="result-path">{fileResult.path}</div>
                <div className="result-details">
                  <span className="result-badge">
                    <Folder size={12} />
                    {fileResult.directory.split('/').slice(-2).join('/') || '/'}
                  </span>
                  {fileResult.extension && (
                    <span className="result-badge">
                      {fileResult.extension.toUpperCase()}
                    </span>
                  )}
                  <button
                    className="copy-btn"
                    onClick={(e) => copyToClipboard(fileResult.path, e)}
                    title="Copy path"
                  >
                    <Copy size={14} />
                    {copiedPath === fileResult.path ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
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
