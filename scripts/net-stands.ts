import { connect, createServer, type Server, type Socket } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import type { Certs } from "./http-stands";

/**
 * Stand-ins for TCP and certificate monitors (#180), for `bun test` and `bun run e2e`, all on
 * spare ports of 127.0.0.1: a port that takes a connection, one that refuses it, TLS from the
 * first byte with the certificate `makeCerts` signed, and SMTP, IMAP and POP3 servers that
 * answer STARTTLS and then speak that same TLS. A mail stand-in that refuses STARTTLS too.
 *
 * Bun cannot turn a server socket into TLS in place, so after STARTTLS a mail stand-in pipes the
 * connection to its TLS port, and the handshake is that port's.
 */

export type NetStands = {
  /** host:port that takes a connection and closes it. */
  open: string;
  /** host:port nothing listens on. */
  closed: string;
  /** TLS from the first byte. */
  tls: string;
  smtp: string;
  imap: string;
  pop3: string;
  /** SMTP without STARTTLS: it answers 502. */
  smtpNoTls: string;
  stop: () => void;
};

type Mail = "smtp" | "imap" | "pop3";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

/** A mail server's plaintext side: its greeting, its answers, and STARTTLS handed to `tlsPort`. */
function mailServer(proto: Mail, tlsPort: number | null): Server {
  return createServer((sock: Socket) => {
    sock.on("error", () => undefined);
    const greeting = { smtp: "220 mail.stand-in ESMTP toposcope", imap: "* OK [CAPABILITY IMAP4rev1 STARTTLS] stand-in", pop3: "+OK stand-in POP3" };
    sock.write(`${greeting[proto]}\r\n`);
    let buf = "";
    const handOver = (ok: string) => {
      sock.removeListener("data", onData);
      sock.pause();
      const up = connect({ host: "127.0.0.1", port: tlsPort! }, () => {
        sock.write(`${ok}\r\n`);
        sock.pipe(up);
        up.pipe(sock);
        sock.resume();
      });
      up.on("error", () => sock.destroy());
      sock.on("close", () => up.destroy());
    };
    const answer = (line: string) => {
      if (proto === "smtp") {
        if (/^(EHLO|HELO)\b/i.test(line)) {
          sock.write(tlsPort ? "250-mail.stand-in\r\n250-PIPELINING\r\n250 STARTTLS\r\n" : "250-mail.stand-in\r\n250 PIPELINING\r\n");
        } else if (/^STARTTLS$/i.test(line)) {
          if (tlsPort) {
            handOver("220 2.0.0 Ready to start TLS");
            return false;
          }
          sock.write("502 5.5.1 STARTTLS not here\r\n");
        } else {
          sock.write("502 5.5.2 no\r\n");
        }
      } else if (proto === "imap") {
        const tag = line.split(" ")[0] ?? "*";
        if (/^\S+ STARTTLS$/i.test(line)) {
          handOver(`${tag} OK Begin TLS negotiation now`);
          return false;
        }
        sock.write(`${tag} BAD no\r\n`);
      } else if (/^STLS$/i.test(line)) {
        handOver("+OK Begin TLS negotiation");
        return false;
      } else {
        sock.write("-ERR no\r\n");
      }
      return true;
    };
    const onData = (d: Buffer) => {
      buf += d.toString("latin1");
      let at: number;
      while ((at = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, at);
        buf = buf.slice(at + 2);
        if (!answer(line)) {
          return;
        }
      }
    };
    sock.on("data", onData);
  });
}

export async function startNetStands(certs: Certs): Promise<NetStands> {
  const servers: Server[] = [];
  const open = createServer((sock) => {
    sock.on("error", () => undefined);
    sock.end();
  });
  servers.push(open);
  const openPort = await listen(open);
  // A port taken and let go: nothing listens there now.
  const gone = createServer();
  const closedPort = await listen(gone);
  await new Promise<void>((resolve) => gone.close(() => resolve()));
  const tls = createTlsServer({ cert: certs.cert, key: certs.key }, (s) => {
    s.on("error", () => undefined);
    s.on("data", () => undefined);
  });
  tls.on("tlsClientError", () => undefined);
  servers.push(tls);
  const tlsPort = await listen(tls);
  const mail = async (proto: Mail, starttls: boolean) => {
    const server = mailServer(proto, starttls ? tlsPort : null);
    servers.push(server);
    return `127.0.0.1:${await listen(server)}`;
  };
  return {
    open: `127.0.0.1:${openPort}`,
    closed: `127.0.0.1:${closedPort}`,
    tls: `localhost:${tlsPort}`,
    smtp: (await mail("smtp", true)).replace("127.0.0.1", "localhost"),
    imap: (await mail("imap", true)).replace("127.0.0.1", "localhost"),
    pop3: (await mail("pop3", true)).replace("127.0.0.1", "localhost"),
    smtpNoTls: (await mail("smtp", false)).replace("127.0.0.1", "localhost"),
    stop: () => {
      for (const s of servers) {
        s.close();
      }
    },
  };
}
