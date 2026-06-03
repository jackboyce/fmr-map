# Deploying FMR Map with Docker on Ubuntu

## What you'll end up with

```
Internet → Nginx (port 80/443) → fmr-map Node app (port 3000, internal only)
```

Both services run as Docker containers managed by Docker Compose. Nginx handles TLS termination, gzip, and caching headers. The Node app never touches the public internet directly.

---

## 1. Install Docker on Ubuntu

```bash
# Remove any old versions
sudo apt remove docker docker-engine docker.io containerd runc

# Install prerequisites
sudo apt update
sudo apt install -y ca-certificates curl gnupg

# Add Docker's GPG key and repo
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker Engine + Compose plugin
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Let your user run Docker without sudo
sudo usermod -aG docker $USER
newgrp docker

# Verify
docker --version
docker compose version
```

---

## 2. Copy the project to your server

From your local machine:

```bash
# Option A: rsync (recommended — skips node_modules automatically)
rsync -av --exclude='node_modules' --exclude='.git' \
  ./fmr-map/ user@your-server-ip:/opt/fmr-map/

# Option B: git
# Push to GitHub, then on the server:
git clone https://github.com/you/fmr-map.git /opt/fmr-map
```

Then SSH in:

```bash
ssh user@your-server-ip
cd /opt/fmr-map
```

---

## 3. Configure environment

```bash
cp .env.example .env
nano .env
```

Set your HUD API token:

```
HUD_API_TOKEN=eyJhbGciOiJSUzI1NiJ9...
PORT=3000
```

The `.env` file is **never** copied into the Docker image (it's in `.dockerignore`). Docker Compose reads it at runtime via `env_file: .env`.

---

## 4. Get a TLS certificate with Certbot

You need a domain pointed at your server's IP before doing this.

```bash
# Install Certbot
sudo apt install -y certbot

# Get a certificate (standalone mode — no web server needed yet)
sudo certbot certonly --standalone -d your-domain.com

# Certs are saved to:
#   /etc/letsencrypt/live/your-domain.com/fullchain.pem
#   /etc/letsencrypt/live/your-domain.com/privkey.pem

# Copy them into the project (Nginx reads from ./nginx/certs/)
sudo mkdir -p /opt/fmr-map/nginx/certs
sudo cp /etc/letsencrypt/live/your-domain.com/fullchain.pem /opt/fmr-map/nginx/certs/
sudo cp /etc/letsencrypt/live/your-domain.com/privkey.pem   /opt/fmr-map/nginx/certs/
sudo chown -R $USER:$USER /opt/fmr-map/nginx/certs
```

Update `nginx/nginx.conf` — change `your-domain.com` to your actual domain.

---

## 5. If you don't have a domain yet (HTTP-only for now)

Edit `docker-compose.yml` to remove the nginx service and expose the app directly:

```yaml
services:
  app:
    build: .
    container_name: fmr-map
    restart: unless-stopped
    env_file: .env
    ports:
      - "3000:3000"     # exposes directly on port 3000
```

Then access it at `http://your-server-ip:3000`. Add Nginx + TLS later.

---

## 6. Build and start

```bash
cd /opt/fmr-map

# Build the image and start both containers in the background
docker compose up -d --build

# Watch the logs
docker compose logs -f

# Check container status
docker compose ps
```

Expected output from `docker compose ps`:
```
NAME          IMAGE          STATUS                  PORTS
fmr-map       fmr-map-app    Up 2 minutes (healthy)  3000/tcp
fmr-nginx     nginx:alpine   Up 2 minutes            0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp
```

Your site is live at `https://your-domain.com`.

---

## 7. Certificate auto-renewal

Let's Encrypt certs expire every 90 days. Add a cron job to renew and re-copy:

```bash
sudo crontab -e
```

Add this line:

```cron
0 3 * * * certbot renew --quiet && \
  cp /etc/letsencrypt/live/your-domain.com/fullchain.pem /opt/fmr-map/nginx/certs/ && \
  cp /etc/letsencrypt/live/your-domain.com/privkey.pem   /opt/fmr-map/nginx/certs/ && \
  docker exec fmr-nginx nginx -s reload
```

This runs at 3am daily, renews if within 30 days of expiry, copies the new certs, and reloads Nginx — zero downtime.

---

## Day-to-day commands

```bash
# Stop everything
docker compose down

# Restart just the app (e.g. after .env change)
docker compose restart app

# Rebuild and redeploy after a code change
docker compose up -d --build

# View live app logs
docker compose logs -f app

# Open a shell inside the running container
docker exec -it fmr-map sh

# See memory/CPU usage
docker stats

# Free up old build cache
docker system prune -f
```

---

## Updating the app

```bash
cd /opt/fmr-map

# Pull new code (if using git)
git pull

# Rebuild image and restart with zero-downtime rolling replace
docker compose up -d --build
```

Docker Compose will rebuild the image, start a new container, and replace the old one. The Nginx container is unaffected.

---

## Firewall (ufw)

Only expose ports 80 and 443 publicly. Port 3000 should never be directly reachable:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

---

## Project structure on the server

```
/opt/fmr-map/
├── Dockerfile
├── docker-compose.yml
├── .env                  ← your secrets (never commit this)
├── .dockerignore
├── package.json
├── server/
│   └── index.js
├── public/
│   ├── index.html
│   ├── css/style.css
│   ├── js/app.js
│   └── data/counties/    ← 52 GeoJSON files (baked into image)
└── nginx/
    ├── nginx.conf
    └── certs/            ← TLS certs (not in image, mounted at runtime)
        ├── fullchain.pem
        └── privkey.pem
```
