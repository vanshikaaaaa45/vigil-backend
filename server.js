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

// ── CORS origins ───────────────────────────────────────────────────
// Support multiple frontend URLs (local dev + Vercel preview + production)
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  process.env.FRONTEND_URL_PREVIEW,       // Vercel preview deployments
  'http://localhost:5173',
  'http://localhost:4173',
].filter(Boolean);

// const corsOptions = {
//   origin: (origin, callback) => {
//     // Allow requests with no origin (curl, mobile apps, Postman)
//     if (!origin) return callback(null, true);
//     if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
//     // Allow any vercel.app subdomain (preview deployments)
//    //if (origin.endsWith('.vercel.app')) return callback(null, true);
   
//     callback(new Error(`CORS: ${origin} not allowed`));
//   },
//   credentials: true,
// };
const corsOptions = {
  origin: [
    process.env.FRONTEND_URL,
    process.env.FRONTEND_URL_PREVIEW,
  ],
  credentials: true,
};

// ── Socket.io ──────────────────────────────────────────────────────
const io = new Server(server, { cors: corsOptions });
app.set('io', io);

io.on('connection', (socket) => {
  socket.on('auth', (token) => {
    try {
      const jwt     = require('jsonwebtoken');
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.join(`user:${decoded.userId}`);
    } catch {
      socket.emit('error', { message: 'Invalid token' });
    }
  });
  socket.on('disconnect', () => {});
});

// ── Middleware ─────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors(corsOptions));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
} else {
  // Minimal logging in production
  app.use(morgan('combined', {
    skip: (req) => req.path === '/api/health',
  }));
}

// ── Routes ─────────────────────────────────────────────────────────
app.use('/api', routes);

// ── 404 ────────────────────────────────────────────────────────────
app.use((req, res) =>
  res.status(404).json({ error: `${req.method} ${req.path} not found` })
);

// ── Global error handler ───────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.message?.startsWith('CORS')) {
    return res.status(403).json({ error: err.message });
  }
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Boot ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5001;

(async () => {
  try {
    // Verify DB connection
    await pool.query('SELECT 1');
    console.log('✓ PostgreSQL connected');

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`✓ VIGIL server on :${PORT} [${process.env.NODE_ENV || 'development'}]`);
      console.log(`  CORS allowed: ${ALLOWED_ORIGINS.join(', ')}`);
    });

    // Start background workers
    await scheduleAll();
    startLogRetention();
    startWeeklySummary();

  } catch (err) {
    console.error('✗ Startup failed:', err.message);
    process.exit(1);
  }
})();