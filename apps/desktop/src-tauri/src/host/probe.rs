//! Looking at a server this app did not start.
//!
//! The common case this exists for is not exotic: a teacher who ran
//! `lantern-server` from a terminal to try something, or a machine where it is on
//! autostart. The port is taken, the app says "start the server", and pressing it
//! produces an address-in-use error and a class that cannot begin.
//!
//! So the app asks first. A TCP connect and one HTTP GET are enough to know a
//! server is there and which build it is - no client library, because the app
//! ships with none and a health endpoint is not worth one. Stopping it is the
//! harder half: the process belongs to somebody else, so it is found by the pid
//! that holds the port and killed by that number, never by a name pattern.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Command, Stdio};
use std::time::Duration;

use super::ExternalServer;

/// Long enough for a local answer, short enough that a closed port does not
/// leave the window waiting. A connect to a port nobody holds is refused at once.
const TIMEOUT: Duration = Duration::from_millis(1200);

/// The pid a server on this port would be, if the platform can be asked.
///
/// `None` means "could not tell", never "there is nothing there": the window
/// offers a manual instruction instead of a button that cannot work.
pub fn pid_on_port(port: u16) -> Option<u32> {
    if cfg!(target_os = "windows") {
        return netstat_pids(port).into_iter().next();
    }
    // `ss` first: it is in every Linux base image, while `lsof` often is not.
    if let Some(pid) = ss_pids(port).into_iter().next() {
        return Some(pid);
    }
    lsof_pids(port).into_iter().next()
}

/// Asks whoever is on the port what they are.
///
/// Returns `None` for a closed port, and for something on the port that is not
/// this app's server - the window then says the port is taken rather than
/// offering to stop a process it cannot identify.
pub fn probe_external(port: u16) -> Option<ExternalServer> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, TIMEOUT).ok()?;
    stream.set_read_timeout(Some(TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(TIMEOUT)).ok()?;

    let request = format!(
        "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).ok()?;

    let mut raw = Vec::new();
    let mut chunk = [0_u8; 1024];
    // The health answer is a few hundred bytes; the cap is here so a port held by
    // something that streams forever cannot pin the window open.
    while raw.len() < 16 * 1024 {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(count) => raw.extend_from_slice(&chunk[..count]),
        }
    }
    let text = String::from_utf8_lossy(&raw);
    if !is_ok(&text) {
        return None;
    }

    Some(ExternalServer {
        port,
        pid: pid_on_port(port),
        version: version_of(&text),
    })
}

/// Stops a process by its number.
///
/// By pid, never by name: a pattern that matched a name would also match the
/// command that ran it, and the window would kill itself.
pub fn kill_pid(pid: u32) -> Result<(), String> {
    if pid == 0 {
        return Err("refusing to stop pid 0".to_string());
    }
    let mut command = if cfg!(target_os = "windows") {
        let mut command = Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/F"]);
        command
    } else {
        // SIGTERM, not SIGKILL: the server closes its database and its socket on
        // the way out, and a class mid-paper is better served by that than by a
        // process that is simply gone.
        let mut command = Command::new("kill");
        command.arg("-TERM").arg(pid.to_string());
        command
    };
    let status = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(_) => Err(format!("could not stop pid {pid}")),
        Err(error) => Err(format!("could not stop pid {pid}: {error}")),
    }
}

/// True when the answer is an HTTP 200 - which is what `/api/health` returns, and
/// what no other thing on the port does by accident.
fn is_ok(text: &str) -> bool {
    text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200")
}

/// The `version` field of the health answer, read as text rather than parsed as
/// JSON: this is one string in a response nobody else is reading, and a parser
/// here would be a dependency for nothing.
fn version_of(text: &str) -> Option<String> {
    let marker = "\"version\":\"";
    let start = text.find(marker)? + marker.len();
    let rest = &text[start..];
    let end = rest.find('"')?;
    let version = rest[..end].trim();
    (!version.is_empty()).then(|| version.to_string())
}

/// `ss -lptnH 'sport = :PORT'` - one line per listener, `pid=NNN` inside.
fn ss_pids(port: u16) -> Vec<u32> {
    let output = run_tool("ss", &["-lptnH", &format!("sport = :{port}")]);
    parse_pids(&output, |text| {
        let after = text.split("pid=").nth(1)?;
        let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
        digits.parse::<u32>().ok()
    })
}

/// `lsof -nP -iTCP:PORT -sTCP:LISTEN -t` - bare pids, one per line.
fn lsof_pids(port: u16) -> Vec<u32> {
    let output = run_tool(
        "lsof",
        &["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"],
    );
    parse_pids(&output, |text| text.trim().parse::<u32>().ok())
}

/// `netstat -ano` - the pid is the last column of a LISTENING row.
fn netstat_pids(port: u16) -> Vec<u32> {
    let output = run_tool("netstat", &["-ano"]);
    let needle = format!(":{port}");
    output
        .lines()
        .filter(|line| {
            let columns: Vec<&str> = line.split_whitespace().collect();
            // TCP  <local>  <foreign>  LISTENING  <pid>, and the local address is
            // the one on our port - the foreign address is somebody else's.
            columns.len() >= 5
                && columns[0].eq_ignore_ascii_case("tcp")
                && columns[1].ends_with(&needle)
                && columns[3].eq_ignore_ascii_case("listening")
        })
        .filter_map(|line| line.split_whitespace().last()?.parse::<u32>().ok())
        .collect()
}

/// Runs a listener lookup and hands back whatever it printed, if anything.
///
/// A missing tool is not an error: it is a system without that tool, and the
/// next candidate is tried. Only a tool that exists and fails loudly is worth
/// saying anything about, and there is nowhere here to say it.
fn run_tool(program: &str, args: &[&str]) -> String {
    Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).to_string())
        .unwrap_or_default()
}

/// Applies a per-line reader to whatever the tool printed, keeping what it found.
fn parse_pids<F>(output: &str, read: F) -> Vec<u32>
where
    F: Fn(&str) -> Option<u32>,
{
    output.lines().filter_map(read).collect()
}

#[cfg(test)]
mod probe_tests;