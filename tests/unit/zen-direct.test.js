// Zen inference lane (#26): tool-carrying requests to free models must ride the
// direct lane with native tool passthrough — client tools renamed to opaque
// wire names, the official `read` appended, official system prompt injected —
// and tool calls must come back with the client's own names.
import { jest } from '@jest/globals';
import request from 'supertest';
import http from 'http';

const sdkMocks = {
    configProviders: jest.fn(async () => ({
        data: { providers: [{ id: 'opencode', models: { 'beam-free': { name: 'Beam Free' }, 'space-bunny': { name: 'Space Bunny' } } }] }
    })),
    configUpdate: jest.fn(async () => ({})),
    configGet: jest.fn(async () => ({ data: { plugin: [] } })),
    toolIds: jest.fn(async () => ({ data: ['bash', 'read', 'webfetch'] })),
    sessionCreate: jest.fn(async () => ({ data: { id: 'ses_test' } })),
    sessionPrompt: jest.fn(async () => ({ data: { parts: [{ type: 'text', text: 'ok' }] } })),
    sessionMessages: jest.fn(async () => ([
        { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'ok' }] }
    ])),
    sessionDelete: jest.fn(async () => ({})),
    eventSubscribe: jest.fn(async () => ({ stream: (async function* () { })() }))
};

jest.unstable_mockModule('@opencode-ai/sdk', () => ({
    createOpencodeClient: jest.fn(() => ({
        config: { providers: sdkMocks.configProviders, update: sdkMocks.configUpdate, get: sdkMocks.configGet },
        tool: { ids: sdkMocks.toolIds },
        session: {
            create: sdkMocks.sessionCreate,
            prompt: sdkMocks.sessionPrompt,
            messages: sdkMocks.sessionMessages,
            delete: sdkMocks.sessionDelete
        },
        event: { subscribe: sdkMocks.eventSubscribe }
    }))
}));

// Stand-in for the Zen inference lane: records the shaped request and replies
// with an SSE stream containing one tool call whose name is whatever wire name
// the proxy sent for the client's `get_weather`.
let lastUpstream = null;
const lane = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        lastUpstream = { url: req.url, headers: req.headers, body: JSON.parse(body) };
        const wireName = (lastUpstream.body.tools || []).find((t) => t.function?.name?.startsWith('clint_'))?.function?.name || 'clint_missing';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const frames = [
            { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: wireName, arguments: '{"ci' } }] }, finish_reason: null }] },
            { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Paris"}' } }] }, finish_reason: 'tool_calls' }] },
            { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, prompt_tokens_details: { cached_tokens: 8 } } }
        ];
        for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    });
});

// Stands in for the OpenCode backend's health endpoint; the API itself is mocked.
const BACKEND = http.createServer((req, res) => {
    res.writeHead(req.url === '/global/health' ? 200 : 404);
    res.end(req.url === '/global/health' ? '{"healthy":true,"version":"1.19.0"}' : '');
});

let proxy;
let lanePort;
let backendPort;

beforeAll(async () => {
    await new Promise((resolve) => lane.listen(0, '127.0.0.1', resolve));
    await new Promise((resolve) => BACKEND.listen(0, '127.0.0.1', resolve));
    lanePort = lane.address().port;
    backendPort = BACKEND.address().port;
    process.env.OPENCODE_ZEN_INFERENCE_URL = `http://127.0.0.1:${lanePort}/v1`;
    const { createApp } = await import('../../src/proxy.js');
    proxy = createApp({
        PORT: 0,
        API_KEY: 'k',
        OPENCODE_SERVER_URL: `http://127.0.0.1:${backendPort}`,
        REQUEST_TIMEOUT_MS: 5000,
        MANAGE_BACKEND: false,
        DEBUG: false
    }).app;
});

afterAll(async () => {
    await new Promise((resolve) => lane.close(resolve));
    await new Promise((resolve) => BACKEND.close(resolve));
});

const clientTool = { type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } };

describe('zen-direct lane for tool-carrying free-model requests', () => {
    test('non-stream: sends native tools through the lane and restores client names', async () => {
        lastUpstream = null;
        const res = await request(proxy)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer k')
            .send({
                model: 'opencode/beam-free',
                messages: [{ role: 'user', content: 'Weather in Paris?' }],
                tools: [clientTool]
            });

        expect(res.statusCode).toEqual(200);
        expect(lastUpstream.url).toEqual('/v1/chat/completions');
        const wireNames = lastUpstream.body.tools.map((t) => t.function.name);
        expect(wireNames.some((n) => n.startsWith('clint_'))).toBe(true);
        expect(wireNames).toContain('read'); // gate tool appended
        expect(lastUpstream.body.stream).toBe(true); // lane reports usage only while streaming
        expect(lastUpstream.body.messages[0].role).toEqual('system');
        expect(lastUpstream.body.messages[0].content.startsWith('You are opencode, an interactive CLI tool')).toBe(true);
        expect(lastUpstream.headers['user-agent'].startsWith('opencode/')).toBe(true);
        const message = res.body.choices[0].message;
        expect(message.tool_calls).toHaveLength(1);
        expect(message.tool_calls[0].function.name).toEqual('get_weather');
        expect(JSON.parse(message.tool_calls[0].function.arguments)).toEqual({ city: 'Paris' });
        expect(res.body.choices[0].finish_reason).toEqual('tool_calls');
        expect(res.body.usage.prompt_tokens).toEqual(12);
        expect(res.body.usage.prompt_tokens_details.cached_tokens).toEqual(8);
    });

    test('stream: passes SSE frames through with client tool names', async () => {
        lastUpstream = null;
        const res = await request(proxy)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer k')
            .send({
                model: 'opencode/beam-free',
                messages: [{ role: 'user', content: 'Weather?' }],
                tools: [clientTool],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        const frames = res.text.split('\n\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .filter((data) => data !== '[DONE]')
            .map((data) => JSON.parse(data));
        const toolCallFrames = frames.filter((f) => f.choices?.[0]?.delta?.tool_calls?.length);
        expect(toolCallFrames.length).toBeGreaterThan(0);
        expect(toolCallFrames[0].choices[0].delta.tool_calls[0].function.name).toEqual('get_weather');
    });

    test('every opencode-provider request rides the lane, with or without tools', async () => {
        // Tool-less request: no clint_ rename, but the official toolset and
        // prompt still ride along.
        lastUpstream = null;
        await request(proxy)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer k')
            .send({ model: 'opencode/beam-free', messages: [{ role: 'user', content: 'hi' }] });
        expect(lastUpstream).not.toBeNull();
        expect(lastUpstream.body.tools.map((t) => t.function.name)).toEqual(
            expect.arrayContaining(['read', 'bash'.replace('bash', 'edit'), 'grep'])
        );
        expect(lastUpstream.body.messages[0].content.startsWith('You are opencode, an interactive CLI tool')).toBe(true);

        // Conversation affinity: the same conversation reuses the session id.
        const first = lastUpstream.headers['x-opencode-session'];
        await request(proxy)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer k')
            .send({ model: 'opencode/beam-free', messages: [{ role: 'user', content: 'hi' }, { role: 'user', content: 'more' }] });
        expect(lastUpstream.headers['x-opencode-session']).toEqual(first);

        // A non-opencode provider keeps the backend pipeline.
        lastUpstream = null;
        await request(proxy)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer k')
            .send({ model: 'otherprov/model-x', messages: [{ role: 'user', content: 'hi' }], tools: [clientTool] });
        expect(lastUpstream).toBeNull();
    });
});
