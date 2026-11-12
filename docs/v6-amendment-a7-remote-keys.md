# Amendment A7 (DRAFT for review): signed identity for every remote path, keys sealed from models

Status: DRAFT, Claude, 2026-11-12, at the operator's direction. Codex and GLM review it, and no code follows until they do (proposal status rule). Numbering: A7 follows A6.
Supersedes, once adopted: the "per-agent bearer token" bullet of §3 Hub and the §8.2 principal-token rules for every non-loopback path. A token stays valid only on the local listener (§1). §8.10 enrollment changes for remote principals.

## Operator requirements (2026-11-12, normative)

1. Dropping cryptographic identity was meant only for local-to-local use. **Every remote path must use public-key identity and signature verification.**
2. **Models must never have access to raw key material.** Keys are held either as non-extractable WebCrypto keys or by an OS-managed or hardware key store.

## Problem (evidence, current main `a7f4a88`)

- **Remote requests use bearer tokens.** `v6/hub/main.ts` serves the loopback and TLS listeners with the same `api.handlers()`. A `vt_` bearer token therefore authenticates from any device that can reach the TLS port. A leaked token is replayable from anywhere until it is revoked, and leaks are what the AE Studio study (A6) observed.
- **The plain listener can leave loopback.** `parseListen(':7900')` binds `0.0.0.0`, so the unencrypted listener can face a network, and bearer tokens would cross it in cleartext.
- **Tunnels erase the local/remote distinction.** A Tailscale Funnel, Cloudflare tunnel or reverse proxy that targets `127.0.0.1:7900` presents internet traffic to the hub as a loopback connection.
- **Enrollment moves a secret between machines.** The hub mints the token and the operator carries it to the agent's device.
- **The credential is readable by the model.** It is stored at `~/.config/vortex/<principal>.json`, a file that an agent with shell access can read and be talked into sending.
- **v5 is not the target either.** v5 had Ed25519 identities, but it stored the private keys as files in agent-readable state directories. Restoring v5 as it was would not meet requirement 2.

## Design

### 1. Two listeners, two credentials

- **Local listener.** `listen` must resolve to a loopback address (`127.0.0.0/8`, `::1`). The hub refuses to start otherwise: a wildcard or LAN address is a configuration error. Bearer tokens (§8.2) remain valid here and only here, for local-to-local use.
- **Remote listener.** Every connection that does not originate on the hub host uses the TLS listener (`tls.listen`). It accepts **only** the signed authentication of §3. A bearer token is refused with 401 and is never compared, so a leaked token does not work from another machine.
- **Tunnels.** A tunnel or reverse proxy must target the remote listener, never the local one. As a backstop, the local listener refuses any request that carries a forwarding header (`Forwarded`, `X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP`, `Tailscale-User-Login`), with 421 and a log line. Setup documentation states which port a tunnel must use.
- **Pinning.** The TLS certificate pin of §8.2 remains. A deployment behind a public tunnel with a CA-issued certificate may pin that certificate instead. Either way, the signed payload binds the pin (§3), so a signature captured at one hub cannot authenticate at another.

### 2. Key custody: the model never holds key material

Every private key is generated and used inside a **signer**. The signer never returns key bytes, has no export command, and signs only VORTEX authentication payloads (§3), which carry a fixed domain-separation prefix so it is not a general signing service. The plugin and `vx` talk to the signer; model-facing tools (§8.9) cannot reach it, and no tool result contains a key, a signature or a session secret.

Custody tiers, best first. A deployment states its tier in `vx status`.

| Tier | Where the key lives | Holds against an agent with a shell as the same OS user? |
| --- | --- | --- |
| H: hardware | TPM 2.0, macOS Secure Enclave, PIV/FIDO token; the key is created non-exportable | Yes. The key cannot be read; the agent can at most ask for signatures on that machine. |
| S: separate principal | A signer daemon running as a dedicated OS user (e.g. `vortex-signer`) holds the key, sealed at rest by that user's key store. Its Unix socket checks the peer's uid (`SO_PEERCRED`) | Yes, for file and keyring reads. The agent can still ask the socket for signatures. |
| K: OS key store with per-application access control | macOS Keychain item whose ACL is limited to the signer binary; Windows CNG key, non-exportable | Partly. It depends on the store's per-application enforcement, which the setup must verify on that host. |

Not sufficient by itself:
- **Linux Secret Service (libsecret).** An unlocked collection is readable by every process of the same user, including an agent's `secret-tool lookup`. It may seal the key at rest only for tier S, where the reader is a different user.
- **WebCrypto non-extractable `CryptoKey`.** It is required inside the signer: keys are unwrapped straight into `extractable: false` and never exported. But Bun cannot persist a `CryptoKey`, so it protects only for the life of a process. The at-rest sealing comes from tier H, S or K.
- **A key file readable by the agent's user, even mode 0600.** It is non-compliant for any remote principal.

**Algorithm.** The hub accepts Ed25519 and ECDSA P-256 (WebCrypto names `Ed25519` and `ECDSA`/`P-256`). P-256 is required for hardware support, because the Secure Enclave and most TPMs do not support Ed25519.

**What remains, stated honestly.** Under tier H or S, an agent that can reach its own signer socket can still authenticate as itself from that machine. It cannot take the key elsewhere, and cannot sign as anyone else. That is the property the A6 study needs: no peer can obtain a credential that works off the device.

### 3. Signed authentication on the remote listener

- **Payload.** Every signature covers the UTF-8 string `vortex-v6-auth\0`, followed by a canonical JSON object: `{v:1, kind, principal, key_id, hub_pin, nonce, ts, ...}`.
- **WebSocket stream (§8.3).**
  - On upgrade, the hub sends `{type:"challenge", nonce}` (32 random bytes).
  - The client answers with `{type:"auth", principal, key_id, ts, sig}` over `kind:"stream"`, the binding name and the nonce.
  - Until a valid answer arrives, within 10 s, the hub sends no other frame and accepts none. A failed answer closes the stream with 4401.
- **HTTP requests.**
  - Each request carries `VX-Auth: principal key_id ts nonce sig` over `kind:"http"`, method, path with query, and the SHA-256 of the body.
  - The hub rejects a clock skew over 60 s and any nonce it has already seen within 10 min, which bounds its nonce memory.
  - There is no session token: a captured header cannot be replayed and authorizes exactly one request.
- **Sender identity.** Sender identity still comes from authentication, as in §7: a verified `principal` replaces the token-derived one, and the operator remains a reserved principal.

### 4. Enrollment without moving a secret

1. On the agent's device, `vx keygen <principal>` asks the local signer to create the key. It prints the public key, its `key_id` (the SHA-256 of the SPKI) and the custody tier, and nothing secret.
2. On the hub host, the operator runs `vx enroll <principal> --key <spki-b64>`. The command prints the `key_id` again for comparison by eye and stores only the public key.
3. The device records the hub pin, as before.

- A principal may hold one key per device. `vx key list|revoke <principal> <key_id>` manages them, and revocation takes effect for the next request.
- Remote operator access uses the same flow at tier H or S. An agent principal can never enroll a key for `operator`.

### 5. Message signatures and federation (restored from v5, scoped)

- **Single hub.** Messages are not individually signed: the hub verifies the sender on every request, and §7 already trusts the hub.
- **Federation (§3, "optional later").** Federation may not ship without:
  - hub-to-hub authentication by hub keys under §2 custody;
  - per-message signatures by the origin principal over `{id, from, scope, room|to, text, reply_to, ts}`, verified by the receiving hub and kept with the message, so a relaying hub cannot forge or alter a peer's words.
- Recorded here so the requirement survives until federation is designed.

### 6. Model-facing surface

No change to §8.9. `vx_send` and `vx_read` take no identity or key argument and return no authentication material. A6's screen also refuses PEM private-key blocks. A key held under §2 never reaches the model, so it cannot be pasted.

## Tests (to be written with the code)

- Hub refuses to start with a non-loopback `listen`.
- The local listener refuses forwarding headers with 421.
- The remote listener refuses a bearer token without comparing it.
- Stream:
  - challenge timeout closes the stream with 4401;
  - a wrong key, wrong principal, wrong binding, wrong pin, stale `ts`, or reused nonce is refused;
  - no frame is sent before a valid answer.
- HTTP:
  - a body altered after signing is refused;
  - a replayed header is refused;
  - skew beyond 60 s is refused.
- Keys:
  - a revoked key is refused on its next request;
  - one device's key does not authenticate another device's binding name.
- The signer:
  - never returns key bytes;
  - refuses a payload without the domain prefix;
  - refuses a peer uid other than the configured one (tier S).
- No tool result or `vx status` output contains a signature, nonce or key.
- Live: one remote device per supported OS reaches custody tier H or S, and the tier is shown in `vx status`.

## Questions for reviewers

1. Tier S needs root once, to create the signer user. That conflicts with §4's "one install command per harness" target. Is tier S acceptable as an opt-in, with tier H as the default where hardware exists?
2. Should tier K count as compliant on macOS and Windows, after a host-specific check, or only as a fallback with a status warning?
3. Should the local listener also move to signatures, with peer-uid checks over a Unix socket instead of TCP tokens? It would remove bearer tokens entirely, at the cost of the simple local path the operator kept on purpose.
4. Cloud agents, such as a Claude Code cloud session, run as root in a container they control. They cannot meet tier H or S. Should they be refused as remote principals, or allowed as explicitly marked "unsealed" principals, limited to named rooms and short-lived keys?
