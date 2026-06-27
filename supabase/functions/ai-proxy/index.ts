const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { system, messages, maxTokens, model: modelOverride } = await req.json()

    // Provider and model are configured server-side via Supabase secrets.
    // The client may pass a model override for lightweight secondary calls (e.g. gpt-5.4-nano).
    const provider = Deno.env.get('HOSTED_PROVIDER') || 'openai'
    const model    = modelOverride || Deno.env.get('HOSTED_MODEL') || 'gpt-5.4-mini'

    let text: string
    if (provider === 'claude') {
      text = await callAnthropic(model, system, messages, maxTokens)
    } else if (provider === 'openai') {
      text = await callOpenAI(model, system, messages, maxTokens)
    } else if (provider === 'gemini') {
      text = await callGemini(model, system, messages, maxTokens)
    } else {
      throw new Error(`Unknown HOSTED_PROVIDER: ${provider}`)
    }

    return json({ text })
  } catch (e) {
    console.error(e)
    return json({ error: (e as Error).message }, 500)
  }
})

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

// ── Provider helpers ──────────────────────────────────────────────────────────

async function callAnthropic(
  model: string, system: string,
  messages: { role: string; content: string }[], maxTokens: number
) {
  const key = (Deno.env.get('ANTHROPIC_API_KEY') ?? '').replace(/[^\x21-\x7E]/g, '')
  if (!key) throw new Error('ANTHROPIC_API_KEY secret not set in Supabase')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any
    throw new Error(`Anthropic ${res.status}: ${err.error?.message || 'API error'}`)
  }
  const data = await res.json() as any
  const text = data.content?.[0]?.text
  if (!text) throw new Error(`Claude returned empty response (stop_reason: ${data.stop_reason ?? 'unknown'})`)
  return text
}

async function callOpenAI(
  model: string, system: string,
  messages: { role: string; content: string }[], maxTokens: number
) {
  const key = (Deno.env.get('OPENAI_API_KEY') ?? '').replace(/[^\x21-\x7E]/g, '')
  if (!key) throw new Error('OPENAI_API_KEY secret not set in Supabase')

  const oaiMessages = [{ role: 'system', content: system }, ...messages]
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model, messages: oaiMessages, max_completion_tokens: maxTokens }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any
    throw new Error(`OpenAI ${res.status}: ${err.error?.message || 'API error'}`)
  }
  const data = await res.json() as any
  const text = data.choices?.[0]?.message?.content
  if (!text) throw new Error(`OpenAI returned empty content (finish_reason: ${data.choices?.[0]?.finish_reason ?? 'unknown'})`)
  return text
}

async function callGemini(
  model: string, system: string,
  messages: { role: string; content: string }[], maxTokens: number
) {
  const key = (Deno.env.get('GEMINI_API_KEY') ?? '').replace(/[^\x21-\x7E]/g, '')
  if (!key) throw new Error('GEMINI_API_KEY secret not set in Supabase')

  const fullMessages = [
    { role: 'user', content: system + '\n\n---\n\n' + (messages[0]?.content || '') },
    ...messages.slice(1),
  ]
  const geminiContents = fullMessages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: geminiContents,
      generationConfig: { maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
      ],
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any
    throw new Error(`Gemini ${res.status}: ${err.error?.message || 'API error'}`)
  }
  const data = await res.json() as any
  const blockReason = data.promptFeedback?.blockReason
  if (blockReason) throw new Error(`Gemini blocked the request (${blockReason})`)
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error(`Gemini returned no content (finishReason: ${data.candidates?.[0]?.finishReason ?? 'unknown'})`)
  return text
}
