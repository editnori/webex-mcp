## Webex MCP

Local stdio MCP server for Webex, built as a Bun-first standalone repo.

### What It Exposes

- user-scoped and bot-scoped identities
- room listing and room lookup
- room resolution from `webexteams://` links or UUIDs
- room search with lightweight fuzzy ranking
- experimental room read-state tools via a Node-backed SDK helper
- experimental internal conversation tools for typing status, reactions, threads, and conversation state
- user-scoped meeting listing and asset inspection
- user-scoped meeting recording listing
- user-scoped meeting transcript listing, download, and snippet search
- local meeting transcript/recording-transcript indexing and search
- local SQLite indexing for cached room/message search
- cached message search backed by the local SQLite index
- room sync tools for recent spaces or one room history
- people search and person lookup
- membership listing, add, and remove
- teams and team memberships
- message listing, lookup, send, update, and delete
- explicit thread reply listing
- attachment action submit and lookup
- webhook create, list, update, and delete
- message search across recent room history
- direct sends via `toPersonEmail` or `toPersonId`
- raw HTML message sends
- adaptive card message sends
- engineering-focused rich message helper
- file download with authenticated fetch
- latest-attachment lookup in a room
- local text extraction for text, pdf, docx, pptx, and xlsx

### Runtime

- primary runtime: Bun
- package manager: Bun
- document extraction helper: `python3`
- document extraction Python packages: `pypdf`, `python-pptx`, `openpyxl`
- experimental SDK helper for read-state tools: `node`

### Identity Model

- `actor: "user"` uses `WEBEX_USER_TOKEN` or the OAuth refresh file
- `actor: "bot"` uses `WEBEX_BOT_TOKEN`
- `actor: "auto"` prefers `user` when it is configured and valid; it only falls back to `bot` when no user auth is configured

This matters because:

- user actor operates as the OAuth user who authorized the integration
- bot actor operates as the configured bot account
- both actors are still limited to the rooms, scopes, and memberships available to their token

### Files

`send_message` supports:

- `filePaths`: local file uploads from disk when `WEBEX_MCP_ENABLE_LOCAL_FILES=true`
- `fileUrls`: remote URLs passed through to Webex

`extract_message_files` downloads every file URL on a message and optionally extracts text.
`extract_local_file_text` is also gated behind `WEBEX_MCP_ENABLE_LOCAL_FILES=true` and `WEBEX_MCP_LOCAL_FILE_ROOTS`.

Rich send surfaces:

- `send_message` supports `text`, `markdown`, `html`, hosted file URLs, local file uploads, and raw adaptive card `attachments`
- `send_engineering_message` builds structured engineering updates as `markdown`, `html`, or adaptive cards

### Write Safety

This MCP hard-blocks writes to large group rooms:

- `send_message` and `update_message` are refused for any `group` room with 20 or more members
- this is a code-level policy, not a prompt-level convention
- changing that behavior requires a code change

### Local Index

The MCP can cache room and message history into a local SQLite database and use that cache for
`search_messages`.

Recommended flow:

1. Run `sync_all_rooms` once to cache all accessible room metadata.
2. Use `search_rooms` and `resolve_space` against that cached room set.
3. Run `sync_recent_rooms` to cache your most active room messages.
4. Use `search_messages` for indexed local lookup.
5. Run `sync_room_history` when you want deeper history for one room.

Notes:

- the cache is actor-scoped, so bot-visible and user-visible data stay separated
- attachment filenames are indexed through the message record; attachment body text is still opt-in via extraction tools
- local index features use Bun's built-in SQLite
- `search_messages` and `search_rooms` are intentionally strict: if the cache is missing, they fail and tell you which sync tool to run

### Webhooks

This MCP can manage Webex webhook objects:

- `list_webhooks`
- `get_webhook`
- `create_webhook`
- `update_webhook`
- `delete_webhook`

Important:

- this standalone MCP does not host a webhook receiver
- the webhook tools are CRUD helpers for remote Webex webhook registration only

### Experimental Read State

These tools use a small Node-backed SDK helper because the public Webex REST API does not expose
`lastSeenDate` or read receipts:

- `list_rooms_with_read_status`
- `get_room_with_read_status`
- `mark_message_seen`

Notes:

- these tools are user-only, not bot-only
- they fail fast with a timeout if the SDK cannot reach the underlying internal Webex services
- the main MCP server still runs under Bun; only the helper uses `node`

### Experimental Internal Conversation

These tools also use the Node-backed SDK helper because they are internal conversation surfaces rather
than public REST APIs:

- `update_typing_status`
- `list_threads`
- `add_reaction`
- `delete_reaction`
- `set_conversation_state`

Notes:

- these are user-only, not bot-only
- they use internal SDK paths and may time out if the required internal Webex services are unavailable
- `list_threads` is room-scoped and derives thread roots from public room messages grouped by `parentId`
- `list_thread_replies` is different: it is a normal MCP wrapper over `list_messages(parentId=...)`

### Meetings And Recordings

These tools use the Webex meeting APIs with the user OAuth token:

- `create_meeting`
- `list_recordings`
- `list_meetings`
- `list_meeting_participants`
- `get_meeting`
- `update_meeting`
- `delete_meeting`
- `get_meeting_preferences`
- `list_meeting_preference_sites`
- `get_meeting_audio_preferences`
- `update_meeting_audio_preferences`
- `get_meeting_scheduling_preferences`
- `update_meeting_scheduling_preferences`
- `get_personal_meeting_room_preferences`
- `update_personal_meeting_room_preferences`
- `get_meeting_controls`
- `update_meeting_controls`
- `inspect_meeting_assets`
- `get_recording`
- `get_recording_transcript`
- `list_meeting_transcripts`
- `get_meeting_transcript`
- `search_meeting_transcript`
- `sync_recent_meeting_content`
- `search_meeting_content`

Notes:

- they are user-only, not bot-only
- they require the user meeting OAuth scopes present in your configured OAuth setup
- meeting CRUD uses the normal `/meetings` APIs and was verified live against the current OAuth token
- top-level `meetingPreferences` is read-only; writable preference surfaces are `audio`, `schedulingOptions`, and `personalMeetingRoom`
- `update_meeting_audio_preferences` automatically normalizes empty phone numbers so the Webex API accepts the payload
- meeting controls are a live-meeting surface; the MCP exposes the raw controls object, but the resource only exists when Webex exposes `/meetings/{meetingId}/controls`
- `list_meeting_participants` exposes actual meeting attendance rows when Webex makes participant data available to the OAuth user
- `get_recording_transcript` uses the temporary transcript link exposed by the recording detail response when one exists
- `get_meeting_transcript` downloads either `txt` or `vtt` content directly from the transcript download link
- `sync_recent_meeting_content` indexes transcript text from both transcript endpoints and recording transcript links into the local SQLite index

### Webex Calling CDR

These tools use the Webex Calling Detailed Call History APIs:

- `list_call_detail_records`
- `list_live_call_detail_records`

Notes:

- they are user-only, not bot-only
- they require `spark-admin:calling_cdr_read` on the OAuth grant
- the authenticating user must also have the Control Hub role `Webex Calling Detailed Call History API access`
- `list_call_detail_records` calls `analytics-calling.webexapis.com/v1/cdr_feed` and is limited to 12 hours per request
- `list_live_call_detail_records` calls `analytics-calling.webexapis.com/v1/cdr_stream` and is limited to 2 hours per request
- if Webex returns a regional endpoint hint, set `WEBEX_CALLING_CDR_BASE_URL` or pass `baseUrl` to the tool
- `spark-admin:locations_read` is optional, but useful when filtering or labeling CDR results by Webex Calling location

### Install

```bash
cd webex-mcp
bun install
python3 -m pip install -r requirements.txt
```

### Webex App Setup

If you want this repo to work as a standalone integration:

1. Create a Webex integration at `https://developer.webex.com/my-apps`.
2. Add a redirect URI that matches your env file.
   Example: `http://localhost:8765/oauth/callback`
3. Enable the scopes in `.env.example` / `WEBEX_OAUTH_SCOPES`.
4. Copy `.env.example` to `.env.local` and fill in:
   - `WEBEX_CLIENT_ID`
   - `WEBEX_CLIENT_SECRET`
   - `WEBEX_REDIRECT_URI`
5. Run the OAuth login helper once.

### OAuth And Reauth

The standalone repo now includes a local OAuth helper:

```bash
cd webex-mcp
bun run auth:login
```

What it does:

- starts a tiny local callback listener using `WEBEX_REDIRECT_URI`
- opens the Webex authorization URL in your browser
- exchanges the returned code for tokens
- writes the token file configured by `WEBEX_OAUTH_TOKEN_FILE`

Useful commands:

```bash
bun run auth:status
bun run auth:refresh
bun run auth:clear
```

Notes:

- normal access-token expiry does not require a full reauth; `server.mjs` already refreshes via the stored `refresh_token`
- you usually only need `auth:login` again when scopes change, the refresh token expires, or the grant is revoked
- if you prefer another env file, use `bun oauth.mjs <command> --env-file /abs/path/.env.local`
- when `--env-file` is passed, that file is authoritative over Bun's auto-loaded env variables

### Publish Safety

Before publishing or sharing this repo:

- keep real credentials only in ignored env files such as `.env.local`
- keep OAuth grants only in the token file configured by `WEBEX_OAUTH_TOKEN_FILE`
- do not commit your local state dir because it can contain cached room history, downloads, and SQLite indexes
- local file access is intentionally off by default; only enable it with a tight `WEBEX_MCP_LOCAL_FILE_ROOTS` allowlist
- review README examples if you adapted them to a local environment

This repo already ignores:

- `.env*` except `.env.example`
- `.data/`
- `node_modules/`

### Run

If you are reusing another app's env file:

```bash
cd webex-mcp
bun server.mjs --env-file /path/to/other/.env.local
```

If you want this repo to own its own env file:

```bash
cd webex-mcp
cp .env.example .env.local
bun server.mjs --env-file .env.local
```

Standalone flow:

```bash
cd webex-mcp
cp .env.example .env.local
bun run auth:login
bun run start
```

### Codex Config

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.webex]
command = "bun"
args = ["/absolute/path/to/webex-mcp/server.mjs", "--env-file", "/absolute/path/to/webex-mcp/.env.local"]
```

Then restart Codex so it loads the new MCP server.

### Claude Code Config

If you want Claude Code to use this same local MCP instead of a hosted Webex endpoint,
point its plugin or `.mcp.json` entry at the same stdio server:

```json
{
  "mcpServers": {
    "webex": {
      "type": "stdio",
      "command": "bun",
      "args": [
        "/absolute/path/to/webex-mcp/server.mjs",
        "--env-file",
        "/absolute/path/to/webex-mcp/.env.local"
      ]
    }
  }
}
```

If Claude points at a remote HTTP MCP while Codex points at this local repo, fixes in this repo
will only affect Codex.

### Tool Schema Compatibility

Some MCP clients reject tool parameter schemas unless the top-level `inputSchema` is a plain
`type: "object"` without top-level `allOf`, `anyOf`, `oneOf`, `enum`, or `not`.

This repo now validates that constraint at load time and in `bun run check`.

When a tool needs conditional requirements such as "provide `meetingId` or `recordingId`", keep
the runtime guard in code and describe the constraint in the relevant property descriptions instead
of using top-level schema combinators.

### Useful Env Vars

- `WEBEX_OAUTH_TOKEN_FILE` overrides the token file location. By default it uses your per-user state dir.
- `WEBEX_MCP_DOWNLOAD_DIR` overrides the download directory for file tools. By default it uses your per-user state dir.
- `WEBEX_MCP_INDEX_DB` overrides the SQLite index path. By default it uses your per-user state dir.
- `WEBEX_MCP_ENABLE_LOCAL_FILES=true` enables `filePaths` uploads and `extract_local_file_text`.
- `WEBEX_MCP_LOCAL_FILE_ROOTS` is a `:`-separated allowlist for local file access.
