#!/usr/bin/env bun

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';

const DEFAULT_SCOPES = [
  'spark:all',
  'spark:calls_read',
  'spark:calls_write',
  'spark:recordings_read',
  'spark:recordings_write',
  'spark:webhooks_read',
  'spark:webhooks_write',
  'meeting:schedules_read',
  'meeting:schedules_write',
  'meeting:recordings_read',
  'meeting:recordings_write',
  'meeting:transcripts_read',
  'meeting:summaries_read',
  'meeting:summaries_write',
  'meeting:participants_read',
  'meeting:participants_write',
  'meeting:controls_read',
  'meeting:controls_write',
  'meeting:preferences_read',
  'meeting:preferences_write',
].join(' ');

function parseArgs(argv) {
  const out = {
    command: argv[2] || 'status',
    envFile: process.env.ENV_FILE || '',
    openBrowser: true,
    timeoutSeconds: 180,
  };

  for (let index = 3; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--env-file' && next) {
      out.envFile = next;
      index += 1;
      continue;
    }

    if (arg === '--no-open') {
      out.openBrowser = false;
      continue;
    }

    if (arg === '--timeout' && next) {
      out.timeoutSeconds = Number(next) || out.timeoutSeconds;
      index += 1;
      continue;
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
  const env = {
    ...fileEnv,
    ...process.env,
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

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getTokenFilePath(config) {
  const configured = config.env.WEBEX_OAUTH_TOKEN_FILE || '.webex_tokens.json';
  return resolveMaybeRelative(config.envDir, configured);
}

function getScopeString(config) {
  return `${config.env.WEBEX_OAUTH_SCOPES || DEFAULT_SCOPES}`.trim();
}

function assertOauthConfig(config) {
  const missing = [];
  for (const key of ['WEBEX_CLIENT_ID', 'WEBEX_CLIENT_SECRET', 'WEBEX_REDIRECT_URI']) {
    if (!config.env[key]) missing.push(key);
  }

  if (!getScopeString(config)) missing.push('WEBEX_OAUTH_SCOPES');
  if (missing.length) {
    throw new Error(`Missing required OAuth env: ${missing.join(', ')}`);
  }
}

function buildAuthorizeUrl(config, state) {
  const query = new URLSearchParams();
  query.set('client_id', config.env.WEBEX_CLIENT_ID);
  query.set('response_type', 'code');
  query.set('redirect_uri', config.env.WEBEX_REDIRECT_URI);
  query.set('scope', getScopeString(config));
  query.set('state', state);
  return `https://webexapis.com/v1/authorize?${query.toString()}`;
}

async function exchangeAuthorizationCode(config, code) {
  const form = new URLSearchParams();
  form.set('grant_type', 'authorization_code');
  form.set('client_id', config.env.WEBEX_CLIENT_ID);
  form.set('client_secret', config.env.WEBEX_CLIENT_SECRET);
  form.set('code', code);
  form.set('redirect_uri', config.env.WEBEX_REDIRECT_URI);

  const response = await fetch('https://webexapis.com/v1/access_token', {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: form.toString(),
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text;
  }

  if (!response.ok) {
    throw new Error(`Authorization code exchange failed with ${response.status}: ${JSON.stringify(body)}`);
  }

  return persistToken(config, body);
}

async function refreshToken(config) {
  const existing = readJson(getTokenFilePath(config), null);
  if (!existing?.refresh_token) {
    throw new Error('No refresh_token is stored yet. Run auth:login first.');
  }

  const form = new URLSearchParams();
  form.set('grant_type', 'refresh_token');
  form.set('client_id', config.env.WEBEX_CLIENT_ID);
  form.set('client_secret', config.env.WEBEX_CLIENT_SECRET);
  form.set('refresh_token', existing.refresh_token);
  form.set('redirect_uri', config.env.WEBEX_REDIRECT_URI);

  const response = await fetch('https://webexapis.com/v1/access_token', {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: form.toString(),
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text;
  }

  if (!response.ok) {
    throw new Error(`Refresh failed with ${response.status}: ${JSON.stringify(body)}`);
  }

  return persistToken(config, {
    ...existing,
    ...body,
  });
}

function persistToken(config, body) {
  const now = Date.now();
  const tokenFile = getTokenFilePath(config);
  const token = {
    ...body,
    obtained_at: now,
    expires_at: now + Number(body.expires_in || 0) * 1000,
  };
  writeJson(tokenFile, token);
  return {tokenFile, token};
}

function openBrowser(url) {
  const platform = process.platform;
  let command;
  let args;

  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function respondHtml(res, statusCode, body) {
  res.writeHead(statusCode, {'content-type': 'text/html; charset=utf-8'});
  res.end(`<!doctype html><html><body style="font-family: sans-serif; padding: 24px;"><p>${body}</p></body></html>`);
}

async function login(config, options = {}) {
  assertOauthConfig(config);

  const redirect = new URL(config.env.WEBEX_REDIRECT_URI);
  if (!/^https?:$/.test(redirect.protocol)) {
    throw new Error('WEBEX_REDIRECT_URI must be http:// or https://.');
  }

  const state = crypto.randomBytes(24).toString('hex');
  const authorizeUrl = buildAuthorizeUrl(config, state);

  const result = await new Promise((resolve, reject) => {
    let timeoutHandle = null;
    function finish(fn, value) {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      fn(value);
    }

    const server = http.createServer(async (req, res) => {
      try {
        const incoming = new URL(req.url || '/', config.env.WEBEX_REDIRECT_URI);
        if (incoming.pathname !== redirect.pathname) {
          respondHtml(res, 404, 'Not found.');
          return;
        }

        const returnedState = incoming.searchParams.get('state') || '';
        const code = incoming.searchParams.get('code') || '';
        const error = incoming.searchParams.get('error') || '';
        const errorDescription = incoming.searchParams.get('error_description') || '';

        if (error) {
          respondHtml(res, 400, `Webex OAuth returned an error: ${error}${errorDescription ? ` (${errorDescription})` : ''}`);
          server.close();
          finish(reject, new Error(`Webex OAuth returned an error: ${error}${errorDescription ? ` (${errorDescription})` : ''}`));
          return;
        }

        if (returnedState !== state) {
          respondHtml(res, 400, 'OAuth state mismatch.');
          server.close();
          finish(reject, new Error('OAuth state mismatch.'));
          return;
        }

        if (!code) {
          respondHtml(res, 400, 'No OAuth code was returned.');
          server.close();
          finish(reject, new Error('No OAuth code was returned.'));
          return;
        }

        const persisted = await exchangeAuthorizationCode(config, code);
        respondHtml(res, 200, 'Webex OAuth complete. You can close this tab.');
        server.close();
        finish(resolve, {authorizeUrl, ...persisted});
      } catch (error) {
        try {
          respondHtml(res, 500, 'OAuth callback handling failed.');
        } catch {}
        server.close();
        finish(reject, error);
      }
    });

    server.on('error', (error) => finish(reject, error));
    server.listen(Number(redirect.port || (redirect.protocol === 'https:' ? 443 : 80)), redirect.hostname, () => {
      if (options.openBrowser) {
        try {
          openBrowser(authorizeUrl);
        } catch {
          // If opening the browser fails, the caller still gets the URL.
        }
      }
      console.log(`Listening for OAuth callback on ${config.env.WEBEX_REDIRECT_URI}`);
      console.log(`Authorize URL:\n${authorizeUrl}\n`);
      console.log('Complete the login in your browser. This process will exit after the callback is received.');
    });

    timeoutHandle = setTimeout(() => {
      server.close();
      finish(reject, new Error(`Timed out waiting for OAuth callback after ${options.timeoutSeconds} seconds.`));
    }, Math.max(30, Number(options.timeoutSeconds || 180)) * 1000);
    timeoutHandle.unref?.();
  });

  return result;
}

function describeStatus(config) {
  const tokenFile = getTokenFilePath(config);
  const token = readJson(tokenFile, null);
  if (!token?.access_token) {
    return {
      hasTokens: false,
      tokenFile,
      redirectUri: config.env.WEBEX_REDIRECT_URI || '',
      scopes: getScopeString(config).split(/\s+/).filter(Boolean),
    };
  }

  const now = Date.now();
  return {
    hasTokens: true,
    tokenFile,
    redirectUri: config.env.WEBEX_REDIRECT_URI || '',
    scopes: `${token.scope || getScopeString(config)}`.split(/\s+/).filter(Boolean),
    expiresAt: token.expires_at || null,
    expiresInSeconds: token.expires_at ? Math.max(0, Math.floor((token.expires_at - now) / 1000)) : null,
    hasRefreshToken: Boolean(token.refresh_token),
  };
}

function clearToken(config) {
  const tokenFile = getTokenFilePath(config);
  if (fs.existsSync(tokenFile)) {
    fs.unlinkSync(tokenFile);
  }
  return {cleared: true, tokenFile};
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig(args.envFile);

  switch (args.command) {
    case 'status':
      console.log(JSON.stringify(describeStatus(config), null, 2));
      return;
    case 'login': {
      const result = await login(config, args);
      console.log(JSON.stringify({
        success: true,
        tokenFile: result.tokenFile,
        expiresAt: result.token.expires_at || null,
        scope: result.token.scope || '',
      }, null, 2));
      return;
    }
    case 'refresh': {
      assertOauthConfig(config);
      const result = await refreshToken(config);
      console.log(JSON.stringify({
        success: true,
        tokenFile: result.tokenFile,
        expiresAt: result.token.expires_at || null,
        scope: result.token.scope || '',
      }, null, 2));
      return;
    }
    case 'clear':
      console.log(JSON.stringify(clearToken(config), null, 2));
      return;
    default:
      console.error(`Unknown command "${args.command}". Use: status | login | refresh | clear`);
      process.exitCode = 1;
  }
}

await main();
