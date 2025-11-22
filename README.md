# Antigravity Search - Super Fast File Finder

## Architecture
This app uses **Tauri** (Rust + React) to achieve maximum performance.
- **Backend (Rust)**: Uses the `ignore` crate (same engine as `ripgrep`) to traverse the file system in parallel. It compiles Regex queries and filters files at system speed.
- **Frontend (React)**: A lightweight, dark-mode UI that debounces inputs and displays results instantly.

## How to Run
1. Ensure you have **Rust** and **Node.js** installed.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the development server:
   ```bash
   npm run tauri dev
   ```

## Features
- **Regex Support**: Search with full regex capabilities (e.g., `^test.*\.txt$`).
- **Parallel Crawling**: Uses all available CPU threads to crawl directories.
- **Safety**: Limits results to 2000 to prevent UI freezing.

## Troubleshooting
- If you see `windres` errors, ensure you have the **C++ Build Tools** installed via Visual Studio Installer, or that `rc.exe` is in your PATH.
