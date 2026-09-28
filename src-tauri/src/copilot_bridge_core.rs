use reqwest::{redirect::Policy, Client, Url};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub(crate) const EXTENSION_ID: &str = "pluely.pluely-copilot-bridge";
const EXTENSION_MANIFEST: &str = include_str!("../../vscode-bridge/package.json");
const EXTENSION_SOURCE: &str = include_str!("../../vscode-bridge/extension.js");

#[derive(Deserialize, Serialize)]
pub struct BridgeConnection {
    base_url: String,
    token: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct BridgeModel {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    family: String,
    #[serde(default)]
    supports_images: bool,
}

#[derive(Default, Deserialize)]
struct Capabilities {
    #[serde(default)]
    images: bool,
    #[serde(default)]
    cancellation: bool,
}

#[derive(Deserialize)]
struct Health {
    ok: bool,
    copilot_available: bool,
    consented: Option<bool>,
    #[serde(default)]
    models: Vec<String>,
    #[serde(default)]
    model_details: Vec<BridgeModel>,
    #[serde(default)]
    default_model: String,
    #[serde(default)]
    capabilities: Capabilities,
}

#[derive(Serialize)]
pub struct BridgeStatus {
    source: String,
    pub(crate) ready: bool,
    pub(crate) message: String,
    models: Vec<BridgeModel>,
    default_model: String,
    supports_images: bool,
    supports_cancellation: bool,
}

fn validate_connection(connection: &BridgeConnection) -> Result<(), String> {
    let url = Url::parse(&connection.base_url)
        .map_err(|_| "The bridge handshake contains an invalid address.".to_string())?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("The bridge must use an HTTP address on 127.0.0.1 with an explicit port.".into());
    }
    if connection.token.len() < 32
        || connection.token.len() > 256
        || !connection.token.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err("The bridge handshake contains an invalid session token.".into());
    }
    Ok(())
}

fn read_connection(path: &Path) -> Result<BridgeConnection, String> {
    let file = fs::File::open(path).map_err(|error| format!("Cannot read handshake: {error}"))?;
    let mut contents = String::new();
    file.take(16_385)
        .read_to_string(&mut contents)
        .map_err(|error| format!("Cannot read handshake: {error}"))?;
    if contents.len() > 16_384 {
        return Err("Bridge handshake is too large.".into());
    }
    let connection: BridgeConnection = serde_json::from_str(&contents)
        .map_err(|_| "Bridge handshake is not valid connection JSON.".to_string())?;
    validate_connection(&connection)?;
    Ok(connection)
}

fn candidates(home: &Path) -> Result<Vec<(PathBuf, &'static str)>, String> {
    let mut paths = Vec::new();
    let directory = home.join(".pluely").join("bridges");
    match fs::read_dir(&directory) {
        Ok(entries) => {
            let mut own = Vec::new();
            for entry in entries {
                let entry = entry.map_err(|error| format!("Cannot list Pluely bridges: {error}"))?;
                let path = entry.path();
                if path.extension().is_some_and(|extension| extension == "json") {
                    let modified = entry
                        .metadata()
                        .and_then(|metadata| metadata.modified())
                        .map_err(|error| format!("Cannot inspect Pluely handshake: {error}"))?;
                    own.push((modified, path));
                }
            }
            own.sort_by(|a, b| b.0.cmp(&a.0));
            paths.extend(own.into_iter().map(|(_, path)| (path, "Pluely")));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Cannot discover Pluely bridges: {error}")),
    }
    paths.push((home.join(".clipdesk").join("bridge.json"), "ClipDesk"));
    paths.push((home.join(".dotpml").join("bridge.json"), "DotPML"));
    Ok(paths)
}

fn status_from_health(health: Health, source: &str) -> BridgeStatus {
    let models = if health.model_details.is_empty() {
        health
            .models
            .into_iter()
            .map(|id| BridgeModel {
                name: id.clone(),
                id,
                family: String::new(),
                supports_images: false,
            })
            .collect()
    } else {
        health.model_details
    };
    let available = health.ok && health.copilot_available && !models.is_empty();
    let authorized = if source == "Pluely" {
        health.consented == Some(true)
    } else {
        health.consented != Some(false)
    };
    let ready = available && authorized;
    let message = if !available {
        "Sign in to GitHub Copilot in VS Code and enable a chat model.".to_string()
    } else if !ready {
        format!("Authorize Copilot access for the {source} bridge in VS Code.")
    } else {
        format!("Connected to the {source} bridge. VS Code can stay minimized.")
    };
    BridgeStatus {
        source: source.into(),
        ready,
        message,
        models,
        default_model: health.default_model,
        supports_images: health.capabilities.images,
        supports_cancellation: health.capabilities.cancellation,
    }
}

async fn probe(client: &Client, connection: &BridgeConnection) -> Result<Health, String> {
    let mut response = client
        .get(format!("{}/health", connection.base_url.trim_end_matches('/')))
        .bearer_auth(&connection.token)
        .send()
        .await
        .map_err(|error| format!("Bridge is not responding: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Bridge health check returned HTTP {}.", response.status()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Cannot read bridge health: {error}"))?
    {
        if bytes.len() + chunk.len() > 1_048_576 {
            return Err("Bridge health response is too large.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "The local service did not return a compatible bridge health response.".into())
}

pub(crate) async fn discover(home: &Path) -> Result<(BridgeConnection, BridgeStatus), String> {
    let client = Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|error| format!("Cannot create bridge client: {error}"))?;
    let mut unavailable = None;
    let mut errors = Vec::new();
    for (path, source) in candidates(home)? {
        if !path.try_exists().map_err(|error| format!("Cannot inspect handshake: {error}"))? {
            continue;
        }
        let connection = match read_connection(&path) {
            Ok(connection) => connection,
            Err(error) => {
                errors.push(format!("{source}: {error}"));
                continue;
            }
        };
        match probe(&client, &connection).await {
            Ok(health) => {
                let status = status_from_health(health, source);
                if status.ready {
                    return Ok((connection, status));
                }
                if unavailable.is_none() {
                    unavailable = Some((connection, status));
                }
            }
            Err(error) => errors.push(format!("{source}: {error}")),
        }
    }
    if let Some(result) = unavailable {
        return Ok(result);
    }
    let detail = if errors.is_empty() {
        String::new()
    } else {
        format!(" {}", errors.join(" "))
    };
    Err(format!(
        "Copilot bridge is not connected. Open Dev Space > AI Providers to set up the bridge, \
         then keep VS Code running and signed in to Copilot.{detail}"
    ))
}

pub(crate) fn editor_directory(editor: &str) -> Result<&'static str, String> {
    match editor {
        "vscode" => Ok(".vscode"),
        "vscode-insiders" => Ok(".vscode-insiders"),
        _ => Err("Choose VS Code or VS Code Insiders.".into()),
    }
}

pub(crate) fn install_in_home(home: &Path, editor: &str) -> Result<String, String> {
    let extensions = home
        .join(editor_directory(editor)?)
        .join("extensions");
    if !extensions.is_dir() {
        return Err("Install and open the selected VS Code edition first, then retry. \
            This installer uses its standard user extensions directory."
            .into());
    }
    let manifest: serde_json::Value = serde_json::from_str(EXTENSION_MANIFEST)
        .map_err(|error| format!("Invalid bundled bridge manifest: {error}"))?;
    let version = manifest["version"]
        .as_str()
        .ok_or("The bundled bridge has no version.")?;
    let target = extensions.join(format!("{EXTENSION_ID}-{version}"));
    fs::create_dir_all(&target)
        .map_err(|error| format!("Cannot create bridge extension directory: {error}"))?;
    for (name, contents) in [
        ("package.json", EXTENSION_MANIFEST),
        ("extension.js", EXTENSION_SOURCE),
    ] {
        fs::write(target.join(name), contents)
            .map_err(|error| format!("Cannot install bridge {name}: {error}"))?;
    }
    Ok("Bridge installed. Reload your VS Code window once (Developer: Reload Window), \
        then click Authorize in VS Code below."
        .into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct TestHome(PathBuf);

    impl TestHome {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("pluely-bridge-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).expect("clean up the test's temporary profile");
        }
    }

    #[test]
    fn only_explicit_loopback_addresses_are_accepted() {
        for base_url in [
            "https://127.0.0.1:8791",
            "http://example.com:8791",
            "http://127.0.0.1",
            "http://user@127.0.0.1:8791",
            "http://127.0.0.1:8791/other",
            "http://127.0.0.1:8791?redirect=1",
            "http://127.0.0.1:8791#fragment",
        ] {
            assert!(validate_connection(&BridgeConnection {
                base_url: base_url.into(),
                token: "a".repeat(64),
            })
            .is_err());
        }
        assert!(validate_connection(&BridgeConnection {
            base_url: "http://127.0.0.1:8791".into(),
            token: "a".repeat(64),
        })
        .is_ok());
    }

    #[test]
    fn legacy_bridges_are_text_only_and_preserve_model_ids() {
        let health: Health = serde_json::from_value(serde_json::json!({
            "ok": true, "copilot_available": true,
            "models": ["model-id"], "default_model": "model-id"
        }))
        .unwrap();
        let status = status_from_health(health, "DotPML");
        assert!(status.ready);
        assert!(!status.supports_images);
        assert_eq!(status.models[0].id, "model-id");
        assert!(!status.models[0].supports_images);
    }

    #[test]
    fn models_do_not_imply_consent() {
        for consent in [None, Some(false), Some(true)] {
            let health: Health = serde_json::from_value(serde_json::json!({
                "ok": true, "copilot_available": true, "consented": consent,
                "models": ["model-id"]
            }))
            .unwrap();
            assert_eq!(status_from_health(health, "Pluely").ready, consent == Some(true));
        }
    }

    #[test]
    fn arbitrary_editor_paths_are_rejected() {
        assert!(editor_directory("vscode").is_ok());
        assert!(editor_directory("vscode-insiders").is_ok());
        assert!(editor_directory("../other").is_err());
    }

    #[test]
    fn installer_uses_the_current_profile_and_bundled_files() {
        let home = TestHome::new();
        assert!(install_in_home(&home.0, "vscode").is_err());
        let extensions = home.0.join(".vscode").join("extensions");
        fs::create_dir_all(&extensions).unwrap();
        install_in_home(&home.0, "vscode").unwrap();
        let manifest: serde_json::Value = serde_json::from_str(EXTENSION_MANIFEST).unwrap();
        let target = extensions.join(format!(
            "{EXTENSION_ID}-{}",
            manifest["version"].as_str().unwrap()
        ));
        assert_eq!(fs::read_to_string(target.join("extension.js")).unwrap(), EXTENSION_SOURCE);
        assert_eq!(fs::read_to_string(target.join("package.json")).unwrap(), EXTENSION_MANIFEST);
        install_in_home(&home.0, "vscode").unwrap();
    }

    #[tokio::test]
    async fn discovery_skips_invalid_handshakes_and_checks_a_legacy_bridge() {
        let home = TestHome::new();
        let own = home.0.join(".pluely").join("bridges");
        fs::create_dir_all(&own).unwrap();
        fs::write(own.join("1.json"), "not a handshake").unwrap();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let token = "b".repeat(64);
        let expected_authorization = format!("authorization: bearer {token}");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut buffer = [0; 1024];
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
                if request.windows(4).any(|part| part == b"\r\n\r\n") {
                    break;
                }
            }
            let request = String::from_utf8(request).unwrap().to_ascii_lowercase();
            assert!(request.starts_with("get /health "));
            assert!(request.contains(&expected_authorization));
            let body = r#"{"ok":true,"copilot_available":true,"consented":true,"models":["copilot-id"]}"#;
            socket.write_all(format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            ).as_bytes()).await.unwrap();
        });

        let legacy = home.0.join(".clipdesk");
        fs::create_dir(&legacy).unwrap();
        fs::write(legacy.join("bridge.json"), serde_json::to_vec(&serde_json::json!({
            "base_url": format!("http://127.0.0.1:{port}"), "token": token
        })).unwrap()).unwrap();
        let (connection, status) = discover(&home.0).await.unwrap();
        assert_eq!(connection.base_url, format!("http://127.0.0.1:{port}"));
        assert_eq!(status.source, "ClipDesk");
        assert!(status.ready);
        assert!(!status.supports_images);
        assert_eq!(status.models[0].id, "copilot-id");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn a_new_machine_gets_actionable_setup_instead_of_a_cloud_fallback() {
        let home = TestHome::new();
        let error = discover(&home.0).await.err().unwrap();
        assert!(error.contains("Dev Space > AI Providers"));
        assert!(error.contains("keep VS Code running"));
    }
}
