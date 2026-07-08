//! Integration tests for the database backup/restore API.
//!
//! Env vars are process-global and `build_state` mutates DATABASE_URL /
//! WF_SECRET_FILE, so each test holds `ENV_LOCK` for its whole body. The
//! restore handler also reads `WF_RESTART_ON_RESTORE` at request time — holding
//! the lock guarantees it stays `false` (so the test process never exits).

use std::net::SocketAddr;

use argon2::{password_hash::SaltString, Argon2, PasswordHasher};
use axum::{
    body::{to_bytes, Body},
    extract::ConnectInfo,
    http::{header, Method, Request},
    Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rand::{rngs::OsRng, RngCore};
use tempfile::TempDir;
use tower::ServiceExt;
use wealthfolio_server::{api::app_router, build_state, config::Config};

static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Build a router backed by a fresh temp data dir. The returned `TempDir` MUST
/// be kept alive for the test — the server writes backups into it. Call while
/// holding `ENV_LOCK`.
async fn build_router_with_data_dir(password: &str) -> (Router, TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    std::env::set_var("WF_DB_PATH", tmp.path().join("test.db"));
    std::env::set_var("WF_SECRET_FILE", tmp.path().join("secrets.json"));

    let salt = SaltString::generate(&mut OsRng);
    let password_hash = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .unwrap()
        .to_string();
    std::env::set_var("WF_AUTH_PASSWORD_HASH", password_hash);

    let mut secret_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut secret_bytes);
    std::env::set_var("WF_SECRET_KEY", BASE64.encode(secret_bytes));
    std::env::set_var("WF_CORS_ALLOW_ORIGINS", "http://localhost:3000");
    // Never exit the test process on restore.
    std::env::set_var("WF_RESTART_ON_RESTORE", "false");

    let config = Config::from_env();
    let state = build_state(&config).await.unwrap();
    (app_router(state, &config), tmp)
}

fn cleanup_env() {
    for key in [
        "WF_DB_PATH",
        "WF_SECRET_FILE",
        "WF_AUTH_PASSWORD_HASH",
        "WF_SECRET_KEY",
        "WF_CORS_ALLOW_ORIGINS",
        "WF_RESTART_ON_RESTORE",
    ] {
        std::env::remove_var(key);
    }
}

/// Add the peer-IP ConnectInfo the rate limiter needs on governed routes.
fn with_connect_info(mut req: Request<Body>) -> Request<Body> {
    req.extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 0))));
    req
}

async fn login(app: &Router, password: &str) -> String {
    let body = serde_json::json!({ "password": password }).to_string();
    let req = with_connect_info(
        Request::builder()
            .method(Method::POST)
            .uri("/api/v1/auth/login")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap(),
    );
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), 200, "login should succeed");
    let set_cookie = res
        .headers()
        .get(header::SET_COOKIE)
        .expect("login should set a cookie")
        .to_str()
        .unwrap()
        .to_owned();
    set_cookie
        .split(';')
        .next()
        .unwrap()
        .trim_start_matches("wf_session=")
        .to_string()
}

async fn list_backups(app: &Router, cookie: &str) -> Vec<serde_json::Value> {
    let req = Request::builder()
        .uri("/api/v1/utilities/database/backups")
        .header(header::COOKIE, format!("wf_session={cookie}"))
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), 200);
    let bytes = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn backup_then_restore_from_server_backup() {
    let _guard = ENV_LOCK.lock().await;
    let password = "super-secret";
    let (app, _tmp) = build_router_with_data_dir(password).await;
    let cookie = login(&app, password).await;

    // Create a backup.
    let backup_req = with_connect_info(
        Request::builder()
            .method(Method::POST)
            .uri("/api/v1/utilities/database/backup")
            .header(header::COOKIE, format!("wf_session={cookie}"))
            .body(Body::empty())
            .unwrap(),
    );
    let backup_res = app.clone().oneshot(backup_req).await.unwrap();
    assert_eq!(backup_res.status(), 200);
    let backup_bytes = to_bytes(backup_res.into_body(), usize::MAX).await.unwrap();
    let backup_json: serde_json::Value = serde_json::from_slice(&backup_bytes).unwrap();
    let filename = backup_json["filename"].as_str().unwrap().to_string();

    // It shows up in the list.
    let before = list_backups(&app, &cookie).await;
    assert!(
        before.iter().any(|b| b["filename"] == filename),
        "created backup should be listed"
    );

    // Restore from it.
    let restore_body = serde_json::json!({ "filename": filename }).to_string();
    let restore_req = with_connect_info(
        Request::builder()
            .method(Method::POST)
            .uri("/api/v1/utilities/database/restore")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, format!("wf_session={cookie}"))
            .body(Body::from(restore_body))
            .unwrap(),
    );
    let restore_res = app.clone().oneshot(restore_req).await.unwrap();
    let restore_status = restore_res.status();
    let restore_bytes = to_bytes(restore_res.into_body(), usize::MAX).await.unwrap();
    assert_eq!(
        restore_status,
        200,
        "restore should succeed, got {}: {}",
        restore_status,
        String::from_utf8_lossy(&restore_bytes)
    );
    let restore_json: serde_json::Value = serde_json::from_slice(&restore_bytes).unwrap();
    assert_eq!(restore_json["restarting"], false);
    let safety_backup = restore_json["safetyBackup"].as_str().unwrap_or_default();
    assert!(
        !safety_backup.is_empty(),
        "a pre-restore safety backup should be created"
    );

    // The pre-restore safety backup is a real, listed backup the user can roll
    // back to. (Backup filenames are second-granular, so a same-second restore
    // may reuse the original's name — assert it's listed rather than counting.)
    let after = list_backups(&app, &cookie).await;
    assert!(
        after.iter().any(|b| b["filename"] == safety_backup),
        "the pre-restore safety backup should appear in the backups list"
    );

    cleanup_env();
}

#[tokio::test]
async fn restore_requires_auth() {
    let _guard = ENV_LOCK.lock().await;
    let password = "another-secret";
    let (app, _tmp) = build_router_with_data_dir(password).await;

    let body =
        serde_json::json!({ "filename": "wealthfolio_backup_20260514_150409.db" }).to_string();
    let req = with_connect_info(
        Request::builder()
            .method(Method::POST)
            .uri("/api/v1/utilities/database/restore")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap(),
    );
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), 401, "restore must require authentication");

    cleanup_env();
}

#[tokio::test]
async fn restore_rejects_path_traversal_filename() {
    let _guard = ENV_LOCK.lock().await;
    let password = "yet-another-secret";
    let (app, _tmp) = build_router_with_data_dir(password).await;
    let cookie = login(&app, password).await;

    let body =
        serde_json::json!({ "filename": "../wealthfolio_backup_20260514_150409.db" }).to_string();
    let req = with_connect_info(
        Request::builder()
            .method(Method::POST)
            .uri("/api/v1/utilities/database/restore")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, format!("wf_session={cookie}"))
            .body(Body::from(body))
            .unwrap(),
    );
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(
        res.status(),
        400,
        "traversal filename must be rejected as a bad request"
    );

    cleanup_env();
}
