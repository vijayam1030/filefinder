use actix_web::{web, App, HttpResponse, HttpServer, middleware};
use actix_cors::Cors;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use parking_lot::RwLock;
use tauri_app_lib::{FileIndex, IndexStats, build_index_sync, search_index_sync};

#[derive(Deserialize)]
struct BuildIndexRequest {
    root_path: String,
    force_rebuild: Option<bool>,
}

#[derive(Deserialize)]
struct SearchRequest {
    query: String,
}

#[derive(Serialize)]
struct SearchResponse {
    results: Vec<String>,
    search_time: f64,
    total_matches: usize,
}

// Build index endpoint
async fn build_index(
    data: web::Json<BuildIndexRequest>,
    state: web::Data<Arc<RwLock<FileIndex>>>,
) -> HttpResponse {
    let root_path = data.root_path.clone();
    let force_rebuild = data.force_rebuild.unwrap_or(false);
    
    let state_clone = state.clone();
    
    // Run in blocking thread
    let result = web::block(move || {
        build_index_sync(root_path, state_clone, force_rebuild)
    }).await;
    
    match result {
        Ok(Ok(total)) => {
            let stats = state.read().stats.read().clone();
            HttpResponse::Ok().json(stats)
        }
        Ok(Err(e)) => HttpResponse::InternalServerError().json(serde_json::json!({
            "error": e
        })),
        Err(e) => HttpResponse::InternalServerError().json(serde_json::json!({
            "error": e.to_string()
        })),
    }
}

// Search endpoint
async fn search(
    data: web::Json<SearchRequest>,
    state: web::Data<Arc<RwLock<FileIndex>>>,
) -> HttpResponse {
    let query = data.query.clone();
    
    if query.trim().is_empty() {
        return HttpResponse::Ok().json(SearchResponse {
            results: vec![],
            search_time: 0.0,
            total_matches: 0,
        });
    }
    
    let state_clone = state.clone();
    let start = std::time::Instant::now();
    
    let result = web::block(move || {
        search_index_sync(query, state_clone)
    }).await;
    
    let search_time = start.elapsed().as_millis() as f64;
    
    match result {
        Ok(Ok(results)) => {
            let total_matches = results.len();
            HttpResponse::Ok().json(SearchResponse {
                results,
                search_time,
                total_matches,
            })
        }
        Ok(Err(e)) => HttpResponse::InternalServerError().json(serde_json::json!({
            "error": e
        })),
        Err(e) => HttpResponse::InternalServerError().json(serde_json::json!({
            "error": e.to_string()
        })),
    }
}

// Get stats endpoint
async fn get_stats(state: web::Data<Arc<RwLock<FileIndex>>>) -> HttpResponse {
    let stats = state.read().stats.read().clone();
    HttpResponse::Ok().json(stats)
}

// Health check
async fn health() -> HttpResponse {
    HttpResponse::Ok().json(serde_json::json!({
        "status": "ok"
    }))
}

// Serve static files (React build)
async fn serve_index() -> HttpResponse {
    HttpResponse::Ok()
        .content_type("text/html")
        .body(include_str!("../../dist/index.html"))
}

pub async fn run_web_server() -> std::io::Result<()> {
    let file_index = Arc::new(RwLock::new(FileIndex::new()));
    
    println!("🚀 Antigravity Search Server starting...");
    println!("📂 Open your browser to: http://localhost:3030");
    
    // Auto-open browser
    if let Err(e) = open::that("http://localhost:3030") {
        eprintln!("Failed to open browser: {}", e);
    }
    
    HttpServer::new(move || {
        let cors = Cors::default()
            .allow_any_origin()
            .allow_any_method()
            .allow_any_header();
        
        App::new()
            .wrap(cors)
            .wrap(middleware::Logger::default())
            .app_data(web::Data::new(file_index.clone()))
            .route("/health", web::get().to(health))
            .route("/api/build-index", web::post().to(build_index))
            .route("/api/search", web::post().to(search))
            .route("/api/index-stats", web::get().to(get_stats))
            // Serve static frontend files
            .service(actix_files::Files::new("/assets", "./dist/assets"))
            .default_service(web::get().to(serve_index))
    })
    .bind("127.0.0.1:3030")?
    .run()
    .await
}
