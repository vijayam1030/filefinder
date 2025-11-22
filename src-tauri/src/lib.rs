use ignore::WalkBuilder;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use parking_lot::RwLock;
use tauri::Emitter;
use fuzzy_matcher::FuzzyMatcher;
use fuzzy_matcher::skim::SkimMatcherV2;
use rayon::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct IndexStats {
    pub total_files: usize,
    pub indexed: bool,
    pub last_indexed: Option<String>,
}

#[derive(Default)]
pub struct FileIndex {
    pub files: Arc<RwLock<Vec<String>>>,
    pub stats: Arc<RwLock<IndexStats>>,
}

impl FileIndex {
    fn new() -> Self {
        Self {
            files: Arc::new(RwLock::new(Vec::new())),
            stats: Arc::new(RwLock::new(IndexStats {
                total_files: 0,
                indexed: false,
                last_indexed: None,
            })),
        }
    }
}

// Cache version - increment this when filter logic changes
const CACHE_VERSION: u32 = 2;

#[derive(Serialize, Deserialize)]
struct CachedIndex {
    version: u32,
    files: Vec<String>,
    timestamp: String,
}

// Get cache file path
fn get_cache_path() -> PathBuf {
    let cache_dir = dirs::cache_dir().unwrap_or_else(|| PathBuf::from("."));
    cache_dir.join("filefinder").join("index_v2.bin")
}

// Save index to disk
fn save_index_to_disk(files: &[String]) -> Result<(), String> {
    let cache_path = get_cache_path();
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    
    let cached = CachedIndex {
        version: CACHE_VERSION,
        files: files.to_vec(),
        timestamp: chrono::Utc::now().to_rfc3339(),
    };
    
    let encoded = bincode::serialize(&cached).map_err(|e| e.to_string())?;
    fs::write(&cache_path, encoded).map_err(|e| e.to_string())?;
    Ok(())
}

// Load index from disk
fn load_index_from_disk() -> Result<CachedIndex, String> {
    let cache_path = get_cache_path();
    if !cache_path.exists() {
        return Err("Cache file not found".to_string());
    }
    
    let data = fs::read(&cache_path).map_err(|e| e.to_string())?;
    let cached: CachedIndex = bincode::deserialize(&data).map_err(|e| e.to_string())?;
    
    // Check version compatibility
    if cached.version != CACHE_VERSION {
        return Err("Cache version mismatch".to_string());
    }
    
    Ok(cached)
}

#[tauri::command]
async fn init_index(state: tauri::State<'_, FileIndex>) -> Result<Option<IndexStats>, String> {
    // Try to silently load from cache on startup
    if let Ok(cached) = load_index_from_disk() {
        let count = cached.files.len();
        *state.files.write() = cached.files;
        let stats = IndexStats {
            total_files: count,
            indexed: true,
            last_indexed: Some(cached.timestamp),
        };
        *state.stats.write() = stats.clone();
        return Ok(Some(stats));
    }
    Ok(None)
}

#[tauri::command]
async fn build_index(
    root_path: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, FileIndex>,
    force_rebuild: Option<bool>,
) -> Result<usize, String> {
    // Try to load from cache first (unless force rebuild)
    if !force_rebuild.unwrap_or(false) {
        if let Ok(cached) = load_index_from_disk() {
            let count = cached.files.len();
            *state.files.write() = cached.files;
            *state.stats.write() = IndexStats {
                total_files: count,
                indexed: true,
                last_indexed: Some(cached.timestamp),
            };
            app.emit("index-progress", count).ok();
            return Ok(count);
        }
    }

    // Build fresh index
    let files = state.files.clone();
    let stats = state.stats.clone();
    let app_clone = app.clone();
    
    tokio::task::spawn_blocking(move || {
        let file_list = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let counter = Arc::new(parking_lot::Mutex::new(0usize));
        
        let walker = WalkBuilder::new(&root_path)
            .hidden(false)
            .git_ignore(true)  // Respect .gitignore to skip typical dev artifacts
            .threads(8)
            .filter_entry(|entry| {
                // Skip common cache/temp directories
                let path_str = entry.path().to_string_lossy().to_lowercase();
                
                // Common Windows temp/cache patterns
                let skip_patterns = [
                    "\\appdata\\local\\temp\\",
                    "\\appdata\\local\\cache\\",
                    "\\windows\\temp\\",
                    "\\$recycle.bin\\",
                    "\\system volume information\\",
                    "\\node_modules\\",
                    "\\.git\\",
                    "\\.cache\\",
                    "\\__pycache__\\",
                    "\\.venv\\",
                    "\\.virtualenv\\",
                    "\\target\\debug\\",
                    "\\target\\release\\",
                    "\\.idea\\",
                    "\\.vs\\",
                    "\\obj\\",
                    "\\bin\\debug\\",
                    "\\bin\\release\\",
                ];
                
                !skip_patterns.iter().any(|pattern| path_str.contains(pattern))
            })
            .build_parallel();

        let file_list_clone = file_list.clone();
        let counter_clone = counter.clone();
        let app_for_walker = app_clone.clone();
        
        walker.run(move || {
            let file_list = file_list_clone.clone();
            let counter = counter_clone.clone();
            let app = app_for_walker.clone();
            
            Box::new(move |entry| {
                if let Ok(entry) = entry {
                    if entry.file_type().map_or(false, |ft| ft.is_file()) {
                        let path = entry.path().to_string_lossy().to_string();
                        file_list.lock().push(path);
                        
                        let mut count = counter.lock();
                        *count += 1;
                        if *count % 1000 == 0 {
                            app.emit("index-progress", *count).ok();
                        }
                    }
                }
                ignore::WalkState::Continue
            })
        });
        // Extract the final list from the Arc<Mutex>
        let final_list = match Arc::try_unwrap(file_list) {
            Ok(mutex) => mutex.into_inner(),
            Err(arc) => arc.lock().clone(),
        };
        
        let total = final_list.len();
        
        // Save to disk cache
        save_index_to_disk(&final_list).ok();
        
        // Update state
        *files.write() = final_list;
        *stats.write() = IndexStats {
            total_files: total,
            indexed: true,
            last_indexed: Some(chrono::Utc::now().to_rfc3339()),
        };
        
        app_clone.emit("index-complete", total).ok();
        total
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn search_index(
    query: String,
    state: tauri::State<'_, FileIndex>,
) -> Result<Vec<String>, String> {
    let files = state.files.read().clone(); // Clone to release lock immediately
    
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    
    // Move heavy computation to blocking thread
    tokio::task::spawn_blocking(move || {
        // Check if query looks like regex
        let is_regex = query.contains('\\') || query.contains('$') || query.contains('^') 
            || query.contains('[') || query.contains('(');
        
        let mut scored_results: Vec<(String, i64)> = if is_regex {
            // Regex mode - case insensitive by default
            let pattern = format!("(?i){}", query);
            let regex = Regex::new(&pattern).map_err(|e| e.to_string())?;
            files
                .par_iter()
                .filter_map(|path| {
                    if regex.is_match(path) || 
                       Path::new(path)
                           .file_name()
                           .map(|f| regex.is_match(&f.to_string_lossy()))
                           .unwrap_or(false) {
                        Some((path.clone(), 1_000_000))
                    } else {
                        None
                    }
                })
                .collect()
        } else {
            // Optimized fuzzy search
            let query_lower = query.to_lowercase();
            let query_bytes = query_lower.as_bytes();
            
            // Check if query has spaces - indicates path pattern search (e.g., "spring Application.java")
            let has_spaces = query.contains(' ');
            let query_parts: Vec<&str> = if has_spaces {
                query_lower.split_whitespace().collect()
            } else {
                vec![]
            };
            
            // Pre-create matcher once (reused across threads)
            let matcher = SkimMatcherV2::default()
                .ignore_case()
                .use_cache(true);
            
            files
                .par_iter()
                .filter_map(|path| {
                    let file_name = Path::new(path)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    
                    let file_name_lower = file_name.to_lowercase();
                    let path_lower = path.to_lowercase();
                    
                    // MULTI-PART PATH SEARCH: "spring Application.java"
                    if has_spaces && query_parts.len() >= 2 {
                        // Check if path contains all parts in order
                        let all_parts_in_path = query_parts.iter().all(|part| path_lower.contains(part));
                        
                        if all_parts_in_path {
                            // Calculate how well the path matches
                            let mut path_score = 300_000_000i64; // High score for multi-part matches
                            
                            // Get last part (assumed to be filename)
                            let last_part = query_parts.last().unwrap();
                            
                            // Bonus if filename matches the last part exactly
                            if file_name_lower == *last_part {
                                path_score += 200_000_000; // 500M total for exact filename in path pattern
                            } else if file_name_lower.contains(last_part) {
                                path_score += 100_000_000; // 400M for containing filename
                            }
                            
                            // Check if parts appear consecutively in path
                            let mut last_pos = 0;
                            let mut consecutive = true;
                            for part in &query_parts {
                                if let Some(pos) = path_lower[last_pos..].find(part) {
                                    last_pos += pos + part.len();
                                } else {
                                    consecutive = false;
                                    break;
                                }
                            }
                            
                            if consecutive {
                                path_score += 50_000_000; // Bonus for consecutive parts
                            }
                            
                            return Some((path.clone(), path_score));
                        }
                    }
                    
                    // EXACT FILENAME MATCHES (highest priority for single-word queries)
                    if file_name_lower == query_lower {
                        return Some((path.clone(), 1_000_000_000));
                    }
                    
                    // Check without extension
                    if let Some((name, _)) = file_name_lower.rsplit_once('.') {
                        if name == query_lower {
                            return Some((path.clone(), 900_000_000));
                        }
                    }
                    
                    // Fast substring check
                    if file_name_lower.contains(&query_lower) {
                        let mut score = 500_000_000i64;
                        
                        if file_name_lower.starts_with(&query_lower) {
                            score += 100_000_000;
                        }
                        
                        // Word boundary bonus
                        let words: Vec<&str> = file_name_lower
                            .split(|c: char| !c.is_alphanumeric())
                            .filter(|w| !w.is_empty())
                            .collect();
                        
                        if words.iter().any(|&w| w == query_lower.as_str()) {
                            score += 50_000_000;
                        }
                        
                        return Some((path.clone(), score));
                    }
                    
                    // Only do fuzzy matching if query is short enough (performance optimization)
                    if query.len() <= 50 && !has_spaces {
                        // Fuzzy match on filename only (skip full path for speed)
                        if let Some(fuzzy_score) = matcher.fuzzy_match(&file_name, &query) {
                            if fuzzy_score > 0 {
                                let capped_score = fuzzy_score.min(1_000_000);
                                return Some((path.clone(), capped_score));
                            }
                        }
                    }
                    
                    None
                })
                .collect()
        };
        
        // Sort by score descending, then alphabetically
        scored_results.par_sort_unstable_by(|a, b| {
            b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0))
        });
        
        // Return top 2000 results
        let results: Vec<String> = scored_results
            .into_iter()
            .take(2000)
            .map(|(path, _)| path)
            .collect();
        
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_index_stats(state: tauri::State<'_, FileIndex>) -> Result<IndexStats, String> {
    Ok(state.stats.read().clone())
}

#[tauri::command]
async fn open_file(path: String, app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(FileIndex::new())
        .invoke_handler(tauri::generate_handler![
            greet,
            init_index,
            build_index,
            search_index,
            get_index_stats,
            open_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
