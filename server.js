require('dotenv').config();

const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const cors         = require('cors');
const helmet       = require('helmet');
const compression  = require('compression');
const morgan       = require('morgan');
const cookieParser = require('cookie-parser');

const { pool }                           = require('./config/db');
const routes                             = require('./routes/index');
const { scheduleAll }                    = require('./workers/ping');
const { startLogRetention, startWeeklySummary } = require('./workers/cron');

const app    = express();
const server = http.createServer(app);
const isProd = process.env.NODE_ENV === 'production';

// ── Allowed CORS origins ───────────────────────────────────────────
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  process.env.FRONTEND_URL_PREVIEW,
  'http://localhost:5173',
  'http://localhost:4173',
].filter(Boolean);

const isAllowedOrigin = (origin) => {
  if (!origin) return true;                          // curl / mobile / Postman
  if (ALLOWED_ORIGINS.includes(origin)) return true; // exact match
  if (origin.endsWith('.vercel.app')) return true;   // Vercel preview URLs
  return false;
};

const corsOptions = {
  origin: (origin, cb) => isAllowedOrigin(origin)
    ? cb(null, true)
    : cb(new Error(`CORS blocked: ${origin}`)),
  credentials: true,   // ← required for cookies to cross origins
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-API-Key','X-Team-Id'],
};

// ── Socket.io  ─────────────────────────────────────────────────────
// Railway: use polling first, then upgrade to websocket
// This fixes "WebSocket closed before connection established" on Railway
const io = new Server(server, {
  cors: corsOptions,
  transports:  isProd ? ['polling'] : ['polling', 'websocket'],
  allowEIO3:   true,
  pingTimeout:  60_000,
  pingInterval: 25_000,
  connectTimeout: 45_000,
});

app.set('io', io);

io.on('connection', (socket) => {
  socket.on('auth', (token) => {
    try {
      const jwt     = require('jsonwebtoken');
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.join(`user:${decoded.userId}`);
      socket.emit('authenticated', { userId: decoded.userId });
    } catch {
      socket.emit('error', { message: 'Invalid token' });
    }
  });
});

// ── Middleware ─────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));  // pre-flight for all routes
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

if (!isProd) {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined', { skip: (req) => req.path === '/api/health' }));
}

// ── Routes ─────────────────────────────────────────────────────────
app.use('/api', routes);

// ── 404 ────────────────────────────────────────────────────────────
app.use((req, res) =>
  res.status(404).json({ error: `${req.method} ${req.path} not found` })
);

// ── Global error handler ───────────────────────────────────────────
app.use((err, req, res, _next) => {
  if (err.message?.startsWith('CORS')) {
    return res.status(403).json({ error: err.message });
  }
  console.error('[error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Boot ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5001;

(async () => {
  try {
    await pool.query('SELECT 1');
    console.log('✓ PostgreSQL connected');

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`✓ VIGIL server :${PORT} [${process.env.NODE_ENV || 'development'}]`);
      console.log(`  Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
      console.log(`  Cookie mode: sameSite=${isProd ? 'none' : 'lax'}, secure=${isProd}`);
    });

    await scheduleAll();
    startLogRetention();
    startWeeklySummary();

  } catch (err) {
    console.error('✗ Startup failed:', err.message);
    process.exit(1);
  }
})();