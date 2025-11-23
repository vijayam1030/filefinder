import { useState, useEffect, useRef, useMemo } from "react";
import { Search, File, Loader2, RefreshCw, Database, Zap, HardDrive, Clock, Folder, FileText, Copy, FolderOpen, History } from "lucide-react";
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

interface SearchHistoryItem {
  query: string;
  timestamp: string;
  resultCount: number;
  copiedPath: string;
}

interface IndexHistoryItem {
  folderName: string;
  folderPath: string;
  timestamp: string;
  fileCount: number;
}

function App() {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [results, setResults] = useState<FileResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [indexStats, setIndexStats] = useState<IndexStats | null>(null);
  const [searchTime, setSearchTime] = useState(0);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [indexProgress, setIndexProgress] = useState(0);
  const [activeTab, setActiveTab] = useState<'search' | 'history'>('search');
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>([]);
  const [indexHistory, setIndexHistory] = useState<IndexHistoryItem[]>([]);
  
  const workerRef = useRef<Worker | null>(null);
  const fileIndexRef = useRef<string[]>([]);

  // Check if File System Access API is supported
  const isFileSystemSupported = 'showDirectoryPicker' in window;

  // Parse file path into structured data
  // Select folder and index files using File System Access API
  const selectAndIndexFolder = async () => {
    if (!isFileSystemSupported) {
      alert('File System Access API is not supported in this browser. Please use Chrome, Edge, or another Chromium-based browser on desktop.');
      return;
    }
    
    try {
      // @ts-ignore - File System Access API
      const dirHandle = await window.showDirectoryPicker({
        mode: 'read'
      });
      
      setSelectedFolder(dirHandle.name);
      setIndexing(true);
      setIndexProgress(0);
      
      // Send to worker for processing
      workerRef.current?.postMessage({
        type: 'INDEX_FILES',
        data: { dirHandle, basePath: '' }
      });
      
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        console.error('Error indexing:', error);
        alert('Error: ' + error.message);
      }
      setIndexing(false);
    }
  };

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

  // Load index from IndexedDB on mount
  useEffect(() => {
    // Initialize Web Worker
    workerRef.current = new Worker(new URL('./indexWorker.ts', import.meta.url), {
      type: 'module'
    });
    
    // Handle worker messages
    workerRef.current.onmessage = (e: MessageEvent) => {
      const { type, data } = e.data;
      
      switch (type) {
        case 'INDEX_PROGRESS':
          setIndexProgress(data.filesIndexed);
          break;
        
        case 'INDEX_COMPLETE':
          fileIndexRef.current = data.files;
          const timestamp = new Date().toISOString();
          setIndexStats({
            total_files: data.totalFiles,
            indexed: true,
            last_indexed: timestamp
          });
          setIndexing(false);
          saveIndexToDB(data.files);
          break;
        
        case 'INDEX_ERROR':
          console.error('Indexing error:', data.error);
          setIndexing(false);
          alert('Error indexing: ' + data.error);
          break;
        
        case 'SEARCH_COMPLETE':
          const parsedResults = data.results.map(parseFilePath);
          setResults(parsedResults);
          setSearchTime(data.searchTime);
          setSearching(false);
          break;
        
        case 'INDEX_LOADED':
          setIndexStats(prev => prev ? { ...prev, indexed: true } : null);
          break;
      }
    };
    
    loadIndexFromDB();
    loadHistory();
    
    return () => {
      workerRef.current?.terminate();
    };
  }, []);

  // Track when indexing completes and add to history
  useEffect(() => {
    if (indexStats?.indexed && indexStats.last_indexed && selectedFolder && !indexing) {
      addToIndexHistory({
        folderName: selectedFolder,
        folderPath: selectedFolder,
        timestamp: indexStats.last_indexed,
        fileCount: indexStats.total_files
      });
    }
  }, [indexStats?.indexed, indexStats?.last_indexed]);

  const loadIndexFromDB = async () => {
    try {
      const db = await openDB();
      const tx = db.transaction('fileIndex', 'readonly');
      const store = tx.objectStore('fileIndex');
      const request = store.get('index');
      
      const data: any = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      
      if (data && data.files) {
        fileIndexRef.current = data.files;
        setIndexStats({
          total_files: data.files.length,
          indexed: true,
          last_indexed: data.timestamp
        });
        
        // Load into worker
        workerRef.current?.postMessage({
          type: 'LOAD_INDEX',
          data: { files: data.files }
        });
      }
    } catch (error) {
      console.log('No previous index found');
    }
  };

  const openDB = (): Promise<IDBDatabase> => {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('FileFinderDB', 1);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('fileIndex')) {
          db.createObjectStore('fileIndex');
        }
      };
    });
  };

  const saveIndexToDB = async (files: string[]) => {
    try {
      const db = await openDB();
      const tx = db.transaction('fileIndex', 'readwrite');
      const store = tx.objectStore('fileIndex');
      
      await store.put({
        files,
        timestamp: new Date().toISOString()
      }, 'index');
    } catch (error) {
      console.error('Error saving to IndexedDB:', error);
    }
  };

  // History management
  const loadHistory = () => {
    try {
      const searchHist = localStorage.getItem('searchHistory');
      const indexHist = localStorage.getItem('indexHistory');
      
      if (searchHist) {
        setSearchHistory(JSON.parse(searchHist));
      }
      if (indexHist) {
        setIndexHistory(JSON.parse(indexHist));
      }
    } catch (error) {
      console.error('Error loading history:', error);
    }
  };

  const addToSearchHistory = (item: SearchHistoryItem) => {
    setSearchHistory(prev => {
      const updated = [item, ...prev.filter(h => h.query !== item.query)].slice(0, 50);
      localStorage.setItem('searchHistory', JSON.stringify(updated));
      return updated;
    });
  };

  const addToIndexHistory = (item: IndexHistoryItem) => {
    setIndexHistory(prev => {
      const updated = [item, ...prev.filter(h => h.folderPath !== item.folderPath)].slice(0, 20);
      localStorage.setItem('indexHistory', JSON.stringify(updated));
      return updated;
    });
  };

  const clearSearchHistory = () => {
    setSearchHistory([]);
    localStorage.removeItem('searchHistory');
  };

  const clearIndexHistory = () => {
    setIndexHistory([]);
    localStorage.removeItem('indexHistory');
  };

  const performSearch = (searchQuery: string) => {
    if (!searchQuery || fileIndexRef.current.length === 0) {
      setResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    
    // Send to worker for processing
    workerRef.current?.postMessage({
      type: 'SEARCH',
      data: { query: searchQuery }
    });
  };

  // Debounce - increase to 300ms for smoother typing
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
    }, 300);
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
    performSearch(debouncedQuery);
  }, [debouncedQuery]);

  const copyToClipboard = async (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(path);
      setCopiedPath(path);
      setTimeout(() => setCopiedPath(null), 2000);
      
      // Add to search history when user clicks a result
      if (debouncedQuery.trim()) {
        addToSearchHistory({
          query: debouncedQuery,
          timestamp: new Date().toISOString(),
          resultCount: results.length,
          copiedPath: path
        });
      }
    } catch (error) {
      console.error("Failed to copy:", error);
    }
  };

  const formatBytes = (bytes: number) => {
    const avg = bytes * 300;
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

  // Highlight matching parts in text (optimized with useMemo)
  const highlightMatch = useMemo(() => {
    return (text: string, query: string) => {
      if (!query.trim()) return text;
      
      const parts = query.toLowerCase().split(/\s+/).filter(p => p.length > 0);
      const textLower = text.toLowerCase();
      
      // Find all match positions
      const positions: Array<{start: number, end: number}> = [];
      
      parts.forEach(part => {
        let index = 0;
        while ((index = textLower.indexOf(part, index)) !== -1) {
          positions.push({ start: index, end: index + part.length });
          index++;
        }
      });
      
      if (positions.length === 0) return text;
      
      // Sort and merge overlapping ranges
      positions.sort((a, b) => a.start - b.start);
      const merged: Array<{start: number, end: number}> = [];
      
      positions.forEach(pos => {
        if (merged.length === 0 || merged[merged.length - 1].end < pos.start) {
          merged.push(pos);
        } else {
          merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, pos.end);
        }
      });
      
      // Build result with highlights
      const result: React.ReactNode[] = [];
      let lastIndex = 0;
      
      merged.forEach((pos, idx) => {
        if (pos.start > lastIndex) {
          result.push(text.substring(lastIndex, pos.start));
        }
        result.push(
          <mark key={idx} className="highlight">
            {text.substring(pos.start, pos.end)}
          </mark>
        );
        lastIndex = pos.end;
      });
      
      if (lastIndex < text.length) {
        result.push(text.substring(lastIndex));
      }
      
      return <>{result}</>;
    };
  }, []);

  return (
    <main className="container">
      <div className="header">
        <h1>
          <Zap size={32} />
          Antigravity Search
        </h1>
        <div className="app-version">v3.0.0 • Pure Browser</div>
      </div>

      {/* Tabs */}
      <div className="tabs-container">
        <button 
          className={`tab-btn ${activeTab === 'search' ? 'active' : ''}`}
          onClick={() => setActiveTab('search')}
        >
          <Search size={16} />
          Search
        </button>
        <button 
          className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => setActiveTab('history')}
        >
          <History size={16} />
          History
        </button>
      </div>

      {/* Browser compatibility warning */}
      {!isFileSystemSupported && (
        <div className="warning-banner">
          <div className="warning-content">
            <strong>⚠️ Browser Not Supported</strong>
            <p>This app requires the File System Access API, which is only available in Chrome, Edge, and other Chromium-based browsers on desktop.</p>
          </div>
        </div>
      )}

      {activeTab === 'search' && (
        <>
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
            <div className="stat-label">Storage</div>
            <div className="stat-value">
              {formatBytes(indexStats.total_files)}
            </div>
            <div className="stat-subtitle">in browser cache</div>
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
                {selectedFolder || 'Local folder'}
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
                {indexProgress.toLocaleString()} files scanned...
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
            <button onClick={selectAndIndexFolder} className="refresh-btn">
              <RefreshCw size={16} />
              Re-index
            </button>
          </>
        ) : (
          <button onClick={selectAndIndexFolder} className="build-index-btn">
            <FolderOpen size={18} />
            Select Folder to Index
          </button>
        )}
      </div>

      {/* Search Input */}
      <form onSubmit={(e) => e.preventDefault()} className="search-container">
        <Search className={searching ? "search-icon searching" : "search-icon"} size={22} />
        <input
          className="search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            indexStats?.indexed
              ? 'Search: "Integer.java" or "spring Application.java"...'
              : "Select a folder to start indexing"
          }
          disabled={!indexStats?.indexed || indexing}
          autoFocus={indexStats?.indexed}
        />
      </form>

      {/* Results Header - always show when indexed to prevent layout shift */}
      {indexStats?.indexed && (
        <div className="results-header">
          {query && results.length > 0 ? (
            <span className="results-count fade-in">
              <Database size={16} />
              {results.length > 100 ? `Showing 100 of ${results.length.toLocaleString()}` : `${results.length.toLocaleString()} results`} • {searchTime.toFixed(1)}ms
            </span>
          ) : (
            <span style={{ opacity: 0 }}>Placeholder</span>
          )}
        </div>
      )}

      <div className="results-list">
        {!searching && !indexStats?.indexed && !indexing && (
          <div className="empty-state">
            <FolderOpen size={64} style={{ opacity: 0.3 }} />
            <p style={{ fontSize: "1.125rem", color: "#888" }}>
              Click "Select Folder to Index" to get started
            </p>
            <p style={{ fontSize: "0.875rem", color: "#666" }}>
              Your browser will ask permission to access the folder
            </p>
          </div>
        )}

        {!searching && results.length === 0 && query && indexStats?.indexed && (
          <div className="empty-state">
            <p style={{ fontSize: "1.125rem", color: "#888" }}>No results found</p>
            <p style={{ fontSize: "0.875rem", color: "#666" }}>
              Try a different search term
            </p>
          </div>
        )}

        {!searching &&
          results.slice(0, 100).map((fileResult, index) => (
            <div
              key={index}
              className="result-item"
              onClick={(e) => copyToClipboard(fileResult.path, e)}
            >
              {getFileIcon(fileResult.extension)}
              <div className="result-content">
                <div className="result-path">
                  {highlightMatch(fileResult.path, debouncedQuery)}
                </div>
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
                    {copiedPath === fileResult.path ? '✓ Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
            </div>
          ))}
      </div>
      </>
      )}

      {/* History Tab */}
      {activeTab === 'history' && (
        <div className="history-container fade-in">
          <div className="history-section">
            <div className="history-header">
              <h2>
                <Search size={20} />
                Recent Searches
              </h2>
              {searchHistory.length > 0 && (
                <button className="clear-btn" onClick={clearSearchHistory}>
                  Clear All
                </button>
              )}
            </div>
            {searchHistory.length === 0 ? (
              <div className="empty-state">
                <Search size={48} style={{ opacity: 0.3 }} />
                <p>No search history yet</p>
              </div>
            ) : (
              <div className="history-list">
                {searchHistory.map((item, idx) => (
                  <div 
                    key={idx} 
                    className="history-item"
                    onClick={() => {
                      setQuery(item.query);
                      setActiveTab('search');
                    }}
                  >
                    <div className="history-item-header">
                      <span className="history-query">{item.query}</span>
                      <span className="history-time">{formatTime(item.timestamp)}</span>
                    </div>
                    <div className="history-meta">
                      <span className="result-badge">{item.resultCount} results</span>
                    </div>
                    {item.copiedPath && (
                      <div className="history-path">
                        <File size={14} />
                        <span className="path-text">{item.copiedPath}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="history-section">
            <div className="history-header">
              <h2>
                <FolderOpen size={20} />
                Indexed Folders
              </h2>
              {indexHistory.length > 0 && (
                <button className="clear-btn" onClick={clearIndexHistory}>
                  Clear All
                </button>
              )}
            </div>
            {indexHistory.length === 0 ? (
              <div className="empty-state">
                <FolderOpen size={48} style={{ opacity: 0.3 }} />
                <p>No folders indexed yet</p>
              </div>
            ) : (
              <div className="history-list">
                {indexHistory.map((item, idx) => (
                  <div key={idx} className="history-item">
                    <div className="history-item-header">
                      <span className="history-query">
                        <Folder size={16} />
                        {item.folderName}
                      </span>
                      <span className="history-time">{formatTime(item.timestamp)}</span>
                    </div>
                    <div className="history-meta">
                      <span className="result-badge">{item.fileCount.toLocaleString()} files</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="footer">
        100% Browser-Based • No Backend Required • Data Stored Locally
      </div>
    </main>
  );
}

export default App;
