# Contributing

Thanks for your interest in contributing to Chess Gateway. This guide covers the
day‑to‑day workflows you will need: running the stack locally (Vault + the
NestJS API + an Algorand node), deploying the `did:algo` storage contract that
the service publishes user DIDs to, and pointing the service at the different
Algorand networks (localnet / fnet / testnet / mainnet).

If you are new to the project, please skim the [`README`](./README.md) first —
it explains the overall KMS / API architecture. This document is a complement
focused on **how to run, deploy, and switch networks**.

---

## 1. Prerequisites

You will need the following installed locally:

| Tool                 | Version                | Notes                                       |
|----------------------|------------------------|---------------------------------------------|
| Node.js              | 20.x LTS               | Matches the version used by the Dockerfile  |
| Yarn                 | 1.x (classic)          | `package.json` is yarn‑based                |
| Docker + Compose v2  | latest                 | Runs Vault and (optionally) the API         |
| AlgoKit CLI          | ≥ 2.x                  | Used to start a local Algorand network      |
| Python               | 3.12 (for AlgoKit)     | AlgoKit ships its own venv under the hood   |

Install AlgoKit by following the official guide:
<https://dev.algorand.co/algokit/install>.

---

## 2. Clone & install

```bash
git clone <this-repo>
cd chess-gateway
yarn install
cp .env .env.local   # optional – keep a personal copy
```

The `.env` checked into the repo is a development template. Adjust values to
match your environment (see [§5](#5-environment-variables) for the full list).

---

## 3. Running localnet (Algorand)

For local development we run a full Algorand network on your machine using
AlgoKit. This gives you a fast, disposable chain that the service can publish
DIDs to without needing testnet ALGO.

### 3.1 Start localnet

```bash
algokit localnet start
```

This boots an algod + indexer + KMD stack on the standard localnet ports:

| Service | URL                     | Token                          |
|---------|-------------------------|--------------------------------|
| algod   | `http://localhost:4001` | `aaaa…` (64 × `a`)             |
| indexer | `http://localhost:8980` |                                |
| KMD     | `http://localhost:4002` | `aaaa…` (64 × `a`)             |

You can confirm it is up with:

```bash
algokit localnet status
```

### 3.2 Point the service at localnet

Edit `.env` (or your `.env.local`) so the algod connection variables and the
genesis identifier match localnet:

```dotenv
GENESIS_ID=dockernet-v1
GENESIS_HASH=<localnet genesis hash>
NODE_HTTP_SCHEME=http
NODE_HOST=localhost
NODE_PORT=4001
NODE_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

> **Tip** – `algokit localnet status` prints the genesis hash; copy it into
> `GENESIS_HASH`. The `GENESIS_ID` value is what the service uses to derive the
> `did:algo` network segment (`localnet` / `fnet` / `testnet` / `mainnet`); see
> `genesisIdToNetwork` in `libs/did-algo/util.ts`.

### 3.3 Stop / reset

```bash
algokit localnet stop      # graceful stop
algokit localnet reset     # wipe state and restart
```

---

## 4. Running Vault and the API

Vault is required for *all* environments — it custodies the manager and user
keys. The `docker compose` setup in this repo runs Vault and the NestJS API
together.

### 4.1 First‑time bring‑up

```bash
./scripts/start_development.sh
```

This script:

1. Brings down any running compose project.
2. Builds and starts the `vault` and `pawn` (NestJS) containers.
3. Initialises Vault (`yarn run vault:development:init`) — this creates the
   transit engines, AppRoles, policies, and the manager key.
4. Drops you into a shell inside the `pawn` container.

The init step prints **four pieces of information you must keep**:

1. Vault root token
2. `pawn_managers_approle` `role_id` / `secret_id`
3. `pawn_users_approle` `role_id` / `secret_id`
4. The manager's Algorand address

On localnet, fund the manager address using the AlgoKit dispenser:

```bash
algokit localnet goal clerk send \
  -a 1000000000 \
  -f $(algokit localnet goal account list | awk 'NR==2 {print $3}') \
  -t <MANAGER_ADDRESS>
```

On testnet, use <https://bank.testnet.algorand.network/>.

### 4.2 Subsequent runs

Vault is sealed every time the container restarts. Re‑run the init helper
inside the `pawn` container to unseal and refresh tokens:

```bash
docker exec -it pawn ash
yarn run vault:development:init
```

### 4.3 Without Docker (host‑mode API)

If you prefer to run the NestJS service on the host (faster reloads, attach a
debugger), keep Vault in Docker and run the API directly:

```bash
docker compose up -d vault
yarn start:dev
```

Make sure `VAULT_BASE_URL` points at `http://localhost:8200` (or set
`CLI_USE_LOCAL_VAULT=true`, which is already the default).

---

## 5. Environment variables

The variables most relevant to running and deploying the service:

| Variable                                                | Purpose                                                                                  |
|---------------------------------------------------------|------------------------------------------------------------------------------------------|
| `NODE_ENV`                                              | `development` / `production`.                                                            |
| `VAULT_BASE_URL` / `VAULT_LOCAL_URL`                    | Vault endpoints used by the service / CLI.                                               |
| `VAULT_TRANSIT_USERS_PATH` / `VAULT_TRANSIT_MANAGERS_PATH` | Vault transit engine mount paths.                                                     |
| `VAULT_MANAGER_KEY`                                     | Name of the manager key inside the managers transit engine.                              |
| `VAULT_ROLE_ID` / `VAULT_SECRET_ID`                     | AppRole credentials for CLI / scripts.                                                   |
| `GENESIS_ID`                                            | Selects the `did:algo` network segment (`dockernet-v1` → `localnet`, `testnet-v1.0` → `testnet`, `mainnet-v1.0` → `mainnet`, `fnet-v1` → `fnet`). |
| `GENESIS_HASH`                                          | Algorand genesis hash for the targeted network.                                          |
| `NODE_HTTP_SCHEME` / `NODE_HOST` / `NODE_PORT` / `NODE_TOKEN` | algod connection used by both `ChainService` and `DidService`.                      |
| `DID_ALGO_APP_ID`                                       | Application id of the deployed `DIDAlgoStorage` contract on the active network.          |

### 5.1 Network presets

Common combinations for `GENESIS_ID` / `GENESIS_HASH` / algod:

```dotenv
# --- Localnet (algokit) ---
GENESIS_ID=dockernet-v1
NODE_HTTP_SCHEME=http
NODE_HOST=localhost
NODE_PORT=4001
NODE_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

# --- Testnet (Algonode) ---
GENESIS_ID=testnet-v1.0
GENESIS_HASH=SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=
NODE_HTTP_SCHEME=https
NODE_HOST=testnet-api.algonode.cloud
NODE_PORT=443
NODE_TOKEN=

# --- Mainnet (Algonode) ---
GENESIS_ID=mainnet-v1.0
GENESIS_HASH=wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=
NODE_HTTP_SCHEME=https
NODE_HOST=mainnet-api.algonode.cloud
NODE_PORT=443
NODE_TOKEN=

# --- Fnet ---
GENESIS_ID=fnet-v1
NODE_HTTP_SCHEME=https
NODE_HOST=fnet-api.4160.nodely.dev
NODE_PORT=443
NODE_TOKEN=
```

> The service reads `GENESIS_ID` once at boot to decide which `did:algo`
> network segment to publish under. If you change it, restart the API.

---

## 6. Deploying the `did:algo` storage contract

Each network needs its own deployed `DIDAlgoStorage` application. The
deployment is signed by the **manager** key custodied in Vault — no private
keys ever leave Vault.

### 6.1 Localnet

1. Make sure localnet is up (`algokit localnet start`) and Vault is
   initialised (the manager address must exist and be funded — see §4.1).
2. Point `.env` at localnet (see §5.1).
3. Run the deploy script from the repo root:

   ```bash
   yarn ts-node scripts/deploy-did-algo.ts
   ```

   The script:
   - Connects to algod using `NODE_*` env vars.
   - Loads the manager's Algorand address and a Vault‑backed
     `TransactionSigner` (so the key never leaves Vault).
   - Deploys the `DIDAlgoStorage` ARC‑56 application bundled in
     `libs/did-algo/contracts/`.
   - Prefunds the freshly deployed app account with 1000 ALGO so it
     can pay box MBR for the DIDs the service publishes.
   - Prints the resulting **app id** to stdout *and* writes it back
     into `.env` as `DID_ALGO_APP_ID` automatically.

4. The script writes `DID_ALGO_APP_ID` into `.env` for you. Restart
   the API so it picks up the new value:

   ```bash
   docker compose restart pawn       # or re-run `yarn start:dev`
   ```

   On localnet, `vault:development:init` will additionally deploy the
   contract on first run if `DID_ALGO_APP_ID` is missing/invalid, so the
   manual step above is only required for non-local networks.

### 6.2 Testnet / fnet / mainnet

The flow is identical, only the network configuration changes:

1. Update `.env` to the target preset from §5.1.
2. Ensure the manager address holds enough ALGO to (a) create the application
   and (b) fund the box storage MBR for any DID the service will publish.
   - Testnet faucet: <https://bank.testnet.algorand.network/>.
   - Mainnet: fund from your treasury.
3. Run the deploy script and capture the app id:

   ```bash
   yarn ts-node scripts/deploy-did-algo.ts
   ```

4. Persist `DID_ALGO_APP_ID` for that environment (e.g. in your secret store /
   k8s config map) and roll the API.

> **Important** – never commit a non‑zero `DID_ALGO_APP_ID` for a public
> network into the repo. Treat it the same as any other per‑environment
> configuration value.

### 6.3 Verifying a deployment

After deploying, create a user via the API (`POST /v1/wallet/user/`) and
inspect the response. The user info DTO returns:

- `did` – the published identifier (`did:algo:<network>:app:<app-id>:<hex-pubkey>`),
  or `null` if the user has no DID yet.
- `wallet_address` – the linked self-custody wallet address (or `null`).

User creation is **fail-fast**: any on-chain publish error aborts the request
with a 5xx — there is no `pending` / `failed` cache row.

Resolve the cached document directly (public endpoint, no auth):

```bash
curl http://localhost:3000/v1/did/users/<user_id>
```

Other DID endpoints (all under `/v1/did`):

- `POST /did/users/:user_id?force=true` – republish (deletes the existing
  on-chain document, reclaiming MBR, then publishes a fresh one). Without
  `force` the request returns 409 if a document already exists.
- `GET  /did/users` – list every cached record (auth).
- `DELETE /did/users/:user_id` – run the contract's `startDelete` /
  `deleteData` flow to tear down the on-chain document and reclaim MBR,
  then drop the local cache row.

---

## 7. Tests, build, and CI checks

Before opening a PR, please run:

```bash
yarn build       # nest build – must be clean
yarn jest        # unit + module tests
yarn lint        # eslint
```

Notes:

- DID‑specific unit tests live under `src/did/**/*.spec.ts` and
  `libs/did-algo/**/*.spec.ts`; both directories are picked up via the
  `roots` entry in the jest config in `package.json`.
- End‑to‑end on‑chain publication is **not** covered by CI — it requires a
  running localnet + Vault + a deployed `DIDAlgoStorage` app. Exercise it
  manually using §6 (or `scripts/create-test-user.ts`) when you change
  anything in `src/did` or `libs/did-algo`.

---

## 8. Branching and PRs

- Branch from `main` (or the active feature branch indicated by maintainers).
- Keep PRs focused; include a short description of the change, the network(s)
  you tested against, and any new env vars or migrations.
- If you add new environment variables, document them in this file and in
  the `.env` template.

Thanks for contributing! 🎼
