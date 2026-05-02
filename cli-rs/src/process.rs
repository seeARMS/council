use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::time::timeout;

const SIGKILL_GRACE_MS: u64 = 2_000;

#[derive(Debug, Clone)]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub timed_out: bool,
    pub spawn_error: Option<String>,
    pub interruption: Option<Interruption>,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone)]
pub struct Interruption {
    pub kind: String,
    pub status: String,
    pub detail: String,
}

pub struct RunOptions {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: std::collections::HashMap<String, String>,
    pub stdin_text: String,
    pub timeout_ms: u64,
    pub interrupt_when: Option<Box<dyn Fn(&str, &str) -> Option<Interruption> + Send + Sync>>,
    pub on_chunk: Option<Box<dyn Fn(ChunkContext) + Send + Sync>>,
}

pub struct ChunkContext {
    pub source: &'static str,
    pub chunk: String,
    pub stdout: String,
    pub stderr: String,
}

pub async fn run_command(opts: RunOptions) -> CommandResult {
    let mut cmd = Command::new(&opts.command);
    cmd.args(&opts.args)
        .current_dir(&opts.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Clear env and set explicitly so we have full control
    cmd.env_clear();
    for (k, v) in &opts.env {
        cmd.env(k, v);
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Safety: setsid() is async-signal-safe; called between fork and exec
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let is_enoent = e.kind() == std::io::ErrorKind::NotFound;
            return CommandResult {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: None,
                signal: None,
                timed_out: false,
                spawn_error: Some(if is_enoent {
                    format!("ENOENT: {}", e)
                } else {
                    e.to_string()
                }),
                interruption: None,
                timeout_ms: opts.timeout_ms,
            };
        }
    };

    let mut stdin = child.stdin.take().expect("stdin is piped");
    let mut stdout_pipe = child.stdout.take().expect("stdout is piped");
    let mut stderr_pipe = child.stderr.take().expect("stderr is piped");

    // Write stdin then close it
    if !opts.stdin_text.is_empty() {
        let _ = stdin.write_all(opts.stdin_text.as_bytes()).await;
    }
    drop(stdin);

    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();
    let mut timed_out = false;
    let mut interruption: Option<Interruption> = None;

    // Read stdout and stderr concurrently while checking for interruption
    let read_result = timeout(
        Duration::from_millis(opts.timeout_ms),
        read_streams(
            &mut stdout_pipe,
            &mut stderr_pipe,
            &mut stdout_buf,
            &mut stderr_buf,
            &opts.interrupt_when,
            &opts.on_chunk,
        ),
    )
    .await;

    match read_result {
        Ok(Ok(intr)) => {
            interruption = intr;
        }
        Ok(Err(_)) => {}
        Err(_elapsed) => {
            timed_out = true;
        }
    }

    // Send SIGTERM to process group, then SIGKILL after grace period
    let pid = child.id();
    if timed_out || interruption.is_some() {
        kill_process(&mut child, pid, false).await;
        tokio::time::sleep(Duration::from_millis(SIGKILL_GRACE_MS)).await;
        kill_process(&mut child, pid, true).await;
    }

    // If we timed out while reading, drain remaining output up to grace period
    if timed_out {
        let _ = timeout(Duration::from_millis(500), async {
            let _ = stdout_pipe.read_to_string(&mut stdout_buf).await;
            let _ = stderr_pipe.read_to_string(&mut stderr_buf).await;
        })
        .await;
    }

    let status = child.wait().await;
    let (exit_code, signal) = match status {
        Ok(s) => {
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                (s.code(), s.signal())
            }
            #[cfg(not(unix))]
            {
                (s.code(), None)
            }
        }
        Err(_) => (None, None),
    };

    CommandResult {
        stdout: stdout_buf,
        stderr: stderr_buf,
        exit_code,
        signal,
        timed_out,
        spawn_error: None,
        interruption,
        timeout_ms: opts.timeout_ms,
    }
}

async fn read_streams(
    stdout: &mut (impl AsyncReadExt + Unpin),
    stderr: &mut (impl AsyncReadExt + Unpin),
    stdout_buf: &mut String,
    stderr_buf: &mut String,
    interrupt_when: &Option<Box<dyn Fn(&str, &str) -> Option<Interruption> + Send + Sync>>,
    on_chunk: &Option<Box<dyn Fn(ChunkContext) + Send + Sync>>,
) -> std::io::Result<Option<Interruption>> {
    let mut stdout_bytes = Vec::new();
    let mut stderr_bytes = Vec::new();
    let mut stdout_done = false;
    let mut stderr_done = false;
    let mut buf = vec![0u8; 4096];
    let mut interruption: Option<Interruption> = None;

    while !stdout_done || !stderr_done {
        tokio::select! {
            n = stdout.read(&mut buf), if !stdout_done => {
                match n {
                    Ok(0) => stdout_done = true,
                    Ok(n) => {
                        stdout_bytes.extend_from_slice(&buf[..n]);
                        let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                        *stdout_buf = String::from_utf8_lossy(&stdout_bytes).to_string();
                        if let Some(cb) = on_chunk {
                            cb(ChunkContext {
                                source: "stdout",
                                chunk: chunk.clone(),
                                stdout: stdout_buf.clone(),
                                stderr: stderr_buf.clone(),
                            });
                        }
                        if interruption.is_none() {
                            if let Some(f) = interrupt_when {
                                if let Some(intr) = f(stdout_buf, stderr_buf) {
                                    interruption = Some(intr);
                                    break;
                                }
                            }
                        }
                    }
                    Err(e) => return Err(e),
                }
            }
            n = stderr.read(&mut buf), if !stderr_done => {
                match n {
                    Ok(0) => stderr_done = true,
                    Ok(n) => {
                        stderr_bytes.extend_from_slice(&buf[..n]);
                        let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                        *stderr_buf = String::from_utf8_lossy(&stderr_bytes).to_string();
                        if let Some(cb) = on_chunk {
                            cb(ChunkContext {
                                source: "stderr",
                                chunk: chunk.clone(),
                                stdout: stdout_buf.clone(),
                                stderr: stderr_buf.clone(),
                            });
                        }
                        if interruption.is_none() {
                            if let Some(f) = interrupt_when {
                                if let Some(intr) = f(stdout_buf, stderr_buf) {
                                    interruption = Some(intr);
                                    break;
                                }
                            }
                        }
                    }
                    Err(e) => return Err(e),
                }
            }
        }
    }

    Ok(interruption)
}

async fn kill_process(child: &mut tokio::process::Child, pid: Option<u32>, force: bool) {
    #[cfg(unix)]
    {
        if let Some(pid) = pid {
            let sig = if force {
                libc::SIGKILL
            } else {
                libc::SIGTERM
            };
            // Kill the entire process group (negative pid)
            unsafe {
                libc::kill(-(pid as libc::pid_t), sig);
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill().await;
    }
}

/// Try to parse a JSON object from text, tolerating leading/trailing non-JSON content.
pub fn extract_json_object(text: &str) -> Option<serde_json::Value> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(v) = serde_json::from_str(trimmed) {
        return Some(v);
    }

    let first_brace = trimmed.find('{')?;
    let last_brace = trimmed.rfind('}')?;

    if last_brace < first_brace {
        return None;
    }

    serde_json::from_str(&trimmed[first_brace..=last_brace]).ok()
}
