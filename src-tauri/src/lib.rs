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

// Get cache file path
fn get_cache_path() -> PathBuf {
    let cache_dir = dirs::cache_dir().unwrap_or_else(|| PathBuf::from("."));
    cache_dir.join("filefinder").join("index.bin")
}

// Save index to disk
fn save_index_to_disk(files: &[String]) -> Result<(), String> {
    let cache_path = get_cache_path();
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    
    let encoded = bincode::serialize(files).map_err(|e| e.to_string())?;
    fs::write(&cache_path, encoded).map_err(|e| e.to_string())?;
    Ok(())
}

// Load index from disk
fn load_index_from_disk() -> Result<Vec<String>, String> {
    let cache_path = get_cache_path();
    if !cache_path.exists() {
        return Err("Cache file not found".to_string());
    }
    
    let data = fs::read(&cache_path).map_err(|e| e.to_string())?;
    bincode::deserialize(&data).map_err(|e| e.to_string())
}

#[tauri::command]
async fn build_index(
    root_path: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, FileIndex>,
) -> Result<usize, String> {
    // Try to load from cache first
    if let Ok(cached_files) = load_index_from_disk() {
        let count = cached_files.len();
        *state.files.write() = cached_files;
        *state.stats.write() = IndexStats {
            total_files: count,
            indexed: true,
            last_indexed: Some(chrono::Utc::now().to_rfc3339()),
        };
        app.emit("index-progress", count).ok();
        return Ok(count);
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
            .git_ignore(false)
            .threads(8)
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
    let regex = Regex::new(&query).map_err(|e| e.to_string())?;
    let files = state.files.read();
    
    let results: Vec<String> = files
        .iter()
        .filter(|path| {
            if let Some(file_name) = Path::new(path).file_name() {
                regex.is_match(&file_name.to_string_lossy())
            } else {
                false
            }
        })
        .take(2000)
        .cloned()
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
            build_index,
            search_index,
            get_index_stats,
            open_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
