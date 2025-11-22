fn main() {
    // Force tauri-build to skip bundling Windows resources if it's failing
    // This is a temporary workaround to get the app running
    // println!("cargo:rustc-env=TAURI_SKIP_DEVSIGN=true"); 
    
    tauri_build::build()
}
