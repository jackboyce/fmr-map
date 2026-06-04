# Deploying FMR Map with Docker + Cloudflare Tunnel

## What you'll end up with

```
Internet → Cloudflare (TLS) → Cloudflare Tunnel → fmr-map Node app (port 3000, internal)
```

Both services run as Docker containers managed by Docker Compose. Cloudflare handles TLS automatically — no certificates, no open inbound ports, no port forwarding required.

---

## 1. Install Docker on Ubuntu

```bash
sudo apt remove docker docker-engine docker.io containerd runc
sudo apt update
sudo apt install -y ca-certificates curl gnupg

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker $USER
newgrp docker
```

---

## 2. Clone the project

```bash
git clone https://github.com/jackboyce/fmr-map.git /opt/fmr-map
cd /opt/fmr-map
```

---

## 3. Configure environment

```bash
cp .env.example .env
nano .env
```

Set your tokens:

```
HUD_API_TOKEN=your_hud_token
CLOUDFLARE_TUNNEL_TOKEN=your_cloudflare_tunnel_token
PORT=3000
```

The `.env` file is never copied into the Docker image. Docker Compose reads it at runtime via `env_file: .env`.

---

## 4. Set up a Cloudflare Tunnel

1. Add your domain to [Cloudflare](https://dash.cloudflare.com) (free plan)
2. Go to **Tunnels** (in the domain's sidebar) → **Create Tunnel**
3. Name it, copy the tunnel token into `.env` as `CLOUDFLARE_TUNNEL_TOKEN`
4. After starting the containers, go back to the tunnel → **Add route** → **Published application**:
   - **Hostname:** your domain (e.g. `hudrents.com`)
   - **Service URL:** `http://fmr-map:3000`
5. Add a CNAME DNS record: `@` → `<tunnel-id>.cfargotunnel.com` (Proxied)

---

## 5. Build and start

```bash
cd /opt/fmr-map
docker compose up -d --build
docker compose logs -f
```

Your site is live at `https://your-domain.com`.

---

## Updating the app

```bash
cd /opt/fmr-map
git pull
docker compose up -d --build
```

---

## Day-to-day commands

```bash
# Stop everything
docker compose down

# Restart just the app (e.g. after .env change)
docker compose restart app

# View live logs
docker compose logs -f app

# Open a shell inside the running container
docker exec -it fmr-map sh

# Free up old build cache
docker system prune -f
```

---

## Project structure

```
/opt/fmr-map/
├── Dockerfile
├── docker-compose.yml
├── .env                  ← your secrets (never commit this)
├── .dockerignore
├── package.json
├── server/
│   └── index.js
└── public/
    ├── index.html
    ├── css/style.css
    ├── js/app.js
    └── data/counties/    ← 52 GeoJSON files (baked into image)
```
