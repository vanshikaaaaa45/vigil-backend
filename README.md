# VIGIL Backend

VIGIL is a developer observability platform that provides real-time log streaming, webhook routing, uptime monitoring, and intelligent alerting — similar to Datadog/Sentry (lite version).

---

## Tech Stack

- Node.js + Express
- PostgreSQL (pg)
- Redis + BullMQ (queues)
- Socket.io (real-time)
- JWT Authentication
- Nodemailer (alerts)

---

## Features

- Authentication (JWT)
- API Key Management
- Log Ingestion (`/api/logs/ingest`)
- Real-time Log Streaming (Socket.io)
- Webhook Relay System
- Uptime Monitoring (cron jobs)
- Alert Engine (threshold + sliding window)
- Email & Slack Alerts
- Team-based architecture (planned/phase)
- Billing-ready (Stripe integration planned)

---

## Setup Instructions

### 1. Clone repo

```bash
git clone https://github.com/your-username/vigil-backend.git
cd vigil-backend
```

---

### 2. Install dependencies

```bash
npm install
```

---

### 3. Setup environment variables

Create `.env` file:

```env
PORT=5001
NODE_ENV=development

DATABASE_URL=postgresql://user:password@localhost:5432/vigil
REDIS_URL=redis://localhost:6379

JWT_SECRET=your_secret
JWT_REFRESH_SECRET=your_refresh_secret

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email
SMTP_PASS=your_app_password
EMAIL_FROM=VIGIL <your_email>

FRONTEND_URL=http://localhost:5173
BACKEND_URL=http://localhost:5001

WEBHOOK_SECRET=your_secret
```

---

### 4. Run migrations

```bash
npm run migrate
```

---

### 5. Start server

```bash
npm run dev
```

---

## API Testing

### Health Check

```bash
GET /health
```

---

### Log Ingestion

```bash
POST /api/logs/ingest
Headers:
  X-API-Key: your_key

Body:
{
  "service": "auth",
  "level": "error",
  "message": "Login failed"
}
```

---

### Webhook Relay

```bash
POST /api/relay/in/:channelSlug
```

---

## Real-time Events

Socket.io emits:

- `log:new`
- `event:received`

---

## Workers

Run workers separately:

```bash
node workers/log.worker.js
node workers/relay.worker.js
```

---

## Deployment

### Backend → Railway

1. Push to GitHub
2. Deploy via Railway
3. Add PostgreSQL + Redis plugins
4. Set environment variables
5. Run migrations

---

## Architecture

```txt
Client → API → Queue → Worker → DB → Socket → UI
```

---

## Future Improvements

- Rate limiting per API key
- Usage tracking & analytics
- Advanced alert rules
- Team collaboration
- Stripe billing integration

---

## Author

Built by Vanshika Chauhan
