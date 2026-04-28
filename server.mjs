#!/usr/bin/env bun

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import {spawn, spawnSync} from 'node:child_process';
import {ensurePrivateDir, readJsonFile, writeJsonFile, withLockedFile} from './auth-store.mjs';

const SERVER_NAME = 'webex';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_STATE_DIR = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'),
  'webex-mcp'
);
const DEFAULT_DOWNLOAD_DIR = path.join(DEFAULT_STATE_DIR, 'downloads');
const DEFAULT_INDEX_DB = path.join(DEFAULT_STATE_DIR, 'index.sqlite');
const DEFAULT_TOKEN_FILE = path.join(DEFAULT_STATE_DIR, 'tokens.json');
const DEFAULT_PAGE_SIZE = 50;
const MAX_WRITABLE_GROUP_MEMBERS = 19;
const DEFAULT_CALLING_CDR_BASE_URL = 'https://analytics-calling.webexapis.com/v1';
const MAX_CDR_FEED_WINDOW_MS = 12 * 60 * 60 * 1000;
const MAX_CDR_STREAM_WINDOW_MS = 2 * 60 * 60 * 1000;

function parseArgs(argv) {
  const out = {
    envFile: process.env.ENV_FILE || '',
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--env-file' && next) {
      out.envFile = next;
      index += 1;
    }
  }

  return out;
}

function parseEnvFile(file) {
  if (!file || !fs.existsSync(file)) return {};

  const text = fs.readFileSync(file, 'utf8');
  const env = {};

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const idx = line.indexOf('=');
    if (idx < 0) continue;

    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

function loadConfig(envFile) {
  const fileEnv = parseEnvFile(envFile);
  const inheritedEnv = {...process.env};

  if (envFile) {
    for (const key of Object.keys(inheritedEnv)) {
      if (key.startsWith('WEBEX_')) {
        delete inheritedEnv[key];
      }
    }
  }

  const env = envFile
    ? {
        ...inheritedEnv,
        ...fileEnv,
      }
    : {
        ...fileEnv,
        ...inheritedEnv,
      };

  return {
    envFile,
    envDir: envFile ? path.dirname(envFile) : process.cwd(),
    env,
  };
}

function resolveMaybeRelative(baseDir, value, fallback = '') {
  if (!value) return fallback;
  if (path.isAbsolute(value)) return value;
  return path.join(baseDir, value);
}

function getTokenFilePath(config) {
  const configured = config.env.WEBEX_OAUTH_TOKEN_FILE || DEFAULT_TOKEN_FILE;
  return resolveMaybeRelative(config.envDir, configured);
}

function getOauthFile(config) {
  return readJsonFile(getTokenFilePath(config), null, {strict: true});
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text;
  }

  return {response, body};
}

function parseNextLinkHeader(linkHeader) {
  const value = `${linkHeader || ''}`.trim();
  if (!value) return null;

  for (const rawPart of value.split(',')) {
    const part = rawPart.trim();
    const match = part.match(/^<([^>]+)>\s*;\s*rel="?([^"]+)"?/i);
    if (!match) continue;
    if (match[2].toLowerCase() !== 'next') continue;
    return match[1];
  }

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelayMs(response, attempt) {
  const retryAfter = Number.parseFloat(response.headers.get('retry-after') || '');
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.ceil(retryAfter * 1000);
  }

  return Math.min(1000 * 2 ** attempt, 8000);
}

async function refreshUserToken(config) {
  const clientId = config.env.WEBEX_CLIENT_ID;
  const clientSecret = config.env.WEBEX_CLIENT_SECRET;
  const redirectUri = config.env.WEBEX_REDIRECT_URI;
  const tokenFilePath = getTokenFilePath(config);
  return withLockedFile(tokenFilePath, async () => {
    const tokens = getOauthFile(config);

    if (!clientId || !clientSecret || !redirectUri || !tokens?.refresh_token) {
      throw new Error('Missing Webex OAuth refresh configuration');
    }

    if (Number(tokens.expires_at || 0) > Date.now() + 60_000) {
      return tokens;
    }

    const form = new URLSearchParams();
    form.set('grant_type', 'refresh_token');
    form.set('client_id', clientId);
    form.set('client_secret', clientSecret);
    form.set('refresh_token', tokens.refresh_token);
    form.set('redirect_uri', redirectUri);

    const {response, body} = await fetchJson('https://webexapis.com/v1/access_token', {
      method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded'},
      body: form.toString(),
    });

    if (!response.ok) {
      const error = new Error(`Webex OAuth refresh failed with ${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }

    const now = Date.now();
    const refreshed = {
      ...tokens,
      ...body,
      obtained_at: now,
      expires_at: now + Number(body.expires_in || 0) * 1000,
    };

    writeJsonFile(tokenFilePath, refreshed);
    return refreshed;
  });
}

async function getUserToken(config, {refreshIfNeeded = true} = {}) {
  if (config.env.WEBEX_USER_TOKEN) return config.env.WEBEX_USER_TOKEN;

  const tokens = readJsonFile(getTokenFilePath(config), null, {strict: refreshIfNeeded});
  if (!tokens?.access_token) return null;
  if (!refreshIfNeeded) return tokens.access_token;

  if (Number(tokens.expires_at || 0) > Date.now() + 60_000) {
    return tokens.access_token;
  }

  const refreshed = await refreshUserToken(config);
  return refreshed.access_token;
}

function isPlainObject(value) {
  return Boolean(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function buildQuery(params = {}) {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, Array.isArray(value) ? value.join(',') : `${value}`);
  }

  const encoded = query.toString();
  return encoded ? `?${encoded}` : '';
}

function trimTrailingSlash(value) {
  return `${value || ''}`.replace(/\/+$/, '');
}

function absolutePath(baseDir, value) {
  if (!value) return value;
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(`${value || ''}`.trim());
}

function getAllowedLocalFileRoots(config) {
  const raw = `${config.env.WEBEX_MCP_LOCAL_FILE_ROOTS || ''}`.trim();
  if (!raw) return [];

  return raw
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => absolutePath(config.envDir, item));
}

function resolveAllowedLocalPath(config, inputPath) {
  if (!isTruthyEnv(config.env.WEBEX_MCP_ENABLE_LOCAL_FILES)) {
    throw new Error(
      'Local file access is disabled. Set WEBEX_MCP_ENABLE_LOCAL_FILES=true and WEBEX_MCP_LOCAL_FILE_ROOTS to allow filePaths or extract_local_file_text.'
    );
  }

  const allowedRoots = getAllowedLocalFileRoots(config);
  if (!allowedRoots.length) {
    throw new Error(
      'Local file access is enabled but WEBEX_MCP_LOCAL_FILE_ROOTS is empty. Configure one or more allowed roots.'
    );
  }

  const resolvedPath = absolutePath(config.envDir, inputPath);
  const normalizedPath = path.normalize(resolvedPath);
  const allowed = allowedRoots.some((root) => {
    const normalizedRoot = path.normalize(root);
    return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${path.sep}`);
  });

  if (!allowed) {
    throw new Error(`Local path ${resolvedPath} is outside WEBEX_MCP_LOCAL_FILE_ROOTS.`);
  }

  return resolvedPath;
}

function sanitizeFilename(value) {
  return `${value || 'download'}`.replace(/[^\w.\-]+/g, '_');
}

function parseFilenameFromContentDisposition(value) {
  if (!value) return null;
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) return decodeURIComponent(utf8Match[1]);
  const plainMatch = value.match(/filename="?([^";]+)"?/i);
  return plainMatch ? plainMatch[1] : null;
}

function limitText(text, max = 12000) {
  if (!text || text.length <= max) return text || '';
  return `${text.slice(0, max)}\n\n[truncated ${text.length - max} chars]`;
}

function contentText(text) {
  return {content: [{type: 'text', text}]};
}

function jsonText(value) {
  return contentText(JSON.stringify(value, null, 2));
}

function errorText(message, extra = null) {
  const text = extra ? `${message}\n\n${extra}` : message;
  return {content: [{type: 'text', text}], isError: true};
}

function createWebexApi(token, {baseDir, resolveLocalPath, cdrBaseUrl} = {}) {
  const callingCdrBaseUrl = trimTrailingSlash(cdrBaseUrl || DEFAULT_CALLING_CDR_BASE_URL);

  async function request(endpoint, {method = 'GET', body, headers = {}} = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `https://webexapis.com/v1${endpoint}`;
    const requestHeaders = {
      Authorization: `Bearer ${token}`,
      ...headers,
    };

    let payload = body;
    if (isPlainObject(body)) {
      requestHeaders['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: payload,
      });

      if (response.ok) {
        if (response.status === 204) return undefined;
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          return response.json();
        }

        const text = await response.text();
        return text;
      }

      let responseBody;
      try {
        responseBody = await response.json();
      } catch {
        responseBody = await response.text();
      }

      if (response.status === 429 && attempt < 4) {
        await sleep(getRetryDelayMs(response, attempt));
        continue;
      }

      const error = new Error(`Webex API ${method} ${endpoint} failed with ${response.status}`);
      error.status = response.status;
      error.body = responseBody;
      throw error;
    }
  }

  async function listCollection(resource, options = {}, pageSize = DEFAULT_PAGE_SIZE) {
    const total = Number(options.max || pageSize);
    const perPage = Math.min(Math.max(total, 1), 100);
    const query = {...options, max: perPage};
    let url = `https://webexapis.com/v1${resource}${buildQuery(query)}`;
    const items = [];

    while (url && items.length < total) {
      const {response, body} = await fetchJson(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        const error = new Error(`Webex API GET ${resource} failed with ${response.status}`);
        error.status = response.status;
        error.body = body;
        throw error;
      }

      items.push(...(body.items || []));
      url = body.next || parseNextLinkHeader(response.headers.get('link')) || null;
    }

    return items.slice(0, total);
  }

  async function listAbsoluteCollection(initialUrl, label, options = {}, pageSize = DEFAULT_PAGE_SIZE) {
    const total = Number(options.max || pageSize);
    const items = [];
    let url = initialUrl;

    while (url && items.length < total) {
      let response;
      let body;
      for (let attempt = 0; ; attempt += 1) {
        ({response, body} = await fetchJson(url, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }));

        if (response.ok || response.status !== 429 || attempt >= 4) break;
        await sleep(getRetryDelayMs(response, attempt));
      }

      if (!response.ok) {
        const error = new Error(`Webex API GET ${label} failed with ${response.status}`);
        error.status = response.status;
        error.body = body;
        throw error;
      }

      items.push(...(body.items || []));
      url = body.next || parseNextLinkHeader(response.headers.get('link')) || null;
    }

    return items.slice(0, total);
  }

  function listCallingCdrCollection(resource, options = {}, pageSize = DEFAULT_PAGE_SIZE) {
    const total = Number(options.max || pageSize);
    const perPage = Math.min(Math.max(total, 1), 100);
    const query = {
      ...options,
      max: perPage,
    };
    delete query.baseUrl;
    delete query.endpoint;

    const baseUrl = trimTrailingSlash(options.baseUrl || callingCdrBaseUrl);
    const url = `${baseUrl}${resource}${buildQuery(query)}`;
    return listAbsoluteCollection(url, `${baseUrl}${resource}`, options, pageSize);
  }

  function buildMultipartMessage(message) {
    const form = new FormData();
    const scalarFields = [
      'roomId',
      'toPersonEmail',
      'toPersonId',
      'parentId',
      'text',
      'markdown',
      'html',
    ];

    for (const key of scalarFields) {
      if (message[key]) form.append(key, message[key]);
    }

    for (const url of message.fileUrls || []) {
      form.append('files', url);
    }

    for (const input of message.filePaths || []) {
      if (!resolveLocalPath) {
        throw new Error('Local file uploads are disabled for this Webex API context.');
      }
      const filePath = resolveLocalPath(input);
      const fileBuffer = fs.readFileSync(filePath);
      const blob = new Blob([fileBuffer]);
      form.append('files', blob, path.basename(filePath));
    }

    if (Array.isArray(message.attachments) && message.attachments.length) {
      form.append('attachments', JSON.stringify(message.attachments));
    }

    return form;
  }

  return {
    request,
    getMe() {
      return request('/people/me');
    },
    getPerson(personId) {
      return request(`/people/${encodeURIComponent(personId)}`);
    },
    listPeople(options = {}) {
      return listCollection('/people', options, Number(options.max || 25));
    },
    getRoom(roomId) {
      return request(`/rooms/${encodeURIComponent(roomId)}`);
    },
    listRooms(options = {}) {
      return listCollection('/rooms', options, Number(options.max || DEFAULT_PAGE_SIZE));
    },
    createRoom(body) {
      return request('/rooms', {method: 'POST', body});
    },
    getMembership(membershipId) {
      return request(`/memberships/${encodeURIComponent(membershipId)}`);
    },
    listMemberships(options = {}) {
      return listCollection('/memberships', options, Number(options.max || 100));
    },
    createMembership(body) {
      return request('/memberships', {method: 'POST', body});
    },
    deleteMembership(membershipId) {
      return request(`/memberships/${encodeURIComponent(membershipId)}`, {method: 'DELETE'});
    },
    updateMembership(membershipId, body) {
      return request(`/memberships/${encodeURIComponent(membershipId)}`, {
        method: 'PUT',
        body,
      });
    },
    getMessage(messageId) {
      return request(`/messages/${encodeURIComponent(messageId)}`);
    },
    listMessages(options = {}) {
      return listCollection('/messages', options, Number(options.max || 50));
    },
    createMessage(message) {
      const useMultipart = (message.filePaths || []).length > 0;
      return request('/messages', {
        method: 'POST',
        body: useMultipart
          ? buildMultipartMessage(message)
          : {
              roomId: message.roomId,
              toPersonEmail: message.toPersonEmail,
              toPersonId: message.toPersonId,
              parentId: message.parentId,
              text: message.text,
              markdown: message.markdown,
              html: message.html,
              files: message.fileUrls?.length ? message.fileUrls : undefined,
              attachments: message.attachments,
            },
      });
    },
    updateMessage(messageId, body) {
      return request(`/messages/${encodeURIComponent(messageId)}`, {
        method: 'PUT',
        body,
      });
    },
    deleteMessage(messageId) {
      return request(`/messages/${encodeURIComponent(messageId)}`, {
        method: 'DELETE',
      });
    },
    listMeetings(options = {}) {
      return listCollection('/meetings', options, Number(options.max || 20));
    },
    createMeeting(body) {
      return request('/meetings', {method: 'POST', body});
    },
    getMeeting(meetingId) {
      return request(`/meetings/${encodeURIComponent(meetingId)}`);
    },
    updateMeeting(meetingId, body, {replace = false} = {}) {
      return request(`/meetings/${encodeURIComponent(meetingId)}`, {
        method: replace ? 'PUT' : 'PATCH',
        body,
      });
    },
    deleteMeeting(meetingId) {
      return request(`/meetings/${encodeURIComponent(meetingId)}`, {method: 'DELETE'});
    },
    getMeetingPreferences() {
      return request('/meetingPreferences');
    },
    listMeetingPreferenceSites() {
      return request('/meetingPreferences/sites');
    },
    getMeetingAudioPreferences() {
      return request('/meetingPreferences/audio');
    },
    updateMeetingAudioPreferences(body) {
      return request('/meetingPreferences/audio', {method: 'PUT', body});
    },
    getMeetingSchedulingPreferences() {
      return request('/meetingPreferences/schedulingOptions');
    },
    updateMeetingSchedulingPreferences(body) {
      return request('/meetingPreferences/schedulingOptions', {method: 'PUT', body});
    },
    getPersonalMeetingRoomPreferences() {
      return request('/meetingPreferences/personalMeetingRoom');
    },
    updatePersonalMeetingRoomPreferences(body) {
      return request('/meetingPreferences/personalMeetingRoom', {method: 'PUT', body});
    },
    getMeetingControls(meetingId) {
      return request(`/meetings/${encodeURIComponent(meetingId)}/controls`);
    },
    updateMeetingControls(meetingId, body) {
      return request(`/meetings/${encodeURIComponent(meetingId)}/controls`, {
        method: 'PUT',
        body,
      });
    },
    listMeetingSummaries(options = {}) {
      return listCollection('/meetingSummaries', options, Number(options.max || 20));
    },
    listMeetingParticipants(options = {}) {
      return listCollection('/meetingParticipants', options, Number(options.max || 100));
    },
    listActiveCalls() {
      return request('/telephony/calls');
    },
    listUserCallHistory(options = {}) {
      return listCollection('/telephony/calls/history', options, Number(options.max || 100));
    },
    getRecording(recordingId) {
      return request(`/recordings/${encodeURIComponent(recordingId)}`);
    },
    listRecordings(options = {}) {
      return listCollection('/recordings', options, Number(options.max || 20));
    },
    listMeetingTranscripts(options = {}) {
      return listCollection('/meetingTranscripts', options, Number(options.max || 20));
    },
    getMeetingTranscript(transcriptId) {
      return request(`/meetingTranscripts/${encodeURIComponent(transcriptId)}`);
    },
    listMeetingTranscriptSnippets(transcriptId, options = {}) {
      return listCollection(
        `/meetingTranscripts/${encodeURIComponent(transcriptId)}/snippets`,
        options,
        Number(options.max || 100)
      );
    },
    listCallDetailRecords(options = {}) {
      return listCallingCdrCollection('/cdr_feed', options, Number(options.max || 100));
    },
    listLiveCallDetailRecords(options = {}) {
      return listCallingCdrCollection('/cdr_stream', options, Number(options.max || 100));
    },
    createAttachmentAction(body) {
      return request('/attachment/actions', {
        method: 'POST',
        body,
      });
    },
    getAttachmentAction(attachmentActionId) {
      return request(`/attachment/actions/${encodeURIComponent(attachmentActionId)}`);
    },
    createWebhook(body) {
      return request('/webhooks', {
        method: 'POST',
        body,
      });
    },
    getWebhook(webhookId) {
      return request(`/webhooks/${encodeURIComponent(webhookId)}`);
    },
    listWebhooks(options = {}) {
      return listCollection('/webhooks', options, Number(options.max || 100));
    },
    updateWebhook(webhookId, body) {
      return request(`/webhooks/${encodeURIComponent(webhookId)}`, {
        method: 'PUT',
        body,
      });
    },
    deleteWebhook(webhookId) {
      return request(`/webhooks/${encodeURIComponent(webhookId)}`, {
        method: 'DELETE',
      });
    },
    createTeam(body) {
      return request('/teams', {
        method: 'POST',
        body,
      });
    },
    getTeam(teamId) {
      return request(`/teams/${encodeURIComponent(teamId)}`);
    },
    listTeams(options = {}) {
      return listCollection('/teams', options, Number(options.max || 100));
    },
    updateTeam(teamId, body) {
      return request(`/teams/${encodeURIComponent(teamId)}`, {
        method: 'PUT',
        body,
      });
    },
    createTeamMembership(body) {
      return request('/team/memberships', {
        method: 'POST',
        body,
      });
    },
    getTeamMembership(teamMembershipId) {
      return request(`/team/memberships/${encodeURIComponent(teamMembershipId)}`);
    },
    listTeamMemberships(options = {}) {
      return listCollection('/team/memberships', options, Number(options.max || 100));
    },
    updateTeamMembership(teamMembershipId, body) {
      return request(`/team/memberships/${encodeURIComponent(teamMembershipId)}`, {
        method: 'PUT',
        body,
      });
    },
    deleteTeamMembership(teamMembershipId) {
      return request(`/team/memberships/${encodeURIComponent(teamMembershipId)}`, {
        method: 'DELETE',
      });
    },
    async downloadFile(url) {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        const error = new Error(`Webex file download failed with ${response.status}`);
        error.status = response.status;
        error.body = await response.text();
        throw error;
      }

      const arrayBuffer = await response.arrayBuffer();
      return {
        bytes: Buffer.from(arrayBuffer),
        contentType: response.headers.get('content-type') || 'application/octet-stream',
        contentDisposition: response.headers.get('content-disposition') || '',
      };
    },
    async downloadText(url) {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        const error = new Error(`Webex text download failed with ${response.status}`);
        error.status = response.status;
        error.body = await response.text();
        throw error;
      }

      return {
        text: await response.text(),
        contentType: response.headers.get('content-type') || 'text/plain',
      };
    },
  };
}

const runtime = {
  bot: null,
  user: null,
  index: null,
  sdkHelper: null,
  sqliteBackend: null,
  sqliteLoadError: null,
};

function closeSdkHelper() {
  const helper = runtime.sdkHelper;
  if (!helper) return;

  runtime.sdkHelper = null;
  helper.closed = true;

  for (const pending of helper.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error('SDK helper was closed.'));
  }
  helper.pending.clear();

  try {
    helper.rl.close();
  } catch {}
  try {
    helper.child.kill();
  } catch {}
}

process.on('exit', () => {
  closeSdkHelper();
});

async function getActorContext(config, actor = 'auto') {
  let preferred = actor;

  if (actor === 'auto') {
    const hasConfiguredUserAuth = Boolean(
      config.env.WEBEX_USER_TOKEN || fs.existsSync(getTokenFilePath(config))
    );

    if (!hasConfiguredUserAuth) {
      preferred = 'bot';
    } else {
      const userToken = await getUserToken(config, {refreshIfNeeded: true});
      if (!userToken) {
        throw new Error(
          'User-scoped Webex auth is configured but unavailable. Fix WEBEX_USER_TOKEN or the OAuth token file instead of relying on actor:auto.'
        );
      }
      preferred = 'user';
    }
  }

  if (preferred === 'bot') {
    if (runtime.bot) return runtime.bot;
    if (!config.env.WEBEX_BOT_TOKEN) throw new Error('WEBEX_BOT_TOKEN is required for bot-scoped actions');
    const api = createWebexApi(config.env.WEBEX_BOT_TOKEN, {
      baseDir: config.envDir,
      resolveLocalPath: (input) => resolveAllowedLocalPath(config, input),
      cdrBaseUrl: config.env.WEBEX_CALLING_CDR_BASE_URL,
    });
    const me = await api.getMe();
    runtime.bot = {actor: 'bot', api, me};
    return runtime.bot;
  }

  const token = await getUserToken(config, {refreshIfNeeded: true});
  if (!token) {
    throw new Error(
      'User-scoped Webex auth is unavailable. Configure WEBEX_USER_TOKEN or OAuth refresh credentials.'
    );
  }

  if (runtime.user?.token === token) return runtime.user;
  if (runtime.user?.token && runtime.user.token !== token) {
    closeSdkHelper();
  }

  const api = createWebexApi(token, {
    baseDir: config.envDir,
    resolveLocalPath: (input) => resolveAllowedLocalPath(config, input),
    cdrBaseUrl: config.env.WEBEX_CALLING_CDR_BASE_URL,
  });
  const me = await api.getMe();
  runtime.user = {actor: 'user', api, me, token};
  return runtime.user;
}

async function getUserScopedContext(config, actor = 'auto') {
  const context = await getActorContext(config, actor);
  if (context.actor !== 'user') {
    throw new Error(
      'This tool requires user-scoped OAuth because Webex meeting transcript APIs do not support bot tokens.'
    );
  }

  return context;
}

function getIndexDbPath(config) {
  return resolveMaybeRelative(config.envDir, config.env.WEBEX_MCP_INDEX_DB, DEFAULT_INDEX_DB);
}

async function loadSqliteModule() {
  if (runtime.sqliteBackend) return runtime.sqliteBackend;
  if (runtime.sqliteLoadError) return null;

  try {
    if (!process.versions?.bun) {
      throw new Error('This standalone MCP expects Bun for SQLite-backed indexing.');
    }

    const {Database} = await import('bun:sqlite');
    runtime.sqliteBackend = {
      name: 'bun:sqlite',
      open(file) {
        const db = new Database(file);
        return {
          exec(sql) {
            db.exec(sql);
          },
          prepare(sql) {
            return db.query(sql);
          },
        };
      },
    };
    return runtime.sqliteBackend;
  } catch (error) {
    runtime.sqliteLoadError = error;
    return null;
  }
}

function initializeIndexSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS rooms (
      actor TEXT NOT NULL,
      id TEXT NOT NULL,
      uuid TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT '',
      last_activity TEXT,
      created TEXT,
      indexed_at INTEGER NOT NULL,
      PRIMARY KEY (actor, id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      actor TEXT NOT NULL,
      id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      room_type TEXT NOT NULL DEFAULT '',
      parent_id TEXT,
      person_id TEXT,
      person_email TEXT,
      text TEXT NOT NULL DEFAULT '',
      markdown TEXT NOT NULL DEFAULT '',
      files_json TEXT NOT NULL DEFAULT '[]',
      attachment_text TEXT NOT NULL DEFAULT '',
      created TEXT,
      updated TEXT,
      indexed_at INTEGER NOT NULL,
      PRIMARY KEY (actor, id)
    );

    CREATE TABLE IF NOT EXISTS meeting_content (
      actor TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      meeting_id TEXT,
      recording_id TEXT,
      title TEXT NOT NULL DEFAULT '',
      host_email TEXT NOT NULL DEFAULT '',
      created TEXT,
      content TEXT NOT NULL DEFAULT '',
      indexed_at INTEGER NOT NULL,
      PRIMARY KEY (actor, source_type, source_id)
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      actor TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      last_synced_at INTEGER NOT NULL,
      cursor TEXT,
      PRIMARY KEY (actor, scope, scope_id)
    );

    CREATE INDEX IF NOT EXISTS idx_rooms_actor_type_activity
      ON rooms(actor, type, last_activity DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_actor_room_created
      ON messages(actor, room_id, created DESC);
    CREATE INDEX IF NOT EXISTS idx_meeting_content_actor_created
      ON meeting_content(actor, created DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
      actor UNINDEXED,
      message_id UNINDEXED,
      room_id UNINDEXED,
      room_type UNINDEXED,
      room_title,
      person_email,
      text,
      markdown,
      files,
      attachment_text,
      tokenize = 'unicode61'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS meeting_content_search USING fts5(
      actor UNINDEXED,
      source_type UNINDEXED,
      source_id UNINDEXED,
      meeting_id UNINDEXED,
      recording_id UNINDEXED,
      title,
      host_email,
      content,
      tokenize = 'unicode61'
    );
  `);
}

function createIndexStatements(db) {
  return {
    countActorMessages: db.prepare('SELECT COUNT(*) AS count FROM messages WHERE actor = ?'),
    countRoomMessages: db.prepare('SELECT COUNT(*) AS count FROM messages WHERE actor = ? AND room_id = ?'),
    countActorMeetingContent: db.prepare(
      'SELECT COUNT(*) AS count FROM meeting_content WHERE actor = ?'
    ),
    upsertRoom: db.prepare(`
      INSERT INTO rooms (actor, id, uuid, title, type, last_activity, created, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(actor, id) DO UPDATE SET
        uuid = excluded.uuid,
        title = excluded.title,
        type = excluded.type,
        last_activity = excluded.last_activity,
        created = excluded.created,
        indexed_at = excluded.indexed_at
    `),
    upsertMessage: db.prepare(`
      INSERT INTO messages (
        actor, id, room_id, room_type, parent_id, person_id, person_email,
        text, markdown, files_json, attachment_text, created, updated, indexed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(actor, id) DO UPDATE SET
        room_id = excluded.room_id,
        room_type = excluded.room_type,
        parent_id = excluded.parent_id,
        person_id = excluded.person_id,
        person_email = excluded.person_email,
        text = excluded.text,
        markdown = excluded.markdown,
        files_json = excluded.files_json,
        attachment_text = excluded.attachment_text,
        created = excluded.created,
        updated = excluded.updated,
        indexed_at = excluded.indexed_at
    `),
    deleteSearchMessage: db.prepare('DELETE FROM message_search WHERE actor = ? AND message_id = ?'),
    insertSearchMessage: db.prepare(`
      INSERT INTO message_search (
        actor, message_id, room_id, room_type, room_title, person_email, text, markdown, files, attachment_text
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    upsertMeetingContent: db.prepare(`
      INSERT INTO meeting_content (
        actor, source_type, source_id, meeting_id, recording_id, title, host_email, created, content, indexed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(actor, source_type, source_id) DO UPDATE SET
        meeting_id = excluded.meeting_id,
        recording_id = excluded.recording_id,
        title = excluded.title,
        host_email = excluded.host_email,
        created = excluded.created,
        content = excluded.content,
        indexed_at = excluded.indexed_at
    `),
    deleteSearchMeetingContent: db.prepare(
      'DELETE FROM meeting_content_search WHERE actor = ? AND source_type = ? AND source_id = ?'
    ),
    insertSearchMeetingContent: db.prepare(`
      INSERT INTO meeting_content_search (
        actor, source_type, source_id, meeting_id, recording_id, title, host_email, content
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    upsertSyncState: db.prepare(`
      INSERT INTO sync_state (actor, scope, scope_id, last_synced_at, cursor)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(actor, scope, scope_id) DO UPDATE SET
        last_synced_at = excluded.last_synced_at,
        cursor = excluded.cursor
    `),
  };
}

async function getIndexStore(config) {
  const sqlite = await loadSqliteModule();
  if (!sqlite?.open) return null;

  const dbPath = getIndexDbPath(config);
  if (runtime.index?.path === dbPath) return runtime.index;

  ensurePrivateDir(path.dirname(dbPath));
  const db = sqlite.open(dbPath);
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch {}
  initializeIndexSchema(db);

  runtime.index = {
    path: dbPath,
    backend: sqlite.name,
    db,
    statements: createIndexStatements(db),
  };

  return runtime.index;
}

async function requireIndexStore(config) {
  const store = await getIndexStore(config);
  if (store) return store;

  throw new Error(
    'Local indexing is unavailable because this standalone MCP expects Bun for SQLite-backed indexing.'
  );
}

function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');

  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}

function readJsonValue(value, fallback = []) {
  if (!value) return fallback;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function buildFtsQuery(query) {
  const normalized = normalizeSearchText(query);
  const tokens = tokenizeQuery(query);
  if (!normalized || !tokens.length) return '';

  const terms = [];
  if (normalized.includes(' ')) {
    terms.push(`"${normalized.replaceAll('"', '""')}"`);
  }

  for (const token of tokens) {
    terms.push(`${token.replaceAll('"', '""')}*`);
  }

  return [...new Set(terms)].join(' OR ');
}

function indexRoom(store, actor, room) {
  store.statements.upsertRoom.run(
    actor,
    room.id,
    extractSpaceUuid(room.id),
    room.title || '',
    room.type || '',
    room.lastActivity || null,
    room.created || null,
    Date.now()
  );
}

function indexMessage(store, actor, message, room = null) {
  const files = coerceArray(message.files);
  const roomType = message.roomType || room?.type || '';
  const roomTitle = room?.title || '';
  const filesJson = JSON.stringify(files);
  const attachmentText = message.attachmentText || '';
  const indexedAt = Date.now();

  store.statements.upsertMessage.run(
    actor,
    message.id,
    message.roomId,
    roomType,
    message.parentId || null,
    message.personId || null,
    message.personEmail || '',
    message.text || '',
    message.markdown || '',
    filesJson,
    attachmentText,
    message.created || null,
    message.updated || null,
    indexedAt
  );
  store.statements.deleteSearchMessage.run(actor, message.id);
  store.statements.insertSearchMessage.run(
    actor,
    message.id,
    message.roomId,
    roomType,
    roomTitle,
    message.personEmail || '',
    message.text || '',
    message.markdown || '',
    files.join(' '),
    attachmentText
  );
}

function indexMeetingContent(store, actor, content) {
  const indexedAt = Date.now();
  store.statements.upsertMeetingContent.run(
    actor,
    content.sourceType,
    content.sourceId,
    content.meetingId || null,
    content.recordingId || null,
    content.title || '',
    content.hostEmail || '',
    content.created || null,
    content.content || '',
    indexedAt
  );
  store.statements.deleteSearchMeetingContent.run(actor, content.sourceType, content.sourceId);
  store.statements.insertSearchMeetingContent.run(
    actor,
    content.sourceType,
    content.sourceId,
    content.meetingId || null,
    content.recordingId || null,
    content.title || '',
    content.hostEmail || '',
    content.content || ''
  );
}

function markSyncState(store, actor, scope, scopeId, cursor = '') {
  store.statements.upsertSyncState.run(actor, scope, scopeId, Date.now(), cursor || '');
}

function summarizeIndexedRoom(row) {
  return {
    id: row.id,
    uuid: row.uuid || extractSpaceUuid(row.id),
    title: row.title || '',
    type: row.type || '',
    lastActivity: row.last_activity || null,
    created: row.created || null,
    isLocked: false,
  };
}

function summarizeIndexedMessage(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    roomType: row.room_type || '',
    parentId: row.parent_id || null,
    personId: row.person_id || null,
    personEmail: row.person_email || '',
    text: row.text || '',
    markdown: row.markdown || '',
    files: readJsonValue(row.files_json, []),
    created: row.created || null,
    updated: row.updated || null,
  };
}

function getIndexedRooms(store, actor) {
  return store.db
    .prepare(
      `
        SELECT id, uuid, title, type, last_activity, created
        FROM rooms
        WHERE actor = ?
        ORDER BY last_activity DESC, created DESC, title ASC
      `
    )
    .all(actor)
    .map(summarizeIndexedRoom);
}

async function searchIndexedRooms(config, actor, args = {}) {
  const store = await getIndexStore(config);
  if (!store) return null;

  const rooms = getIndexedRooms(store, actor);
  if (!rooms.length) return null;

  const filtered = args.roomType ? rooms.filter((room) => room.type === args.roomType) : rooms;
  const ranked = rankRooms(filtered, args.query, {roomType: args.roomType}).slice(0, args.maxResults || 20);

  return {
    actor,
    count: ranked.length,
    searchMode: 'localRoomCache',
    index: {
      dbPath: store.path,
      backend: store.backend,
      roomCount: rooms.length,
    },
    rooms: ranked.map((item) => ({
      score: item.score,
      room: summarizeRoom(item.room),
    })),
  };
}

function buildRoomFilterSql(roomIds = []) {
  if (!roomIds.length) return {sql: '', params: []};
  return {
    sql: ` AND m.room_id IN (${roomIds.map(() => '?').join(', ')})`,
    params: roomIds,
  };
}

function buildLocalResult(rows, query, maxResults) {
  const ranked = rows
    .map((row) => {
      const files = readJsonValue(row.files_json, []);
      return {
        row,
        lexicalScore: scoreSearchMatch(
          query,
          row.text,
          row.markdown,
          row.person_email,
          ...files,
          row.room_title || ''
        ),
      };
    })
    .filter((item) => item.lexicalScore > 0)
    .sort((left, right) => {
      if (right.lexicalScore !== left.lexicalScore) return right.lexicalScore - left.lexicalScore;
      if (left.row.search_rank !== right.row.search_rank) return left.row.search_rank - right.row.search_rank;
      return new Date(right.row.created || 0) - new Date(left.row.created || 0);
    })
    .slice(0, maxResults);

  return ranked.map((item) => ({
    score: item.lexicalScore,
    room: summarizeIndexedRoom({
      id: item.row.room_id,
      uuid: item.row.room_uuid,
      title: item.row.room_title,
      type: item.row.room_type,
      last_activity: item.row.room_last_activity,
      created: item.row.room_created,
    }),
    message: summarizeIndexedMessage(item.row),
  }));
}

async function searchIndexedMessages(config, actor, args = {}) {
  const store = await getIndexStore(config);
  if (!store) return null;

  const actorMessageCount = Number(store.statements.countActorMessages.get(actor)?.count || 0);
  if (!actorMessageCount) return null;

  let candidateRoomIds = [];
  let constrainedByRoomSelection = false;

  if (args.roomId) {
    constrainedByRoomSelection = true;
    const count = Number(store.statements.countRoomMessages.get(actor, args.roomId)?.count || 0);
    if (!count) return null;
    candidateRoomIds = [args.roomId];
  } else if (args.roomQuery || args.roomType) {
    constrainedByRoomSelection = true;
    const indexedRooms = getIndexedRooms(store, actor);
    const roomQuery = args.roomQuery || '';
    const rankedRooms = roomQuery
      ? rankRooms(indexedRooms, roomQuery, {roomType: args.roomType})
      : indexedRooms
          .filter((room) => !args.roomType || room.type === args.roomType)
          .map((room) => ({room, score: 1}));
    candidateRoomIds = rankedRooms.map((item) => item.room.id).slice(0, args.maxRooms || 20);
    if (!candidateRoomIds.length) return null;
  }

  const maxResults = args.maxResults || 20;
  const candidateLimit = Math.max(maxResults * 5, 50);
  const roomFilter = buildRoomFilterSql(candidateRoomIds);
  const ftsQuery = buildFtsQuery(args.query);
  let rows = [];

  if (ftsQuery) {
    rows = store.db
      .prepare(
        `
          SELECT
            m.*,
            r.uuid AS room_uuid,
            r.title AS room_title,
            r.type AS room_type,
            r.last_activity AS room_last_activity,
            r.created AS room_created,
            bm25(message_search) AS search_rank
          FROM message_search
          JOIN messages m
            ON m.actor = message_search.actor
           AND m.id = message_search.message_id
          LEFT JOIN rooms r
            ON r.actor = m.actor
           AND r.id = m.room_id
          WHERE message_search.actor = ?
            AND message_search MATCH ?
            ${roomFilter.sql}
          ORDER BY search_rank ASC, m.created DESC
          LIMIT ?
        `
      )
      .all(actor, ftsQuery, ...roomFilter.params, candidateLimit);
  }

  if (!rows.length) {
    const scanLimit = Math.max(candidateLimit * 10, 500);
    rows = store.db
      .prepare(
        `
          SELECT
            m.*,
            r.uuid AS room_uuid,
            r.title AS room_title,
            r.type AS room_type,
            r.last_activity AS room_last_activity,
            r.created AS room_created,
            0 AS search_rank
          FROM messages m
          LEFT JOIN rooms r
            ON r.actor = m.actor
           AND r.id = m.room_id
          WHERE m.actor = ?
            ${roomFilter.sql}
          ORDER BY m.created DESC
          LIMIT ?
        `
      )
      .all(actor, ...roomFilter.params, scanLimit);
  }

  const results = buildLocalResult(rows, args.query, maxResults);

  return {
    actor,
    count: results.length,
    searchMode: 'localIndex',
    index: {
      dbPath: store.path,
      backend: store.backend,
      messageCount: actorMessageCount,
    },
    results,
  };
}

async function searchIndexedMeetingContent(config, actor, args = {}) {
  const store = await getIndexStore(config);
  if (!store) return null;

  const actorContentCount = Number(store.statements.countActorMeetingContent.get(actor)?.count || 0);
  if (!actorContentCount) return null;

  const maxResults = args.maxResults || 20;
  const candidateLimit = Math.max(maxResults * 5, 50);
  const ftsQuery = buildFtsQuery(args.query);
  let rows = [];

  if (ftsQuery) {
    rows = store.db
      .prepare(
        `
          SELECT
            mc.*,
            bm25(meeting_content_search) AS search_rank
          FROM meeting_content_search
          JOIN meeting_content mc
            ON mc.actor = meeting_content_search.actor
           AND mc.source_type = meeting_content_search.source_type
           AND mc.source_id = meeting_content_search.source_id
          WHERE meeting_content_search.actor = ?
            AND meeting_content_search MATCH ?
          ORDER BY search_rank ASC, mc.created DESC
          LIMIT ?
        `
      )
      .all(actor, ftsQuery, candidateLimit);
  }

  if (!rows.length) {
    const scanLimit = Math.max(candidateLimit * 10, 500);
    rows = store.db
      .prepare(
        `
          SELECT
            mc.*,
            0 AS search_rank
          FROM meeting_content mc
          WHERE mc.actor = ?
          ORDER BY mc.created DESC
          LIMIT ?
        `
      )
      .all(actor, scanLimit);
  }

  const normalizedQuery = `${args.query || ''}`.trim().toLowerCase();
  const results = rows
    .filter((row) => {
      if (!normalizedQuery) return true;
      const haystack = [
        row.title || '',
        row.host_email || '',
        row.content || '',
        row.meeting_id || '',
        row.recording_id || '',
      ]
        .join('\n')
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    })
    .slice(0, maxResults)
    .map((row) => summarizeMeetingContentRow(row));

  return {
    actor,
    count: results.length,
    searchMode: 'localMeetingIndex',
    index: {
      dbPath: store.path,
      backend: store.backend,
      meetingContentCount: actorContentCount,
    },
    results,
  };
}

function coerceArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function requireDestination(args) {
  if (args.roomId || args.toPersonEmail || args.toPersonId) return;
  throw new Error('Provide at least one destination: roomId, toPersonEmail, or toPersonId.');
}

function requireMessageContent(args) {
  const hasText = Boolean(args.text || args.markdown || args.html);
  const hasFiles = coerceArray(args.filePaths).length > 0 || coerceArray(args.fileUrls).length > 0;
  const hasAttachments = Array.isArray(args.attachments) && args.attachments.length > 0;

  if (hasText || hasFiles || hasAttachments) return;
  throw new Error('Provide message content via text, markdown, html, filePaths, fileUrls, or attachments.');
}

const DISALLOWED_TOP_LEVEL_TOOL_SCHEMA_KEYS = ['allOf', 'anyOf', 'enum', 'not', 'oneOf'];

function validateToolInputSchema(tool) {
  if (!isPlainObject(tool)) {
    throw new Error('Tool definitions must be plain objects.');
  }

  if (!tool.name || typeof tool.name !== 'string') {
    throw new Error('Each tool definition must include a non-empty string name.');
  }

  if (!isPlainObject(tool.inputSchema)) {
    throw new Error(`Tool "${tool.name}" must expose inputSchema as a plain object.`);
  }

  if (tool.inputSchema.type !== 'object') {
    throw new Error(`Tool "${tool.name}" must expose an object inputSchema.`);
  }

  const forbiddenKeys = DISALLOWED_TOP_LEVEL_TOOL_SCHEMA_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(tool.inputSchema, key)
  );

  if (forbiddenKeys.length > 0) {
    throw new Error(
      `Tool "${tool.name}" uses unsupported top-level inputSchema keys: ${forbiddenKeys.join(
        ', '
      )}. Move those constraints into runtime validation or property descriptions.`
    );
  }
}

function validatePublishedToolSchemas(tools) {
  if (!Array.isArray(tools)) {
    throw new Error('Published tools must be an array.');
  }

  const seenNames = new Set();
  for (const tool of tools) {
    validateToolInputSchema(tool);
    if (seenNames.has(tool.name)) {
      throw new Error(`Duplicate tool definition found for "${tool.name}".`);
    }
    seenNames.add(tool.name);
  }

  return tools;
}

async function enforceRoomWritePolicy(context, roomId) {
  if (!roomId) return;

  const room = await context.api.getRoom(roomId);
  if (room.type !== 'group') return;

  const memberships = await context.api.listMemberships({
    roomId,
    max: MAX_WRITABLE_GROUP_MEMBERS + 1,
  });

  if (memberships.length <= MAX_WRITABLE_GROUP_MEMBERS) return;

  const title = room.title || roomId;
  throw new Error(
    `Write blocked by policy: refusing to send or update messages in group room "${title}" because it has ${memberships.length}+ members. Change the code to override this rule.`
  );
}

function getDownloadRoot(config) {
  return resolveMaybeRelative(config.envDir, config.env.WEBEX_MCP_DOWNLOAD_DIR, DEFAULT_DOWNLOAD_DIR);
}

function getExtractorPath() {
  return path.join(path.dirname(new URL(import.meta.url).pathname), 'extract_text.py');
}

function getSdkHelperPath() {
  return path.join(path.dirname(new URL(import.meta.url).pathname), 'sdk-helper.cjs');
}

function extractLocalFileText(localPath, mimeType = '') {
  const result = spawnSync('python3', [getExtractorPath(), localPath, mimeType], {
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'file extraction failed').trim());
  }

  return JSON.parse(result.stdout.trim() || '{}');
}

async function createSdkHelperClient(token) {
  const child = spawn('node', [getSdkHelperPath()], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const rl = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });

  const helper = {
    token,
    child,
    rl,
    pending: new Map(),
    nextId: 1,
    stderr: '',
    ready: false,
    closed: false,
  };

  const ready = new Promise((resolve, reject) => {
    const fail = (error) => {
      if (runtime.sdkHelper === helper) {
        runtime.sdkHelper = null;
      }
      reject(error);
    };

    child.stderr.on('data', (chunk) => {
      helper.stderr += chunk;
      if (helper.stderr.length > 8000) {
        helper.stderr = helper.stderr.slice(-8000);
      }
    });

    child.on('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      const error = new Error(helper.stderr.trim() || `SDK helper exited with ${reason}.`);
      for (const pending of helper.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      helper.pending.clear();
      if (!helper.closed) {
        fail(error);
      }
    });

    rl.on('line', (line) => {
      if (!line.trim()) return;

      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        const parseError = new Error(`SDK helper returned invalid JSON: ${error.message || String(error)}`);
        if (!helper.ready) {
          fail(parseError);
          return;
        }
        for (const pending of helper.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(parseError);
        }
        helper.pending.clear();
        return;
      }

      if (message.type === 'ready') {
        helper.ready = true;
        resolve(helper);
        return;
      }

      if (message.type !== 'response' || !message.id) return;
      const pending = helper.pending.get(message.id);
      if (!pending) return;
      helper.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error || `SDK helper failed for ${pending.command}.`));
      }
    });
  });

  child.stdin.write(JSON.stringify({type: 'init', token}) + '\n');
  return ready;
}

async function getSdkHelperClient(token) {
  if (
    runtime.sdkHelper &&
    !runtime.sdkHelper.closed &&
    runtime.sdkHelper.child.exitCode === null &&
    runtime.sdkHelper.token === token
  ) {
    return runtime.sdkHelper;
  }

  closeSdkHelper();
  runtime.sdkHelper = await createSdkHelperClient(token);
  return runtime.sdkHelper;
}

async function runSdkHelper(config, actor, command, payload = {}, timeoutMs = 30000) {
  const context = await getActorContext(config, actor);
  if (context.actor !== 'user') {
    throw new Error('The SDK helper only supports the user actor because these capabilities depend on user-scoped internal services.');
  }

  const helper = await getSdkHelperClient(context.token);
  const id = `${helper.nextId++}`;

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      helper.pending.delete(id);
      reject(new Error(`SDK helper timed out while waiting for ${command}.`));
    }, timeoutMs + 1000);

    helper.pending.set(id, {resolve, reject, timer, command});
    helper.child.stdin.write(
      JSON.stringify({
        type: 'call',
        id,
        command,
        payload: {...payload, timeoutMs},
      }) + '\n'
    );
  });
}

async function downloadFileWithOptionalExtraction(config, actor, url, options = {}) {
  const context = await getActorContext(config, actor);
  const download = await context.api.downloadFile(url);
  const outputDir = absolutePath(config.envDir, options.outputDir || getDownloadRoot(config));
  ensurePrivateDir(outputDir);

  const requestedName = options.filename ? sanitizeFilename(options.filename) : null;
  const derivedName =
    requestedName ||
    sanitizeFilename(parseFilenameFromContentDisposition(download.contentDisposition)) ||
    sanitizeFilename(path.basename(new URL(url).pathname)) ||
    'download.bin';
  const filePath = path.join(outputDir, derivedName);
  fs.writeFileSync(filePath, download.bytes);

  const result = {
    actor: context.actor,
    downloadedBy: context.me.emails?.[0] || context.me.displayName || context.me.id,
    url,
    filePath,
    contentType: download.contentType,
    byteLength: download.bytes.length,
  };

  if (options.extractText) {
    try {
      const extracted = extractLocalFileText(filePath, download.contentType);
      result.extracted = {
        ...extracted,
        text: limitText(extracted.text || '', Number(options.maxChars || 12000)),
      };
    } catch (error) {
      result.extracted = null;
      result.extractedError = error.message || String(error);
    }
  }

  return result;
}

async function getMeetingSummaryAvailability(context, meetingId, max = 5) {
  try {
    const items = await context.api.listMeetingSummaries({
      meetingId,
      max,
    });
    return {
      accessible: true,
      count: items.length,
      items,
    };
  } catch (error) {
    return {
      accessible: false,
      count: 0,
      error: error.message || String(error),
    };
  }
}

async function inspectMeetingAssets(context, args = {}) {
  const recording = args.recordingId ? await context.api.getRecording(args.recordingId) : null;
  const meetingId = args.meetingId || recording?.meetingId;

  if (!meetingId) {
    throw new Error('Provide meetingId or recordingId.');
  }

  const meeting = await context.api.getMeeting(meetingId);
  const transcripts = await context.api.listMeetingTranscripts({
    meetingId,
    max: args.maxTranscripts || 20,
  });
  const summaryInfo = await getMeetingSummaryAvailability(context, meetingId, 5);

  return {
    actor: context.actor,
    meeting: summarizeMeeting(meeting),
    recording: recording ? summarizeRecording(recording) : null,
    transcripts: transcripts.map(summarizeMeetingTranscript),
    transcriptCount: transcripts.length,
    summaryAccess: {
      accessible: summaryInfo.accessible,
      count: summaryInfo.count,
      error: summaryInfo.error || null,
    },
  };
}

async function syncRecentMeetingContentIntoIndex(config, args = {}) {
  const context = await getUserScopedContext(config, args.actor || 'auto');
  const store = await requireIndexStore(config);
  const actor = context.actor;
  const now = new Date();
  const from = args.from || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const to = args.to || now.toISOString();
  const maxRecordings = Number(args.maxRecordings || 20);
  const maxTranscripts = Number(args.maxTranscripts || 20);
  const items = [];

  const recordings = await context.api.listRecordings({
    from,
    to,
    max: maxRecordings,
  });

  for (const summary of recordings) {
    const recording = await context.api.getRecording(summary.id);
    const transcriptUrl = recording?.temporaryDirectDownloadLinks?.transcriptDownloadLink;
    if (!transcriptUrl) continue;
    const downloaded = await context.api.downloadText(transcriptUrl);
    const content = downloaded.text || '';
    const row = {
      sourceType: 'recording_transcript',
      sourceId: recording.id,
      meetingId: recording.meetingId || null,
      recordingId: recording.id,
      title: recording.topic || '',
      hostEmail: recording.hostEmail || '',
      created: recording.createTime || recording.timeRecorded || null,
      content,
    };
    items.push(row);
  }

  const transcripts = await context.api.listMeetingTranscripts({
    max: maxTranscripts,
  });

  for (const transcript of transcripts) {
    const detail = await context.api.getMeetingTranscript(transcript.id);
    const downloadUrl = detail.txtDownloadLink || detail.vttDownloadLink;
    if (!downloadUrl) continue;
    const downloaded = await context.api.downloadText(downloadUrl);
    const content = downloaded.text || '';
    const row = {
      sourceType: 'meeting_transcript',
      sourceId: detail.id,
      meetingId: detail.meetingId || null,
      recordingId: null,
      title: detail.title || '',
      hostEmail: '',
      created: detail.createTime || detail.created || null,
      content,
    };
    items.push(row);
  }

  withTransaction(store.db, () => {
    for (const item of items) {
      indexMeetingContent(store, actor, item);
    }
    markSyncState(store, actor, 'meeting_content', 'recent', '');
  });

  return {
    actor,
    indexedCount: items.length,
    sourceBreakdown: items.reduce((acc, item) => {
      acc[item.sourceType] = (acc[item.sourceType] || 0) + 1;
      return acc;
    }, {}),
    index: {
      dbPath: store.path,
      backend: store.backend,
    },
  };
}

function summarizeMessage(message) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  return {
    id: message.id,
    roomId: message.roomId,
    roomType: message.roomType,
    parentId: message.parentId || null,
    personId: message.personId,
    personEmail: message.personEmail,
    text: message.text || '',
    markdown: message.markdown || '',
    hasHtml: Boolean(message.html),
    htmlPreview: message.html ? limitText(message.html, 400) : '',
    files: message.files || [],
    attachmentCount: attachments.length,
    attachmentTypes: attachments.map((item) => item.contentType).filter(Boolean),
    created: message.created,
    updated: message.updated || null,
  };
}

function summarizeAttachmentAction(action) {
  return {
    id: action.id,
    type: action.type || action.objectType || '',
    messageId: action.messageId || null,
    roomId: action.roomId || null,
    personId: action.personId || null,
    created: action.created || null,
    inputs: isPlainObject(action.inputs) ? action.inputs : {},
  };
}

function summarizeWebhook(webhook) {
  return {
    id: webhook.id,
    resource: webhook.resource || '',
    event: webhook.event || '',
    filter: webhook.filter || '',
    targetUrl: webhook.targetUrl || '',
    name: webhook.name || '',
    created: webhook.created || null,
  };
}

function summarizeTeam(team) {
  return {
    id: team.id,
    name: team.name || '',
    created: team.created || null,
  };
}

function summarizeTeamMembership(membership) {
  return {
    id: membership.id,
    teamId: membership.teamId,
    personId: membership.personId || null,
    personEmail: membership.personEmail || '',
    isModerator: Boolean(membership.isModerator),
    created: membership.created || null,
  };
}

function summarizeReadStatusRoom(room) {
  const lastActivityDate = room.lastActivityDate || room.lastActivity || null;
  const lastSeenDate = room.lastSeenDate || null;
  return {
    id: room.id,
    title: room.title || '',
    type: room.type || '',
    lastActivityDate,
    lastSeenDate,
    isUnread: Boolean(lastActivityDate && (!lastSeenDate || new Date(lastActivityDate) > new Date(lastSeenDate))),
  };
}

function summarizeSeenUpdate(result) {
  return {
    id: result.id,
    roomId: result.roomId,
    roomType: result.roomType || '',
    lastSeenId: result.lastSeenId || null,
    created: result.created || null,
  };
}

function summarizeMeeting(meeting) {
  return {
    id: meeting.id,
    meetingNumber: meeting.meetingNumber || '',
    title: meeting.title || '',
    meetingType: meeting.meetingType || '',
    state: meeting.state || '',
    start: meeting.start || null,
    end: meeting.end || null,
    hostUserId: meeting.hostUserId || null,
    hostDisplayName: meeting.hostDisplayName || '',
    hostEmail: meeting.hostEmail || '',
    siteUrl: meeting.siteUrl || '',
    webLink: meeting.webLink || '',
    hasRecording: Boolean(meeting.hasRecording),
    hasTranscription: Boolean(meeting.hasTranscription),
    hasSummary: Boolean(meeting.hasSummary),
    hasClosedCaption: Boolean(meeting.hasClosedCaption),
  };
}

function summarizeMeetingParticipant(participant) {
  const joinedTime = participant.joinedTime || participant.joinTime || participant.joined || null;
  const leftTime = participant.leftTime || participant.leaveTime || participant.left || null;
  const durationSeconds =
    Number(participant.durationSeconds ?? participant.duration ?? participant.totalDurationSeconds ?? 0) || 0;

  return {
    id: participant.id || null,
    meetingId: participant.meetingId || null,
    meetingSeriesId: participant.meetingSeriesId || null,
    personId: participant.personId || participant.userId || null,
    personEmail: participant.personEmail || participant.email || '',
    displayName: participant.displayName || participant.name || participant.personName || '',
    state: participant.state || '',
    role: participant.role || participant.participantRole || '',
    joinedTime,
    leftTime,
    durationSeconds,
    isHost: Boolean(participant.host || participant.isHost),
    isCohost: Boolean(participant.cohost || participant.isCohost),
    deviceType: participant.deviceType || '',
    clientType: participant.clientType || '',
  };
}

function summarizeActiveCall(call) {
  return {
    id: call.id || call.callId || null,
    status: call.status || call.state || '',
    type: call.type || '',
    direction: call.direction || '',
    callerId: call.callerId || call.callingParty || null,
    calledId: call.calledId || call.calledParty || null,
    remoteParty: call.remoteParty || call.person || null,
    created: call.created || call.startTime || call.time || null,
    raw: call,
  };
}

function summarizeUserCallHistoryItem(item) {
  return {
    type: item.type || '',
    name: item.name || '',
    number: item.number || '',
    privacyEnabled: Boolean(item.privacyEnabled),
    time: item.time || item.created || null,
    durationSeconds: Number(item.durationSeconds || item.duration || 0) || null,
  };
}

function filterUserCallHistory(items, args = {}) {
  const fromMs = args.from ? parseIsoTime(args.from, 'from') : null;
  const toMs = args.to ? parseIsoTime(args.to, 'to') : null;
  const type = `${args.type || ''}`.trim().toLowerCase();
  const query = `${args.query || ''}`.trim().toLowerCase();

  return items.filter((item) => {
    const summary = summarizeUserCallHistoryItem(item);
    const itemMs = summary.time ? Date.parse(summary.time) : NaN;

    if (fromMs !== null && (!Number.isFinite(itemMs) || itemMs < fromMs)) return false;
    if (toMs !== null && (!Number.isFinite(itemMs) || itemMs > toMs)) return false;
    if (type && summary.type.toLowerCase() !== type) return false;
    if (query) {
      const haystack = `${summary.name} ${summary.number} ${summary.type}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }

    return true;
  });
}

function summarizeUserCallHistory(items) {
  const byType = {};
  let oldest = null;
  let newest = null;

  for (const item of items.map(summarizeUserCallHistoryItem)) {
    const type = item.type || 'unknown';
    byType[type] = (byType[type] || 0) + 1;
    if (item.time && (!oldest || Date.parse(item.time) < Date.parse(oldest))) oldest = item.time;
    if (item.time && (!newest || Date.parse(item.time) > Date.parse(newest))) newest = item.time;
  }

  return {
    count: items.length,
    byType,
    oldest,
    newest,
  };
}

function summarizeMeetingSitesResponse(value) {
  const sites = Array.isArray(value?.sites) ? value.sites : [];
  return {
    count: sites.length,
    sites: sites.map((site) => ({
      siteUrl: site.siteUrl || '',
      default: Boolean(site.default),
    })),
  };
}

function normalizeMeetingAudioPreferencesForUpdate(preferences = {}) {
  const audio = isPlainObject(preferences) ? {...preferences} : {};

  for (const key of ['officeNumber', 'mobileNumber']) {
    const phone = audio[key];
    if (!isPlainObject(phone)) continue;
    audio[key] = {...phone};
    if (!audio[key].number) {
      delete audio[key].number;
    }
  }

  return audio;
}

function summarizeMeetingTranscript(transcript) {
  return {
    id: transcript.id,
    meetingId: transcript.meetingId || null,
    title: transcript.title || '',
    created: transcript.createTime || transcript.created || null,
    txtUrl: transcript.txtDownloadLink || '',
    vttUrl: transcript.vttDownloadLink || '',
  };
}

function summarizeMeetingTranscriptSnippet(snippet) {
  return {
    id: snippet.id || null,
    text: snippet.text || '',
    startTime: snippet.startTime || snippet.start || null,
    endTime: snippet.endTime || snippet.end || null,
    personName: snippet.personName || '',
    speakerEmail: snippet.speakerEmail || '',
  };
}

function summarizeRecording(recording) {
  const links = isPlainObject(recording.temporaryDirectDownloadLinks)
    ? recording.temporaryDirectDownloadLinks
    : {};
  return {
    id: recording.id,
    meetingId: recording.meetingId || null,
    topic: recording.topic || '',
    created: recording.createTime || recording.created || null,
    timeRecorded: recording.timeRecorded || null,
    hostEmail: recording.hostEmail || '',
    format: recording.format || '',
    durationSeconds: Number(recording.durationSeconds || 0),
    sizeBytes: Number(recording.sizeBytes || 0),
    playbackUrl: recording.playbackUrl || '',
    downloadUrl: recording.downloadUrl || '',
    shareToMe: Boolean(recording.shareToMe),
    status: recording.status || '',
    serviceType: recording.serviceType || '',
    siteUrl: recording.siteUrl || '',
    hasTemporaryDirectDownloadLinks: Object.keys(links).length > 0,
    hasRecordingDownloadLink: Boolean(links.recordingDownloadLink),
    hasTranscriptDownloadLink: Boolean(links.transcriptDownloadLink),
    directLinkExpiration: links.expiration || null,
  };
}

function summarizeMeetingContentRow(row) {
  return {
    sourceType: row.source_type,
    sourceId: row.source_id,
    meetingId: row.meeting_id || null,
    recordingId: row.recording_id || null,
    title: row.title || '',
    hostEmail: row.host_email || '',
    created: row.created || null,
    contentPreview: limitText(row.content || '', 500),
  };
}

function parseIsoTime(value, fieldName) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Provide a valid ISO timestamp for ${fieldName}.`);
  }
  return timestamp;
}

function enforceCallDetailWindow(args, maxWindowMs, label) {
  if (!args.startTime || !args.endTime) {
    throw new Error('Provide startTime and endTime as ISO timestamps.');
  }

  const startMs = parseIsoTime(args.startTime, 'startTime');
  const endMs = parseIsoTime(args.endTime, 'endTime');

  if (endMs <= startMs) {
    throw new Error('endTime must be after startTime.');
  }

  if (endMs - startMs > maxWindowMs) {
    const maxHours = maxWindowMs / (60 * 60 * 1000);
    throw new Error(`${label} can query at most ${maxHours} hours per request.`);
  }
}

function firstPresent(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function parseDurationSeconds(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  const text = `${value}`.trim();
  if (!text) return 0;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);

  const hms = text.match(/^(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/);
  if (hms) {
    return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
  }

  const ms = text.match(/^(\d+):(\d{2})(?:\.\d+)?$/);
  if (ms) {
    return Number(ms[1]) * 60 + Number(ms[2]);
  }

  return 0;
}

function normalizeDigits(value) {
  return `${value || ''}`.replace(/\D+/g, '');
}

function summarizeCallDetailRecord(record, {includeRaw = false} = {}) {
  const durationSeconds = parseDurationSeconds(
    firstPresent(record, [
      'Duration',
      'Call duration',
      'Call Duration',
      'Call duration seconds',
      'Call Duration Seconds',
      'duration',
      'durationSeconds',
    ])
  );

  const summary = {
    callId: firstPresent(record, ['Call ID', 'Call Id', 'callId', 'id']),
    correlationId: firstPresent(record, ['Correlation ID', 'Correlation Id', 'correlationId']),
    userId: firstPresent(record, ['User ID', 'User Id', 'userId', 'Person ID', 'personId']),
    userEmail: firstPresent(record, ['User email', 'User Email', 'userEmail', 'Email', 'email']),
    userName: firstPresent(record, ['User name', 'User Name', 'userName', 'Name', 'name']),
    location: firstPresent(record, ['Location', 'Location name', 'Location Name', 'locationName']),
    departmentId: firstPresent(record, ['Department ID', 'Department Id', 'departmentId']),
    startTime: firstPresent(record, ['Start time', 'Start Time', 'Start time UTC', 'startTime']),
    answerTime: firstPresent(record, ['Answer time', 'Answer Time', 'answerTime']),
    releaseTime: firstPresent(record, ['Release time', 'Release Time', 'End time', 'End Time', 'endTime']),
    durationSeconds,
    answered: firstPresent(record, ['Answered', 'answered', 'Answer indicator', 'Answer Indicator']),
    direction: firstPresent(record, ['Direction', 'direction', 'Personality', 'personality']),
    callType: firstPresent(record, ['Call type', 'Call Type', 'callType']),
    callOutcome: firstPresent(record, ['Call outcome', 'Call Outcome', 'callOutcome']),
    callOutcomeReason: firstPresent(record, ['Call outcome reason', 'Call Outcome Reason', 'callOutcomeReason']),
    callingNumber: firstPresent(record, ['Calling number', 'Calling Number', 'callingNumber']),
    calledNumber: firstPresent(record, ['Called number', 'Called Number', 'calledNumber']),
    callingLineId: firstPresent(record, ['Calling line ID', 'Calling Line ID', 'callingLineId']),
    calledLineId: firstPresent(record, ['Called line ID', 'Called Line ID', 'calledLineId']),
    clientType: firstPresent(record, ['Client type', 'Client Type', 'clientType']),
    clientVersion: firstPresent(record, ['Client version', 'Client Version', 'clientVersion']),
  };

  if (includeRaw) summary.raw = record;
  return summary;
}

function callDetailMatchesFilter(record, args = {}) {
  const haystack = JSON.stringify(record).toLowerCase();

  if (args.personEmail && !haystack.includes(`${args.personEmail}`.toLowerCase())) {
    return false;
  }

  if (args.personName && !haystack.includes(`${args.personName}`.toLowerCase())) {
    return false;
  }

  if (args.number) {
    const needle = normalizeDigits(args.number);
    if (needle && !normalizeDigits(haystack).includes(needle)) return false;
  }

  return true;
}

function summarizeCallDetailRecords(records) {
  const summaries = records.map((record) => summarizeCallDetailRecord(record));
  const totalDurationSeconds = summaries.reduce((total, record) => total + (record.durationSeconds || 0), 0);
  const byCallType = {};
  const byDirection = {};

  for (const record of summaries) {
    const callType = record.callType || 'unknown';
    const direction = record.direction || 'unknown';
    byCallType[callType] = (byCallType[callType] || 0) + 1;
    byDirection[direction] = (byDirection[direction] || 0) + 1;
  }

  return {
    recordCount: records.length,
    totalDurationSeconds,
    totalDurationMinutes: Math.round((totalDurationSeconds / 60) * 10) / 10,
    byCallType,
    byDirection,
  };
}

function escapeHtml(value) {
  return `${value || ''}`
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeFacts(facts) {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return [];
  return Object.entries(facts)
    .map(([title, value]) => [title.trim(), `${value || ''}`.trim()])
    .filter(([title, value]) => title && value);
}

function buildEngineeringPlainText(args = {}) {
  const parts = [args.title, args.summary].filter(Boolean).map((value) => `${value}`.trim());
  return parts.length ? parts.join(' - ') : 'Engineering update';
}

function buildEngineeringMarkdown(args = {}) {
  const lines = [];

  if (args.title) lines.push(`**${args.title.trim()}**`);
  if (args.summary) lines.push(args.summary.trim());

  const facts = normalizeFacts(args.facts);
  if (facts.length) {
    lines.push(facts.map(([title, value]) => `- **${title}:** ${value}`).join('\n'));
  }

  if (Array.isArray(args.bullets) && args.bullets.length) {
    lines.push(args.bullets.filter(Boolean).map((item) => `- ${item}`).join('\n'));
  }

  if (Array.isArray(args.numbered) && args.numbered.length) {
    lines.push(
      args.numbered
        .filter(Boolean)
        .map((item, index) => `${index + 1}. ${item}`)
        .join('\n')
    );
  }

  if (args.code) {
    const language = `${args.codeLanguage || ''}`.trim();
    lines.push(`\`\`\`${language}\n${args.code.replace(/\s+$/, '')}\n\`\`\``);
  }

  if (args.callToActionUrl) {
    const label = (args.callToActionLabel || 'Open link').trim();
    lines.push(`[${label}](${args.callToActionUrl})`);
  }

  return lines.filter(Boolean).join('\n\n');
}

function buildEngineeringHtml(args = {}) {
  const sections = [];

  if (args.title) sections.push(`<h2>${escapeHtml(args.title.trim())}</h2>`);
  if (args.summary) sections.push(`<p>${escapeHtml(args.summary.trim())}</p>`);

  const facts = normalizeFacts(args.facts);
  if (facts.length) {
    sections.push(
      `<ul>${facts
        .map(([title, value]) => `<li><b>${escapeHtml(title)}:</b> ${escapeHtml(value)}</li>`)
        .join('')}</ul>`
    );
  }

  if (Array.isArray(args.bullets) && args.bullets.length) {
    sections.push(`<ul>${args.bullets.filter(Boolean).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`);
  }

  if (Array.isArray(args.numbered) && args.numbered.length) {
    sections.push(
      `<ol>${args.numbered.filter(Boolean).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol>`
    );
  }

  if (args.code) {
    sections.push(`<pre><code>${escapeHtml(args.code.replace(/\s+$/, ''))}</code></pre>`);
  }

  if (args.callToActionUrl) {
    const label = escapeHtml((args.callToActionLabel || 'Open link').trim());
    const href = escapeHtml(args.callToActionUrl);
    sections.push(`<p><a href="${href}">${label}</a></p>`);
  }

  return sections.join('');
}

function buildEngineeringCardAttachment(args = {}) {
  const severity = {
    default: 'Default',
    accent: 'Accent',
    good: 'Good',
    warning: 'Warning',
    attention: 'Attention',
  }[`${args.severity || 'accent'}`.toLowerCase()] || 'Accent';

  const body = [];
  if (args.title) {
    body.push({
      type: 'TextBlock',
      text: `${args.title}`.trim(),
      weight: 'Bolder',
      size: 'Large',
      color: severity,
      wrap: true,
    });
  }

  if (args.summary) {
    body.push({
      type: 'TextBlock',
      text: `${args.summary}`.trim(),
      wrap: true,
      spacing: 'Small',
    });
  }

  const facts = normalizeFacts(args.facts);
  if (facts.length) {
    body.push({
      type: 'FactSet',
      facts: facts.map(([title, value]) => ({title, value})),
    });
  }

  if (Array.isArray(args.bullets) && args.bullets.length) {
    body.push({
      type: 'TextBlock',
      text: args.bullets.filter(Boolean).map((item) => `• ${item}`).join('\n'),
      wrap: true,
    });
  }

  if (Array.isArray(args.numbered) && args.numbered.length) {
    body.push({
      type: 'TextBlock',
      text: args.numbered
        .filter(Boolean)
        .map((item, index) => `${index + 1}. ${item}`)
        .join('\n'),
      wrap: true,
    });
  }

  if (args.code) {
    body.push({
      type: 'Container',
      style: 'emphasis',
      items: [
        {
          type: 'TextBlock',
          text: args.code.replace(/\s+$/, ''),
          wrap: true,
          fontType: 'Monospace',
        },
      ],
    });
  }

  const actions = [];
  if (args.callToActionUrl) {
    actions.push({
      type: 'Action.OpenUrl',
      title: (args.callToActionLabel || 'Open link').trim(),
      url: args.callToActionUrl,
    });
  }

  return {
    contentType: 'application/vnd.microsoft.card.adaptive',
    content: {
      type: 'AdaptiveCard',
      version: '1.2',
      body,
      ...(actions.length ? {actions} : {}),
    },
  };
}

function buildEngineeringMessage(args = {}) {
  const mode = `${args.mode || 'card'}`.toLowerCase();
  const text = buildEngineeringPlainText(args);

  if (mode === 'markdown') {
    return {text, markdown: buildEngineeringMarkdown(args)};
  }

  if (mode === 'html') {
    return {text, html: buildEngineeringHtml(args)};
  }

  return {
    text,
    attachments: [buildEngineeringCardAttachment(args)],
  };
}

function decodeBase64(value) {
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function encodeHydraRoomId(uuid) {
  return Buffer.from(`ciscospark://us/ROOM/${uuid}`).toString('base64');
}

function extractSpaceUuid(input) {
  const value = `${input || ''}`.trim();
  if (!value) return '';

  const uuidMatch = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuidMatch) return uuidMatch[0].toLowerCase();

  const decoded = decodeBase64(value);
  const decodedMatch = decoded.match(/ciscospark:\/\/us\/ROOM\/([0-9a-f-]{36})/i);
  return decodedMatch ? decodedMatch[1].toLowerCase() : '';
}

function normalizeSearchText(value) {
  return `${value || ''}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenizeQuery(value) {
  return normalizeSearchText(value)
    .split(/\s+/)
    .filter(Boolean);
}

function scoreSearchMatch(query, ...fields) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;

  const haystack = normalizeSearchText(fields.filter(Boolean).join(' '));
  if (!haystack) return 0;

  let score = 0;
  if (haystack === normalizedQuery) score += 100;
  if (haystack.startsWith(normalizedQuery)) score += 50;
  if (haystack.includes(normalizedQuery)) score += 35;

  for (const token of tokenizeQuery(query)) {
    if (!haystack.includes(token)) continue;
    score += token.length > 3 ? 12 : 6;
  }

  return score;
}

function summarizeRoom(room) {
  return {
    id: room.id,
    uuid: extractSpaceUuid(room.id),
    title: room.title || '',
    type: room.type,
    lastActivity: room.lastActivity || null,
    created: room.created || null,
    isLocked: room.isLocked || false,
  };
}

async function resolveRoomInput(config, actor, roomInput) {
  const context = await getActorContext(config, actor);
  const raw = `${roomInput || ''}`.trim();
  if (!raw) throw new Error('roomId or space identifier is required');

  const roomId = raw.startsWith('Y2lzY29z') ? raw : (() => {
    const uuid = extractSpaceUuid(raw);
    return uuid ? encodeHydraRoomId(uuid) : raw;
  })();

  return {
    actor: context.actor,
    roomId,
    room: await context.api.getRoom(roomId),
  };
}

function rankRooms(rooms, query, {roomType} = {}) {
  const ranked = rooms
    .filter((room) => !roomType || room.type === roomType)
    .map((room) => ({
      room,
      score: scoreSearchMatch(query, room.title, room.id, extractSpaceUuid(room.id)),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return new Date(right.room.lastActivity || 0) - new Date(left.room.lastActivity || 0);
    });

  return ranked;
}

function buildLocalThreadsFromMessages(messages, maxResults = 20) {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const repliesByParentId = new Map();

  for (const message of messages) {
    if (!message.parentId) continue;
    const list = repliesByParentId.get(message.parentId) || [];
    list.push(message);
    repliesByParentId.set(message.parentId, list);
  }

  const threads = [];

  for (const [parentId, replies] of repliesByParentId.entries()) {
    replies.sort((left, right) => new Date(left.created || 0) - new Date(right.created || 0));
    const parentMessage = byId.get(parentId) || null;
    threads.push({
      parentId,
      parentMessage: parentMessage ? summarizeMessage(parentMessage) : null,
      childCount: replies.length,
      latestReplyCreated: replies[replies.length - 1]?.created || null,
      replies: replies.map(summarizeMessage),
    });
  }

  threads.sort((left, right) => new Date(right.latestReplyCreated || 0) - new Date(left.latestReplyCreated || 0));
  return threads.slice(0, maxResults);
}

function syncMessagesIntoIndex(store, actor, room, messages) {
  return withTransaction(store.db, () => {
    indexRoom(store, actor, room);
    for (const message of messages) {
      indexMessage(store, actor, message, room);
    }
    markSyncState(store, actor, 'room', room.id);
    return messages.length;
  });
}

function syncRoomsIntoIndex(store, actor, rooms, scope = 'all') {
  return withTransaction(store.db, () => {
    for (const room of rooms) {
      indexRoom(store, actor, room);
    }
    markSyncState(store, actor, 'rooms', scope);
    return rooms.length;
  });
}

async function syncAllRoomsIntoIndex(config, args = {}) {
  const context = await getActorContext(config, args.actor || 'auto');
  const store = await requireIndexStore(config);
  const rooms = (await context.api.listRooms({max: args.maxRooms || 5000}))
    .filter((room) => !args.roomType || room.type === args.roomType)
    .sort((left, right) => new Date(right.lastActivity || 0) - new Date(left.lastActivity || 0));

  const indexedRoomCount = syncRoomsIntoIndex(store, context.actor, rooms, args.roomType || 'all');

  return {
    actor: context.actor,
    roomCount: indexedRoomCount,
    index: {
      dbPath: store.path,
      backend: store.backend,
    },
    rooms: rooms.map(summarizeRoom),
  };
}

async function syncRecentRoomsIntoIndex(config, args = {}) {
  const context = await getActorContext(config, args.actor || 'auto');
  const store = await requireIndexStore(config);
  const rooms = (await context.api.listRooms({max: args.maxRooms || 20}))
    .filter((room) => !args.roomType || room.type === args.roomType)
    .sort((left, right) => new Date(right.lastActivity || 0) - new Date(left.lastActivity || 0));

  const syncedRooms = [];
  const failures = [];
  let indexedMessageCount = 0;

  for (const room of rooms) {
    try {
      const messages = await context.api.listMessages({
        roomId: room.id,
        max: args.perRoomMessages || 50,
      });
      indexedMessageCount += syncMessagesIntoIndex(store, context.actor, room, messages);
      syncedRooms.push({
        room: summarizeRoom(room),
        messageCount: messages.length,
      });
    } catch (error) {
      failures.push({
        room: summarizeRoom(room),
        error: error.message || String(error),
      });
    }
  }

  markSyncState(store, context.actor, 'recent_rooms', args.roomType || 'all');

  return {
    actor: context.actor,
    roomCount: syncedRooms.length,
    messageCount: indexedMessageCount,
    failedRoomCount: failures.length,
    index: {
      dbPath: store.path,
      backend: store.backend,
    },
    rooms: syncedRooms,
    failures,
  };
}

async function syncRoomHistoryIntoIndex(config, args = {}) {
  const actor = args.actor || 'auto';
  const context = await getActorContext(config, actor);
  const store = await requireIndexStore(config);
  let room;

  if (args.roomId) {
    room = await context.api.getRoom(args.roomId);
  } else if (args.space) {
    room = (await resolveRoomInput(config, actor, args.space)).room;
  } else {
    throw new Error('Provide roomId or space.');
  }

  const messages = await context.api.listMessages({
    roomId: room.id,
    before: args.before,
    beforeMessage: args.beforeMessage,
    max: args.maxMessages || 200,
  });

  const indexedMessageCount = syncMessagesIntoIndex(store, context.actor, room, messages);

  return {
    actor: context.actor,
    room: summarizeRoom(room),
    messageCount: indexedMessageCount,
    index: {
      dbPath: store.path,
      backend: store.backend,
    },
  };
}

const TOOLS = validatePublishedToolSchemas([
  {
    name: 'whoami',
    description: 'Show the Webex identity for the selected actor.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
      },
    },
  },
  {
    name: 'list_rooms',
    description: 'List rooms visible to the selected actor.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        max: {type: 'integer', minimum: 1, maximum: 500},
        roomType: {type: 'string', enum: ['direct', 'group']},
      },
    },
  },
  {
    name: 'list_rooms_with_read_status',
    description:
      'Experimental user-only helper that asks the Webex SDK for room read state, including lastSeenDate and unread inference.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        maxRecent: {type: 'integer', minimum: 0, maximum: 100},
      },
    },
  },
  {
    name: 'get_room_with_read_status',
    description:
      'Experimental user-only helper that asks the Webex SDK for one room read state, including lastSeenDate and unread inference.',
    inputSchema: {
      type: 'object',
      required: ['roomId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        roomId: {type: 'string'},
      },
    },
  },
  {
    name: 'mark_message_seen',
    description:
      'Experimental user-only helper that asks the Webex SDK to send a read receipt for the specified message.',
    inputSchema: {
      type: 'object',
      required: ['messageId', 'roomId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        messageId: {type: 'string'},
        roomId: {type: 'string'},
      },
    },
  },
  {
    name: 'update_typing_status',
    description:
      'Experimental user-only helper that asks the internal conversation SDK to emit typing start/stop state for a room.',
    inputSchema: {
      type: 'object',
      required: ['roomId', 'typing'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        roomId: {type: 'string'},
        typing: {type: 'boolean'},
      },
    },
  },
  {
    name: 'list_threads',
    description:
      'List thread roots for one room by grouping public room messages by parentId.',
    inputSchema: {
      type: 'object',
      required: ['roomId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        roomId: {type: 'string'},
        maxResults: {type: 'integer', minimum: 1, maximum: 100},
      },
    },
  },
  {
    name: 'list_meetings',
    description:
      'List meetings visible to the user OAuth token.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        from: {type: 'string'},
        to: {type: 'string'},
        max: {type: 'integer', minimum: 1, maximum: 200},
      },
    },
  },
  {
    name: 'list_meeting_participants',
    description:
      'List participant attendance rows for a meetingId via the user OAuth token. Use this to measure actual join/leave duration when Webex exposes participant data.',
    inputSchema: {
      type: 'object',
      required: ['meetingId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        meetingId: {type: 'string'},
        max: {type: 'integer', minimum: 1, maximum: 500},
      },
    },
  },
  {
    name: 'create_meeting',
    description:
      'Create a meeting via the user OAuth token. Pass the Webex meeting create payload as the meeting object.',
    inputSchema: {
      type: 'object',
      required: ['meeting'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        meeting: {type: 'object', additionalProperties: true},
      },
    },
  },
  {
    name: 'get_meeting',
    description:
      'Fetch one meeting by meetingId via the user OAuth token.',
    inputSchema: {
      type: 'object',
      required: ['meetingId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        meetingId: {type: 'string'},
      },
    },
  },
  {
    name: 'update_meeting',
    description:
      'Update a meeting via the user OAuth token. By default this sends PATCH; set replace=true to send PUT.',
    inputSchema: {
      type: 'object',
      required: ['meetingId', 'changes'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        meetingId: {type: 'string'},
        changes: {type: 'object', additionalProperties: true},
        replace: {type: 'boolean'},
      },
    },
  },
  {
    name: 'delete_meeting',
    description:
      'Delete or cancel a meeting via the user OAuth token.',
    inputSchema: {
      type: 'object',
      required: ['meetingId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        meetingId: {type: 'string'},
      },
    },
  },
  {
    name: 'get_meeting_preferences',
    description:
      'Fetch the aggregate meeting preferences for the current user.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
      },
    },
  },
  {
    name: 'list_meeting_preference_sites',
    description:
      'List the meeting sites available in the current user preferences.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
      },
    },
  },
  {
    name: 'get_meeting_audio_preferences',
    description:
      'Fetch the current user meeting audio preferences.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
      },
    },
  },
  {
    name: 'update_meeting_audio_preferences',
    description:
      'Update the current user meeting audio preferences via PUT. Empty office/mobile numbers are automatically normalized.',
    inputSchema: {
      type: 'object',
      required: ['preferences'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        preferences: {type: 'object', additionalProperties: true},
      },
    },
  },
  {
    name: 'get_meeting_scheduling_preferences',
    description:
      'Fetch the current user meeting scheduling preferences.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
      },
    },
  },
  {
    name: 'update_meeting_scheduling_preferences',
    description:
      'Update the current user meeting scheduling preferences via PUT.',
    inputSchema: {
      type: 'object',
      required: ['preferences'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        preferences: {type: 'object', additionalProperties: true},
      },
    },
  },
  {
    name: 'get_personal_meeting_room_preferences',
    description:
      'Fetch the current user personal meeting room preferences.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
      },
    },
  },
  {
    name: 'update_personal_meeting_room_preferences',
    description:
      'Update the current user personal meeting room preferences via PUT.',
    inputSchema: {
      type: 'object',
      required: ['preferences'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        preferences: {type: 'object', additionalProperties: true},
      },
    },
  },
  {
    name: 'get_meeting_controls',
    description:
      'Fetch live-meeting control state for a meetingId. This only works for meetings where the controls resource exists.',
    inputSchema: {
      type: 'object',
      required: ['meetingId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        meetingId: {type: 'string'},
      },
    },
  },
  {
    name: 'update_meeting_controls',
    description:
      'Update live-meeting controls via PUT /meetings/{meetingId}/controls. Pass the Webex controls payload as the controls object.',
    inputSchema: {
      type: 'object',
      required: ['meetingId', 'controls'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        meetingId: {type: 'string'},
        controls: {type: 'object', additionalProperties: true},
      },
    },
  },
  {
    name: 'inspect_meeting_assets',
    description:
      'Inspect meeting asset availability for a meetingId or recordingId, including recordings, transcripts, and summary access.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        meetingId: {type: 'string', description: 'Required if recordingId is not provided'},
        recordingId: {type: 'string', description: 'Required if meetingId is not provided'},
        maxTranscripts: {type: 'integer', minimum: 1, maximum: 100},
      },
    },
  },
  {
    name: 'list_meeting_transcripts',
    description:
      'List meeting transcript metadata via the user OAuth token. Optionally filter to one meetingId.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        meetingId: {type: 'string'},
        max: {type: 'integer', minimum: 1, maximum: 200},
      },
    },
  },
  {
    name: 'list_recordings',
    description:
      'List meeting recording metadata via the user OAuth token, including recordings shared with the current user.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        from: {type: 'string'},
        to: {type: 'string'},
        max: {type: 'integer', minimum: 1, maximum: 200},
        sharedOnly: {type: 'boolean'},
      },
    },
  },
  {
    name: 'list_call_detail_records',
    description:
      'List Webex Calling Detailed Call History records from analytics-calling /cdr_feed. Requires spark-admin:calling_cdr_read and the Control Hub Detailed Call History API access role. Each request is limited to a 12-hour window.',
    inputSchema: {
      type: 'object',
      required: ['startTime', 'endTime'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        startTime: {type: 'string', description: 'ISO timestamp. Must be within 30 days and at least 5 minutes before now.'},
        endTime: {type: 'string', description: 'ISO timestamp after startTime. Maximum 12 hours after startTime.'},
        locations: {type: 'array', items: {type: 'string'}, description: 'Optional Webex Calling location ids or names to pass to the CDR API.'},
        baseUrl: {type: 'string', description: `Optional regional base URL. Defaults to ${DEFAULT_CALLING_CDR_BASE_URL}.`},
        max: {type: 'integer', minimum: 1, maximum: 1000},
        personEmail: {type: 'string', description: 'Optional local filter across returned CDR fields.'},
        personName: {type: 'string', description: 'Optional local filter across returned CDR fields.'},
        number: {type: 'string', description: 'Optional local phone/extension filter across returned CDR fields.'},
        includeRaw: {type: 'boolean', description: 'Include raw CDR records in each summarized result.'},
      },
    },
  },
  {
    name: 'list_active_calls',
    description:
      'List active Webex Calling calls currently associated with the OAuth user. Requires spark:calls_read or spark:xsi and only returns active call-control state, not historical duration.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
      },
    },
  },
  {
    name: 'list_user_call_history',
    description:
      'List the OAuth user Webex Calling call history from /telephony/calls/history. Requires user-level calling scopes such as spark:calls_read or spark:xsi. This is not CDR and may omit duration.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        max: {type: 'integer', minimum: 1, maximum: 500},
        from: {type: 'string', description: 'Optional local ISO timestamp lower bound.'},
        to: {type: 'string', description: 'Optional local ISO timestamp upper bound.'},
        type: {type: 'string', description: 'Optional local filter such as missed, received, or placed.'},
        query: {type: 'string', description: 'Optional local name/number/type substring filter.'},
      },
    },
  },
  {
    name: 'list_live_call_detail_records',
    description:
      'List near-real-time Webex Calling Detailed Call History records from analytics-calling /cdr_stream. Requires spark-admin:calling_cdr_read and the Control Hub Detailed Call History API access role. Each request is limited to a 2-hour window.',
    inputSchema: {
      type: 'object',
      required: ['startTime', 'endTime'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        startTime: {type: 'string', description: 'ISO timestamp.'},
        endTime: {type: 'string', description: 'ISO timestamp after startTime. Maximum 2 hours after startTime.'},
        locations: {type: 'array', items: {type: 'string'}, description: 'Optional Webex Calling location ids or names to pass to the CDR API.'},
        baseUrl: {type: 'string', description: `Optional regional base URL. Defaults to ${DEFAULT_CALLING_CDR_BASE_URL}.`},
        max: {type: 'integer', minimum: 1, maximum: 1000},
        personEmail: {type: 'string', description: 'Optional local filter across returned CDR fields.'},
        personName: {type: 'string', description: 'Optional local filter across returned CDR fields.'},
        number: {type: 'string', description: 'Optional local phone/extension filter across returned CDR fields.'},
        includeRaw: {type: 'boolean', description: 'Include raw CDR records in each summarized result.'},
      },
    },
  },
  {
    name: 'get_recording',
    description:
      'Fetch one recording by recordingId via the user OAuth token, including temporary direct download link availability.',
    inputSchema: {
      type: 'object',
      required: ['recordingId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        recordingId: {type: 'string'},
      },
    },
  },
  {
    name: 'get_recording_transcript',
    description:
      'Download transcript text for a recording when Webex exposes a temporary direct transcript link.',
    inputSchema: {
      type: 'object',
      required: ['recordingId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        recordingId: {type: 'string'},
        maxChars: {type: 'integer', minimum: 1, maximum: 500000},
      },
    },
  },
  {
    name: 'sync_recent_meeting_content',
    description:
      'Download and index recent meeting transcript text from both transcript APIs and recording transcript links into the local SQLite meeting index.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        from: {type: 'string'},
        to: {type: 'string'},
        maxRecordings: {type: 'integer', minimum: 1, maximum: 100},
        maxTranscripts: {type: 'integer', minimum: 1, maximum: 100},
      },
    },
  },
  {
    name: 'search_meeting_content',
    description:
      'Search the locally indexed meeting transcript content cache.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        query: {type: 'string'},
        maxResults: {type: 'integer', minimum: 1, maximum: 100},
      },
    },
  },
  {
    name: 'get_meeting_transcript',
    description:
      'Download one meeting transcript as txt or vtt via the user OAuth token.',
    inputSchema: {
      type: 'object',
      required: ['transcriptId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        transcriptId: {type: 'string'},
        format: {type: 'string', enum: ['txt', 'vtt']},
        maxChars: {type: 'integer', minimum: 1, maximum: 500000},
      },
    },
  },
  {
    name: 'search_meeting_transcript',
    description:
      'Search transcript snippets for one meeting transcript via the user OAuth token.',
    inputSchema: {
      type: 'object',
      required: ['transcriptId', 'query'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        transcriptId: {type: 'string'},
        query: {type: 'string'},
        max: {type: 'integer', minimum: 1, maximum: 500},
      },
    },
  },
  {
    name: 'sync_recent_rooms',
    description: 'Cache recent rooms and their latest messages into the local SQLite index for deterministic local search.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        maxRooms: {type: 'integer', minimum: 1, maximum: 200},
        perRoomMessages: {type: 'integer', minimum: 1, maximum: 200},
        roomType: {type: 'string', enum: ['direct', 'group']},
      },
    },
  },
  {
    name: 'sync_all_rooms',
    description: 'Cache all accessible room metadata into the local SQLite index so room lookup and ranking do not depend on partial live scans.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        maxRooms: {type: 'integer', minimum: 1, maximum: 10000},
        roomType: {type: 'string', enum: ['direct', 'group']},
      },
    },
  },
  {
    name: 'sync_room_history',
    description: 'Cache one room thread history into the local SQLite index.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        roomId: {type: 'string', description: 'Required if space is not provided'},
        space: {type: 'string', description: 'Required if roomId is not provided'},
        maxMessages: {type: 'integer', minimum: 1, maximum: 1000},
        before: {type: 'string'},
        beforeMessage: {type: 'string'},
      },
    },
  },
  {
    name: 'resolve_space',
    description: 'Resolve a Webex room from a roomId, UUID, or webexteams:// space link.',
    inputSchema: {
      type: 'object',
      required: ['space'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        space: {type: 'string'},
      },
    },
  },
  {
    name: 'search_rooms',
    description: 'Search cached rooms by title, UUID, or link with lightweight fuzzy ranking.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        query: {type: 'string'},
        roomType: {type: 'string', enum: ['direct', 'group']},
        maxRooms: {type: 'integer', minimum: 1, maximum: 1000},
        maxResults: {type: 'integer', minimum: 1, maximum: 100},
      },
    },
  },
  {
    name: 'get_room',
    description: 'Fetch one room by roomId.',
    inputSchema: {
      type: 'object',
      required: ['roomId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        roomId: {type: 'string'},
      },
    },
  },
  {
    name: 'create_room',
    description: 'Create a new group room.',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        title: {type: 'string'},
        teamId: {type: 'string'},
      },
    },
  },
  {
    name: 'list_teams',
    description: 'List teams visible to the selected actor.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        max: {type: 'integer', minimum: 1, maximum: 500},
      },
    },
  },
  {
    name: 'get_team',
    description: 'Fetch one team by teamId.',
    inputSchema: {
      type: 'object',
      required: ['teamId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        teamId: {type: 'string'},
      },
    },
  },
  {
    name: 'create_team',
    description: 'Create a new team.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        name: {type: 'string'},
      },
    },
  },
  {
    name: 'update_team',
    description: 'Update a team name.',
    inputSchema: {
      type: 'object',
      required: ['teamId', 'name'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        teamId: {type: 'string'},
        name: {type: 'string'},
      },
    },
  },
  {
    name: 'list_team_memberships',
    description: 'List memberships for a team.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        teamId: {type: 'string'},
        personId: {type: 'string'},
        personEmail: {type: 'string'},
        max: {type: 'integer', minimum: 1, maximum: 500},
      },
    },
  },
  {
    name: 'get_team_membership',
    description: 'Fetch one team membership by membershipId.',
    inputSchema: {
      type: 'object',
      required: ['membershipId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        membershipId: {type: 'string'},
      },
    },
  },
  {
    name: 'add_team_membership',
    description: 'Add a person to a team by personId or personEmail.',
    inputSchema: {
      type: 'object',
      required: ['teamId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        teamId: {type: 'string'},
        personId: {type: 'string'},
        personEmail: {type: 'string'},
        isModerator: {type: 'boolean'},
      },
    },
  },
  {
    name: 'update_team_membership',
    description: 'Update a team membership moderator flag.',
    inputSchema: {
      type: 'object',
      required: ['membershipId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        membershipId: {type: 'string'},
        isModerator: {type: 'boolean'},
      },
    },
  },
  {
    name: 'remove_team_membership',
    description: 'Remove a team membership by membershipId.',
    inputSchema: {
      type: 'object',
      required: ['membershipId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        membershipId: {type: 'string'},
      },
    },
  },
  {
    name: 'search_people',
    description: 'Search Webex people by email or display name.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        query: {type: 'string'},
        max: {type: 'integer', minimum: 1, maximum: 200},
      },
    },
  },
  {
    name: 'get_person',
    description: 'Fetch one person by personId.',
    inputSchema: {
      type: 'object',
      required: ['personId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        personId: {type: 'string'},
      },
    },
  },
  {
    name: 'list_memberships',
    description: 'List memberships for a room or person filter.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        roomId: {type: 'string'},
        personId: {type: 'string'},
        personEmail: {type: 'string'},
        max: {type: 'integer', minimum: 1, maximum: 500},
      },
    },
  },
  {
    name: 'add_membership',
    description: 'Add a person to a room by personId or personEmail.',
    inputSchema: {
      type: 'object',
      required: ['roomId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        roomId: {type: 'string'},
        personId: {type: 'string'},
        personEmail: {type: 'string'},
        isModerator: {type: 'boolean'},
      },
    },
  },
  {
    name: 'remove_membership',
    description: 'Remove a membership by membershipId.',
    inputSchema: {
      type: 'object',
      required: ['membershipId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        membershipId: {type: 'string'},
      },
    },
  },
  {
    name: 'list_messages',
    description: 'List messages in a room.',
    inputSchema: {
      type: 'object',
      required: ['roomId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        roomId: {type: 'string'},
        max: {type: 'integer', minimum: 1, maximum: 200},
        parentId: {type: 'string'},
        before: {type: 'string'},
        beforeMessage: {type: 'string'},
      },
    },
  },
  {
    name: 'search_messages',
    description:
      'Search cached messages from the local SQLite index.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        query: {type: 'string'},
        roomId: {type: 'string'},
        roomQuery: {type: 'string'},
        roomType: {type: 'string', enum: ['direct', 'group']},
        maxRooms: {type: 'integer', minimum: 1, maximum: 200},
        perRoomMessages: {type: 'integer', minimum: 1, maximum: 200},
        maxResults: {type: 'integer', minimum: 1, maximum: 100},
      },
    },
  },
  {
    name: 'get_message',
    description: 'Fetch one message by messageId.',
    inputSchema: {
      type: 'object',
      required: ['messageId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        messageId: {type: 'string'},
      },
    },
  },
  {
    name: 'list_thread_replies',
    description: 'List reply messages for one thread root message.',
    inputSchema: {
      type: 'object',
      required: ['roomId', 'parentId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        roomId: {type: 'string'},
        parentId: {type: 'string'},
        max: {type: 'integer', minimum: 1, maximum: 200},
        before: {type: 'string'},
        beforeMessage: {type: 'string'},
      },
    },
  },
  {
    name: 'add_reaction',
    description:
      'Experimental user-only helper that asks the internal conversation SDK to add a reaction to a message.',
    inputSchema: {
      type: 'object',
      required: ['roomId', 'messageId', 'reaction'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        roomId: {type: 'string'},
        messageId: {type: 'string'},
        reaction: {
          type: 'string',
          enum: ['celebrate', 'heart', 'thumbsup', 'smiley', 'haha', 'confused', 'sad'],
        },
      },
    },
  },
  {
    name: 'delete_reaction',
    description:
      'Experimental user-only helper that asks the internal conversation SDK to delete a reaction activity.',
    inputSchema: {
      type: 'object',
      required: ['roomId', 'reactionId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        roomId: {type: 'string'},
        reactionId: {type: 'string'},
      },
    },
  },
  {
    name: 'set_conversation_state',
    description:
      'Experimental user-only helper for conversation state toggles like favorite, hide, and mute.',
    inputSchema: {
      type: 'object',
      required: ['roomId', 'action'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user']},
        roomId: {type: 'string'},
        action: {
          type: 'string',
          enum: ['favorite', 'unfavorite', 'hide', 'unhide', 'mute', 'unmute'],
        },
      },
    },
  },
  {
    name: 'create_attachment_action',
    description: 'Submit an adaptive-card attachment action for a message.',
    inputSchema: {
      type: 'object',
      required: ['messageId', 'type'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        messageId: {type: 'string'},
        type: {type: 'string'},
        inputs: {type: 'object', additionalProperties: true},
      },
    },
  },
  {
    name: 'get_attachment_action',
    description: 'Fetch one attachment action by attachmentActionId.',
    inputSchema: {
      type: 'object',
      required: ['attachmentActionId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        attachmentActionId: {type: 'string'},
      },
    },
  },
  {
    name: 'send_message',
    description: 'Send a room or direct message as the selected actor, with support for markdown, html, files, and adaptive card attachments.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        roomId: {type: 'string', description: 'Destination: provide roomId, toPersonEmail, or toPersonId'},
        toPersonEmail: {type: 'string', description: 'Destination: provide roomId, toPersonEmail, or toPersonId'},
        toPersonId: {type: 'string', description: 'Destination: provide roomId, toPersonEmail, or toPersonId'},
        parentId: {type: 'string'},
        text: {type: 'string', description: 'Content: provide at least one of text, markdown, html, filePaths, fileUrls, or attachments'},
        markdown: {type: 'string', description: 'Content: provide at least one of text, markdown, html, filePaths, fileUrls, or attachments'},
        html: {type: 'string', description: 'Content: provide at least one of text, markdown, html, filePaths, fileUrls, or attachments'},
        filePaths: {type: 'array', items: {type: 'string'}},
        fileUrls: {type: 'array', items: {type: 'string'}},
        attachments: {type: 'array', items: {type: 'object'}},
      },
    },
  },
  {
    name: 'send_engineering_message',
    description: 'Build and send a richly formatted engineering update as markdown, html, or an adaptive card.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        roomId: {type: 'string', description: 'Destination: provide roomId, toPersonEmail, or toPersonId'},
        toPersonEmail: {type: 'string', description: 'Destination: provide roomId, toPersonEmail, or toPersonId'},
        toPersonId: {type: 'string', description: 'Destination: provide roomId, toPersonEmail, or toPersonId'},
        parentId: {type: 'string'},
        mode: {type: 'string', enum: ['markdown', 'html', 'card']},
        severity: {type: 'string', enum: ['default', 'accent', 'good', 'warning', 'attention']},
        title: {type: 'string'},
        summary: {type: 'string'},
        bullets: {type: 'array', items: {type: 'string'}},
        numbered: {type: 'array', items: {type: 'string'}},
        facts: {
          type: 'object',
          additionalProperties: {type: 'string'},
        },
        code: {type: 'string'},
        codeLanguage: {type: 'string'},
        callToActionLabel: {type: 'string'},
        callToActionUrl: {type: 'string'},
      },
    },
  },
  {
    name: 'list_webhooks',
    description: 'List webhooks visible to the selected actor.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        max: {type: 'integer', minimum: 1, maximum: 500},
      },
    },
  },
  {
    name: 'get_webhook',
    description: 'Fetch one webhook by webhookId.',
    inputSchema: {
      type: 'object',
      required: ['webhookId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        webhookId: {type: 'string'},
      },
    },
  },
  {
    name: 'create_webhook',
    description: 'Create a new webhook.',
    inputSchema: {
      type: 'object',
      required: ['resource', 'event', 'targetUrl', 'name'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        resource: {type: 'string'},
        event: {type: 'string'},
        filter: {type: 'string'},
        targetUrl: {type: 'string'},
        name: {type: 'string'},
        secret: {type: 'string'},
      },
    },
  },
  {
    name: 'update_webhook',
    description: 'Update an existing webhook.',
    inputSchema: {
      type: 'object',
      required: ['webhookId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        webhookId: {type: 'string'},
        resource: {type: 'string'},
        event: {type: 'string'},
        filter: {type: 'string'},
        targetUrl: {type: 'string'},
        name: {type: 'string'},
        secret: {type: 'string'},
      },
    },
  },
  {
    name: 'delete_webhook',
    description: 'Delete a webhook by webhookId.',
    inputSchema: {
      type: 'object',
      required: ['webhookId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        webhookId: {type: 'string'},
      },
    },
  },
  {
    name: 'update_message',
    description: 'Update an existing message. Webex requires roomId when updating.',
    inputSchema: {
      type: 'object',
      required: ['messageId', 'roomId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        messageId: {type: 'string'},
        roomId: {type: 'string'},
        text: {type: 'string'},
        markdown: {type: 'string'},
        html: {type: 'string'},
      },
    },
  },
  {
    name: 'delete_message',
    description: 'Delete a message by messageId.',
    inputSchema: {
      type: 'object',
      required: ['messageId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        messageId: {type: 'string'},
      },
    },
  },
  {
    name: 'download_file',
    description: 'Download a Webex file URL with auth and optionally extract text.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        url: {type: 'string'},
        outputDir: {type: 'string'},
        filename: {type: 'string'},
        extractText: {type: 'boolean'},
        maxChars: {type: 'integer', minimum: 1, maximum: 100000},
      },
    },
  },
  {
    name: 'extract_message_files',
    description: 'Download and optionally extract every file attached to a message.',
    inputSchema: {
      type: 'object',
      required: ['messageId'],
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        messageId: {type: 'string'},
        outputDir: {type: 'string'},
        extractText: {type: 'boolean'},
        maxChars: {type: 'integer', minimum: 1, maximum: 100000},
      },
    },
  },
  {
    name: 'find_latest_attachment',
    description: 'Find the newest message with one or more file attachments in a room.',
    inputSchema: {
      type: 'object',
      properties: {
        actor: {type: 'string', enum: ['auto', 'user', 'bot']},
        roomId: {type: 'string'},
        space: {type: 'string'},
        roomQuery: {type: 'string'},
        maxRooms: {type: 'integer', minimum: 1, maximum: 100},
        scanMessages: {type: 'integer', minimum: 1, maximum: 200},
      },
    },
  },
  {
    name: 'extract_local_file_text',
    description: 'Extract text from a local file path without downloading.',
    inputSchema: {
      type: 'object',
      required: ['filePath'],
      properties: {
        filePath: {type: 'string'},
        mimeType: {type: 'string'},
      },
    },
  },
]);

async function callTool(config, name, args = {}) {
  switch (name) {
    case 'whoami': {
      const context = await getActorContext(config, args.actor || 'auto');
      return jsonText({
        actor: context.actor,
        id: context.me.id,
        displayName: context.me.displayName,
        emails: context.me.emails || [],
      });
    }
    case 'list_rooms': {
      const context = await getActorContext(config, args.actor || 'auto');
      const rooms = await context.api.listRooms({max: args.max || DEFAULT_PAGE_SIZE});
      const filtered = args.roomType ? rooms.filter((room) => room.type === args.roomType) : rooms;
      return jsonText({
        actor: context.actor,
        count: filtered.length,
        rooms: filtered.map(summarizeRoom),
      });
    }
    case 'list_rooms_with_read_status': {
      const result = await runSdkHelper(config, args.actor || 'auto', 'list_rooms_with_read_status', {
        maxRecent: args.maxRecent || 0,
      });
      return jsonText({
        actor: 'user',
        ...result,
      });
    }
    case 'get_room_with_read_status': {
      const result = await runSdkHelper(config, args.actor || 'auto', 'get_room_with_read_status', {
        roomId: args.roomId,
      });
      return jsonText({
        actor: 'user',
        room: summarizeReadStatusRoom(result),
      });
    }
    case 'mark_message_seen': {
      const result = await runSdkHelper(config, args.actor || 'auto', 'mark_message_seen', {
        messageId: args.messageId,
        roomId: args.roomId,
      });
      return jsonText({
        actor: 'user',
        membership: summarizeSeenUpdate(result),
      });
    }
    case 'update_typing_status': {
      const result = await runSdkHelper(config, args.actor || 'auto', 'update_typing_status', {
        roomId: args.roomId,
        typing: Boolean(args.typing),
      });
      return jsonText({
        actor: 'user',
        ...result,
      });
    }
    case 'list_threads': {
      const context = await getActorContext(config, args.actor || 'auto');
      const messages = await context.api.listMessages({
        roomId: args.roomId,
        max: 200,
      });
      const threads = buildLocalThreadsFromMessages(messages, args.maxResults || 20);
      return jsonText({
        actor: context.actor,
        roomId: args.roomId,
        count: threads.length,
        threadSource: 'publicMessages',
        threads,
      });
    }
    case 'list_meeting_transcripts': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const transcripts = await context.api.listMeetingTranscripts({
        meetingId: args.meetingId,
        max: args.max || 20,
      });
      return jsonText({
        actor: context.actor,
        count: transcripts.length,
        transcripts: transcripts.map(summarizeMeetingTranscript),
      });
    }
    case 'list_recordings': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const recordings = await context.api.listRecordings({
        from: args.from,
        to: args.to,
        max: args.max || 20,
      });
      const filtered = args.sharedOnly
        ? recordings.filter((recording) => Boolean(recording.shareToMe))
        : recordings;
      return jsonText({
        actor: context.actor,
        count: filtered.length,
        recordings: filtered.map(summarizeRecording),
      });
    }
    case 'list_call_detail_records': {
      enforceCallDetailWindow(args, MAX_CDR_FEED_WINDOW_MS, 'CDR feed');
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const records = await context.api.listCallDetailRecords({
        startTime: args.startTime,
        endTime: args.endTime,
        locations: args.locations,
        baseUrl: args.baseUrl,
        max: args.max || 100,
      });
      const filtered = records.filter((record) => callDetailMatchesFilter(record, args));
      return jsonText({
        actor: context.actor,
        source: 'cdr_feed',
        startTime: args.startTime,
        endTime: args.endTime,
        count: filtered.length,
        rawCount: records.length,
        summary: summarizeCallDetailRecords(filtered),
        records: filtered.map((record) =>
          summarizeCallDetailRecord(record, {includeRaw: Boolean(args.includeRaw)})
        ),
      });
    }
    case 'list_active_calls': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const response = await context.api.listActiveCalls();
      const calls = Array.isArray(response?.items)
        ? response.items
        : Array.isArray(response?.calls)
          ? response.calls
          : Array.isArray(response)
            ? response
            : [];
      return jsonText({
        actor: context.actor,
        count: calls.length,
        calls: calls.map(summarizeActiveCall),
        raw: response,
      });
    }
    case 'list_user_call_history': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const history = await context.api.listUserCallHistory({
        max: args.max || 100,
      });
      const filtered = filterUserCallHistory(history, args);
      return jsonText({
        actor: context.actor,
        count: filtered.length,
        rawCount: history.length,
        summary: summarizeUserCallHistory(filtered),
        calls: filtered.map(summarizeUserCallHistoryItem),
      });
    }
    case 'list_live_call_detail_records': {
      enforceCallDetailWindow(args, MAX_CDR_STREAM_WINDOW_MS, 'CDR stream');
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const records = await context.api.listLiveCallDetailRecords({
        startTime: args.startTime,
        endTime: args.endTime,
        locations: args.locations,
        baseUrl: args.baseUrl,
        max: args.max || 100,
      });
      const filtered = records.filter((record) => callDetailMatchesFilter(record, args));
      return jsonText({
        actor: context.actor,
        source: 'cdr_stream',
        startTime: args.startTime,
        endTime: args.endTime,
        count: filtered.length,
        rawCount: records.length,
        summary: summarizeCallDetailRecords(filtered),
        records: filtered.map((record) =>
          summarizeCallDetailRecord(record, {includeRaw: Boolean(args.includeRaw)})
        ),
      });
    }
    case 'list_meetings': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const meetings = await context.api.listMeetings({
        from: args.from,
        to: args.to,
        max: args.max || 20,
      });
      return jsonText({
        actor: context.actor,
        count: meetings.length,
        meetings: meetings.map(summarizeMeeting),
      });
    }
    case 'list_meeting_participants': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const participants = await context.api.listMeetingParticipants({
        meetingId: args.meetingId,
        max: args.max || 100,
      });
      const summarized = participants.map(summarizeMeetingParticipant);
      const totalDurationSeconds = summarized.reduce(
        (total, participant) => total + (participant.durationSeconds || 0),
        0
      );
      return jsonText({
        actor: context.actor,
        meetingId: args.meetingId,
        count: summarized.length,
        totalParticipantDurationSeconds: totalDurationSeconds,
        totalParticipantDurationMinutes: Math.round((totalDurationSeconds / 60) * 10) / 10,
        participants: summarized,
      });
    }
    case 'create_meeting': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const meeting = await context.api.createMeeting(args.meeting || {});
      return jsonText({
        actor: context.actor,
        meeting: summarizeMeeting(meeting),
        rawMeeting: meeting,
      });
    }
    case 'get_meeting': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const meeting = await context.api.getMeeting(args.meetingId);
      return jsonText({
        actor: context.actor,
        meeting: summarizeMeeting(meeting),
      });
    }
    case 'update_meeting': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const meeting = await context.api.updateMeeting(args.meetingId, args.changes || {}, {
        replace: Boolean(args.replace),
      });
      return jsonText({
        actor: context.actor,
        meeting: summarizeMeeting(meeting),
        rawMeeting: meeting,
      });
    }
    case 'delete_meeting': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      await context.api.deleteMeeting(args.meetingId);
      return jsonText({
        actor: context.actor,
        deleted: true,
        meetingId: args.meetingId,
      });
    }
    case 'get_meeting_preferences': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const preferences = await context.api.getMeetingPreferences();
      return jsonText({
        actor: context.actor,
        preferences,
      });
    }
    case 'list_meeting_preference_sites': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const sites = await context.api.listMeetingPreferenceSites();
      return jsonText({
        actor: context.actor,
        ...summarizeMeetingSitesResponse(sites),
      });
    }
    case 'get_meeting_audio_preferences': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const preferences = await context.api.getMeetingAudioPreferences();
      return jsonText({
        actor: context.actor,
        preferences,
      });
    }
    case 'update_meeting_audio_preferences': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const preferences = await context.api.updateMeetingAudioPreferences(
        normalizeMeetingAudioPreferencesForUpdate(args.preferences || {})
      );
      return jsonText({
        actor: context.actor,
        preferences,
      });
    }
    case 'get_meeting_scheduling_preferences': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const preferences = await context.api.getMeetingSchedulingPreferences();
      return jsonText({
        actor: context.actor,
        preferences,
      });
    }
    case 'update_meeting_scheduling_preferences': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const preferences = await context.api.updateMeetingSchedulingPreferences(args.preferences || {});
      return jsonText({
        actor: context.actor,
        preferences,
      });
    }
    case 'get_personal_meeting_room_preferences': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const preferences = await context.api.getPersonalMeetingRoomPreferences();
      return jsonText({
        actor: context.actor,
        preferences,
      });
    }
    case 'update_personal_meeting_room_preferences': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const preferences = await context.api.updatePersonalMeetingRoomPreferences(args.preferences || {});
      return jsonText({
        actor: context.actor,
        preferences,
      });
    }
    case 'get_meeting_controls': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const controls = await context.api.getMeetingControls(args.meetingId);
      return jsonText({
        actor: context.actor,
        meetingId: args.meetingId,
        controls,
      });
    }
    case 'update_meeting_controls': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const controls = await context.api.updateMeetingControls(args.meetingId, args.controls || {});
      return jsonText({
        actor: context.actor,
        meetingId: args.meetingId,
        controls,
      });
    }
    case 'inspect_meeting_assets': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      return jsonText(await inspectMeetingAssets(context, args));
    }
    case 'get_recording': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const recording = await context.api.getRecording(args.recordingId);
      return jsonText({
        actor: context.actor,
        recording: summarizeRecording(recording),
        temporaryDirectDownloadLinks: isPlainObject(recording.temporaryDirectDownloadLinks)
          ? recording.temporaryDirectDownloadLinks
          : {},
      });
    }
    case 'get_recording_transcript': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const recording = await context.api.getRecording(args.recordingId);
      const transcriptUrl = recording?.temporaryDirectDownloadLinks?.transcriptDownloadLink;

      if (!transcriptUrl) {
        throw new Error(`Recording ${args.recordingId} does not expose a transcript download link.`);
      }

      const downloaded = await context.api.downloadText(transcriptUrl);
      const content = downloaded.text || '';

      return jsonText({
        actor: context.actor,
        recording: summarizeRecording(recording),
        transcriptUrl,
        contentType: downloaded.contentType,
        charLength: content.length,
        content: limitText(content, Number(args.maxChars || 20000)),
      });
    }
    case 'sync_recent_meeting_content': {
      return jsonText(await syncRecentMeetingContentIntoIndex(config, args));
    }
    case 'search_meeting_content': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const indexed = await searchIndexedMeetingContent(config, context.actor, args);
      return jsonText(
        indexed || {
          actor: context.actor,
          count: 0,
          searchMode: 'localMeetingIndex',
          results: [],
        }
      );
    }
    case 'get_meeting_transcript': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const transcript = await context.api.getMeetingTranscript(args.transcriptId);
      const format = args.format === 'vtt' ? 'vtt' : 'txt';
      const downloadUrl =
        format === 'vtt' ? transcript.vttDownloadLink : transcript.txtDownloadLink;

      if (!downloadUrl) {
        throw new Error(`Transcript ${args.transcriptId} does not expose a ${format} download link.`);
      }

      const downloaded = await context.api.downloadText(downloadUrl);
      const content = downloaded.text || '';

      return jsonText({
        actor: context.actor,
        transcript: summarizeMeetingTranscript(transcript),
        format,
        contentType: downloaded.contentType,
        charLength: content.length,
        content: limitText(content, Number(args.maxChars || 20000)),
      });
    }
    case 'search_meeting_transcript': {
      const context = await getUserScopedContext(config, args.actor || 'auto');
      const query = `${args.query || ''}`.trim();
      if (!query) {
        throw new Error('Provide a non-empty query.');
      }

      const snippets = await context.api.listMeetingTranscriptSnippets(args.transcriptId, {
        max: args.max || 100,
      });
      const loweredQuery = query.toLowerCase();
      const matches = snippets
        .filter((snippet) => {
          const text = `${snippet.text || ''}`.toLowerCase();
          const personName = `${snippet.personName || ''}`.toLowerCase();
          const speakerEmail = `${snippet.speakerEmail || ''}`.toLowerCase();
          return (
            text.includes(loweredQuery) ||
            personName.includes(loweredQuery) ||
            speakerEmail.includes(loweredQuery)
          );
        })
        .map(summarizeMeetingTranscriptSnippet);

      return jsonText({
        actor: context.actor,
        transcriptId: args.transcriptId,
        query,
        count: matches.length,
        matches,
      });
    }
    case 'sync_recent_rooms': {
      return jsonText(await syncRecentRoomsIntoIndex(config, args));
    }
    case 'sync_all_rooms': {
      return jsonText(await syncAllRoomsIntoIndex(config, args));
    }
    case 'sync_room_history': {
      return jsonText(await syncRoomHistoryIntoIndex(config, args));
    }
    case 'resolve_space': {
      const resolved = await resolveRoomInput(config, args.actor || 'auto', args.space);
      return jsonText({
        actor: resolved.actor,
        roomId: resolved.roomId,
        room: summarizeRoom(resolved.room),
      });
    }
    case 'search_rooms': {
      const context = await getActorContext(config, args.actor || 'auto');
      const indexed = await searchIndexedRooms(config, context.actor, args);
      if (!indexed) {
        throw new Error(
          'Cached room metadata is unavailable. Run sync_all_rooms before using search_rooms.'
        );
      }
      return jsonText(indexed);
    }
    case 'get_room': {
      const context = await getActorContext(config, args.actor || 'auto');
      return jsonText(summarizeRoom(await context.api.getRoom(args.roomId)));
    }
    case 'create_room': {
      const context = await getActorContext(config, args.actor || 'auto');
      return jsonText(await context.api.createRoom({title: args.title, teamId: args.teamId}));
    }
    case 'list_teams': {
      const context = await getActorContext(config, args.actor || 'auto');
      const teams = await context.api.listTeams({max: args.max || 100});
      return jsonText({
        actor: context.actor,
        count: teams.length,
        teams: teams.map(summarizeTeam),
      });
    }
    case 'get_team': {
      const context = await getActorContext(config, args.actor || 'auto');
      return jsonText(summarizeTeam(await context.api.getTeam(args.teamId)));
    }
    case 'create_team': {
      const context = await getActorContext(config, args.actor || 'auto');
      return jsonText(summarizeTeam(await context.api.createTeam({name: args.name})));
    }
    case 'update_team': {
      const context = await getActorContext(config, args.actor || 'auto');
      return jsonText(summarizeTeam(await context.api.updateTeam(args.teamId, {id: args.teamId, name: args.name})));
    }
    case 'list_team_memberships': {
      const context = await getActorContext(config, args.actor || 'auto');
      const memberships = await context.api.listTeamMemberships({
        teamId: args.teamId,
        personId: args.personId,
        personEmail: args.personEmail,
        max: args.max || 100,
      });
      return jsonText({
        actor: context.actor,
        count: memberships.length,
        memberships: memberships.map(summarizeTeamMembership),
      });
    }
    case 'get_team_membership': {
      const context = await getActorContext(config, args.actor || 'auto');
      return jsonText(summarizeTeamMembership(await context.api.getTeamMembership(args.membershipId)));
    }
    case 'add_team_membership': {
      const context = await getActorContext(config, args.actor || 'auto');
      if (!args.personId && !args.personEmail) {
        throw new Error('Provide personId or personEmail.');
      }
      return jsonText(
        summarizeTeamMembership(
          await context.api.createTeamMembership({
            teamId: args.teamId,
            personId: args.personId,
            personEmail: args.personEmail,
            isModerator: Boolean(args.isModerator),
          })
        )
      );
    }
    case 'update_team_membership': {
      const context = await getActorContext(config, args.actor || 'auto');
      return jsonText(
        summarizeTeamMembership(
          await context.api.updateTeamMembership(args.membershipId, {
            id: args.membershipId,
            isModerator: Boolean(args.isModerator),
          })
        )
      );
    }
    case 'remove_team_membership': {
      const context = await getActorContext(config, args.actor || 'auto');
      await context.api.deleteTeamMembership(args.membershipId);
      return jsonText({deleted: true, membershipId: args.membershipId});
    }
    case 'search_people': {
      const context = await getActorContext(config, args.actor || 'auto');
      const max = args.max || 25;
      const query = `${args.query || ''}`.trim();
      const options = query.includes('@') ? {email: query, max} : {displayName: query, max};
      return jsonText({
        actor: context.actor,
        people: await context.api.listPeople(options),
      });
    }
    case 'get_person': {
      const context = await getActorContext(config, args.actor || 'auto');
      return jsonText(await context.api.getPerson(args.personId));
    }
    case 'list_memberships': {
      const context = await getActorContext(config, args.actor || 'auto');
      return jsonText({
        actor: context.actor,
        memberships: await context.api.listMemberships({
          roomId: args.roomId,
          personId: args.personId,
          personEmail: args.personEmail,
          max: args.max || 100,
        }),
      });
    }
    case 'add_membership': {
      const context = await getActorContext(config, args.actor || 'auto');
      if (!args.personId && !args.personEmail) {
        throw new Error('Provide personId or personEmail.');
      }
      return jsonText(
        await context.api.createMembership({
          roomId: args.roomId,
          personId: args.personId,
          personEmail: args.personEmail,
          isModerator: Boolean(args.isModerator),
        })
      );
    }
    case 'remove_membership': {
      const context = await getActorContext(config, args.actor || 'auto');
      await context.api.deleteMembership(args.membershipId);
      return jsonText({deleted: true, membershipId: args.membershipId});
    }
    case 'list_messages': {
      const context = await getActorContext(config, args.actor || 'auto');
      const messages = await context.api.listMessages({
        roomId: args.roomId,
        parentId: args.parentId,
        before: args.before,
        beforeMessage: args.beforeMessage,
        max: args.max || 50,
      });
      return jsonText({
        actor: context.actor,
        count: messages.length,
        messages: messages.map(summarizeMessage),
      });
    }
    case 'search_messages': {
      const context = await getActorContext(config, args.actor || 'auto');
      const indexed = await searchIndexedMessages(config, context.actor, args);
      if (!indexed) {
        throw new Error(
          'Cached message history is unavailable. Run sync_recent_rooms or sync_room_history before using search_messages.'
        );
      }
      return jsonText(indexed);
    }
    case 'get_message': {
      const context = await getActorContext(config, args.actor || 'auto');
      return jsonText(summarizeMessage(await context.api.getMessage(args.messageId)));
    }
    case 'list_thread_replies': {
      const context = await getActorContext(config, args.actor || 'auto');
      const messages = await context.api.listMessages({
        roomId: args.roomId,
        parentId: args.parentId,
        before: args.before,
        beforeMessage: args.beforeMessage,
        max: args.max || 50,
      });
      return jsonText({
        actor: context.actor,
        count: messages.length,
        parentId: args.parentId,
        messages: messages.map(summarizeMessage),
      });
    }
    case 'add_reaction': {
      const result = await runSdkHelper(config, args.actor || 'auto', 'add_reaction', {
        roomId: args.roomId,
        messageId: args.messageId,
        reaction: args.reaction,
      });
      return jsonText({
        actor: 'user',
        reaction: result,
      });
    }
    case 'delete_reaction': {
      const result = await runSdkHelper(config, args.actor || 'auto', 'delete_reaction', {
        roomId: args.roomId,
        reactionId: args.reactionId,
      });
      return jsonText({
        actor: 'user',
        reaction: result,
      });
    }
    case 'set_conversation_state': {
      const result = await runSdkHelper(config, args.actor || 'auto', 'set_conversation_state', {
        roomId: args.roomId,
        action: args.action,
      });
      return jsonText({
        actor: 'user',
        activity: result,
      });
    }
    case 'create_attachment_action': {
      const context = await getActorContext(config, args.actor || 'auto');
      return jsonText(
        summarizeAttachmentAction(
          await context.api.createAttachmentAction({
            messageId: args.messageId,
            type: args.type,
            inputs: isPlainObject(args.inputs) ? args.inputs : {},
          })
        )
      );
    }
    case 'get_attachment_action': {
      const context = await getActorContext(config, args.actor || 'auto');
      return jsonText(summarizeAttachmentAction(await context.api.getAttachmentAction(args.attachmentActionId)));
    }
    case 'send_message': {
      const context = await getActorContext(config, args.actor || 'auto');
      requireDestination(args);
      requireMessageContent(args);
      await enforceRoomWritePolicy(context, args.roomId);

      return jsonText(
        summarizeMessage(
          await context.api.createMessage({
            roomId: args.roomId,
            toPersonEmail: args.toPersonEmail,
            toPersonId: args.toPersonId,
            parentId: args.parentId,
            text: args.text,
            markdown: args.markdown,
            html: args.html,
            filePaths: coerceArray(args.filePaths),
            fileUrls: coerceArray(args.fileUrls),
            attachments: Array.isArray(args.attachments) ? args.attachments : [],
          })
        )
      );
    }
    case 'send_engineering_message': {
      const context = await getActorContext(config, args.actor || 'auto');
      requireDestination(args);
      await enforceRoomWritePolicy(context, args.roomId);

      const payload = buildEngineeringMessage(args);
      requireMessageContent(payload);

      return jsonText(
        summarizeMessage(
          await context.api.createMessage({
            roomId: args.roomId,
            toPersonEmail: args.toPersonEmail,
            toPersonId: args.toPersonId,
            parentId: args.parentId,
            text: payload.text,
            markdown: payload.markdown,
            html: payload.html,
            attachments: payload.attachments,
          })
        )
      );
    }
    case 'list_webhooks': {
      const context = await getActorContext(config, args.actor || 'auto');
      const webhooks = await context.api.listWebhooks({max: args.max || 100});
      return jsonText({
        actor: context.actor,
        count: webhooks.length,
        webhooks: webhooks.map(summarizeWebhook),
      });
    }
    case 'get_webhook': {
      const context = await getActorContext(config, args.actor || 'auto');
      return jsonText(summarizeWebhook(await context.api.getWebhook(args.webhookId)));
    }
    case 'create_webhook': {
      const context = await getActorContext(config, args.actor || 'auto');
      return jsonText(
        summarizeWebhook(
          await context.api.createWebhook({
            resource: args.resource,
            event: args.event,
            filter: args.filter,
            targetUrl: args.targetUrl,
            name: args.name,
            secret: args.secret,
          })
        )
      );
    }
    case 'update_webhook': {
      const context = await getActorContext(config, args.actor || 'auto');
      return jsonText(
        summarizeWebhook(
          await context.api.updateWebhook(args.webhookId, {
            id: args.webhookId,
            resource: args.resource,
            event: args.event,
            filter: args.filter,
            targetUrl: args.targetUrl,
            name: args.name,
            secret: args.secret,
          })
        )
      );
    }
    case 'delete_webhook': {
      const context = await getActorContext(config, args.actor || 'auto');
      await context.api.deleteWebhook(args.webhookId);
      return jsonText({deleted: true, webhookId: args.webhookId});
    }
    case 'update_message': {
      const context = await getActorContext(config, args.actor || 'auto');
      await enforceRoomWritePolicy(context, args.roomId);
      return jsonText(
        summarizeMessage(
          await context.api.updateMessage(args.messageId, {
            roomId: args.roomId,
            text: args.text,
            markdown: args.markdown,
            html: args.html,
          })
        )
      );
    }
    case 'delete_message': {
      const context = await getActorContext(config, args.actor || 'auto');
      await context.api.deleteMessage(args.messageId);
      return jsonText({deleted: true, messageId: args.messageId});
    }
    case 'download_file': {
      return jsonText(
        await downloadFileWithOptionalExtraction(config, args.actor || 'auto', args.url, {
          outputDir: args.outputDir,
          filename: args.filename,
          extractText: Boolean(args.extractText),
          maxChars: args.maxChars,
        })
      );
    }
    case 'extract_message_files': {
      const context = await getActorContext(config, args.actor || 'auto');
      const message = await context.api.getMessage(args.messageId);
      const files = message.files || [];
      const downloads = [];

      for (const url of files) {
        downloads.push(
          await downloadFileWithOptionalExtraction(config, context.actor, url, {
            outputDir: args.outputDir,
            extractText: Boolean(args.extractText),
            maxChars: args.maxChars,
          })
        );
      }

      return jsonText({
        actor: context.actor,
        message: summarizeMessage(message),
        fileCount: downloads.length,
        files: downloads,
      });
    }
    case 'find_latest_attachment': {
      const actor = args.actor || 'auto';
      const context = await getActorContext(config, actor);
      let room = null;

      if (args.roomId) {
        room = await context.api.getRoom(args.roomId);
      } else if (args.space) {
        room = (await resolveRoomInput(config, actor, args.space)).room;
      } else if (args.roomQuery) {
        const rooms = await context.api.listRooms({max: args.maxRooms || 100});
        const ranked = rankRooms(rooms, args.roomQuery);
        room = ranked[0]?.room || null;
      }

      if (!room) {
        throw new Error('Provide roomId, space, or roomQuery to identify the room.');
      }

      const messages = await context.api.listMessages({
        roomId: room.id,
        max: args.scanMessages || 100,
      });
      const latest = messages.find((message) => Array.isArray(message.files) && message.files.length > 0);
      if (!latest) {
        return jsonText({
          actor: context.actor,
          room: summarizeRoom(room),
          found: false,
        });
      }

      return jsonText({
        actor: context.actor,
        found: true,
        room: summarizeRoom(room),
        message: summarizeMessage(latest),
      });
    }
    case 'extract_local_file_text': {
      const filePath = resolveAllowedLocalPath(config, args.filePath);
      const extracted = extractLocalFileText(filePath, args.mimeType || '');
      return jsonText({
        filePath,
        ...extracted,
        text: limitText(extracted.text || ''),
      });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function sendMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  sendMessage({jsonrpc: '2.0', id, result});
}

function sendError(id, code, message, data) {
  sendMessage({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      data,
    },
  });
}

async function handleRequest(config, request) {
  const {id, method, params = {}} = request;

  try {
    switch (method) {
      case 'initialize':
        return sendResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: {
              listChanged: false,
            },
          },
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION,
          },
        });
      case 'ping':
        return sendResult(id, {});
      case 'tools/list':
        return sendResult(id, {tools: TOOLS});
      case 'tools/call': {
        const result = await callTool(config, params.name, params.arguments || {});
        return sendResult(id, result);
      }
      default:
        return sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    const detail = error?.body ? JSON.stringify(error.body) : error?.stack || error?.message || String(error);
    return sendResult(id, errorText(error.message || 'Tool execution failed', limitText(detail, 8000)));
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig(args.envFile);

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on('line', (line) => {
    if (!line.trim()) return;

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      sendError(null, -32700, 'Parse error', error.message);
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(message, 'id')) {
      return;
    }

    void handleRequest(config, message);
  });

}

export {TOOLS, validatePublishedToolSchemas};

if (import.meta.main) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}
