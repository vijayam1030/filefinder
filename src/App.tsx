import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Search, File, Loader2 } from "lucide-react";
import "./App.css";

function App() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [rootPath] = useState("C:/"); // Default to C drive

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (query.length > 0) {
        setSearching(true);
        try {
          // Invoke Rust command. Tauri maps camelCase JS args to snake_case Rust args.
          const res = await invoke<string[]>("search_files", { query, rootPath });
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
    }, 300); // 300ms debounce

    return () => clearTimeout(timer);
  }, [query, rootPath]);

  return (
    <main className="container">
      <h1>Antigravity Search</h1>

      <div className="search-container">
        <Search className="search-icon" size={20} />
        <input
          className="search-input"
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search files with Regex (e.g. \.txt$)..."
          autoFocus
        />
      </div>

      <div className="results-list">
        {searching && (
            <div className="loading">
                <Loader2 className="animate-spin" style={{margin: "0 auto"}} />
                <p>Searching...</p>
            </div>
        )}
        
        {!searching && results.length === 0 && query && (
            <div className="empty-state">No results found</div>
        )}

        {!searching && results.map((path, index) => (
          <div key={index} className="result-item" title={path}>
            <File className="result-icon" size={16} />
            <span>{path}</span>
          </div>
        ))}
      </div>
      
      <div style={{marginTop: "1rem", fontSize: "0.8rem", color: "#666", textAlign: "center"}}>
        Searching in: {rootPath} (Limited to 2000 results)
      </div>
    </main>
  );
}

export default App;
