# Nimir Backend API

Production-ready REST API + WebSocket server for the **Nimir** trauma-informed safety reporting platform.

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js ≥ 18 |
| Framework | Express 4 |
| Database | MongoDB + Mongoose 8 |
| Auth | JWT (access + rotating refresh tokens) |
| Real-time | Socket.io 4 |
| Uploads | Multer (evidence, voice, avatars) |
| Validation | Joi |
| Logging | Winston |
| Security | Helmet, CORS, express-rate-limit, express-mongo-sanitize |

---

## Quick Start

```bash
# 1. Clone and install
npm install

# 2. Configure environment
cp .env.example .env
# → Edit .env: set MONGO_URI, JWT_SECRET, JWT_REFRESH_SECRET

# 3. Start MongoDB (if running locally)
mongod --dbpath ./data

# 4. Seed demo data (optional)
npm run seed

# 5. Start dev server (hot-reload)
npm run dev

# Production
npm start
```

Server: **http://localhost:4000**  
Health: **http://localhost:4000/api/health**

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MONGO_URI` | `mongodb://localhost:27017/nimir` | MongoDB connection string |
| `JWT_SECRET` | **required** | Access token secret (64+ chars) |
| `JWT_EXPIRES_IN` | `15m` | Access token lifetime |
| `JWT_REFRESH_SECRET` | **required** | Refresh token secret (64+ chars) |
| `JWT_REFRESH_EXPIRES_IN` | `7d` | Refresh token lifetime |
| `BCRYPT_SALT_ROUNDS` | `12` | Password hash rounds |
| `UPLOAD_DIR` | `./uploads` | File storage root |
| `MAX_FILE_SIZE_MB` | `10` | Max upload size |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated allowed origins |
| `RATE_LIMIT_MAX` | `200` | Requests per window |
| `RATE_LIMIT_WINDOW_MS` | `900000` | Rate limit window (15 min) |
| `AUTH_RATE_LIMIT_MAX` | `10` | Auth attempts per 15 min |
| `TIMER_POLL_INTERVAL_MS` | `5000` | Timer background check interval |

---

## Project Structure

```
nimir-backend/
├── server.js                    ← Entry point — HTTP + Socket.io + bootstrap
├── src/
│   ├── app.js                   ← Express app — middleware + routes
│   ├── config/
│   │   ├── db.js                ← Mongoose connection + events
│   │   └── seed.js              ← Demo data seeder
│   ├── models/
│   │   ├── User.js              ← User schema (registered + ghost modes)
│   │   ├── RefreshToken.js      ← Rotating refresh token store
│   │   ├── Report.js            ← Report + evidence sub-documents + GeoJSON
│   │   └── index.js             ← TrustedContact, CheckinTimer, Notification,
│   │                                SupportResource, AuditLog
│   ├── controllers/
│   │   ├── auth.controller.js   ← register, login, ghost, refresh, logout, me
│   │   ├── report.controller.js ← CRUD + stats + status management
│   │   ├── evidence.controller.js ← file upload / delete / voice
│   │   ├── contacts.controller.js ← trusted contacts CRUD
│   │   ├── timer.controller.js  ← start / cancel / status
│   │   ├── profile.controller.js← view / update / password / avatar / delete
│   │   ├── notification.controller.js
│   │   └── support.controller.js
│   ├── routes/
│   │   ├── auth.routes.js
│   │   ├── report.routes.js
│   │   └── other.routes.js      ← contacts, timer, profile, notifications, support
│   ├── middleware/
│   │   ├── auth.js              ← protect, requireRegistered, optionalAuth
│   │   ├── validate.js          ← Joi schemas + validate() factory
│   │   ├── upload.js            ← Multer evidence/voice/avatar instances
│   │   └── errorHandler.js      ← global error handler + audit middleware + 404
│   ├── services/
│   │   ├── token.service.js     ← JWT sign/verify/rotate
│   │   ├── notification.service.js ← in-app + email/SMS (mock → swap in prod)
│   │   └── timer.service.js     ← background timer polling + Socket.io push
│   └── utils/
│       ├── logger.js            ← Winston logger
│       └── apiHelpers.js        ← ApiError, ApiResponse, asyncHandler
└── uploads/
    ├── evidence/
    ├── avatars/
    └── voice/
```

---

## API Reference

All endpoints: `/api/*`  
Protected routes require: `Authorization: Bearer <access_token>`

---

### Authentication  `/api/auth`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/register` | ❌ | Create a registered account |
| POST | `/login` | ❌ | Login with email + password |
| POST | `/ghost` | ❌ | Start an anonymous ghost session |
| POST | `/refresh` | ❌ | Rotate access + refresh tokens |
| POST | `/logout` | ❌ | Revoke a refresh token |
| POST | `/logout-all` | ✅ | Revoke all sessions for this user |
| GET  | `/me` | ✅ | Get authenticated user profile |

**Register**
```json
POST /api/auth/register
{
  "fullName": "Alex Johnson",
  "email": "alex@example.com",
  "password": "Password123!",
  "phone": "+254712345678"
}
```
```json
201 → { "accessToken": "eyJ...", "refreshToken": "eyJ...", "user": { ... } }
```

**Ghost Session**
```json
POST /api/auth/ghost
{ "displayName": "Anonymous" }
```
Returns `accessToken` only — no refresh token, no PII stored.

**Refresh Tokens** (rotation — old token invalidated)
```json
POST /api/auth/refresh
{ "refreshToken": "eyJ..." }
```

---

### Reports  `/api/reports`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | `/` | List reports (paginated, filterable) |
| GET    | `/stats` | Status count summary |
| GET    | `/:id` | Get full report + evidence |
| POST   | `/` | Create report (starts as `draft`) |
| PUT    | `/:id` | Update report fields |
| PATCH  | `/:id/status` | Advance status in workflow |
| DELETE | `/:id` | Delete report + all files |
| POST   | `/:id/evidence` | Upload evidence files (multipart, field: `files`) |
| DELETE | `/:id/evidence/:evidenceId` | Delete one evidence file |
| POST   | `/:id/voice` | Upload voice recording (multipart, field: `audio`) |
| DELETE | `/:id/voice` | Delete voice recording |

**Status workflow:**
```
draft → submitted → under_review → reviewed → closed
```

**Create Report**
```json
POST /api/reports
{
  "title": "Workplace Harassment",
  "description": "Detailed account of the incident...",
  "relationship": "Colleague",
  "locationName": "Nairobi CBD",
  "locationLat": -1.2921,
  "locationLng": 36.8219,
  "locationObfuscated": true,
  "selfDestruct": false,
  "isAnonymous": false
}
```

**List with filters**
```
GET /api/reports?page=1&limit=20&status=submitted&search=workplace
```

**Update Status**
```json
PATCH /api/reports/:id/status
{
  "status": "reviewed",
  "assignedAdvocate": "Adv. Grace Mwangi",
  "legalNotes": "Case filed successfully."
}
```

**Upload Evidence** (multipart/form-data)
```
POST /api/reports/:id/evidence
Content-Type: multipart/form-data
files: [photo.jpg, document.pdf]   (max 5 files, 10MB each)
```

---

### Trusted Contacts  `/api/contacts`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | `/` | List all contacts |
| GET    | `/:id` | Get single contact |
| POST   | `/` | Add contact (max 5) |
| PUT    | `/:id` | Update contact |
| DELETE | `/:id` | Remove contact |

```json
POST /api/contacts
{
  "name": "Dr. Sarah Osei",
  "email": "sarah@example.com",
  "phone": "+254722000001",
  "relationship": "Therapist",
  "notifyOnCheckin": true,
  "notifyOnReport": false,
  "isPrimary": true
}
```

---

### Check-in Timer  `/api/timer`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | `/` | Get current timer status + remaining seconds |
| POST   | `/start` | Start or restart timer |
| DELETE | `/cancel` | Cancel active timer |

```json
POST /api/timer/start
{ "durationSeconds": 1800 }
```

When the timer expires **without cancellation**:
1. All `notifyOnCheckin` contacts are alerted via email + SMS
2. An in-app notification is created
3. A `timer:expired` Socket.io event is emitted to the user

---

### Profile  `/api/profile`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | `/` | Get profile + stats |
| PUT    | `/` | Update name, phone, language |
| POST   | `/password` | Change password (revokes all sessions) |
| POST   | `/avatar` | Upload avatar (multipart, field: `avatar`) |
| DELETE | `/avatar` | Delete avatar |
| DELETE | `/` | Soft-delete account (anonymise PII) |

---

### Notifications  `/api/notifications`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | `/` | List notifications (supports `?unreadOnly=true`) |
| PATCH  | `/:id/read` | Mark one as read |
| POST   | `/read-all` | Mark all as read |
| DELETE | `/:id` | Delete one notification |
| DELETE | `/` | Clear all notifications |

---

### Support Resources  `/api/support`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/resources` | List all active resources |
| GET | `/resources/:category` | Filter by category |

Categories: `ai`, `legal`, `mental_health`, `community`, `emergency`

---

## WebSocket Events

Connect to `ws://localhost:4000` with a valid JWT:

```javascript
import { io } from 'socket.io-client'

const socket = io('http://localhost:4000', {
  auth: { token: localStorage.getItem('accessToken') }
})

// Server → Client events
socket.on('timer:expired',  (data) => console.log(data.message))
socket.on('timer:started',  (data) => console.log(data.expiresAt))
socket.on('timer:cancelled',(data) => console.log(data.message))
socket.on('report:updated', (data) => console.log(data.reportNumber, data.status))

// Client → Server events
socket.emit('timer:get_status')
socket.on('timer:status', ({ timer }) => console.log(timer.remainingSeconds))
```

---

## MongoDB Schemas Overview

| Collection | Key Fields |
|------------|-----------|
| `users` | fullName, email, phone, passwordHash, mode (registered/ghost), isVerified |
| `refreshtokens` | user (ref), tokenHash, expiresAt — TTL auto-delete |
| `reports` | user (ref), reportNumber, title, description, evidence[], location (GeoJSON), status, voiceUrl |
| `trustedcontacts` | user (ref), name, email, phone, notifyOnCheckin, isPrimary |
| `checkintimers` | user (ref, unique), durationSeconds, expiresAt, isActive, wasTriggered |
| `notifications` | user (ref), type, title, body, isRead — TTL 90 days |
| `supportresources` | category, title, description, actionLabel, icon, phone |
| `auditlogs` | user, action, resourceType, ipAddress — TTL 1 year |

---

## Security Highlights

- **Rotating refresh tokens** — each refresh invalidates the previous token
- **bcrypt password hashing** — configurable salt rounds (default 12)
- **Short-lived access tokens** (15 min default) + 7-day refresh tokens
- **NoSQL injection prevention** — express-mongo-sanitize strips `$` and `.` from inputs
- **Rate limiting** — 10 auth attempts / 15 min; 200 general / 15 min
- **Helmet** — sets 11 secure HTTP response headers
- **Audit log** — every write action recorded with user ID, IP, user-agent
- **Ghost mode** — no email/phone/PII stored; access token only; session expires in 24h
- **Soft delete** — account deletion anonymises PII, preserves reports for legal compliance
- **Password change revokes all sessions** — forces re-authentication on all devices

---

## Demo Credentials (after `npm run seed`)

```
URL:      http://localhost:4000
Email:    alex@demo.nimir.app
Password: Password123!
```
