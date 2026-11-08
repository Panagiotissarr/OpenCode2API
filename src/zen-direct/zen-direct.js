// Zen inference lane: the proxy's direct, disguised client for the keyless
// OpenCode Zen free tier (https://opencode.ai/inference/openai/v1).
//
// The 1.x backend the proxy used to drive cannot carry client tools natively
// (a plugin's `tool` map never reaches the provider request — Hooks.tool is
// not bridged into the ToolRegistry), and its per-request `tools` map only
// disables built-ins. Tool-carrying requests used to ride a text contract in
// the system prompt, which smaller models follow poorly (#26).
//
// This module sends every /v1/chat/completions request straight to the public
// OpenAI-compatible lane, dressed exactly like the official OpenCode 2.x CLI,
// mirroring the disguise proven out by the jasonxu114514/opencode2api gateway:
//
//   - Session identity: x-opencode-session carries a descending-timestamp
//     ses_ id (the layout the 2026-10 gate validates), kept stable per
//     conversation so upstream prompt caches keep hitting; x-opencode-project
//     is a fresh 40-hex git-commit-shaped id per request (the tier ledges
//     quota per project, so one shared id is one shared bucket).
//   - Headers: the "opencode/<channel>/<version>/cli" User-Agent, x-opencode-
//     client: cli, both session headers plus affinity. The v1 lane's
//     x-opencode-request header is NOT sent — the /inference gate 403s it.
//   - System prompt: the official CLI prompt (captured from the 2.x client)
//     with the env block and built-in skills listing, followed by whatever
//     system instructions the client itself sent.
//   - Tools: client tools renamed to opaque clint_<digest> names (a
//     client-named tool on the wire is what the gate refuses) and the full
//     official 2.x toolset appended behind them, every entry strict:false.
//     Tool references (tool_choice, history tool_calls) are rewritten too,
//     and response tool names are mapped back.
//   - Body: always streamed with stream_options.include_usage (the lane only
//     reports usage while streaming) and a 2.x-client completion ceiling.
//
// The backend session pipeline remains for /v1/messages, /v1/responses and
// any request this lane cannot serve.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The official 2.x CLI system prompt, captured verbatim.
const OFFICIAL_PROMPT = fs.readFileSync(path.join(__dirname, 'official-prompt.txt'), 'utf8').trimEnd();

// Official 2.x tool definitions (name -> {description, parameters}).
const OFFICIAL_TOOLS = JSON.parse(fs.readFileSync(path.join(__dirname, 'official-tools.json'), 'utf8'));

// The official toolset order, kept for a stable wire body.
const OFFICIAL_TOOL_ORDER = [
    'edit', 'execute', 'glob', 'grep', 'question', 'read', 'shell',
    'skill', 'subagent', 'webfetch', 'websearch', 'write', 'patch'
];

const CLIENT_TOOL_PREFIX = 'clint_';
const CLIENT_TOOL_DIGEST_LENGTH = 12;
const TOOL_WIRE_NAME_LIMIT = 64;

const V2_USER_AGENT = 'opencode/latest/2.0.32/cli';

// Free-tier limits the official client always sets.
const DEFAULT_MAX_COMPLETION_TOKENS = 32000;

// --- session identity ------------------------------------------------------

const SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const DESCENDING_TIME_PATTERN = /^[0-9a-f]{9}f[c-f][0-9a-f]$/;
// A session timestamp may sit up to ~30 days in the past; the gate rejects a
// date roughly a year off, so a month leaves room for skew.
const SESSION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const BOOT_NONCE = crypto.randomBytes(16);

const isOfficialSessionId = (value) =>
    SESSION_PATTERN.test(String(value || '')) && DESCENDING_TIME_PATTERN.test(String(value || '').slice(4, 16));

function base62Fixed(bigInt, width) {
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    let n = bigInt;
    const out = [];
    for (let i = 0; i < width; i += 1) {
        out.push(alphabet[Number(n % 62n)]);
        n = n / 62n;
    }
    return out.reverse().join('');
}

// Mints a canonical ses_ id for a conversation signal: official client-minted
// ids pass through, anything else is hashed into the same layout. The
// descending time part derives from a fixed hash of the signal, so the same
// conversation always maps to the same session id within this process.
export function canonicalSessionId(signal) {
    if (isOfficialSessionId(signal)) return signal;
    const hasher = crypto.createHash('sha256');
    hasher.update('ses\x00');
    hasher.update(BOOT_NONCE);
    hasher.update('\x00');
    hasher.update(String(signal));
    const sum = hasher.digest();
    // Fix the time base per process (start of day) so repeat calls agree.
    const dayBase = Math.floor(Date.now() / 86400000) * 86400000;
    const window = SESSION_WINDOW_MS;
    const offset = ((sum[0] << 24) | (sum[1] << 16) | (sum[2] << 8) | sum[3]) >>> 0;
    const base = dayBase - (offset % window);
    const current = (BigInt(base) << 12n) | 1n;
    const inverted = ~current & 0xFFFFFFFFFFFFn;
    const timePart = inverted.toString(16).padStart(12, '0');
    const randomPart = base62Fixed(BigInt('0x' + sum.subarray(6, 16).toString('hex')), 14);
    return 'ses_' + timePart + randomPart;
}

// A fresh 40-hex git-commit-shaped project id (the free tier ledges quota per
// project id, so every request gets its own bucket).
export function randomProjectId() {
    return crypto.randomBytes(20).toString('hex');
}

// --- tool shaping ----------------------------------------------------------

function clientToolWireName(name, used) {
    const digest = crypto.createHash('sha256').update(String(name)).digest('hex').slice(0, CLIENT_TOOL_DIGEST_LENGTH);
    let base = CLIENT_TOOL_PREFIX + digest.slice(0, TOOL_WIRE_NAME_LIMIT - CLIENT_TOOL_PREFIX.length);
    if (!used.has(base)) {
        used.add(base);
        return base;
    }
    for (let suffix = 2; ; suffix += 1) {
        const tag = `_${suffix}`;
        const candidate = base.slice(0, Math.max(0, TOOL_WIRE_NAME_LIMIT - tag.length)) + tag;
        if (!used.has(candidate)) {
            used.add(candidate);
            return candidate;
        }
    }
}

function officialToolDefinition(name) {
    const definition = OFFICIAL_TOOLS[name] || {};
    let description = definition.description || `Agent tool ${name}`;
    if (name === 'shell' && process.platform === 'win32') {
        description = description.replace('on Linux using bash', 'on Windows using powershell');
    }
    return {
        type: 'function',
        function: {
            name,
            description,
            parameters: definition.parameters || { type: 'object', properties: {} },
            strict: false
        }
    };
}

// Renames every client tool to an opaque wire name and appends the full
// official toolset — the disguised request always carries the official tools
// (agent shape), whether or not the client declared its own. Returns the
// wire->client rename map (empty when the client sent no tools).
export function shapeToolsForFreeTier(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const tools = Array.isArray(payload.tools) ? payload.tools : [];

    const renames = new Map(); // wire name -> client name
    const used = new Set();
    const shaped = [];

    for (const tool of tools) {
        if (!tool || typeof tool !== 'object') continue;
        // Chat nested shape { type:'function', function:{ name, parameters } }
        // and Responses flat shape { type:'function', name, parameters }.
        const definition = tool.function && typeof tool.function === 'object' ? tool.function : tool;
        const name = String(definition.name || '').trim();
        if (!name) continue;
        const wireName = clientToolWireName(name, used);
        renames.set(wireName, name);
        const entry = { ...tool, strict: false };
        if (entry.function && typeof entry.function === 'object') {
            entry.function = { ...entry.function, name: wireName, strict: false };
        } else {
            entry.name = wireName;
        }
        shaped.push(entry);
    }

    for (const name of OFFICIAL_TOOL_ORDER) {
        if (!used.has(name)) shaped.push(officialToolDefinition(name));
    }
    payload.tools = shaped;

    rewriteToolReferences(payload, renames);
    return renames;
}

function rewriteToolReferences(payload, renames) {
    const wireOf = (clientName) => {
        for (const [wire, client] of renames.entries()) {
            if (client === clientName) return wire;
        }
        return null;
    };
    const renameContainer = (container) => {
        if (!container || typeof container !== 'object') return;
        const current = container.function?.name || container.name;
        if (typeof current !== 'string') return;
        const wire = wireOf(current);
        if (!wire) return;
        if (container.function && typeof container.function === 'object') container.function.name = wire;
        else container.name = wire;
    };
    const choice = payload.tool_choice;
    if (choice && typeof choice === 'object') renameContainer(choice.function || choice);
    const call = payload.function_call;
    if (call && typeof call === 'object') renameContainer(call);
    for (const message of Array.isArray(payload.messages) ? payload.messages : []) {
        if (!message || typeof message !== 'object') continue;
        if (message.function_call && typeof message.function_call === 'object') renameContainer(message.function_call);
        for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
            renameContainer(toolCall);
        }
    }
}

// --- system prompt ---------------------------------------------------------

function officialEnvironment(model) {
    const apiModel = String(model || '').replace(/^opencode\//, '') || 'unknown';
    const platform = process.platform === 'win32' ? 'win32' : process.platform;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const now = new Date();
    const date = `${months[now.getUTCMonth()]} ${String(now.getUTCDate()).padStart(2, '0')} ${now.getUTCFullYear()}`;
    return [
        `You are powered by the model named ${apiModel}. The exact model ID is opencode/${apiModel}`,
        'Here is some useful information about the environment you are running in:',
        '<env>',
        '  Working directory: /workspace',
        '  Workspace root folder: /workspace',
        '  Is directory a git repo: yes',
        `  Platform: ${platform}`,
        `  Today's date: ${date}`,
        '</env>'
    ].join('\n');
}

const OFFICIAL_SKILLS = `Skills provide specialized instructions and workflows for specific tasks.
Use the skill tool to load a skill when a task matches its description.
<available_skills>
  <skill>
    <name>customize-opencode</name>
    <description>Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself.</description>
    <location>&lt;built-in&gt;</location>
  </skill>
</available_skills>`;

export function officialSystemPrompt(model) {
    return OFFICIAL_PROMPT + '\n' + officialEnvironment(model) + '\n' + OFFICIAL_SKILLS;
}

const PROMPT_MARKER = 'You are opencode, an interactive CLI tool';

// Folds system/developer messages into one system string: the official CLI
// prompt first, the caller's own instructions after it. A body that already
// carries the official prompt is left alone (a disguised client re-sending
// history must not double it).
export function injectOfficialSystemPrompt(payload) {
    const messages = Array.isArray(payload.messages) ? payload.messages : null;
    if (!messages) return false;
    let hasSystem = false;
    for (const message of messages) {
        const role = message?.role;
        if (role !== 'system' && role !== 'developer') continue;
        const content = typeof message?.content === 'string'
            ? message.content
            : Array.isArray(message?.content)
                ? message.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
                : '';
        if (content.includes(PROMPT_MARKER)) return false; // already official
        if (content) hasSystem = true;
    }
    const kept = [];
    const instructions = [];
    for (const message of messages) {
        const role = message?.role;
        if (role !== 'system' && role !== 'developer') {
            kept.push(message);
            continue;
        }
        const content = typeof message?.content === 'string'
            ? message.content
            : Array.isArray(message?.content)
                ? message.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
                : '';
        if (content) instructions.push(content);
    }
    const system = [officialSystemPrompt(payload.model), ...instructions].filter(Boolean).join('\n\n');
    payload.messages = [{ role: 'system', content: system }, ...kept];
    return hasSystem || true;
}

// --- response restore ------------------------------------------------------

// Restores client tool names inside one decoded JSON payload (a response
// object or one SSE frame). Mutates and returns the object.
export function restoreClientToolNames(payload, renames) {
    if (!renames || renames.size === 0 || !payload || typeof payload !== 'object') return payload;
    const restore = (name) => (typeof name === 'string' && renames.has(name) ? renames.get(name) : name);
    const visitChoice = (choice) => {
        if (!choice || typeof choice !== 'object') return;
        const message = choice.message;
        if (message && Array.isArray(message.tool_calls)) {
            for (const call of message.tool_calls) {
                if (call?.function) call.function.name = restore(call.function.name);
            }
        }
        const delta = choice.delta;
        if (delta && Array.isArray(delta.tool_calls)) {
            for (const call of delta.tool_calls) {
                if (call?.function) call.function.name = restore(call.function.name);
            }
        }
        if (choice.function_call?.name) choice.function_call.name = restore(choice.function_call.name);
        if (delta?.function_call?.name) delta.function_call.name = restore(delta.function_call.name);
    };
    for (const choice of Array.isArray(payload.choices) ? payload.choices : []) visitChoice(choice);
    return payload;
}

// --- request assembly ------------------------------------------------------

// Conversation signal: the explicit session headers clients send, else the
// hash of (system prelude + first user turn), which stays stable as a
// conversation grows while separating conversations that begin differently.
function conversationSignal(body, headers = {}) {
    const explicit = headers['x-opencode-session']
        || headers['x-opencode-session-id']
        || headers['x-session-affinity']
        || headers['x-session-id']
        || headers['session_id']
        || headers['conversation-id']
        || headers['conversation_id']
        || body?.conversation_id
        || body?.metadata?.session_id;
    if (explicit && typeof explicit === 'string') return explicit;
    const prelude = [];
    if (body?.system !== undefined) prelude.push(body.system);
    if (body?.instructions !== undefined) prelude.push(body.instructions);
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    let firstUser = null;
    for (const message of messages) {
        if (message?.role === 'system' || message?.role === 'developer') {
            prelude.push(message.content);
            continue;
        }
        if (message?.role === 'user') {
            firstUser = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? null);
            break;
        }
    }
    if (firstUser === null) return null;
    return crypto.createHash('sha256').update(JSON.stringify([...prelude, firstUser])).digest('hex');
}

const sessionCache = new Map();
const SESSION_CACHE_LIMIT = 512;

function sessionIdFor(signal) {
    if (!signal) return canonicalSessionId(crypto.randomBytes(16).toString('hex'));
    if (sessionCache.has(signal)) return sessionCache.get(signal);
    if (sessionCache.size >= SESSION_CACHE_LIMIT) {
        // Drop the oldest entries; canonicalSessionId is deterministic in the
        // process lifetime, so a re-derive returns the same id anyway.
        const oldest = sessionCache.keys().next().value;
        sessionCache.delete(oldest);
    }
    const id = canonicalSessionId(signal);
    sessionCache.set(signal, id);
    return id;
}

// Builds the disguised upstream request. Returns the fetch() arguments plus
// the renames the response path needs.
export function buildZenDirectRequest({ body, zenApiKey = '', inferenceBaseUrl = 'https://opencode.ai/inference/openai/v1', headers = {} }) {
    const payload = { ...body };
    injectOfficialSystemPrompt(payload);
    const renames = shapeToolsForFreeTier(payload) || new Map();
    // The lane reports usage only while streaming; a non-stream caller gets
    // its single JSON frame re-assembled by the caller.
    payload.stream = true;
    payload.stream_options = { include_usage: true };
    if (!('max_completion_tokens' in payload) && !('max_tokens' in payload)) {
        payload.max_completion_tokens = DEFAULT_MAX_COMPLETION_TOKENS;
    }
    const signal = conversationSignal(body, headers);
    const sessionId = sessionIdFor(signal);
    const requestHeaders = {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'User-Agent': V2_USER_AGENT,
        'x-opencode-client': 'cli',
        'x-opencode-session': sessionId,
        'x-opencode-session-id': sessionId,
        'x-session-affinity': sessionId,
        'X-Session-Id': sessionId,
        'x-opencode-project': randomProjectId(),
        ...(zenApiKey ? { Authorization: `Bearer ${zenApiKey}` } : { Authorization: 'Bearer public' })
    };
    return {
        url: `${inferenceBaseUrl.replace(/\/+$/, '')}/chat/completions`,
        headers: requestHeaders,
        body: JSON.stringify(payload),
        renames,
        sessionId
    };
}
