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
  const [displayResults, setDisplayResults] = useState<FileResult[]>([]);
  const [displayQuery, setDisplayQuery] = useState("");
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
  const [folderPathInput, setFolderPathInput] = useState<string>('');
  
  const workerRef = useRef<Worker | null>(null);
  const fileIndexRef = useRef<string[]>([]);
  const encryptionKeyRef = useRef<CryptoKey | null>(null);

  // Generate or retrieve encryption key
  const getEncryptionKey = async (): Promise<CryptoKey> => {
    if (encryptionKeyRef.current) {
      return encryptionKeyRef.current;
    }

    // Try to load existing key from localStorage
    const storedKey = localStorage.getItem('encryptionKey');
    
    if (storedKey) {
      // Import the key
      const keyData = Uint8Array.from(atob(storedKey), c => c.charCodeAt(0));
      const key = await crypto.subtle.importKey(
        'raw',
        keyData,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
      );
      encryptionKeyRef.current = key;
      return key;
    }

    // Generate new key
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    // Store key
    const exportedKey = await crypto.subtle.exportKey('raw', key);
    const keyArray = new Uint8Array(exportedKey);
    const keyBase64 = btoa(String.fromCharCode(...keyArray));
    localStorage.setItem('encryptionKey', keyBase64);

    encryptionKeyRef.current = key;
    return key;
  };

  // Encrypt data
  const encryptData = async (data: any): Promise<string> => {
    const key = await getEncryptionKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encodedData = new TextEncoder().encode(JSON.stringify(data));

    const encryptedData = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encodedData
    );

    // Combine IV and encrypted data
    const combined = new Uint8Array(iv.length + encryptedData.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encryptedData), iv.length);

    return btoa(String.fromCharCode(...combined));
  };

  // Decrypt data
  const decryptData = async (encryptedString: string): Promise<any> => {
    const key = await getEncryptionKey();
    const combined = Uint8Array.from(atob(encryptedString), c => c.charCodeAt(0));

    const iv = combined.slice(0, 12);
    const encryptedData = combined.slice(12);

    const decryptedData = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      encryptedData
    );

    const decodedData = new TextDecoder().decode(decryptedData);
    return JSON.parse(decodedData);
  };

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
      // Show folder picker (browser security requires manual selection to grant access)
      // @ts-ignore - File System Access API
      const dirHandle = await window.showDirectoryPicker({
        mode: 'read',
        startIn: 'documents'
      });
      
      // Use folder name as base path
      const basePath = dirHandle.name;
      
      setSelectedFolder(dirHandle.name);
      setFolderPathInput(dirHandle.name);
      setIndexing(true);
      setIndexProgress(0);
      
      // Send to worker for processing
      workerRef.current?.postMessage({
        type: 'INDEX_FILES',
        data: { dirHandle, basePath }
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
      
      const encryptedData: any = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      
      if (encryptedData && encryptedData.encrypted) {
        // Decrypt the data
        const data = await decryptData(encryptedData.encrypted);
        
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
      console.log('No previous index found or decryption failed');
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
      const data = {
        files,
        timestamp: new Date().toISOString()
      };
      
      // Encrypt the data
      const encrypted = await encryptData(data);
      
      const db = await openDB();
      const tx = db.transaction('fileIndex', 'readwrite');
      const store = tx.objectStore('fileIndex');
      
      await store.put({ encrypted }, 'index');
    } catch (error) {
      console.error('Error saving to IndexedDB:', error);
    }
  };

  // History management
  const loadHistory = async () => {
    try {
      const searchHist = localStorage.getItem('searchHistory');
      const indexHist = localStorage.getItem('indexHistory');
      
      if (searchHist) {
        try {
          const decrypted = await decryptData(searchHist);
          setSearchHistory(decrypted);
        } catch {
          // Fallback to unencrypted for backward compatibility
          setSearchHistory(JSON.parse(searchHist));
        }
      }
      if (indexHist) {
        try {
          const decrypted = await decryptData(indexHist);
          setIndexHistory(decrypted);
        } catch {
          // Fallback to unencrypted for backward compatibility
          setIndexHistory(JSON.parse(indexHist));
        }
      }
    } catch (error) {
      console.error('Error loading history:', error);
    }
  };

  const addToSearchHistory = async (item: SearchHistoryItem) => {
    const updated = [item, ...searchHistory.filter(h => h.query !== item.query)].slice(0, 50);
    const encrypted = await encryptData(updated);
    localStorage.setItem('searchHistory', encrypted);
    setSearchHistory(updated);
  };

  const addToIndexHistory = async (item: IndexHistoryItem) => {
    const updated = [item, ...indexHistory.filter(h => h.folderPath !== item.folderPath)].slice(0, 20);
    const encrypted = await encryptData(updated);
    localStorage.setItem('indexHistory', encrypted);
    setIndexHistory(updated);
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

  // Debounce - increase to 400ms for smoother typing
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
    }, 400);
    return () => clearTimeout(timer);
  }, [query]);

  // Update display results only after search completes (prevent glitching)
  useEffect(() => {
    if (!searching && results.length >= 0) {
      // Small delay to ensure smooth transition
      const timer = setTimeout(() => {
        setDisplayResults(results);
        setDisplayQuery(debouncedQuery);
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [searching, results, debouncedQuery]);

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
      // Convert forward slashes back to backslashes for Windows
      const windowsPath = path.replace(/\//g, '\\');
      await navigator.clipboard.writeText(windowsPath);
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

  // Convert forward slashes to backslashes for Windows display
  const toWindowsPath = (path: string) => path.replace(/\//g, '\\');

  // Highlight matching parts in text (optimized with useMemo)
  const highlightMatch = useMemo(() => {
    return (text: string, query: string) => {
      if (!query.trim()) return text;
      
      const parts = query.toLowerCase().split(/\s+/).filter(p => p.length > 0);
      const textLower = text.toLowerCase();
      
      // Colors for different search terms
      const colors = ['highlight-1', 'highlight-2', 'highlight-3', 'highlight-4'];
      
      // Find all match positions with their word index
      const positions: Array<{start: number, end: number, colorClass: string}> = [];
      
      parts.forEach((part, partIndex) => {
        let index = 0;
        const colorClass = colors[partIndex % colors.length];
        while ((index = textLower.indexOf(part, index)) !== -1) {
          positions.push({ start: index, end: index + part.length, colorClass });
          index++;
        }
      });
      
      if (positions.length === 0) return text;
      
      // Sort by start position
      positions.sort((a, b) => a.start - b.start);
      
      // Merge overlapping ranges (keep first color)
      const merged: Array<{start: number, end: number, colorClass: string}> = [];
      
      positions.forEach(pos => {
        if (merged.length === 0 || merged[merged.length - 1].end < pos.start) {
          merged.push(pos);
        } else if (pos.end > merged[merged.length - 1].end) {
          merged[merged.length - 1].end = pos.end;
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
          <mark key={idx} className={`highlight ${pos.colorClass}`}>
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
          File Search
        </h1>
        <div className="app-version">v3.0.0 • Lightning Fast</div>
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
        <div className="main-layout">
          {/* Left Panel - Index Setup & Search */}
          <div className="left-panel">
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
        ) : (
          <>
            {indexStats?.indexed && (
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
                  {selectedFolder && (
                    <div className="last-indexed" title={selectedFolder}>
                      <FolderOpen size={14} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {selectedFolder}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
            <button onClick={selectAndIndexFolder} className="build-index-btn">
              <FolderOpen size={18} />
              {indexStats?.indexed ? 'Re-index Folder' : 'Select Folder to Index'}
            </button>
          </>
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
              : "Enter folder path and index to start searching"
          }
          disabled={!indexStats?.indexed || indexing}
          autoFocus={indexStats?.indexed}
        />
      </form>
          </div>

          {/* Right Panel - Results */}
          <div className="right-panel">
            {/* Results Header - always show when indexed to prevent layout shift */}
            {indexStats?.indexed && (
              <div className="results-header">
                {displayQuery && displayResults.length > 0 ? (
                  <span className="results-count">
                    <Database size={16} />
                    {displayResults.length > 100 ? `Showing 100 of ${displayResults.length.toLocaleString()}` : `${displayResults.length.toLocaleString()} results`} • {searchTime.toFixed(1)}ms
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
              Enter folder path and click Index to get started
            </p>
            <p style={{ fontSize: "0.875rem", color: "#666" }}>
              Your browser will ask permission to access the folder
            </p>
          </div>
        )}

        {!searching && displayResults.length === 0 && displayQuery && indexStats?.indexed && (
          <div className="empty-state">
            <p style={{ fontSize: "1.125rem", color: "#888" }}>No results found</p>
            <p style={{ fontSize: "0.875rem", color: "#666" }}>
              Try a different search term
            </p>
          </div>
        )}

        {!searching &&
          displayResults.slice(0, 100).map((fileResult, index) => (
            <div
              key={index}
              className="result-item"
              onClick={(e) => copyToClipboard(fileResult.path, e)}
            >
              {getFileIcon(fileResult.extension)}
              <div className="result-content">
                <div className="result-path">
                  {highlightMatch(toWindowsPath(fileResult.path), displayQuery)}
                </div>
                <div className="result-details">
                  <span className="result-badge">
                    <Folder size={12} />
                    {toWindowsPath(fileResult.directory).split('\\').slice(-2).join('\\') || '\\'}
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
          </div>
        </div>
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
