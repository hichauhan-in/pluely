use crate::copilot_bridge_core::{
    discover, editor_directory, install_in_home, BridgeConnection, BridgeStatus, EXTENSION_ID,
};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

fn home_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .home_dir()
        .map_err(|error| format!("Cannot locate this machine's user profile: {error}"))
}

#[tauri::command]
pub async fn copilot_bridge_status(app: AppHandle) -> Result<BridgeStatus, String> {
    let (_, status) = discover(&home_directory(&app)?).await?;
    Ok(status)
}

#[derive(Serialize)]
pub struct ConnectedBridge {
    connection: BridgeConnection,
    status: BridgeStatus,
}

#[tauri::command]
pub async fn connect_copilot_bridge(app: AppHandle) -> Result<ConnectedBridge, String> {
    let (connection, status) = discover(&home_directory(&app)?).await?;
    if !status.ready {
        return Err(status.message);
    }
    Ok(ConnectedBridge { connection, status })
}

#[tauri::command]
pub async fn install_copilot_bridge(app: AppHandle, editor: String) -> Result<String, String> {
    install_in_home(&home_directory(&app)?, &editor)
}

#[tauri::command]
pub fn open_copilot_bridge(app: AppHandle, editor: String) -> Result<(), String> {
    editor_directory(&editor)?;
    app.opener()
        .open_url(format!("{editor}://{EXTENSION_ID}/setup"), None::<&str>)
        .map_err(|error| format!("Cannot open VS Code bridge setup: {error}"))
}
