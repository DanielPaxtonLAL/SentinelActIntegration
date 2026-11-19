# Prototype

## Run locally

Install Node.js 20 or later. If you do not already have `.env`, copy
`.env.example` to `.env` and set the EMS and Act! URLs for your
environment. Use the server origin for `EMS_URL` (for example,
`http://your-ems-host:8080`), without the `/ems` path. Set `ACT_URL` to
the Act! Web API base URL (for example, `http://your-act-host/Act.Web.API`).
Both addresses are required.

```powershell
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Set `PORT` in `.env` to
choose a different local port. Set `EMS_INSECURE=1` only when connecting to an
EMS server with a self-signed HTTPS certificate. Log in with your own EMS
username and password. The first time, select **Configure Act! login** and enter
your Act! credentials. After both logins succeed, the browser saves them
encrypted with a key derived from your EMS password (PBKDF2-SHA-256 and
AES-256-GCM). Later logins unlock them with your EMS password. They are stored
per EMS username and browser profile, not shared between devices. The login
flow does not save either submitted password in plaintext; sessions retain
tokens, not passwords. Existing legacy credential entries in `.env` are not
used by the app's login and remain plaintext until removed.

If your EMS password changes, your Act! credentials change, or browser data is
cleared, select **Configure Act! login** and enter them again. Logging out does
not delete the encrypted browser copy. Server sessions end on logout, after 12
hours, on restart, or if an upstream session expires; log in again when needed.

Browser storage encryption works over HTTP as well as HTTPS. Use HTTPS between
the browser and the app and for `EMS_URL` and `ACT_URL` to protect credentials
in transit. Browser storage encryption does not protect against a compromised
browser or malicious code running on this site, and weak EMS passwords can be
guessed offline. Over HTTP, someone on the network could intercept passwords or
modify the app's code.

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
default to `v90` and `2`. For an HTTPS server with an invalid certificate, the
script also honors `EMS_INSECURE=1`; this disables certificate verification for
that connection and should be used only temporarily on a trusted network.

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

Copy `.env.example` to `.env` and set the EMS and Act! URLs for your environment. The `.env` file is passed to the container at runtime and is not included in the Docker image.

```powershell
Copy-Item .env.example .env
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). Set `PORT` in `.env` to change the host port; the app continues to listen on port 3000 inside the container.

Stop the app with `docker compose down`.
