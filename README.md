# Prototype

## Run with Docker

Copy `.env.example` to `.env` and set the EMS credentials and URLs for your environment. The `.env` file is passed to the container at runtime and is not included in the Docker image.

```powershell
Copy-Item .env.example .env
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). Set `PORT` in `.env` to change the host port; the app continues to listen on port 3000 inside the container.

Stop the app with `docker compose down`.
