# HTTPS on the school LAN

The server speaks plain HTTP by default and that stays the default: a classroom
with no internet has no certificate authority to ask, and a server that refuses
to start without TLS would be a server a teacher cannot run. HTTPS is optional
and, when it is on, it is on for everything — the API, the student client, the
download and the live sockets.

It is worth turning on when either of these is true:

- **A phone should keep the app.** A browser runs a service worker, and offers to
  install a web app, only in a secure context: `https`, or `localhost`. A phone
  opening `http://192.168.1.65:3300` gets neither, so the offline copy silently
  does not exist. The student client says so in About ("Offline copy — Needs
  HTTPS") instead of leaving it to be discovered mid-lesson.
- **Passwords should not cross the room in clear text.** The teacher's and the
  admin's passwords travel on every sign-in; a student's only once, but that one
  is theirs.

## Two flags

```sh
lantern-server --tls-cert /etc/lantern/cert.pem --tls-key /etc/lantern/key.pem
```

Both or neither. One flag on its own, or a file that cannot be read, stops the
process with a sentence naming the flag — a server that silently fell back to
plain HTTP because of a typo would be the worst of both worlds.

`GET /api/health` answers `"tls": true` when the listener speaks HTTPS, so the
address can be checked without a browser. `**https://**<address>:<port>/` is
then the address to put into the admin's public address field: the join link,
the QR code and the student client follow it unchanged.

## A certificate a phone will trust

The part that matters: **Android and iOS trust a certificate authority, not a
leaf certificate.** Importing a self-signed certificate onto the phone is
possible on Android (Settings → Security → Encryption & credentials → Install a
certificate → CA certificate) and effectively impossible on iOS without
installing a profile, and a browser that once accepted a warning will warn
again on the next screen. A local CA costs one more command and is what to use.

### A local CA with `openssl`

Done once per school, on the machine that runs the server. The CA key never
leaves that machine; only `ca.crt` is copied to the phones.

```sh
# The authority, valid for ten years.
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout ca.key -out ca.crt -subj "/CN=LANtern CA"

# A leaf for this server. The address must be in the SAN: browsers stopped
# reading CN years ago, and a certificate without a SAN is rejected outright.
cat > san.cnf <<'EOF'
subjectAltName = DNS:lantern.local, IP:192.168.1.65
EOF
openssl req -newkey rsa:2048 -nodes -keyout key.pem -out server.csr \
  -subj "/CN=lantern.local"
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 825 -out cert.pem -extfile san.cnf

lantern-server --tls-cert cert.pem --tls-key key.pem
```

Put the address students actually type into `san.cnf`. An IP that changes with
the DHCP lease is the usual reason a working certificate stops being one; a
hostname on the school's router, or a static address, avoids it.

Copy `ca.crt` to the phone — by mail, by cable, from any file server — and
install it as a **CA certificate** (Android: Settings → Security → Encryption &
credentials → Install a certificate → CA certificate; it also requires a screen
lock). The browser then trusts the server without a warning, and because the
context is now secure, the app becomes installable and keeps an offline copy.

### Behind a reverse proxy

If the school already has a proxy with a certificate, keep the server on plain
HTTP on `127.0.0.1` and let the proxy terminate TLS. The address students use is
the proxy's; the server never sees a certificate.

```sh
lantern-server --host 127.0.0.1 --port 3300
```

Caddy, which gets a certificate from its own CA and trusts it on the machines it
can reach:

```
lantern.local {
    reverse_proxy 127.0.0.1:3300
}
```

Nginx, with a certificate from the local CA above:

```nginx
server {
    listen 443 ssl;
    server_name lantern.local;

    ssl_certificate     /etc/lantern/cert.pem;
    ssl_certificate_key /etc/lantern/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3300;
        proxy_http_version 1.1;
        # The live board and the log tail are WebSockets; without these they
        # fall back to polling and a paused run looks thirty seconds late.
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

A proxy must pass the upgrade headers. The client falls back to polling when the
socket cannot be opened, which hides a broken proxy during class — the live board
still moves, only more slowly — so a proxy is worth one look with the devtools
open.

## What the client does

- The student client is served by the server and uses the page's own origin, so
  an `https` page opens `wss` sockets without configuration.
- The desktop app talks to its own server on `localhost` over plain HTTP and
  keeps doing so: the certificate is for the phones in the room, and a Tauri
  window loading `https://localhost` with a self-signed leaf would have to trust
  it first.
- A server behind a proxy keeps `publicBaseUrl` at the `https` address; the
  validation already accepts it, and the join link and QR code carry it as it is.
