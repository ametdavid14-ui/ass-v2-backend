// =============================================
// ASS v2.0 — Módulo compartido de llamadas a IA (Claude/ChatGPT).
// Extraído de routes/ia.js para poder reutilizarlo también en otras
// rutas (ej: búsqueda sindromática de CIE-10) sin duplicar código.
//
// Soporta 2 proveedores — Claude (Anthropic) y ChatGPT (OpenAI):
// - IA_PROVIDER en las variables de entorno decide cuál usar primero
//   ('claude' o 'openai'; por defecto 'claude').
// - Si el proveedor principal falla y el otro tiene su key configurada,
//   se reintenta automáticamente con el otro.
// =============================================

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

async function llamarClaude(systemPrompt, userContent, maxTokens = 4096) {
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY no configurada');
  const mensaje = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: maxTokens,
    // system con cache_control: el prompt se cachea entre llamadas
    // seguidas (ventana de 5 min) — ahorra costo cuando se usa seguido.
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent }],
  });
  const bloqueTexto = mensaje.content?.find(b => b.type === 'text');
  if (!bloqueTexto?.text) {
    console.error('Claude no devolvió texto. stop_reason:', mensaje.stop_reason, '— content:', JSON.stringify(mensaje.content));
    throw new Error(`Claude no devolvió contenido de texto (stop_reason: ${mensaje.stop_reason || 'desconocido'})`);
  }
  if (mensaje.stop_reason === 'max_tokens') {
    console.error('Advertencia: la respuesta de Claude se cortó por max_tokens — puede venir incompleta.');
  }
  return bloqueTexto.text;
}

async function llamarChatGPT(systemPrompt, userContent, maxTokens = 4096) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY no configurada');
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    }),
  });
  if (!resp.ok) {
    const cuerpoError = await resp.text().catch(() => '');
    throw new Error(`OpenAI respondió ${resp.status}: ${cuerpoError.slice(0, 200)}`);
  }
  const data = await resp.json();
  const contenido = data.choices?.[0]?.message?.content;
  if (!contenido) {
    console.error('OpenAI no devolvió contenido. finish_reason:', data.choices?.[0]?.finish_reason, '— respuesta:', JSON.stringify(data).slice(0, 500));
    throw new Error(`OpenAI no devolvió contenido de texto (finish_reason: ${data.choices?.[0]?.finish_reason || 'desconocido'})`);
  }
  if (data.choices?.[0]?.finish_reason === 'length') {
    console.error('Advertencia: la respuesta de OpenAI se cortó por límite de tokens — puede venir incompleta.');
  }
  return contenido;
}

// Intenta el proveedor configurado como principal (IA_PROVIDER); si falla
// y el otro tiene su key configurada, reintenta automáticamente con ese.
async function llamarIAConRespaldo(systemPrompt, userContent, maxTokens = 4096) {
  const principal = (process.env.IA_PROVIDER || 'claude').toLowerCase();
  const proveedores = principal === 'openai' ? ['openai', 'claude'] : ['claude', 'openai'];

  let ultimoError = null;
  for (const proveedor of proveedores) {
    try {
      const texto = proveedor === 'openai'
        ? await llamarChatGPT(systemPrompt, userContent, maxTokens)
        : await llamarClaude(systemPrompt, userContent, maxTokens);
      return { texto, proveedorUsado: proveedor };
    } catch (e) {
      console.error(`Error con ${proveedor}:`, e.message);
      ultimoError = e;
    }
  }
  throw ultimoError || new Error('Ningún proveedor de IA está configurado');
}

module.exports = { llamarIAConRespaldo };
