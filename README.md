# 📐 Estado

[![CodeQL](https://github.com/willswire/estado/actions/workflows/codeql.yml/badge.svg)](https://github.com/willswire/estado/actions/workflows/codeql.yml)
[![Code Coverage](https://github.com/willswire/estado/actions/workflows/coverage.yml/badge.svg)](https://github.com/willswire/estado/actions/workflows/coverage.yml)
[![Deploy](https://github.com/willswire/estado/actions/workflows/deploy.yml/badge.svg)](https://github.com/willswire/estado/actions/workflows/deploy.yml)

Estado is a project designed to manage Terraform State using the HTTP backend on Cloudflare Workers. It leverages Cloudflare’s serverless platform to provide a scalable, reliable, and efficient solution for handling Terraform State, complete with support for state locking.

## Features

- **Scalable and Reliable**: Built on Cloudflare Workers, Estado offers a highly scalable and reliable environment for managing Terraform State.
- **State Locking**: Prevent concurrent state modifications with built-in support for state locking.
- **Low Latency**: Leverage Cloudflare’s global network to ensure low latency state management.
- **Serverless**: Reduce operational overhead with a serverless architecture that handles scaling and infrastructure management for you.

## Getting Started

### Prerequisites

- A Cloudflare account
- Terraform (or OpenTofu) installed on your local machine
- Node.js installed on your local machine

### Installation

1. **Clone the Repository**

   ```sh
   git clone https://github.com/willswire/estado.git
   cd estado
   ```

2. **Install Dependencies**

   ```sh
   npm install
   ```

3. **Configure Cloudflare Workers**

   Bind one R2 bucket and one Durable Object namespace. The checked-in `wrangler.toml` is an example; change the Worker route and bucket name for your account. Keep the backend credentials in Worker secrets, not in Git or `wrangler.toml`.

   ```toml
    name = "estado"
    main = "src/index.ts"
    compatibility_date = "2024-07-01"
    compatibility_flags = [ "nodejs_compat" ]

    [[durable_objects.bindings]]
    name = "TF_STATE_LOCK"
    class_name = "DurableState"

    [[migrations]]
    tag = "v1"
    new_classes = ["DurableState"]

    [[r2_buckets]]
    binding = "TF_STATE_BUCKET"
    bucket_name = "estado"
   ```

   Set the credentials before deploying:

   ```sh
   npx wrangler secret put ESTADO_USERNAME
   npx wrangler secret put ESTADO_PASSWORD
   npx wrangler secret put ESTADO_STATE_KEY_RING
   npx wrangler secret put ESTADO_STATE_ACTIVE_KEY_ID
   ```

   `ESTADO_STATE_KEY_RING` is a bounded JSON object mapping key IDs to the standard Base64 encoding of exactly 32 random bytes. `ESTADO_STATE_ACTIVE_KEY_ID` must name one of those keys. Generate key material with `openssl rand -base64 32`. Estado rejects every request when the authentication secrets are missing, and rejects state reads or mutations when the key ring or active ID is missing or malformed. It never writes credentials, keys, or plaintext state to logs.

4. **Deploy to Cloudflare Workers**

   ```sh
   npx wrangler deploy
   ```

## Configuration

In your Terraform configuration, you can configure the HTTP backend to use Estado:

```hcl
terraform {
  backend "http" {
    address         = "https://your-worker-url/myproject"
    lock_address    = "https://your-worker-url/myproject/lock"
    unlock_address  = "https://your-worker-url/myproject/lock"
    lock_method     = "LOCK"
    unlock_method   = "UNLOCK"
  }
}
```

Set `TF_HTTP_USERNAME` and `TF_HTTP_PASSWORD` in the Terraform process environment. Replace `https://your-worker-url` with the URL of your deployed Cloudflare Worker. State writes always require the current lock ID. Deletes require it while a lock exists and may omit it when the state is already unlocked.

State names must start with an ASCII letter or digit and may contain ASCII letters, digits, `.`, `_`, and `-` (up to 128 characters). This keeps each state in a single R2 object namespace and rejects traversal-like paths.

When another client owns a lock, Estado returns HTTP `423` and the existing lock JSON in the response body. Unlock requests must include that lock's `ID`.

## Deployment

By using Cloudflare's Zero Trust framework, you can create a policy for your deployed endpoint that enhances security. Follow these steps to set up Zero Trust for your Estado endpoint:

1. **Log in to Cloudflare Dashboard**

   Visit the Cloudflare dashboard and navigate to the Zero Trust section.

2. **Create an Application**

   Define a new application in the Zero Trust dashboard. Set the application type to web and enter the URL of your Estado endpoint.

3. **Configure Access Policies**

   Create an access policy to control who can access your Estado endpoint. You can define rules based on identity, including allowing specific users, groups, or IP addresses. You can also enforce multi-factor authentication (MFA) for additional security.

4. **Deploy Policies**

   Save and deploy the configured access policies. Cloudflare will now enforce these policies for any requests hitting your Estado endpoint.

Cloudflare Access can sit in front of the Worker as an additional network policy, but it does not replace Estado's Basic authentication. Keep both controls enabled for production state.

### Encryption and backups

Estado stores each primary state object as a versioned AES-256-GCM envelope. The state R2 key is authenticated as AES-GCM additional authenticated data, so moving an envelope to another state path makes decryption fail. Backups copy the previous encrypted envelope to `backups/v1/<state-key>/<timestamp>-<random>.json` before every overwrite or delete. A failed backup aborts the mutation and leaves the primary object unchanged.

Configure an R2 bucket-lock policy for the `backups/v1/` prefix, then add an R2 lifecycle expiry rule for that same prefix. Set the expiry to match the account's recovery needs (30 to 90 days is a reasonable starting point). To recover manually, list the backup prefix, copy the selected encrypted object to the primary state key with R2 tooling, then verify it through the authenticated Terraform endpoint. Do not edit the envelope or decrypt it outside the Worker.

Rotate keys in four steps: add the new key ID and Base64 key to the ring while retaining the old key, deploy the ring with the old active ID, switch `ESTADO_STATE_ACTIVE_KEY_ID` to the new ID, and remove the old key only after every state and retained backup encrypted with it has expired. Existing envelopes keep their key ID, so reads continue through the rotation window. Envelope version 2 records that ID explicitly.

The Durable Object keeps lock metadata in persistent storage. Its in-memory operation queue serializes lock changes and R2 mutations for the lifetime of an instance; a fresh instance starts with the persisted lock record and an empty queue. Cloudflare must finish an in-flight Durable Object request before replacing the instance. Configure lifecycle and bucket-lock policies separately because the queue is not a backup-retention mechanism.

## Contributing

If you have suggestions, bug reports, or feature requests, please open an issue or submit a pull request on GitHub.
