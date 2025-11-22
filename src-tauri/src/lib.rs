use ignore::WalkBuilder;
use regex::Regex;
use std::sync::{Arc, Mutex};

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn search_files(query: String, root_path: String) -> Result<Vec<String>, String> {
    // Compile the regex
    let regex = Regex::new(&query).map_err(|e| e.to_string())?;
    
    // Thread-safe container for results
    let results = Arc::new(Mutex::new(Vec::new()));
    let results_clone = results.clone();
    
    // Use ignore crate for fast, parallel traversal
    let walker = WalkBuilder::new(&root_path)
        .hidden(false) // Search hidden files too? Maybe make this configurable later
        .git_ignore(false) // Don't respect .gitignore for a general file searcher
        .threads(8) // Use 8 threads (or system default)
        .build_parallel();

    walker.run(move || {
        let results = results_clone.clone();
        let regex = regex.clone();
        Box::new(move |entry| {
            if let Ok(entry) = entry {
                if entry.file_type().map_or(false, |ft| ft.is_file()) {
                    let file_name = entry.file_name().to_string_lossy();
                    if regex.is_match(&file_name) {
                        let mut lock = results.lock().unwrap();
                        if lock.len() < 2000 { // Limit to 2000 results to prevent UI freeze
                            lock.push(entry.path().to_string_lossy().to_string());
                        } else {
                            return ignore::WalkState::Quit;
                        }
                    }
                }
            }
            ignore::WalkState::Continue
        })
    });

    let final_results = Arc::try_unwrap(results)
        .map_err(|_| "Failed to unwrap Arc".to_string())?
        .into_inner()
        .map_err(|_| "Failed to lock Mutex".to_string())?;
        
    Ok(final_results)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, search_files])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
