use tauri_app_lib::web_server;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    web_server::run_web_server().await
}
