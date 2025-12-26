import dotenv from 'dotenv';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import mysql from 'mysql2/promise';
import { v4 as uuidv4 } from 'uuid';
dotenv.config();

// Configuration
const PORT = parseInt(process.env.PORT || '3909', 10);
const DB_CONFIG = {
  host: "148.113.201.195",
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: "admin",
  password: "Pityboy@22",
  database: "ripplebids",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
};

// Create HTTP server (for WebSocket upgrades)
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WebSocket server for live chat is running.\n');
});

// Create WebSocket server
const wss = new WebSocketServer({ server });

// MySQL pool
let pool;
(async () => {
  try {
    pool = mysql.createPool(DB_CONFIG);
  } catch (err) {
    console.error('Failed to initialize MySQL pool:', err);
  }
})();

// In-memory room tracking
// rooms: Map<live_session_id, { clients: Set<WebSocket>, viewerCount: number }>
const rooms = new Map();

// clientMeta: Map<WebSocket, { user_id: string|null, username: string|null, live_session_id: string|null }>
const clientMeta = new Map();

// Utilities
function isValidUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

async function validateUser(user_id) {
  if (!pool) return null;
  try {
    const [rows] = await pool.query('SELECT id, username FROM users WHERE id = ? LIMIT 1', [user_id]);
    if (rows && rows.length > 0) {
      const { id, username } = rows[0];
      return { id: String(id), username: username || null };
    }
    return null;
  } catch (err) {
    console.error('Error validating user:', err);
    return null;
  }
}

async function saveMessage(msg) {
  if (!pool) return;
  try {
    const {
      id,
      live_session_id,
      user_id,
      username,
      message,
      message_type,
      created_at,
    } = msg;
    await pool.query(
      `INSERT INTO live_chat_messages_ripplevids 
       (id, live_session_id, user_id, username, message, message_type, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, live_session_id, user_id, username, message, message_type, created_at]
    );
  } catch (err) {
    console.error('Error saving message:', err);
  }
}

function send(ws, payload) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  } catch (_) {}
}

function broadcastToRoom(live_session_id, payload) {
  const room = rooms.get(live_session_id);
  if (!room) return;
  for (const client of room.clients) {
    send(client, payload);
  }
}

function attachToRoom(ws, live_session_id) {
  let room = rooms.get(live_session_id);
  if (!room) {
    room = { clients: new Set(), viewerCount: 0 };
    rooms.set(live_session_id, room);
  }
  if (!room.clients.has(ws)) {
    room.clients.add(ws);
    room.viewerCount += 1;
  }
}

function detachFromRoom(ws) {
  const meta = clientMeta.get(ws);
  const live_session_id = meta?.live_session_id;
  const username = meta?.username;
  const user_id = meta?.user_id;
  if (!live_session_id) return;
  const room = rooms.get(live_session_id);
  if (!room) return;
  if (room.clients.has(ws)) {
    room.clients.delete(ws);
    room.viewerCount = Math.max(0, room.viewerCount - 1);
  }
  // Emit viewer count update
  broadcastToRoom(live_session_id, {
    event: 'viewer_count',
    data: { live_session_id, count: room.viewerCount },
  });
  // Emit system leave message
  const sysMsg = {
    id: uuidv4(),
    live_session_id,
    user_id: null,
    username: null,
    message: username ? `User ${username} left` : user_id ? `User ${user_id} left` : 'A user left',
    message_type: 'SYSTEM',
    created_at: new Date().toISOString(),
  };
  broadcastToRoom(live_session_id, { event: 'system', data: sysMsg });
  saveMessage(sysMsg);
  // Cleanup empty rooms
  if (room.clients.size === 0) {
    rooms.delete(live_session_id);
  }
}

// WebSocket events
wss.on('connection', (ws) => {
  clientMeta.set(ws, { user_id: null, username: null, live_session_id: null });

  // join: client sends { event: 'join', data: { live_session_id, user_id? } }
  // Server validates, attaches to room, acknowledges, emits system message and viewer_count
  // message: client sends { event: 'message', data: { message } }, server broadcasts TEXT to room
  // tip: client sends { event: 'tip', data: { message } }, server broadcasts TIP to room
  // system: client/platform sends { event: 'system', data: { message } }, server broadcasts SYSTEM to room
  // user_typing: client sends { event: 'user_typing' }, server broadcasts typing event to room
  // leave: client sends { event: 'leave' }, server detaches and broadcasts leave updates
  ws.on('message', async (raw) => {
    let payload;
    try {
      payload = JSON.parse(String(raw));
    } catch (err) {
      send(ws, { event: 'error', data: { code: 'BAD_JSON', message: 'Invalid JSON payload' } });
      return;
    }
    const { event, data } = payload || {};
    if (!event) {
      send(ws, { event: 'error', data: { code: 'NO_EVENT', message: 'Missing event' } });
      return;
    }

    if (event === 'join') {
      const { live_session_id, user_id } = data || {};
      if (!live_session_id || !isValidUUID(String(live_session_id))) {
        send(ws, { event: 'error', data: { code: 'INVALID_SESSION', message: 'Invalid live_session_id' } });
        return;
      }
      let username = null;
      if (user_id) {
        const user = await validateUser(String(user_id));
        if (!user) {
          send(ws, { event: 'error', data: { code: 'INVALID_USER', message: 'Invalid user_id' } });
          return;
        }
        username = user.username;
      }
      clientMeta.set(ws, { user_id: user_id || null, username, live_session_id });
      attachToRoom(ws, live_session_id);
      send(ws, { event: 'join_ack', data: { live_session_id, success: true } });
      // Emit viewer count update
      const room = rooms.get(live_session_id);
      broadcastToRoom(live_session_id, {
        event: 'viewer_count',
        data: { live_session_id, count: room.viewerCount },
      });
      // Emit system joined message
      const sysMsg = {
        id: uuidv4(),
        live_session_id,
        user_id: null,
        username: null,
        message: username ? `User ${username} joined` : user_id ? `User ${user_id} joined` : 'A user joined',
        message_type: 'SYSTEM',
        created_at: new Date().toISOString(),
      };
      broadcastToRoom(live_session_id, { event: 'system', data: sysMsg });
      saveMessage(sysMsg);
      return;
    }

    // Require that the client has joined a room before other actions
    const meta = clientMeta.get(ws);
    const live_session_id = meta?.live_session_id;
    const user_id = meta?.user_id;
    const username = meta?.username;
    if (!live_session_id) {
      send(ws, { event: 'error', data: { code: 'NOT_JOINED', message: 'Join a session first' } });
      return;
    }

    if (event === 'message') {
      // TEXT messages require a valid user
      if (!user_id) {
        send(ws, { event: 'error', data: { code: 'NO_USER', message: 'user_id required for TEXT messages' } });
        return;
      }
      const { message } = data || {};
      if (!message || typeof message !== 'string') {
        send(ws, { event: 'error', data: { code: 'BAD_MESSAGE', message: 'message must be a string' } });
        return;
      }
      const msg = {
        id: uuidv4(),
        live_session_id,
        user_id,
        username,
        message,
        message_type: 'TEXT',
        created_at: new Date().toISOString(),
      };
      broadcastToRoom(live_session_id, { event: 'message', data: msg });
      saveMessage(msg);
      return;
    }

    if (event === 'tip') {
      // TIP messages require a valid user
      if (!user_id) {
        send(ws, { event: 'error', data: { code: 'NO_USER', message: 'user_id required for TIP messages' } });
        return;
      }
      const { message } = data || {};
      if (!message || typeof message !== 'string') {
        send(ws, { event: 'error', data: { code: 'BAD_MESSAGE', message: 'message must be a string' } });
        return;
      }
      const msg = {
        id: uuidv4(),
        live_session_id,
        user_id,
        username,
        message,
        message_type: 'TIP',
        created_at: new Date().toISOString(),
      };
      broadcastToRoom(live_session_id, { event: 'tip', data: msg });
      saveMessage(msg);
      return;
    }

    if (event === 'system') {
      const { message } = data || {};
      if (!message || typeof message !== 'string') {
        send(ws, { event: 'error', data: { code: 'BAD_MESSAGE', message: 'message must be a string' } });
        return;
      }
      const msg = {
        id: uuidv4(),
        live_session_id,
        user_id: null,
        username: null,
        message,
        message_type: 'SYSTEM',
        created_at: new Date().toISOString(),
      };
      broadcastToRoom(live_session_id, { event: 'system', data: msg });
      saveMessage(msg);
      return;
    }

    if (event === 'user_typing') {
      // Broadcast typing status; no persistence
      broadcastToRoom(live_session_id, {
        event: 'user_typing',
        data: { live_session_id, user_id, username, at: new Date().toISOString() },
      });
      return;
    }

    if (event === 'leave') {
      detachFromRoom(ws);
      clientMeta.delete(ws);
      try {
        ws.close();
      } catch (_) {}
      return;
    }

    // Unknown event
    send(ws, { event: 'error', data: { code: 'UNKNOWN_EVENT', message: `Unknown event: ${event}` } });
  });

  ws.on('close', () => {
    detachFromRoom(ws);
    clientMeta.delete(ws);
  });

  ws.on('error', () => {
    // Best-effort cleanup
    detachFromRoom(ws);
    clientMeta.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`WebSocket server listening on port ${PORT}`);
});
