// Gemini-адаптер поверх общей логики ассистента (lib/assistantCore.js) —
// один и тот же набор инструментов (TOOLS/HANDLERS) и одно и то же правило
// "изменяющее действие только предлагается, ждёт подтверждения человека"
// (resolveToolUseBlocks — она не завязана на формат Anthropic, работает
// с любым {id, name, input}, поэтому переиспользуется как есть). Разница —
// только в форме запроса/ответа: у Gemini вызов инструмента называется
// functionCall/functionResponse, а не tool_use/tool_result, и у самого
// вызова нет собственного id (собираем свой по номеру в ответе).
// Бесплатный ключ — aistudio.google.com, без банковской карты.
const { TOOLS, SYSTEM_PROMPT, MAX_TURNS, resolveToolUseBlocks } = require('./assistantCore');

const GEMINI_MODEL = 'gemini-2.5-flash';

// Anthropic input_schema и Gemini parameters — практически совпадающий
// JSON Schema (type/properties/required/enum/description), так что
// содержимое конвертировать не нужно, только имя поля снаружи.
const TOOLS_GEMINI = [{
  functionDeclarations: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  })),
}];

async function callGemini(contents, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      tools: TOOLS_GEMINI,
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API ${res.status}: ${text}`);
  }
  return res.json();
}

function extractFunctionCalls(parts) {
  return (parts || [])
    .map((p, i) => (p.functionCall ? { id: 'call_' + i, name: p.functionCall.name, input: p.functionCall.args || {} } : null))
    .filter(Boolean);
}

function functionResponseParts(callBlocks, toolResults) {
  return toolResults.map((tr, i) => ({
    functionResponse: { name: callBlocks[i].name, response: JSON.parse(tr.content) },
  }));
}

// Аналог runAssistantLoop из assistantCore.js, только на формате Gemini
// (contents вместо messages, role 'model' вместо 'assistant'). Общая точка
// входа для .github/scripts/run-assistant.js, когда выбрана модель Gemini.
async function runAssistantLoopGemini(initialContents, initialDecisions, apiKey) {
  const contents = [...initialContents];
  const actions = [];

  if (initialDecisions) {
    const lastMsg = contents[contents.length - 1];
    const pendingBlocks = lastMsg && lastMsg.role === 'model' ? extractFunctionCalls(lastMsg.parts) : [];
    if (!pendingBlocks.length) throw new Error('decisions без ожидающего хода ассистента');
    const resolved = await resolveToolUseBlocks(pendingBlocks, initialDecisions, actions);
    if (resolved.awaiting) {
      return { reply: '', actions, messages: contents, awaitingConfirmation: true, pendingActions: resolved.pendingActions };
    }
    contents.push({ role: 'user', parts: functionResponseParts(pendingBlocks, resolved.toolResults) });
  }

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await callGemini(contents, apiKey);
    const candidate = resp.candidates && resp.candidates[0];
    const parts = (candidate && candidate.content && candidate.content.parts) || [];
    const functionCalls = extractFunctionCalls(parts);

    if (!functionCalls.length) {
      const text = parts.filter((p) => p.text).map((p) => p.text).join('\n');
      return { reply: text, actions, messages: [...contents, { role: 'model', parts }] };
    }

    contents.push({ role: 'model', parts });
    const resolved = await resolveToolUseBlocks(functionCalls, null, actions);
    if (resolved.awaiting) {
      const text = parts.filter((p) => p.text).map((p) => p.text).join('\n');
      return { reply: text, actions, messages: contents, awaitingConfirmation: true, pendingActions: resolved.pendingActions };
    }
    contents.push({ role: 'user', parts: functionResponseParts(functionCalls, resolved.toolResults) });
  }

  return {
    reply: 'Достигнут лимит шагов на один запрос — попроси меня продолжить отдельным сообщением, если что-то осталось незавершённым.',
    actions,
    messages: contents,
  };
}

module.exports = { runAssistantLoopGemini };
