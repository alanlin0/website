// Mints a short-lived OpenAI Realtime ephemeral client secret so the browser can
// open a WebRTC speech-to-speech session WITHOUT ever seeing the real API key.
//
// The browser calls this, gets back { value: "ek_...", model }, then POSTs its
// WebRTC SDP offer straight to https://api.openai.com/v1/realtime/calls using the
// ephemeral key. The real OPENAI_API_KEY never leaves the server.
//
// Deploy:  supabase functions deploy realtime-token --no-verify-jwt
// Secret reused from ai-proxy:  OPENAI_API_KEY  (optional: REALTIME_MODEL)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const body = await req.json().catch(() => ({})) as {
      instructions?: string
      voice?: string
      model?: string
      safetyId?: string
    }

    const key = (Deno.env.get('OPENAI_API_KEY') ?? '').replace(/[^\x21-\x7E]/g, '')
    if (!key) throw new Error('OPENAI_API_KEY secret not set in Supabase')

    const model = body.model || Deno.env.get('REALTIME_MODEL') || 'gpt-realtime-mini'
    const voice = body.voice || 'marin'

    // Build the session the ephemeral token is bound to. Instructions, voice and
    // transcription are set here; the browser can still session.update later.
    const session: Record<string, unknown> = {
      type: 'realtime',
      model,
      audio: {
        input: {
          // Transcribe the user's speech so the UI can show what they said.
          transcription: { model: 'whisper-1' },
          // Filter background noise / echo before it reaches VAD — cuts false triggers.
          noise_reduction: { type: 'near_field' },
          // Less trigger-happy VAD: needs louder audio and a longer pause to end a turn.
          turn_detection: {
            type: 'server_vad',
            threshold: 0.6,
            prefix_padding_ms: 300,
            silence_duration_ms: 700,
          },
        },
        output: { voice },
      },
    }
    if (body.instructions) session.instructions = body.instructions

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    }
    // Bind a (hashed) user id to the session for abuse monitoring when provided.
    if (body.safetyId) headers['OpenAI-Safety-Identifier'] = body.safetyId

    const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers,
      body: JSON.stringify({ session }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as any
      throw new Error(`OpenAI ${res.status}: ${err.error?.message || 'realtime token error'}`)
    }

    const data = await res.json() as any
    const value = data.value || data.client_secret?.value
    if (!value) throw new Error('OpenAI did not return an ephemeral token')

    return json({ value, model, expires_at: data.expires_at ?? null })
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
