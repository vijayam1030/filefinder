use ignore::WalkBuilder;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use parking_lot::RwLock;
use tauri::Emitter;

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
    let files = state.files.read();
    
    // Check if query looks like regex (contains regex special chars)
    let is_regex = query.contains('\\') || query.contains('$') || query.contains('^') 
        || query.contains('[') || query.contains('(') || query.contains('.');
    
    let mut scored_results: Vec<(String, i32)> = if is_regex {
        // Regex mode
        let regex = Regex::new(&query).map_err(|e| e.to_string())?;
        files
            .iter()
            .filter(|path| {
                if let Some(file_name) = Path::new(path).file_name() {
                    regex.is_match(&file_name.to_string_lossy())
                } else {
                    false
                }
            })
            .map(|path| (path.clone(), 100)) // All regex matches get same score
            .collect()
    } else {
        // Smart word-based search
        let search_words: Vec<String> = query
            .split_whitespace()
            .map(|s| s.to_lowercase())
            .collect();
        
        if search_words.is_empty() {
            return Ok(Vec::new());
        }
        
        files
            .iter()
            .filter_map(|path| {
                let path_lower = path.to_lowercase();
                let file_name = Path::new(path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                
                // Create concatenated version (e.g., "hello world" -> "helloworld")
                let concatenated = search_words.join("");
                
                // Check if all words are present in the path OR concatenated form exists
                let all_words_present = search_words.iter().all(|word| path_lower.contains(word))
                    || path_lower.contains(&concatenated);
                
                if !all_words_present {
                    return None;
                }
                
                // Score the match
                let mut score = 0;
                
                // Check for concatenated match in filename (very high priority)
                if file_name.contains(&concatenated) {
                    score += 1500; // Higher than individual words
                    
                    // Extra bonus if filename IS the concatenated word
                    if file_name.starts_with(&concatenated) {
                        score += 300;
                    }
                }
                
                // Priority 1: All words in filename (highest priority)
                let all_in_filename = search_words.iter().all(|word| file_name.contains(word));
                if all_in_filename {
                    score += 1000;
                    
                    // Bonus: Words appear in order
                    let joined = search_words.join(" ");
                    if file_name.contains(&joined) {
                        score += 500; // Exact phrase match
                    }
                    
                    // Bonus: Filename starts with first word
                    if file_name.starts_with(&search_words[0]) {
                        score += 200;
                    }
                }
                
                // Priority 2: Words appear in path components (folder structure)
                let path_components: Vec<String> = Path::new(path)
                    .components()
                    .filter_map(|c| {
                        if let std::path::Component::Normal(os_str) = c {
                            Some(os_str.to_string_lossy().to_lowercase())
                        } else {
                            None
                        }
                    })
                    .collect();
                
                // Check if consecutive path components match consecutive search words
                for i in 0..path_components.len() {
                    for j in 0..search_words.len() {
                        if i + j < path_components.len() 
                           && path_components[i + j].contains(&search_words[j]) {
                            score += 100; // Words in path structure
                        }
                    }
                }
                
                // Bonus for exact component matches
                for word in &search_words {
                    for component in &path_components {
                        if component == word {
                            score += 150; // Exact folder/file name match
                        }
                    }
                }
                
                // Only return if we have a positive score
                if score > 0 {
                    Some((path.clone(), score))
                } else {
                    None
                }
            })
            .collect()
    };
    
    // Sort by score (descending), then alphabetically
    scored_results.sort_by(|a, b| {
        b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0))
    });
    
    // Return top 2000 results
    let results: Vec<String> = scored_results
        .into_iter()
        .take(2000)
        .map(|(path, _)| path)
        .collect();
    
    Ok(results)
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
