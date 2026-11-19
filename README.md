# Prototype

## Run locally

Install Node.js 20 or later. If you do not already have `.env`, copy
`.env.example` to `.env` and set the EMS URL and Act! credentials for your
environment. Use the server origin for `EMS_URL` (for example,
`http://your-ems-host:8080`), without the `/ems` path.

```powershell
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Set `PORT` in `.env` to
choose a different local port. Set `EMS_INSECURE=1` only when connecting to an
EMS server with a self-signed HTTPS certificate. Log in with your own EMS
username and password. Each browser has its own EMS session; Act! operations use
`ACT_USER` and `ACT_PASS` from `.env`. Credentials and sessions are kept in
server memory, and sessions end on logout, after 12 hours, or on server restart.
Use HTTPS when accessing the app over a network.

New entitlements start on the current UTC date by default. Lease expiry dates
are still checked against the local date as well as the entitlement start date.

For a generated Product Key entitlement, select **Activate**, choose the
customer's C2V file, and download the resulting V2C file. Activations consume
available licenses. If the result is uncertain, check the Activations page for
the license before retrying; existing V2Cs can also be downloaded there.
Activation errors include EMS's readable diagnostics when available.

In entitlement verbose details, base product memory shows EMS memory access
and ASCII-decoded values. Non-printable bytes are shown as `\xNN`.

## List EMS product IDs

Use the PowerShell script to list product names and internal IDs for
`entitlement-form-data.json`. Pass the EMS server origin (without `/ems`):

```powershell
.\config-helper-scripts\get-ems-products.ps1 https://your-ems-host:8080
```

The script uses `EMS_USER` and `EMS_PASS` from the process environment or the
local `.env` file. If either is missing, it prompts for EMS credentials.
`EMS_API_VERSION` and `EMS_VENDOR_ID` are also read from `.env` when set; they
default to `v90` and `2`.

## Product key serial number

The customer configured by `highest-product-key-serial-number-customer-id` in
`entitlement-form-data.json` stores a serial counter in EMS Ref ID 1, which is
incremented after a new draft is saved. The form independently scans serial
numbers encoded in all existing base-product entitlements, selects the lowest
unused value above 06000 (06001 or higher). Serial numbers below 06000 cannot
be submitted. The form checks the input live against the used list. A
duplicate serial is marked invalid and disables saving. Editing an existing
draft does not change the counter.

If the used-serial list cannot be loaded, saving remains disabled until the
lookup succeeds. If EMS saves the draft but the counter cannot be updated, the
draft is still saved; the entitlements page displays a warning with the update
error.

## Run with Docker

Copy `.env.example` to `.env` and set the EMS URL and Act! credentials and URL for your environment. The `.env` file is passed to the container at runtime and is not included in the Docker image.

```powershell
Copy-Item .env.example .env
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). Set `PORT` in `.env` to change the host port; the app continues to listen on port 3000 inside the container.

Stop the app with `docker compose down`.
