use super::*;

/// The health answer, byte for byte what the server writes.
const HEALTH: &str = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"status\":\"ok\",\"version\":\"0.7.0\"}";

#[test]
fn reads_the_build_out_of_a_health_answer() {
    assert_eq!(version_of(HEALTH).as_deref(), Some("0.7.0"));
}

#[test]
fn a_404_is_not_a_server_even_though_something_answered() {
    let not_found = "HTTP/1.1 404 Not Found\r\n\r\n{}";
    assert!(!is_ok(not_found));
    assert!(!is_ok(""));
}

#[test]
fn a_socket_that_is_not_http_is_not_a_server() {
    // Something else on the port - an SSH forward, a database - says something
    // else entirely, and stopping it would be stopping the wrong thing.
    let ssh = "SSH-2.0-OpenSSH_9.6\r\n";
    assert!(!is_ok(ssh));
}

#[test]
fn finds_the_pid_inside_an_ss_line() {
    let output = concat!(
        "LISTEN 0      511          0.0.0.0:3300       0.0.0.0:*    ",
        "users:((\"lantern-server\",pid=2420,fd=3))\n",
    );
    let read = |text: &str| {
        let after = text.split("pid=").nth(1)?;
        let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
        digits.parse::<u32>().ok()
    };
    assert_eq!(parse_pids(output, read), vec![2420]);
}

#[test]
fn reads_bare_pids_the_way_lsof_prints_them() {
    let output = "2420\n2421\n";
    assert_eq!(parse_pids(output, |t| t.trim().parse::<u32>().ok()), vec![2420, 2421]);
}

#[test]
fn finds_the_listener_and_ignores_the_established_rows() {
    let output = concat!(
        "Active Connections\n",
        "  Proto  Local Address          Foreign Address        State           PID\n",
        "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       964\n",
        "  TCP    192.168.1.5:3300        192.168.1.9:51514      ESTABLISHED     2420\n",
        "  TCP    0.0.0.0:3300            0.0.0.0:0              LISTENING       2420\n",
    );
    // The established row has our port as its *foreign* address, so matching the
    // wrong column would pick the wrong pid - here, the right one by accident but
    // for the wrong reason, so the port check is what the second row tests.
    let pids = netstat_pids_from(output);
    assert_eq!(pids, vec![2420]);
}

/// `netstat_pids` runs a tool; this is the same rule with the output handed in, so
/// the parsing is testable on any machine.
fn netstat_pids_from(output: &str) -> Vec<u32> {
    output
        .lines()
        .filter(|line| {
            let columns: Vec<&str> = line.split_whitespace().collect();
            columns.len() >= 5
                && columns[0].eq_ignore_ascii_case("tcp")
                && columns[1].ends_with(":3300")
                && columns[3].eq_ignore_ascii_case("listening")
        })
        .filter_map(|line| line.split_whitespace().last()?.parse::<u32>().ok())
        .collect()
}

#[test]
fn a_closed_port_has_no_server_and_no_pid() {
    // Port 1 is not going to be listening, and a connect there must simply fail.
    assert!(probe_external(1).is_none());
    assert!(pid_on_port(1).is_none());
}

#[test]
fn refuses_to_stop_pid_zero() {
    // pid 0 addresses the whole process group, which is a fine thing for an
    // operating system and a terrible thing for this button to ask for.
    assert!(kill_pid(0).is_err());
}