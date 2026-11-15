# Prototype

## Run locally

Install Node.js 20 or later. If you do not already have `.env`, copy
`.env.example` to `.env` and set the EMS credentials and URL for your
environment. Use the server origin for `EMS_URL` (for example,
`http://your-ems-host:8080`), without the `/ems` path.

```powershell
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Set `PORT` in `.env` to
choose a different local port. Set `EMS_INSECURE=1` only when connecting to an
EMS server with a self-signed HTTPS certificate.

New entitlements start on the current UTC date by default. Lease expiry dates
are still checked against the local date as well as the entitlement start date.

For a generated Product Key entitlement, select **Activate**, choose the
customer's C2V file, and download the resulting V2C file. Activations consume
available licenses. If the result is uncertain, check the Activations page for
the license before retrying; existing V2Cs can also be downloaded there.
Activation errors include EMS's readable diagnostics when available.

## Run with Docker

Copy `.env.example` to `.env` and set the EMS credentials and URLs for your environment. The `.env` file is passed to the container at runtime and is not included in the Docker image.

```powershell
Copy-Item .env.example .env
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). Set `PORT` in `.env` to change the host port; the app continues to listen on port 3000 inside the container.

Stop the app with `docker compose down`.
