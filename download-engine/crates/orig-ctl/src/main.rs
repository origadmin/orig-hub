//! orig-ctl —— orig-hub 下载内核的远程管理 CLI。
//!
//! 通过守护进程（orig-daemon）已有的 REST API 管理下载任务，适用于：
//! - Docker / 容器部署后从本机 SSH 或笔记本远程管控；
//! - 不想开桌面壳、只想用命令行增删/暂停/恢复下载。
//!
//! 鉴权：设 `ORIG_DAEMON_TOKEN`（与守护进程 `SURGE_TOKEN` 一致）即自动带 Bearer。
//! 地址：`ORIG_DAEMON_URL`（缺省 `http://127.0.0.1:19786`）。
//!
//! 仅依赖 `tokio`/`reqwest`/`serde_json`（与守护进程同源），无需额外下载。

use std::error::Error;

const USAGE: &str = r#"orig-ctl — remote control CLI for the orig-hub download daemon

Usage:
  orig-ctl [--url URL] [--token TOKEN] <command> [args]

Commands:
  health                       Show daemon health
  list                         List all downloads
  add <url> [--filename F] [--output DIR]
                               Add a download
  pause <id>                  Pause a download
  resume <id>                 Resume a download
  cancel <id>                 Cancel a download
  remove <id>                 Remove a download
  config                      Show daemon config
  watch                       Poll downloads every 2s

Env:
  ORIG_DAEMON_URL   daemon base URL (default http://127.0.0.1:19786)
  ORIG_DAEMON_TOKEN bearer token (required if the daemon enforces auth)
"#;

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().collect();

    let mut url =
        std::env::var("ORIG_DAEMON_URL").unwrap_or_else(|_| "http://127.0.0.1:19786".to_string());
    let mut token: Option<String> = std::env::var("ORIG_DAEMON_TOKEN").ok().filter(|s| !s.is_empty());

    // 解析全局 flag（--url / --token），定位子命令起点。
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--url" if i + 1 < args.len() => {
                url = args[i + 1].clone();
                i += 2;
            }
            "--token" if i + 1 < args.len() => {
                token = Some(args[i + 1].clone());
                i += 2;
            }
            _ => break,
        }
    }

    if i >= args.len() {
        eprint!("{USAGE}");
        std::process::exit(2);
    }
    let cmd = args[i].clone();
    let rest = args[i + 1..].to_vec();

    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(run(&cmd, &rest, &url, token.as_deref()))?;
    Ok(())
}

async fn run(
    cmd: &str,
    rest: &[String],
    base: &str,
    token: Option<&str>,
) -> Result<(), Box<dyn Error>> {
    let client = reqwest::Client::new();
    let base = base.trim_end_matches('/');

    match cmd {
        "health" => {
            let v = request(&client, token, base, "GET", "/health", None).await?;
            print_json(&v);
        }
        "list" => {
            let v = request(&client, token, base, "GET", "/api/downloads", None).await?;
            print_json(&v);
        }
        "add" => {
            if rest.is_empty() {
                return Err("add requires a <url>".into());
            }
            let url_arg = &rest[0];
            let mut filename: Option<String> = None;
            let mut output: Option<String> = None;
            let mut j = 1;
            while j < rest.len() {
                match rest[j].as_str() {
                    "--filename" if j + 1 < rest.len() => {
                        filename = Some(rest[j + 1].clone());
                        j += 2;
                    }
                    "--output" if j + 1 < rest.len() => {
                        output = Some(rest[j + 1].clone());
                        j += 2;
                    }
                    other => return Err(format!("unknown arg for add: {other}").into()),
                }
            }
            let mut body = serde_json::json!({ "url": url_arg });
            if let Some(f) = filename {
                body["filename"] = f.into();
            }
            if let Some(o) = output {
                body["output_path"] = o.into();
            }
            let v = request(&client, token, base, "POST", "/api/downloads", Some(&body)).await?;
            print_json(&v);
        }
        "pause" => act(&client, token, base, arg_id(rest)?.as_str(), "pause").await?,
        "resume" => act(&client, token, base, arg_id(rest)?.as_str(), "resume").await?,
        "cancel" => act(&client, token, base, arg_id(rest)?.as_str(), "cancel").await?,
        "remove" => {
            let id = arg_id(rest)?;
            let v = request(
                &client,
                token,
                base,
                "DELETE",
                &format!("/api/downloads/{}", enc(&id)),
                None,
            )
            .await?;
            print_json(&v);
        }
        "config" => {
            let v = request(&client, token, base, "GET", "/api/config", None).await?;
            print_json(&v);
        }
        "watch" => loop {
            match request(&client, token, base, "GET", "/api/downloads", None).await {
                Ok(v) => {
                    if let Some(arr) = v.as_array() {
                        for t in arr {
                            let id = t.get("id").and_then(|x| x.as_str()).unwrap_or("?");
                            let name = t.get("filename").and_then(|x| x.as_str()).unwrap_or("-");
                            let st = t.get("status").and_then(|x| x.as_str()).unwrap_or("?");
                            let pct = t
                                .get("progress")
                                .and_then(|x| x.get("percent"))
                                .and_then(|x| x.as_f64())
                                .unwrap_or(0.0);
                            println!("[{pct:5.1}%] {st:<10} {id:<28} {name}");
                        }
                    }
                    println!("---");
                }
                Err(e) => eprintln!("watch error: {e}"),
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        },
        other => {
            eprintln!("unknown command: {other}\n");
            eprint!("{USAGE}");
            std::process::exit(2);
        }
    }
    Ok(())
}

/// Generic JSON request against the daemon API.
async fn request(
    client: &reqwest::Client,
    auth: Option<&str>,
    base: &str,
    method: &str,
    path: &str,
    body: Option<&serde_json::Value>,
) -> Result<serde_json::Value, Box<dyn Error>> {
    let mut req = client.request(
        reqwest::Method::from_bytes(method.as_bytes())?,
        format!("{base}{path}"),
    );
    if let Some(t) = auth {
        req = req.bearer_auth(t);
    }
    if let Some(b) = body {
        req = req
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(serde_json::to_string(b)?);
    }
    let resp = req.send().await?;
    let status = resp.status();
    let text = resp.text().await?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {text}").into());
    }
    if text.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    Ok(serde_json::from_str(&text)?)
}

/// POST /api/downloads/:id?action=<a>
async fn act(
    client: &reqwest::Client,
    auth: Option<&str>,
    base: &str,
    id: &str,
    action: &str,
) -> Result<(), Box<dyn Error>> {
    let path = format!("/api/downloads/{}?action={}", enc(id), action);
    let v = request(client, auth, base, "POST", &path, None).await?;
    print_json(&v);
    Ok(())
}

/// 取子命令后的首个位置参数作为 id。
fn arg_id(rest: &[String]) -> Result<String, Box<dyn Error>> {
    rest.first()
        .cloned()
        .ok_or_else(|| "missing <id> argument".into())
}

/// 最小百分号编码（download id 可能是 URL，必须编码）。
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' =>
                out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// 美化打印 JSON，非 JSON 时退回原始文本。
fn print_json(v: &serde_json::Value) {
    match serde_json::to_string_pretty(v) {
        Ok(s) => println!("{s}"),
        Err(_) => println!("{v}"),
    }
}
