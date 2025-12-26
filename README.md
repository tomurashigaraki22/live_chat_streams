# Live Stream Chat WebSocket Server (Port 3909)

This server provides real-time chat for multiple live sessions. Each `live_session_id` is a separate room. Clients connect via WebSocket and exchange JSON messages with an `event` field and a `data` payload.

## Environment

Configure the following environment variables before starting:

- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DATABASE_NAME`
- `PORT` (default `3909`)

Copy `.env.example` to `.env` and fill in your values, or set variables in your shell.

## Start

```
npm install
npm start
```

The server listens on `ws://localhost:3909`.

## Client Usage

Use the native WebSocket API (browser) or any WS client. All payloads are JSON:

```json
{ "event": "<event_name>", "data": { /* payload */ } }
```

### 1) Join a Room

Send:
```json
{
  "event": "join",
  "data": {
    "live_session_id": "7a3b8f4e-1234-5678-9abc-def012345678",
    "user_id": "5c2b4d1e-1111-2222-3333-444455556666"
  }
}
```
- `live_session_id` must be a UUID (8-4-4-4-12).
- `user_id` is optional for joining (system messages can be sent without it), but required for `message` and `tip`.

Server replies:
```json
{ "event": "join_ack", "data": { "live_session_id": "...", "success": true } }
```

The server also emits to the room:
- `viewer_count` with current viewers
- `system` with "User X joined"

### 2) Send a Text Message

```json
{
  "event": "message",
  "data": { "message": "Hello everyone!" }
}
```

Broadcast to room:
```json
{
  "event": "message",
  "data": {
    "id": "uuid",
    "live_session_id": "uuid",
    "user_id": "uuid",
    "username": "string|null",
    "message": "Hello everyone!",
    "message_type": "TEXT",
    "created_at": "timestamp"
  }
}
```

### 3) Send a Tip

```json
{
  "event": "tip",
  "data": { "message": "Sent a tip!" }
}
```

Broadcast to room with `message_type: "TIP"`.

### 4) Send a System Message

```json
{
  "event": "system",
  "data": { "message": "Stream starting soon" }
}
```

Broadcast to room with `message_type: "SYSTEM"`.

### 5) User Typing (optional)

```json
{ "event": "user_typing", "data": {} }
```

Broadcast to room:
```json
{
  "event": "user_typing",
  "data": { "live_session_id": "uuid", "user_id": "uuid", "username": "string|null", "at": "timestamp" }
}
```

### 6) Leave

```json
{ "event": "leave", "data": {} }
```

Server closes connection, emits:
- `viewer_count` with updated viewers
- `system` with "User X left"

### Errors

Server sends:
```json
{ "event": "error", "data": { "code": "<CODE>", "message": "<desc>" } }
```

Common codes: `BAD_JSON`, `NO_EVENT`, `INVALID_SESSION`, `INVALID_USER`, `NOT_JOINED`, `NO_USER`, `BAD_MESSAGE`, `UNKNOWN_EVENT`.

## Persistence

- Messages are inserted into `live_chat_messages_ripplevids`.
- `users` is used to validate `user_id` and fetch `username`.
- Message structure:
```json
{
  "id": "uuid",
  "live_session_id": "uuid",
  "user_id": "uuid|null",
  "username": "string|null",
  "message": "string",
  "message_type": "TEXT | TIP | SYSTEM",
  "created_at": "timestamp"
}
```

## Example Browser Client

```html
<script>
  const ws = new WebSocket('ws://localhost:3909');
  ws.onopen = () => {
    ws.send(JSON.stringify({
      event: 'join',
      data: {
        live_session_id: '7a3b8f4e-1234-5678-9abc-def012345678',
        user_id: '5c2b4d1e-1111-2222-3333-444455556666'
      }
    }));
  };
  ws.onmessage = (evt) => {
    const payload = JSON.parse(evt.data);
    console.log('Incoming:', payload);
  };
  function sendText(msg) {
    ws.send(JSON.stringify({ event: 'message', data: { message: msg } }));
  }
  function sendTip(msg) {
    ws.send(JSON.stringify({ event: 'tip', data: { message: msg } }));
  }
</script>
```
