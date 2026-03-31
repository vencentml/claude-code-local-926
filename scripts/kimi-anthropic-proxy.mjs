import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number.parseInt(process.env.ANTHROPIC_PROXY_PORT || '3456', 10);
const KIMI_API_KEY = process.env.KIMI_API_KEY || '';
const KIMI_BASE_URL = (process.env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1').replace(/\/+$/, '');
const KIMI_MODEL = process.env.KIMI_MODEL || '';
const KIMI_STRICT_MODEL = /^1|true|yes$/i.test(process.env.KIMI_STRICT_MODEL || '');

if (!KIMI_API_KEY) {
  console.error('KIMI_API_KEY is required');
  process.exit(1);
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendAnthropicError(res, statusCode, message, type = 'invalid_request_error') {
  sendJson(res, statusCode, {
    type: 'error',
    error: { type, message },
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function textFromBlock(block) {
  if (!block || typeof block !== 'object') return '';
  if (block.type === 'text' && typeof block.text === 'string') return block.text;
  if (block.type === 'tool_result') {
    return stringifyToolResult(block.content);
  }
  if (block.type === 'image') {
    return '[image omitted by kimi proxy]';
  }
  if (block.type === 'document') {
    return '[document omitted by kimi proxy]';
  }
  return '';
}

function extractAnthropicText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(textFromBlock)
    .filter(Boolean)
    .join('\n');
}

function stringifyToolResult(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (typeof item === 'string') return item;
        if (item?.type === 'text' && typeof item.text === 'string') return item.text;
        return JSON.stringify(item);
      })
      .join('\n');
  }
  if (content == null) return '';
  if (typeof content === 'object') return JSON.stringify(content);
  return String(content);
}

function anthropicToolChoiceToOpenAI(toolChoice) {
  if (!toolChoice) return 'auto';
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'any') return 'required';
    return toolChoice;
  }
  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return {
      type: 'function',
      function: { name: toolChoice.name },
    };
  }
  return 'auto';
}

function anthropicToolsToOpenAI(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }));
}

function anthropicMessagesToOpenAI(systemPrompt, messages) {
  const out = [];

  const systemText =
    typeof systemPrompt === 'string'
      ? systemPrompt
      : Array.isArray(systemPrompt)
        ? systemPrompt.map(textFromBlock).filter(Boolean).join('\n')
        : '';
  if (systemText) {
    out.push({ role: 'system', content: systemText });
  }

  for (const message of messages || []) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;

    if (message.role === 'assistant') {
      const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: extractAnthropicText(message.content) }];
      const content = [];
      const thinking = [];
      const toolCalls = [];

      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
          content.push(block.text);
        } else if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
          thinking.push(block.thinking);
        } else if (block?.type === 'tool_use') {
          toolCalls.push({
            id: block.id || `toolu_${randomUUID()}`,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            },
          });
        }
      }

      out.push({
        role: 'assistant',
        content: content.length > 0 ? content.join('\n') : null,
        ...((thinking.length > 0 || toolCalls.length > 0) ? { reasoning_content: thinking.length > 0 ? thinking.join('\n') : 'Tool call reasoning preserved by local bridge.' } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: extractAnthropicText(message.content) }];
    const userText = [];
    for (const block of blocks) {
      if (block?.type === 'tool_result') {
        out.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: stringifyToolResult(block.content),
        });
      } else {
        const text = textFromBlock(block);
        if (text) userText.push(text);
      }
    }
    if (userText.length > 0) {
      out.push({ role: 'user', content: userText.join('\n') });
    }
  }

  return out;
}

function resolveModel(requestedModel) {
  if (KIMI_STRICT_MODEL && requestedModel) return requestedModel;
  if (KIMI_MODEL) return KIMI_MODEL;
  return requestedModel || 'moonshot-v1-8k';
}

function mapFinishReason(reason, hasToolCalls) {
  if (reason === 'tool_calls' || hasToolCalls) return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  return 'end_turn';
}

function openAIMessageToAnthropicContent(message) {
  const content = [];
  if (typeof message?.reasoning_content === 'string' && message.reasoning_content) {
    content.push({ type: 'thinking', thinking: message.reasoning_content, signature: '' });
  }
  if (typeof message?.content === 'string' && message.content) {
    content.push({ type: 'text', text: message.content });
  }
  for (const toolCall of message?.tool_calls || []) {
    let input = {};
    try {
      input = toolCall?.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
    } catch {
      input = {};
    }
    content.push({
      type: 'tool_use',
      id: toolCall.id || `toolu_${randomUUID()}`,
      name: toolCall?.function?.name || 'unknown_tool',
      input,
    });
  }
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }
  return content;
}

function openAINonStreamToAnthropic(payload, requestModel) {
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || {};
  const stopReason = mapFinishReason(choice.finish_reason, Array.isArray(message.tool_calls) && message.tool_calls.length > 0);
  return {
    id: payload.id || `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    content: openAIMessageToAnthropicContent(message),
    model: payload.model || requestModel,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: payload?.usage?.prompt_tokens || 0,
      output_tokens: payload?.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function* parseSse(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = rawEvent.split(/\r?\n/);
      const dataLines = [];
      for (const line of lines) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      const data = dataLines.join('\n');
      if (data) yield data;
      boundary = buffer.indexOf('\n\n');
    }
  }
  const finalText = buffer.trim();
  if (finalText) {
    const lines = finalText.split(/\r?\n/);
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    const data = dataLines.join('\n');
    if (data) yield data;
  }
}

async function handleStream(openAiReq, anthropicReq, res, requestModel) {
  const upstream = await fetch(`${KIMI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${KIMI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      ...openAiReq,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    sendAnthropicError(res, upstream.status, text || `Upstream error ${upstream.status}`, 'api_error');
    return;
  }

  const messageId = `msg_${randomUUID()}`;
  const model = openAiReq.model || requestModel;
  const toolStates = new Map();
  let textBlockStarted = false;
  let nextContentIndex = 0;
  let stopReason = 'end_turn';
  let promptTokens = 0;
  let completionTokens = 0;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });

  writeSse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });

  for await (const data of parseSse(upstream.body)) {
    if (data === '[DONE]') break;

    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }

    if (payload.usage) {
      promptTokens = payload.usage.prompt_tokens || promptTokens;
      completionTokens = payload.usage.completion_tokens || completionTokens;
    }

    const choice = payload.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      if (!textBlockStarted) {
        writeSse(res, 'content_block_start', {
          type: 'content_block_start',
          index: nextContentIndex,
          content_block: { type: 'text', text: '' },
        });
        textBlockStarted = true;
        nextContentIndex += 1;
      }
      writeSse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: delta.content },
      });
    }

    for (const toolDelta of delta.tool_calls || []) {
      const toolIndex = toolDelta.index ?? 0;
      if (!toolStates.has(toolIndex)) {
        const contentIndex = nextContentIndex;
        nextContentIndex += 1;
        const toolId = toolDelta.id || `toolu_${randomUUID()}`;
        const toolName = toolDelta.function?.name || 'unknown_tool';
        toolStates.set(toolIndex, { contentIndex, toolId, toolName, open: true });
        writeSse(res, 'content_block_start', {
          type: 'content_block_start',
          index: contentIndex,
          content_block: {
            type: 'tool_use',
            id: toolId,
            name: toolName,
            input: {},
          },
        });
      }

      const state = toolStates.get(toolIndex);
      if (toolDelta.id) state.toolId = toolDelta.id;
      if (toolDelta.function?.name) state.toolName = toolDelta.function.name;

      const partialJson = toolDelta.function?.arguments;
      if (typeof partialJson === 'string' && partialJson.length > 0) {
        writeSse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: state.contentIndex,
          delta: { type: 'input_json_delta', partial_json: partialJson },
        });
      }
    }

    if (choice.finish_reason) {
      stopReason = mapFinishReason(choice.finish_reason, toolStates.size > 0);
    }
  }

  if (textBlockStarted) {
    writeSse(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: 0,
    });
  }
  for (const state of toolStates.values()) {
    if (state.open) {
      writeSse(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: state.contentIndex,
      });
      state.open = false;
    }
  }

  writeSse(res, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: stopReason,
      stop_sequence: null,
    },
    usage: {
      output_tokens: completionTokens,
    },
  });
  writeSse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

async function handleMessages(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    sendAnthropicError(res, 400, 'Invalid JSON body');
    return;
  }

  const requestedModel = body.model;
  const model = resolveModel(requestedModel);
  const openAiReq = {
    model,
    messages: anthropicMessagesToOpenAI(body.system, body.messages),
    temperature: body.temperature,
    top_p: body.top_p,
    stop: Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0 ? body.stop_sequences : undefined,
    max_tokens: body.max_tokens,
    tools: anthropicToolsToOpenAI(body.tools),
    tool_choice: anthropicToolChoiceToOpenAI(body.tool_choice),
  };

  if (body.stream) {
    await handleStream(openAiReq, body, res, requestedModel);
    return;
  }

  const upstream = await fetch(`${KIMI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${KIMI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(openAiReq),
  });

  const text = await upstream.text();
  if (!upstream.ok) {
    sendAnthropicError(res, upstream.status, text || `Upstream error ${upstream.status}`, 'api_error');
    return;
  }

  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    sendAnthropicError(res, 502, 'Failed to parse upstream JSON response', 'api_error');
    return;
  }

  sendJson(res, 200, openAINonStreamToAnthropic(payload, requestedModel));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, {
        ok: true,
        provider: 'kimi',
        baseUrl: KIMI_BASE_URL,
        model: KIMI_MODEL || null,
        strictModel: KIMI_STRICT_MODEL,
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/messages') {
      await handleMessages(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/complete') {
      sendAnthropicError(res, 501, 'The proxy only implements /v1/messages');
      return;
    }

    sendAnthropicError(res, 404, `Unknown route: ${req.method} ${req.url}`, 'not_found_error');
  } catch (error) {
    sendAnthropicError(
      res,
      500,
      error instanceof Error ? error.message : String(error),
      'api_error',
    );
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Kimi Anthropic proxy listening on http://127.0.0.1:${PORT}`);
});

